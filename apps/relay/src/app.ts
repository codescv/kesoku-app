import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Hono, type Context } from 'hono';
import { createAdaptorServer } from '@hono/node-server';
import { z } from 'zod';
import { PlatformSchema } from '@kesoku/protocol';
import type { RelayConfig } from './config';
import { DeviceAuth } from './auth/device';
import { createFirebaseVerifier, isEmailAllowed, type IdTokenVerifier } from './auth/firebase';
import { clearSessionCookies, sessionCookie } from './auth/cookie';
import { Pairing } from './pair';
import { Bridge } from './bridge';
import { GcsMedia, LocalDiskMedia, MediaService, localMediaHandler, type MediaBackend } from './media';
import { SlidingWindowLimiter, clientIp } from './ratelimit';
import { securityHeaders } from './security';
import { staticHandler } from './static';
import { consoleLogger, type Logger } from './log';

export interface RelayDeps {
  /** Google ID token verifier (default: firebase-admin when FIREBASE_PROJECT_ID is set). */
  idTokenVerifier?: IdTokenVerifier;
  /** Media backend override (default: GCS when MEDIA_BUCKET, local disk when LOCAL_MEDIA_DIR). */
  media?: MediaBackend;
  logger?: Logger;
}

export interface Relay {
  server: Server;
  bridge: Bridge;
  auth: DeviceAuth;
  pairing: Pairing;
  app: Hono<NodeEnv>;
  listen(port?: number, host?: string): Promise<AddressInfo>;
  /** Base URL once listening (or PUBLIC_ORIGIN). */
  origin(): string;
  /** SIGTERM path: `relay.restarting` on both legs, then close. */
  shutdown(): Promise<void>;
  close(): Promise<void>;
}

type NodeEnv = { Bindings: { incoming: import('node:http').IncomingMessage } };

const MAX_JSON_BODY = 16 * 1024;

const PairBody = z.object({
  code: z.string().max(32),
  device: z
    .object({
      platform: PlatformSchema,
      model: z.string().max(64).optional(),
      name: z.string().max(64).optional(),
    })
    .passthrough(),
});

const GoogleBody = z.object({
  id_token: z.string().min(1).max(8192),
  device: z.object({ platform: PlatformSchema.optional(), name: z.string().max(64).optional() }).passthrough().optional(),
});

async function readJson(c: Context): Promise<unknown> {
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > MAX_JSON_BODY) throw new Error('body too large');
  const text = await c.req.text();
  if (text.length > MAX_JSON_BODY) throw new Error('body too large');
  return JSON.parse(text);
}

export function createRelay(config: RelayConfig, deps: RelayDeps = {}): Relay {
  const log = deps.logger ?? consoleLogger;
  const L = config.limits;
  const auth = new DeviceAuth(config.deviceHmacKey);
  const pairing = new Pairing(L.pairMaxAttemptsPerOffer);
  let boundOrigin = '';
  const origin = () => config.publicOrigin ?? boundOrigin;

  let backend: MediaBackend | null = deps.media ?? null;
  const ttl = { putTtlS: L.mediaPutTtlS, getTtlS: L.mediaGetTtlS };
  let local: LocalDiskMedia | null = backend instanceof LocalDiskMedia ? backend : null;
  if (!backend && config.localMediaDir) {
    local = new LocalDiskMedia(config.localMediaDir, config.deviceHmacKey, origin, ttl);
    backend = local;
  } else if (!backend && config.mediaBucket) {
    backend = new GcsMedia(config.mediaBucket, ttl);
  }
  const media = backend
    ? new MediaService(backend, {
        messageMaxBytes: L.messageMediaMaxBytes,
        avatarSourceMaxBytes: L.avatarSourceMaxBytes,
        mediaPutMaxBytes: L.mediaPutMaxBytes,
      })
    : null;

  const verifier: IdTokenVerifier | null =
    deps.idTokenVerifier ?? (config.firebaseProjectId ? createFirebaseVerifier(config.firebaseProjectId) : null);

  const bridge = new Bridge({ config, auth, pairing, media, logger: log });
  const pairLimiter = new SlidingWindowLimiter(L.pairIpLimit, L.pairIpWindowMs);
  const googleLimiter = new SlidingWindowLimiter(L.authGoogleIpLimit, L.authGoogleIpWindowMs);
  const secHeaders = securityHeaders(config);

  const app = new Hono<NodeEnv>();
  const ipOf = (c: Context<NodeEnv>) => clientIp(c.req.header('x-forwarded-for'), c.env?.incoming?.socket?.remoteAddress, config.trustProxy);

  app.use('*', async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(secHeaders)) c.res.headers.set(k, v);
  });

  app.onError((err, c) => {
    log.error('http handler failed', { path: new URL(c.req.url).pathname, error: err.message });
    return c.json({ error: 'INTERNAL' }, 500);
  });

  // CORS for native WebViews (capacitor://localhost, https://localhost) on the auth endpoints.
  // Only exact origins from `config.corsOrigins` are echoed back (never `*`), so allowing
  // credentials is safe.
  const corsPaths = ['/pair', '/auth/google', '/auth/logout', '/auth/config'];
  app.use('*', async (c, next) => {
    const reqOrigin = c.req.header('origin');
    const p = new URL(c.req.url).pathname;
    const allowed = !!reqOrigin && corsPaths.includes(p) && config.corsOrigins.includes(reqOrigin);
    if (c.req.method === 'OPTIONS' && corsPaths.includes(p)) {
      if (!allowed) return c.body(null, 403);
      return c.body(null, 204, {
        'Access-Control-Allow-Origin': reqOrigin!,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      });
    }
    await next();
    if (allowed) {
      c.res.headers.set('Access-Control-Allow-Origin', reqOrigin!);
      c.res.headers.set('Access-Control-Allow-Credentials', 'true');
      c.res.headers.append('Vary', 'Origin');
    }
  });

  app.get('/healthz', (c) => c.text('ok', 200, { 'Cache-Control': 'no-store' }));
  app.get('/health', (c) => c.text('ok', 200, { 'Cache-Control': 'no-store' }));
  app.get('/engine/status', (c) => c.json(bridge.engineStatus(), 200, { 'Cache-Control': 'no-store' }));

  // Public Firebase web config for the client's Google popup (not secret).
  app.get('/auth/config', (c) =>
    c.json({ firebase: config.firebaseWeb, google_login: Boolean(config.firebaseWeb && verifier) }, 200, { 'Cache-Control': 'no-cache' }),
  );

  app.post('/auth/google', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!googleLimiter.hit(ipOf(c))) return c.json({ error: 'RATE_LIMITED' }, 429);
    if (!verifier) return c.json({ error: 'GOOGLE_SIGNIN_DISABLED' }, 503);
    let body: z.infer<typeof GoogleBody>;
    try {
      const parsed = GoogleBody.safeParse(await readJson(c));
      if (!parsed.success) return c.json({ error: 'BAD_REQUEST' }, 400);
      body = parsed.data;
    } catch {
      return c.json({ error: 'BAD_REQUEST' }, 400);
    }
    let claims;
    try {
      claims = await verifier.verifyIdToken(body.id_token);
    } catch {
      return c.json({ error: 'UNAUTHORIZED' }, 401);
    }
    const email = isEmailAllowed(claims, config.allowedEmails);
    if (!email) {
      log.warn('google sign-in refused (not allowlisted or unverified)');
      return c.json({ error: 'FORBIDDEN_EMAIL' }, 403);
    }
    const { token, claims: dev } = auth.issue('google');
    const platform = body.device?.platform ?? 'web';
    bridge.sendControlToEngine('device.registered', {
      device_id: dev.device_id,
      kind: 'google',
      name: body.device?.name || email,
      email,
      platform,
    });
    log.info('google device issued', { device_id: dev.device_id });
    c.header('Set-Cookie', sessionCookie(token));
    return c.json({ device_id: dev.device_id, device_token: token, email });
  });

  app.post('/pair', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!pairLimiter.hit(ipOf(c))) return c.json({ error: 'RATE_LIMITED' }, 429);
    let body: z.infer<typeof PairBody>;
    try {
      const parsed = PairBody.safeParse(await readJson(c));
      if (!parsed.success) return c.json({ error: 'BAD_REQUEST' }, 400);
      body = parsed.data;
    } catch {
      return c.json({ error: 'BAD_REQUEST' }, 400);
    }
    const code = body.code.replace(/[\s-]/g, '');
    if (!/^\d{6}$/.test(code)) return c.json({ error: 'BAD_REQUEST' }, 400);
    const r = pairing.redeem(code);
    if (!r.ok) {
      if (r.reason === 'burned') {
        log.warn('pair offer burned after failed attempts', { attempts: r.attempts });
        bridge.sendControlToEngine('pair.burned', { code_hash: r.code_hash, attempts: r.attempts });
      }
      return c.json({ error: 'PAIR_FAILED' }, 403);
    }
    const { token, claims } = auth.issue('pair');
    const d = body.device;
    bridge.sendControlToEngine('pair.redeem', {
      device_id: claims.device_id,
      name: d.name || r.offer.name || d.model || d.platform,
      platform: d.platform,
      ...(d.model ? { model: d.model } : {}),
    });
    log.info('device paired', { device_id: claims.device_id, platform: d.platform });
    c.header('Set-Cookie', sessionCookie(token));
    return c.json({ device_id: claims.device_id, device_token: token });
  });

  app.post('/auth/logout', (c) => {
    for (const ck of clearSessionCookies()) c.header('Set-Cookie', ck, { append: true });
    c.header('Cache-Control', 'no-store');
    return c.body(null, 204);
  });

  if (local) app.on(['GET', 'HEAD', 'PUT'], '/local-media/*', localMediaHandler(local));

  // Reserved API paths never fall through to the SPA.
  for (const p of ['/ws', '/engine', '/auth/*', '/local-media/*']) app.all(p, (c) => c.json({ error: 'NOT_FOUND' }, 404));
  app.all('/pair', (c) => c.json({ error: 'METHOD_NOT_ALLOWED' }, 405));

  app.get('*', staticHandler(config.staticDir));
  app.all('*', (c) => c.text('Not Found', 404));

  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => undefined);
    if (!bridge.handleUpgrade(req, socket, head)) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
    }
  });
  // Long-lived WS legs: never time out idle sockets at the HTTP layer.
  server.requestTimeout = 60_000;
  server.headersTimeout = 30_000;

  let closing: Promise<void> | null = null;
  const closeServer = () =>
    (closing ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }));

  return {
    server,
    bridge,
    auth,
    pairing,
    app,
    origin,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const addr = server.address() as AddressInfo;
          const h = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address === '0.0.0.0' ? '127.0.0.1' : addr.address;
          boundOrigin = `http://${h}:${addr.port}`;
          resolve(addr);
        });
      });
    },
    async shutdown() {
      await bridge.shutdown();
      await closeServer();
    },
    async close() {
      bridge.close();
      await closeServer();
    },
  };
}

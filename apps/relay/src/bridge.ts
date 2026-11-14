import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  ClientToEngine,
  EngineToRelay,
  MediaPutHeaderSchema,
  WS_CLOSE,
  makeEnvelope,
  newId,
  parseEnvelope,
  validatePayload,
  type Envelope,
} from '@kesoku/protocol';
import type { RelayConfig } from './config';
import type { DeviceAuth } from './auth/device';
import { sessionTokenFromCookie } from './auth/cookie';
import type { Pairing } from './pair';
import { MediaError, type MediaService } from './media';
import { RingStore } from './ringbuffer';
import { ConcurrencyLimiter, SlidingWindowLimiter, clientIp } from './ratelimit';
import { safeEqual } from './security';
import type { Logger } from './log';

const SERVICE_RESTART = 1012;
const MAX_CLIENT_LEGS = 256;

/** Relay⇄engine control types a client must never inject. */
const CLIENT_FORBIDDEN_TYPES = new Set(['sync.replay', 'device.registered', 'media.upload.ticket', 'media.sign', 'media.put', 'media.put.ok', 'media.signed']);
const CLIENT_FORBIDDEN_PREFIXES = ['engine.', 'relay.', 'pair.'];

interface Leg {
  ws: WebSocket;
  alive: boolean;
  rotateTimer?: NodeJS.Timeout;
  forceTimer?: NodeJS.Timeout;
}

interface ClientLeg extends Leg {
  deviceId: string;
  kind: 'pair' | 'google';
  ip: string;
}

interface EngineLeg extends Leg {
  id: number;
  bootId?: number | string;
  connSeq?: number;
  hello: boolean;
  draining: boolean;
  drainTimer?: NodeJS.Timeout;
  chain: Promise<void>;
}

interface QueuedFrame {
  id: string;
  data: string;
  control: boolean;
}

export interface BridgeDeps {
  config: RelayConfig;
  auth: DeviceAuth;
  pairing: Pairing;
  media: MediaService | null;
  logger: Logger;
}

function nowS(): number {
  return Date.now() / 1000;
}

/** Order (boot_id, conn_seq): numeric when both boot ids are integers, else string compare; then conn_seq. */
export function compareEngineKey(a: { boot_id: number | string; conn_seq: number }, b: { boot_id: number | string; conn_seq: number }): number {
  const sa = String(a.boot_id);
  const sb = String(b.boot_id);
  let c: number;
  if (/^\d+$/.test(sa) && /^\d+$/.test(sb)) {
    const ba = BigInt(sa);
    const bb = BigInt(sb);
    c = ba === bb ? 0 : ba > bb ? 1 : -1;
  } else {
    c = sa === sb ? 0 : sa > sb ? 1 : -1;
  }
  if (c !== 0) return c;
  return a.conn_seq === b.conn_seq ? 0 : a.conn_seq > b.conn_seq ? 1 : -1;
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  if (socket.writable) {
    socket.write(
      `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${text.length}\r\n` +
        `X-Content-Type-Options: nosniff\r\n\r\n${text}`,
    );
  }
  socket.destroy();
}

function send(ws: WebSocket, data: string | Buffer): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  ws.send(data);
  return true;
}

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

function rawToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

/**
 * In-memory two-leg WebSocket bridge (PROTOCOL.md §2/§3): authenticated client legs on `/ws`, one primary
 * engine leg on `/engine` (with instant takeover + drain), offline inbound queue, per-session ring buffer.
 */
export class Bridge {
  private readonly config: RelayConfig;
  private readonly auth: DeviceAuth;
  private readonly pairing: Pairing;
  private readonly media: MediaService | null;
  private readonly log: Logger;
  private readonly wssClient: WebSocketServer;
  private readonly wssEngine: WebSocketServer;
  private readonly clients = new Set<ClientLeg>();
  private readonly pendingClients = new Set<WebSocket>();
  private readonly engines = new Set<EngineLeg>();
  private primary: EngineLeg | null = null;
  private queue: QueuedFrame[] = [];
  private statusSince = nowS();
  private engineSeq = 0;
  private heartbeat?: NodeJS.Timeout;
  private closed = false;
  readonly rings: RingStore;
  private readonly hsConcurrent: ConcurrencyLimiter;
  private readonly hsRate: SlidingWindowLimiter;

  constructor(deps: BridgeDeps) {
    this.config = deps.config;
    this.auth = deps.auth;
    this.pairing = deps.pairing;
    this.media = deps.media;
    this.log = deps.logger;
    const L = this.config.limits;
    this.wssClient = new WebSocketServer({ noServer: true, maxPayload: L.clientMaxFrameBytes, perMessageDeflate: false });
    this.wssEngine = new WebSocketServer({ noServer: true, maxPayload: L.engineMaxFrameBytes, perMessageDeflate: false });
    this.rings = new RingStore(L.ringPerSession);
    this.hsConcurrent = new ConcurrencyLimiter(L.handshakeConcurrentPerIp);
    this.hsRate = new SlidingWindowLimiter(L.handshakePerMinutePerIp, 60_000);
    if (L.heartbeatMs > 0) {
      this.heartbeat = setInterval(() => this.beat(), L.heartbeatMs);
      this.heartbeat.unref();
    }
  }

  // ───────────────────────────── public state ─────────────────────────────

  get engineOnline(): boolean {
    return !!this.primary && this.primary.ws.readyState === WebSocket.OPEN;
  }

  engineStatus(): { online: boolean; since: number } {
    return { online: this.engineOnline, since: this.statusSince };
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * Relay-originated frame to the engine (`pair.redeem`, `pair.burned`, `device.registered`): sent now or
   * queued while the engine is offline (bypasses the client queue limit, bounded at 2×).
   */
  sendControlToEngine<P extends Record<string, unknown>>(type: string, payload: P): void {
    const env = makeEnvelope(type, payload);
    this.toEngine(env.id, JSON.stringify(env), true);
  }

  // ───────────────────────────── upgrade routing ─────────────────────────────

  /** Returns true when the path belongs to the bridge (socket handled either way). */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? '/', 'http://relay.invalid');
    if (this.closed) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return true;
    }
    if (url.pathname === '/engine') {
      this.upgradeEngine(req, socket, head);
      return true;
    }
    if (url.pathname === '/ws') {
      this.upgradeClient(req, socket, head, url);
      return true;
    }
    return false;
  }

  private upgradeEngine(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const header = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m || !safeEqual(m[1].trim(), this.config.engineToken)) {
      this.log.warn('engine leg rejected: bad credentials', { ip: req.socket.remoteAddress });
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    this.wssEngine.handleUpgrade(req, socket, head, (ws) => this.onEngine(ws));
  }

  private originAllowsCookie(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser client
    try {
      const o = new URL(origin);
      if (this.config.publicOrigin && origin === this.config.publicOrigin) return true;
      if (req.headers.host && o.host === req.headers.host) return true;
      return this.config.corsOrigins.includes(origin);
    } catch {
      return false;
    }
  }

  private upgradeClient(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void {
    const ip = clientIp(req.headers['x-forwarded-for'], req.socket.remoteAddress, this.config.trustProxy);
    if (this.clients.size >= MAX_CLIENT_LEGS) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    if (!this.hsRate.hit(ip) || !this.hsConcurrent.acquire(ip)) {
      rejectUpgrade(socket, 429, 'Too Many Requests');
      return;
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.hsConcurrent.release(ip);
    };
    socket.once('close', release);
    const cookieToken = this.originAllowsCookie(req) ? sessionTokenFromCookie(req.headers.cookie) : undefined;
    const deviceParam = url.searchParams.get('device') || undefined;
    this.wssClient.handleUpgrade(req, socket, head, (ws) => this.onClient(ws, { ip, cookieToken, deviceParam, release }));
  }

  // ───────────────────────────── client leg ─────────────────────────────

  private onClient(ws: WebSocket, ctx: { ip: string; cookieToken?: string; deviceParam?: string; release: () => void }): void {
    this.pendingClients.add(ws);
    let leg: ClientLeg | null = null;
    const timer = setTimeout(() => {
      if (!leg) ws.close(WS_CLOSE.UNAUTHORIZED, 'auth timeout');
    }, this.config.limits.authHelloTimeoutMs);

    ws.on('message', (data, isBinary) => {
      if (leg) {
        this.onClientFrame(leg, data, isBinary);
        return;
      }
      if (ws.readyState !== WebSocket.OPEN) return;
      leg = this.authenticate(ws, data, isBinary, ctx);
      if (leg) {
        clearTimeout(timer);
        ctx.release();
        this.pendingClients.delete(ws);
      }
    });
    ws.on('pong', () => {
      if (leg) leg.alive = true;
    });
    ws.on('error', (err) => this.log.warn('client leg error', { error: err.message }));
    ws.on('close', () => {
      clearTimeout(timer);
      ctx.release();
      this.pendingClients.delete(ws);
      if (leg) {
        this.clearLegTimers(leg);
        this.clients.delete(leg);
      }
    });
  }

  private authenticate(
    ws: WebSocket,
    data: RawData,
    isBinary: boolean,
    ctx: { ip: string; cookieToken?: string; deviceParam?: string },
  ): ClientLeg | null {
    const fail = (code: number, reason: string) => {
      ws.close(code, reason);
      return null;
    };
    if (isBinary) return fail(WS_CLOSE.UNAUTHORIZED, 'auth required');
    const res = parseEnvelope(rawToString(data), this.config.limits.clientMaxFrameBytes);
    if (!res.ok || res.envelope.type !== 'auth.hello') return fail(WS_CLOSE.UNAUTHORIZED, 'auth required');
    const hello = res.envelope;
    const payloadToken = typeof hello.payload.device_token === 'string' ? hello.payload.device_token : undefined;
    const token = payloadToken || ctx.cookieToken;
    const v = this.auth.verify(token);
    if (!v.ok) return fail(v.reason === 'revoked' ? WS_CLOSE.REVOKED : WS_CLOSE.UNAUTHORIZED, v.reason === 'revoked' ? 'revoked' : 'unauthorized');
    if (ctx.deviceParam && ctx.deviceParam !== v.claims.device_id) return fail(WS_CLOSE.UNAUTHORIZED, 'device mismatch');
    const leg: ClientLeg = { ws, alive: true, deviceId: v.claims.device_id, kind: v.claims.kind, ip: ctx.ip };
    this.clients.add(leg);
    send(
      ws,
      JSON.stringify(
        makeEnvelope(
          'auth.ok',
          { device_id: leg.deviceId, engine_online: this.engineOnline, server_ts: nowS(), kind: leg.kind },
          { reply_to: hello.id },
        ),
      ),
    );
    this.scheduleRotate(leg);
    this.log.info('client leg authenticated', { device_id: leg.deviceId, kind: leg.kind });
    return leg;
  }

  private sendError(ws: WebSocket, code: string, message: string, replyTo?: string): void {
    const payload: Record<string, unknown> = { code, message };
    if (replyTo) payload.reply_to = replyTo;
    send(ws, JSON.stringify(makeEnvelope('error', payload, replyTo ? { reply_to: replyTo } : {})));
  }

  private onClientFrame(leg: ClientLeg, data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.sendError(leg.ws, 'BAD_REQUEST', 'binary frames are not accepted');
      return;
    }
    const res = parseEnvelope(rawToString(data), this.config.limits.clientMaxFrameBytes);
    if (!res.ok) {
      this.sendError(leg.ws, 'BAD_REQUEST', res.error);
      return;
    }
    const env = res.envelope;
    switch (env.type) {
      case 'auth.hello':
        return;
      case 'ping':
        send(leg.ws, JSON.stringify(makeEnvelope('pong', { server_ts: nowS() }, { reply_to: env.id })));
        return;
      case 'media.ticket':
        void this.clientMediaTicket(leg, env);
        return;
      case 'media.refresh':
        void this.clientMediaRefresh(leg, env);
        return;
      case 'sync.resume':
        this.syncResume(leg, env);
        return;
      default:
        break;
    }
    if (CLIENT_FORBIDDEN_TYPES.has(env.type) || CLIENT_FORBIDDEN_PREFIXES.some((p) => env.type.startsWith(p))) {
      this.sendError(leg.ws, 'BAD_REQUEST', `type ${env.type} not allowed`, env.id);
      return;
    }
    env.device_id = leg.deviceId;
    if (!this.toEngine(env.id, JSON.stringify(env), false)) {
      this.sendError(leg.ws, 'ENGINE_OFFLINE', 'engine offline and relay queue full', env.id);
    }
  }

  private async clientMediaTicket(leg: ClientLeg, env: Envelope): Promise<void> {
    const v = validatePayload(ClientToEngine, 'media.ticket', env.payload);
    if (!v || !v.ok) {
      this.sendError(leg.ws, 'BAD_REQUEST', v && !v.ok ? v.error : 'invalid', env.id);
      return;
    }
    if (!this.media) {
      this.sendError(leg.ws, 'INTERNAL', 'media storage not configured', env.id);
      return;
    }
    try {
      const t = await this.media.clientTicket(leg.deviceId, v.data as Record<string, unknown>);
      send(leg.ws, JSON.stringify(makeEnvelope('media.ticket.ok', t, { reply_to: env.id })));
    } catch (err) {
      this.mediaFailure(leg.ws, err, env.id);
    }
  }

  private async clientMediaRefresh(leg: ClientLeg, env: Envelope): Promise<void> {
    const v = validatePayload(ClientToEngine, 'media.refresh', env.payload);
    if (!v || !v.ok) {
      this.sendError(leg.ws, 'BAD_REQUEST', v && !v.ok ? v.error : 'invalid', env.id);
      return;
    }
    if (!this.media) {
      this.sendError(leg.ws, 'INTERNAL', 'media storage not configured', env.id);
      return;
    }
    try {
      const s = await this.media.sign((v.data as { object: string }).object);
      send(leg.ws, JSON.stringify(makeEnvelope('media.refresh.ok', { object: s.object, url: s.url, expires_at: s.expires_at }, { reply_to: env.id })));
    } catch (err) {
      this.mediaFailure(leg.ws, err, env.id);
    }
  }

  private mediaFailure(ws: WebSocket, err: unknown, replyTo: string): void {
    if (err instanceof MediaError) {
      this.sendError(ws, err.code, err.message, replyTo);
    } else {
      this.log.error('media signing failed', { error: err instanceof Error ? err.message : String(err) });
      this.sendError(ws, 'INTERNAL', 'media signing failed', replyTo);
    }
  }

  private syncResume(leg: ClientLeg, env: Envelope): void {
    const v = validatePayload(ClientToEngine, 'sync.resume', env.payload);
    if (!v || !v.ok) {
      this.sendError(leg.ws, 'BAD_REQUEST', v && !v.ok ? v.error : 'invalid', env.id);
      return;
    }
    const { sessions } = v.data as { sessions: { session_id: string; last_seq: number }[] };
    for (const s of sessions) {
      const ring = this.rings.get(s.session_id);
      const hit = ring ? ring.after(s.last_seq) : null;
      let through = s.last_seq;
      if (hit) {
        for (const e of hit) send(leg.ws, e.frame);
        if (hit.length) through = hit[hit.length - 1].seq;
      }
      if (this.engineOnline) {
        const replay = makeEnvelope(
          'sync.replay',
          { session_id: s.session_id, after_seq: through, limit: 500 },
          { device_id: leg.deviceId, session_id: s.session_id, id: newId('req') },
        );
        this.toEngine(replay.id, JSON.stringify(replay), true);
      } else {
        const head = Math.max(through, ring?.headSeq ?? 0);
        send(
          leg.ws,
          JSON.stringify(
            makeEnvelope(
              'sync.done',
              { session_id: s.session_id, replayed_through_seq: through, head_seq: head, has_more: false, active_turn: null },
              { session_id: s.session_id, reply_to: env.id },
            ),
          ),
        );
      }
    }
  }

  // ───────────────────────────── engine queue ─────────────────────────────

  /** Send to the primary engine leg or queue. Returns false when a client frame overflowed the queue. */
  private toEngine(id: string, data: string, control: boolean): boolean {
    if (this.primary && this.primary.ws.readyState === WebSocket.OPEN && this.queue.length === 0) {
      this.primary.ws.send(data);
      return true;
    }
    const limit = this.config.limits.inboundQueue;
    if (!control && this.queue.length >= limit) return false;
    if (control && this.queue.length >= limit * 2) {
      const idx = this.queue.findIndex((q) => !q.control);
      this.queue.splice(idx >= 0 ? idx : 0, 1);
    }
    this.queue.push({ id, data, control });
    if (this.primary && this.primary.ws.readyState === WebSocket.OPEN) this.flushQueue(this.primary);
    return true;
  }

  private flushQueue(leg: EngineLeg): void {
    while (this.queue.length && this.primary === leg && leg.ws.readyState === WebSocket.OPEN) {
      const item = this.queue.shift()!;
      leg.ws.send(item.data);
    }
  }

  // ───────────────────────────── engine leg ─────────────────────────────

  private onEngine(ws: WebSocket): void {
    const leg: EngineLeg = { ws, alive: true, id: ++this.engineSeq, hello: false, draining: false, chain: Promise.resolve() };
    this.engines.add(leg);
    const timer = setTimeout(() => {
      if (!leg.hello) ws.close(WS_CLOSE.UNAUTHORIZED, 'engine.hello required');
    }, this.config.limits.engineHelloTimeoutMs);

    ws.on('message', (data, isBinary) => {
      if (!leg.hello) {
        clearTimeout(timer);
        this.engineHello(leg, data, isBinary);
        return;
      }
      leg.chain = leg.chain
        .then(() => this.onEngineFrame(leg, data, isBinary))
        .catch((err) => this.log.error('engine frame handling failed', { error: err instanceof Error ? err.message : String(err) }));
    });
    ws.on('pong', () => {
      leg.alive = true;
    });
    ws.on('error', (err) => this.log.warn('engine leg error', { error: err.message }));
    ws.on('close', (code) => {
      clearTimeout(timer);
      this.clearLegTimers(leg);
      if (leg.drainTimer) clearTimeout(leg.drainTimer);
      this.engines.delete(leg);
      if (this.primary === leg) {
        this.primary = null;
        this.statusSince = nowS();
        this.log.warn('engine offline', { code });
        this.broadcastStatus();
      }
    });
  }

  private engineHello(leg: EngineLeg, data: RawData, isBinary: boolean): void {
    if (isBinary) {
      leg.ws.close(WS_CLOSE.UNAUTHORIZED, 'engine.hello required');
      return;
    }
    const res = parseEnvelope(rawToString(data), this.config.limits.engineMaxFrameBytes);
    if (!res.ok || res.envelope.type !== 'engine.hello') {
      leg.ws.close(WS_CLOSE.UNAUTHORIZED, 'engine.hello required');
      return;
    }
    const v = validatePayload(EngineToRelay, 'engine.hello', res.envelope.payload);
    if (!v || !v.ok) {
      leg.ws.close(WS_CLOSE.UNAUTHORIZED, 'invalid engine.hello');
      return;
    }
    const hello = v.data as { boot_id: number | string; conn_seq: number; last_inbound_id?: string; revoked_device_ids: string[]; engine_version?: string };
    const cur = this.primary;
    if (cur && cur.bootId !== undefined && cur.connSeq !== undefined) {
      if (compareEngineKey(hello, { boot_id: cur.bootId, conn_seq: cur.connSeq }) <= 0) {
        this.log.warn('engine leg rejected: not newer than primary', { boot_id: String(hello.boot_id), conn_seq: hello.conn_seq });
        leg.ws.close(WS_CLOSE.SUPERSEDED, 'superseded');
        return;
      }
    }
    leg.hello = true;
    leg.bootId = hello.boot_id;
    leg.connSeq = hello.conn_seq;
    const wasOnline = !!cur;
    this.primary = leg;
    if (cur) this.drain(cur);

    this.revokeDevices(hello.revoked_device_ids);
    if (hello.last_inbound_id) {
      const idx = this.queue.findIndex((q) => q.id === hello.last_inbound_id);
      if (idx >= 0) this.queue.splice(0, idx + 1);
    }
    send(leg.ws, JSON.stringify(makeEnvelope('engine.welcome', { primary: true, server_ts: nowS(), queued: this.queue.length }, { reply_to: res.envelope.id })));
    this.flushQueue(leg);
    this.scheduleRotate(leg);
    this.log.info('engine leg primary', { boot_id: String(hello.boot_id), conn_seq: hello.conn_seq, takeover: wasOnline });
    if (!wasOnline) {
      this.statusSince = nowS();
      this.broadcastStatus();
    }
  }

  private drain(old: EngineLeg): void {
    old.draining = true;
    this.clearLegTimers(old);
    old.drainTimer = setTimeout(() => old.ws.close(WS_CLOSE.SUPERSEDED, 'superseded'), this.config.limits.engineDrainMs);
  }

  private broadcastStatus(): void {
    const frame = JSON.stringify(makeEnvelope('engine.status', { online: this.engineOnline, since: this.statusSince, latency_ms: null }));
    for (const c of this.clients) send(c.ws, frame);
  }

  private replyEngine(leg: EngineLeg, type: string, payload: Record<string, unknown>, replyTo?: string): void {
    send(leg.ws, JSON.stringify(makeEnvelope(type, payload, replyTo ? { reply_to: replyTo } : {})));
  }

  private engineError(leg: EngineLeg, err: unknown, replyTo?: string): void {
    const code = err instanceof MediaError ? err.code : 'INTERNAL';
    const message = err instanceof Error ? err.message : String(err);
    if (!(err instanceof MediaError)) this.log.error('engine request failed', { error: message });
    this.replyEngine(leg, 'error', { code, message, ...(replyTo ? { reply_to: replyTo } : {}) }, replyTo);
  }

  private async onEngineFrame(leg: EngineLeg, data: RawData, isBinary: boolean): Promise<void> {
    if (isBinary) {
      await this.engineMediaPut(leg, rawToBuffer(data));
      return;
    }
    const raw = rawToString(data);
    const res = parseEnvelope(raw, this.config.limits.engineMaxFrameBytes);
    if (!res.ok) {
      this.replyEngine(leg, 'error', { code: 'BAD_REQUEST', message: res.error });
      return;
    }
    const env = res.envelope;
    const validated = (type: keyof typeof EngineToRelay) => {
      const v = validatePayload(EngineToRelay, type, env.payload);
      if (!v || !v.ok) {
        this.replyEngine(leg, 'error', { code: 'BAD_REQUEST', message: v && !v.ok ? v.error : 'invalid', reply_to: env.id }, env.id);
        return null;
      }
      return v.data as Record<string, unknown>;
    };
    switch (env.type) {
      case 'engine.hello':
      case 'pong':
        return;
      case 'ping':
        this.replyEngine(leg, 'pong', { server_ts: nowS() }, env.id);
        return;
      case 'pair.offer': {
        const p = validated('pair.offer');
        if (p) {
          this.pairing.setOffer(p as { code_hash: string; salt: string; expires_at: number; name?: string });
          this.log.info('pair offer received');
        }
        return;
      }
      case 'device.revoked': {
        const p = validated('device.revoked');
        if (p) this.revokeDevices(p.device_ids as string[]);
        return;
      }
      case 'media.upload.ticket': {
        const p = validated('media.upload.ticket');
        if (!p) return;
        if (!this.media) return this.engineError(leg, new MediaError('INTERNAL', 'media storage not configured'), env.id);
        try {
          this.replyEngine(leg, 'media.ticket.ok', await this.media.engineTicket(p), env.id);
        } catch (err) {
          this.engineError(leg, err, env.id);
        }
        return;
      }
      case 'media.sign': {
        const p = validated('media.sign');
        if (!p) return;
        if (!this.media) return this.engineError(leg, new MediaError('INTERNAL', 'media storage not configured'), env.id);
        try {
          this.replyEngine(leg, 'media.signed', await this.media.sign(p.object), env.id);
        } catch (err) {
          this.engineError(leg, err, env.id);
        }
        return;
      }
      default:
        await this.deliverToClients(env, raw);
    }
  }

  private async engineMediaPut(leg: EngineLeg, buf: Buffer): Promise<void> {
    let headerId: string | undefined;
    try {
      if (buf.length < 4) throw new MediaError('BAD_REQUEST', 'media.put frame too short');
      const hlen = buf.readUInt32BE(0);
      if (hlen <= 0 || hlen > 16 * 1024 || 4 + hlen > buf.length) throw new MediaError('BAD_REQUEST', 'invalid media.put header length');
      let headerJson: unknown;
      try {
        headerJson = JSON.parse(buf.subarray(4, 4 + hlen).toString('utf8'));
      } catch {
        throw new MediaError('BAD_REQUEST', 'invalid media.put header');
      }
      if (headerJson && typeof headerJson === 'object' && typeof (headerJson as { id?: unknown }).id === 'string') {
        headerId = (headerJson as { id: string }).id;
      }
      const h = MediaPutHeaderSchema.safeParse(headerJson);
      if (!h.success) throw new MediaError('BAD_REQUEST', 'invalid media.put header');
      if (!this.media) throw new MediaError('INTERNAL', 'media storage not configured');
      const bytes = buf.subarray(4 + hlen);
      const r = await this.media.enginePut(h.data, Buffer.from(bytes));
      this.replyEngine(leg, 'media.put.ok', r, h.data.id);
    } catch (err) {
      this.engineError(leg, err, headerId);
    }
  }

  private async deliverToClients(env: Envelope, raw: string): Promise<void> {
    let frame = raw;
    if (env.type === 'media.ready' && this.media && typeof env.payload.object === 'string' && !env.payload.url) {
      try {
        const s = await this.media.sign(env.payload.object);
        env.payload.url = s.url;
        env.payload.expires_at = s.expires_at;
        frame = JSON.stringify(env);
      } catch (err) {
        this.log.warn('media.ready signing failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (env.device_id) {
      for (const c of this.clients) if (c.deviceId === env.device_id) send(c.ws, frame);
      return;
    }
    if (env.session_id && typeof env.seq === 'number') this.rings.push(env.session_id, env.seq, frame);
    for (const c of this.clients) send(c.ws, frame);
  }

  private revokeDevices(ids: string[]): void {
    if (!ids.length) return;
    this.auth.revoke(ids);
    const set = new Set(ids);
    for (const c of this.clients) {
      if (set.has(c.deviceId)) {
        this.log.info('client leg revoked', { device_id: c.deviceId });
        c.ws.close(WS_CLOSE.REVOKED, 'revoked');
      }
    }
  }

  // ───────────────────────────── timers / lifecycle ─────────────────────────────

  private scheduleRotate(leg: Leg): void {
    const L = this.config.limits;
    if (L.rotateAfterMs <= 0) return;
    leg.rotateTimer = setTimeout(() => {
      send(leg.ws, JSON.stringify(makeEnvelope('relay.rotate', { grace_ms: L.rotateGraceMs })));
      leg.forceTimer = setTimeout(() => leg.ws.close(WS_CLOSE.ROTATE, 'rotate'), L.rotateForceCloseMs);
    }, L.rotateAfterMs);
  }

  private clearLegTimers(leg: Leg): void {
    if (leg.rotateTimer) clearTimeout(leg.rotateTimer);
    if (leg.forceTimer) clearTimeout(leg.forceTimer);
    leg.rotateTimer = undefined;
    leg.forceTimer = undefined;
  }

  private beat(): void {
    const legs: Leg[] = [...this.clients, ...this.engines];
    for (const leg of legs) {
      if (!leg.alive) {
        leg.ws.terminate();
        continue;
      }
      leg.alive = false;
      try {
        leg.ws.ping();
      } catch {
        /* closing */
      }
    }
  }

  /** SIGTERM path: tell both legs to come back in `retry_ms`, then close everything. */
  async shutdown(retryMs = this.config.limits.restartRetryMs): Promise<void> {
    if (this.closed) return;
    const frame = JSON.stringify(makeEnvelope('relay.restarting', { retry_ms: retryMs }));
    for (const c of this.clients) send(c.ws, frame);
    for (const e of this.engines) send(e.ws, frame);
    await new Promise((r) => setTimeout(r, 100));
    this.close(SERVICE_RESTART, 'restarting');
  }

  close(code = 1001, reason = 'going away'): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.clients) {
      this.clearLegTimers(c);
      c.ws.close(code, reason);
    }
    for (const ws of this.pendingClients) ws.close(code, reason);
    for (const e of this.engines) {
      this.clearLegTimers(e);
      if (e.drainTimer) clearTimeout(e.drainTimer);
      e.ws.close(code, reason);
    }
    // Force-terminate anything that does not finish the closing handshake promptly.
    const t = setTimeout(() => {
      for (const ws of this.wssClient.clients) ws.terminate();
      for (const ws of this.wssEngine.clients) ws.terminate();
    }, 500);
    t.unref();
    this.wssClient.close();
    this.wssEngine.close();
  }
}

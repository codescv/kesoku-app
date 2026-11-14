import { afterEach, describe, expect, it } from 'vitest';
import { makeEnvelope } from '@kesoku/protocol';
import type { IdTokenVerifier } from '../src/auth/firebase';
import { codeHash, json, makeConfig, openClient, openEngine, sleep, startRelay, type Harness } from './helpers';

const SALT = '0123456789abcdef0123456789abcdef';

const fakeVerifier: IdTokenVerifier = {
  async verifyIdToken(t: string) {
    if (t === 'tok-owner') return { uid: 'u1', email: 'Owner@Example.com', email_verified: true };
    if (t === 'tok-unverified') return { uid: 'u2', email: 'owner@example.com', email_verified: false };
    if (t === 'tok-stranger') return { uid: 'u3', email: 'stranger@example.com', email_verified: true };
    throw new Error('invalid token');
  },
};

let h: Harness | null = null;
afterEach(async () => {
  await h?.stop();
  h = null;
});

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${h!.base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /auth/google', () => {
  it('rejects non-allowlisted and unverified emails with 403 FORBIDDEN_EMAIL', async () => {
    h = await startRelay(makeConfig(), { idTokenVerifier: fakeVerifier });
    for (const t of ['tok-stranger', 'tok-unverified']) {
      const r = await post('/auth/google', { id_token: t });
      expect(r.status).toBe(403);
      expect(await json(r)).toEqual({ error: 'FORBIDDEN_EMAIL' });
      expect(r.headers.get('set-cookie')).toBeNull();
    }
    const bad = await post('/auth/google', { id_token: 'garbage' });
    expect(bad.status).toBe(401);
    expect((await post('/auth/google', 'not json')).status).toBe(400);
  });

  it('issues a google token + HttpOnly cookie; device.registered is queued and delivered on engine connect', async () => {
    h = await startRelay(makeConfig(), { idTokenVerifier: fakeVerifier });
    const r = await post('/auth/google', { id_token: 'tok-owner' });
    expect(r.status).toBe(200);
    const body = await json(r);
    expect(body.email).toBe('owner@example.com');
    expect(body.device_id).toMatch(/^dev_/);
    const cookie = r.headers.get('set-cookie')!;
    expect(cookie).toContain(`__Host-kesoku_session=${body.device_token}`);
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=31536000']) expect(cookie).toContain(attr);
    expect(h.relay.auth.verify(body.device_token)).toMatchObject({ ok: true, claims: { kind: 'google', device_id: body.device_id } });

    const { peer, welcome } = await openEngine(h);
    expect(welcome.payload).toMatchObject({ primary: true, queued: 1 });
    const reg = await peer.next('device.registered');
    expect(reg.payload).toEqual({ device_id: body.device_id, kind: 'google', name: 'owner@example.com', email: 'owner@example.com', platform: 'web' });
    peer.close();
  });

  it('503 when Google sign-in is not configured', async () => {
    h = await startRelay(makeConfig());
    expect((await post('/auth/google', { id_token: 'tok-owner' })).status).toBe(503);
  });
});

describe('POST /pair', () => {
  it('redeems a valid code once: token + cookie, pair.redeem to engine, offer burned after use', async () => {
    h = await startRelay(makeConfig());
    const { peer: engine } = await openEngine(h);
    engine.send(makeEnvelope('pair.offer', { code_hash: codeHash('483920', SALT), salt: SALT, expires_at: Date.now() / 1000 + 120, name: 'iPhone 17' }));
    await sleep(50);
    const r = await post('/pair', { code: '483 920', device: { platform: 'ios', model: 'iPhone17,1' } });
    expect(r.status).toBe(200);
    const body = await json(r);
    expect(h.relay.auth.verify(body.device_token)).toMatchObject({ ok: true, claims: { kind: 'pair', device_id: body.device_id } });
    expect(r.headers.get('set-cookie')).toContain('__Host-kesoku_session=');
    const redeem = await engine.next('pair.redeem');
    expect(redeem.payload).toEqual({ device_id: body.device_id, name: 'iPhone 17', platform: 'ios', model: 'iPhone17,1' });
    // Single use.
    expect((await post('/pair', { code: '483920', device: { platform: 'ios' } })).status).toBe(403);
    engine.close();
  });

  it('wrong code → 403, and the offer is destroyed after 5 failures across IPs (6th correct code still 403 + pair.burned)', async () => {
    h = await startRelay(makeConfig({ trustProxy: true }));
    const { peer: engine } = await openEngine(h);
    const hash = codeHash('111222', SALT);
    engine.send(makeEnvelope('pair.offer', { code_hash: hash, salt: SALT, expires_at: Date.now() / 1000 + 120, name: 'Pixel' }));
    await sleep(50);
    for (let i = 0; i < 5; i++) {
      const r = await post('/pair', { code: String(100000 + i), device: { platform: 'android' } }, { 'X-Forwarded-For': `198.51.100.${i + 1}` });
      expect(r.status).toBe(403);
      expect(await json(r)).toEqual({ error: 'PAIR_FAILED' });
    }
    const burned = await engine.next('pair.burned');
    expect(burned.payload).toEqual({ code_hash: hash, attempts: 5 });
    const late = await post('/pair', { code: '111222', device: { platform: 'android' } }, { 'X-Forwarded-For': '198.51.100.99' });
    expect(late.status).toBe(403);
    expect(await engine.none('pair.redeem')).toBe(true);
    engine.close();
  });

  it('rate limits per rightmost X-Forwarded-For IP (5 / 10 min) → 429', async () => {
    h = await startRelay(makeConfig({ trustProxy: true }));
    for (let i = 0; i < 5; i++) {
      const r = await post('/pair', { code: '000000', device: { platform: 'web' } }, { 'X-Forwarded-For': `10.9.9.${i}, 203.0.113.7` });
      expect(r.status).toBe(403); // no active offer
    }
    // Spoofing the leftmost entry does not help.
    const limited = await post('/pair', { code: '000000', device: { platform: 'web' } }, { 'X-Forwarded-For': '1.2.3.4, 203.0.113.7' });
    expect(limited.status).toBe(429);
    // A different real client is unaffected.
    const other = await post('/pair', { code: '000000', device: { platform: 'web' } }, { 'X-Forwarded-For': '203.0.113.7, 203.0.113.8' });
    expect(other.status).toBe(403);
  });

  it('expired offer → 403 even with the right code', async () => {
    h = await startRelay(makeConfig());
    h.relay.pairing.setOffer({ code_hash: codeHash('654321', SALT), salt: SALT, expires_at: Date.now() / 1000 - 1, name: '' });
    const r = await post('/pair', { code: '654321', device: { platform: 'web' } });
    expect(r.status).toBe(403);
    expect(h.relay.pairing.active).toBeNull();
  });

  it('pair.redeem is queued while the engine is offline', async () => {
    h = await startRelay(makeConfig());
    h.relay.pairing.setOffer({ code_hash: codeHash('222333', SALT), salt: SALT, expires_at: Date.now() / 1000 + 60, name: 'Tablet' });
    const r = await post('/pair', { code: '222333', device: { platform: 'android', name: 'My Tab' } });
    expect(r.status).toBe(200);
    const { device_id } = await json(r);
    const { peer, welcome } = await openEngine(h);
    expect(welcome.payload.queued).toBe(1);
    expect((await peer.next('pair.redeem')).payload).toMatchObject({ device_id, name: 'My Tab', platform: 'android' });
    peer.close();
  });

  it('validates the body', async () => {
    h = await startRelay(makeConfig());
    expect((await post('/pair', { code: '12', device: { platform: 'web' } })).status).toBe(400);
    expect((await post('/pair', { code: '123456', device: { platform: 'symbian' } })).status).toBe(400);
    expect((await post('/pair', '{')).status).toBe(400);
  });
});

describe('logout, health, static, headers', () => {
  it('POST /auth/logout clears cookies with 204', async () => {
    h = await startRelay(makeConfig());
    const r = await post('/auth/logout', {});
    expect(r.status).toBe(204);
    const cookies = r.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith('__Host-kesoku_session=;') && c.includes('Max-Age=0'))).toBe(true);
  });

  it('GET /healthz and /engine/status', async () => {
    h = await startRelay(makeConfig());
    const r = await fetch(`${h.base}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('ok');
    expect(await (await fetch(`${h.base}/engine/status`)).json()).toMatchObject({ online: false, since: expect.any(Number) });
    const { peer } = await openEngine(h);
    expect(await (await fetch(`${h.base}/engine/status`)).json()).toMatchObject({ online: true });
    peer.close();
  });

  it('security headers on every response (static, API, 404)', async () => {
    h = await startRelay(makeConfig());
    for (const p of ['/', '/healthz', '/engine/status', '/nope.png', '/auth/unknown']) {
      const r = await fetch(`${h.base}${p}`);
      const csp = r.headers.get('content-security-policy')!;
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain('connect-src \'self\' wss: https://storage.googleapis.com https://*.googleapis.com https://*.firebaseapp.com');
      expect(csp).not.toContain('127.0.0.1');
      expect(csp).toContain("script-src 'self';");
      expect(r.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('x-frame-options')).toBe('DENY');
      expect(r.headers.get('referrer-policy')).toBe('no-referrer');
      expect(r.headers.get('permissions-policy')).toBe('camera=(self), microphone=(self), geolocation=()');
      expect(r.headers.get('strict-transport-security')).toBeNull();
    }
  });

  it('HSTS on Cloud Run and loopback CSP in local mode', async () => {
    h = await startRelay(makeConfig({ cloudRun: true, localMode: true }));
    const r = await fetch(`${h.base}/healthz`);
    expect(r.headers.get('strict-transport-security')).toMatch(/max-age=\d+/);
    expect(r.headers.get('content-security-policy')).toContain('http://127.0.0.1:* ws://127.0.0.1:*');
  });

  it('SPA fallback, immutable assets, no-cache shell files, 404 for missing files', async () => {
    h = await startRelay(makeConfig());
    const root = await fetch(`${h.base}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');
    expect(root.headers.get('cache-control')).toBe('no-cache');
    const spa = await fetch(`${h.base}/mode/translator`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain('<title>Kesoku</title>');
    expect(spa.headers.get('cache-control')).toBe('no-cache');
    const asset = await fetch(`${h.base}/assets/app-abc123.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${h.base}/sw.js`)).headers.get('cache-control')).toBe('no-cache');
    expect((await fetch(`${h.base}/manifest.webmanifest`)).headers.get('cache-control')).toBe('no-cache');
    expect((await fetch(`${h.base}/assets/missing.js`)).status).toBe(404);
    // Traversal attempts never escape the static root (normalised → SPA shell, never the real file).
    const trav = await fetch(`${h.base}/%2e%2e/%2e%2e/%2e%2e/etc/passwd`);
    expect(await trav.text()).not.toContain('root:');
    const trav2 = await fetch(`${h.base}/assets/..%2f..%2f..%2fetc%2fhosts`);
    expect(await trav2.text()).not.toContain('localhost');
    const etag = root.headers.get('etag')!;
    expect((await fetch(`${h.base}/`, { headers: { 'If-None-Match': etag } })).status).toBe(304);
  });

  it('GET /auth/config exposes the public Firebase web config and widens script-src only when set', async () => {
    h = await startRelay(makeConfig());
    expect(await json(await fetch(`${h.base}/auth/config`))).toEqual({ firebase: null, google_login: false });
    await h.stop();
    const firebaseWeb = { apiKey: 'public-web-key', authDomain: 'demo.firebaseapp.com', projectId: 'demo' };
    h = await startRelay(makeConfig({ firebaseWeb, firebaseProjectId: 'demo' }), { idTokenVerifier: fakeVerifier });
    const r = await fetch(`${h.base}/auth/config`);
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ firebase: firebaseWeb, google_login: true });
    expect(r.headers.get('content-security-policy')).toContain("script-src 'self' https://apis.google.com;");
    expect(r.headers.get('content-security-policy')).toContain("frame-src 'self' https://*.firebaseapp.com https://accounts.google.com");
  });

  it('CORS preflight only for allowed native origins', async () => {
    h = await startRelay(makeConfig());
    const ok = await fetch(`${h.base}/pair`, { method: 'OPTIONS', headers: { Origin: 'capacitor://localhost', 'Access-Control-Request-Method': 'POST' } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('capacitor://localhost');
    const bad = await fetch(`${h.base}/pair`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
    expect(bad.status).toBe(403);
  });

  it('native origin gets credentialed CORS on /pair and /auth/config', async () => {
    h = await startRelay(makeConfig());
    const origin = 'capacitor://localhost';
    for (const [path, method] of [
      ['/pair', 'POST'],
      ['/auth/config', 'GET'],
    ] as const) {
      const pre = await fetch(`${h.base}${path}`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': method } });
      expect(pre.status).toBe(204);
      expect(pre.headers.get('access-control-allow-origin')).toBe(origin);
      expect(pre.headers.get('access-control-allow-credentials')).toBe('true');
      expect(pre.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
    }
    const cfg = await fetch(`${h.base}/auth/config`, { headers: { Origin: origin } });
    expect(cfg.status).toBe(200);
    expect(cfg.headers.get('access-control-allow-origin')).toBe(origin);
    expect(cfg.headers.get('access-control-allow-credentials')).toBe('true');
    const pr = await post('/pair', { code: '000000' }, { Origin: origin });
    expect(pr.headers.get('access-control-allow-origin')).toBe(origin);
    expect(pr.headers.get('access-control-allow-credentials')).toBe('true');
    // Unlisted origins never get CORS headers.
    const evil = await fetch(`${h.base}/auth/config`, { headers: { Origin: 'https://evil.example' } });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    expect(evil.headers.get('access-control-allow-credentials')).toBeNull();
    const evilPre = await fetch(`${h.base}/auth/config`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
    expect(evilPre.status).toBe(403);
  });

  it('cookie auth works over WS for same-origin requests only', async () => {
    h = await startRelay(makeConfig(), { idTokenVerifier: fakeVerifier });
    const r = await post('/auth/google', { id_token: 'tok-owner' });
    const { device_id, device_token } = await json(r);
    const cookie = `__Host-kesoku_session=${device_token}`;
    const { peer, ok } = await openClient(h, { cookie, headers: { Origin: h.base } });
    expect(ok.payload).toMatchObject({ device_id, kind: 'google', engine_online: false });
    peer.close();
  });
});

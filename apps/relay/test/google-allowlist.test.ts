import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { WS_CLOSE, b64urlEncode, makeEnvelope, splitDeviceToken } from '@kesoku/protocol';
import type { IdTokenVerifier } from '../src/auth/firebase';
import { DeviceAuth, newDeviceId } from '../src/auth/device';
import { buildCsp } from '../src/security';
import type { RelayConfig } from '../src/config';
import { HMAC_KEY, Peer, codeHash, json, makeConfig, openClient, openEngine, sleep, startRelay, type Harness } from './helpers';

const SALT = '0123456789abcdef0123456789abcdef';
const FIREBASE_WEB = { apiKey: 'public-web-key', authDomain: 'demo.firebaseapp.com', projectId: 'demo' };

const fakeVerifier: IdTokenVerifier = {
  async verifyIdToken(t: string) {
    if (t === 'tok-owner') return { uid: 'u1', email: 'Owner@Example.com', email_verified: true };
    if (t === 'tok-stranger') return { uid: 'u3', email: 'stranger@example.com', email_verified: true };
    if (t === 'tok-unverified') return { uid: 'u2', email: 'owner@example.com', email_verified: false };
    throw new Error('invalid token');
  },
};

let h: Harness | null = null;
afterEach(async () => {
  await h?.stop();
  h = null;
});

function googleConfig(over: Partial<RelayConfig> = {}): RelayConfig {
  return makeConfig({ firebaseWeb: FIREBASE_WEB, firebaseProjectId: 'demo', ...over });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${h!.base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function offer(engine: Peer, code: string) {
  engine.send(makeEnvelope('pair.offer', { code_hash: codeHash(code, SALT), salt: SALT, expires_at: Date.now() / 1000 + 120, name: 'Phone' }));
  await sleep(50);
}

const hello = (payload: Record<string, unknown> = {}) => makeEnvelope('auth.hello', { client: { platform: 'web', version: '1', locale: 'en' }, ...payload });

function rawClient(headers: Record<string, string> = {}) {
  return new Peer(new WebSocket(`${h!.wsBase}/ws`, { headers }));
}

async function expectClose(headers: Record<string, string>, payload: Record<string, unknown> = {}): Promise<number> {
  const p = rawClient(headers);
  await p.opened;
  p.send(hello(payload));
  return (await p.closed).code;
}

describe('device token email binding', () => {
  const auth = new DeviceAuth(HMAC_KEY);

  it('google tokens carry a 4-part body with the lower-cased email and verify', () => {
    const id = newDeviceId();
    const { token, claims } = auth.issue('google', id, 1_763_100_000, '  Owner@Example.COM ');
    expect(claims).toEqual({ device_id: id, issued_at: 1_763_100_000, kind: 'google', email: 'owner@example.com' });
    expect(splitDeviceToken(token)!.body).toBe(`${id}|1763100000|google|owner@example.com`);
    expect(auth.verify(token)).toEqual({ ok: true, claims });
  });

  it('pair tokens stay 3-part even when an email is passed; 1-3 arg callers unchanged', () => {
    const id = newDeviceId();
    const p = auth.issue('pair', id, 1_763_100_000, 'owner@example.com');
    expect(splitDeviceToken(p.token)!.body).toBe(`${id}|1763100000|pair`);
    expect(p.claims.email).toBeUndefined();
    const legacy = auth.issue('google', id, 1_763_100_000);
    expect(splitDeviceToken(legacy.token)!.body).toBe(`${id}|1763100000|google`);
    expect(auth.verify(legacy.token)).toEqual({ ok: true, claims: { device_id: id, issued_at: 1_763_100_000, kind: 'google' } });
  });

  it('the email is covered by the MAC (swapping it is rejected)', () => {
    const { token, claims } = auth.issue('google', undefined, undefined, 'owner@example.com');
    const [p, , mac] = token.split('.');
    const forged = new TextEncoder().encode(`${claims.device_id}|${claims.issued_at}|google|attacker@example.com`);
    expect(auth.verify(`${p}.${b64urlEncode(forged)}.${mac}`)).toEqual({ ok: false, reason: 'bad_mac' });
  });
});

describe('POST /auth/google allowlist', () => {
  it('allowlisted email → 200 + __Host-kesoku_session bound to the email', async () => {
    h = await startRelay(googleConfig(), { idTokenVerifier: fakeVerifier });
    const r = await post('/auth/google', { id_token: 'tok-owner' });
    expect(r.status).toBe(200);
    const body = await json(r);
    expect(body.email).toBe('owner@example.com');
    expect(r.headers.get('set-cookie')).toContain(`__Host-kesoku_session=${body.device_token}`);
    expect(h.relay.auth.verify(body.device_token)).toMatchObject({ ok: true, claims: { kind: 'google', email: 'owner@example.com' } });
  });

  it('non-allowlisted email → 403 FORBIDDEN_EMAIL with the email and cleared session cookies', async () => {
    h = await startRelay(googleConfig(), { idTokenVerifier: fakeVerifier });
    const r = await post('/auth/google', { id_token: 'tok-stranger' }, { Cookie: '__Host-kesoku_session=stale' });
    expect(r.status).toBe(403);
    expect(await json(r)).toEqual({ error: 'FORBIDDEN_EMAIL', email: 'stranger@example.com' });
    const cookies = r.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith('__Host-kesoku_session=;') && c.includes('Max-Age=0'))).toBe(true);
    expect(cookies.some((c) => c.startsWith('__Secure-kesoku_session=;') && c.includes('Max-Age=0'))).toBe(true);
    expect(cookies.some((c) => /^__Host-kesoku_session=kdt1/.test(c))).toBe(false);
  });
});

describe('POST /pair when Google Sign-In is enabled', () => {
  it('rejects platform web with 403 WEB_GOOGLE_REQUIRED without consuming the offer', async () => {
    h = await startRelay(googleConfig({ trustProxy: true }), { idTokenVerifier: fakeVerifier });
    const { peer: engine } = await openEngine(h);
    await offer(engine, '483920');
    // More browser attempts than the per-offer failure budget never burn the native offer (redeem is never reached).
    for (let i = 0; i < 6; i++) {
      const r = await post('/pair', { code: i % 2 ? '000000' : '483920', device: { platform: 'web' } }, { 'X-Forwarded-For': `203.0.113.${i + 1}` });
      expect(r.status).toBe(403);
      expect(await json(r)).toEqual({ error: 'WEB_GOOGLE_REQUIRED' });
      expect(r.headers.get('set-cookie')).toBeNull();
    }
    expect(await engine.none('pair.burned', 100)).toBe(true);
    const ok = await post('/pair', { code: '483920', device: { platform: 'ios', model: 'iPhone17,1' } });
    expect(ok.status).toBe(200);
    engine.close();
  });

  it.each(['ios', 'android'] as const)('%s pairs with a JSON device_token and no cookie', async (platform) => {
    h = await startRelay(googleConfig(), { idTokenVerifier: fakeVerifier });
    const { peer: engine } = await openEngine(h);
    await offer(engine, '111222');
    const r = await post('/pair', { code: '111222', device: { platform } });
    expect(r.status).toBe(200);
    const body = await json(r);
    expect(h.relay.auth.verify(body.device_token)).toMatchObject({ ok: true, claims: { kind: 'pair', device_id: body.device_id } });
    expect(r.headers.get('set-cookie')).toBeNull();
    const redeem = await engine.next('pair.redeem');
    expect(redeem.payload).toMatchObject({ device_id: body.device_id, platform });
    engine.close();
  });

  it('local mode without Firebase still lets the Web pair and sets the cookie', async () => {
    h = await startRelay(makeConfig());
    const { peer: engine } = await openEngine(h);
    await offer(engine, '333444');
    const r = await post('/pair', { code: '333444', device: { platform: 'web' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toContain('__Host-kesoku_session=');
    engine.close();
  });
});

describe('/ws auth when Google Sign-In is enabled', () => {
  it('rejects a cookie-based pair token with 4403', async () => {
    h = await startRelay(googleConfig(), { idTokenVerifier: fakeVerifier });
    const { token } = h.relay.auth.issue('pair');
    expect(await expectClose({ Cookie: `__Host-kesoku_session=${token}`, Origin: h.base })).toBe(WS_CLOSE.FORBIDDEN);
  });

  it('rejects a cookie-based legacy google token without an email with 4403', async () => {
    h = await startRelay(googleConfig(), { idTokenVerifier: fakeVerifier });
    const { token } = h.relay.auth.issue('google');
    expect(await expectClose({ Cookie: `__Host-kesoku_session=${token}`, Origin: h.base })).toBe(WS_CLOSE.FORBIDDEN);
  });

  it('accepts a cookie-based allowlisted google token from /auth/google', async () => {
    h = await startRelay(googleConfig(), { idTokenVerifier: fakeVerifier });
    const { device_id, device_token } = await json(await post('/auth/google', { id_token: 'tok-owner' }));
    const { peer, ok } = await openClient(h, { cookie: `__Host-kesoku_session=${device_token}`, headers: { Origin: h.base } });
    expect(ok.payload).toMatchObject({ device_id, kind: 'google' });
    peer.close();
  });

  it('revokes google sessions whose email was removed from the allowlist (cookie and payload token)', async () => {
    h = await startRelay(googleConfig({ allowedEmails: ['other@example.com'] }), { idTokenVerifier: fakeVerifier });
    const { token } = h.relay.auth.issue('google', undefined, undefined, 'owner@example.com');
    expect(await expectClose({ Cookie: `__Host-kesoku_session=${token}`, Origin: h.base })).toBe(WS_CLOSE.FORBIDDEN);
    expect(await expectClose({}, { device_token: token })).toBe(WS_CLOSE.FORBIDDEN);
  });

  it('accepts native pair device_token in the auth.hello payload', async () => {
    h = await startRelay(googleConfig(), { idTokenVerifier: fakeVerifier });
    const { token, claims } = h.relay.auth.issue('pair');
    const { peer, ok } = await openClient(h, { token, headers: { Origin: 'capacitor://localhost' } });
    expect(ok.payload).toMatchObject({ device_id: claims.device_id, kind: 'pair' });
    peer.close();
  });

  it('without Firebase, cookie-based pair tokens keep working (local mode)', async () => {
    h = await startRelay(makeConfig());
    const { token, claims } = h.relay.auth.issue('pair');
    const { peer, ok } = await openClient(h, { cookie: `__Host-kesoku_session=${token}`, headers: { Origin: h.base } });
    expect(ok.payload).toMatchObject({ device_id: claims.device_id, kind: 'pair' });
    peer.close();
  });
});

describe('CSP for Google Sign-In', () => {
  it('widens script/connect/img/frame sources only when Google Sign-In is configured', () => {
    const on = buildCsp(false, true);
    expect(on).toContain("script-src 'self' https://apis.google.com;");
    expect(on).toMatch(/connect-src [^;]*https:\/\/\*\.googleapis\.com https:\/\/\*\.firebaseapp\.com https:\/\/apis\.google\.com https:\/\/accounts\.google\.com/);
    expect(on).toMatch(/img-src [^;]*https:\/\/\*\.googleusercontent\.com/);
    expect(on).toContain("frame-src 'self' https://*.firebaseapp.com https://accounts.google.com");
    const off = buildCsp(false, false);
    expect(off).toContain("script-src 'self';");
    expect(off).not.toContain('googleusercontent');
    expect(off).not.toContain('https://apis.google.com');
  });
});

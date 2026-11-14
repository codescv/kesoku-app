import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, resolveBind } from '../src/config';
import { ConcurrencyLimiter, SlidingWindowLimiter, clientIp } from '../src/ratelimit';
import { buildCsp, safeEqual, securityHeaders } from '../src/security';
import { ENGINE_TOKEN, HMAC_KEY } from './helpers';

describe('config', () => {
  it('fails fast on missing or weak secrets', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ ENGINE_TOKEN, DEVICE_HMAC_KEY: 'too-short' })).toThrow(/DEVICE_HMAC_KEY/);
    expect(() => loadConfig({ DEVICE_HMAC_KEY: HMAC_KEY })).toThrow(/ENGINE_TOKEN/);
  });

  it('parses env', () => {
    const c = loadConfig({
      ENGINE_TOKEN,
      DEVICE_HMAC_KEY: HMAC_KEY,
      ALLOWED_EMAILS: ' Owner@Example.com, second@example.com ',
      K_SERVICE: 'kesoku-relay',
      MEDIA_BUCKET: 'b',
      PUBLIC_ORIGIN: 'https://relay.example.com/',
    });
    expect(c.allowedEmails).toEqual(['owner@example.com', 'second@example.com']);
    expect(c.trustProxy).toBe(true);
    expect(c.cloudRun).toBe(true);
    expect(c.publicOrigin).toBe('https://relay.example.com');
    expect(c.localMode).toBe(false);
    expect(c.staticDir).toMatch(/client[\\/]dist$/);
    expect(c.firebaseWeb).toBeNull();
    const f = loadConfig({ ENGINE_TOKEN, DEVICE_HMAC_KEY: HMAC_KEY, FIREBASE_PROJECT_ID: 'demo', FIREBASE_WEB_API_KEY: 'k' });
    expect(f.firebaseWeb).toEqual({ apiKey: 'k', authDomain: 'demo.firebaseapp.com', projectId: 'demo' });
  });

  it('binds loopback unless K_SERVICE or RELAY_HOST', () => {
    expect(resolveBind({})).toEqual({ host: '127.0.0.1', port: 8080 });
    expect(resolveBind({ K_SERVICE: 'x', PORT: '9000' })).toEqual({ host: '0.0.0.0', port: 9000 });
    expect(resolveBind({ K_SERVICE: 'x', RELAY_HOST: '::1' }).host).toBe('::1');
    expect(resolveBind({ RELAY_HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
  });
});

describe('rate limiting', () => {
  it('uses the rightmost X-Forwarded-For only behind a trusted proxy', () => {
    expect(clientIp('1.1.1.1, 2.2.2.2, 3.3.3.3', '10.0.0.1', true)).toBe('3.3.3.3');
    expect(clientIp(['9.9.9.9', '4.4.4.4'], '10.0.0.1', true)).toBe('4.4.4.4');
    expect(clientIp('1.1.1.1', '::ffff:127.0.0.1', false)).toBe('127.0.0.1');
    expect(clientIp(undefined, '10.0.0.1', true)).toBe('10.0.0.1');
  });

  it('sliding window and concurrency', () => {
    let t = 0;
    const l = new SlidingWindowLimiter(2, 1000, () => t);
    expect(l.hit('a')).toBe(true);
    expect(l.hit('a')).toBe(true);
    expect(l.hit('a')).toBe(false);
    expect(l.hit('b')).toBe(true);
    t = 1001;
    expect(l.hit('a')).toBe(true);
    const c = new ConcurrencyLimiter(1);
    expect(c.acquire('x')).toBe(true);
    expect(c.acquire('x')).toBe(false);
    c.release('x');
    expect(c.acquire('x')).toBe(true);
  });
});

describe('security helpers', () => {
  it('safeEqual', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('CSP adds loopback only in local mode; HSTS only on Cloud Run', () => {
    expect(buildCsp(false)).not.toContain('127.0.0.1');
    expect(buildCsp(true)).toContain('http://127.0.0.1:* ws://127.0.0.1:*');
    expect(buildCsp(false)).toContain("script-src 'self';");
    expect(buildCsp(false, true)).toContain("script-src 'self' https://apis.google.com;");
    expect(securityHeaders({ localMode: false, cloudRun: false })['Strict-Transport-Security']).toBeUndefined();
    expect(securityHeaders({ localMode: false, cloudRun: true })['Strict-Transport-Security']).toMatch(/max-age=/);
  });
});

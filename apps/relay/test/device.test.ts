import { describe, expect, it } from 'vitest';
import { DEVICE_ID_RE, b64urlDecode, b64urlEncode, splitDeviceToken } from '@kesoku/protocol';
import { DeviceAuth, newDeviceId } from '../src/auth/device';
import { HMAC_KEY } from './helpers';

describe('device tokens', () => {
  const auth = new DeviceAuth(HMAC_KEY);

  it('issues kdt1 tokens that verify', () => {
    const { token, claims } = auth.issue('pair');
    expect(token.startsWith('kdt1.')).toBe(true);
    expect(DEVICE_ID_RE.test(claims.device_id)).toBe(true);
    const v = auth.verify(token);
    expect(v).toEqual({ ok: true, claims });
    const parts = splitDeviceToken(token)!;
    expect(parts.body).toBe(`${claims.device_id}|${claims.issued_at}|pair`);
  });

  it('round-trips google kind and explicit ids', () => {
    const id = newDeviceId();
    const { token } = auth.issue('google', id, 1_763_100_000);
    const v = auth.verify(token);
    expect(v.ok && v.claims).toEqual({ device_id: id, issued_at: 1_763_100_000, kind: 'google' });
  });

  it('rejects tampered body, tampered mac, foreign key and garbage', () => {
    const { token, claims } = auth.issue('pair');
    const [p, body, mac] = token.split('.');
    // Tamper body: switch kind to google but keep the MAC.
    const forged = new TextEncoder().encode(`${claims.device_id}|${claims.issued_at}|google`);
    expect(auth.verify(`${p}.${b64urlEncode(forged)}.${mac}`)).toEqual({ ok: false, reason: 'bad_mac' });
    // Tamper MAC (flip a byte).
    const macBytes = b64urlDecode(mac);
    macBytes[0] ^= 0xff;
    expect(auth.verify(`${p}.${body}.${b64urlEncode(macBytes)}`)).toEqual({ ok: false, reason: 'bad_mac' });
    // Truncated MAC.
    expect(auth.verify(`${p}.${body}.${mac.slice(0, 10)}`)).toEqual({ ok: false, reason: 'bad_mac' });
    // Different key.
    const other = new DeviceAuth('another-hmac-key-another-hmac-key-0000');
    expect(other.verify(token)).toEqual({ ok: false, reason: 'bad_mac' });
    // Garbage.
    for (const t of ['', 'kdt1', 'kdt2.a.b', 'kdt1.!!.??', `kdt1.${body}`, undefined, null]) {
      expect(auth.verify(t as string).ok).toBe(false);
    }
  });

  it('revocation rejects otherwise valid tokens', () => {
    const { token, claims } = auth.issue('google');
    auth.revoke([claims.device_id]);
    expect(auth.isRevoked(claims.device_id)).toBe(true);
    expect(auth.verify(token)).toEqual({ ok: false, reason: 'revoked' });
    const fresh = auth.issue('google');
    expect(auth.verify(fresh.token).ok).toBe(true);
  });

  it('refuses weak keys', () => {
    expect(() => new DeviceAuth('short')).toThrow();
  });
});

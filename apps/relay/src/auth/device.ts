import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  DEVICE_TOKEN_PREFIX,
  b64urlDecode,
  b64urlEncode,
  encodeClaims,
  splitDeviceToken,
  type DeviceTokenClaims,
} from '@kesoku/protocol';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** `dev_` + 24 base62 chars (matches DEVICE_ID_RE). */
export function newDeviceId(): string {
  const bytes = randomBytes(24);
  let out = 'dev_';
  for (let i = 0; i < bytes.length; i++) out += BASE62[bytes[i] % 62];
  return out;
}

export type VerifyResult =
  | { ok: true; claims: DeviceTokenClaims }
  | { ok: false; reason: 'malformed' | 'bad_mac' | 'revoked' };

/**
 * Stateless HMAC device tokens (`kdt1.<b64url(claims)>.<b64url(HMAC-SHA256)>`) + in-memory revocation set
 * (seeded by `engine.hello.revoked_device_ids`, extended by `device.revoked`).
 */
export class DeviceAuth {
  private readonly key: Buffer;
  private readonly revoked = new Set<string>();

  constructor(hmacKey: string) {
    if (!hmacKey || hmacKey.length < 32) throw new Error('DEVICE_HMAC_KEY must be >= 32 chars');
    this.key = Buffer.from(hmacKey, 'utf8');
  }

  private mac(body: string): Buffer {
    return createHmac('sha256', this.key).update(body, 'utf8').digest();
  }

  issue(kind: DeviceTokenClaims['kind'], deviceId: string = newDeviceId(), issuedAt: number = Math.floor(Date.now() / 1000)): {
    token: string;
    claims: DeviceTokenClaims;
  } {
    const claims: DeviceTokenClaims = { device_id: deviceId, issued_at: Math.floor(issuedAt), kind };
    const body = encodeClaims(claims);
    const token = `${DEVICE_TOKEN_PREFIX}.${b64urlEncode(new TextEncoder().encode(body))}.${b64urlEncode(this.mac(body))}`;
    return { token, claims };
  }

  verify(token: string | undefined | null): VerifyResult {
    if (!token) return { ok: false, reason: 'malformed' };
    const parts = splitDeviceToken(token);
    if (!parts) return { ok: false, reason: 'malformed' };
    let given: Uint8Array;
    try {
      given = b64urlDecode(parts.macB64);
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    const expected = this.mac(parts.body);
    // Re-encode check guards against non-canonical body encodings.
    const canonical = b64urlEncode(new TextEncoder().encode(parts.body)) === parts.bodyB64;
    const sameLen = given.length === expected.length;
    const macOk = timingSafeEqual(sameLen ? Buffer.from(given) : expected, expected) && sameLen;
    if (!macOk || !canonical) return { ok: false, reason: 'bad_mac' };
    if (this.revoked.has(parts.claims.device_id)) return { ok: false, reason: 'revoked' };
    return { ok: true, claims: parts.claims };
  }

  revoke(ids: Iterable<string>): void {
    for (const id of ids) if (typeof id === 'string' && id) this.revoked.add(id);
  }

  isRevoked(id: string): boolean {
    return this.revoked.has(id);
  }

  get revokedCount(): number {
    return this.revoked.size;
  }
}

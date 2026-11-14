/**
 * Device token wire format (Blueprint §4.2):
 *   kdt1.<b64url(device_id "|" issued_at "|" kind)>.<b64url(HMAC-SHA256(DEVICE_HMAC_KEY, same bytes))>
 * `issued_at` is integer Unix seconds, `kind` ∈ {pair, google}. HMAC is computed/verified by the relay only.
 */

export const DEVICE_TOKEN_PREFIX = 'kdt1';
export const DEVICE_ID_RE = /^dev_[0-9A-Za-z]{10,40}$/;

export interface DeviceTokenClaims {
  device_id: string;
  issued_at: number;
  kind: 'pair' | 'google';
}

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('invalid base64url');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeClaims(c: DeviceTokenClaims): string {
  return `${c.device_id}|${Math.floor(c.issued_at)}|${c.kind}`;
}

export function decodeClaims(body: string): DeviceTokenClaims | null {
  const parts = body.split('|');
  if (parts.length !== 3) return null;
  const [device_id, issued, kind] = parts;
  if (!DEVICE_ID_RE.test(device_id)) return null;
  if (!/^\d{1,12}$/.test(issued)) return null;
  if (kind !== 'pair' && kind !== 'google') return null;
  return { device_id, issued_at: Number(issued), kind };
}

/** Split a token into its parts without verifying the MAC. */
export function splitDeviceToken(token: string): { body: string; bodyB64: string; macB64: string; claims: DeviceTokenClaims } | null {
  if (typeof token !== 'string' || token.length > 512) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== DEVICE_TOKEN_PREFIX) return null;
  try {
    const body = new TextDecoder().decode(b64urlDecode(parts[1]));
    const claims = decodeClaims(body);
    if (!claims) return null;
    return { body, bodyB64: parts[1], macB64: parts[2], claims };
  } catch {
    return null;
  }
}

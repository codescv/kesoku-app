import { createHash, timingSafeEqual } from 'node:crypto';
import type { RelayConfig } from './config';

/** Constant-time string comparison (hash both sides so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/**
 * @param localMode   adds loopback http/ws sources (offline E2E with LOCAL_MEDIA_DIR)
 * @param googleSignIn Firebase web config present → the popup helper script (apis.google.com) is allowed
 */
export function buildCsp(localMode: boolean, googleSignIn = false): string {
  const loop = localMode ? ' http://127.0.0.1:* ws://127.0.0.1:*' : '';
  const gsi = googleSignIn ? ' https://apis.google.com' : '';
  return [
    "default-src 'self'",
    `script-src 'self'${gsi}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: https://storage.googleapis.com${loop}`,
    `media-src 'self' blob: https://storage.googleapis.com${loop}`,
    `connect-src 'self' wss: https://storage.googleapis.com https://*.googleapis.com https://*.firebaseapp.com${loop}`,
    // Firebase Auth's auth-domain iframe / Google account chooser (popup sign-in).
    "frame-src 'self' https://*.firebaseapp.com https://accounts.google.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
  ].join('; ');
}

/** Headers applied to every HTTP response. */
export function securityHeaders(config: Pick<RelayConfig, 'localMode' | 'cloudRun'> & { firebaseWeb?: RelayConfig['firebaseWeb'] }): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Security-Policy': buildCsp(config.localMode, Boolean(config.firebaseWeb)),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()',
    // Keeps window.opener for the sign-in popup while isolating everything else.
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  };
  if (config.cloudRun) h['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains';
  return h;
}

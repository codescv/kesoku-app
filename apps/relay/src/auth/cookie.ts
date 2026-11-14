import { SESSION_COOKIE_FALLBACK, SESSION_COOKIE_SECURE } from '@kesoku/protocol';

export const COOKIE_MAX_AGE_S = 31_536_000;

/** Parse a `Cookie:` header into a map (first occurrence wins). */
export function parseCookies(header: string | undefined | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    let value = part.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}

/** Device token from `__Host-kesoku_session` (preferred) or `__Secure-kesoku_session`. */
export function sessionTokenFromCookie(header: string | undefined | null): string | undefined {
  const cookies = parseCookies(header);
  return cookies.get(SESSION_COOKIE_SECURE) || cookies.get(SESSION_COOKIE_FALLBACK) || undefined;
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE_SECURE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`;
}

export function clearSessionCookies(): string[] {
  return [
    `${SESSION_COOKIE_SECURE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
    `${SESSION_COOKIE_FALLBACK}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
  ];
}

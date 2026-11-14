import { getPlatform, isNative } from '../native/platform';
import { secureStore } from '../native/secureStore';
import { db, kvGet, kvSet } from './db';

const TOKEN_KEY = 'kesoku.device_token';

export interface AuthInfo {
  device_id: string;
  kind: 'pair' | 'google';
  email?: string;
}

export class AuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 0,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Relay base URL: same origin on Web; on native, the user-configured URL (non-secret, stored in
 * IndexedDB) or, when unset, the build-time `VITE_RELAY_URL` default.
 */
export async function getRelayBase(): Promise<string> {
  if (!isNative()) return window.location.origin;
  let stored: string | null = null;
  try {
    stored = await kvGet<string | null>('relay_url', null);
  } catch {
    /* storage unavailable: fall back to the build-time default */
  }
  const env = (import.meta.env.VITE_RELAY_URL as string | undefined) ?? '';
  return (stored?.trim() || env.trim() || '').replace(/\/+$/, '');
}

/**
 * Fetch credentials mode. Web relies on the same-origin HttpOnly session cookie. Native shells
 * (capacitor://localhost, https://localhost) keep the device token in the platform secure store,
 * never in cookies, and a cross-origin `include` request is rejected by the WebView unless the
 * server opts in, so native requests omit credentials.
 */
export function fetchCredentials(): RequestCredentials {
  return isNative() ? 'omit' : 'include';
}

export async function setRelayBase(url: string): Promise<void> {
  const u = new URL(url);
  if (u.protocol !== 'https:' && !(u.hostname === '127.0.0.1' || u.hostname === 'localhost')) throw new AuthError('BAD_URL', '中继地址必须是 https');
  await kvSet('relay_url', u.origin);
}

export async function wsUrl(): Promise<string> {
  const base = await getRelayBase();
  return base.replace(/^http/, 'ws') + '/ws';
}

/** Native: token from Keychain / EncryptedSharedPreferences. Web: `null` (HttpOnly cookie carries it). */
export async function getDeviceToken(): Promise<string | null> {
  if (!isNative()) return null;
  return secureStore.get(TOKEN_KEY);
}

export async function getAuthInfo(): Promise<AuthInfo | null> {
  return kvGet<AuthInfo | null>('auth', null);
}

async function postJson(path: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const base = await getRelayBase();
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: fetchCredentials(),
    body: JSON.stringify(body),
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty body */
  }
  return { status: res.status, data };
}

async function persist(device_id: string, token: string | undefined, kind: AuthInfo['kind'], email?: string) {
  if (isNative() && token) await secureStore.set(TOKEN_KEY, token);
  // Web never persists the token itself: only an opaque marker; the secret lives in the HttpOnly cookie.
  await kvSet('auth', { device_id, kind, email } satisfies AuthInfo);
}

/** Redeem a 6-digit pairing code from `kesoku app pair`. */
export async function pair(code: string, name?: string): Promise<AuthInfo> {
  const clean = code.replace(/\D/g, '');
  if (clean.length !== 6) throw new AuthError('BAD_CODE', '请输入 6 位配对码');
  const { status, data } = await postJson('/pair', {
    code: clean,
    device: { platform: getPlatform(), model: navigator.userAgent.slice(0, 64), name: name ?? defaultDeviceName() },
  });
  if (status === 429) throw new AuthError('RATE_LIMITED', '尝试过于频繁，请 10 分钟后再试', status);
  if (status !== 200 || typeof data.device_id !== 'string') throw new AuthError('PAIR_FAILED', '配对码无效或已过期（连续 5 次输错即作废，请在引擎主机重新运行 kesoku app pair）', status);
  await persist(data.device_id, typeof data.device_token === 'string' ? data.device_token : undefined, 'pair');
  return { device_id: data.device_id, kind: 'pair' };
}

export interface AuthConfig {
  firebase: { apiKey: string; authDomain: string; projectId: string } | null;
  google_login: boolean;
}

export async function getAuthConfig(): Promise<AuthConfig> {
  try {
    const base = await getRelayBase();
    const res = await fetch(base + '/auth/config', { credentials: fetchCredentials() });
    if (!res.ok) return { firebase: null, google_login: false };
    return (await res.json()) as AuthConfig;
  } catch {
    return { firebase: null, google_login: false };
  }
}

/** Web one-tap Google login via Firebase Auth popup (SDK lazy-loaded). */
export async function googleLogin(): Promise<AuthInfo> {
  const cfg = await getAuthConfig();
  if (!cfg.firebase) throw new AuthError('NO_GOOGLE', '此中继未启用 Google 登录');
  const [{ initializeApp }, fa] = await Promise.all([import('firebase/app'), import('firebase/auth')]);
  const app = initializeApp(cfg.firebase, 'kesoku');
  const auth = fa.getAuth(app);
  const cred = await fa.signInWithPopup(auth, new fa.GoogleAuthProvider());
  const idToken = await cred.user.getIdToken();
  const { status, data } = await postJson('/auth/google', { id_token: idToken });
  await fa.signOut(auth).catch(() => {});
  if (status === 403) throw new AuthError('FORBIDDEN_EMAIL', '该 Google 账号不在白名单内', status);
  if (status !== 200 || typeof data.device_id !== 'string') throw new AuthError('LOGIN_FAILED', '登录失败', status);
  const email = typeof data.email === 'string' ? data.email : undefined;
  await persist(data.device_id, typeof data.device_token === 'string' ? data.device_token : undefined, 'google', email);
  return { device_id: data.device_id, kind: 'google', email };
}

export async function logout(): Promise<void> {
  try {
    await postJson('/auth/logout', {});
  } catch {
    /* offline: still clear locally */
  }
  if (isNative()) await secureStore.remove(TOKEN_KEY);
  await db.kv.delete('auth');
}

export async function hasCredentials(): Promise<boolean> {
  if (isNative()) return !!(await secureStore.get(TOKEN_KEY));
  return !!(await getAuthInfo());
}

function defaultDeviceName(): string {
  const p = getPlatform();
  if (p === 'ios') return 'iPhone';
  if (p === 'android') return 'Android';
  return 'Web';
}

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
 * Relay base URL: same origin on Web; on native, ONLY the user-configured URL (non-secret, stored in
 * IndexedDB, set via the pairing form or a `kesoku://pair?code=...&relay=...` link). There is
 * deliberately no build-time default, so no build can ever bake a server URL into the bundle.
 */
export async function getRelayBase(): Promise<string> {
  if (!isNative()) return window.location.origin;
  let stored: string | null = null;
  try {
    stored = await kvGet<string | null>('relay_url', null);
  } catch {
    /* storage unavailable: no relay configured */
  }
  return (stored || '').trim().replace(/\/+$/, '');
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

const NO_AUTH_CONFIG: AuthConfig = { firebase: null, google_login: false };

/** In-memory cache of the last successful `/auth/config` fetch, keyed by relay base URL. */
let cachedAuthConfig: AuthConfig | null = null;
let cachedAuthBase = '';

export async function getAuthConfig(): Promise<AuthConfig> {
  try {
    const base = await getRelayBase();
    if (cachedAuthConfig && cachedAuthBase === base) return cachedAuthConfig;
    const res = await fetch(base + '/auth/config', { credentials: fetchCredentials() });
    if (!res.ok) return NO_AUTH_CONFIG;
    const cfg = (await res.json()) as AuthConfig;
    cachedAuthConfig = cfg;
    cachedAuthBase = base;
    return cfg;
  } catch {
    return NO_AUTH_CONFIG;
  }
}

type FirebaseApp = import('firebase/app').FirebaseApp;
type FirebaseAuthModule = typeof import('firebase/auth');

interface WarmFirebase {
  app: FirebaseApp;
  fa: FirebaseAuthModule;
}

const FIREBASE_APP_NAME = 'kesoku';
let firebasePromise: Promise<WarmFirebase> | null = null;
let warmFirebase: WarmFirebase | null = null;

/** Test hook: forget the cached config and warmed SDK handles (the named Firebase app itself persists). */
export function resetAuthCaches(): void {
  cachedAuthConfig = null;
  cachedAuthBase = '';
  firebasePromise = null;
  warmFirebase = null;
}

/** Load the Firebase SDK once and reuse the named app (never `app/duplicate-app` on retry). */
function loadFirebase(firebaseCfg: NonNullable<AuthConfig['firebase']>): Promise<WarmFirebase> {
  firebasePromise ??= (async () => {
    const [appMod, fa] = await Promise.all([import('firebase/app'), import('firebase/auth')]);
    const app = appMod.getApps().find((a) => a.name === FIREBASE_APP_NAME) ?? appMod.initializeApp(firebaseCfg, FIREBASE_APP_NAME);
    const warm = { app, fa };
    warmFirebase = warm;
    return warm;
  })();
  firebasePromise.catch(() => {
    firebasePromise = null;
  });
  return firebasePromise;
}

/**
 * Warm everything the Google popup needs (config + SDK + app instance) before the user clicks, so the
 * click handler can open the popup without awaiting the network (popup blockers require the popup to
 * open synchronously within the user gesture).
 */
export async function preloadGoogleAuth(cfg?: AuthConfig): Promise<void> {
  try {
    const c = cfg ?? (await getAuthConfig());
    if (c.firebase) await loadFirebase(c.firebase);
  } catch {
    /* best effort: googleLogin() retries the load */
  }
}

function firebaseErrorCode(x: unknown): string {
  return x && typeof x === 'object' && typeof (x as { code?: unknown }).code === 'string' ? (x as { code: string }).code : '';
}

/** Web Google login via Firebase Auth popup (SDK lazy-loaded, ideally pre-warmed by `preloadGoogleAuth`). */
export async function googleLogin(preloadedCfg?: AuthConfig): Promise<AuthInfo> {
  const cfg = preloadedCfg ?? cachedAuthConfig ?? (await getAuthConfig());
  if (!cfg.firebase) throw new AuthError('NO_GOOGLE', '此中继未启用 Google 登录');
  const { app, fa } = warmFirebase ?? (await loadFirebase(cfg.firebase));
  const auth = fa.getAuth(app);
  const provider = new fa.GoogleAuthProvider();
  // Always show the account chooser so a different (allowlisted) account can be picked on retry.
  provider.setCustomParameters({ prompt: 'select_account' });
  let idToken: string;
  try {
    const cred = await fa.signInWithPopup(auth, provider);
    idToken = await cred.user.getIdToken();
  } catch (x) {
    const code = firebaseErrorCode(x);
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') throw new AuthError('CANCELLED', '已取消登录');
    if (code === 'auth/popup-blocked') throw new AuthError('POPUP_BLOCKED', '浏览器拦截了登录弹窗，请允许此站点的弹窗后重试');
    throw new AuthError('LOGIN_FAILED', '登录失败，请重试');
  }
  const { status, data } = await postJson('/auth/google', { id_token: idToken });
  await fa.signOut(auth).catch(() => {});
  if (status === 403) {
    await db.kv.delete('auth').catch(() => {});
    throw new AuthError(
      'FORBIDDEN_EMAIL',
      typeof data.email === 'string' ? `账号 ${data.email} 不在访问白名单内，请切换受权账号重试` : '该 Google 账号不在访问白名单内，请切换受权账号重试',
      403,
    );
  }
  if (status === 429) throw new AuthError('RATE_LIMITED', '尝试过于频繁，请稍后再试', status);
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  platform: { value: 'web' as 'web' | 'android' | 'ios' },
  apps: [] as { name: string; options: unknown }[],
  initializeApp: vi.fn(),
  signInWithPopup: vi.fn(),
  setCustomParameters: vi.fn(),
  signOut: vi.fn(async () => undefined),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => h.platform.value,
    isNativePlatform: () => h.platform.value !== 'web',
  },
  registerPlugin: () => ({}),
}));

vi.mock('../../src/native/secureStore', () => ({
  secureStore: { get: async () => null, set: async () => undefined, remove: async () => undefined },
}));

// Mirrors the real SDK: a second initializeApp() with the same name throws `app/duplicate-app`.
vi.mock('firebase/app', () => ({
  getApps: () => [...h.apps],
  initializeApp: (options: unknown, name: string) => {
    h.initializeApp(options, name);
    if (h.apps.some((a) => a.name === name)) throw Object.assign(new Error('duplicate'), { code: 'app/duplicate-app' });
    const app = { name, options };
    h.apps.push(app);
    return app;
  },
}));

vi.mock('firebase/auth', () => ({
  getAuth: (app: unknown) => ({ app }),
  GoogleAuthProvider: class {
    setCustomParameters(p: Record<string, string>) {
      h.setCustomParameters(p);
    }
  },
  signInWithPopup: (...args: unknown[]) => h.signInWithPopup(...args),
  signOut: () => h.signOut(),
}));

import { AuthScreen } from '../../src/features/auth/AuthScreen';
import { googleLogin, preloadGoogleAuth, resetAuthCaches, type AuthConfig } from '../../src/lib/auth';
import { db } from '../../src/lib/db';

const FIREBASE = { apiKey: 'public-web-key', authDomain: 'demo.firebaseapp.com', projectId: 'demo' };
const GOOGLE_CFG: AuthConfig = { firebase: FIREBASE, google_login: true };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let authConfig: AuthConfig = GOOGLE_CFG;
let googleResponse: () => Response = () => jsonResponse({ device_id: 'dev_abc', device_token: 'kdt1.x.y', email: 'owner@example.com' });
let fetchMock: ReturnType<typeof vi.fn>;

const popupOk = () => ({ user: { getIdToken: async () => 'id-token' } });
const firebaseError = (code: string) => Object.assign(new Error(code), { code });

beforeEach(async () => {
  h.platform.value = 'web';
  h.apps.length = 0;
  h.initializeApp.mockClear();
  h.signInWithPopup.mockReset();
  h.setCustomParameters.mockClear();
  resetAuthCaches();
  await db.kv.clear();
  authConfig = GOOGLE_CFG;
  googleResponse = () => jsonResponse({ device_id: 'dev_abc', device_token: 'kdt1.x.y', email: 'owner@example.com' });
  fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/auth/config')) return jsonResponse(authConfig);
    if (url.endsWith('/auth/google')) return googleResponse();
    return jsonResponse({ device_id: 'dev_pair', device_token: 'kdt1.p.q' });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AuthScreen on Web with Google Sign-In', () => {
  it('renders only the Google login (no pairing form) and preloads the SDK', async () => {
    render(<AuthScreen onDone={() => {}} />);
    const btn = await screen.findByRole('button', { name: '使用 Google 账号登录' });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('仅限白名单受权 Google 账号访问')).toBeTruthy();
    expect(screen.queryByText('6 位配对码')).toBeNull();
    expect(screen.queryByText('或使用配对码')).toBeNull();
    expect(screen.queryByRole('button', { name: /配对并连接/ })).toBeNull();
    await waitFor(() => expect(h.initializeApp).toHaveBeenCalledTimes(1));
    expect(h.initializeApp).toHaveBeenCalledWith(FIREBASE, 'kesoku');
  });

  it('never flashes the pairing form while /auth/config is loading', async () => {
    let release!: () => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(jsonResponse(GOOGLE_CFG));
        }),
    );
    render(<AuthScreen onDone={() => {}} />);
    expect(screen.queryByText('6 位配对码')).toBeNull();
    await waitFor(() => expect(release).toBeTypeOf('function'));
    await act(async () => release());
    expect(await screen.findByRole('button', { name: '使用 Google 账号登录' })).toBeTruthy();
    expect(screen.queryByText('6 位配对码')).toBeNull();
  });

  it('retries reuse the kesoku app (no app/duplicate-app), show cancel + 403 messages, then succeed', async () => {
    const onDone = vi.fn();
    h.signInWithPopup
      .mockRejectedValueOnce(firebaseError('auth/popup-closed-by-user'))
      .mockRejectedValueOnce(firebaseError('auth/popup-blocked'))
      .mockResolvedValue(popupOk());
    render(<AuthScreen onDone={onDone} />);
    const btn = await screen.findByRole('button', { name: '使用 Google 账号登录' });

    fireEvent.click(btn);
    expect((await screen.findByRole('alert')).textContent).toContain('已取消登录');

    fireEvent.click(screen.getByRole('button', { name: '使用 Google 账号登录' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('浏览器拦截了登录弹窗，请允许此站点的弹窗后重试'));

    googleResponse = () => jsonResponse({ error: 'FORBIDDEN_EMAIL', email: 'stranger@example.com' }, 403);
    fireEvent.click(screen.getByRole('button', { name: '使用 Google 账号登录' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('账号 stranger@example.com 不在访问白名单内，请切换受权账号重试'));
    expect(onDone).not.toHaveBeenCalled();

    googleResponse = () => jsonResponse({ device_id: 'dev_abc', device_token: 'kdt1.x.y', email: 'owner@example.com' });
    fireEvent.click(screen.getByRole('button', { name: '使用 Google 账号登录' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));

    expect(h.initializeApp).toHaveBeenCalledTimes(1);
    expect(h.apps).toHaveLength(1);
    expect(h.signInWithPopup).toHaveBeenCalledTimes(4);
    expect(h.setCustomParameters).toHaveBeenCalledWith({ prompt: 'select_account' });
    // /auth/config fetched once (cached), never re-fetched on click.
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/auth/config'))).toHaveLength(1);
    expect(await db.kv.get('auth')).toMatchObject({ value: { device_id: 'dev_abc', kind: 'google', email: 'owner@example.com' } });
  });

  it('403 without an email shows the generic allowlist message', async () => {
    h.signInWithPopup.mockResolvedValue(popupOk());
    googleResponse = () => jsonResponse({ error: 'FORBIDDEN_EMAIL' }, 403);
    render(<AuthScreen onDone={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '使用 Google 账号登录' }));
    expect((await screen.findByRole('alert')).textContent).toContain('该 Google 账号不在访问白名单内，请切换受权账号重试');
  });

  it('shows the pairing form on Web only when Google Sign-In is off (local mode)', async () => {
    authConfig = { firebase: null, google_login: false };
    render(<AuthScreen onDone={() => {}} />);
    expect(await screen.findByText('6 位配对码')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '使用 Google 账号登录' })).toBeNull();
  });

  it('native always shows the pairing form even if the relay has Google Sign-In', async () => {
    h.platform.value = 'ios';
    render(<AuthScreen onDone={() => {}} />);
    expect(screen.getByText('6 位配对码')).toBeTruthy();
    expect(screen.getByText('中继地址')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '使用 Google 账号登录' })).toBeNull();
  });
});

describe('googleLogin / preloadGoogleAuth', () => {
  it('reuses an existing kesoku app even after caches reset', async () => {
    h.signInWithPopup.mockResolvedValue(popupOk());
    await preloadGoogleAuth(GOOGLE_CFG);
    resetAuthCaches();
    await expect(googleLogin(GOOGLE_CFG)).resolves.toMatchObject({ kind: 'google', email: 'owner@example.com' });
    await expect(googleLogin()).resolves.toMatchObject({ kind: 'google' });
    expect(h.initializeApp).toHaveBeenCalledTimes(1);
  });

  it('maps cancelled-popup-request to CANCELLED', async () => {
    h.signInWithPopup.mockRejectedValue(firebaseError('auth/cancelled-popup-request'));
    await expect(googleLogin(GOOGLE_CFG)).rejects.toMatchObject({ code: 'CANCELLED', message: '已取消登录' });
  });

  it('403 clears a stale local auth marker', async () => {
    await db.kv.put({ key: 'auth', value: { device_id: 'dev_old', kind: 'pair' } });
    h.signInWithPopup.mockResolvedValue(popupOk());
    googleResponse = () => jsonResponse({ error: 'FORBIDDEN_EMAIL', email: 'stranger@example.com' }, 403);
    await expect(googleLogin(GOOGLE_CFG)).rejects.toMatchObject({ code: 'FORBIDDEN_EMAIL', status: 403 });
    expect(await db.kv.get('auth')).toBeUndefined();
  });
});

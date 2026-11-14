import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  platform: { value: 'ios' as 'web' | 'android' | 'ios' },
  store: new Map<string, string>(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => h.platform.value,
    isNativePlatform: () => h.platform.value !== 'web',
  },
  registerPlugin: () => ({}),
}));

vi.mock('../../src/native/secureStore', () => ({
  secureStore: {
    get: async (k: string) => h.store.get(k) ?? null,
    set: async (k: string, v: string) => void h.store.set(k, v),
    remove: async (k: string) => void h.store.delete(k),
  },
}));

import { fetchCredentials, getAuthConfig, getRelayBase, pair, setRelayBase } from '../../src/lib/auth';
import { db } from '../../src/lib/db';

const RELAY = 'https://relay.example.com';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  h.platform.value = 'ios';
  h.store.clear();
  await db.kv.clear();
  vi.stubEnv('VITE_RELAY_URL', RELAY + '/');
  fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/auth/config')) return jsonResponse({ firebase: null, google_login: false });
    return jsonResponse({ device_id: 'dev-1', device_token: 'tok-1' });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('native auth fetch', () => {
  it('falls back to VITE_RELAY_URL when no relay URL is stored', async () => {
    expect(await getRelayBase()).toBe(RELAY);
  });

  it('prefers the stored relay URL over the build-time default', async () => {
    await setRelayBase('https://other.example.org/some/path');
    expect(await getRelayBase()).toBe('https://other.example.org');
  });

  it('omits credentials on native for POST /pair and uses VITE_RELAY_URL', async () => {
    expect(fetchCredentials()).toBe('omit');
    await pair('123456');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${RELAY}/pair`);
    expect(init.credentials).toBe('omit');
    expect(init.method).toBe('POST');
    expect(h.store.get('kesoku.device_token')).toBe('tok-1');
  });

  it('omits credentials on native for GET /auth/config', async () => {
    h.platform.value = 'android';
    await getAuthConfig();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${RELAY}/auth/config`);
    expect(init.credentials).toBe('omit');
  });

  it('keeps cookie credentials on Web (same origin)', async () => {
    h.platform.value = 'web';
    expect(fetchCredentials()).toBe('include');
    await getAuthConfig();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${window.location.origin}/auth/config`);
    expect(init.credentials).toBe('include');
  });
});

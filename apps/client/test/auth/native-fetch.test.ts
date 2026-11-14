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

describe('native relay base (no build-time default)', () => {
  it('is empty on native until the user configures a relay', async () => {
    expect(await getRelayBase()).toBe('');
  });

  it('ignores any VITE_RELAY_URL in the environment', async () => {
    vi.stubEnv('VITE_RELAY_URL', 'https://baked.example.net');
    expect(await getRelayBase()).toBe('');
  });

  it('setRelayBase stores the bare origin, getRelayBase returns it', async () => {
    await setRelayBase('https://other.example.org/some/path/');
    expect(await getRelayBase()).toBe('https://other.example.org');
  });

  it('setRelayBase rejects non-https relays except localhost', async () => {
    await expect(setRelayBase('http://relay.example.com')).rejects.toMatchObject({ code: 'BAD_URL' });
    await setRelayBase('http://127.0.0.1:8787/x');
    expect(await getRelayBase()).toBe('http://127.0.0.1:8787');
  });
});

describe('native auth fetch', () => {
  beforeEach(async () => {
    await setRelayBase(RELAY + '/');
  });

  it('omits credentials on native for POST /pair and uses the stored relay', async () => {
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

  it('keeps cookie credentials on Web (same origin, stored relay ignored)', async () => {
    h.platform.value = 'web';
    expect(fetchCredentials()).toBe('include');
    expect(await getRelayBase()).toBe(window.location.origin);
    await getAuthConfig();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${window.location.origin}/auth/config`);
    expect(init.credentials).toBe('include');
  });
});

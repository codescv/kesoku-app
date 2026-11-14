import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

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

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: () => Promise.resolve({ remove: () => Promise.resolve() }),
    getLaunchUrl: () => Promise.resolve(undefined),
  },
}));

vi.mock('../../src/native/secureStore', () => ({
  secureStore: {
    get: async (k: string) => h.store.get(k) ?? null,
    set: async (k: string, v: string) => void h.store.set(k, v),
    remove: async (k: string) => void h.store.delete(k),
  },
}));

import { AuthScreen } from '../../src/features/auth/AuthScreen';
import { getRelayBase, resetAuthCaches } from '../../src/lib/auth';
import { db } from '../../src/lib/db';

const RELAY = 'https://relay.example.com';
const LINK = `kesoku://pair?code=483920&relay=${encodeURIComponent(RELAY)}`;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  h.platform.value = 'ios';
  h.store.clear();
  resetAuthCaches();
  await db.kv.clear();
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ device_id: 'dev-1', device_token: 'tok-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const relayInput = () => screen.getByPlaceholderText('https://relay.example.com') as HTMLInputElement;
const codeInput = () => screen.getByPlaceholderText('483 920') as HTMLInputElement;

describe('AuthScreen pairing link (native)', () => {
  it('uses a neutral relay placeholder and starts empty (no baked default)', async () => {
    render(<AuthScreen onDone={() => {}} />);
    await waitFor(() => expect(relayInput()).toBeTruthy());
    expect(relayInput().value).toBe('');
    expect(document.body.innerHTML).not.toMatch(/run\.app/);
  });

  it('prefills relay + code from a scanned kesoku://pair link (initialRelay / initialCode)', async () => {
    render(<AuthScreen onDone={() => {}} initialCode="483920" initialRelay={RELAY} />);
    expect(relayInput().value).toBe(RELAY);
    expect(codeInput().value).toBe('483920');
  });

  it('pasting the link into 中继地址 fills both fields', async () => {
    render(<AuthScreen onDone={() => {}} />);
    fireEvent.change(relayInput(), { target: { value: LINK } });
    expect(relayInput().value).toBe(RELAY);
    expect(codeInput().value).toBe('483920');
  });

  it('pasting the link into 6 位配对码 fills both fields, then pairing hits the pasted relay', async () => {
    const onDone = vi.fn();
    render(<AuthScreen onDone={onDone} />);
    fireEvent.change(codeInput(), { target: { value: LINK } });
    expect(relayInput().value).toBe(RELAY);
    expect(codeInput().value).toBe('483920');
    fireEvent.click(screen.getByRole('button', { name: '配对并连接' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`${RELAY}/pair`);
    expect(await getRelayBase()).toBe(RELAY);
  });

  it('a link with an invalid relay still fills the code and keeps the typed relay', async () => {
    render(<AuthScreen onDone={() => {}} />);
    fireEvent.change(relayInput(), { target: { value: 'https://mine.example.org' } });
    fireEvent.change(codeInput(), { target: { value: 'kesoku://pair?code=111222&relay=http%3A%2F%2Fevil.example' } });
    expect(codeInput().value).toBe('111222');
    expect(relayInput().value).toBe('https://mine.example.org');
  });

  it('plain typing still works and the code is limited to digits', async () => {
    render(<AuthScreen onDone={() => {}} />);
    fireEvent.change(codeInput(), { target: { value: '48a3 920999' } });
    expect(codeInput().value).toBe('483 920');
    fireEvent.change(relayInput(), { target: { value: 'https://typed.example.org' } });
    expect(relayInput().value).toBe('https://typed.example.org');
  });

  it('tapping 扫码配对 invokes native Camera.scanQRCode when available and auto-submits pairing', async () => {
    const onDone = vi.fn();
    (globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
      nativePromise: vi.fn(async (plugin: string, method: string) => {
        if (plugin === 'Camera' && method === 'scanQRCode') {
          return { value: LINK };
        }
        throw new Error('UNIMPLEMENTED');
      }),
    };
    try {
      render(<AuthScreen onDone={onDone} />);
      fireEvent.click(screen.getByRole('button', { name: /扫码配对/ }));
      await waitFor(() => expect(onDone).toHaveBeenCalled());
      expect(relayInput().value).toBe(RELAY);
      expect(codeInput().value).toBe('483920');
      expect(await getRelayBase()).toBe(RELAY);
    } finally {
      delete (globalThis as unknown as { Capacitor?: unknown }).Capacitor;
    }
  });

  it('tapping 扫码配对 opens QrScannerModal when native scanQRCode is unavailable', async () => {
    render(<AuthScreen onDone={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /扫码配对/ }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: '扫描配对二维码' })).toBeTruthy());
    expect(screen.getByRole('button', { name: /从相册 \/ 拍照识别二维码/ })).toBeTruthy();
  });
});

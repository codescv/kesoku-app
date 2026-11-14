import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const listeners: Array<(e: { url: string }) => void> = [];
  return {
    platform: { value: 'web' as 'web' | 'android' | 'ios' },
    listeners,
    launchUrl: { value: undefined as string | undefined },
    removed: { count: 0 },
  };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => h.platform.value,
    isNativePlatform: () => h.platform.value !== 'web',
  },
  registerPlugin: () => ({}),
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: (_event: string, cb: (e: { url: string }) => void) => {
      h.listeners.push(cb);
      return Promise.resolve({
        remove: () => {
          h.removed.count += 1;
          const i = h.listeners.indexOf(cb);
          if (i >= 0) h.listeners.splice(i, 1);
          return Promise.resolve();
        },
      });
    },
    getLaunchUrl: () => Promise.resolve(h.launchUrl.value ? { url: h.launchUrl.value } : undefined),
  },
}));

import { onDeepLink, parseDeepLink, resetDeepLinkStateForTests, type DeepLink } from '../../src/native/deeplinks';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('parseDeepLink', () => {
  it.each([
    ['kesoku://mode/translator', 'translator'],
    ['kesoku://mode/travel', 'travel_companion'],
    ['kesoku://mode/pokemon', 'pokemon_assistant'],
    ['KESOKU://mode/Travel/', 'travel_companion'],
    ['kesoku://mode/travel_companion', 'travel_companion'],
    ['kesoku:/mode/pokemon', 'pokemon_assistant'],
    ['/mode/translator', 'translator'],
    ['/mode/travel?from=shortcut', 'travel_companion'],
    ['https://kesoku.example/mode/pokemon', 'pokemon_assistant'],
    ['https://localhost/mode/travel', 'travel_companion'],
    ['capacitor://localhost/mode/translator', 'translator'],
  ])('%s -> mode %s', (url, mode_id) => {
    expect(parseDeepLink(url)).toEqual({ kind: 'mode', mode_id });
  });

  it.each([
    ['kesoku://pair?code=483920', '483920'],
    ['kesoku://pair?code=483%20920', '483920'],
    ['kesoku://pair?code=483-920', '483920'],
    ['/pair?code=000123', '000123'],
  ])('%s -> pair %s', (url, code) => {
    expect(parseDeepLink(url)).toEqual({ kind: 'pair', code });
  });

  it.each([
    ['kesoku://pair?code=483920&relay=https://relay.example.com', 'https://relay.example.com'],
    ['kesoku://pair?code=483920&relay=https%3A%2F%2Frelay.example.com', 'https://relay.example.com'],
    ['kesoku://pair/?code=483920&relay=https%3A%2F%2Fr.example%2Fsome%2Fpath%2F', 'https://r.example'],
    ['kesoku://pair?relay=https%3A%2F%2Frelay.example.com%3A8443%2F&code=483%20920', 'https://relay.example.com:8443'],
    ['kesoku://pair?code=483920&relay=http%3A%2F%2F127.0.0.1%3A8787', 'http://127.0.0.1:8787'],
    ['kesoku://pair?code=483920&relay=http%3A%2F%2Flocalhost%3A8787%2F', 'http://localhost:8787'],
  ])('%s -> pair with relay %s', (url, relay) => {
    expect(parseDeepLink(url)).toEqual({ kind: 'pair', code: '483920', relay });
  });

  it.each([
    'kesoku://pair?code=483920&relay=http%3A%2F%2Frelay.example.com',
    'kesoku://pair?code=483920&relay=javascript%3Aalert(1)',
    'kesoku://pair?code=483920&relay=not%20a%20url',
    'kesoku://pair?code=483920&relay=ftp%3A%2F%2Frelay.example.com',
    'kesoku://pair?code=483920&relay=https%3A%2F%2Fuser%3Apw%40relay.example.com',
    'kesoku://pair?code=483920&relay=',
  ])('%s -> pair code kept, invalid relay dropped', (url) => {
    const link = parseDeepLink(url);
    expect(link).toEqual({ kind: 'pair', code: '483920' });
    expect(link && 'relay' in link).toBe(false);
  });

  it('a relay never rescues an invalid code', () => {
    expect(parseDeepLink('kesoku://pair?code=12345&relay=https%3A%2F%2Frelay.example.com')).toBeNull();
  });

  it.each([
    '',
    'kesoku://',
    'kesoku://mode',
    'kesoku://mode/galgame',
    'kesoku://mode/__proto__',
    'kesoku://mode/constructor',
    'kesoku://mode/translator/extra',
    'kesoku://pair',
    'kesoku://pair?code=12345',
    'kesoku://pair?code=1234567',
    'kesoku://pair?code=abcdef',
    'kesoku://settings',
    'otherapp://mode/translator',
    'javascript:alert(1)//mode/translator',
    'https://kesoku.example/',
    'https://kesoku.example/modes/translator',
    '/mode/%E0%A4%A',
    'not a url',
    `kesoku://mode/${'a'.repeat(3000)}`,
  ])('rejects %s', (url) => {
    expect(parseDeepLink(url)).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(parseDeepLink(undefined as unknown as string)).toBeNull();
  });
});

describe('onDeepLink (web)', () => {
  beforeEach(() => {
    h.platform.value = 'web';
    resetDeepLinkStateForTests();
  });
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('delivers the launch location once', async () => {
    window.history.replaceState(null, '', '/mode/travel');
    const a: DeepLink[] = [];
    const offA = onDeepLink((l) => a.push(l));
    await flush();
    expect(a).toEqual([{ kind: 'mode', mode_id: 'travel_companion' }]);

    const b: DeepLink[] = [];
    const offB = onDeepLink((l) => b.push(l));
    await flush();
    expect(b).toEqual([]);
    offA();
    offB();
  });

  it('survives an immediate unsubscribe (StrictMode double effect)', async () => {
    window.history.replaceState(null, '', '/pair?code=483920');
    const first: DeepLink[] = [];
    const off1 = onDeepLink((l) => first.push(l));
    off1();
    const second: DeepLink[] = [];
    const off2 = onDeepLink((l) => second.push(l));
    await flush();
    expect(first).toEqual([]);
    expect(second).toEqual([{ kind: 'pair', code: '483920' }]);
    off2();
  });

  it('ignores ordinary paths', async () => {
    window.history.replaceState(null, '', '/settings');
    const got: DeepLink[] = [];
    const off = onDeepLink((l) => got.push(l));
    await flush();
    expect(got).toEqual([]);
    off();
  });
});

describe('onDeepLink (native)', () => {
  beforeEach(() => {
    h.platform.value = 'android';
    h.listeners.length = 0;
    h.removed.count = 0;
    h.launchUrl.value = undefined;
    resetDeepLinkStateForTests();
  });

  it('delivers the cold-start URL and appUrlOpen events, then unsubscribes', async () => {
    h.launchUrl.value = 'kesoku://mode/pokemon';
    const got: DeepLink[] = [];
    const off = onDeepLink((l) => got.push(l));
    await flush();
    expect(got).toEqual([{ kind: 'mode', mode_id: 'pokemon_assistant' }]);

    h.listeners.forEach((cb) => cb({ url: 'kesoku://mode/translator' }));
    h.listeners.forEach((cb) => cb({ url: 'kesoku://unknown' }));
    h.listeners.forEach((cb) => cb({ url: 'kesoku://pair?code=111222' }));
    expect(got.slice(1)).toEqual([
      { kind: 'mode', mode_id: 'translator' },
      { kind: 'pair', code: '111222' },
    ]);

    off();
    expect(h.removed.count).toBe(1);
    expect(h.listeners).toHaveLength(0);
  });

  it('removes a listener that resolves after unsubscribe', async () => {
    const off = onDeepLink(() => undefined);
    off();
    await flush();
    expect(h.removed.count).toBe(1);
    expect(h.listeners).toHaveLength(0);
  });
});

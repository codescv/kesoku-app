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
    ['kesoku://pair/?code=483920&relay=https%3A%2F%2Fr.example', '483920'],
    ['kesoku://pair?code=483%20920', '483920'],
    ['kesoku://pair?code=483-920', '483920'],
    ['/pair?code=000123', '000123'],
  ])('%s -> pair %s', (url, code) => {
    expect(parseDeepLink(url)).toEqual({ kind: 'pair', code });
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

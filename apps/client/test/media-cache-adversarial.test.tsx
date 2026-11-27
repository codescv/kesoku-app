import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { kesoku } from '../src/lib/client';
import {
  __mediaCacheTest,
  buildMediaAliases,
  clearMediaCache,
  fetchAndCacheImage,
  getCachedImageUrl,
  getMediaCacheStats,
  peekCachedImageUrl,
  putCachedImage,
} from '../src/lib/mediaCache';
import { __avatarCache, useAvatarUrl } from '../src/features/persona/avatar';
import { initialState, useStore } from '../src/lib/store';

function makeBlob(size: number, type = 'image/png'): Blob {
  return new Blob([new Uint8Array(size).fill(66)], { type });
}

function imageResponse(size = 256, type = 'image/png') {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': type }),
    blob: async () => makeBlob(size, type),
  };
}

let blobSeq = 0;
let revoked: string[] = [];

beforeEach(async () => {
  blobSeq = 0;
  revoked = [];
  useStore.setState(initialState(), true);
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:adv/${++blobSeq}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => {
    revoked.push(u);
  });
  __avatarCache.reset();
  await __mediaCacheTest.resetAll();
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  __avatarCache.reset();
  await __mediaCacheTest.resetAll();
});

describe('mediaCache adversarial: clear / logout races', () => {
  it('an in-flight download that completes AFTER clearMediaCache() must not resurrect the entry', async () => {
    let release!: (v: unknown) => void;
    const gate = new Promise((r) => {
      release = r;
    });
    const fetchMock = vi.fn(async () => {
      await gate;
      return imageResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    const aliases = ['obj:media/s1/race.png', 'ref:s1:race.png'];
    const pending = fetchAndCacheImage('https://cdn.invalid/race.png?sig=1', aliases);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // User taps "Clear image cache" / logs out while the GCS download is still running.
    await clearMediaCache();
    release(undefined);
    const result = await pending;

    // After clear the late result must not be persisted nor linked in memory (previous user's images on logout!).
    expect((await getMediaCacheStats()).count).toBe(0);
    expect(peekCachedImageUrl(aliases)).toBeNull();
    expect(result).toBe('https://cdn.invalid/race.png?sig=1');
  });

  it('a putCachedImage() that started before clearMediaCache() must not survive the clear', async () => {
    const put = putCachedImage(['obj:media/s1/seed.png'], makeBlob(128), 'image/png');
    await clearMediaCache();
    await put;
    expect((await getMediaCacheStats()).count).toBe(0);
    expect(peekCachedImageUrl(['obj:media/s1/seed.png'])).toBeNull();
  });
});

describe('mediaCache adversarial: LRU bounds', () => {
  it('concurrent puts never exceed the configured byte cap', async () => {
    __mediaCacheTest.setLimitBytes(3000);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => putCachedImage([`obj:media/s1/c${i}.png`], makeBlob(1000), 'image/png')),
    );
    const stats = await getMediaCacheStats();
    expect(stats.bytes).toBeLessThanOrEqual(3000);
    expect(stats.count).toBeLessThanOrEqual(3);
  });

  it('a single image larger than the cap is rejected without evicting everything else', async () => {
    __mediaCacheTest.setLimitBytes(2000);
    const keep = await putCachedImage(['obj:media/s1/keep.png'], makeBlob(1500), 'image/png');
    expect(keep).toMatch(/^blob:adv\//);
    expect(await putCachedImage(['obj:media/s1/big.png'], makeBlob(2001), 'image/png')).toBeNull();
    expect(await getCachedImageUrl(['obj:media/s1/keep.png'])).toBe(keep);
    expect(revoked).not.toContain(keep);
  });

  it('never caches SVG (script-capable) or octet-stream payloads served for audio paths', async () => {
    expect(await putCachedImage(['obj:media/s1/x.svg'], makeBlob(64, 'image/svg+xml'), 'image/svg+xml')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => imageResponse(64, 'application/octet-stream')));
    const u = 'https://cdn.invalid/v.m4a?sig=1';
    expect(await fetchAndCacheImage(u, ['obj:media/s1/v.m4a'])).toBe(u);
    expect((await getMediaCacheStats()).count).toBe(0);
  });
});

describe('mediaCache adversarial: alias lifecycle for user-sent images', () => {
  it('Composer seed obj: -> message.user {object, ref} -> restart history {object, ref} and ref-only all hit one blob', async () => {
    const object = 'media/s1/u1.jpg';
    const seeded = await putCachedImage([`obj:${object}`], makeBlob(700, 'image/jpeg'), 'image/jpeg');
    expect(seeded).toMatch(/^blob:adv\//);

    // message.user echo arrives with ref -> UserImageThumb peeks with both aliases (links ref alias).
    const both = buildMediaAliases({ object, ref: 'uploads/u1.jpg', sessionId: 's1' });
    expect(peekCachedImageUrl(both)).toBe(seeded);
    await new Promise((r) => setTimeout(r, 20)); // let fire-and-forget alias bulkPut land

    // Simulated restart: memory wiped, IDB stays.
    __mediaCacheTest.resetMemory();
    const fetchMock = vi.fn(async () => imageResponse());
    vi.stubGlobal('fetch', fetchMock);
    const afterRestart = await getCachedImageUrl(both);
    expect(afterRestart).toMatch(/^blob:adv\//);
    __mediaCacheTest.resetMemory();
    expect(await getCachedImageUrl(buildMediaAliases({ ref: 'uploads/u1.jpg', sessionId: 's1' }))).toMatch(/^blob:adv\//);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await getMediaCacheStats()).count).toBe(1);
  });
});

describe('resolveMedia adversarial: revoked blob: URLs left in the store', () => {
  it('after LRU eviction revokes a blob: URL, resolveMedia must not hand back that revoked URL from the media store', async () => {
    __mediaCacheTest.setLimitBytes(1000);
    vi.spyOn(kesoku, 'rpc').mockImplementation(async (_m: string, p?: unknown) => {
      const obj = (p as { object?: string })?.object ?? 'x';
      return { url: `https://signed.invalid/${obj}?X-Goog-Signature=a`, expires_at: Math.floor(Date.now() / 1000) + 900 } as never;
    });
    vi.stubGlobal('fetch', vi.fn(async () => imageResponse(800, 'image/webp')));

    const first = await kesoku.resolveMedia({ object: 'media/s1/a.webp' }, { sessionId: 's1' });
    expect(first).toMatch(/^blob:adv\//);
    // Second image evicts the first under a 1000-byte cap (revokes `first`).
    await kesoku.resolveMedia({ object: 'media/s1/b.webp' }, { sessionId: 's1' });
    expect(revoked).toContain(first);

    const again = await kesoku.resolveMedia({ object: 'media/s1/a.webp' }, { sessionId: 's1' });
    expect(again).not.toBe(first);
  });
});

describe('useAvatarUrl after clearMediaCache()', () => {
  it('a mounted avatar does not keep returning a revoked blob: URL after the cache is cleared', async () => {
    const resolveSpy = vi
      .spyOn(kesoku, 'resolveMedia')
      .mockResolvedValueOnce('blob:adv/avatar-old')
      .mockResolvedValue('blob:adv/avatar-new');
    const { result } = renderHook(() => useAvatarUrl('roles/asuka/avatar.webp', 2));
    await waitFor(() => expect(result.current).toBe('blob:adv/avatar-old'));

    // Simulate the cache owning that URL: clearMediaCache revokes every blob it minted.
    await act(async () => {
      await clearMediaCache();
    });
    // Mounted consumers (desktop SessionPanel / launchpad avatars stay mounted while Settings is open)
    // must not keep handing a revoked URL to new <img> elements.
    await waitFor(() => expect(result.current).not.toBe('blob:adv/avatar-old'));
    expect(resolveSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

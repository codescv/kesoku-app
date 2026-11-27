import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, purgeSessionFromDb } from '../src/lib/db';
import {
  MAX_SINGLE_IMAGE_BYTES,
  __mediaCacheTest,
  buildMediaAliases,
  clearMediaCache,
  fetchAndCacheImage,
  getCachedImageUrl,
  getMediaCacheStats,
  invalidateCachedImage,
  isImageMedia,
  onMediaCacheClear,
  peekCachedImageUrl,
  pruneOldAvatarRevs,
  purgeSessionMediaCache,
  putCachedImage,
} from '../src/lib/mediaCache';

function makeBlob(size: number, type = 'image/png', fill = 65): Blob {
  const buf = new Uint8Array(size);
  buf.fill(fill);
  return new Blob([buf], { type });
}

let blobSeq = 0;
let revokedUrls: string[] = [];

beforeEach(async () => {
  blobSeq = 0;
  revokedUrls = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test/${++blobSeq}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => {
    revokedUrls.push(u);
  });
  await __mediaCacheTest.resetAll();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await __mediaCacheTest.resetAll();
});

describe('mediaCache', () => {
  it('builds stable logical aliases for avatars, global refs, session refs, and objects', () => {
    expect(buildMediaAliases({ ref: 'roles/asuka/avatar.webp', avatarRev: 3 })).toEqual(['avatar:roles/asuka/avatar.webp@3']);
    expect(buildMediaAliases({ ref: 'pkmn/0987.webp', sessionId: 's1' })).toEqual(['ref:pkmn/0987.webp']);
    expect(buildMediaAliases({ ref: 'characters/hero/p.png', sessionId: 's1' })).toEqual(['ref:characters/hero/p.png']);
    expect(buildMediaAliases({ ref: 'games/g1/cg.jpg', sessionId: 's1' })).toEqual(['ref:games/g1/cg.jpg']);
    expect(buildMediaAliases({ ref: 'photos/1.jpg', sessionId: 's1', object: 'media/s1/abc.jpg' })).toEqual([
      'ref:s1:photos/1.jpg',
      'obj:media/s1/abc.jpg',
    ]);
  });

  it('persists blobs in IndexedDB across simulated app restarts (in-memory reset)', async () => {
    const url1 = await putCachedImage(['obj:media/s1/a.png'], makeBlob(1024), 'image/png');
    expect(url1).toBe('blob:test/1');
    expect(peekCachedImageUrl(['obj:media/s1/a.png'])).toBe('blob:test/1');

    // Simulate page reload / app restart: memory maps are wiped, IDB remains intact.
    __mediaCacheTest.resetMemory();
    expect(peekCachedImageUrl(['obj:media/s1/a.png'])).toBeNull();

    const url2 = await getCachedImageUrl(['obj:media/s1/a.png']);
    expect(url2).toBe('blob:test/2');
    // Subsequent lookup hits in-memory blob map (same URL, no duplicate ObjectURL minted).
    expect(await getCachedImageUrl(['obj:media/s1/a.png'])).toBe('blob:test/2');
  });

  it('deduplicates storage across multiple aliases (live object+ref hit by history ref-only)', async () => {
    const aliases = buildMediaAliases({ object: 'media/s1/pic.webp', ref: 'gen/pic.webp', sessionId: 's1' });
    const url = await putCachedImage(aliases, makeBlob(2048, 'image/webp'), 'image/webp');
    expect(url).toMatch(/^blob:test\//);

    // Only ONE row in media_cache, TWO rows in media_aliases.
    expect(await db.media_cache.count()).toBe(1);
    expect(await db.media_aliases.count()).toBe(2);

    // After restart, history snapshot only has `ref` (no `object`).
    __mediaCacheTest.resetMemory();
    const historyHit = await getCachedImageUrl(['ref:s1:gen/pic.webp']);
    expect(historyHit).toMatch(/^blob:test\//);
    expect(await db.media_cache.count()).toBe(1);
  });

  it('auto-links newly provided aliases on cache hit so later ref-only lookups succeed', async () => {
    await putCachedImage(['obj:media/s1/u1.jpg'], makeBlob(512, 'image/jpeg'), 'image/jpeg');
    expect(await db.media_aliases.count()).toBe(1);

    // Live echo carries both object and ref -> hit on obj links ref.
    const hit = await getCachedImageUrl(['obj:media/s1/u1.jpg', 'ref:s1:uploads/u1.jpg']);
    expect(hit).toMatch(/^blob:test\//);

    // Wait a microtask for background alias bulkPut.
    await vi.waitFor(async () => expect(await db.media_aliases.count()).toBe(2));

    __mediaCacheTest.resetMemory();
    expect(await getCachedImageUrl(['ref:s1:uploads/u1.jpg'])).toMatch(/^blob:test\//);
  });

  it('evicts least-recently-used entries when exceeding configured byte limit and revokes evicted blob URLs', async () => {
    __mediaCacheTest.setLimitBytes(1000);

    const u1 = await putCachedImage(['ref:pkmn/1.png'], makeBlob(400), 'image/png');
    await db.media_cache.update('ref:pkmn/1.png', { accessedAt: 1000 });
    const u2 = await putCachedImage(['ref:pkmn/2.png'], makeBlob(400), 'image/png');
    await db.media_cache.update('ref:pkmn/2.png', { accessedAt: 2000 });

    // Writing a 400-byte entry pushes total to 1200 > 1000 -> evicts oldest (`ref:pkmn/1.png`).
    const u3 = await putCachedImage(['ref:pkmn/3.png'], makeBlob(400), 'image/png');
    expect(u1).toBeTruthy();
    expect(u2).toBeTruthy();
    expect(u3).toBeTruthy();

    expect(revokedUrls).toContain(u1);
    expect(revokedUrls).not.toContain(u2);
    expect(await getCachedImageUrl(['ref:pkmn/1.png'])).toBeNull();
    expect(await getCachedImageUrl(['ref:pkmn/2.png'])).toBe(u2);
    expect(await getCachedImageUrl(['ref:pkmn/3.png'])).toBe(u3);

    const stats = await getMediaCacheStats();
    expect(stats.count).toBe(2);
    expect(stats.bytes).toBe(800);
    expect(stats.limitBytes).toBe(1000);
  });

  it('handles QuotaExceededError gracefully by aggressively evicting and retrying once without throwing', async () => {
    await putCachedImage(['ref:pkmn/old1.png'], makeBlob(300), 'image/png');
    await db.media_cache.update('ref:pkmn/old1.png', { accessedAt: 100 });
    await putCachedImage(['ref:pkmn/old2.png'], makeBlob(300), 'image/png');
    await db.media_cache.update('ref:pkmn/old2.png', { accessedAt: 200 });

    const origPut = db.media_cache.put.bind(db.media_cache);
    let attempts = 0;
    vi.spyOn(db.media_cache, 'put').mockImplementation((...args) => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error('Quota exceeded');
        err.name = 'QuotaExceededError';
        return Promise.reject(err) as never;
      }
      return origPut(...args);
    });

    const url = await putCachedImage(['ref:pkmn/new.png'], makeBlob(300), 'image/png');
    expect(url).toMatch(/^blob:test\//);
    expect(attempts).toBe(2);
    // Oldest entry should have been aggressively evicted.
    expect(await getCachedImageUrl(['ref:pkmn/old1.png'])).toBeNull();
    expect(await getCachedImageUrl(['ref:pkmn/new.png'])).toBe(url);

    // If retry ALSO fails with QuotaExceededError, returns null and never throws.
    vi.spyOn(db.media_cache, 'put').mockImplementation(() => {
      const err = new Error('Still full');
      err.name = 'QuotaExceededError';
      return Promise.reject(err) as never;
    });
    await expect(putCachedImage(['ref:pkmn/fail.png'], makeBlob(200), 'image/png')).resolves.toBeNull();
  });

  it('prunes older avatar revisions while keeping the active revision', async () => {
    const v1 = await putCachedImage(['avatar:roles/asuka/avatar.webp@1'], makeBlob(256, 'image/webp'), 'image/webp');
    const v2 = await putCachedImage(['avatar:roles/asuka/avatar.webp@2'], makeBlob(256, 'image/webp'), 'image/webp');
    const other = await putCachedImage(['avatar:roles/rei/avatar.webp@1'], makeBlob(256, 'image/webp'), 'image/webp');

    await pruneOldAvatarRevs('roles/asuka/avatar.webp', 2);

    expect(revokedUrls).toContain(v1);
    expect(await getCachedImageUrl(['avatar:roles/asuka/avatar.webp@1'])).toBeNull();
    expect(await getCachedImageUrl(['avatar:roles/asuka/avatar.webp@2'])).toBe(v2);
    expect(await getCachedImageUrl(['avatar:roles/rei/avatar.webp@1'])).toBe(other);
  });

  it('rejects non-images, oversized blobs, non-2xx responses, and HTML/XML error payloads', async () => {
    expect(isImageMedia({ mime: 'audio/webm', filename: 'v.webm' })).toBe(false);
    expect(isImageMedia({ mime: 'video/mp4', filename: 'v.mp4' })).toBe(false);
    expect(isImageMedia({ mime: 'application/pdf', filename: 'doc.pdf' })).toBe(false);
    expect(isImageMedia({ mime: 'image/webp', filename: 'a.webp' })).toBe(true);

    expect(await putCachedImage(['obj:media/s1/v.webm'], makeBlob(100, 'audio/webm'), 'audio/webm')).toBeNull();
    expect(await putCachedImage(['obj:media/s1/err.png'], makeBlob(100, 'text/html'), 'text/html')).toBeNull();
    expect(await putCachedImage(['obj:media/s1/xml.png'], makeBlob(100, 'application/xml'), 'application/xml')).toBeNull();
    expect(await putCachedImage(['obj:media/s1/empty.png'], makeBlob(0, 'image/png'), 'image/png')).toBeNull();

    // Oversized blob (> 25 MiB) rejected without allocating 25 MiB in RAM via fake size.
    const huge = { size: MAX_SINGLE_IMAGE_BYTES + 1, type: 'image/png' } as Blob;
    expect(await putCachedImage(['obj:media/s1/huge.png'], huge, 'image/png')).toBeNull();

    // fetchAndCacheImage rejects 403 / XML error body and falls back to raw URL without caching.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 403,
        headers: new Headers({ 'content-type': 'application/xml' }),
        blob: async () => new Blob(['<Error>Expired</Error>'], { type: 'application/xml' }),
      })),
    );
    const signedErr = 'https://storage.invalid/expired.png?sig=1';
    expect(await fetchAndCacheImage(signedErr, ['obj:media/s1/expired.png'])).toBe(signedErr);
    expect((await getMediaCacheStats()).count).toBe(0);

    // Even HTTP 200 with text/html must never be cached.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
        blob: async () => new Blob(['<html>Login</html>'], { type: 'text/html' }),
      })),
    );
    const htmlUrl = 'https://storage.invalid/login.png';
    expect(await fetchAndCacheImage(htmlUrl, ['obj:media/s1/login.png'])).toBe(htmlUrl);
    expect((await getMediaCacheStats()).count).toBe(0);
    vi.unstubAllGlobals();
  });

  it('deduplicates concurrent remote fetches and downloads once with cors + credentials omit', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/webp' }),
      blob: async () => makeBlob(512, 'image/webp'),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const aliases = ['obj:media/s1/dup.webp', 'ref:s1:dup.webp'];
    const [a, b] = await Promise.all([
      fetchAndCacheImage('https://cdn.invalid/dup.webp', aliases),
      fetchAndCacheImage('https://cdn.invalid/dup.webp', aliases),
    ]);

    expect(a).toMatch(/^blob:test\//);
    expect(b).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://cdn.invalid/dup.webp', { mode: 'cors', credentials: 'omit' });
    vi.unstubAllGlobals();
  });

  it('supports invalidateCachedImage, purgeSessionMediaCache, purgeSessionFromDb, and clearMediaCache', async () => {
    const uS1 = await putCachedImage(['ref:s1:p1.png', 'obj:media/s1/p1.png'], makeBlob(300), 'image/png');
    const uS2 = await putCachedImage(['ref:s2:p2.png', 'obj:media/s2/p2.png'], makeBlob(400), 'image/png');
    const uGlobal = await putCachedImage(['ref:pkmn/0025.webp'], makeBlob(500, 'image/webp'), 'image/webp');

    await invalidateCachedImage(['obj:media/s1/p1.png']);
    expect(revokedUrls).toContain(uS1);
    expect(await getCachedImageUrl(['ref:s1:p1.png'])).toBeNull();
    expect((await getMediaCacheStats()).count).toBe(2);

    // Re-add s1 image and verify purgeSessionFromDb cleans it without touching s2 or global refs.
    await putCachedImage(['ref:s1:p3.png'], makeBlob(200), 'image/png');
    await purgeSessionFromDb('s1');
    expect(await getCachedImageUrl(['ref:s1:p3.png'])).toBeNull();
    expect(await getCachedImageUrl(['ref:s2:p2.png'])).toBe(uS2);
    expect(await getCachedImageUrl(['ref:pkmn/0025.webp'])).toBe(uGlobal);

    // Direct purgeSessionMediaCache cleans s2.
    await purgeSessionMediaCache('s2');
    expect(await getCachedImageUrl(['ref:s2:p2.png'])).toBeNull();
    expect(await getCachedImageUrl(['ref:pkmn/0025.webp'])).toBe(uGlobal);

    // clearMediaCache clears remaining entries and notifies listeners.
    const onClear = vi.fn();
    const unsub = onMediaCacheClear(onClear);
    await clearMediaCache();
    unsub();
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(await getMediaCacheStats()).toEqual({ bytes: 0, count: 0, limitBytes: __mediaCacheTest.getLimitBytes() });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kesoku } from '../src/lib/client';
import { __mediaCacheTest, getMediaCacheStats, putCachedImage } from '../src/lib/mediaCache';
import { actions, initialState, useStore } from '../src/lib/store';

let blobSeq = 0;

beforeEach(async () => {
  blobSeq = 0;
  useStore.setState(initialState(), true);
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:resolve/${++blobSeq}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  await __mediaCacheTest.resetAll();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await __mediaCacheTest.resetAll();
});

describe('kesoku.resolveMedia placeholder fallback', () => {
  it('an unknown placeholder with a durable ref hydrates the ref immediately (no long wait)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network error')));
    const rpc = vi.spyOn(kesoku, 'rpc').mockResolvedValue({ kind: 'image', url: 'https://media.test/0987.webp' } as never);
    const url = await kesoku.resolveMedia({ placeholder_id: 'ph_lost', ref: 'pkmn/0987.webp' }, { sessionId: 's1' });
    expect(url).toBe('https://media.test/0987.webp');
    expect(rpc).toHaveBeenCalledWith('media.hydrate', expect.objectContaining({ ref: 'pkmn/0987.webp', session_id: 's1' }), expect.anything());
  });

  it('a failed placeholder still falls back to the ref', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network error')));
    actions.setMedia('ph_bad', { status: 'failed' });
    vi.spyOn(kesoku, 'rpc').mockResolvedValue({ kind: 'image', url: 'https://media.test/r.webp' } as never);
    expect(await kesoku.resolveMedia({ placeholder_id: 'ph_bad', ref: 'pkmn/r.webp' })).toBe('https://media.test/r.webp');
  });

  it('a pending placeholder waits only briefly before using the ref', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network error')));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    actions.setMedia('ph_slow', { status: 'pending' });
    const rpc = vi.spyOn(kesoku, 'rpc').mockResolvedValue({ kind: 'image', url: 'https://media.test/s.webp' } as never);
    const p = kesoku.resolveMedia({ placeholder_id: 'ph_slow', ref: 'pkmn/s.webp' });
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await p).toBe('https://media.test/s.webp');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('a placeholder that becomes ready wins over the ref', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network error')));
    actions.setMedia('ph_ok', { status: 'pending' });
    const rpc = vi.spyOn(kesoku, 'rpc');
    const p = kesoku.resolveMedia({ placeholder_id: 'ph_ok', ref: 'pkmn/o.webp' });
    actions.setMedia('ph_ok', { status: 'ready', url: 'https://media.test/live.webp' });
    expect(await p).toBe('https://media.test/live.webp');
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('kesoku.resolveMedia persistent image cache integration', () => {
  it('returns cached blob URL directly with 0 RPCs on persistent cache hit', async () => {
    await putCachedImage(['obj:media/s1/pic.png', 'ref:s1:gen/pic.png'], new Blob([new Uint8Array(64)], { type: 'image/png' }), 'image/png');
    __mediaCacheTest.resetMemory();

    const rpc = vi.spyOn(kesoku, 'rpc');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const url = await kesoku.resolveMedia({ ref: 'gen/pic.png' }, { sessionId: 's1' });
    expect(url).toMatch(/^blob:resolve\//);
    expect(rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('on cache miss, resolves signed URL, fetches & caches once under both object and ref, and serves history from IDB', async () => {
    const rpc = vi.spyOn(kesoku, 'rpc').mockResolvedValue({
      url: 'https://signed.invalid/photo.webp?X-Goog-Signature=abc',
      expires_at: Math.floor(Date.now() / 1000) + 900,
    } as never);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/webp' }),
      blob: async () => new Blob([new Uint8Array(128)], { type: 'image/webp' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const liveUrl = await kesoku.resolveMedia(
      { object: 'media/s1/photo.webp', ref: 'uploads/photo.webp' },
      { sessionId: 's1' },
    );
    expect(liveUrl).toBe('blob:resolve/1');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('media.refresh', { object: 'media/s1/photo.webp' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Simulate app restart (empty store + empty in-memory blob map), history only carries `ref`.
    useStore.setState(initialState(), true);
    __mediaCacheTest.resetMemory();

    const historyUrl = await kesoku.resolveMedia({ ref: 'uploads/photo.webp' }, { sessionId: 's1' });
    expect(historyUrl).toBe('blob:resolve/2');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await getMediaCacheStats()).count).toBe(1);
  });

  it('falls back to raw signed URL when fetch fails (e.g. CORS error) without breaking rendering', async () => {
    vi.spyOn(kesoku, 'rpc').mockResolvedValue({
      url: 'https://signed.invalid/cors-blocked.jpg',
      expires_at: Math.floor(Date.now() / 1000) + 900,
    } as never);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const url = await kesoku.resolveMedia({ object: 'media/s1/cors-blocked.jpg' }, { sessionId: 's1' });
    expect(url).toBe('https://signed.invalid/cors-blocked.jpg');
    expect((await getMediaCacheStats()).count).toBe(0);
  });

  it('invalidates cache and re-fetches via RPC when forceRefresh is true', async () => {
    await putCachedImage(['obj:media/s1/stale.png'], new Blob([new Uint8Array(64)], { type: 'image/png' }), 'image/png');
    const rpc = vi.spyOn(kesoku, 'rpc').mockResolvedValue({
      url: 'https://signed.invalid/fresh.png',
      expires_at: Math.floor(Date.now() / 1000) + 900,
    } as never);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/png' }),
      blob: async () => new Blob([new Uint8Array(96)], { type: 'image/png' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const url = await kesoku.resolveMedia(
      { object: 'media/s1/stale.png' },
      { sessionId: 's1', forceRefresh: true },
    );
    expect(url).toBe('blob:resolve/2');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never caches audio attachments in media_cache', async () => {
    vi.spyOn(kesoku, 'rpc').mockResolvedValue({
      url: 'https://signed.invalid/clip.m4a',
      mime: 'audio/mp4',
      expires_at: Math.floor(Date.now() / 1000) + 900,
    } as never);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const url = await kesoku.resolveMedia({ object: 'media/s1/clip.m4a' }, { sessionId: 's1', mime: 'audio/mp4' });
    expect(url).toBe('https://signed.invalid/clip.m4a');
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await getMediaCacheStats()).count).toBe(0);
  });

  it('caches avatars under versioned avatar:${ref}@${rev} keys and misses on bumped rev', async () => {
    const rpc = vi
      .spyOn(kesoku, 'rpc')
      .mockResolvedValueOnce({ url: 'https://signed.invalid/av-v1.webp' } as never)
      .mockResolvedValueOnce({ url: 'https://signed.invalid/av-v2.webp' } as never);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/webp' }),
      blob: async () => new Blob([new Uint8Array(64)], { type: 'image/webp' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const v1 = await kesoku.resolveMedia({ ref: 'roles/asuka/avatar.webp' }, { kind: 'image', avatarRev: 1 });
    expect(v1).toBe('blob:resolve/1');
    expect(rpc).toHaveBeenCalledTimes(1);

    // After restart, rev 1 hits IDB with 0 RPCs.
    useStore.setState(initialState(), true);
    __mediaCacheTest.resetMemory();
    const v1Hit = await kesoku.resolveMedia({ ref: 'roles/asuka/avatar.webp' }, { kind: 'image', avatarRev: 1 });
    expect(v1Hit).toBe('blob:resolve/2');
    expect(rpc).toHaveBeenCalledTimes(1);

    // Bumped rev 2 misses cache and hydrates fresh URL.
    const v2 = await kesoku.resolveMedia({ ref: 'roles/asuka/avatar.webp' }, { kind: 'image', avatarRev: 2 });
    expect(v2).toBe('blob:resolve/3');
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});

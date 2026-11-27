import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  onStatus: null as null | ((status: string, info?: Record<string, unknown>) => void),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'web', isNativePlatform: () => false },
  registerPlugin: () => ({}),
}));

// Capture the status callback the client wires into the socket.
vi.mock('../../src/lib/ws', () => ({
  RpcError: class extends Error {},
  KesokuSocket: class {
    constructor(opts: { onStatus: (status: string, info?: Record<string, unknown>) => void }) {
      h.onStatus = opts.onStatus;
    }
    start() {}
    stop() {}
    suspend() {}
    resume() {}
  },
}));

import { kesoku } from '../../src/lib/client';
import { __mediaCacheTest, getMediaCacheStats, putCachedImage } from '../../src/lib/mediaCache';
import { useStore } from '../../src/lib/store';
import { db } from '../../src/lib/db';

beforeEach(async () => {
  kesoku.stop();
  h.onStatus = null;
  await db.kv.clear();
  await __mediaCacheTest.resetAll();
});

describe('unauthorized / forbidden socket close', () => {
  it('returns to the auth screen, clears the stale local auth marker, and clears cached images', async () => {
    // e.g. an older Web pairing session that the relay now refuses (4403).
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:auth-test/1');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    await putCachedImage(['obj:media/s1/private.png'], new Blob([new Uint8Array(64)], { type: 'image/png' }), 'image/png');
    expect((await getMediaCacheStats()).count).toBe(1);

    await db.kv.put({ key: 'auth', value: { device_id: 'dev_old', kind: 'pair' } });
    useStore.setState({ auth: 'ok', authKind: 'pair', email: null });
    await kesoku.start();
    expect(h.onStatus).toBeTypeOf('function');
    h.onStatus!('unauthorized');
    expect(useStore.getState().auth).toBe('needed');
    expect(useStore.getState().authKind).toBeNull();
    await vi.waitFor(async () => expect(await db.kv.get('auth')).toBeUndefined());
    await vi.waitFor(async () => expect((await getMediaCacheStats()).count).toBe(0));
    vi.restoreAllMocks();
  });
});

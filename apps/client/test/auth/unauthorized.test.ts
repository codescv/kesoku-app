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
import { useStore } from '../../src/lib/store';
import { db } from '../../src/lib/db';

beforeEach(async () => {
  kesoku.stop();
  h.onStatus = null;
  await db.kv.clear();
});

describe('unauthorized / forbidden socket close', () => {
  it('returns to the auth screen and clears the stale local auth marker', async () => {
    // e.g. an older Web pairing session that the relay now refuses (4403).
    await db.kv.put({ key: 'auth', value: { device_id: 'dev_old', kind: 'pair' } });
    useStore.setState({ auth: 'ok', authKind: 'pair', email: null });
    await kesoku.start();
    expect(h.onStatus).toBeTypeOf('function');
    h.onStatus!('unauthorized');
    expect(useStore.getState().auth).toBe('needed');
    expect(useStore.getState().authKind).toBeNull();
    await vi.waitFor(async () => expect(await db.kv.get('auth')).toBeUndefined());
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

const h = vi.hoisted(() => ({
  platform: { value: 'web' as 'web' | 'android' | 'ios' },
  native: {
    get: vi.fn(async (_o: { key: string }) => ({ value: 'native-value' as string | null })),
    set: vi.fn(async (_o: { key: string; value: string }) => undefined),
    remove: vi.fn(async (_o: { key: string }) => undefined),
  },
  registered: [] as string[],
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => h.platform.value,
    isNativePlatform: () => h.platform.value !== 'web',
  },
  registerPlugin: (name: string) => {
    h.registered.push(name);
    return h.native;
  },
}));

import { secureStore, WEB_DB_NAME, WEB_STORE_NAME } from '../../src/native/secureStore';

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(WEB_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked'));
  });
}

function rawRead(key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(WEB_DB_NAME);
    open.onsuccess = () => {
      const db = open.result;
      const req = db.transaction(WEB_STORE_NAME, 'readonly').objectStore(WEB_STORE_NAME).get(key);
      req.onsuccess = () => {
        db.close();
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    };
    open.onerror = () => reject(open.error);
  });
}

describe('secureStore (web / IndexedDB)', () => {
  beforeEach(async () => {
    h.platform.value = 'web';
    localStorage.clear();
    sessionStorage.clear();
    await deleteDb();
  });

  it('returns null for a missing key', async () => {
    expect(await secureStore.get('device_handle')).toBeNull();
  });

  it('round-trips set / get / remove', async () => {
    await secureStore.set('device_handle', 'opaque-123');
    expect(await secureStore.get('device_handle')).toBe('opaque-123');
    await secureStore.set('device_handle', 'opaque-456');
    expect(await secureStore.get('device_handle')).toBe('opaque-456');
    await secureStore.remove('device_handle');
    expect(await secureStore.get('device_handle')).toBeNull();
    await expect(secureStore.remove('device_handle')).resolves.toBeUndefined();
  });

  it('stores in kesoku-auth/kv and never touches Web Storage', async () => {
    const lsSet = vi.spyOn(Storage.prototype, 'setItem');
    await secureStore.set('device_handle', 'opaque-789');
    expect(await rawRead('device_handle')).toBe('opaque-789');
    expect(lsSet).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    lsSet.mockRestore();
  });

  it('keeps keys independent', async () => {
    await secureStore.set('a', '1');
    await secureStore.set('b', '2');
    await secureStore.remove('a');
    expect(await secureStore.get('a')).toBeNull();
    expect(await secureStore.get('b')).toBe('2');
  });

  it('does not block deleting the database (connections are closed)', async () => {
    await secureStore.set('device_handle', 'x');
    await expect(deleteDb()).resolves.toBeUndefined();
    expect(await secureStore.get('device_handle')).toBeNull();
  });

  it.each(['', 'has space', 'slash/key', 'x'.repeat(129), '鍵'])('rejects invalid key %j', async (key) => {
    await expect(secureStore.get(key)).rejects.toThrow(TypeError);
    await expect(secureStore.set(key, 'v')).rejects.toThrow(TypeError);
    await expect(secureStore.remove(key)).rejects.toThrow(TypeError);
  });

  it('rejects oversized values', async () => {
    await expect(secureStore.set('k', 'x'.repeat(64 * 1024 + 1))).rejects.toThrow(TypeError);
  });
});

describe('secureStore (native)', () => {
  beforeEach(() => {
    h.native.get.mockClear();
    h.native.set.mockClear();
    h.native.remove.mockClear();
  });

  it('registers the KesokuSecureStore plugin', () => {
    expect(h.registered).toContain('KesokuSecureStore');
  });

  it.each(['android', 'ios'] as const)('delegates to the native plugin on %s', async (p) => {
    h.platform.value = p;
    expect(await secureStore.get('device_token')).toBe('native-value');
    await secureStore.set('device_token', 'tok');
    await secureStore.remove('device_token');
    expect(h.native.get).toHaveBeenCalledWith({ key: 'device_token' });
    expect(h.native.set).toHaveBeenCalledWith({ key: 'device_token', value: 'tok' });
    expect(h.native.remove).toHaveBeenCalledWith({ key: 'device_token' });
  });

  it('maps a missing native value to null', async () => {
    h.platform.value = 'android';
    h.native.get.mockResolvedValueOnce({ value: null });
    expect(await secureStore.get('device_token')).toBeNull();
  });
});

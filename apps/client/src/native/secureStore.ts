import { registerPlugin } from '@capacitor/core';
import { isNative } from './platform';

/**
 * Credential storage.
 *
 * - Android: `KesokuSecureStore` local plugin (EncryptedSharedPreferences).
 * - iOS: `KesokuSecureStore` local plugin (Keychain, kSecAttrAccessibleAfterFirstUnlock).
 * - Web: IndexedDB database `kesoku-auth`, object store `kv`. Only an opaque device handle
 *   belongs here; nothing is ever written to Web Storage.
 *
 * Keys: 1-128 chars of `[A-Za-z0-9._:-]`. Values: strings up to 64 KiB.
 */
export interface SecureStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

interface KesokuSecureStorePlugin {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

const NativeSecureStore = registerPlugin<KesokuSecureStorePlugin>('KesokuSecureStore');

export const WEB_DB_NAME = 'kesoku-auth';
export const WEB_STORE_NAME = 'kv';
const WEB_DB_VERSION = 1;
const KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_VALUE_CHARS = 64 * 1024;

function assertKey(key: string): void {
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    throw new TypeError('secureStore: invalid key');
  }
}

function assertValue(value: string): void {
  if (typeof value !== 'string' || value.length > MAX_VALUE_CHARS) {
    throw new TypeError('secureStore: invalid value');
  }
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function openWebDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('secureStore: IndexedDB unavailable'));
  }
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(WEB_DB_NAME, WEB_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(WEB_STORE_NAME)) {
        db.createObjectStore(WEB_STORE_NAME);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Never hold up a future schema upgrade (or a deleteDatabase from logout / another tab).
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('secureStore: cannot open IndexedDB'));
    req.onblocked = () => reject(new Error('secureStore: IndexedDB open blocked'));
  });
}

/** Runs one transaction on a short-lived connection (operations are rare; no caching needed). */
async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openWebDb();
  try {
    const tx = db.transaction(WEB_STORE_NAME, mode);
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('secureStore: transaction aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('secureStore: transaction failed'));
    });
    const result = await promisify(fn(tx.objectStore(WEB_STORE_NAME)));
    await done;
    return result;
  } finally {
    db.close();
  }
}

export const webSecureStore: SecureStore = {
  async get(key) {
    assertKey(key);
    const v: unknown = await withStore('readonly', (s) => s.get(key));
    return typeof v === 'string' ? v : null;
  },
  async set(key, value) {
    assertKey(key);
    assertValue(value);
    await withStore('readwrite', (s) => s.put(value, key));
  },
  async remove(key) {
    assertKey(key);
    await withStore('readwrite', (s) => s.delete(key));
  },
};

const nativeSecureStore: SecureStore = {
  async get(key) {
    assertKey(key);
    const { value } = await NativeSecureStore.get({ key });
    return typeof value === 'string' ? value : null;
  },
  async set(key, value) {
    assertKey(key);
    assertValue(value);
    await NativeSecureStore.set({ key, value });
  },
  async remove(key) {
    assertKey(key);
    await NativeSecureStore.remove({ key });
  },
};

/** Platform-appropriate credential store (resolved per call, so tests can switch platforms). */
export const secureStore: SecureStore = {
  get: (key) => (isNative() ? nativeSecureStore : webSecureStore).get(key),
  set: (key, value) => (isNative() ? nativeSecureStore : webSecureStore).set(key, value),
  remove: (key) => (isNative() ? nativeSecureStore : webSecureStore).remove(key),
};

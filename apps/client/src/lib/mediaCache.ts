import { LIMITS } from '@kesoku/protocol';
import { db } from './db';

/** Default persistent image cache cap: 1 GiB (configurable for tests). */
export const MAX_MEDIA_CACHE_BYTES = 1024 * 1024 * 1024;
/** Maximum single image blob eligible for persistent caching (25 MiB). */
export const MAX_SINGLE_IMAGE_BYTES = LIMITS.MESSAGE_MEDIA_MAX_BYTES;

const TOUCH_THROTTLE_MS = 60_000;
const GLOBAL_REF_PREFIX_RE = /^(roles|user|pkmn|characters|games)\//;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|heic|heif|bmp|avif)$/i;
const AUDIO_EXT_RE = /\.(m4a|webm|wav|mp3|ogg|oga|opus|aac|flac)$/i;
const VIDEO_EXT_RE = /\.(mp4|mov|m4v|mkv|avi|ogv)$/i;
const REJECTED_MIME_RE = /^(text\/|audio\/|video\/|application\/(xml|xhtml\+xml|json|pdf|zip|javascript))/i;

let maxCacheBytes = MAX_MEDIA_CACHE_BYTES;

/** In-memory blob: URL map keyed by canonical `media_cache.id`. */
const idToBlobUrl = new Map<string, string>();
/** In-memory alias -> canonical `media_cache.id` map. */
const aliasToId = new Map<string, string>();
/** Last IndexedDB `accessedAt` write timestamp per `media_cache.id` (for 60s throttling). */
const lastTouchAt = new Map<string, number>();
/** Deduplicate concurrent remote fetches by alias. */
const inflight = new Map<string, Promise<string>>();
/** Listeners notified when `clearMediaCache()` runs (e.g., avatar / store caches). */
const clearListeners = new Set<() => void>();

export interface MediaCacheStats {
  bytes: number;
  count: number;
  limitBytes: number;
}

export function onMediaCacheClear(cb: () => void): () => void {
  clearListeners.add(cb);
  return () => {
    clearListeners.delete(cb);
  };
}

function stripUrlQuery(input: string): string {
  const hash = input.indexOf('#');
  const noHash = hash >= 0 ? input.slice(0, hash) : input;
  const q = noHash.indexOf('?');
  return q >= 0 ? noHash.slice(0, q) : noHash;
}

function normalizeMime(mime?: string | null): string {
  return (mime ?? '').split(';')[0].trim().toLowerCase();
}

function normalizeAliases(aliases: readonly (string | undefined | null)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of aliases) {
    const a = typeof raw === 'string' ? raw.trim() : '';
    if (a && !seen.has(a)) {
      seen.add(a);
      out.push(a);
    }
  }
  return out;
}

/** True when a media descriptor refers to an image (by MIME or file extension; never audio/video/documents). */
export function isImageMedia(input: { mime?: string; object?: string; ref?: string; url?: string; filename?: string }): boolean {
  const m = normalizeMime(input.mime);
  if (m) {
    if (m.startsWith('image/')) return true;
    if (m !== 'application/octet-stream') return false;
  }
  for (const candidate of [input.filename, input.object, input.ref, input.url]) {
    if (!candidate) continue;
    const clean = stripUrlQuery(candidate);
    if (AUDIO_EXT_RE.test(clean) || VIDEO_EXT_RE.test(clean)) return false;
    if (IMAGE_EXT_RE.test(clean)) return true;
  }
  return false;
}

function isCacheableImageMime(mime: string, aliases: readonly string[], url?: string): boolean {
  const m = normalizeMime(mime);
  if (m) {
    if (REJECTED_MIME_RE.test(m) || m.includes('xml') || m.includes('html')) return false;
    if (m.startsWith('image/')) return true;
    if (m !== 'application/octet-stream') return false;
  }
  for (const candidate of [...aliases, url]) {
    if (!candidate) continue;
    const clean = stripUrlQuery(candidate);
    if (AUDIO_EXT_RE.test(clean) || VIDEO_EXT_RE.test(clean)) return false;
    if (IMAGE_EXT_RE.test(clean)) return true;
  }
  return false;
}

/**
 * Build stable logical cache keys that survive 15-minute signed URL rotation:
 * - Avatars with revision: `avatar:${ref}@${rev}`
 * - Global shared refs (`roles/`, `user/`, `pkmn/`, `characters/`, `games/`): `ref:${ref}`
 * - Session-scoped refs: `ref:${sessionId}:${ref}`
 * - Relay objects: `obj:${object}`
 */
export function buildMediaAliases(opts: {
  object?: string;
  ref?: string;
  sessionId?: string;
  avatarRev?: number;
}): string[] {
  const out: string[] = [];
  if (opts.ref) {
    if (opts.avatarRev !== undefined) {
      out.push(`avatar:${opts.ref}@${opts.avatarRev}`);
    } else if (GLOBAL_REF_PREFIX_RE.test(opts.ref)) {
      out.push(`ref:${opts.ref}`);
    } else if (opts.sessionId) {
      out.push(`ref:${opts.sessionId}:${opts.ref}`);
    } else {
      out.push(`ref:${opts.ref}`);
    }
  }
  if (opts.object) {
    out.push(`obj:${opts.object}`);
  }
  return normalizeAliases(out);
}

function canMintObjectUrl(): boolean {
  return typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
}

function mintBlobUrl(id: string, blob: Blob): string | null {
  const existing = idToBlobUrl.get(id);
  if (existing) return existing;
  if (!canMintObjectUrl()) return null;
  const url = URL.createObjectURL(blob);
  idToBlobUrl.set(id, url);
  return url;
}

function revokeId(id: string): void {
  const url = idToBlobUrl.get(id);
  if (url) {
    try {
      if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(url);
      }
    } catch {
      /* ignore revoke failure */
    }
    idToBlobUrl.delete(id);
  }
  lastTouchAt.delete(id);
  for (const [alias, targetId] of aliasToId.entries()) {
    if (targetId === id) aliasToId.delete(alias);
  }
}

function isQuotaExceededError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; code?: number; inner?: { name?: string; code?: number } };
  return (
    e.name === 'QuotaExceededError' ||
    e.code === 22 ||
    e.inner?.name === 'QuotaExceededError' ||
    e.inner?.code === 22
  );
}

function touchLruThrottled(id: string, previousAccessedAt?: number): void {
  const now = Date.now();
  const last = Math.max(lastTouchAt.get(id) ?? 0, previousAccessedAt ?? 0);
  if (now - last < TOUCH_THROTTLE_MS) return;
  lastTouchAt.set(id, now);
  void db.media_cache.update(id, { accessedAt: now }).catch(() => {});
}

function linkAliasesInMemory(id: string, aliases: readonly string[]): string[] {
  const newlyLinked: string[] = [];
  for (const alias of aliases) {
    if (aliasToId.get(alias) !== id) {
      aliasToId.set(alias, id);
      newlyLinked.push(alias);
    }
  }
  return newlyLinked;
}

/** Synchronous in-memory cache peek for 0ms initial render (e.g., right after Composer upload). */
export function peekCachedImageUrl(aliases: readonly string[]): string | null {
  const keys = normalizeAliases(aliases);
  for (const alias of keys) {
    const id = aliasToId.get(alias);
    if (!id) continue;
    const url = idToBlobUrl.get(id);
    if (url) {
      const missing = linkAliasesInMemory(id, keys);
      if (missing.length) {
        void db.media_aliases.bulkPut(missing.map((a) => ({ alias: a, targetId: id }))).catch(() => {});
      }
      touchLruThrottled(id);
      return url;
    }
  }
  return null;
}

/** Look up any alias in memory or IndexedDB, returning a reusable `blob:` URL (0 RPCs, 0 network). */
export async function getCachedImageUrl(aliases: readonly string[]): Promise<string | null> {
  const keys = normalizeAliases(aliases);
  if (!keys.length) return null;

  const memHit = peekCachedImageUrl(keys);
  if (memHit) return memHit;

  try {
    const aliasRows = await db.media_aliases.bulkGet(keys);
    let targetId: string | undefined;
    for (const row of aliasRows) {
      if (row?.targetId) {
        targetId = row.targetId;
        break;
      }
    }
    if (!targetId) {
      const directRows = await db.media_cache.bulkGet(keys);
      const hit = directRows.find((r) => Boolean(r));
      if (hit) targetId = hit.id;
    }
    if (!targetId) return null;

    const entry = await db.media_cache.get(targetId);
    if (!entry) {
      // Clean up orphaned aliases pointing to missing blob row.
      await db.media_aliases.where('targetId').equals(targetId).delete().catch(() => {});
      return null;
    }

    const url = mintBlobUrl(entry.id, entry.blob);
    if (!url) return null;

    linkAliasesInMemory(entry.id, keys);
    const missingAliases = keys.filter((k, idx) => aliasRows[idx]?.targetId !== entry.id);
    if (missingAliases.length) {
      void db.media_aliases.bulkPut(missingAliases.map((alias) => ({ alias, targetId: entry.id }))).catch(() => {});
    }
    touchLruThrottled(entry.id, entry.accessedAt);
    return url;
  } catch {
    return null;
  }
}

async function evictByTargetIds(evictIds: string[]): Promise<void> {
  if (!evictIds.length) return;
  await db.transaction('rw', [db.media_cache, db.media_aliases], async () => {
    await db.media_cache.bulkDelete(evictIds);
    await db.media_aliases.where('targetId').anyOf(evictIds).delete();
  });
  for (const id of evictIds) revokeId(id);
}

async function writeCacheEntry(
  id: string,
  aliases: string[],
  blob: Blob,
  mime: string,
  bytes: number,
  now: number,
  staleIdsToDrop: string[],
): Promise<string[]> {
  const evictedIds: string[] = [];
  await db.transaction('rw', [db.media_cache, db.media_aliases], async () => {
    if (staleIdsToDrop.length) {
      await db.media_cache.bulkDelete(staleIdsToDrop);
      await db.media_aliases.where('targetId').anyOf(staleIdsToDrop).delete();
    }

    const existing = await db.media_cache.orderBy('accessedAt').toArray();
    let totalBytes = 0;
    for (const row of existing) {
      if (row.id !== id) totalBytes += row.bytes;
    }

    if (totalBytes + bytes > maxCacheBytes) {
      let current = totalBytes;
      for (const row of existing) {
        if (row.id === id) continue;
        if (current + bytes <= maxCacheBytes) break;
        evictedIds.push(row.id);
        current -= row.bytes;
      }
      if (evictedIds.length) {
        await db.media_cache.bulkDelete(evictedIds);
        await db.media_aliases.where('targetId').anyOf(evictedIds).delete();
      }
    }

    await db.media_cache.put({
      id,
      blob,
      mime,
      bytes,
      createdAt: now,
      accessedAt: now,
    });
    await db.media_aliases.bulkPut(aliases.map((alias) => ({ alias, targetId: id })));
  });
  return [...staleIdsToDrop, ...evictedIds];
}

async function evictAggressively(minBytesToFree: number, keepId: string): Promise<void> {
  const existing = await db.media_cache.orderBy('accessedAt').toArray();
  const candidates = existing.filter((r) => r.id !== keepId);
  if (!candidates.length) return;
  const totalBytes = candidates.reduce((acc, r) => acc + r.bytes, 0);
  const targetFree = Math.max(minBytesToFree, Math.ceil(totalBytes / 2));
  let freed = 0;
  const evictIds: string[] = [];
  for (const row of candidates) {
    evictIds.push(row.id);
    freed += row.bytes;
    if (freed >= targetFree && evictIds.length >= Math.ceil(candidates.length / 2)) break;
  }
  await evictByTargetIds(evictIds);
}

/** Store an image Blob under one or more logical aliases with 1 GiB LRU enforcement and QuotaExceededError recovery. */
export async function putCachedImage(aliases: readonly string[], blob: Blob, mime?: string): Promise<string | null> {
  const keys = normalizeAliases(aliases);
  if (!keys.length || !blob) return null;

  const effectiveMime = normalizeMime(mime || blob.type);
  if (!isCacheableImageMime(effectiveMime, keys)) return null;

  const bytes = blob.size;
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > MAX_SINGLE_IMAGE_BYTES || bytes > maxCacheBytes) {
    return null;
  }

  const now = Date.now();
  try {
    const existingAliasRows = await db.media_aliases.bulkGet(keys);
    const matchedIds = normalizeAliases(existingAliasRows.map((r) => r?.targetId));
    const id = matchedIds[0] ?? keys[0];
    const staleIds = matchedIds.slice(1);

    // If overwriting an existing row's blob, revoke its old blob: URL before minting the new one.
    const hadOldUrl = idToBlobUrl.has(id);

    let removedIds: string[];
    try {
      removedIds = await writeCacheEntry(id, keys, blob, effectiveMime || 'image/octet-stream', bytes, now, staleIds);
    } catch (err) {
      if (!isQuotaExceededError(err)) return null;
      try {
        await evictAggressively(bytes * 2, id);
        removedIds = await writeCacheEntry(id, keys, blob, effectiveMime || 'image/octet-stream', bytes, now, staleIds);
      } catch {
        return null;
      }
    }

    for (const evId of removedIds) revokeId(evId);
    if (hadOldUrl) revokeId(id);

    const url = mintBlobUrl(id, blob);
    if (!url) return null;
    linkAliasesInMemory(id, keys);
    lastTouchAt.set(id, now);
    return url;
  } catch {
    return null;
  }
}

/**
 * Single-download image fetch + cache: checks persistent cache first, deduplicates concurrent fetches,
 * fetches once with `{ mode: 'cors', credentials: 'omit' }`, validates HTTP 2xx + image content-type,
 * stores in IndexedDB, and returns a `blob:` URL. Gracefully falls back to the raw signed URL on error.
 */
export async function fetchAndCacheImage(
  url: string,
  aliases: readonly string[],
  opts: { mime?: string } = {},
): Promise<string> {
  if (!url || /^(blob|data):/i.test(url)) return url;
  const keys = normalizeAliases(aliases);
  if (!keys.length) return url;

  const existing = await getCachedImageUrl(keys);
  if (existing) return existing;

  for (const alias of keys) {
    const running = inflight.get(alias);
    if (running) return running;
  }

  const promise: Promise<string> = (async (): Promise<string> => {
    try {
      const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (!res || !res.ok) return url;

      const contentLength = Number(res.headers?.get?.('content-length') ?? '');
      if (Number.isFinite(contentLength) && contentLength > MAX_SINGLE_IMAGE_BYTES) {
        return url;
      }

      const headerMime = normalizeMime(res.headers?.get?.('content-type'));
      if (headerMime && (REJECTED_MIME_RE.test(headerMime) || headerMime.includes('xml') || headerMime.includes('html'))) {
        return url;
      }
      const candidateMime = headerMime && headerMime !== 'application/octet-stream' ? headerMime : normalizeMime(opts.mime);
      if (!isCacheableImageMime(candidateMime, keys, url)) {
        return url;
      }

      const blob = await res.blob();
      if (!blob || blob.size <= 0 || blob.size > MAX_SINGLE_IMAGE_BYTES) {
        return url;
      }
      const blobMime = normalizeMime(blob.type);
      if (blobMime && (REJECTED_MIME_RE.test(blobMime) || blobMime.includes('xml') || blobMime.includes('html'))) {
        return url;
      }
      const finalMime = candidateMime || blobMime || 'image/octet-stream';
      const cachedUrl = await putCachedImage(keys, blob, finalMime);
      return cachedUrl ?? url;
    } catch {
      return url;
    }
  })().finally(() => {
    for (const alias of keys) {
      if (inflight.get(alias) === promise) inflight.delete(alias);
    }
  });

  for (const alias of keys) inflight.set(alias, promise);
  return promise;
}

/** Invalidate cached image(s) for the given aliases (revoking blob URLs and deleting IDB rows). */
export async function invalidateCachedImage(aliases: readonly string[]): Promise<void> {
  const keys = normalizeAliases(aliases);
  if (!keys.length) return;

  const memIds = new Set<string>();
  for (const alias of keys) {
    const id = aliasToId.get(alias);
    if (id) memIds.add(id);
    if (idToBlobUrl.has(alias)) memIds.add(alias);
    aliasToId.delete(alias);
  }
  for (const id of memIds) revokeId(id);

  try {
    const rows = await db.media_aliases.bulkGet(keys);
    const ids = new Set<string>(memIds);
    for (const r of rows) {
      if (r?.targetId) ids.add(r.targetId);
    }
    for (const k of keys) ids.add(k);
    const idList = [...ids];
    await db.transaction('rw', [db.media_cache, db.media_aliases], async () => {
      await db.media_cache.bulkDelete(idList);
      await db.media_aliases.where('targetId').anyOf(idList).delete();
      await db.media_aliases.bulkDelete(keys);
    });
    for (const id of idList) revokeId(id);
  } catch {
    /* ignore IDB error */
  }
}

/** Prune older cached revisions for an avatar ref, keeping only `avatar:${ref}@${keepRev}`. */
export async function pruneOldAvatarRevs(ref: string, keepRev: number): Promise<void> {
  if (!ref) return;
  const prefix = `avatar:${ref}@`;
  const keepAlias = `${prefix}${keepRev}`;
  try {
    const all = await db.media_aliases.where('alias').startsWith(prefix).toArray();
    const keepTargetId = all.find((r) => r.alias === keepAlias)?.targetId;
    const stale = all.filter((r) => r.alias !== keepAlias);
    if (!stale.length) return;
    const staleAliases = stale.map((r) => r.alias);
    const staleTargetIds = normalizeAliases(stale.map((r) => r.targetId)).filter((id) => id !== keepTargetId);
    await db.transaction('rw', [db.media_cache, db.media_aliases], async () => {
      await db.media_aliases.bulkDelete(staleAliases);
      if (staleTargetIds.length) {
        await db.media_cache.bulkDelete(staleTargetIds);
        await db.media_aliases.where('targetId').anyOf(staleTargetIds).delete();
      }
    });
    for (const a of staleAliases) aliasToId.delete(a);
    for (const id of staleTargetIds) revokeId(id);
  } catch {
    /* ignore IDB error */
  }
}

/** Purge all cached media rows scoped to a deleted session (`ref:${sessionId}:*` and `obj:media/${sessionId}/*`). */
export async function purgeSessionMediaCache(sessionId: string): Promise<void> {
  if (!sessionId) return;
  const refPrefix = `ref:${sessionId}:`;
  const objPrefix = `obj:media/${sessionId}/`;
  try {
    const [refRows, objRows] = await Promise.all([
      db.media_aliases.where('alias').startsWith(refPrefix).toArray(),
      db.media_aliases.where('alias').startsWith(objPrefix).toArray(),
    ]);
    const rows = [...refRows, ...objRows];
    if (!rows.length) return;
    const targetIds = normalizeAliases(rows.map((r) => r.targetId));
    await evictByTargetIds(targetIds);
    for (const r of rows) aliasToId.delete(r.alias);
  } catch {
    /* ignore IDB error */
  }
}

/** Return current persistent image cache usage (`bytes`, `count`, `limitBytes`). */
export async function getMediaCacheStats(): Promise<MediaCacheStats> {
  try {
    let bytes = 0;
    let count = 0;
    await db.media_cache.each((row) => {
      bytes += row.bytes || 0;
      count += 1;
    });
    return { bytes, count, limitBytes: maxCacheBytes };
  } catch {
    return { bytes: 0, count: 0, limitBytes: maxCacheBytes };
  }
}

/** Clear all cached images from memory and IndexedDB, revoking all minted `blob:` URLs. */
export async function clearMediaCache(): Promise<void> {
  const ids = [...idToBlobUrl.keys()];
  for (const id of ids) revokeId(id);
  idToBlobUrl.clear();
  aliasToId.clear();
  lastTouchAt.clear();
  inflight.clear();
  try {
    await db.transaction('rw', [db.media_cache, db.media_aliases], async () => {
      await db.media_cache.clear();
      await db.media_aliases.clear();
    });
  } catch {
    /* ignore IDB error */
  }
  for (const cb of clearListeners) {
    try {
      cb();
    } catch {
      /* ignore listener error */
    }
  }
}

/** Test helpers (for resetting memory vs IDB, configuring LRU cap, etc.). */
export const __mediaCacheTest = {
  resetMemory(): void {
    const ids = [...idToBlobUrl.keys()];
    for (const id of ids) revokeId(id);
    idToBlobUrl.clear();
    aliasToId.clear();
    lastTouchAt.clear();
    inflight.clear();
  },
  async resetAll(): Promise<void> {
    maxCacheBytes = MAX_MEDIA_CACHE_BYTES;
    await clearMediaCache();
  },
  setLimitBytes(bytes: number): void {
    maxCacheBytes = bytes;
  },
  getLimitBytes(): number {
    return maxCacheBytes;
  },
  getMemoryEntryCount(): number {
    return idToBlobUrl.size;
  },
};

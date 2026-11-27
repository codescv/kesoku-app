import { useEffect, useState } from 'react';
import { kesoku } from '../../lib/client';
import { onMediaCacheClear, pruneOldAvatarRevs } from '../../lib/mediaCache';
import { actions } from '../../lib/store';

/** Last avatar_rev seen per ref — a changed rev invalidates the cached (signed) URL. */
const seenRev = new Map<string, number>();
const inflight = new Map<string, Promise<string | null>>();
const failed = new Set<string>();

onMediaCacheClear(() => {
  seenRev.clear();
  inflight.clear();
  failed.clear();
});

const SIGNED_RE = /[?&](x-goog-signature|x-amz-signature|signature|sig)=/i;

/**
 * Append the avatar revision for cache-busting. Signed URLs must not get extra query params
 * (that would invalidate the signature), so they carry the revision in the fragment instead —
 * a re-hydrated signed URL is already unique.
 */
export function withRev(url: string, rev: number | undefined): string {
  if (!rev || /^(blob|data):/i.test(url)) return url;
  const hash = url.indexOf('#');
  const base = hash >= 0 ? url.slice(0, hash) : url;
  if (SIGNED_RE.test(base)) return `${base}#rev=${rev}`;
  return `${base}${base.includes('?') ? '&' : '?'}rev=${rev}`;
}

function resolveAvatar(ref: string, rev: number): Promise<string | null> {
  const key = `${ref}@${rev}`;
  const running = inflight.get(key);
  if (running) return running;
  if (seenRev.get(ref) !== rev) {
    // Drop any cached URL for an older revision so `resolveMedia` hydrates again, and prune old IDB revisions.
    actions.setMedia(`ref:${ref}`, { status: 'pending' });
    seenRev.set(ref, rev);
    void pruneOldAvatarRevs(ref, rev).catch(() => {});
  }
  const p = kesoku
    .resolveMedia({ ref }, { kind: 'image', avatarRev: rev })
    .catch(() => null)
    .then((u) => {
      inflight.delete(key);
      if (!u) failed.add(key);
      return u ? withRev(u, rev) : null;
    });
  inflight.set(key, p);
  return p;
}

/** Lazily resolve an avatar ref (`roles/<id>/avatar.webp` / `user/avatar.webp`); null → letter avatar. */
export function useAvatarUrl(ref: string | null, rev: number | undefined): string | null {
  const r = rev ?? 0;
  const [state, setState] = useState<{ key: string; url: string | null }>({ key: '', url: null });
  const key = ref ? `${ref}@${r}` : '';
  useEffect(() => {
    if (!ref || failed.has(`${ref}@${r}`)) return;
    let alive = true;
    void resolveAvatar(ref, r).then((url) => {
      if (alive) setState({ key: `${ref}@${r}`, url });
    });
    return () => {
      alive = false;
    };
  }, [ref, r]);
  if (!ref) return null;
  // Keep showing the previous revision until the new one resolves (cross-fade in CSS).
  if (state.key === key) return state.url;
  return state.key.startsWith(`${ref}@`) ? state.url : null;
}

/** Test seam. */
export const __avatarCache = {
  reset() {
    seenRev.clear();
    inflight.clear();
    failed.clear();
  },
};

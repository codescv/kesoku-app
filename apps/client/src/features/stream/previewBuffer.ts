import type { StreamPreview } from '../../lib/types';

export function cpLen(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

export interface DeltaPayload {
  turn_id: string;
  round_id: number;
  offset: number;
  delta: string;
  phase?: 'text' | 'thought';
}

export interface DeltaResult {
  preview: StreamPreview | undefined;
  /** Offset mismatch (dropped frame / mid-stream reconnect) → caller must `sync.resume` and replace from `active_turn.preview_text`. */
  needResync: boolean;
  dropped: boolean;
}

/**
 * Apply a `stream.delta` to the preview buffer keyed by (turn_id, round_id) — Blueprint §3.2:
 * offset 0 → reset; offset == buffered code-point length → append; otherwise do not splice and resync.
 * Deltas for finalized turns and stale rounds are dropped.
 */
export function applyDelta(prev: StreamPreview | undefined, d: DeltaPayload, finalized: ReadonlySet<string>, now = Date.now()): DeltaResult {
  if (finalized.has(d.turn_id)) return { preview: prev, needResync: false, dropped: true };
  const phase = d.phase ?? 'text';
  let p = prev;
  if (!p || p.turn_id !== d.turn_id) {
    p = { turn_id: d.turn_id, round_id: d.round_id, text: '', thought: '', startedAt: now };
  } else if (d.round_id < p.round_id) {
    return { preview: prev, needResync: false, dropped: true };
  } else if (d.round_id > p.round_id) {
    p = { ...p, round_id: d.round_id, text: '', thought: '' };
  } else {
    p = { ...p };
  }
  const key = phase === 'thought' ? 'thought' : 'text';
  const buf = p[key];
  if (d.offset === 0) {
    p[key] = d.delta;
    return { preview: p, needResync: false, dropped: false };
  }
  if (d.offset === cpLen(buf)) {
    p[key] = buf + d.delta;
    return { preview: p, needResync: false, dropped: false };
  }
  return { preview: p, needResync: true, dropped: false };
}

/** `stream.clear{turn_id, round_id}` → preview invalidated (next tool round starts fresh). */
export function applyClear(prev: StreamPreview | undefined, c: { turn_id: string; round_id: number }, finalized: ReadonlySet<string>, now = Date.now()): StreamPreview | undefined {
  if (finalized.has(c.turn_id)) return prev;
  if (prev && prev.turn_id === c.turn_id && c.round_id < prev.round_id) return prev;
  return { turn_id: c.turn_id, round_id: c.round_id, text: '', thought: '', startedAt: prev?.turn_id === c.turn_id ? prev.startedAt : now };
}

/** Replace the buffer from `active_turn` after a resync. */
export function fromActiveTurn(at: { turn_id: string; round_id: number; preview_text: string } | null | undefined, finalized: ReadonlySet<string>, now = Date.now()): StreamPreview | undefined {
  if (!at || finalized.has(at.turn_id)) return undefined;
  return { turn_id: at.turn_id, round_id: at.round_id, text: at.preview_text, thought: '', startedAt: now };
}

/** Coalesce high-frequency updates into one flush per animation frame (60 fps). */
export function createFrameBatcher<T>(flush: (items: T[]) => void, raf: (cb: () => void) => unknown = defaultRaf) {
  let items: T[] = [];
  let scheduled = false;
  return {
    push(item: T) {
      items.push(item);
      if (scheduled) return;
      scheduled = true;
      raf(() => {
        scheduled = false;
        const batch = items;
        items = [];
        if (batch.length) flush(batch);
      });
    },
    flushNow() {
      const batch = items;
      items = [];
      scheduled = false;
      if (batch.length) flush(batch);
    },
  };
}

function defaultRaf(cb: () => void) {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(() => cb());
  return setTimeout(cb, 16);
}

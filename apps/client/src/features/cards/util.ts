import { useEffect, useRef, useState } from 'react';
import type { CardContext, GlossaryEntry, MediaRef } from './types';

/* ------------------------------------------------------------------ */
/* Defensive accessors: unknown / malformed fields → empty, never throw */
/* ------------------------------------------------------------------ */

export type Dict = Record<string, unknown>;

export function isObj(v: unknown): v is Dict {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function obj(v: unknown): Dict {
  return isObj(v) ? v : {};
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** String-ish value → trimmed string ('' for null / objects). */
export function str(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

export function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** List of strings from `string[]`, a `、`/`,`-separated string, or `[{label|name|text}]`. */
export function strList(v: unknown): string[] {
  if (typeof v === 'string') {
    return v
      .split(/[、,，·/]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return arr(v)
    .map((x) => (isObj(x) ? str(x.label ?? x.name ?? x.text ?? x.zh ?? x.title) : str(x)))
    .filter(Boolean);
}

/** First non-empty string among several candidate fields. */
export function pick(o: Dict, ...keys: string[]): string {
  for (const k of keys) {
    const s = str(o[k]);
    if (s) return s;
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* Media                                                               */
/* ------------------------------------------------------------------ */

const URL_RE = /^(https?:|data:|blob:|capacitor:|file:\/\/)/i;
const FILE_TAG_RE = /^\[file:\s*([^\]]+)\]$/i;

/** Coerce a card field (`"[file:pkmn/0149.webp]"`, URL, `{placeholder_id|object|ref|url}`) into a MediaRef. */
export function toMediaRef(v: unknown): MediaRef | null {
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    if (URL_RE.test(s)) return { url: s };
    const m = FILE_TAG_RE.exec(s);
    if (m) return { ref: m[1].trim() };
    return { ref: s };
  }
  if (isObj(v)) {
    const r: MediaRef = {};
    for (const k of ['placeholder_id', 'object', 'ref', 'url'] as const) {
      const s = str(v[k]);
      if (s) r[k] = s;
    }
    return Object.keys(r).length ? r : null;
  }
  return null;
}

/**
 * Card media lookup: `ctx.media[key]` placeholder first, then the raw data value. The data value (e.g.
 * `{ ref: 'pkmn/0987.webp' }`) is kept alongside the placeholder so resolving can fall back to `media.hydrate`
 * when the placeholder is unknown to the live store (after a reload) or fails.
 */
export function cardMedia(ctx: Pick<CardContext, 'media'>, keys: string[], fallback?: unknown): MediaRef | null {
  const fb = toMediaRef(fallback);
  for (const k of keys) {
    const ph = ctx.media?.[k];
    if (typeof ph === 'string' && ph) return fb ? { ...fb, placeholder_id: ph } : { placeholder_id: ph };
  }
  return fb;
}

/** Resolve an IMAGE ref on mount (never used for audio — audio resolves only inside a tap handler). */
export function useImageUrl(resolve: CardContext['resolveMedia'] | undefined, ref: MediaRef | null): string | null | undefined {
  const key = ref ? JSON.stringify(ref) : '';
  const [state, setState] = useState<{ key: string; url: string | null | undefined }>({ key: '', url: undefined });
  // `resolve` is recreated with the card context on every list render (streaming, state.sync…). Keep the latest in
  // a ref and re-resolve only when the media itself changes, so in-flight loads are never cancelled/reset.
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;
  const hasResolve = !!resolve;
  useEffect(() => {
    const resolve = resolveRef.current;
    if (!ref || !resolve) return;
    if (ref.url && !ref.placeholder_id && !ref.object && !ref.ref) {
      setState({ key, url: ref.url });
      return;
    }
    let alive = true;
    setState({ key, url: undefined });
    resolve(ref).then(
      (u) => alive && setState({ key, url: u ?? null }),
      () => alive && setState({ key, url: null }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, hasResolve]);
  if (!ref) return null;
  return state.key === key ? state.url : undefined;
}

/* ------------------------------------------------------------------ */
/* Photo location (menu photos)                                       */
/* ------------------------------------------------------------------ */

export type BBox = [number, number, number, number];

/** `[x,y,w,h]` / `{x,y,w,h}` normalized 0–1 (percent values > 1 are scaled down). */
export function toBBox(v: unknown): BBox | null {
  let vals: (number | null)[] = [];
  if (Array.isArray(v)) vals = v.slice(0, 4).map(num);
  else if (isObj(v)) vals = [num(v.x), num(v.y), num(v.w ?? v.width), num(v.h ?? v.height)];
  if (vals.length !== 4 || vals.some((x) => x === null)) return null;
  let [x, y, w, h] = vals as number[];
  if (Math.max(x, y, w, h) > 1) [x, y, w, h] = [x / 100, y / 100, w / 100, h / 100];
  const c = (n: number) => Math.max(0, Math.min(1, n));
  x = c(x);
  y = c(y);
  w = Math.min(c(w), 1 - x);
  h = Math.min(c(h), 1 - y);
  if (w <= 0 || h <= 0) return null;
  return [x, y, w, h];
}

/** `右上` / `左中` / `正中` from a bbox centre. */
export function bboxPosition(b: BBox | null): string {
  if (!b) return '';
  const cx = b[0] + b[2] / 2;
  const cy = b[1] + b[3] / 2;
  const h = cx < 1 / 3 ? '左' : cx < 2 / 3 ? '中' : '右';
  const v = cy < 1 / 3 ? '上' : cy < 2 / 3 ? '中' : '下';
  if (h === '中' && v === '中') return '正中';
  return h + v;
}

/** Photo number shown to the user (`photo_index` is 1-based; 0 is tolerated as the first photo). */
export function photoNumber(v: unknown): number | null {
  const n = num(v);
  if (n === null || n < 0) return null;
  return Math.max(1, Math.round(n));
}

/** MediaRef of menu photo #n (1-based): `ctx.media` keys first, then `data.photos[n-1]`. */
export function photoRef(ctx: Pick<CardContext, 'media'>, data: Dict, n: number): MediaRef | null {
  const keys = [`photo_${n}`, `photo${n}`, `photos.${n - 1}`, `photos[${n - 1}]`, `image_${n}`, `图${n}`];
  const photos = arr(data.photos ?? data.images);
  return cardMedia(ctx, keys, photos[n - 1]);
}

/* ------------------------------------------------------------------ */
/* Language                                                            */
/* ------------------------------------------------------------------ */

const KANA_RE = /[\u3041-\u30ff]/;
const HANGUL_RE = /[\uac00-\ud7af]/;
const HAN_RE = /[\u4e00-\u9fff]/;

export function hasKana(s: string): boolean {
  return KANA_RE.test(s);
}

const LANG_TAGS: Record<string, string> = {
  ja: 'ja-JP',
  jp: 'ja-JP',
  日语: 'ja-JP',
  zh: 'zh-CN',
  'zh-cn': 'zh-CN',
  'zh-hans': 'zh-CN',
  简中: 'zh-CN',
  中文: 'zh-CN',
  'zh-tw': 'zh-TW',
  'zh-hant': 'zh-TW',
  en: 'en-US',
  英语: 'en-US',
  ko: 'ko-KR',
  kr: 'ko-KR',
  韩语: 'ko-KR',
};

/** BCP-47 tag for TTS from an explicit hint, else guessed from the script of the text. */
export function speechLang(hint: unknown, text: string): string {
  const h = str(hint).toLowerCase();
  if (h && LANG_TAGS[h]) return LANG_TAGS[h];
  if (h && /^[a-z]{2}-[a-z]{2,4}$/i.test(h)) return h;
  if (KANA_RE.test(text)) return 'ja-JP';
  if (HANGUL_RE.test(text)) return 'ko-KR';
  if (HAN_RE.test(text)) return 'zh-CN';
  return 'en-US';
}

/* ------------------------------------------------------------------ */
/* Glossary                                                            */
/* ------------------------------------------------------------------ */

/** Normalise a card's `glossary{}` map into `GlossaryEntry` records keyed (and id'd) by their key. */
export function glossaryMap(v: unknown): Record<string, GlossaryEntry> {
  const out: Record<string, GlossaryEntry> = {};
  for (const [id, raw] of Object.entries(obj(v))) {
    if (!isObj(raw)) continue;
    const title = pick(raw, 'title', 'name', 'label') || id;
    out[id] = {
      id,
      title,
      category: pick(raw, 'category') || undefined,
      summary: pick(raw, 'summary') || undefined,
      effect_pills: strList(raw.effect_pills),
      details_md: pick(raw, 'details_md', 'details') || undefined,
      related: strList(raw.related),
    };
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Pokémon types                                                       */
/* ------------------------------------------------------------------ */

const TYPE_COLORS: Record<string, string> = {
  一般: '#9fa19f', normal: '#9fa19f',
  火: '#e62829', fire: '#e62829',
  水: '#2980ef', water: '#2980ef',
  草: '#3fa129', grass: '#3fa129',
  电: '#e6b800', electric: '#e6b800',
  冰: '#3dcef3', ice: '#3dcef3',
  格斗: '#ff8000', fighting: '#ff8000',
  毒: '#9141cb', poison: '#9141cb',
  地面: '#915121', ground: '#915121',
  飞行: '#81b9ef', flying: '#81b9ef',
  超能力: '#ef4179', psychic: '#ef4179',
  虫: '#91a119', bug: '#91a119',
  岩石: '#afa981', rock: '#afa981',
  幽灵: '#704170', ghost: '#704170',
  龙: '#5060e1', dragon: '#5060e1',
  恶: '#624d4e', dark: '#624d4e',
  钢: '#60a1b8', steel: '#60a1b8',
  妖精: '#ef70ef', fairy: '#ef70ef',
};

export function typeColor(t: string): string {
  return TYPE_COLORS[t] ?? TYPE_COLORS[t.toLowerCase()] ?? '#7c8597';
}

export type GameVersion = 'sv' | 'za';

export function versionOf(data: Dict): GameVersion {
  const v = str(data.version ?? data.game_version).toLowerCase();
  if (v === 'za' || v === 'z-a') return 'za';
  if (v === 'sv') return 'sv';
  return data.cd_s != null || data.cd_sec != null || data.mega_stone != null ? 'za' : 'sv';
}

export const VERSION_LABEL: Record<GameVersion, string> = { sv: '朱／紫 SV', za: '传说 Z-A' };

/* ------------------------------------------------------------------ */
/* Plain text helpers                                                  */
/* ------------------------------------------------------------------ */

/** Markdown → plain paragraphs (never HTML): strips emphasis / code / heading / list markers. */
export function mdParagraphs(md: string): string[] {
  return md
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .split('\n')
        .map((l) =>
          l
            .replace(/^\s{0,3}#{1,6}\s+/, '')
            .replace(/^\s*[-*+]\s+/, '• ')
            .replace(/^\s*>\s?/, '')
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/__([^_]+)__/g, '$1')
            .replace(/\*([^*]+)\*/g, '$1')
            .replace(/`([^`]+)`/g, '$1')
            .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'),
        )
        .join('\n')
        .trim(),
    )
    .filter(Boolean);
}

/** Character-level diff (LCS) for short strings. Returns null when too long to be worth it. */
export function charDiff(a: string, b: string): { a: Array<[string, boolean]>; b: Array<[string, boolean]> } | null {
  const A = Array.from(a);
  const B = Array.from(b);
  if (!A.length || !B.length || A.length * B.length > 60000) return null;
  const n = A.length;
  const m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ra: Array<[string, boolean]> = [];
  const rb: Array<[string, boolean]> = [];
  const push = (list: Array<[string, boolean]>, ch: string, changed: boolean) => {
    const last = list[list.length - 1];
    if (last && last[1] === changed) last[0] += ch;
    else list.push([ch, changed]);
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      push(ra, A[i++], false);
      push(rb, B[j++], false);
    } else if (dp[i + 1][j] >= dp[i][j + 1]) push(ra, A[i++], true);
    else push(rb, B[j++], true);
  }
  while (i < n) push(ra, A[i++], true);
  while (j < m) push(rb, B[j++], true);
  return { a: ra, b: rb };
}

import { useEffect, useMemo, useRef, useState } from 'react';
import type { BilingualSegment, LexToken } from '@kesoku/protocol';
import { RubyText, VoicePill, resolveRubyParts, type RubyPart } from '@kesoku/ui';
import { useStore } from '../../lib/store';
import { Markdown } from './Markdown';

export interface WordUnit extends RubyPart {
  start: number;
  end: number;
}

const PUNCT = /[\s、。！？!?,.，「」『』（）()…・〜~：:；;]/;

function scriptOf(ch: string): 'hira' | 'kata' | 'kanji' | 'punct' | 'other' {
  if (PUNCT.test(ch)) return 'punct';
  if (/[\u3041-\u309F]/.test(ch)) return 'hira';
  if (/[\u30A0-\u30FFー]/.test(ch)) return 'kata';
  if (/[\u3400-\u9FFF々〆]/.test(ch)) return 'kanji';
  return 'other';
}

/** Token boundaries (char offsets in plain text) from sequential surface matching. */
export function tokenSpans(plain: string, tokens: LexToken[] | undefined): Array<{ start: number; end: number; token: LexToken }> {
  const spans: Array<{ start: number; end: number; token: LexToken }> = [];
  if (!tokens?.length) return spans;
  let cursor = 0;
  for (const t of tokens) {
    if (typeof t.start === 'number' && typeof t.end === 'number' && t.end > t.start) {
      spans.push({ start: t.start, end: t.end, token: t });
      cursor = t.end;
      continue;
    }
    if (!t.surface) continue;
    const idx = plain.indexOf(t.surface, cursor);
    if (idx < 0) {
      // Out-of-order token (e.g. merged from the sentence analysis): match its first occurrence, keep the cursor.
      const any = plain.indexOf(t.surface);
      if (any >= 0) spans.push({ start: any, end: any + t.surface.length, token: t });
      continue;
    }
    spans.push({ start: idx, end: idx + t.surface.length, token: t });
    cursor = idx + t.surface.length;
  }
  return spans;
}

/** Split ruby parts into tappable word units (never splitting an annotated base). */
export function toWordUnits(parts: RubyPart[], tokens?: LexToken[]): WordUnit[] {
  const plain = parts.map((p) => p.base).join('');
  const bounds = new Set<number>();
  for (const s of tokenSpans(plain, tokens)) {
    bounds.add(s.start);
    bounds.add(s.end);
  }
  const units: WordUnit[] = [];
  let off = 0;
  for (const p of parts) {
    const start = off;
    off += p.base.length;
    if (p.rt) {
      units.push({ base: p.base, rt: p.rt, start, end: off });
      continue;
    }
    let cur = '';
    let curStart = start;
    for (let i = 0; i < p.base.length; i++) {
      const ch = p.base[i];
      const abs = start + i;
      const brk = cur && (bounds.size ? bounds.has(abs) : scriptOf(ch) !== scriptOf(cur[cur.length - 1]) || scriptOf(ch) === 'punct');
      if (brk) {
        units.push({ base: cur, start: curStart, end: abs });
        cur = '';
        curStart = abs;
      }
      cur += ch;
    }
    if (cur) units.push({ base: cur, start: curStart, end: off });
  }
  return units;
}

/** Bundled tokens plus whole-sentence tokens whose surface is not already covered. */
export function mergeTokens(base: LexToken[] | undefined, extra: LexToken[] | undefined): LexToken[] {
  const b = base ?? [];
  if (!extra?.length) return b;
  const seen = new Set(b.map((t) => t.surface));
  return [...b, ...extra.filter((t) => t.surface && !seen.has(t.surface))];
}

/** Match a word (surface string) against a token list: exact surface first, then containment. */
function matchBySurface(base: string, tokens: LexToken[] | undefined): LexToken | undefined {
  const b = base.trim();
  if (!b || !tokens?.length) return undefined;
  return (
    tokens.find((t) => t.surface === b) ??
    tokens.find((t) => !!t.surface && t.surface.includes(b)) ??
    // Only let a longer tapped unit match a token of ≥2 chars (avoid single particles like は/が winning).
    tokens.find((t) => !!t.surface && t.surface.length >= 2 && b.includes(t.surface))
  );
}

/**
 * Resolve the token for a tapped word unit without any network: positional spans of `tokens` → surface match in
 * `tokens` → the whole-sentence analysis cache → the per-word cache.
 */
export function findToken(unit: WordUnit, plain: string, tokens?: LexToken[]): LexToken | undefined {
  return (
    tokenSpans(plain, tokens).find((s) => s.start <= unit.start && unit.start < s.end)?.token ??
    matchBySurface(unit.base, tokens) ??
    matchBySurface(unit.base, getCachedSentenceLex(plain)) ??
    getCachedLex(plain, unit.base)
  );
}

const LEX_CACHE_MAX = 512;
const lexCache = new Map<string, LexToken>();
const lexInflight = new Map<string, Promise<LexToken | null>>();

/** Whole-sentence analysis: every 意群 of a sentence, returned by `lexical.explain.result.tokens`. */
const SENTENCE_LEX_MAX = 128;
const SENTENCE_LEX_CACHE = new Map<string, LexToken[]>();
/** One in-flight `lexical.explain` per sentence: taps on other words of the same sentence share it. */
const INFLIGHT_SENTENCE = new Map<string, Promise<LexToken | null>>();

function lexCacheKey(text: string, token: string): string {
  return `${text.trim()}\u0000${token.trim()}`;
}

export function getCachedSentenceLex(sentence: string): LexToken[] | undefined {
  const key = sentence.trim();
  const hit = SENTENCE_LEX_CACHE.get(key);
  if (hit) {
    SENTENCE_LEX_CACHE.delete(key);
    SENTENCE_LEX_CACHE.set(key, hit);
  }
  return hit;
}

export function cacheSentenceLex(sentence: string, tokens: LexToken[]): void {
  const key = sentence.trim();
  const valid = (tokens ?? []).filter((t): t is LexToken => !!t && typeof t === 'object' && typeof t.surface === 'string' && !!t.surface.trim());
  if (!key || !valid.length) return;
  if (SENTENCE_LEX_CACHE.has(key)) SENTENCE_LEX_CACHE.delete(key);
  SENTENCE_LEX_CACHE.set(key, valid);
  while (SENTENCE_LEX_CACHE.size > SENTENCE_LEX_MAX) {
    const oldest = SENTENCE_LEX_CACHE.keys().next().value;
    if (oldest === undefined) break;
    SENTENCE_LEX_CACHE.delete(oldest);
  }
  for (const t of valid) setCachedLex(sentence, t.surface, t);
}

export function getCachedLex(text: string, token: string): LexToken | undefined {
  const key = lexCacheKey(text, token);
  const hit = lexCache.get(key);
  if (hit) {
    lexCache.delete(key);
    lexCache.set(key, hit);
  }
  return hit;
}

export function setCachedLex(text: string, token: string, value: LexToken): void {
  const keys = [lexCacheKey(text, token)];
  if (value.surface && value.surface.trim() && value.surface.trim() !== token.trim()) {
    keys.push(lexCacheKey(text, value.surface));
  }
  for (const key of keys) {
    if (lexCache.has(key)) lexCache.delete(key);
    lexCache.set(key, value);
    while (lexCache.size > LEX_CACHE_MAX) {
      const oldest = lexCache.keys().next().value;
      if (oldest === undefined) break;
      lexCache.delete(oldest);
    }
  }
}

function cachedWord(text: string, token: string): LexToken | undefined {
  return getCachedLex(text, token) ?? matchBySurface(token, getCachedSentenceLex(text));
}

/**
 * Explain `token` in `text` with caching. The fetcher is expected to store the whole-sentence analysis via
 * `cacheSentenceLex` when the engine returns it, so the next word of the same sentence resolves from memory.
 * A tap while another word of the same sentence is loading waits for that request instead of firing a new one.
 */
export async function explainLexCached(
  text: string,
  token: string,
  fetcher: (text: string, token: string) => Promise<LexToken | null>,
): Promise<LexToken | null> {
  const cached = cachedWord(text, token);
  if (cached) return cached;
  const key = lexCacheKey(text, token);
  const pending = lexInflight.get(key);
  if (pending) return pending;
  const sentKey = text.trim();
  const sentPending = INFLIGHT_SENTENCE.get(sentKey);
  if (sentPending) {
    await sentPending.catch(() => null);
    const hit = cachedWord(text, token);
    if (hit) return hit;
    const again = lexInflight.get(key);
    if (again) return again;
  }
  const box: { p?: Promise<LexToken | null> } = {};
  const p = (async () => {
    try {
      const res = await Promise.resolve().then(() => fetcher(text, token));
      if (res) setCachedLex(text, token, res);
      return res;
    } finally {
      lexInflight.delete(key);
      if (INFLIGHT_SENTENCE.get(sentKey) === box.p) INFLIGHT_SENTENCE.delete(sentKey);
    }
  })();
  box.p = p;
  lexInflight.set(key, p);
  if (!INFLIGHT_SENTENCE.has(sentKey)) INFLIGHT_SENTENCE.set(sentKey, p);
  return p;
}

export function clearLexCacheForTest(): void {
  lexCache.clear();
  lexInflight.clear();
  SENTENCE_LEX_CACHE.clear();
  INFLIGHT_SENTENCE.clear();
}

export interface BilingualCardProps {
  seg: BilingualSegment;
  resolveVoice: () => Promise<string | null>;
  /** Called when a word without a bundled token is tapped (→ `lexical.explain`). */
  explain: (text: string, token: string) => Promise<LexToken | null>;
  onWord?: (token: LexToken, sentence: string) => void;
  compact?: boolean;
  /** Mobile shows the breakdown inline; the desktop workbench shows it in the right column instead. */
  inlineLex?: boolean;
  /** Buffer the voice clip in the background even when it is only a history `ref` (latest rows). */
  preloadVoice?: boolean;
}

export function LexCard({ token, onClose }: { token: LexToken; onClose?: () => void }) {
  return (
    <div className="k-lex" role="region" aria-label="词汇与语法拆解">
      <div className="k-lex-head">
        <span className="k-lex-surface" lang="ja">
          {token.surface}
        </span>
        {token.reading && (
          <span className="k-lex-reading" lang="ja">
            {token.reading}
          </span>
        )}
        {token.pos && <span className="k-pill k-pill-accent k-pill-sm">{token.pos}</span>}
        {onClose && (
          <button type="button" className="k-lex-close" aria-label="收起" onClick={onClose}>
            ✕
          </button>
        )}
      </div>
      {token.gloss_zh && <div className="k-lex-gloss">{token.gloss_zh}</div>}
      <div className="k-lex-grid">
        {token.lemma && (
          <span>
            <b>原形</b> <span lang="ja">{token.lemma}</span>
          </span>
        )}
        {token.conj && (
          <span>
            <b>变形</b> {token.conj}
          </span>
        )}
      </div>
      {(token.textbook || token.colloquial) && (
        <div className="k-lex-dual">
          <div className="k-lex-col is-book">
            <span className="k-lex-tag">📘 教科书体</span>
            <span lang="ja">{token.textbook ?? '—'}</span>
          </div>
          <div className="k-lex-col is-live">
            <span className="k-lex-tag">🔥 口语约音</span>
            <span lang="ja">{token.colloquial ?? '—'}</span>
          </div>
        </div>
      )}
      {token.note ? (
        <div className="k-lex-note">
          <Markdown text={token.note} />
        </div>
      ) : (token as unknown as { explanation_markdown?: string }).explanation_markdown && !token.gloss_zh && !token.lemma && !token.conj ? (
        <div className="k-lex-note">
          <Markdown text={(token as unknown as { explanation_markdown: string }).explanation_markdown} />
        </div>
      ) : null}
    </div>
  );
}

/** Integrated bilingual card: real <ruby>, tap-to-play ▶ (never autoplay), tap-to-toggle 中文, tap-any-word breakdown. */
export function BilingualCard({ seg, resolveVoice, explain, onWord, compact, inlineLex = true, preloadVoice }: BilingualCardProps) {
  const entry = useStore(
    (s) =>
      (seg.voice?.placeholder_id ? s.media[seg.voice.placeholder_id] : undefined) ??
      (seg.voice?.ref ? s.media['ref:' + seg.voice.ref] : undefined),
  );
  const vPending = !!seg.voice?.placeholder_id && !seg.voice?.object && !seg.voice?.url && (entry?.status === 'pending' || (!entry && !seg.voice?.ref));
  const vFailed = entry?.status === 'failed';
  const readyKey = entry?.url || seg.voice?.object || seg.voice?.url || '';
  const parts = useMemo(() => resolveRubyParts(seg as never), [seg]);
  const plain = useMemo(() => parts.map((p) => p.base).join(''), [parts]);
  // Whole-sentence analysis (all 意群) once any word of this sentence has been explained.
  const [sentenceTokens, setSentenceTokens] = useState<LexToken[] | undefined>(() => getCachedSentenceLex(plain));
  const effectiveTokens = useMemo(() => mergeTokens(seg.tokens, sentenceTokens), [seg.tokens, sentenceTokens]);
  // Word boundaries: bundled tokens win; otherwise the sentence analysis; otherwise script heuristics.
  const units = useMemo(() => toWordUnits(parts, seg.tokens?.length ? seg.tokens : sentenceTokens), [parts, seg.tokens, sentenceTokens]);
  const [showZh, setShowZh] = useState(false);
  // Active word as a char offset (stable when the units are re-split by the sentence analysis).
  const [activeAt, setActiveAt] = useState<number | null>(null);
  const active = useMemo(() => {
    if (activeAt === null) return null;
    const idx = units.findIndex((u) => u.start <= activeAt && activeAt < u.end);
    return idx >= 0 ? idx : null;
  }, [activeAt, units]);
  const [lex, setLex] = useState<LexToken | null>(null);
  const [loading, setLoading] = useState(false);
  const reqSeq = useRef(0);

  useEffect(() => {
    setSentenceTokens(getCachedSentenceLex(plain));
  }, [plain]);

  async function onPart(_p: RubyPart, i: number) {
    const seq = ++reqSeq.current;
    if (active === i) {
      setActiveAt(null);
      setLex(null);
      setLoading(false);
      return;
    }
    const u = units[i];
    setActiveAt(u.start);
    const t = findToken(u, plain, effectiveTokens);
    if (t) {
      // Zero RPC, zero spinner: the sentence (or this word) is already analysed.
      setLoading(false);
      setLex(t);
      onWord?.(t, plain);
      return;
    }
    setLoading(true);
    setLex({ surface: u.base, reading: u.rt });
    try {
      const r = await explainLexCached(plain, u.base, explain);
      const whole = getCachedSentenceLex(plain);
      if (whole) setSentenceTokens(whole);
      if (seq !== reqSeq.current) return; // the user already tapped another word
      if (r) {
        setLex(r);
        onWord?.(r, plain);
      }
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  const hasVoice = !!seg.voice && !!(seg.voice.placeholder_id || seg.voice.object || seg.voice.ref || seg.voice.url);
  return (
    <div className={'k-bi' + (compact ? ' is-compact' : '')} onClick={() => activeAt !== null && (setActiveAt(null), setLex(null))}>
      <div className="k-bi-head">
        {seg.speaker && <span className="k-bi-speaker">{seg.speaker}</span>}
        <span className="k-bi-spacer" />
        {hasVoice && (
          <VoicePill
            resolveUrl={resolveVoice}
            pending={vPending}
            failed={vFailed}
            preload={!vPending && !vFailed && Boolean(readyKey || preloadVoice)}
            preloadKey={readyKey || seg.voice?.ref || ''}
            durationMs={seg.voice?.duration_ms ?? entry?.duration_ms}
          />
        )}
      </div>
      <div className="k-bi-ja">
        <RubyText parts={units} onPartClick={onPart} activeIndex={active} />
      </div>
      {seg.zh && (
        <button
          type="button"
          className={'k-bi-zh' + (showZh ? ' is-open' : '')}
          aria-expanded={showZh}
          onClick={(e) => {
            e.stopPropagation();
            setShowZh((v) => !v);
          }}
        >
          {seg.zh}
        </button>
      )}
      {lex && inlineLex && (
        <div onClick={(e) => e.stopPropagation()}>
          <LexCard token={lex} onClose={() => (setActiveAt(null), setLex(null))} />
          {loading && <div className="k-lex-loading">精讲生成中…</div>}
        </div>
      )}
    </div>
  );
}

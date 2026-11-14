import { useMemo, useState } from 'react';
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
    if (idx < 0) continue;
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

export function findToken(unit: WordUnit, plain: string, tokens?: LexToken[]): LexToken | undefined {
  return tokenSpans(plain, tokens).find((s) => s.start <= unit.start && unit.start < s.end)?.token;
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
  const units = useMemo(() => toWordUnits(parts, seg.tokens), [parts, seg.tokens]);
  const [showZh, setShowZh] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const [lex, setLex] = useState<LexToken | null>(null);
  const [loading, setLoading] = useState(false);

  async function onPart(_p: RubyPart, i: number) {
    if (active === i) {
      setActive(null);
      setLex(null);
      return;
    }
    setActive(i);
    const u = units[i];
    const t = findToken(u, plain, seg.tokens);
    if (t) {
      setLex(t);
      onWord?.(t, plain);
      return;
    }
    setLoading(true);
    setLex({ surface: u.base, reading: u.rt });
    try {
      const r = await explain(plain, u.base);
      if (r) {
        setLex(r);
        onWord?.(r, plain);
      }
    } finally {
      setLoading(false);
    }
  }

  const hasVoice = !!seg.voice && !!(seg.voice.placeholder_id || seg.voice.object || seg.voice.ref || seg.voice.url);
  return (
    <div className={'k-bi' + (compact ? ' is-compact' : '')} onClick={() => active !== null && (setActive(null), setLex(null))}>
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
          <LexCard token={lex} onClose={() => (setActive(null), setLex(null))} />
          {loading && <div className="k-lex-loading">精讲生成中…</div>}
        </div>
      )}
    </div>
  );
}

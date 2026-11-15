import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { LexToken } from '@kesoku/protocol';
import { RubyText, Sheet, VoicePill, resolveRubyParts, type RubyPart, type RubySpecInput } from '@kesoku/ui';
import { LexCard, explainLexCached, findToken, getCachedSentenceLex, mergeTokens, toWordUnits } from '../segments/BilingualCard';
import type { CardContext } from './types';
import { bboxPosition, cardMedia, hasKana, isObj, num, photoRef, pick, toBBox, useImageUrl, type BBox, type Dict } from './util';

/** Card shell: rounded card with an optional compact header row. */
export function CardShell({
  kind,
  className,
  head,
  children,
  tone,
}: {
  kind: string;
  className?: string;
  head?: ReactNode;
  children: ReactNode;
  tone?: 'ok' | 'danger' | 'warn' | 'accent' | 'mode';
}) {
  return (
    <section className={['kc-card', `kc-${kind}`, tone ? `kc-tone-${tone}` : '', className].filter(Boolean).join(' ')} data-card-kind={kind}>
      {head && <header className="kc-head">{head}</header>}
      {children}
    </section>
  );
}

function isJapanese(text: string, lang: string | undefined, ruby: unknown, rubyParts: unknown): boolean {
  if (lang) {
    const l = lang.toLowerCase();
    return l.startsWith('ja') || lang === '日语' || lang === '日本語';
  }
  return hasKana(text) || hasKana(typeof ruby === 'string' ? ruby : '') || ruby != null || Array.isArray(rubyParts);
}

const KANJI_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff々〆ヶ]/;
const KANA_ONLY_RE = /^[\u3041-\u309f\u30a0-\u30ffー・\s]+$/;

/**
 * Japanese line whose words are tappable (same flow as `BilingualCard`): bundled `tokens` → whole-sentence cache →
 * `lexical.explain`, with the `LexCard` breakdown shown right under the line. Words the model left without furigana
 * get the reading from a matching analysed token.
 */
function InteractiveJa({ parts, className, ctx, tokens }: { parts: RubyPart[]; className?: string; ctx: CardContext; tokens?: LexToken[] }) {
  const plain = useMemo(() => parts.map((p) => p.base).join(''), [parts]);
  const [sentenceTokens, setSentenceTokens] = useState<LexToken[] | undefined>(() => getCachedSentenceLex(plain));
  useEffect(() => setSentenceTokens(getCachedSentenceLex(plain)), [plain]);
  const effective = useMemo(() => mergeTokens(tokens, sentenceTokens), [tokens, sentenceTokens]);
  const units = useMemo(() => {
    const base = toWordUnits(parts, tokens?.length ? tokens : sentenceTokens);
    return base.map((u) => {
      if (u.rt || !KANJI_RE.test(u.base)) return u;
      const t = findToken(u, plain, effective);
      const reading = t?.reading?.trim();
      return reading && reading !== u.base && KANA_ONLY_RE.test(reading) && t?.surface === u.base ? { ...u, rt: reading } : u;
    });
  }, [parts, tokens, sentenceTokens, plain, effective]);
  const [activeAt, setActiveAt] = useState<number | null>(null);
  const [lex, setLex] = useState<LexToken | null>(null);
  const [loading, setLoading] = useState(false);
  const seqRef = useRef(0);
  const active = activeAt === null ? null : units.findIndex((u) => u.start <= activeAt && activeAt < u.end);
  const close = () => {
    seqRef.current++;
    setActiveAt(null);
    setLex(null);
    setLoading(false);
  };
  const onPart = async (_p: RubyPart, i: number) => {
    if (active === i) return close();
    const seq = ++seqRef.current;
    const u = units[i];
    setActiveAt(u.start);
    const hit = findToken(u, plain, effective);
    if (hit) {
      setLoading(false);
      setLex(hit);
      ctx.onWord?.(hit, plain);
      return;
    }
    setLoading(true);
    setLex({ surface: u.base, reading: u.rt });
    try {
      const r = await explainLexCached(plain, u.base, (text, token) => ctx.explain!(text, token));
      const whole = getCachedSentenceLex(plain);
      if (whole) setSentenceTokens(whole);
      if (seq !== seqRef.current) return;
      if (r) {
        setLex(r);
        ctx.onWord?.(r, plain);
      }
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  };
  return (
    <>
      <RubyText parts={units} className={className} onPartClick={(p, i) => void onPart(p, i)} activeIndex={active !== null && active >= 0 ? active : null} />
      {lex && (
        <div className="kc-tr-lex" onClick={(e) => e.stopPropagation()}>
          <LexCard token={lex} onClose={close} />
          {loading && <div className="k-lex-loading">精讲生成中…</div>}
        </div>
      )}
    </>
  );
}

/**
 * Japanese (or any) line with optional ruby. Accepts `{text, ruby?, ruby_parts?}`; `漢字(かな)`, `{漢字|かな}` and
 * `<ruby>漢字<rt>かな</rt></ruby>` are parsed. Non-Japanese text renders as a plain span. With `interactive` and a
 * card context that can `explain`, every Japanese word is tappable for the AI lexical breakdown.
 */
export function Ja({
  text,
  ruby,
  rubyParts,
  className,
  lang,
  interactive,
  ctx,
  tokens,
}: {
  text: string;
  ruby?: unknown;
  rubyParts?: unknown;
  className?: string;
  lang?: string;
  interactive?: boolean;
  ctx?: CardContext;
  tokens?: unknown;
}) {
  if (!text) return null;
  if (!isJapanese(text, lang, ruby, rubyParts)) return <span className={className}>{text}</span>;
  const parts = resolveRubyParts({
    ja: text,
    ruby: (ruby ?? undefined) as RubySpecInput,
    ruby_parts: Array.isArray(rubyParts) ? (rubyParts as Array<{ base: string; rt?: string }>) : undefined,
  });
  if (interactive && ctx?.explain) {
    const toks = Array.isArray(tokens) ? (tokens.filter((t) => isObj(t) && typeof t.surface === 'string') as unknown as LexToken[]) : undefined;
    return <InteractiveJa parts={parts} className={className} ctx={ctx} tokens={toks} />;
  }
  return <RubyText parts={parts} className={className} />;
}

/** A `{ja|text, ruby?, zh?, voice?}` line object (or a plain string). */
export interface LineLike {
  text: string;
  ruby?: unknown;
  rubyParts?: unknown;
  zh: string;
  voice: Dict | null;
  tag: string;
}

export function toLine(v: unknown): LineLike | null {
  if (typeof v === 'string') return v.trim() ? { text: v.trim(), zh: '', voice: null, tag: '' } : null;
  if (!isObj(v)) return null;
  const text = pick(v, 'ja', 'text', 'jp', 'sentence', 'source', 'local');
  if (!text) return null;
  const voice = isObj(v.voice) ? v.voice : null;
  return {
    text,
    ruby: v.ruby,
    rubyParts: v.ruby_parts,
    zh: pick(v, 'zh', 'translation', 'meaning', 'note_zh'),
    voice,
    tag: pick(v, 'tag', 'scene', 'label', 'register'),
  };
}

/** Tap-only voice pill for a line's voice ref (rendered only when a ref is present). */
export function LineVoice({ voice, ctx }: { voice: Dict | null; ctx: CardContext }) {
  if (!voice) return null;
  const ref = cardMedia({}, [], voice);
  if (!ref) return null;
  const dur = num(voice.duration_ms);
  return <VoicePill resolveUrl={() => ctx.resolveMedia(ref)} durationMs={dur ?? undefined} label="▶" />;
}

/** `[第N张图 · 右上 🔍]` badge → opens the photo locator. */
export function PhotoTag({
  n,
  bbox,
  position,
  data,
  ctx,
  zoom = true,
}: {
  n: number | null;
  bbox: unknown;
  position?: string;
  data: Dict;
  ctx: CardContext;
  zoom?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (n === null) return null;
  const b = toBBox(bbox);
  const pos = position || bboxPosition(b);
  const label = `第${n}张图${pos ? ` · ${pos}` : ''}`;
  if (!zoom) return <span className="kc-photo-tag">{label}</span>;
  return (
    <>
      <button
        type="button"
        className="kc-photo-tag is-btn"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        aria-label={`${label}，查看原图位置`}
      >
        {label} <span aria-hidden>🔍</span>
      </button>
      {open && <PhotoLocator n={n} bbox={b} label={label} data={data} ctx={ctx} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Modal with the original menu photo and a highlight box at the normalized bbox. */
export function PhotoLocator({
  n,
  bbox,
  label,
  data,
  ctx,
  onClose,
}: {
  n: number;
  bbox: BBox | null;
  label: string;
  data: Dict;
  ctx: CardContext;
  onClose: () => void;
}) {
  const ref = photoRef(ctx, data, n);
  const url = useImageUrl(ctx.resolveMedia, ref);
  return (
    <Sheet open onClose={onClose} title={label} height="full" className="kc-locator-sheet">
      <div className="kc-locator">
        {url ? (
          <div className="kc-locator-frame">
            <img src={url} alt={label} draggable={false} />
            {bbox && (
              <span
                className="kc-locator-box"
                data-testid="photo-bbox"
                style={{ left: `${bbox[0] * 100}%`, top: `${bbox[1] * 100}%`, width: `${bbox[2] * 100}%`, height: `${bbox[3] * 100}%` }}
              />
            )}
          </div>
        ) : (
          <div className="kc-locator-empty">{url === undefined && ref ? '原图加载中…' : '原图不可用'}</div>
        )}
      </div>
    </Sheet>
  );
}

/** Collapsible `▸ title` section (plain button + region). */
export function Fold({ title, children, defaultOpen = false, className }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={['kc-fold', open ? 'is-open' : '', className].filter(Boolean).join(' ')}>
      <button type="button" className="kc-fold-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="kc-fold-caret" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        {title}
      </button>
      {open && <div className="kc-fold-body">{children}</div>}
    </div>
  );
}


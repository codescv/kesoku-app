import { useState, type ReactNode } from 'react';
import { RubyText, Sheet, VoicePill, resolveRubyParts, type RubySpecInput } from '@kesoku/ui';
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

/**
 * Japanese (or any) line with optional ruby. Accepts `{text, ruby?, ruby_parts?}`; strings containing
 * `漢字(かな)` notation are parsed. Non-Japanese text renders as a plain span.
 */
export function Ja({
  text,
  ruby,
  rubyParts,
  className,
  lang,
}: {
  text: string;
  ruby?: unknown;
  rubyParts?: unknown;
  className?: string;
  lang?: string;
}) {
  if (!text) return null;
  const isJa = lang ? lang.startsWith('ja') : hasKana(text) || ruby != null || Array.isArray(rubyParts);
  if (!isJa) return <span className={className}>{text}</span>;
  const parts = resolveRubyParts({
    ja: text,
    ruby: (ruby ?? undefined) as RubySpecInput,
    ruby_parts: Array.isArray(rubyParts) ? (rubyParts as Array<{ base: string; rt?: string }>) : undefined,
  });
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


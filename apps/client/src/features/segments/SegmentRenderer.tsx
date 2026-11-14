import { useEffect, useRef, useState } from 'react';
import type { CardSegment, DetailsSegment, FileSegment, LexToken, QuestionSegment, Segment } from '@kesoku/protocol';
import { Skeleton, VoicePill } from '@kesoku/ui';
import { BilingualCard } from './BilingualCard';
import { Markdown, renderInline } from './Markdown';
import { GenericCardSafe, getCard } from '../cards';
import type { CardContext } from '../cards/types';
import { actions, useStore } from '../../lib/store';
import { overlays } from '../session/overlays';

export interface SegmentEnv {
  ctx: CardContext;
  picked?: string[];
  onPick: (questionMessageId: string, choices: string[]) => void;
  explain: (text: string, token: string) => Promise<LexToken | null>;
  onWord?: (token: LexToken, sentence: string) => void;
  readOnly?: boolean;
  inlineLex?: boolean;
  /** Eagerly buffer voice clips of this row (the latest few rows when a session is opened from history). */
  preloadVoice?: boolean;
}

const STICKER_DIR = /(^|\/)stickers\//i;
const GIF_EXT = /\.gif$/i;

/** Chibi sticker / GIF media: rendered small inline, never as a full-width card or a galgame CG. */
export function isStickerMedia(media: { mime?: unknown; name?: unknown; ref?: unknown; object?: unknown; url?: unknown } | Record<string, unknown>): boolean {
  const seg = media as { mime?: unknown; name?: unknown; ref?: unknown; object?: unknown; url?: unknown };
  if (String(seg.mime ?? '').toLowerCase() === 'image/gif') return true;
  for (const v of [seg.ref, seg.name, seg.object, seg.url]) {
    if (typeof v !== 'string' || !v) continue;
    const path = v.split('?')[0];
    if (STICKER_DIR.test(path) || GIF_EXT.test(path)) return true;
  }
  return false;
}

function QuestionPills({ seg, env }: { seg: QuestionSegment; env: SegmentEnv }) {
  const [sel, setSel] = useState<string[]>([]);
  const picked = env.picked;
  const qid = seg.question_message_id ?? env.ctx.messageId;
  const disabled = !!picked?.length || env.readOnly;
  const max = seg.max ?? (seg.multi ? seg.choices.length : 1);
  return (
    <div className="k-q">
      {seg.prompt && <div className="k-q-prompt">{renderInline(seg.prompt, 'qp')}</div>}
      <div className="k-q-choices">
        {seg.choices.map((c, idx) => {
          const on = picked ? picked.includes(c) : sel.includes(c);
          return (
            <button
              key={c}
              type="button"
              className={'k-choice' + (on ? ' is-on' : '')}
              disabled={disabled}
              onClick={() => {
                if (!seg.multi) return env.onPick(qid, [c]);
                setSel((s) => (s.includes(c) ? s.filter((x) => x !== c) : s.length < max ? [...s, c] : s));
              }}
            >
              {renderInline(c, `qc-${idx}`)}
            </button>
          );
        })}
      </div>
      {seg.multi && !disabled && (
        <button type="button" className="k-choice-confirm" disabled={!sel.length} onClick={() => env.onPick(qid, sel)}>
          确认选择 ({sel.length}/{max})
        </button>
      )}
    </div>
  );
}

function DetailsBlock({ seg }: { seg: DetailsSegment }) {
  return (
    <details className="k-details">
      <summary>{seg.title}</summary>
      <Markdown text={seg.body_markdown} />
    </details>
  );
}

function isFreshEntryUrl(entry: { url?: string; expires_at?: number } | undefined): string | null {
  if (!entry?.url) return null;
  if (entry.expires_at && entry.expires_at > 1_000_000_000 && entry.expires_at - 30 <= Date.now() / 1000) return null;
  return entry.url;
}

/** Images: placeholder/object load when rendered; history `ref`-only media loads on tap or when scrolled into view. */
export function MediaImage({ seg, ctx, className, autoHydrate }: { seg: FileSegment; ctx: CardContext; className?: string; autoHydrate?: boolean }) {
  const sticker = isStickerMedia(seg);
  const refKey = seg.ref ? 'ref:' + seg.ref : undefined;
  const objKey = seg.object ? 'obj:' + seg.object : undefined;
  const entry = useStore(
    (s) =>
      (seg.placeholder_id ? s.media[seg.placeholder_id] : undefined) ??
      (objKey ? s.media[objKey] : undefined) ??
      (refKey ? s.media[refKey] : undefined),
  );
  const freshEntryUrl = isFreshEntryUrl(entry);
  const [url, setUrl] = useState<string | null>(seg.url ?? freshEntryUrl ?? null);
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [imgLoaded, setImgLoaded] = useState(false);
  const [inView, setInView] = useState(Boolean(autoHydrate));
  const tapBtnRef = useRef<HTMLButtonElement | null>(null);
  const retryCountRef = useRef(0);
  const lazyOnly = !inView && !autoHydrate && !seg.placeholder_id && !seg.object && !seg.url && !freshEntryUrl && !!seg.ref;

  useEffect(() => {
    if (inView || autoHydrate || !tapBtnRef.current || typeof IntersectionObserver === 'undefined') return;
    const el = tapBtnRef.current;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          obs.disconnect();
        }
      },
      { rootMargin: '320px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [inView, autoHydrate]);

  useEffect(() => {
    if (freshEntryUrl && !url) {
      setUrl(freshEntryUrl);
      setState('idle');
      return;
    }
    if (lazyOnly || url) return;
    if (entry?.status === 'failed') return setState('failed');
    if (seg.placeholder_id && entry?.status !== 'ready' && !seg.object && !seg.ref) return;
    let alive = true;
    setState('loading');
    ctx.resolveMedia({ placeholder_id: seg.placeholder_id, object: seg.object ?? entry?.object, ref: seg.ref }).then(
      (u) => alive && (u ? (setUrl(u), setState('idle')) : setState('failed')),
      () => alive && setState('failed'),
    );
    return () => {
      alive = false;
    };
  }, [entry?.status, entry?.object, freshEntryUrl, seg.placeholder_id, seg.object, seg.ref, lazyOnly, url, ctx]);

  function retryLoad() {
    const curMedia = useStore.getState().media;
    for (const k of [seg.placeholder_id, objKey, refKey, entry?.object ? 'obj:' + entry.object : undefined]) {
      if (k && curMedia[k]?.url) {
        actions.setMedia(k, { ...curMedia[k], url: undefined });
      }
    }
    setImgLoaded(false);
    setUrl(null);
    setState('loading');
    ctx.resolveMedia({ placeholder_id: seg.placeholder_id, object: seg.object ?? entry?.object, ref: seg.ref }).then(
      (u) => (u ? (setUrl(u), setState('idle')) : setState('failed')),
      () => setState('failed'),
    );
  }

  if (entry?.status === 'failed' || state === 'failed') {
    const canRetry = Boolean(seg.ref || seg.object || entry?.object || seg.placeholder_id);
    return (
      <div className="k-media k-media-failed">
        <span>⚠️ 附件生成失败{entry?.reason ? ` · ${entry.reason}` : ''}</span>
        {canRetry && (
          <button
            type="button"
            className="k-btn k-btn-sm k-btn-ghost"
            style={{ marginLeft: 8 }}
            onClick={(e) => {
              e.stopPropagation();
              retryCountRef.current = 0;
              retryLoad();
            }}
          >
            重试
          </button>
        )}
      </div>
    );
  }
  if (url)
    return (
      <button
        type="button"
        className={['k-media', 'k-media-img', sticker && 'is-sticker', imgLoaded ? 'is-loaded' : 'is-loading', className].filter(Boolean).join(' ')}
        onClick={(e) => {
          e.stopPropagation();
          overlays.image(url);
        }}
        aria-label={sticker ? '查看表情' : '查看大图'}
      >
        <img
          src={url}
          alt={seg.name ?? (sticker ? '表情' : '图片')}
          onLoad={() => setImgLoaded(true)}
          onError={() => {
            if (retryCountRef.current < 1 && (seg.ref || seg.object || entry?.object || seg.placeholder_id)) {
              retryCountRef.current += 1;
              retryLoad();
            } else {
              setUrl(null);
              setState('failed');
            }
          }}
        />
      </button>
    );
  if (lazyOnly)
    return (
      <button
        ref={tapBtnRef}
        type="button"
        className={['k-media', 'k-media-tap', sticker && 'is-sticker', className].filter(Boolean).join(' ')}
        onClick={(e) => {
          e.stopPropagation();
          setInView(true);
          setState('loading');
          ctx.resolveMedia({ ref: seg.ref }).then((u) => (u ? setUrl(u) : setState('failed')), () => setState('failed'));
        }}
      >
        {state === 'loading' ? '载入中…' : sticker ? '🙂 表情' : '🖼 点开查看图片'}
      </button>
    );
  return <div className={['k-media', 'k-media-pending', sticker && 'is-sticker', className].filter(Boolean).join(' ')}>⏳ {entry?.label || (sticker ? '表情' : '附件生成中…')}</div>;
}

/** Compact inline sticker for narrative flows (galgame dialogue box). */
export function StickerThumb({ seg, ctx }: { seg: FileSegment; ctx: CardContext }) {
  return <MediaImage seg={seg} ctx={ctx} className="k-sticker-thumb" autoHydrate />;
}

/** Pending/failed/ready status of a voice clip, from the media placeholder store. */
export function useVoiceStatus(v: { placeholder_id?: string; object?: string; url?: string; ref?: string } | undefined, preloadVoice?: boolean) {
  const pid = v?.placeholder_id;
  const refKey = v?.ref ? 'ref:' + v.ref : undefined;
  const entry = useStore((s) => (pid ? s.media[pid] : undefined) ?? (refKey ? s.media[refKey] : undefined));
  const pending = !!pid && !v?.object && !v?.url && (entry?.status === 'pending' || (!entry && !v?.ref));
  const failed = entry?.status === 'failed';
  const readyKey = entry?.url || v?.object || v?.url || '';
  return {
    entry,
    pending,
    failed,
    preload: !pending && !failed && Boolean(readyKey || preloadVoice),
    preloadKey: readyKey || v?.ref || '',
  };
}

function VoiceSegment({ seg, ctx, preloadVoice }: { seg: FileSegment; ctx: CardContext; preloadVoice?: boolean }) {
  const st = useVoiceStatus(seg, preloadVoice);
  return (
    <div className="k-voice-row">
      <VoicePill
        pending={st.pending}
        failed={st.failed}
        preload={st.preload}
        preloadKey={st.preloadKey}
        durationMs={seg.duration_ms ?? st.entry?.duration_ms}
        resolveUrl={() => ctx.resolveMedia({ placeholder_id: seg.placeholder_id, object: seg.object, ref: seg.ref, url: seg.url })}
      />
    </div>
  );
}

function CardBlock({ seg, ctx }: { seg: CardSegment; ctx: CardContext }) {
  const Comp = getCard(seg.kind) ?? GenericCardSafe;
  const cardCtx = seg.media ? { ...ctx, media: seg.media } : ctx;
  return (
    <div className={`k-card-wrap k-card-${seg.kind}`}>
      <Comp data={seg.data} ctx={cardCtx} />
    </div>
  );
}

export function SegmentView({ seg, env }: { seg: Segment; env: SegmentEnv }) {
  switch (seg.type) {
    case 'text':
      return <Markdown text={seg.markdown} />;
    case 'bilingual':
      return (
        <BilingualCard
          seg={seg}
          explain={env.explain}
          onWord={env.onWord}
          inlineLex={env.inlineLex}
          preloadVoice={env.preloadVoice}
          resolveVoice={() => env.ctx.resolveMedia({ placeholder_id: seg.voice?.placeholder_id, object: seg.voice?.object, ref: seg.voice?.ref, url: seg.voice?.url })}
        />
      );
    case 'question':
      return <QuestionPills seg={seg} env={env} />;
    case 'details':
      return <DetailsBlock seg={seg} />;
    case 'file':
      return /^audio\//.test(seg.mime ?? '') ? (
        <VoiceSegment seg={seg} ctx={env.ctx} preloadVoice={env.preloadVoice} />
      ) : (
        <MediaImage seg={seg} ctx={env.ctx} autoHydrate={Boolean(env.preloadVoice)} />
      );
    case 'voice':
      return <VoiceSegment seg={seg} ctx={env.ctx} preloadVoice={env.preloadVoice} />;
    case 'card':
      return <CardBlock seg={seg} ctx={env.ctx} />;
    default:
      return null;
  }
}

export function SegmentList({ segments, env }: { segments: Segment[]; env: SegmentEnv }) {
  return (
    <div className="k-segs">
      {segments.map((s, i) => (
        <SegmentView key={i} seg={s} env={env} />
      ))}
    </div>
  );
}

export function CardSkeleton({ kind, title }: { kind?: string; title?: string }) {
  return (
    <div className="k-card-skel" data-kind={kind}>
      <div className="k-card-skel-title">{title || (kind ? `正在生成 ${kind} …` : '正在生成卡片…')}</div>
      <Skeleton lines={3} />
    </div>
  );
}

import { useEffect, useState } from 'react';
import type { CardSegment, DetailsSegment, FileSegment, LexToken, QuestionSegment, Segment } from '@kesoku/protocol';
import { Skeleton, VoicePill } from '@kesoku/ui';
import { BilingualCard } from './BilingualCard';
import { Markdown } from './Markdown';
import { GenericCardSafe, getCard } from '../cards';
import type { CardContext } from '../cards/types';
import { useStore } from '../../lib/store';
import { overlays } from '../session/overlays';

export interface SegmentEnv {
  ctx: CardContext;
  picked?: string[];
  onPick: (questionMessageId: string, choices: string[]) => void;
  explain: (text: string, token: string) => Promise<LexToken | null>;
  onWord?: (token: LexToken, sentence: string) => void;
  readOnly?: boolean;
  inlineLex?: boolean;
}

function QuestionPills({ seg, env }: { seg: QuestionSegment; env: SegmentEnv }) {
  const [sel, setSel] = useState<string[]>([]);
  const picked = env.picked;
  const qid = seg.question_message_id ?? env.ctx.messageId;
  const disabled = !!picked?.length || env.readOnly;
  const max = seg.max ?? (seg.multi ? seg.choices.length : 1);
  return (
    <div className="k-q">
      {seg.prompt && <div className="k-q-prompt">{seg.prompt}</div>}
      <div className="k-q-choices">
        {seg.choices.map((c) => {
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
              {c}
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

/** Images: placeholder/object load when rendered; history `ref`-only media loads on tap (media.hydrate). */
export function MediaImage({ seg, ctx }: { seg: FileSegment; ctx: CardContext }) {
  const entry = useStore((s) => (seg.placeholder_id ? s.media[seg.placeholder_id] : undefined));
  const [url, setUrl] = useState<string | null>(seg.url ?? null);
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const lazyOnly = !seg.placeholder_id && !seg.object && !seg.url && !!seg.ref;
  useEffect(() => {
    if (lazyOnly || url) return;
    if (entry?.status === 'failed') return setState('failed');
    if (seg.placeholder_id && entry?.status !== 'ready' && !seg.object) return;
    let alive = true;
    setState('loading');
    ctx.resolveMedia({ placeholder_id: seg.placeholder_id, object: seg.object, ref: seg.ref }).then(
      (u) => alive && (u ? (setUrl(u), setState('idle')) : setState('failed')),
      () => alive && setState('failed'),
    );
    return () => {
      alive = false;
    };
  }, [entry?.status, seg.placeholder_id, seg.object, seg.ref, lazyOnly, url, ctx]);

  if (entry?.status === 'failed' || state === 'failed') return <div className="k-media k-media-failed">⚠️ 附件生成失败{entry?.reason ? ` · ${entry.reason}` : ''}</div>;
  if (url)
    return (
      <button type="button" className="k-media k-media-img" onClick={() => overlays.image(url)} aria-label="查看大图">
        <img src={url} alt={seg.name ?? '图片'} loading="lazy" />
      </button>
    );
  if (lazyOnly)
    return (
      <button
        type="button"
        className="k-media k-media-tap"
        onClick={() => {
          setState('loading');
          ctx.resolveMedia({ ref: seg.ref }).then((u) => (u ? setUrl(u) : setState('failed')), () => setState('failed'));
        }}
      >
        {state === 'loading' ? '载入中…' : '🖼 点开查看图片'}
      </button>
    );
  return <div className="k-media k-media-pending">⏳ {entry?.label || '附件生成中…'}</div>;
}

function VoiceSegment({ seg, ctx }: { seg: FileSegment; ctx: CardContext }) {
  const entry = useStore((s) => (seg.placeholder_id ? s.media[seg.placeholder_id] : undefined));
  if (entry?.status === 'failed') return <div className="k-media k-media-failed">⚠️ 语音生成失败</div>;
  if (seg.placeholder_id && entry?.status === 'pending') return <div className="k-media k-media-pending">⏳ {entry.label || '语音生成中…'}</div>;
  return (
    <div className="k-voice-row">
      <VoicePill durationMs={seg.duration_ms ?? entry?.duration_ms} resolveUrl={() => ctx.resolveMedia({ placeholder_id: seg.placeholder_id, object: seg.object, ref: seg.ref, url: seg.url })} />
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
          resolveVoice={() => env.ctx.resolveMedia({ placeholder_id: seg.voice?.placeholder_id, object: seg.voice?.object, ref: seg.voice?.ref, url: seg.voice?.url })}
        />
      );
    case 'question':
      return <QuestionPills seg={seg} env={env} />;
    case 'details':
      return <DetailsBlock seg={seg} />;
    case 'file':
      return /^audio\//.test(seg.mime ?? '') ? <VoiceSegment seg={seg} ctx={env.ctx} /> : <MediaImage seg={seg} ctx={env.ctx} />;
    case 'voice':
      return <VoiceSegment seg={seg} ctx={env.ctx} />;
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

import { useEffect, useRef, useState } from 'react';
import type { CardSegment, ChoiceItem, DetailsSegment, FileSegment, LexToken, QuestionSegment, Segment } from '@kesoku/protocol';
import { Skeleton, UiIcon, VoicePill, useT } from '@kesoku/ui';
import { BilingualCard } from './BilingualCard';
import { CharacterPickerCard, hasCharacterPortraits } from './CharacterPickerCard';
import { Markdown, renderInline } from './Markdown';
import { GenericCardSafe, getCard } from '../cards';
import type { CardContext } from '../cards/types';
import { actions, useStore } from '../../lib/store';
import { buildMediaAliases, invalidateCachedImage, onMediaCacheClear, onMediaCacheRevoke } from '../../lib/mediaCache';
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
  const t = useT();
  const [sel, setSel] = useState<number[]>([]);
  const picked = env.picked;
  const qid = seg.question_message_id ?? env.ctx.messageId;
  useEffect(() => setSel([]), [qid]);
  const disabled = !!picked?.length || env.readOnly;
  // Rich-item-only questions (no plain `choices`) fall back to the item values as pills.
  const choices = seg.choices?.length ? seg.choices : (seg.choice_items ?? []).map((it) => it.value);
  const max = seg.max ?? (seg.multi ? choices.length : 1);
  if (picked?.length) {
    // Answered: the picked option is shown once as the user's own bubble right below — don't repeat it as a pill
    // (nor the portrait grid of a character picker).
    return seg.prompt ? (
      <div className="k-q is-answered">
        <div className="k-q-prompt">{renderInline(seg.prompt, 'qp')}</div>
      </div>
    ) : null;
  }
  if (hasCharacterPortraits(seg)) return <CharacterPickerCard seg={seg} qid={qid} ctx={env.ctx} onPick={env.onPick} disabled={disabled} />;

  const choiceItems = seg.choice_items ?? [];
  const itemByValue = new Map<string, ChoiceItem>();
  for (const it of choiceItems) {
    if (it?.value && !itemByValue.has(it.value)) itemByValue.set(it.value, it);
  }
  const entries = choices.map((value, idx) => {
    const posItem = choiceItems[idx];
    const item = posItem?.value === value ? posItem : itemByValue.get(value);
    return {
      idx,
      value,
      label: item?.name || value,
      subtitle: item?.subtitle?.trim() || '',
      group: (item?.group ?? '').trim(),
    };
  });

  const groupMap = new Map<string, typeof entries>();
  for (const entry of entries) {
    const bucket = groupMap.get(entry.group);
    if (bucket) bucket.push(entry);
    else groupMap.set(entry.group, [entry]);
  }
  const hasGroups = Array.from(groupMap.keys()).some((g) => g.length > 0);
  const sections = Array.from(groupMap.entries()).map(([group, items]) => ({ group, items }));
  const showMax = !hasGroups || seg.max !== undefined;

  function toggleChoice(idx: number) {
    const entry = entries[idx];
    if (!entry) return;
    if (!seg.multi) return env.onPick(qid, [entry.value]);
    setSel((s) => {
      if (s.includes(idx)) return s.filter((x) => x !== idx);
      if (entry.group) {
        const withoutGroup = s.filter((x) => entries[x]?.group !== entry.group);
        return withoutGroup.length < max ? [...withoutGroup, idx] : s;
      }
      return s.length < max ? [...s, idx] : s;
    });
  }

  function renderChoiceButton(entry: (typeof entries)[number]) {
    const on = sel.includes(entry.idx);
    return (
      <button
        key={entry.idx}
        type="button"
        className={'k-choice' + (on ? ' is-on' : '') + (entry.subtitle ? ' has-sub' : '')}
        disabled={disabled}
        aria-pressed={seg.multi ? on : undefined}
        onClick={() => toggleChoice(entry.idx)}
      >
        {entry.subtitle ? (
          <span className="k-choice-body">
            <span className="k-choice-title">{renderInline(entry.label, `qc-${entry.idx}`)}</span>
            <span className="k-choice-sub">{renderInline(entry.subtitle, `qcs-${entry.idx}`)}</span>
          </span>
        ) : (
          renderInline(entry.label, `qc-${entry.idx}`)
        )}
      </button>
    );
  }

  return (
    <div className={'k-q' + (hasGroups ? ' is-grouped' : '')}>
      {seg.prompt && <div className="k-q-prompt">{renderInline(seg.prompt, 'qp')}</div>}
      {hasGroups ? (
        <div className="k-q-groups">
          {sections.map((section, sIdx) => (
            <div
              key={section.group || `__ungrouped-${sIdx}`}
              className="k-q-group"
              role={section.group ? 'group' : undefined}
              aria-label={section.group || undefined}
            >
              {section.group && <div className="k-q-group-label">{renderInline(section.group, `qg-${sIdx}`)}</div>}
              <div className="k-q-choices">{section.items.map(renderChoiceButton)}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="k-q-choices">{entries.map(renderChoiceButton)}</div>
      )}
      {seg.multi && !disabled && (
        <button
          type="button"
          className="k-choice-confirm"
          disabled={!sel.length}
          onClick={() => env.onPick(qid, [...sel].sort((a, b) => a - b).map((idx) => entries[idx].value))}
        >
          {t('seg.confirmSelection', { count: sel.length, cap: showMax ? `/${max}` : '' })}
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
  const t = useT();
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
    if (!url?.startsWith('blob:')) return;
    const drop = () => {
      setImgLoaded(false);
      setUrl(null);
      setState('idle');
    };
    const offClear = onMediaCacheClear(drop);
    const offRevoke = onMediaCacheRevoke((revokedUrl) => {
      if (revokedUrl === url) drop();
    });
    return () => {
      offClear();
      offRevoke();
    };
  }, [url]);

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
    const aliases = buildMediaAliases({ object: seg.object ?? entry?.object, ref: seg.ref, sessionId: ctx.sessionId });
    setImgLoaded(false);
    setUrl(null);
    setState('loading');
    void invalidateCachedImage(aliases).finally(() => {
      ctx.resolveMedia({ placeholder_id: seg.placeholder_id, object: seg.object ?? entry?.object, ref: seg.ref }, { forceRefresh: true }).then(
        (u) => (u ? (setUrl(u), setState('idle')) : setState('failed')),
        () => setState('failed'),
      );
    });
  }

  if (entry?.status === 'failed' || state === 'failed') {
    const canRetry = Boolean(seg.ref || seg.object || entry?.object || seg.placeholder_id);
    return (
      <div className="k-media k-media-failed">
        <span className="k-ico-label">
          <UiIcon name="image" size={16} /> {t('seg.attachmentFailed', { reason: entry?.reason ? ` · ${entry.reason}` : '' })}
        </span>
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
            {t('common.retry')}
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
        aria-label={sticker ? t('common.viewSticker') : t('common.viewLargeImage')}
      >
        <img
          src={url}
          alt={seg.name ?? (sticker ? t('common.sticker') : t('common.image'))}
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
        {state === 'loading' ? (
          t('common.loading')
        ) : (
          <span className="k-ico-label">
            <UiIcon name={sticker ? 'sticker' : 'image'} size={16} /> {sticker ? t('common.sticker') : t('seg.tapToViewImage')}
          </span>
        )}
      </button>
    );
  return <div className={['k-media', 'k-media-pending', sticker && 'is-sticker', className].filter(Boolean).join(' ')}>
      <span className="k-ico-label">
        <UiIcon name="clock" size={16} /> {entry?.label || (sticker ? t('common.sticker') : t('stream.generatingAttachment'))}
      </span>
    </div>;
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
  const t = useT();
  return (
    <div className="k-card-skel" data-kind={kind}>
      <div className="k-card-skel-title">{title || (kind ? t('seg.generatingCardKind', { kind }) : t('seg.generatingCard'))}</div>
      <Skeleton lines={3} />
    </div>
  );
}

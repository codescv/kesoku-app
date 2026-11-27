import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, LexToken, MemoryProposal } from '@kesoku/protocol';
import { Avatar, ModeIcon, UiIcon, VoicePill, modeMeta, t as tGlobal, useLocale, useT, type MessageKey } from '@kesoku/ui';
import { kesoku } from '../../lib/client';
import { buildMediaAliases, getCachedImageUrl, onMediaCacheClear, onMediaCacheRevoke, peekCachedImageUrl } from '../../lib/mediaCache';
import { actions, useStore } from '../../lib/store';
import type { ChatItem, TurnEvent } from '../../lib/types';
import { SegmentList, type SegmentEnv } from '../segments/SegmentRenderer';
import { Markdown } from '../segments/Markdown';
import { StreamingPreview, ThinkingPill } from '../stream/StreamingPreview';
import { ProposalCard } from '../proposals/ProposalCard';
import { useAvatarUrl } from '../persona/avatar';
import { fallbackRoleId, roleAvatarRef, roleFallbackName } from '../persona/model';
import { makeCardContext } from './cardContext';
import { explainLexical } from '../../lib/lexical';
import { overlays } from './overlays';
import { useIsDesktop } from '../../app/useMedia';
import { splitUserQuote } from './SelectionQuote';

/** Format a message timestamp (`ts` in Unix seconds or ms) as `HH:mm`, `昨天 HH:mm`, `MM-DD HH:mm`, or `YYYY-MM-DD HH:mm`. */
export function formatMessageTime(ts: number | undefined, nowMs = Date.now()): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return '';
  const ms = ts > 1e11 ? ts : ts * 1000;
  const d = new Date(ms);
  const now = new Date(nowMs);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfMsgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfMsgDay) / 86_400_000);
  if (dayDiff === 0) return hhmm;
  if (dayDiff === 1) return tGlobal('common.yesterdayTime', { time: hhmm });
  if (d.getFullYear() === now.getFullYear()) return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hhmm}`;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hhmm}`;
}

function AssistantHeader({ roleId, fallbackName, ts }: { roleId: string; fallbackName: string; ts?: number }) {
  useLocale();
  const persona = useStore((s) => s.personas.find((p) => p.role_id === roleId));
  const src = useAvatarUrl(persona ? roleAvatarRef(persona) : null, persona?.avatar_rev);
  const displayName = persona?.display_name || fallbackName;
  const timeLabel = formatMessageTime(ts);
  return (
    <div className="k-assistant-head">
      <Avatar src={src} name={displayName} size={28} ai={persona?.avatar_ai} />
      <span className="k-assistant-name">{displayName}</span>
      {timeLabel && (
        <time className="k-msg-time" data-testid="msg-time">
          {timeLabel}
        </time>
      )}
    </div>
  );
}

const EMPTY_ITEMS: ChatItem[] = [];

/** Map proposals to the `key` of the chat row they render under (see MessageList). */
export function anchorProposals(items: ChatItem[], proposals: MemoryProposal[]): { m: Map<string, MemoryProposal[]>; tail: MemoryProposal[] } {
  const m = new Map<string, MemoryProposal[]>();
  const tail: MemoryProposal[] = [];
  const byMsg = new Map<string, ChatItem>();
  const replyByTurn = new Map<string, ChatItem>();
  for (const it of items) {
    if (it.message_id) byMsg.set(it.message_id, it);
    if (it.kind === 'assistant' && it.turn_id) replyByTurn.set(it.turn_id, it); // last reply of the turn wins
  }
  for (const p of proposals) {
    const target = p.message_id ? byMsg.get(p.message_id) : undefined;
    let anchor: ChatItem | undefined = p.turn_id ? (replyByTurn.get(p.turn_id) ?? byMsg.get(p.turn_id)) : undefined;
    if (!anchor && target?.kind === 'assistant') anchor = target;
    else if (!anchor && target?.kind === 'user') anchor = replyByTurn.get(target.message_id!) ?? target;
    else if (!anchor && p.message_id) anchor = replyByTurn.get(p.message_id);
    if (anchor) m.set(anchor.key, [...(m.get(anchor.key) ?? []), p]);
    else tail.push(p);
  }
  return { m, tail };
}

const STARTER_KEYS: Record<string, [MessageKey, MessageKey]> = {
  chat: ['starter.chat.0', 'starter.chat.1'],
  galgame: ['starter.galgame.0', 'starter.galgame.1'],
  travel_companion: ['starter.travel_companion.0', 'starter.travel_companion.1'],
  translator: ['starter.translator.0', 'starter.translator.1'],
  jp_classroom: ['starter.jp_classroom.0', 'starter.jp_classroom.1'],
  trpg: ['starter.trpg.0', 'starter.trpg.1'],
  pokemon_assistant: ['starter.pokemon_assistant.0', 'starter.pokemon_assistant.1'],
  story_theater: ['starter.story_theater.0', 'starter.story_theater.1'],
};

function ModeEmpty({ modeId, sessionId }: { modeId: string; sessionId: string }) {
  const locale = useLocale();
  const t = useT();
  const m = modeMeta(modeId, locale);
  const starters = (STARTER_KEYS[modeId] ?? STARTER_KEYS.chat).map((k) => t(k));
  return (
    <div className="k-mode-empty" style={{ ['--mode' as string]: m.color }}>
      <span className="k-mode-empty-icon" aria-hidden>
        <ModeIcon mode={m.id} size={56} />
      </span>
      <h2>{m.title}</h2>
      <p>{m.subtitle}</p>
      <div className="k-mode-empty-chips">
        {starters.map((text) => (
          <button key={text} type="button" className="k-choice" onClick={() => void kesoku.sendMessage(sessionId, text)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
const EMPTY_EVENTS: never[] = [];

const AUDIO_EXT_RE = /\.(m4a|webm|wav|mp3|ogg|oga|opus|aac|flac)$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|heic|heif|bmp|avif)$/i;

type AttachmentLike = Pick<Attachment, 'mime'> & { object?: string; ref?: string; filename?: string; url?: string; duration_ms?: number };

/** True for recorded voice / audio uploads (by MIME, or by file extension when the MIME is generic). */
export function isAudioAttachment(a: AttachmentLike): boolean {
  return !!a.mime?.toLowerCase().startsWith('audio/') || AUDIO_EXT_RE.test(a.filename || a.object || a.ref || '');
}

export function isImageAttachment(a: AttachmentLike): boolean {
  if (isAudioAttachment(a)) return false;
  return !!a.mime?.toLowerCase().startsWith('image/') || IMAGE_EXT_RE.test(a.filename || a.object || a.ref || '');
}

/** Rounded image thumbnail inside a user bubble with 0ms cache peek, lazy IO for old history, lightbox tap, and retry on error. */
export function UserImageThumb({
  a,
  index,
  sessionId,
  messageId,
  eager = true,
}: {
  a: AttachmentLike;
  index: number;
  sessionId: string;
  messageId?: string;
  eager?: boolean;
}) {
  const t = useT();
  const canResolve = !!(a.object || a.ref || a.url);
  const aliases = useMemo(
    () => buildMediaAliases({ object: a.object || undefined, ref: a.ref || undefined, sessionId }),
    [a.object, a.ref, sessionId],
  );
  const [url, setUrl] = useState<string | null>(() => a.url || (aliases.length ? peekCachedImageUrl(aliases) : null));
  const [imgLoaded, setImgLoaded] = useState(false);
  const [failed, setFailed] = useState(!canResolve);
  const [inView, setInView] = useState(() => Boolean(eager || url || typeof IntersectionObserver === 'undefined'));
  const [attempt, setAttempt] = useState(0);
  const retryCountRef = useRef(0);
  const forceNextRef = useRef(false);
  const hostRef = useRef<HTMLButtonElement | null>(null);

  // Drop revoked `blob:` URLs cleanly if the image cache is cleared or evicts this entry while mounted.
  useEffect(() => {
    if (!url?.startsWith('blob:')) return;
    const drop = () => {
      setImgLoaded(false);
      setUrl(null);
      setAttempt((n) => n + 1);
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

  // Sync reset when attachment identity changes.
  const attachKey = `${sessionId}|${a.object ?? ''}|${a.ref ?? ''}|${a.url ?? ''}`;
  const prevKeyRef = useRef(attachKey);
  if (prevKeyRef.current !== attachKey) {
    prevKeyRef.current = attachKey;
    retryCountRef.current = 0;
    forceNextRef.current = false;
  }

  // Even for offscreen older history items, check persistent IDB cache immediately (0 RPCs, 0 network).
  // Also link newly learned aliases (e.g., when server echoes `ref` alongside `object`) to the existing cached blob.
  useEffect(() => {
    if (!aliases.length) return;
    if (url) {
      if (url.startsWith('blob:')) peekCachedImageUrl(aliases);
      return;
    }
    let alive = true;
    void getCachedImageUrl(aliases).then((cached) => {
      if (alive && cached) {
        setUrl(cached);
        setFailed(false);
      }
    });
    return () => {
      alive = false;
    };
  }, [aliases, url]);

  // Lazy-load uncached offscreen older history thumbnails when scrolled near viewport.
  useEffect(() => {
    if (inView || url || failed || !canResolve || !hostRef.current || typeof IntersectionObserver === 'undefined') return;
    const el = hostRef.current;
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
  }, [inView, url, failed, canResolve]);

  useEffect(() => {
    if (!canResolve) {
      setFailed(true);
      return;
    }
    if (url || failed || !inView) return;
    const forceRefresh = forceNextRef.current;
    forceNextRef.current = false;
    let alive = true;
    void kesoku
      .resolveMedia(
        { object: a.object || undefined, ref: a.ref || undefined, url: a.url || undefined },
        { sessionId, messageId, mime: a.mime, kind: 'image', ...(forceRefresh ? { forceRefresh: true } : {}) },
      )
      .then(
        (resolved) => {
          if (!alive) return;
          if (resolved) {
            setUrl(resolved);
            setFailed(false);
          } else {
            setFailed(true);
          }
        },
        () => {
          if (alive) setFailed(true);
        },
      );
    return () => {
      alive = false;
    };
  }, [a.object, a.ref, a.url, a.mime, sessionId, messageId, canResolve, url, failed, inView, attempt]);

  const triggerForceRetry = () => {
    forceNextRef.current = true;
    setImgLoaded(false);
    setUrl(null);
    setFailed(false);
    setInView(true);
    setAttempt((n) => n + 1);
  };

  const handleImgError = () => {
    if (retryCountRef.current < 1 && canResolve) {
      retryCountRef.current += 1;
      triggerForceRetry();
    } else {
      setUrl(null);
      setFailed(true);
    }
  };

  const ariaLabel = t('common.viewImageN', { n: index + 1 });

  if (failed) {
    return (
      <button
        ref={hostRef}
        type="button"
        className="k-user-img k-user-img-error"
        disabled={!canResolve}
        aria-label={ariaLabel}
        onClick={(e) => {
          e.stopPropagation();
          retryCountRef.current = 0;
          triggerForceRetry();
        }}
      >
        <UiIcon name="image" size={18} />
        <span>{t('common.retry')}</span>
      </button>
    );
  }

  if (!url) {
    return (
      <button
        ref={hostRef}
        type="button"
        className="k-user-img k-user-img-loading"
        disabled
        aria-busy="true"
        aria-label={ariaLabel}
      >
        <span className="k-user-img-skel" aria-hidden />
      </button>
    );
  }

  return (
    <button
      ref={hostRef}
      type="button"
      className={'k-user-img' + (imgLoaded ? ' is-loaded' : ' is-loading')}
      aria-label={ariaLabel}
      onClick={(e) => {
        e.stopPropagation();
        overlays.image(url);
      }}
    >
      <img
        src={url}
        alt={a.filename || t('common.imageN', { n: index + 1 })}
        decoding="async"
        draggable={false}
        onLoad={() => setImgLoaded(true)}
        onError={handleImgError}
      />
    </button>
  );
}

/** One attachment item inside a user bubble: playable voice pill for audio, thumbnail for images, pill for other files. */
export function UserAttachmentItem({
  a,
  index,
  sessionId,
  messageId,
  eager = true,
}: {
  a: AttachmentLike;
  index: number;
  sessionId: string;
  messageId?: string;
  eager?: boolean;
}) {
  const t = useT();
  const resolve = () => kesoku.resolveMedia({ object: a.object || undefined, ref: a.ref || undefined, url: a.url || undefined }, { sessionId, messageId });
  if (isAudioAttachment(a)) {
    return (
      <VoicePill
        className="k-user-voice"
        resolveUrl={resolve}
        durationMs={typeof a.duration_ms === 'number' && a.duration_ms > 0 ? a.duration_ms : undefined}
        label={t('common.voice')}
        preloadKey={a.object || a.ref || ''}
      />
    );
  }
  if (isImageAttachment(a)) {
    return <UserImageThumb a={a} index={index} sessionId={sessionId} messageId={messageId} eager={eager} />;
  }
  return (
    <span className="k-pill k-pill-neutral k-pill-sm" title={a.filename}>
      📎 {a.filename || t('common.attachmentN', { n: index + 1 })}
    </span>
  );
}

function UserBubble({ item, sessionId, eager = true }: { item: ChatItem; sessionId: string; eager?: boolean }) {
  const t = useT();
  const timeLabel = formatMessageTime(item.ts);
  const { quote, reply } = splitUserQuote(item.text);
  const indexed = (item.attachments ?? []).map((a, index) => ({ a, index }));
  const imageAtts = indexed.filter(({ a }) => isImageAttachment(a));
  const otherAtts = indexed.filter(({ a }) => !isImageAttachment(a));
  const imgGridClass =
    imageAtts.length === 1
      ? 'k-user-imgs is-single'
      : imageAtts.length === 2 || imageAtts.length === 4
        ? 'k-user-imgs is-grid-2'
        : 'k-user-imgs is-grid-3';

  return (
    <div className={'k-row k-row-user' + (item.status === 'failed' ? ' is-failed' : '')}>
      <div className="k-bubble k-bubble-user">
        {quote && (
          <blockquote className="k-user-quote" data-testid="user-quote">
            {quote}
          </blockquote>
        )}
        {imageAtts.length > 0 && (
          <div className={imgGridClass} data-count={imageAtts.length}>
            {imageAtts.map(({ a, index }) => (
              <UserImageThumb key={a.object || a.ref || index} a={a} index={index} sessionId={sessionId} messageId={item.message_id} eager={eager} />
            ))}
          </div>
        )}
        {otherAtts.length > 0 && (
          <div className="k-attach-row">
            {otherAtts.map(({ a, index }) => (
              <UserAttachmentItem key={a.object || a.ref || index} a={a} index={index} sessionId={sessionId} messageId={item.message_id} eager={eager} />
            ))}
          </div>
        )}
        {reply && <div className="k-user-text">{reply}</div>}
        {item.status === 'sending' && <span className="k-sending" aria-label={t('msg.sendingAria')}>···</span>}
      </div>
      {timeLabel && item.status !== 'failed' && (
        <time className="k-msg-time k-msg-time-user" data-testid="msg-time">
          {timeLabel}
        </time>
      )}
      {item.status === 'failed' && (
        <button type="button" className="k-retry" onClick={() => void kesoku.retry(sessionId, item)}>
          {t('msg.failedRetry')}
        </button>
      )}
    </div>
  );
}

export function MessageList({
  sessionId,
  modeId,
  readOnly,
  onScrollDirection,
}: {
  sessionId: string;
  modeId: string;
  readOnly?: boolean;
  onScrollDirection?: (dir: 'up' | 'down' | 'top') => void;
}) {
  const t = useT();
  const items = useStore((s) => s.items[sessionId] ?? EMPTY_ITEMS);
  const preview = useStore((s) => s.previews[sessionId]);
  const turnEvents = useStore((s) => s.turnEvents);
  const proposalsAll = useStore((s) => s.proposals);
  const hasMore = useStore((s) => s.hasMoreHistory[sessionId]);
  const session = useStore((s) => s.sessions[sessionId]);
  const personas = useStore((s) => s.personas);
  const desktop = useIsDesktop();
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastScrollTop = useRef(0);
  const scrollAccum = useRef(0);

  const proposals = useMemo(() => Object.values(proposalsAll).filter((p) => p.session_id === sessionId), [proposalsAll, sessionId]);
  /**
   * Anchor each proposal under a chat row: the engine may reference the assistant message or the triggering
   * user message (whose id is the assistant turn's `turn_id`). Prefer the assistant reply of that turn; if it has
   * not arrived yet, show the card right after the user bubble; unknown ids go to the tail.
   */
  const byMessage = useMemo(() => anchorProposals(items, proposals), [proposals, items]);

  const explain = useCallback((text: string, token: string): Promise<LexToken | null> => explainLexical(sessionId, text, token), [sessionId]);
  const onWord = useCallback(
    (token: LexToken, sentence: string) => {
      if (desktop) actions.setUi({ inspector: { kind: 'word', token, sentence } });
    },
    [desktop],
  );
  const onPick = useCallback((qid: string, choices: string[]) => void kesoku.pick(sessionId, qid, choices), [sessionId]);

  const previewEvents = (preview && turnEvents[preview.turn_id]) || EMPTY_EVENTS;
  const previewThinking = Boolean(preview?.thought);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, preview?.text, !!preview, previewEvents.length, previewThinking, proposals.length]);

  useEffect(() => {
    stick.current = true;
    lastScrollTop.current = 0;
    scrollAccum.current = 0;
  }, [sessionId]);

  const persona = personas.find((p) => p.role_id === session?.role);
  const name = persona?.display_name ?? roleFallbackName(session?.role);
  const defaultRoleId = session?.role || fallbackRoleId(personas);
  const runningTool = preview && !preview.interrupted ? runningToolTitle(previewEvents) : undefined;

  return (
    <>
    <div
      className="k-stage-scroll"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        const top = Math.max(0, el.scrollTop);
        stick.current = el.scrollHeight - top - el.clientHeight < 80;
        if (onScrollDirection) {
          const prev = lastScrollTop.current;
          const dy = top - prev;
          lastScrollTop.current = top;
          const maxScroll = el.scrollHeight - el.clientHeight;
          const nearBottom = maxScroll > 0 && maxScroll - top < 24;
          if (top <= 12) {
            scrollAccum.current = 0;
            onScrollDirection('top');
          } else if (dy !== 0) {
            if ((dy > 0 && scrollAccum.current < 0) || (dy < 0 && scrollAccum.current > 0)) {
              scrollAccum.current = 0;
            }
            scrollAccum.current += dy;
            if (scrollAccum.current > 24 && top > 32) {
              scrollAccum.current = 0;
              onScrollDirection('down');
            } else if (!nearBottom && scrollAccum.current < -20) {
              scrollAccum.current = 0;
              onScrollDirection('up');
            }
          }
        }
      }}
    >
      <div className="k-stage-inner">
        {items.length === 0 && !preview && <ModeEmpty modeId={modeId} sessionId={sessionId} />}
        {hasMore && (
          <button type="button" className="k-load-older" onClick={() => void kesoku.loadOlder(sessionId)}>
            {t('msg.loadOlder')}
          </button>
        )}
        {items.map((item, idx) => {
          if (item.kind === 'user')
          return (
            <Fragment key={item.key}>
              <UserBubble item={item} sessionId={sessionId} eager={idx >= items.length - 12} />
              {byMessage.m.get(item.key)?.map((p) => <ProposalCard key={p.proposal_id} proposal={p} />)}
            </Fragment>
          );
          if (item.kind === 'system' || item.kind === 'error')
            return (
              <div key={item.key} className="k-row k-row-system">
                <Markdown text={item.text ?? ''} />
              </div>
            );
          let resolvedPicked = item.picked;
          if (!resolvedPicked?.length) {
            const nextUser = items.slice(idx + 1).find((it) => it.kind === 'user');
            if (nextUser) {
              const ut = (nextUser.text ?? '').trim();
              const pickMatch = /^(?:选择：|Selected:\s*|選択：)/.exec(ut);
              const multi = pickMatch ? ut.slice(pickMatch[0].length).split(/[；;]/).map((s) => s.trim()).filter(Boolean) : null;
              resolvedPicked = multi?.length ? multi : ut ? [ut] : ['__answered__'];
            }
          }
          const env: SegmentEnv = {
            ctx: makeCardContext(sessionId, item.message_id ?? item.key, modeId),
            picked: resolvedPicked,
            onPick,
            explain,
            onWord,
            readOnly,
            inlineLex: !desktop,
            preloadVoice: idx >= items.length - 12,
          };
          const evs = (item.turn_id && turnEvents[item.turn_id]) || EMPTY_EVENTS;
          const rowRoleId = item.sender?.role_id || defaultRoleId;
          return (
            <div key={item.key} className="k-row k-row-assistant">
              <div className="k-assistant-meta">
                <AssistantHeader roleId={rowRoleId} fallbackName={item.sender?.display_name ?? name} ts={item.ts} />
                <ThinkingPill events={evs} running={false} />
              </div>
              {item.segments?.length ? <SegmentList segments={item.segments} env={env} /> : item.text ? <Markdown text={item.text} /> : null}
              {byMessage.m.get(item.key)?.map((p) => <ProposalCard key={p.proposal_id} proposal={p} />) ?? null}
            </div>
          );
        })}
        {byMessage.tail.map((p) => (
          <ProposalCard key={p.proposal_id} proposal={p} />
        ))}
        {preview && (
          <div className="k-row k-row-assistant is-streaming">
            <div className="k-assistant-meta">
              <AssistantHeader roleId={defaultRoleId} fallbackName={name} />
              <ThinkingPill
                events={previewEvents}
                running={!preview.interrupted && (Boolean(preview.thought) || previewEvents.length > 0)}
                startedAt={preview.startedAt}
                thought={preview.thought}
              />
            </div>
            <StreamingPreview preview={preview} name={name} toolTitle={runningTool} />
          </div>
        )}
      </div>
    </div>
    </>
  );
}

/** Title of the latest tool call that has no result yet (shown as `正在执行 <tool>…`). */
export function runningToolTitle(events: readonly TurnEvent[]): string | undefined {
  const done = new Set(events.filter((e) => e.kind === 'tool_result').map((e) => (e as { tool_call_message_id?: string }).tool_call_message_id));
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === 'tool_call' && e.status === 'running' && !(e.message_id && done.has(e.message_id))) return e.title;
  }
  return undefined;
}

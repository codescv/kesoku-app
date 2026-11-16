import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { Attachment, LexToken, MemoryProposal } from '@kesoku/protocol';
import { Avatar, ModeIcon, UiIcon, VoicePill, modeMeta } from '@kesoku/ui';
import { kesoku } from '../../lib/client';
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
  if (dayDiff === 1) return `昨天 ${hhmm}`;
  if (d.getFullYear() === now.getFullYear()) return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hhmm}`;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hhmm}`;
}

function AssistantHeader({ roleId, fallbackName, ts }: { roleId: string; fallbackName: string; ts?: number }) {
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

const STARTERS: Record<string, string[]> = {
  chat: ['今天过得怎么样？', '教我一句地道的日语'],
  galgame: ['我们去江之岛海边吧', '约你去看烟花大会'],
  travel_companion: ['拍菜单照，帮我排雷', '帮我做一张问路大字卡'],
  translator: ['すみません、お会計お願いします', '我对荞麦过敏'],
  jp_classroom: ['开始今天的课程', '复习我的错题'],
  trpg: ['开一局赛博朋克跑团', '克苏鲁 · 阿卡姆调查'],
  pokemon_assistant: ['刚遇到失控超级快龙，弱什么？', '神速在 Z-A 里的冷却是多少？'],
  story_theater: ['继续下一片段', '回看上一段'],
};

function ModeEmpty({ modeId, sessionId }: { modeId: string; sessionId: string }) {
  const m = modeMeta(modeId);
  return (
    <div className="k-mode-empty" style={{ ['--mode' as string]: m.color }}>
      <span className="k-mode-empty-icon" aria-hidden>
        <ModeIcon mode={m.id} size={56} />
      </span>
      <h2>{m.title}</h2>
      <p>{m.subtitle}</p>
      <div className="k-mode-empty-chips">
        {(STARTERS[modeId] ?? STARTERS.chat).map((t) => (
          <button key={t} type="button" className="k-choice" onClick={() => void kesoku.sendMessage(sessionId, t)}>
            {t}
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

/** One attachment pill inside a user bubble: playable voice pill for audio, tap-to-open 图N for images. */
export function UserAttachmentItem({ a, index, sessionId, messageId }: { a: AttachmentLike; index: number; sessionId: string; messageId?: string }) {
  const resolve = () => kesoku.resolveMedia({ object: a.object || undefined, ref: a.ref || undefined, url: a.url || undefined }, { sessionId, messageId });
  if (isAudioAttachment(a)) {
    return (
      <VoicePill
        className="k-user-voice"
        resolveUrl={resolve}
        durationMs={typeof a.duration_ms === 'number' && a.duration_ms > 0 ? a.duration_ms : undefined}
        label="语音"
        preloadKey={a.object || a.ref || ''}
      />
    );
  }
  const canOpen = !!(a.object || a.ref || a.url);
  if (isImageAttachment(a)) {
    return (
      <button
        type="button"
        className="k-pill k-pill-neutral k-pill-sm"
        disabled={!canOpen}
        aria-label={`查看图${index + 1}`}
        onClick={(e) => {
          e.stopPropagation();
          void resolve().then((url) => url && overlays.image(url), () => undefined);
        }}
      >
        <UiIcon name="image" size={13} /> 图{index + 1}
      </button>
    );
  }
  return (
    <span className="k-pill k-pill-neutral k-pill-sm" title={a.filename}>
      📎 {a.filename || `附件${index + 1}`}
    </span>
  );
}

function UserBubble({ item, sessionId }: { item: ChatItem; sessionId: string }) {
  const timeLabel = formatMessageTime(item.ts);
  return (
    <div className={'k-row k-row-user' + (item.status === 'failed' ? ' is-failed' : '')}>
      <div className="k-bubble k-bubble-user">
        {item.attachments?.length ? (
          <div className="k-attach-row">
            {item.attachments.map((a, i) => (
              <UserAttachmentItem key={a.object || a.ref || i} a={a} index={i} sessionId={sessionId} messageId={item.message_id} />
            ))}
          </div>
        ) : null}
        {item.text && <div className="k-user-text">{item.text}</div>}
        {item.status === 'sending' && <span className="k-sending" aria-label="发送中">···</span>}
      </div>
      {timeLabel && item.status !== 'failed' && (
        <time className="k-msg-time k-msg-time-user" data-testid="msg-time">
          {timeLabel}
        </time>
      )}
      {item.status === 'failed' && (
        <button type="button" className="k-retry" onClick={() => void kesoku.retry(sessionId, item)}>
          未送达 · 点击重试
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
  const lastToggleAt = useRef(0);

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
          if (top <= 12) {
            scrollAccum.current = 0;
            onScrollDirection('top');
          } else if (dy !== 0) {
            if ((dy > 0 && scrollAccum.current < 0) || (dy < 0 && scrollAccum.current > 0)) {
              scrollAccum.current = 0;
            }
            scrollAccum.current += dy;
            const now = Date.now();
            const inCooldown = now - lastToggleAt.current < 220;
            if (scrollAccum.current > 24 && top > 32 && (!inCooldown || scrollAccum.current > 48)) {
              scrollAccum.current = 0;
              lastToggleAt.current = now;
              onScrollDirection('down');
            } else if (scrollAccum.current < -18 && (!inCooldown || scrollAccum.current < -48)) {
              scrollAccum.current = 0;
              lastToggleAt.current = now;
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
            加载更早的消息
          </button>
        )}
        {items.map((item, idx) => {
          if (item.kind === 'user')
          return (
            <Fragment key={item.key}>
              <UserBubble item={item} sessionId={sessionId} />
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
              const multi = ut.startsWith('选择：') ? ut.slice(3).split('；').map((s) => s.trim()).filter(Boolean) : null;
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

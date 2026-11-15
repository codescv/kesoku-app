import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { Attachment, EngineToClientPayload, LexToken, MemoryProposal } from '@kesoku/protocol';
import { Avatar, ModeIcon, UiIcon, VoicePill, modeMeta } from '@kesoku/ui';
import { kesoku } from '../../lib/client';
import { actions, useStore } from '../../lib/store';
import type { ChatItem } from '../../lib/types';
import { SegmentList, type SegmentEnv } from '../segments/SegmentRenderer';
import { cacheSentenceLex } from '../segments/BilingualCard';
import { Markdown } from '../segments/Markdown';
import { StreamingPreview, ThinkingPill } from '../stream/StreamingPreview';
import { ProposalCard } from '../proposals/ProposalCard';
import { useAvatarUrl } from '../persona/avatar';
import { fallbackRoleId, roleAvatarRef, roleFallbackName } from '../persona/model';
import { makeCardContext } from './cardContext';
import { overlays } from './overlays';
import { useIsDesktop } from '../../app/useMedia';

function AssistantHeader({ roleId, fallbackName }: { roleId: string; fallbackName: string }) {
  const persona = useStore((s) => s.personas.find((p) => p.role_id === roleId));
  const src = useAvatarUrl(persona ? roleAvatarRef(persona) : null, persona?.avatar_rev);
  const displayName = persona?.display_name || fallbackName;
  return (
    <div className="k-assistant-head">
      <Avatar src={src} name={displayName} size={28} ai={persona?.avatar_ai} />
      <span className="k-assistant-name">{displayName}</span>
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
      {item.status === 'failed' && (
        <button type="button" className="k-retry" onClick={() => void kesoku.retry(sessionId, item)}>
          未送达 · 点击重试
        </button>
      )}
    </div>
  );
}

export function MessageList({ sessionId, modeId, readOnly }: { sessionId: string; modeId: string; readOnly?: boolean }) {
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

  const proposals = useMemo(() => Object.values(proposalsAll).filter((p) => p.session_id === sessionId), [proposalsAll, sessionId]);
  /**
   * Anchor each proposal under a chat row: the engine may reference the assistant message or the triggering
   * user message (whose id is the assistant turn's `turn_id`). Prefer the assistant reply of that turn; if it has
   * not arrived yet, show the card right after the user bubble; unknown ids go to the tail.
   */
  const byMessage = useMemo(() => anchorProposals(items, proposals), [proposals, items]);

  const explain = useCallback(
    async (text: string, token: string): Promise<LexToken | null> => {
      try {
        const r = await kesoku.rpc<EngineToClientPayload<'lexical.explain.result'> & { explanation_markdown?: string }>(
          'lexical.explain',
          { session_id: sessionId, text, token },
          { timeoutMs: 30_000 },
        );
        const rawTok = (r as { token?: unknown }).token;
        // Whole-sentence analysis: cache every 意群 so the next word of this sentence needs no request.
        if (Array.isArray(r.tokens) && r.tokens.length > 0) cacheSentenceLex(text, r.tokens);
        if (rawTok && typeof rawTok === 'object') return rawTok as LexToken;
        const md = typeof r.explanation_markdown === 'string' ? r.explanation_markdown : typeof rawTok === 'string' ? rawTok : '';
        return { surface: token, note: md };
      } catch {
        actions.toast('精讲暂不可用', 'error');
        return null;
      }
    },
    [sessionId],
  );
  const onWord = useCallback(
    (token: LexToken, sentence: string) => {
      if (desktop) actions.setUi({ inspector: { kind: 'word', token, sentence } });
    },
    [desktop],
  );
  const onPick = useCallback((qid: string, choices: string[]) => void kesoku.pick(sessionId, qid, choices), [sessionId]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, preview?.text, proposals.length]);

  useEffect(() => {
    stick.current = true;
  }, [sessionId]);

  const persona = personas.find((p) => p.role_id === session?.role);
  const name = persona?.display_name ?? roleFallbackName(session?.role);
  const defaultRoleId = session?.role || fallbackRoleId(personas);

  return (
    <div
      className="k-stage-scroll"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
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
              <AssistantHeader roleId={rowRoleId} fallbackName={item.sender?.display_name ?? name} />
              <ThinkingPill events={evs} running={false} />
              {item.segments?.length ? <SegmentList segments={item.segments} env={env} /> : item.text ? <Markdown text={item.text} /> : null}
              {byMessage.m.get(item.key)?.map((p) => <ProposalCard key={p.proposal_id} proposal={p} />) ?? null}
            </div>
          );
        })}
        {byMessage.tail.map((p) => (
          <ProposalCard key={p.proposal_id} proposal={p} />
        ))}
        {preview && (preview.text || preview.thought || (turnEvents[preview.turn_id]?.length ?? 0) > 0) && (
          <div className="k-row k-row-assistant is-streaming">
            <AssistantHeader roleId={defaultRoleId} fallbackName={name} />
            <ThinkingPill events={turnEvents[preview.turn_id] ?? EMPTY_EVENTS} running={!preview.interrupted} startedAt={preview.startedAt} thought={preview.thought} />
            <StreamingPreview preview={preview} />
          </div>
        )}
      </div>
    </div>
  );
}

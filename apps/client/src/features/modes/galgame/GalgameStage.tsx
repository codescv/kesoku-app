import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from 'react';
import type { BilingualSegment, EngineToClientPayload, FileSegment, LexToken, MemoryPolicy, Segment } from '@kesoku/protocol';
import { PolicyBadge, SceneChips } from '@kesoku/hud';
import { RubyText, VoicePill, parseRubyNotation, resolveRubyParts, t as tGlobal, useT, type RubyPart } from '@kesoku/ui';
import type { ChatItem, StreamPreview } from '../../../lib/types';
import { kesoku } from '../../../lib/client';
import { useStore } from '../../../lib/store';
import type { CardContext, MediaRef } from '../../cards/types';
import { toMediaRef, useImageUrl } from '../../cards/util';
import { LexCard, cacheSentenceLex, explainLexCached, findToken, toWordUnits } from '../../segments/BilingualCard';
import { Markdown, renderInline } from '../../segments/Markdown';
import { CharacterPickerCard, hasCharacterPortraits } from '../../segments/CharacterPickerCard';
import { StickerThumb, isStickerMedia, useVoiceStatus } from '../../segments/SegmentRenderer';
import { parseStreaming } from '../../stream/streamParser';

export interface GalgameStageProps {
  items: ChatItem[];
  preview: StreamPreview | null;
  stateFiles: Record<string, unknown>;
  ctx: CardContext;
  policy: MemoryPolicy;
  onPolicyChange: (p: MemoryPolicy) => void;
  onPick: (questionMessageId: string, choices: string[]) => void;
  onExit: () => void;
  /** Full display name of the active role (from the live persona list); generic agent sender names are never shown. */
  personaName?: string;
}

type AnySeg = Segment & Record<string, unknown>;

const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|aac|opus|flac|mp4|webm|mov)(\?|$)/i;

function isImageSeg(s: AnySeg): boolean {
  if (s.type !== 'file') return false;
  const mime = typeof s.mime === 'string' ? s.mime : '';
  if (mime) return mime.startsWith('image/');
  const name = [s.name, s.object, s.ref, s.url].find((x) => typeof x === 'string') as string | undefined;
  return !name || !AUDIO_EXT.test(name);
}

type MediaStatusMap = Record<string, { status?: string } | undefined>;

/**
 * Latest CG: newest non-sticker image `file` segment of any assistant row. Stickers / GIFs never become
 * the CG, and a placeholder that is still generating (or failed) is skipped so the previous ready CG
 * (or the fallback backdrop) stays until the new one is ready.
 */
export function latestCg(items: ChatItem[], media?: MediaStatusMap): MediaRef | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== 'assistant' || !Array.isArray(it.segments)) continue;
    for (let j = it.segments.length - 1; j >= 0; j--) {
      const s = it.segments[j] as AnySeg;
      if (s && isImageSeg(s)) {
        if (isStickerMedia(s)) continue;
        const pid = typeof s.placeholder_id === 'string' ? s.placeholder_id : '';
        const st = pid ? media?.[pid]?.status : undefined;
        if (st === 'failed' || st === 'pending') continue;
        const ref = toMediaRef({ placeholder_id: s.placeholder_id, object: s.object, ref: s.ref, url: s.url });
        if (ref) return ref;
      }
    }
  }
  return null;
}

/** Generation status of the newest assistant turn's scene illustration (non-sticker image). */
export function pendingCgStatus(items: ChatItem[], media?: MediaStatusMap): 'pending' | 'failed' | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== 'assistant') continue;
    const segs = Array.isArray(it.segments) ? it.segments : [];
    for (let j = segs.length - 1; j >= 0; j--) {
      const s = segs[j] as AnySeg;
      if (!s || !isImageSeg(s) || isStickerMedia(s)) continue;
      const pid = typeof s.placeholder_id === 'string' ? s.placeholder_id : '';
      const st = pid ? media?.[pid]?.status : undefined;
      return st === 'pending' || st === 'failed' ? st : null;
    }
    return null;
  }
  return null;
}

type BilingualSeg = Extract<Segment, { type: 'bilingual' }>;
type QuestionSeg = Extract<Segment, { type: 'question' }>;
type StorySeg = Extract<Segment, { type: 'text' | 'bilingual' | 'file' }>;

function isStorySeg(s: Segment | undefined | null): s is StorySeg {
  if (!s) return false;
  if (s.type === 'text') return typeof s.markdown === 'string' && !!s.markdown.trim();
  if (s.type === 'bilingual') return typeof s.ja_plain === 'string';
  if (s.type === 'file') return isStickerMedia(s);
  return false;
}

/** Newest assistant turn with any story content: narration (`text`), dialogue (`bilingual`) or stickers. */
export function latestTurn(items: ChatItem[]): { item: ChatItem; segments: StorySeg[] } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== 'assistant' || !Array.isArray(it.segments)) continue;
    const segments = it.segments.filter(isStorySeg);
    if (segments.length) return { item: it, segments };
  }
  return null;
}

const GENERIC_NAMES = new Set(['kesoku', 'assistant']);

function nonGeneric(n: unknown): string | undefined {
  if (typeof n !== 'string') return undefined;
  const t = n.trim();
  return t && !GENERIC_NAMES.has(t.toLowerCase()) ? t : undefined;
}

/** Speaker: segment speaker → live persona name → sender display name → non-generic sender name → generic fallback. */
export function resolveSpeaker(segSpeaker: unknown, item: ChatItem | undefined, personaName?: string): string {
  return (
    nonGeneric(segSpeaker) ||
    nonGeneric(personaName) ||
    nonGeneric(item?.sender?.display_name) ||
    nonGeneric(item?.sender?.name) ||
    tGlobal('common.aiAssistant')
  );
}

/** Latest bilingual line (+ its row, for the speaker fallback). */
export function latestLine(items: ChatItem[]): { seg: BilingualSeg; item: ChatItem } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== 'assistant' || !Array.isArray(it.segments)) continue;
    for (let j = it.segments.length - 1; j >= 0; j--) {
      const s = it.segments[j];
      if (s && s.type === 'bilingual' && typeof s.ja_plain === 'string') return { seg: s, item: it };
    }
  }
  return null;
}

/** Open choices: the last question segment of the newest assistant row, unless already picked. */
export function openQuestion(items: ChatItem[]): { seg: QuestionSeg; id: string } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'user') return null; // the player already answered
    if (it.kind !== 'assistant') continue;
    if (it.picked && it.picked.length) return null;
    const segs = Array.isArray(it.segments) ? it.segments : [];
    for (let j = segs.length - 1; j >= 0; j--) {
      const s = segs[j];
      if (s && s.type === 'question' && ((Array.isArray(s.choices) && s.choices.length) || hasCharacterPortraits(s))) {
        const id = s.question_message_id || it.message_id || it.key;
        return { seg: s, id };
      }
    }
    return null;
  }
  return null;
}

/** Streaming preview → displayable line: the latest `ja:` value inside an open bilingual fence, else plain prose. */
export function previewLine(text: string): string {
  if (!text) return '';
  const fences = text.split('```');
  const inFence = fences.length % 2 === 0;
  if (inFence) {
    const body = fences[fences.length - 1];
    const ja = [...body.matchAll(/^\s*(?:ja|ja_plain)\s*:\s*["'「]?(.+?)["'」]?\s*$/gm)];
    if (ja.length) return ja[ja.length - 1][1];
  }
  // Keep only text outside complete fences; drop [file:…] tags.
  const prose = fences
    .filter((_, i) => i % 2 === 0)
    .join('\n')
    .replace(/\[file:[^\]]*\]/g, '')
    .trim();
  const paras = prose.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return paras[paras.length - 1] ?? '';
}

/** Reveal `target` progressively (resets when the text is replaced rather than extended). */
function useTypewriter(target: string, cps = 45): string {
  const [n, setN] = useState(0);
  const prev = useRef('');
  useEffect(() => {
    if (!target.startsWith(prev.current)) setN(0);
    prev.current = target;
  }, [target]);
  useEffect(() => {
    if (n >= target.length) return;
    const t = setTimeout(() => setN((x) => Math.min(target.length, x + Math.max(1, Math.ceil((target.length - x) / 30)))), 1000 / cps);
    return () => clearTimeout(t);
  }, [n, target, cps]);
  return target.slice(0, n);
}

/** Crossfading Ken Burns CG layers. */
function CgLayers({ url }: { url: string | null | undefined }) {
  const [layers, setLayers] = useState<string[]>([]);
  useEffect(() => {
    if (!url) return;
    setLayers((ls) => (ls[ls.length - 1] === url ? ls : [...ls.slice(-1), url]));
  }, [url]);
  if (!layers.length) return <div className="gg-cg-fallback" data-testid="gg-fallback" />;
  return (
    <>
      {layers.map((u, i) => (
        <img
          key={u}
          src={u}
          alt=""
          draggable={false}
          className={'gg-cg' + (i === layers.length - 1 ? ' is-top' : '')}
          data-testid="gg-cg"
          onAnimationEnd={(e) => {
            if (e.animationName === 'gg-xfade' && layers.length > 1) setLayers((ls) => ls.slice(-1));
          }}
        />
      ))}
    </>
  );
}

/** Tap-to-play voice for one dialogue line; synthesis status + background buffering (never autoplay). */
function SpeechVoice({ seg, ctx }: { seg: BilingualSegment; ctx: CardContext }) {
  const v = seg.voice;
  const st = useVoiceStatus(v, true);
  const ref = v ? toMediaRef(v) : null;
  if (!ref) return null;
  return (
    <VoicePill
      resolveUrl={() => ctx.resolveMedia(ref)}
      pending={st.pending}
      failed={st.failed}
      preload={!st.pending && !st.failed}
      preloadKey={st.preloadKey}
      durationMs={typeof v?.duration_ms === 'number' ? v.duration_ms : st.entry?.duration_ms}
    />
  );
}

function hasVoice(seg: BilingualSegment): boolean {
  const v = seg.voice;
  return !!v && !!(v.placeholder_id || v.object || v.ref || v.url);
}

function Speech({
  seg,
  ctx,
  speaker,
  showSpeaker,
  showVoice,
  zhOpen,
  onToggleZh,
  onOpenLex,
}: {
  seg: BilingualSegment;
  ctx: CardContext;
  speaker: string;
  showSpeaker: boolean;
  showVoice: boolean;
  zhOpen: boolean;
  onToggleZh: () => void;
  onOpenLex?: () => void;
}) {
  const t = useT();
  const parts = useMemo(() => resolveRubyParts(seg), [seg]);
  const plain = useMemo(() => parts.map((p) => p.base).join(''), [parts]);
  const units = useMemo(() => toWordUnits(parts, seg.tokens), [parts, seg.tokens]);
  const [active, setActive] = useState<number | null>(null);
  const [lex, setLex] = useState<LexToken | null>(null);
  const [loading, setLoading] = useState(false);
  const lexRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (lex && lexRef.current && typeof lexRef.current.scrollIntoView === 'function') {
      lexRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [lex]);

  async function onPart(_p: RubyPart, i: number) {
    if (active === i) {
      setActive(null);
      setLex(null);
      return;
    }
    setActive(i);
    onOpenLex?.();
    const u = units[i];
    const bundled = findToken(u, plain, seg.tokens);
    if (bundled) {
      setLex(bundled);
      return;
    }
    setLoading(true);
    setLex({ surface: u.base, reading: u.rt });
    try {
      const explained = await explainLexCached(plain, u.base, async (txt, tok) => {
        const r = await kesoku.rpc<EngineToClientPayload<'lexical.explain.result'> & { explanation_markdown?: string }>(
          'lexical.explain',
          { session_id: ctx.sessionId, text: txt, token: tok },
          { timeoutMs: 30_000 },
        );
        const rawTok = (r as { token?: unknown }).token;
        if (Array.isArray(r.tokens) && r.tokens.length > 0) cacheSentenceLex(txt, r.tokens);
        if (rawTok && typeof rawTok === 'object') return rawTok as LexToken;
        return { surface: u.base, reading: u.rt, note: typeof r.explanation_markdown === 'string' ? r.explanation_markdown : String(rawTok ?? '') };
      });
      if (explained) setLex(explained);
    } catch {
      /* keep surface/reading fallback */
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="gg-speech" onClick={() => active !== null && (setActive(null), setLex(null))}>
      {(showSpeaker || showVoice) && (
        <div className="gg-speech-head">
          {showSpeaker ? <span className="gg-speech-name">{speaker}</span> : <span />}
          {showVoice && <SpeechVoice seg={seg} ctx={ctx} />}
        </div>
      )}
      <div className="gg-line">
        <RubyText parts={units} onPartClick={onPart} activeIndex={active} />
      </div>
      {seg.zh && (
        <button
          type="button"
          className={'gg-zh' + (zhOpen ? '' : ' is-collapsed')}
          aria-expanded={zhOpen}
          onClick={(e) => {
            e.stopPropagation();
            onToggleZh();
          }}
        >
          {zhOpen ? seg.zh : t('galgame.zhToggle')}
        </button>
      )}
      {lex && (
        <div ref={lexRef} className="gg-lex" onClick={(e) => e.stopPropagation()}>
          <LexCard token={lex} onClose={() => (setActive(null), setLex(null))} />
          {loading && <div className="k-lex-loading">{t('seg.lexLoading')}</div>}
        </div>
      )}
    </div>
  );
}

function stripQuotes(s: string): string {
  return s.replace(/^[「『"']+/, '').replace(/[」』"']+$/, '');
}

/** Streaming body: every prose paragraph + open/closed dialogue lines, progressively (raw YAML never shown). */
function StreamingBody({ text, speaker }: { text: string; speaker: string }) {
  const blocks = useMemo(() => parseStreaming(text).filter((b) => (b.kind === 'text' ? !!b.text.trim() : b.kind === 'bilingual')), [text]);
  const last = blocks[blocks.length - 1];
  const lastText = !last ? '' : last.kind === 'text' ? last.text.trim() : last.kind === 'bilingual' ? stripQuotes(last.ja ?? '') : '';
  const typed = useTypewriter(lastText);
  return (
    <>
      {blocks.map((b, i) => {
        const isLast = i === blocks.length - 1;
        if (b.kind === 'text')
          return isLast ? (
            <div key={i} className="gg-narration is-typing">
              {typed}
              <span className="gg-caret" aria-hidden />
            </div>
          ) : (
            <div key={i} className="gg-narration">
              <Markdown text={b.text.trim()} />
            </div>
          );
        if (b.kind !== 'bilingual') return null;
        const ja = stripQuotes(b.ja ?? '');
        return (
          <div key={i} className="gg-speech">
            {b.speaker && b.speaker !== speaker && (
              <div className="gg-speech-head">
                <span className="gg-speech-name">{b.speaker}</span>
              </div>
            )}
            <div className={'gg-line' + (isLast ? ' is-typing' : '')} lang="ja">
              {isLast ? typed : <RubyText parts={parseRubyNotation(ja)} />}
              {isLast && <span className="gg-caret" aria-hidden />}
            </div>
            {b.closed && b.zh && <div className="gg-zh is-static">{b.zh}</div>}
          </div>
        );
      })}
    </>
  );
}

/**
 * Immersive visual-novel stage (Screen 04): full-bleed CG, top glass micro-pills, frosted dialogue box
 * with the whole scene (narration + dialogue + stickers, in order), floating choice pills.
 * Voice playback is strictly tap-to-play; clips are only buffered in the background.
 */
export function GalgameStage({ items, preview, stateFiles, ctx, policy, onPolicyChange, onPick, onExit, personaName }: GalgameStageProps) {
  const t = useT();
  const media = useStore((s) => s.media);
  const cgRef = useMemo(() => latestCg(items, media), [items, media]);
  const cgUrl = useImageUrl(ctx.resolveMedia, cgRef);
  const cgStatus = useMemo(() => pendingCgStatus(items, media), [items, media]);
  const turn = useMemo(() => latestTurn(items), [items]);
  const question = useMemo(() => openQuestion(items), [items]);
  const streamText = preview && !preview.interrupted && preview.text.trim() ? preview.text : '';
  const streaming = !!streamText;
  const isWaiting = !!preview && !preview.interrupted && !streamText;

  const [zhClosed, setZhClosed] = useState<Record<number, boolean>>({});
  const [expanded, setExpanded] = useState(false);
  const [uiHidden, setUiHidden] = useState(false);
  const [multi, setMulti] = useState<string[]>([]);
  const press = useRef<{ t: ReturnType<typeof setTimeout> | null; y: number | null }>({ t: null, y: null });

  useEffect(() => setMulti([]), [question?.id]);
  useEffect(() => setZhClosed({}), [turn?.item.key]);
  useEffect(() => () => {
    if (press.current.t) clearTimeout(press.current.t);
  }, []);

  const segs = turn?.segments ?? [];
  const speeches = segs.filter((s): s is BilingualSegment => s.type === 'bilingual');
  const firstSpeech = speeches[0];
  const speaker = resolveSpeaker(firstSpeech?.speaker, turn?.item, personaName);
  const roleName = resolveSpeaker(undefined, turn?.item, personaName);
  const voicedSpeeches = speeches.filter(hasVoice);
  const headerVoiceSeg =
    speeches.length === 1 && hasVoice(speeches[0])
      ? speeches[0]
      : voicedSpeeches.length === 1 && resolveSpeaker(voicedSpeeches[0].speaker, turn?.item, personaName) === speaker
        ? voicedSpeeches[0]
        : null;

  const startPress = (e: RPointerEvent) => {
    const el = e.target as HTMLElement | null;
    if (el && typeof el.closest === 'function' && el.closest('button, .gg-box, .gg-choices, .gg-cpick')) return;
    press.current.y = e.clientY;
    if (press.current.t) clearTimeout(press.current.t);
    press.current.t = setTimeout(() => setUiHidden(true), 600);
  };
  const endPress = (e: RPointerEvent) => {
    if (press.current.t) clearTimeout(press.current.t);
    press.current.t = null;
    const y = typeof e.clientY === 'number' ? e.clientY : null;
    if (press.current.y !== null && y !== null && press.current.y - y > 90) onExit(); // swipe up → bubble history
    press.current.y = null;
  };
  const onBoxClick = (e: RMouseEvent) => {
    const el = e.target as HTMLElement | null;
    if (el && typeof el.closest === 'function' && el.closest('button, a, ruby, rt, img, .k-voice')) return;
    setExpanded((x) => !x);
  };

  return (
    <div
      className={'gg-stage' + (uiHidden ? ' is-ui-hidden' : '')}
      data-testid="galgame-stage"
      onPointerDown={startPress}
      onPointerUp={endPress}
      onPointerCancel={endPress}
      onClick={() => uiHidden && setUiHidden(false)}
    >
      <div className="gg-cg-wrap" aria-hidden>
        <CgLayers url={cgUrl} />
        <div className="gg-vignette" />
      </div>

      <div className="gg-top">
        <button type="button" className="gg-glass gg-back" onClick={onExit} aria-label={t('galgame.backToBubblesAria')}>
          {t('galgame.backLabel', { name: roleName })}
        </button>
        {cgStatus && (
          <span className={'gg-glass gg-cg-status is-' + cgStatus} role="status" data-testid="gg-cg-status">
            {cgStatus === 'pending' ? t('galgame.cgPending') : t('galgame.cgFailed')}
          </span>
        )}
        <SceneChips scene={stateFiles['game/scene.json']} glass />
        <PolicyBadge modeId="galgame" policy={policy} onPolicyChange={onPolicyChange} glass />
      </div>

      <div className="gg-bottom">
        {question && hasCharacterPortraits(question.seg) && (
          <div className="gg-cpick" data-testid="gg-cpick">
            <CharacterPickerCard seg={question.seg} qid={question.id} ctx={ctx} onPick={onPick} variant="stage" />
          </div>
        )}
        {question && !hasCharacterPortraits(question.seg) && (
          <div className="gg-choices" role="group" aria-label={question.seg.prompt || t('galgame.choicesAria')}>
            {question.seg.choices.map((c, idx) => {
              const on = multi.includes(c);
              return (
                <button
                  key={c}
                  type="button"
                  className={'gg-choice' + (on ? ' is-on' : '')}
                  aria-pressed={question.seg.multi ? on : undefined}
                  onClick={() => {
                    if (!question.seg.multi) return onPick(question.id, [c]);
                    setMulti((m) => (m.includes(c) ? m.filter((x) => x !== c) : question.seg.max && m.length >= question.seg.max ? m : [...m, c]));
                  }}
                >
                  <span aria-hidden>✦</span> <span className="gg-choice-text">{renderInline(c, `gc-${idx}`)}</span>
                  <span className="gg-choice-go" aria-hidden>
                    ›
                  </span>
                </button>
              );
            })}
            {question.seg.multi && (
              <button type="button" className="gg-choice is-confirm" disabled={!multi.length} onClick={() => onPick(question.id, multi)}>
                {t('galgame.confirmCount', { count: multi.length })}
              </button>
            )}
          </div>
        )}

        {(turn || streaming || isWaiting) && (
          <div className={'gg-box' + (expanded ? ' is-expanded' : '')} onClick={onBoxClick} data-testid="gg-box">
            <div className="gg-box-head">
              <span className="gg-nameplate">{streaming || isWaiting ? roleName : speaker}</span>
              <div className="gg-head-right">
                {!streaming && !isWaiting && headerVoiceSeg && <SpeechVoice seg={headerVoiceSeg} ctx={ctx} />}
                <button
                  type="button"
                  className="gg-expand-btn"
                  aria-expanded={expanded}
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpanded((x) => !x);
                  }}
                >
                  {expanded ? t('galgame.collapse') : t('galgame.expand')}
                </button>
              </div>
            </div>
            <div className="gg-box-body" data-testid="gg-box-body">
              {isWaiting ? (
                <div className="gg-typing" role="status" data-testid="gg-typing">
                  <span className="k-typing-dots" aria-hidden>
                    <span />
                    <span />
                    <span />
                  </span>
                  <span className="k-typing-label">
                    <b>{roleName}</b> {t('stream.typing')}
                  </span>
                </div>
              ) : streaming ? (
                <StreamingBody text={streamText} speaker={roleName} />
              ) : (
                segs.map((s, i) => {
                  const spIdx = s.type === 'bilingual' ? speeches.indexOf(s) : -1;
                  const segSpeaker = s.type === 'bilingual' ? resolveSpeaker(s.speaker, turn?.item, personaName) : speaker;
                  const prevSpeaker = spIdx > 0 ? resolveSpeaker(speeches[spIdx - 1].speaker, turn?.item, personaName) : speaker;
                  return (
                    <Fragment key={i}>
                      {s.type === 'text' ? (
                        <div className="gg-narration">
                          <Markdown text={s.markdown} />
                        </div>
                      ) : s.type === 'bilingual' ? (
                        <Speech
                          seg={s}
                          ctx={ctx}
                          speaker={segSpeaker}
                          showSpeaker={segSpeaker !== prevSpeaker}
                          showVoice={hasVoice(s) && s !== headerVoiceSeg}
                          zhOpen={!zhClosed[i]}
                          onToggleZh={() => setZhClosed((z) => ({ ...z, [i]: !z[i] }))}
                        />
                      ) : (
                        <div className="gg-sticker">
                          <StickerThumb seg={s as FileSegment} ctx={ctx} />
                        </div>
                      )}
                    </Fragment>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

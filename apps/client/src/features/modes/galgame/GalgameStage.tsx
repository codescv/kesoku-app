import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { MemoryPolicy, Segment } from '@kesoku/protocol';
import { PolicyBadge, SceneChips } from '@kesoku/hud';
import { RubyText, VoicePill, resolveRubyParts } from '@kesoku/ui';
import type { ChatItem, StreamPreview } from '../../../lib/types';
import type { CardContext, MediaRef } from '../../cards/types';
import { toMediaRef, useImageUrl } from '../../cards/util';

export interface GalgameStageProps {
  items: ChatItem[];
  preview: StreamPreview | null;
  stateFiles: Record<string, unknown>;
  ctx: CardContext;
  policy: MemoryPolicy;
  onPolicyChange: (p: MemoryPolicy) => void;
  onPick: (questionMessageId: string, choices: string[]) => void;
  onExit: () => void;
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

/** Latest CG: newest image `file` segment of any assistant row. */
export function latestCg(items: ChatItem[]): MediaRef | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== 'assistant' || !Array.isArray(it.segments)) continue;
    for (let j = it.segments.length - 1; j >= 0; j--) {
      const s = it.segments[j] as AnySeg;
      if (s && isImageSeg(s)) {
        const ref = toMediaRef({ placeholder_id: s.placeholder_id, object: s.object, ref: s.ref, url: s.url });
        if (ref) return ref;
      }
    }
  }
  return null;
}

type BilingualSeg = Extract<Segment, { type: 'bilingual' }>;
type QuestionSeg = Extract<Segment, { type: 'question' }>;

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
      if (s && s.type === 'question' && Array.isArray(s.choices) && s.choices.length) {
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

/**
 * Immersive visual-novel stage (Screen 04): full-bleed CG, top glass micro-pills, frosted dialogue box,
 * floating choice pills. Voice is strictly tap-to-play; nothing audio-related is resolved on mount.
 */
export function GalgameStage({ items, preview, stateFiles, ctx, policy, onPolicyChange, onPick, onExit }: GalgameStageProps) {
  const cgRef = useMemo(() => latestCg(items), [items]);
  const cgUrl = useImageUrl(ctx.resolveMedia, cgRef);
  const line = useMemo(() => latestLine(items), [items]);
  const question = useMemo(() => openQuestion(items), [items]);
  const streaming = preview && !preview.interrupted ? previewLine(preview.text) : '';
  const typed = useTypewriter(streaming);

  const [zhOpen, setZhOpen] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [uiHidden, setUiHidden] = useState(false);
  const [multi, setMulti] = useState<string[]>([]);
  const press = useRef<{ t: ReturnType<typeof setTimeout> | null; y: number | null }>({ t: null, y: null });

  useEffect(() => setMulti([]), [question?.id]);
  useEffect(() => () => {
    if (press.current.t) clearTimeout(press.current.t);
  }, []);

  const lastItem = line?.item;
  const personaName = lastItem?.sender?.display_name || lastItem?.sender?.name || '飞鸟';
  const speaker = (line?.seg.speaker as string | undefined) || personaName;
  const parts = line ? resolveRubyParts(line.seg) : [];
  const voice = line?.seg.voice;
  const voiceRef = voice ? toMediaRef(voice) : null;
  const zh = line?.seg.zh ?? '';

  const startPress = (e: RPointerEvent) => {
    const el = e.target as HTMLElement | null;
    if (el && typeof el.closest === 'function' && el.closest('button, .gg-box, .gg-choices')) return;
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
        <button type="button" className="gg-glass gg-back" onClick={onExit} aria-label="返回气泡流">
          ← {personaName} · 约会
        </button>
        <SceneChips scene={stateFiles['game/scene.json']} glass />
        <PolicyBadge modeId="galgame" policy={policy} onPolicyChange={onPolicyChange} glass />
      </div>

      <div className="gg-bottom">
        {question && (
          <div className="gg-choices" role="group" aria-label={question.seg.prompt || '选项'}>
            {question.seg.choices.map((c) => {
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
                  <span aria-hidden>✦</span> {c}
                  <span className="gg-choice-go" aria-hidden>
                    ›
                  </span>
                </button>
              );
            })}
            {question.seg.multi && (
              <button type="button" className="gg-choice is-confirm" disabled={!multi.length} onClick={() => onPick(question.id, multi)}>
                确定 ({multi.length})
              </button>
            )}
          </div>
        )}

        {(line || typed) && (
          <div className={'gg-box' + (expanded ? ' is-expanded' : '')} onClick={() => setExpanded((x) => !x)}>
            <div className="gg-box-head">
              <span className="gg-nameplate">{speaker}</span>
              {!streaming && voiceRef && (
                <VoicePill resolveUrl={() => ctx.resolveMedia(voiceRef)} durationMs={typeof voice?.duration_ms === 'number' ? voice.duration_ms : undefined} />
              )}
            </div>
            {streaming ? (
              <div className="gg-line is-typing" lang="ja">
                {typed}
                <span className="gg-caret" aria-hidden />
              </div>
            ) : (
              <div className="gg-line">
                <RubyText parts={parts} />
              </div>
            )}
            {!streaming && zh && (
              <button
                type="button"
                className={'gg-zh' + (zhOpen ? '' : ' is-collapsed')}
                aria-expanded={zhOpen}
                onClick={(e) => {
                  e.stopPropagation();
                  setZhOpen((o) => !o);
                }}
              >
                {zhOpen ? zh : '中文 ▸'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

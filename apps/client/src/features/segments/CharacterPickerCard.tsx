import { useEffect, useRef, useState } from 'react';
import type { ChoiceItem, QuestionSegment } from '@kesoku/protocol';
import { UiIcon } from '@kesoku/ui';
import type { CardContext } from '../cards/types';
import { actions, useStore } from '../../lib/store';
import { overlays } from '../session/overlays';
import { renderInline } from './Markdown';

/** Avatars that are already loadable URLs (no `media.hydrate` round trip needed). */
const DIRECT_URL = /^(https?:|data:|blob:)/i;

/** True when a question carries at least one portrait option → render the character picker card. */
export function hasCharacterPortraits(seg: Pick<QuestionSegment, 'choice_items'> | null | undefined): boolean {
  return Array.isArray(seg?.choice_items) && seg.choice_items.some((it) => Boolean(it?.avatar));
}

function freshUrl(entry: { url?: string; expires_at?: number } | undefined): string | null {
  if (!entry?.url) return null;
  if (entry.expires_at && entry.expires_at > 1_000_000_000 && entry.expires_at - 30 <= Date.now() / 1000) return null;
  return entry.url;
}

/** First visible character of a name, for the error / no-image badge. */
function initialOf(label: string): string {
  return Array.from(label.trim())[0]?.toUpperCase() ?? '?';
}

/**
 * Eagerly resolve a portrait ref via `ctx.resolveMedia({ ref })`. The resolved URL is kept in the shared media
 * store under `'ref:' + avatar`, so re-renders / remounts reuse it instantly; one silent retry on `<img>` error.
 */
function usePortraitUrl(avatar: string, ctx: CardContext) {
  const direct = DIRECT_URL.test(avatar) ? avatar : null;
  const refKey = 'ref:' + avatar;
  const cached = useStore((s) => (direct ? null : freshUrl(s.media[refKey])));
  const [local, setLocal] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retried = useRef(false);
  // The card context is recreated on every list render; keep the latest without re-triggering loads.
  const resolveRef = useRef(ctx.resolveMedia);
  resolveRef.current = ctx.resolveMedia;
  const url = direct ?? cached ?? local;

  useEffect(() => {
    if (direct || cached || failed) return;
    let alive = true;
    resolveRef.current({ ref: avatar }).then(
      (u) => {
        if (!alive) return;
        if (!u) return setFailed(true);
        if (!freshUrl(useStore.getState().media[refKey])) actions.setMedia(refKey, { status: 'ready', url: u });
        setLocal(u);
      },
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [avatar, direct, cached, failed, refKey, attempt]);

  /** `<img>` failed: drop the stale cached URL and re-resolve once, then give up (initial badge). */
  function onImgError() {
    if (retried.current || direct) return setFailed(true);
    retried.current = true;
    const entry = useStore.getState().media[refKey];
    if (entry?.url) actions.setMedia(refKey, { ...entry, url: undefined });
    setLocal(null);
    setAttempt((n) => n + 1);
  }

  return { url: failed ? null : url, failed, onImgError };
}

interface CharacterCardProps {
  item: ChoiceItem & { avatar: string };
  ctx: CardContext;
  selected: boolean;
  dim: boolean;
  disabled?: boolean;
  multi: boolean;
  onSelect: () => void;
}

function CharacterCard({ item, ctx, selected, dim, disabled, multi, onSelect }: CharacterCardProps) {
  const label = item.name || item.value;
  const { url, failed, onImgError } = usePortraitUrl(item.avatar, ctx);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const loaded = !!url && loadedUrl === url;
  return (
    <div
      className={['k-cpick-card', selected && 'is-selected', dim && 'is-dim'].filter(Boolean).join(' ')}
      data-testid="cpick-card"
      data-value={item.value}
    >
      <button
        type="button"
        className="k-cpick-hit"
        aria-pressed={multi ? selected : undefined}
        aria-disabled={dim || undefined}
        disabled={disabled}
        onClick={onSelect}
      >
        <span className={'k-cpick-portrait' + (!failed && !loaded ? ' is-loading' : '')}>
          {url ? (
            <img src={url} alt={label} loading="eager" decoding="async" draggable={false} onLoad={() => setLoadedUrl(url)} onError={onImgError} />
          ) : failed ? (
            <span className="k-cpick-initial" aria-hidden data-testid="cpick-initial">
              {initialOf(label)}
            </span>
          ) : null}
        </span>
        <span className="k-cpick-text">
          <span className="k-cpick-name">{label}</span>
          {item.subtitle && <span className="k-cpick-sub">{item.subtitle}</span>}
        </span>
      </button>
      {selected && (
        <span className="k-cpick-check" aria-hidden>
          ✓
        </span>
      )}
      {url && (
        <button
          type="button"
          className="k-cpick-zoom"
          aria-label={`查看 ${label} 大图`}
          onClick={(e) => {
            e.stopPropagation();
            overlays.image(url);
          }}
        >
          <UiIcon name="search" size={14} />
        </button>
      )}
    </div>
  );
}

export interface CharacterPickerCardProps {
  seg: QuestionSegment;
  /** Question message id passed back to `onPick`. */
  qid: string;
  ctx: CardContext;
  onPick: (questionMessageId: string, choices: string[]) => void;
  disabled?: boolean;
  /** `stage` = frosted-glass container for the galgame stage; `list` = inline in the bubble flow. */
  variant?: 'list' | 'stage';
}

/**
 * Portrait character picker for `question` segments whose `choice_items` carry avatars.
 * Single-select picks in one tap; multi-select toggles (capped by `max`) and confirms. Non-avatar items
 * (e.g. "🎲 再帮我想 8 个不同的候选") render as secondary pills and submit in one tap while nothing is selected.
 */
export function CharacterPickerCard({ seg, qid, ctx, onPick, disabled, variant = 'list' }: CharacterPickerCardProps) {
  const [sel, setSel] = useState<string[]>([]);
  useEffect(() => setSel([]), [qid]);
  const items = seg.choice_items ?? [];
  const avatarItems = items.filter((it): it is ChoiceItem & { avatar: string } => Boolean(it.avatar));
  const actionItems = items.filter((it) => !it.avatar);
  const multi = !!seg.multi;
  const max = seg.max ?? 0;
  const capLabel = max > 1 ? '/' + max : '';
  const full = multi && max > 1 && sel.length >= max;

  /** Multi-select toggle honouring `max` (a cap of 1 swaps the selection instead of blocking). */
  function toggle(value: string) {
    setSel((s) => {
      if (s.includes(value)) return s.filter((x) => x !== value);
      if (max === 1) return [value];
      if (max > 0 && s.length >= max) return s;
      return [...s, value];
    });
  }

  function pickItem(value: string) {
    if (disabled) return;
    if (!multi) return onPick(qid, [value]);
    toggle(value);
  }

  return (
    <div className={'k-cpick' + (variant === 'stage' ? ' is-stage' : '')} data-testid="character-picker" role="group" aria-label={seg.prompt || '选择角色'}>
      <div className="k-cpick-head">
        <div className="k-cpick-prompt">{seg.prompt ? renderInline(seg.prompt, 'cpp') : '选择角色'}</div>
        <span className="k-cpick-status" data-testid="cpick-status">
          {multi ? `已选 ${sel.length}${capLabel}` : '单选'}
        </span>
      </div>
      <div className="k-cpick-grid">
        {avatarItems.map((it) => {
          const selected = sel.includes(it.value);
          return (
            <CharacterCard
              key={it.value}
              item={it}
              ctx={ctx}
              multi={multi}
              selected={selected}
              dim={full && !selected}
              disabled={disabled}
              onSelect={() => pickItem(it.value)}
            />
          );
        })}
      </div>
      {actionItems.length > 0 && (
        <div className="k-cpick-actions">
          {actionItems.map((it, idx) => {
            const on = sel.includes(it.value);
            return (
              <button
                key={it.value}
                type="button"
                className={'k-cpick-action' + (on ? ' is-on' : '')}
                disabled={disabled}
                onClick={() => {
                  // Reroll-style actions submit in one tap while nothing is selected, even in multi-select.
                  if (!multi || sel.length === 0) return onPick(qid, [it.value]);
                  toggle(it.value);
                }}
              >
                {renderInline(it.name || it.value, `cpa-${idx}`)}
              </button>
            );
          })}
        </div>
      )}
      {multi && !disabled && (
        <div className="k-cpick-bar">
          {sel.length > 0 && (
            <button type="button" className="k-cpick-clear" onClick={() => setSel([])}>
              清空
            </button>
          )}
          <button type="button" className="k-cpick-confirm" disabled={sel.length === 0} onClick={() => onPick(qid, sel)}>
            {`确认选择 (${sel.length}${capLabel})`}
          </button>
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TouchEvent as ReactTouchEvent } from 'react';
import { createPortal } from 'react-dom';
import type { SessionSummary } from '@kesoku/protocol';
import { Avatar, ModeIcon, UiIcon, formatLocaleDate, modeMeta, useLocale, useT, type ResolvedLocale, type MessageKey } from '@kesoku/ui';
import { kesoku } from '../../lib/client';
import { actions, useStore } from '../../lib/store';
import { kvSet } from '../../lib/db';
import { hapticTap } from '../../native/haptics';
import { useIsDesktop } from '../../app/useMedia';
import { useAvatarUrl } from '../persona/avatar';
import { fallbackRoleId, roleAvatarRef, roleFallbackName } from '../persona/model';
import { selectHasActiveWorkout, useWorkoutStore } from '../workout/store';

function channelLabel(chan: string, t: (k: MessageKey) => string): string {
  if (chan === 'wechat') return t('shell.channel.wechat');
  if (chan === 'discord' || chan === 'discord_asuka') return 'Discord';
  return chan;
}

export const RECENT_SESSIONS_LIMIT = 10;

function rel(ts: number, locale: ResolvedLocale, t: (k: MessageKey, p?: Record<string, string | number>) => string): string {
  const d = Date.now() / 1000 - ts;
  if (d < 60) return t('common.justNow');
  if (d < 3600) return t('common.minutesAgo', { n: Math.floor(d / 60) });
  if (d < 86400) return t('common.hoursAgo', { n: Math.floor(d / 3600) });
  if (d < 86400 * 7) return t('common.daysAgo', { n: Math.floor(d / 86400) });
  return formatLocaleDate(ts * 1000, { month: 'numeric', day: 'numeric' }, locale);
}

const LONG_PRESS_MS = 420;

type EditMode = 'menu' | 'rename';

export interface EditAnchor {
  x: number;
  y: number;
  rect: DOMRect;
}

function isForeign(s: SessionSummary): boolean {
  return !!s.chatbot_id && s.chatbot_id !== 'app';
}

/** Swallow the event so nothing bubbles up to a drawer-closing / session-opening ancestor. */
function stop(e: { stopPropagation(): void }) {
  e.stopPropagation();
}

function SessionRow({
  s,
  active,
  onOpen,
  onEdit,
}: {
  s: SessionSummary;
  active: boolean;
  onOpen: () => void;
  onEdit: (mode: EditMode, anchor?: EditAnchor, openedByTouch?: boolean) => void;
}) {
  const locale = useLocale();
  const t = useT();
  const touchRef = useRef<{ startX: number; startY: number; timer: ReturnType<typeof setTimeout> | null; longPressed: boolean }>({
    startX: 0,
    startY: 0,
    timer: null,
    longPressed: false,
  });
  const lastTouchAtRef = useRef(0);
  const chan = isForeign(s) ? s.chatbot_id! : null;
  const m = modeMeta(s.mode_id || 'chat', locale);

  const clearTimer = () => {
    const t = touchRef.current;
    if (t.timer) clearTimeout(t.timer);
    t.timer = null;
  };
  useEffect(() => clearTimer, []);

  const onTouchStart = (e: ReactTouchEvent) => {
    lastTouchAtRef.current = Date.now();
    const t = touchRef.current;
    const p = e.touches[0];
    clearTimer();
    t.startX = p?.clientX ?? 0;
    t.startY = p?.clientY ?? 0;
    t.longPressed = false;
    t.timer = setTimeout(() => {
      t.timer = null;
      t.longPressed = true;
      void hapticTap();
      onEdit('menu', undefined, true);
    }, LONG_PRESS_MS);
  };
  const onTouchMove = (e: ReactTouchEvent) => {
    lastTouchAtRef.current = Date.now();
    const t = touchRef.current;
    const p = e.touches[0];
    if (!p) return;
    const dx = p.clientX - t.startX;
    const dy = p.clientY - t.startY;
    if (Math.hypot(dx, dy) > 10) clearTimer();
  };
  const onTouchEnd = (e: ReactTouchEvent) => {
    lastTouchAtRef.current = Date.now();
    clearTimer();
    const t = touchRef.current;
    if (t.longPressed) {
      // Suppress the synthetic click so it can't open the session or hit the freshly opened menu.
      if (e.cancelable) e.preventDefault();
    }
  };
  const onTouchCancel = () => {
    lastTouchAtRef.current = Date.now();
    clearTimer();
  };

  return (
    <div
      className={'k-srow' + (active ? ' is-active' : '')}
      data-session-id={s.session_id}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
      <button
        type="button"
        className="k-srow-main"
        onClick={(e) => {
          const t = touchRef.current;
          if (t.longPressed) {
            t.longPressed = false;
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          onOpen();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          clearTimer();
          // A touch long-press already opened (or is opening) the menu; never pass desktop anchor or toggle twice.
          const isTouchContextMenu = touchRef.current.longPressed || Date.now() - lastTouchAtRef.current < 1500;
          if (isTouchContextMenu) {
            if (!touchRef.current.longPressed) {
              touchRef.current.longPressed = true;
              void hapticTap();
              onEdit('menu', undefined, true);
            }
            return;
          }
          onEdit('menu', {
            x: e.clientX,
            y: e.clientY,
            rect: e.currentTarget.getBoundingClientRect(),
          });
        }}
      >
        <span className="k-srow-title">
          {m && (
            <span className="k-srow-mode" aria-hidden>
              <ModeIcon mode={m.id} size={18} />
            </span>
          )}
          {s.title || t('session.untitled')}
        </span>
        <span className="k-srow-meta">
          {chan && (
            <span className="k-pill k-pill-warn k-pill-sm">
              [{channelLabel(chan, t)} · {s.app_bound ? t('session.takenOver') : t('session.readOnly')}]
            </span>
          )}
          {m && <span className="k-pill k-pill-sm k-pill-neutral">{m.short}</span>}
          <span>{rel(s.updated_at, locale, t)}</span>
          {s.unread ? <span className="k-dot" aria-label={t('session.unreadAria')} /> : null}
        </span>
      </button>
    </div>
  );
}

/** Long-press / right-click edit menu for one session (rename & delete). Anchored popover on desktop right-click. */
function SessionEditMenu({
  sessionId,
  mode,
  anchor,
  openedByTouch,
  onMode,
  onClose,
}: {
  sessionId: string;
  mode: EditMode;
  anchor?: EditAnchor;
  openedByTouch?: boolean;
  onMode: (m: EditMode) => void;
  onClose: () => void;
}) {
  const locale = useLocale();
  const t = useT();
  const s = useStore((st) => st.sessions[sessionId]);
  const desktop = useIsDesktop();
  const isPopover = Boolean(desktop && anchor && !openedByTouch);
  const [title, setTitle] = useState(s?.title ?? '');
  const openedAt = useRef(Date.now());
  const initialTouchStillDownRef = useRef(Boolean(openedByTouch));
  const lastTouchReleaseAtRef = useRef(0);
  const scrimPressedRef = useRef(false);
  const cardPressedRef = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!s) onClose();
  }, [s, onClose]);

  useEffect(() => {
    const onTouchRelease = () => {
      if (initialTouchStillDownRef.current) {
        initialTouchStillDownRef.current = false;
      }
      lastTouchReleaseAtRef.current = Date.now();
    };
    window.addEventListener('touchend', onTouchRelease, true);
    window.addEventListener('touchcancel', onTouchRelease, true);
    return () => {
      window.removeEventListener('touchend', onTouchRelease, true);
      window.removeEventListener('touchcancel', onTouchRelease, true);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!isPopover) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (cardRef.current && e.target instanceof Node && cardRef.current.contains(e.target)) return;
      onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('touchstart', onDown, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('touchstart', onDown, true);
    };
  }, [isPopover, onClose]);

  if (!s) return null;
  const m = modeMeta(s.mode_id || 'chat', locale);
  const foreign = isForeign(s);
  const name = s.title || t('session.untitled');
  const save = () => {
    const next = title.trim();
    if (!next) return;
    onClose();
    if (next !== s.title) void kesoku.renameSession(s.session_id, next);
  };

  let popoverStyle: { left: string; top: string } | undefined;
  if (isPopover && anchor) {
    const cardW = mode === 'rename' ? 280 : 224;
    const cardH = mode === 'rename' ? 156 : 224;
    const hasCoords = anchor.x > 0 || anchor.y > 0;
    const rawX = hasCoords ? anchor.x : anchor.rect.left + Math.min(Math.max(anchor.rect.width * 0.4, 24), 140);
    const rawY = hasCoords ? anchor.y : anchor.rect.bottom + 4;
    const vw = typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : 1280;
    const vh = typeof window !== 'undefined' && window.innerHeight > 0 ? window.innerHeight : 800;
    const left = Math.max(8, Math.min(rawX, vw - cardW - 12));
    const top = Math.max(8, Math.min(rawY, vh - cardH - 12));
    popoverStyle = { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` };
  }

  const node = (
    <div
      className={'k-sedit-root' + (isPopover ? ' is-popover' : '')}
      style={popoverStyle}
      data-testid="session-edit-menu"
      data-popover={isPopover ? 'true' : 'false'}
      role="dialog"
      aria-modal={!isPopover}
      aria-label={t('session.editAria', { name })}
      onClick={stop}
      onTouchStart={stop}
      onTouchEnd={stop}
      onContextMenu={(e) => {
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
        stop(e);
      }}
    >
      {!isPopover && (
        <div
          className="k-sedit-scrim"
          onTouchStart={(e) => {
            stop(e);
            if (!initialTouchStillDownRef.current) {
              scrimPressedRef.current = true;
            }
          }}
          onPointerDown={(e) => {
            stop(e);
            if (e.pointerType === 'touch') {
              if (!initialTouchStillDownRef.current) scrimPressedRef.current = true;
              return;
            }
            if (!initialTouchStillDownRef.current && Date.now() - lastTouchReleaseAtRef.current > 350) {
              scrimPressedRef.current = true;
            }
          }}
          onMouseDown={(e) => {
            stop(e);
            if (!initialTouchStillDownRef.current && Date.now() - lastTouchReleaseAtRef.current > 350) {
              scrimPressedRef.current = true;
            }
          }}
          onClick={(e) => {
            stop(e);
            const now = Date.now();
            // Never close while the opening long-press touch is still held down,
            // or on the trailing synthetic click emitted right when the finger lifts.
            if (initialTouchStillDownRef.current) return;
            if (lastTouchReleaseAtRef.current > 0 && now - lastTouchReleaseAtRef.current < 400 && !scrimPressedRef.current) {
              return;
            }
            if (scrimPressedRef.current) {
              scrimPressedRef.current = false;
              onClose();
              return;
            }
            if (!openedByTouch && now - openedAt.current > 350) {
              onClose();
              return;
            }
            if (openedByTouch && lastTouchReleaseAtRef.current > 0 && now - lastTouchReleaseAtRef.current >= 400) {
              onClose();
            }
          }}
        />
      )}
      <div
        className="k-sedit-card"
        ref={cardRef}
        onTouchStartCapture={() => {
          if (!initialTouchStillDownRef.current) {
            cardPressedRef.current = true;
          }
        }}
        onMouseDownCapture={() => {
          if (!initialTouchStillDownRef.current && Date.now() - lastTouchReleaseAtRef.current > 350) {
            cardPressedRef.current = true;
          }
        }}
        onClickCapture={(e) => {
          if (!openedByTouch || cardPressedRef.current) return;
          if (e.clientX === 0 && e.clientY === 0) return;
          const now = Date.now();
          if (initialTouchStillDownRef.current || (lastTouchReleaseAtRef.current > 0 && now - lastTouchReleaseAtRef.current < 350)) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        <div className="k-sedit-head">
          {m && (
            <span className="k-srow-mode" aria-hidden>
              <ModeIcon mode={m.id} size={20} />
            </span>
          )}
          <span className="k-sedit-title">{name}</span>
        </div>
        {mode === 'rename' ? (
          <form
            className="k-sedit-rename"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <input autoFocus value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} aria-label={t('session.titleAria')} data-testid="session-rename-input" />
            <div className="k-sedit-row">
              <button type="button" className="k-btn k-btn-ghost" onClick={onClose}>
                {t('common.cancel')}
              </button>
              <button type="submit" className="k-btn k-btn-primary" data-testid="session-rename-save" disabled={!title.trim()}>
                {t('common.save')}
              </button>
            </div>
          </form>
        ) : (
          <div className="k-sedit-actions">
            <button
              type="button"
              className="k-sedit-btn"
              data-testid="session-action-rename"
              onClick={() => {
                setTitle(s.title ?? '');
                onMode('rename');
              }}
            >
              <UiIcon name="edit" size={20} />
              {t('session.rename')}
            </button>
            <button
              type="button"
              className="k-sedit-btn"
              data-testid="session-action-notes"
              onClick={() => {
                onClose();
                actions.setUi({ sessionNotesId: s.session_id, drawerOpen: false });
              }}
            >
              <UiIcon name="pin" size={20} />
              {t('topbar.pinnedNotes')}
            </button>
            <button
              type="button"
              className="k-sedit-btn is-danger"
              data-testid="session-action-delete"
              disabled={foreign}
              onClick={() => {
                onClose();
                void kesoku.deleteSession(s.session_id);
              }}
            >
              <UiIcon name="trash" size={20} />
              {t('session.delete')}
            </button>
            {foreign && <p className="k-sedit-hint">{t('session.externalCannotDelete')}</p>}
            <button type="button" className="k-sedit-btn is-cancel" data-testid="session-action-cancel" onClick={onClose}>
              {t('common.cancel')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
  return typeof document !== 'undefined' ? createPortal(node, document.body) : node;
}

/** Left drawer / desktop left column (Screen 03). */
export function SessionPanel({ onNavigate }: { onNavigate?: () => void }) {
  const locale = useLocale();
  const t = useT();
  const sessions = useStore((s) => s.sessions);
  const current = useStore((s) => s.currentSessionId);
  const allChannels = useStore((s) => s.settings.allChannels);
  const roleFilter = useStore((s) => s.ui.roleFilter);
  const screen = useStore((s) => s.ui.screen);
  const personas = useStore((s) => s.personas);
  const hits = useStore((s) => s.searchHits);
  const proposals = useStore((s) => s.proposals);
  const conn = useStore((s) => s.conn);
  const [q, setQ] = useState('');
  const [allSessionsOpen, setAllSessionsOpen] = useState(false);
  const [editing, setEditing] = useState<{ id: string; mode: EditMode; anchor?: EditAnchor; openedByTouch?: boolean } | null>(null);
  const closeEdit = useCallback(() => setEditing(null), []);

  useEffect(() => {
    const onOpenAll = () => setAllSessionsOpen(true);
    window.addEventListener('kesoku:open-all-sessions', onOpenAll);
    return () => window.removeEventListener('kesoku:open-all-sessions', onOpenAll);
  }, []);

  useEffect(() => {
    if (q.trim().length < 2) {
      useStore.setState({ searchHits: [] });
      return;
    }
    const t = setTimeout(() => void kesoku.search(q.trim()).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [q]);

  const list = useMemo(
    () =>
      Object.values(sessions)
        .filter((s) => allChannels || (s.chatbot_id ?? 'app') === 'app')
        .filter((s) => !roleFilter || s.role === roleFilter)
        .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0) || b.session_id.localeCompare(a.session_id)),
    [sessions, allChannels, roleFilter],
  );
  const recentList = useMemo(() => list.slice(0, RECENT_SESSIONS_LIMIT), [list]);
  const pending = Object.values(proposals).filter((p) => (p.status ?? 'pending') === 'pending').length;
  const hasActiveWorkout = useWorkoutStore(selectHasActiveWorkout);
  const toolsActive = screen === 'tools' || screen === 'notes' || screen === 'files' || screen === 'workout';
  const draftRole = useStore((s) => s.ui.draftRole);
  const activeRole = (current ? sessions[current]?.role : undefined) ?? draftRole ?? roleFilter ?? fallbackRoleId(personas);
  const activePersona = personas.find((p) => p.role_id === activeRole) ?? personas[0];
  const activeAvatarSrc = useAvatarUrl(activePersona ? roleAvatarRef(activePersona) : null, activePersona?.avatar_rev);
  const roles = [
    { id: null as string | null, label: t('common.all') },
    ...personas.map((p) => ({
      id: p.role_id as string | null,
      label: p.display_name || p.role_id,
    })),
  ];
  const go = () => onNavigate?.();

  return (
    <nav
      className="k-spanel"
      aria-label={t('session.navAria')}
      onContextMenu={(e) => {
        // Menu chrome is not text: never show the iOS/desktop callout on buttons, chips or rows.
        const t = e.target as HTMLElement;
        if (!t.closest('input, textarea, [contenteditable="true"]')) e.preventDefault();
      }}
    >
      {allSessionsOpen ? (
        <div className="k-spanel-subview" data-testid="all-sessions-view">
          <div className="k-spanel-subhead">
            <button
              type="button"
              className="k-btn k-btn-ghost k-btn-sm"
              data-testid="all-sessions-back"
              aria-label={t('session.backToSidebarAria')}
              onClick={() => {
                setQ('');
                useStore.setState({ searchHits: [] });
                setAllSessionsOpen(false);
              }}
            >
              <UiIcon name="arrow-left" size={18} /> {t('common.back')}
            </button>
            <b className="k-spanel-subtitle">{t('session.allSessionsCount', { count: list.length })}</b>
          </div>
          <div className="k-spanel-search">
            <UiIcon name="search" size={18} className="k-search-icon" />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('session.searchPlaceholder')} aria-label={t('session.searchPlaceholder')} id="k-search" />
          </div>
          <div className="k-chips" role="tablist" aria-label={t('session.roleFilterAria')}>
            {roles.map((r) => (
              <button
                key={r.id ?? 'all'}
                type="button"
                role="tab"
                aria-selected={roleFilter === r.id}
                className={'k-chip' + (roleFilter === r.id ? ' is-on' : '')}
                onClick={() => {
                  actions.setUi(r.id && !useStore.getState().currentSessionId ? { roleFilter: r.id, draftRole: r.id } : { roleFilter: r.id });
                  void kesoku.listSessions().catch(() => {});
                }}
              >
                {r.label}
              </button>
            ))}
          </div>
          <label className="k-switch-row">
            <span>{t('session.showAllChannels')}</span>
            <input
              type="checkbox"
              role="switch"
              checked={allChannels}
              onChange={(e) => {
                actions.setSettings({ allChannels: e.target.checked });
                void kvSet('settings', useStore.getState().settings);
                void kesoku.listSessions().catch(() => {});
              }}
            />
          </label>
          <div className="k-slist">
            {hits.length > 0 ? (
              hits.map((h, i) => (
                <button
                  key={`${h.session_id}-${h.message_id ?? i}`}
                  type="button"
                  className="k-hit"
                  onClick={() => {
                    void kesoku.openSession(h.session_id);
                    go();
                  }}
                >
                  <span className="k-hit-title">{h.title || sessions[h.session_id]?.title || t('session.fallbackTitle')}</span>
                  <span className="k-hit-snippet">{h.snippet}</span>
                  <span className="k-srow-meta">
                    {h.role && <span className="k-pill k-pill-sm k-pill-primary">{h.role}</span>}
                    {h.chatbot_id && h.chatbot_id !== 'app' && <span className="k-pill k-pill-sm k-pill-warn">{channelLabel(h.chatbot_id, t)}</span>}
                    <span>{rel(h.ts, locale, t)}</span>
                  </span>
                </button>
              ))
            ) : list.length ? (
              list.map((s) => (
                <SessionRow
                  key={s.session_id}
                  s={s}
                  active={s.session_id === current}
                  onOpen={() => {
                    void kesoku.openSession(s.session_id);
                    go();
                  }}
                  onEdit={(mode, anchor, openedByTouch) => setEditing({ id: s.session_id, mode, anchor, openedByTouch })}
                />
              ))
            ) : (
              <div className="k-empty">{t('session.noMatching')}</div>
            )}
          </div>
        </div>
      ) : (
        <>
          <button
            type="button"
            className="k-new-session"
            data-testid="new-session"
            onClick={() => {
              // Carry the role over to the New Session screen (role filter → current session's role → earlier pick).
              const s = useStore.getState();
              const draftRole = s.ui.roleFilter ?? (s.currentSessionId ? s.sessions[s.currentSessionId]?.role : null) ?? s.ui.draftRole ?? null;
              useStore.setState({ currentSessionId: null });
              actions.setUi({ launchpad: true, screen: 'chat', drawerOpen: false, draftRole });
              go();
            }}
          >
            <UiIcon name="plus" size={18} /> {t('session.newSession')}
          </button>
          <div className="k-slist">
            {recentList.length ? (
              recentList.map((s) => (
                <SessionRow
                  key={s.session_id}
                  s={s}
                  active={s.session_id === current}
                  onOpen={() => {
                    void kesoku.openSession(s.session_id);
                    go();
                  }}
                  onEdit={(mode, anchor, openedByTouch) => setEditing({ id: s.session_id, mode, anchor, openedByTouch })}
                />
              ))
            ) : (
              <div className="k-empty">{t('session.emptyHint')}</div>
            )}
          </div>
          <button
            type="button"
            className="k-foot-btn k-all-sessions-btn"
            data-testid="all-sessions-btn"
            onClick={() => setAllSessionsOpen(true)}
          >
            <UiIcon name="clock" size={19} />
            <span>{t('session.allSessions')}</span>
            <span className="k-all-sessions-count">{list.length}</span>
            <UiIcon name="chevron-right" size={16} />
          </button>
          <div className="k-spanel-foot">
            <div className="k-spanel-foot-row">
              <button
                type="button"
                className={'k-foot-btn' + (screen === 'memory' ? ' is-active' : '')}
                data-testid="sidebar-memory-btn"
                aria-current={screen === 'memory' ? 'page' : undefined}
                onClick={() => (actions.setUi({ screen: 'memory', toolReturnScreen: 'chat', drawerOpen: false }), go())}
              >
                <UiIcon name="brain" size={18} />
                <span>{t('session.memory')}</span>
                {pending > 0 && <span className="k-badge-dot" aria-label={t('session.pendingCountAria', { count: pending })}>{pending}</span>}
              </button>
              <button
                type="button"
                className={'k-foot-btn' + (toolsActive ? ' is-active' : '')}
                data-testid="sidebar-tools-btn"
                aria-current={toolsActive ? 'page' : undefined}
                onClick={() => (actions.setUi({ screen: 'tools', toolReturnScreen: 'chat', drawerOpen: false }), go())}
              >
                <UiIcon name="apps" size={17} />
                <span>{t('session.tools')}</span>
                {hasActiveWorkout && <span className="k-sidebar-tools-dot" data-testid="sidebar-tools-active-dot" aria-hidden />}
              </button>
            </div>
            <button
              type="button"
              className={'k-foot-btn' + (screen === 'studio' ? ' is-active' : '')}
              data-testid="sidebar-studio-btn"
              aria-current={screen === 'studio' ? 'page' : undefined}
              onClick={() => (actions.setUi({ screen: 'studio', toolReturnScreen: 'chat', drawerOpen: false }), go())}
            >
              <Avatar src={activeAvatarSrc} name={activePersona?.display_name ?? roleFallbackName(activeRole)} size={22} ai={activePersona?.avatar_ai} /> {t('session.studio')}
            </button>
            <button
              type="button"
              className={'k-foot-btn' + (screen === 'settings' ? ' is-active' : '')}
              data-testid="sidebar-settings-btn"
              aria-current={screen === 'settings' ? 'page' : undefined}
              onClick={() => (actions.setUi({ screen: 'settings', toolReturnScreen: 'chat', drawerOpen: false }), go())}
            >
              <UiIcon name="sliders" size={20} /> {t('session.settings')}
            </button>
            <div className="k-conn-line">
              <span className={'k-conn-dot' + (conn.status === 'online' ? (conn.engineOnline ? ' is-ok' : ' is-bad') : conn.status === 'reconnecting' ? ' is-warn' : '')} aria-hidden />
              {conn.status === 'online'
                ? conn.engineOnline
                  ? conn.latencyMs != null
                    ? t('settings.connectedLatency', { ms: conn.latencyMs })
                    : t('settings.connected')
                  : t('session.engineOffline')
                : conn.status === 'reconnecting'
                  ? t('shell.reconnecting')
                  : t('client.notConnected')}
            </div>
          </div>
        </>
      )}
      {editing && (
        <SessionEditMenu
          key={editing.id}
          sessionId={editing.id}
          mode={editing.mode}
          anchor={editing.anchor}
          openedByTouch={editing.openedByTouch}
          onMode={(mode) => setEditing({ id: editing.id, mode, anchor: editing.anchor, openedByTouch: editing.openedByTouch })}
          onClose={closeEdit}
        />
      )}
    </nav>
  );
}

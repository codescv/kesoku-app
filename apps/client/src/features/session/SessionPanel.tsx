import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TouchEvent as ReactTouchEvent } from 'react';
import { createPortal } from 'react-dom';
import type { SessionSummary } from '@kesoku/protocol';
import { Avatar, ModeIcon, UiIcon, modeMeta } from '@kesoku/ui';
import { kesoku } from '../../lib/client';
import { actions, useStore } from '../../lib/store';
import { kvSet } from '../../lib/db';
import { hapticTap } from '../../native/haptics';
import { useAvatarUrl } from '../persona/avatar';
import { fallbackRoleId, roleAvatarRef, roleFallbackName } from '../persona/model';

const CHANNEL_LABEL: Record<string, string> = { discord: 'Discord', discord_asuka: 'Discord', wechat: '微信' };

function rel(ts: number): string {
  const d = Date.now() / 1000 - ts;
  if (d < 60) return '刚刚';
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)} 天前`;
  return new Date(ts * 1000).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

const LONG_PRESS_MS = 420;

type EditMode = 'menu' | 'rename';

function isForeign(s: SessionSummary): boolean {
  return !!s.chatbot_id && s.chatbot_id !== 'app';
}

/** Swallow the event so nothing bubbles up to a drawer-closing / session-opening ancestor. */
function stop(e: { stopPropagation(): void }) {
  e.stopPropagation();
}

function SessionRow({ s, active, onOpen, onEdit }: { s: SessionSummary; active: boolean; onOpen: () => void; onEdit: (mode: EditMode) => void }) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(s.title);
  const touchRef = useRef<{ startX: number; startY: number; timer: ReturnType<typeof setTimeout> | null; longPressed: boolean; swiped: boolean }>({
    startX: 0,
    startY: 0,
    timer: null,
    longPressed: false,
    swiped: false,
  });
  const chan = isForeign(s) ? s.chatbot_id! : null;
  const m = modeMeta(s.mode_id || 'chat');

  const clearTimer = () => {
    const t = touchRef.current;
    if (t.timer) clearTimeout(t.timer);
    t.timer = null;
  };
  useEffect(() => clearTimer, []);

  const onTouchStart = (e: ReactTouchEvent) => {
    if (renaming) return;
    const t = touchRef.current;
    const p = e.touches[0];
    clearTimer();
    t.startX = p?.clientX ?? 0;
    t.startY = p?.clientY ?? 0;
    t.longPressed = false;
    t.swiped = false;
    t.timer = setTimeout(() => {
      t.timer = null;
      t.longPressed = true;
      void hapticTap();
      onEdit('menu');
    }, LONG_PRESS_MS);
  };
  const onTouchMove = (e: ReactTouchEvent) => {
    const t = touchRef.current;
    const p = e.touches[0];
    if (!p) return;
    const dx = p.clientX - t.startX;
    const dy = p.clientY - t.startY;
    if (Math.hypot(dx, dy) > 10) clearTimer();
    if (Math.abs(dx) > 20 && Math.abs(dx) > Math.abs(dy)) t.swiped = true;
  };
  const onTouchEnd = (e: ReactTouchEvent) => {
    clearTimer();
    const t = touchRef.current;
    if (renaming) return;
    if (t.longPressed) {
      // Suppress the synthetic click so it can't open the session or hit the freshly opened menu.
      if (e.cancelable) e.preventDefault();
      return;
    }
    const p = e.changedTouches[0];
    const dx = (p?.clientX ?? t.startX) - t.startX;
    const dy = (p?.clientY ?? t.startY) - t.startY;
    if (dx < -45 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      t.swiped = true;
      setMenu(true);
      void hapticTap();
    } else if (dx > 40 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      t.swiped = true;
      setMenu(false);
    }
  };
  const onTouchCancel = () => {
    clearTimer();
  };

  return (
    <div
      className={'k-srow' + (active ? ' is-active' : '') + (menu ? ' is-menu' : '')}
      data-session-id={s.session_id}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
      {renaming ? (
        <form
          className="k-srow-rename"
          onClick={stop}
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const next = title.trim();
            setRenaming(false);
            setMenu(false);
            if (next && next !== s.title) void kesoku.renameSession(s.session_id, next);
          }}
        >
          <input autoFocus value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} aria-label="会话标题" data-testid="session-rename-input" />
          <button type="button" className="k-btn k-btn-ghost k-btn-sm" onClick={(e) => (stop(e), setRenaming(false), setTitle(s.title))}>
            取消
          </button>
          <button type="submit" className="k-btn k-btn-primary k-btn-sm" data-testid="session-rename-save" onClick={stop}>
            保存
          </button>
        </form>
      ) : (
        <button
          type="button"
          className="k-srow-main"
          onClick={(e) => {
            const t = touchRef.current;
            if (t.longPressed || t.swiped) {
              t.longPressed = false;
              t.swiped = false;
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
            // A touch long-press already opened the menu; don't toggle it twice.
            if (!touchRef.current.longPressed) onEdit('menu');
          }}
        >
          <span className="k-srow-title">
            {m && (
              <span className="k-srow-mode" aria-hidden>
                <ModeIcon mode={m.id} size={18} />
              </span>
            )}
            {s.title || '未命名会话'}
          </span>
          <span className="k-srow-meta">
            {chan && <span className="k-pill k-pill-warn k-pill-sm">[{CHANNEL_LABEL[chan] ?? chan} · {s.app_bound ? '普通接管' : '只读'}]</span>}
            {m && <span className="k-pill k-pill-sm k-pill-neutral">{m.short}</span>}
            <span>{rel(s.updated_at)}</span>
            {s.unread ? <span className="k-dot" aria-label="未读" /> : null}
          </span>
        </button>
      )}
      {!renaming && (
        <button
          type="button"
          className="k-srow-more"
          aria-label={`编辑 ${s.title || '未命名会话'}`}
          data-testid="session-more"
          onClick={(e) => (stop(e), onEdit('menu'))}
        >
          <span aria-hidden>⋯</span>
        </button>
      )}
      {menu && !renaming && (
        <span className="k-srow-actions" onClick={stop}>
          <button
            type="button"
            className="k-btn k-btn-sm"
            data-testid="session-swipe-rename"
            onClick={(e) => {
              stop(e);
              setTitle(s.title);
              setRenaming(true);
            }}
          >
            重命名
          </button>
          <button
            type="button"
            className="k-btn k-btn-sm k-btn-danger"
            data-testid="session-swipe-delete"
            disabled={!!chan}
            title={chan ? '外部渠道会话不可在 App 内删除' : undefined}
            onClick={(e) => {
              stop(e);
              setMenu(false);
              void kesoku.deleteSession(s.session_id);
            }}
          >
            删除
          </button>
          <button type="button" className="k-btn k-btn-sm k-btn-ghost" aria-label="收起" onClick={(e) => (stop(e), setMenu(false))}>
            <UiIcon name="close" size={16} />
          </button>
        </span>
      )}
    </div>
  );
}

/** Long-press / right-click / ⋯ edit menu for one session (rename & delete). Never closes the drawer. */
function SessionEditMenu({ sessionId, mode, onMode, onClose }: { sessionId: string; mode: EditMode; onMode: (m: EditMode) => void; onClose: () => void }) {
  const s = useStore((st) => st.sessions[sessionId]);
  const [title, setTitle] = useState(s?.title ?? '');
  const openedAt = useRef(Date.now());
  useEffect(() => {
    if (!s) onClose();
  }, [s, onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!s) return null;
  const m = modeMeta(s.mode_id || 'chat');
  const foreign = isForeign(s);
  const name = s.title || '未命名会话';
  const save = () => {
    const next = title.trim();
    if (!next) return;
    onClose();
    if (next !== s.title) void kesoku.renameSession(s.session_id, next);
  };
  const node = (
    <div
      className="k-sedit-root"
      data-testid="session-edit-menu"
      role="dialog"
      aria-modal="true"
      aria-label={`编辑会话 ${name}`}
      onClick={stop}
      onTouchStart={stop}
      onTouchEnd={stop}
      onContextMenu={(e) => {
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
        stop(e);
      }}
    >
      <div
        className="k-sedit-scrim"
        onClick={(e) => {
          stop(e);
          // Ignore the trailing synthetic click of the long-press that opened us.
          if (Date.now() - openedAt.current > 350) onClose();
        }}
      />
      <div className="k-sedit-card">
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
            <input autoFocus value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} aria-label="会话标题" data-testid="session-rename-input" />
            <div className="k-sedit-row">
              <button type="button" className="k-btn k-btn-ghost" onClick={onClose}>
                取消
              </button>
              <button type="submit" className="k-btn k-btn-primary" data-testid="session-rename-save" disabled={!title.trim()}>
                保存
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
              重命名对话
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
              删除对话
            </button>
            {foreign && <p className="k-sedit-hint">外部渠道会话不可在 App 内删除</p>}
            <button type="button" className="k-sedit-btn is-cancel" data-testid="session-action-cancel" onClick={onClose}>
              取消
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
  const sessions = useStore((s) => s.sessions);
  const current = useStore((s) => s.currentSessionId);
  const allChannels = useStore((s) => s.settings.allChannels);
  const roleFilter = useStore((s) => s.ui.roleFilter);
  const personas = useStore((s) => s.personas);
  const hits = useStore((s) => s.searchHits);
  const proposals = useStore((s) => s.proposals);
  const conn = useStore((s) => s.conn);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<{ id: string; mode: EditMode } | null>(null);
  const closeEdit = useCallback(() => setEditing(null), []);

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
        .sort((a, b) => b.updated_at - a.updated_at),
    [sessions, allChannels, roleFilter],
  );
  const pending = Object.values(proposals).filter((p) => (p.status ?? 'pending') === 'pending').length;
  const draftRole = useStore((s) => s.ui.draftRole);
  const activeRole = (current ? sessions[current]?.role : undefined) ?? draftRole ?? roleFilter ?? fallbackRoleId(personas);
  const activePersona = personas.find((p) => p.role_id === activeRole) ?? personas[0];
  const activeAvatarSrc = useAvatarUrl(activePersona ? roleAvatarRef(activePersona) : null, activePersona?.avatar_rev);
  const roles = [
    { id: null as string | null, label: '全部' },
    ...personas.map((p) => ({
      id: p.role_id as string | null,
      label: p.display_name || p.role_id,
    })),
  ];
  const go = () => onNavigate?.();

  return (
    <nav
      className="k-spanel"
      aria-label="会话"
      onContextMenu={(e) => {
        // Menu chrome is not text: never show the iOS/desktop callout on buttons, chips or rows.
        const t = e.target as HTMLElement;
        if (!t.closest('input, textarea, [contenteditable="true"]')) e.preventDefault();
      }}
    >
      <div className="k-spanel-search">
        <UiIcon name="search" size={18} className="k-search-icon" />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索历史对话" aria-label="搜索历史对话" id="k-search" />
      </div>
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
        <UiIcon name="plus" size={18} /> 新会话
      </button>
      <div className="k-chips" role="tablist" aria-label="角色筛选">
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
        <span>显示全部渠道 (Discord / 微信)</span>
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
              <span className="k-hit-title">{h.title || sessions[h.session_id]?.title || '会话'}</span>
              <span className="k-hit-snippet">{h.snippet}</span>
              <span className="k-srow-meta">
                {h.role && <span className="k-pill k-pill-sm k-pill-primary">{h.role}</span>}
                {h.chatbot_id && h.chatbot_id !== 'app' && <span className="k-pill k-pill-sm k-pill-warn">{CHANNEL_LABEL[h.chatbot_id] ?? h.chatbot_id}</span>}
                <span>{rel(h.ts)}</span>
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
              onEdit={(mode) => setEditing({ id: s.session_id, mode })}
            />
          ))
        ) : (
          <div className="k-empty">还没有会话 · 点「新会话」开始</div>
        )}
      </div>
      <div className="k-spanel-foot">
        <button type="button" className="k-foot-btn" onClick={() => (actions.setUi({ screen: 'memory', drawerOpen: false }), go())}>
          <UiIcon name="brain" size={20} /> 记忆库{pending > 0 && <span className="k-badge-dot" aria-label={`${pending} 条待确认`}>{pending}</span>}
        </button>
        <button type="button" className="k-foot-btn" onClick={() => (actions.setUi({ screen: 'studio', drawerOpen: false }), go())}>
          <Avatar src={activeAvatarSrc} name={activePersona?.display_name ?? roleFallbackName(activeRole)} size={22} ai={activePersona?.avatar_ai} /> 角色与形象工坊
        </button>
        <button type="button" className="k-foot-btn" onClick={() => (actions.setUi({ screen: 'files', drawerOpen: false }), go())}>
          <UiIcon name="folder" size={20} /> 文件管理
        </button>
        <button type="button" className="k-foot-btn" onClick={() => (actions.setUi({ screen: 'settings', drawerOpen: false }), go())}>
          <UiIcon name="sliders" size={20} /> 设置
        </button>
        <div className="k-conn-line">
          <span className={'k-conn-dot' + (conn.status === 'online' ? (conn.engineOnline ? ' is-ok' : ' is-bad') : conn.status === 'reconnecting' ? ' is-warn' : '')} aria-hidden />
          {conn.status === 'online' ? (conn.engineOnline ? `已连接${conn.latencyMs != null ? ` · ${conn.latencyMs}ms` : ''}` : '引擎离线') : conn.status === 'reconnecting' ? '重连中…' : '未连接'}
        </div>
      </div>
      {editing && <SessionEditMenu key={editing.id} sessionId={editing.id} mode={editing.mode} onMode={(mode) => setEditing({ id: editing.id, mode })} onClose={closeEdit} />}
    </nav>
  );
}

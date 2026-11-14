import { useEffect, useMemo, useState } from 'react';
import type { SessionSummary } from '@kesoku/protocol';
import { Avatar, modeMeta } from '@kesoku/ui';
import { kesoku } from '../../lib/client';
import { actions, useStore } from '../../lib/store';
import { kvSet } from '../../lib/db';
import { useAvatarUrl } from '../persona/avatar';
import { roleAvatarRef } from '../persona/model';

const CHANNEL_LABEL: Record<string, string> = { discord: 'Discord', discord_asuka: 'Discord', wechat: '微信' };

function rel(ts: number): string {
  const d = Date.now() / 1000 - ts;
  if (d < 60) return '刚刚';
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)} 天前`;
  return new Date(ts * 1000).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function SessionRow({ s, active }: { s: SessionSummary; active: boolean }) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(s.title);
  const [confirmDel, setConfirmDel] = useState(false);
  const chan = s.chatbot_id && s.chatbot_id !== 'app' ? s.chatbot_id : null;
  const m = s.mode_id ? modeMeta(s.mode_id) : null;
  let startX = 0;
  return (
    <div
      className={'k-srow' + (active ? ' is-active' : '') + (menu ? ' is-menu' : '')}
      onTouchStart={(e) => (startX = e.touches[0]?.clientX ?? 0)}
      onTouchEnd={(e) => {
        const dx = (e.changedTouches[0]?.clientX ?? 0) - startX;
        if (dx < -50) setMenu(true);
        if (dx > 40) setMenu(false);
      }}
    >
      {renaming ? (
        <form
          className="k-srow-rename"
          onSubmit={(e) => {
            e.preventDefault();
            setRenaming(false);
            setMenu(false);
            if (title.trim()) void kesoku.renameSession(s.session_id, title.trim());
          }}
        >
          <input autoFocus value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} aria-label="会话标题" />
          <button type="submit" className="k-btn k-btn-primary k-btn-sm">
            保存
          </button>
        </form>
      ) : (
        <button type="button" className="k-srow-main" onClick={() => void kesoku.openSession(s.session_id)} onContextMenu={(e) => (e.preventDefault(), setMenu(true))}>
          <span className="k-srow-title">
            {m && m.id !== 'chat' && (
              <span className="k-srow-mode" style={{ color: m.color }} aria-hidden>
                {m.icon}
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
      {menu && !renaming && (
        <span className="k-srow-actions">
          <button type="button" className="k-btn k-btn-sm" onClick={() => setRenaming(true)}>
            重命名
          </button>
          {confirmDel ? (
            <button type="button" className="k-btn k-btn-sm k-btn-danger" onClick={() => void kesoku.deleteSession(s.session_id)}>
              确认删除
            </button>
          ) : (
            <button type="button" className="k-btn k-btn-sm k-btn-danger-ghost" onClick={() => setConfirmDel(true)}>
              删除
            </button>
          )}
          <button type="button" className="k-btn k-btn-sm k-btn-ghost" aria-label="收起" onClick={() => (setMenu(false), setConfirmDel(false))}>
            ✕
          </button>
        </span>
      )}
    </div>
  );
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
  const activeRole = (current ? sessions[current]?.role : undefined) ?? 'asuka';
  const activePersona = personas.find((p) => p.role_id === activeRole) ?? personas[0];
  const activeAvatarSrc = useAvatarUrl(activePersona ? roleAvatarRef(activePersona) : null, activePersona?.avatar_rev);
  const roles = [
    { id: null as string | null, label: '全部' },
    ...(personas.length ? personas : [{ role_id: 'asuka', display_name: '飞鸟' }, { role_id: 'coder', display_name: 'Coder' }, { role_id: 'default', display_name: 'Default' }]).map((p) => ({
      id: p.role_id as string | null,
      label: p.display_name,
    })),
  ];
  const go = () => onNavigate?.();

  return (
    <nav className="k-spanel" aria-label="会话">
      <div className="k-spanel-search">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 搜索历史对话 (FTS5)..." aria-label="搜索历史对话" id="k-search" />
      </div>
      <button
        type="button"
        className="k-new-session"
        onClick={() => {
          useStore.setState({ currentSessionId: null });
          actions.setUi({ launchpad: true, screen: 'chat', drawerOpen: false });
          go();
        }}
      >
        ＋ 新会话
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
              actions.setUi({ roleFilter: r.id });
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
            <div key={s.session_id} onClick={go}>
              <SessionRow s={s} active={s.session_id === current} />
            </div>
          ))
        ) : (
          <div className="k-empty">还没有会话 · 点 ＋ 新会话 开始</div>
        )}
      </div>
      <div className="k-spanel-foot">
        <button type="button" className="k-foot-btn" onClick={() => (actions.setUi({ screen: 'memory', drawerOpen: false }), go())}>
          🧠 记忆库{pending > 0 && <span className="k-badge-dot" aria-label={`${pending} 条待确认`}>{pending}</span>}
        </button>
        <button type="button" className="k-foot-btn" onClick={() => (actions.setUi({ screen: 'studio', drawerOpen: false }), go())}>
          <Avatar src={activeAvatarSrc} name={activePersona?.display_name ?? '飞鸟'} size={22} ai={activePersona?.avatar_ai} /> 🎭 角色与形象工坊
        </button>
        <button type="button" className="k-foot-btn" onClick={() => (actions.setUi({ screen: 'files', drawerOpen: false }), go())}>
          📁 Agent 目录 (band)
        </button>
        <button type="button" className="k-foot-btn" onClick={() => (actions.setUi({ screen: 'settings', drawerOpen: false }), go())}>
          ⚙ 设置
        </button>
        <div className="k-conn-line">
          {conn.status === 'online' ? (conn.engineOnline ? `🟢 引擎已直连${conn.latencyMs != null ? ` · ${conn.latencyMs}ms` : ''}` : '🔴 引擎离线') : conn.status === 'reconnecting' ? '🟡 重连中…' : '⚪ 未连接'}
        </div>
      </div>
    </nav>
  );
}

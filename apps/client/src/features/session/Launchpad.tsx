import { useMemo, useRef, useState } from 'react';
import type { MemoryPolicy, ModeId, PersonaSummary } from '@kesoku/protocol';
import { Avatar, MODE_LIST, ModeIcon, POLICY_BADGE, Sheet, UiIcon, type ModeMeta } from '@kesoku/ui';
import { kesoku } from '../../lib/client';
import { actions, useStore } from '../../lib/store';
import { PolicySegmented } from '../memory/PolicySegmented';
import { useAvatarUrl } from '../persona/avatar';
import { fallbackRoleId, roleAvatarRef, roleFallbackName, sortRoles } from '../persona/model';

const MODEL_LABEL: Record<string, string> = { 'gemini-4-neon': 'Neon · Low' };

function ModeTile({ m, onOpen, onInfo }: { m: ModeMeta; onOpen: () => void; onInfo: () => void }) {
  const policy = useStore((s) => s.policies.policies[m.id]) as MemoryPolicy | undefined;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const long = useRef(false);
  const b = POLICY_BADGE[policy ?? 'confirm_only'];
  return (
    <button
      type="button"
      className="k-mode-tile"
      style={{ ['--mode' as string]: m.color }}
      onPointerDown={() => {
        long.current = false;
        timer.current = setTimeout(() => {
          long.current = true;
          onInfo();
        }, 520);
      }}
      onPointerUp={() => timer.current && clearTimeout(timer.current)}
      onPointerLeave={() => timer.current && clearTimeout(timer.current)}
      onContextMenu={(e) => {
        e.preventDefault();
        onInfo();
      }}
      onClick={() => !long.current && onOpen()}
      aria-label={m.title}
    >
      <span className="k-mode-top">
        <span className="k-mode-icon" aria-hidden>
          <ModeIcon mode={m.id} size={26} />
        </span>
        {m.badge && <span className="k-mode-badge">{m.badge}</span>}
        <span className="k-mode-policy" title={`记忆：${b.label}`}>
          <UiIcon name={b.iconName} size={13} /> {b.label}
        </span>
      </span>
      <span className="k-mode-title">{m.title}</span>
      <span className="k-mode-sub">{m.subtitle}</span>
    </button>
  );
}

function RoleAvatar({ role, size }: { role: PersonaSummary; size: number }) {
  const src = useAvatarUrl(roleAvatarRef(role), role.avatar_rev);
  return <Avatar src={src} name={role.display_name} size={size} ai={role.avatar_ai} />;
}

/** Horizontal role pills: the picked role starts the mode / new session. */
function RolePills({ roles, activeRoleId, onPick, testId }: { roles: PersonaSummary[]; activeRoleId: string; onPick: (r: PersonaSummary) => void; testId?: string }) {
  return (
    <div className="k-launch-roles" role="radiogroup" aria-label="选择对话角色" data-testid={testId}>
      {roles.map((r) => {
        const on = r.role_id === activeRoleId;
        return (
          <button
            key={r.role_id}
            type="button"
            role="radio"
            aria-checked={on}
            className={'k-launch-role' + (on ? ' is-on' : '')}
            data-testid={testId ? `launchpad-role-${r.role_id}` : undefined}
            onClick={() => onPick(r)}
          >
            <RoleAvatar role={r} size={28} />
            <span className="k-launch-role-text">
              <b>{r.display_name || roleFallbackName(r.role_id)}</b>
              {r.tagline ? <small>{r.tagline}</small> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Screen 01 · 8-grid mode launchpad (new session). */
export function Launchpad() {
  const [info, setInfo] = useState<ModeMeta | null>(null);
  const sessions = useStore((s) => s.sessions);
  const recent = Object.values(sessions)
    .filter((x) => (x.chatbot_id ?? 'app') === 'app')
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0) || b.session_id.localeCompare(a.session_id))
    .slice(0, 2);
  const policy = useStore((s) => (info ? s.policies.policies[info.id] : undefined));
  const personas = useStore((s) => s.personas);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const draftRole = useStore((s) => s.ui.draftRole);
  const roleFilter = useStore((s) => s.ui.roleFilter);
  const activeRoleId = (currentSessionId ? sessions[currentSessionId]?.role : null) ?? draftRole ?? roleFilter ?? fallbackRoleId(personas);
  const roleList = useMemo(() => sortRoles(personas), [personas]);
  const activeRole = roleList.find((r) => r.role_id === activeRoleId);
  const activeRoleName = activeRole?.display_name || roleFallbackName(activeRoleId);
  const pickRole = (r: PersonaSummary) => {
    actions.setUi({ draftRole: r.role_id });
    if (currentSessionId && sessions[currentSessionId]?.role !== r.role_id) {
      void kesoku.setRole(currentSessionId, r.role_id).catch(() => actions.toast('切换角色失败', 'error'));
    }
  };
  const start = (id: ModeId) => void kesoku.startMode(id, { role: activeRoleId });
  return (
    <div className="k-launchpad">
      <div className="k-launch-head">
        <h1>想做点什么？</h1>
        <span className="k-launch-hint">点选模式开始 · 长按查看说明与记忆策略 · 或直接在下方打字</span>
      </div>
      {roleList.length > 0 && (
        <section className="k-launch-rolebar" aria-label="对话角色">
          <span className="k-launch-rolebar-label">{currentSessionId ? '对话角色' : '选择对话角色'}</span>
          <RolePills roles={roleList} activeRoleId={activeRoleId} onPick={pickRole} testId="launchpad-role-picker" />
        </section>
      )}
      <div className="k-mode-grid">
        {MODE_LIST.map((m) => (
          <ModeTile key={m.id} m={m} onOpen={() => start(m.id)} onInfo={() => setInfo(m)} />
        ))}
      </div>
      {recent.length > 0 && (
        <div className="k-resume">
          {recent.map((s) => (
            <button key={s.session_id} type="button" className="k-resume-row" onClick={() => void kesoku.openSession(s.session_id)}>
              <span className="k-resume-title">
                <UiIcon name="refresh" size={14} /> {s.title || '未命名会话'}
              </span>
              <span className="k-resume-meta">{new Date(s.updated_at * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            </button>
          ))}
        </div>
      )}
      <Sheet open={!!info} onClose={() => setInfo(null)} title={
          info ? (
            <span className="k-ico-label">
              <ModeIcon mode={info.id} size={22} /> {info.title}
            </span>
          ) : (
            ''
          )
        }>
        {info && (
          <div className="k-mode-info">
            <p className="k-mode-info-sub">{info.subtitle}</p>
            <div className="k-kv">
              <span>默认模型</span>
              <b>{info.defaultModel ? MODEL_LABEL[info.defaultModel] ?? info.defaultModel : '跟随顶栏模型胶囊'}</b>
            </div>
            {roleList.length > 0 && (
              <div className="k-kv k-kv-col">
                <span>对话角色</span>
                <RolePills roles={roleList} activeRoleId={activeRoleId} onPick={pickRole} />
              </div>
            )}
            <div className="k-kv k-kv-col">
              <span>当前模式记忆</span>
              <PolicySegmented modeId={info.id as ModeId} value={policy} />
            </div>
            <button
              type="button"
              className="k-btn k-btn-primary k-btn-block"
              onClick={() => {
                const id = info.id as ModeId;
                setInfo(null);
                start(id);
              }}
            >
              使用「{activeRoleName}」进入{info.title}
            </button>
          </div>
        )}
      </Sheet>
    </div>
  );
}

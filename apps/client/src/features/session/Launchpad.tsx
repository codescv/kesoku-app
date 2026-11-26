import { useMemo, useRef, useState } from 'react';
import type { MemoryPolicy, ModeId, PersonaSummary } from '@kesoku/protocol';
import { Avatar, ModeIcon, Sheet, UiIcon, formatLocaleDateTime, getModeList, getPolicyBadge, modeMeta, useLocale, useT, type ModeMeta } from '@kesoku/ui';
import { kesoku } from '../../lib/client';
import { actions, useStore } from '../../lib/store';
import { PolicySegmented } from '../memory/PolicySegmented';
import { useAvatarUrl } from '../persona/avatar';
import { fallbackRoleId, roleAvatarRef, roleFallbackName, sortRoles } from '../persona/model';

function ModeTile({ m, onOpen, onInfo }: { m: ModeMeta; onOpen: () => void; onInfo: () => void }) {
  const locale = useLocale();
  const t = useT();
  const policy = useStore((s) => s.policies.policies[m.id]) as MemoryPolicy | undefined;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const long = useRef(false);
  const b = getPolicyBadge(policy ?? 'confirm_only', locale);
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
        <span className="k-mode-policy" title={t('policy.badgePrefix', { label: b.label })}>
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
  const t = useT();
  return (
    <div className="k-launch-roles" role="radiogroup" aria-label={t('launchpad.chooseRole')} data-testid={testId}>
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
  const locale = useLocale();
  const t = useT();
  const [infoId, setInfoId] = useState<ModeId | null>(null);
  const modes = useMemo(() => getModeList(locale), [locale]);
  const info = infoId ? modeMeta(infoId, locale) : null;
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
      void kesoku.setRole(currentSessionId, r.role_id).catch(() => actions.toast(t('topbar.switchRoleFailed'), 'error'));
    }
  };
  const start = (id: ModeId) => void kesoku.startMode(id, { role: activeRoleId });
  const defaultModelLabel = (model: string) => (model === 'gemini-4-neon' ? `Neon · ${t('thinking.low')}` : model);
  return (
    <div className="k-launchpad">
      <div className="k-launch-head">
        <h1>{t('launchpad.heading')}</h1>
        <span className="k-launch-hint">{t('launchpad.hint')}</span>
      </div>
      {roleList.length > 0 && (
        <section className="k-launch-rolebar" aria-label={t('launchpad.roleBarAria')}>
          <span className="k-launch-rolebar-label">{currentSessionId ? t('launchpad.roleLabel') : t('launchpad.chooseRole')}</span>
          <RolePills roles={roleList} activeRoleId={activeRoleId} onPick={pickRole} testId="launchpad-role-picker" />
        </section>
      )}
      <div className="k-mode-grid">
        {modes.map((m) => (
          <ModeTile key={m.id} m={m} onOpen={() => start(m.id)} onInfo={() => setInfoId(m.id)} />
        ))}
      </div>
      {recent.length > 0 && (
        <div className="k-resume">
          {recent.map((s) => (
            <button key={s.session_id} type="button" className="k-resume-row" onClick={() => void kesoku.openSession(s.session_id)}>
              <span className="k-resume-title">
                <UiIcon name="refresh" size={14} /> {s.title || t('launchpad.untitledSession')}
              </span>
              <span className="k-resume-meta">
                {formatLocaleDateTime(s.updated_at * 1000, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }, locale)}
              </span>
            </button>
          ))}
        </div>
      )}
      <Sheet open={!!info} onClose={() => setInfoId(null)} title={
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
              <span>{t('launchpad.defaultModel')}</span>
              <b>{info.defaultModel ? defaultModelLabel(info.defaultModel) : t('launchpad.followTopbarModel')}</b>
            </div>
            {roleList.length > 0 && (
              <div className="k-kv k-kv-col">
                <span>{t('launchpad.roleLabel')}</span>
                <RolePills roles={roleList} activeRoleId={activeRoleId} onPick={pickRole} />
              </div>
            )}
            <div className="k-kv k-kv-col">
              <span>{t('launchpad.currentModeMemory')}</span>
              <PolicySegmented modeId={info.id as ModeId} value={policy} />
            </div>
            <button
              type="button"
              className="k-btn k-btn-primary k-btn-block"
              onClick={() => {
                const id = info.id as ModeId;
                setInfoId(null);
                start(id);
              }}
            >
              {t('launchpad.enterModeWithRole', { role: activeRoleName, mode: info.title })}
            </button>
          </div>
        )}
      </Sheet>
    </div>
  );
}

import { useState } from 'react';
import { MODEL_CATALOG, THINKING_LEVELS, type LlmOverride, type ModeId, type ThinkingLevel } from '@kesoku/protocol';
import { Avatar, Capsule, ModeIcon, Sheet, UiIcon, modeMeta } from '@kesoku/ui';
import { kesoku } from '../lib/client';
import { actions, useStore } from '../lib/store';
import { useAvatarUrl } from '../features/persona/avatar';
import { fallbackRoleId, roleAvatarRef, roleFallbackName, sortRoles } from '../features/persona/model';

const LEVEL_LABEL: Record<ThinkingLevel, string> = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High' };
const LEVEL_SHORT: Record<ThinkingLevel, string> = { minimal: 'Min', low: 'L', medium: 'M', high: 'H' };
const MODEL_SHORT_LABEL: Record<string, string> = {
  'gemini-4-neon': 'Neon',
  'gemini-4-hydrogen': 'Hydrogen',
  'gemini-3.5-flash-lite': 'Lite',
  'gemini-4-carbon': 'Carbon',
  'claude-sonnet-5-5': 'Sonnet',
  'claude-opus-5-5': 'Opus',
};

export function modelLabel(o: LlmOverride | null | undefined): string {
  const m = MODEL_CATALOG.find((x) => x.model_name === o?.model_name);
  return `${m?.label ?? 'Neon'} · ${LEVEL_LABEL[(o?.thinking_level ?? 'low') as ThinkingLevel]}`;
}

export function modelShortLabel(o: LlmOverride | null | undefined): string {
  const m = MODEL_CATALOG.find((x) => x.model_name === o?.model_name);
  const shortModel = (o?.model_name && MODEL_SHORT_LABEL[o.model_name]) ?? m?.label ?? 'Neon';
  const shortLevel = LEVEL_SHORT[(o?.thinking_level ?? 'low') as ThinkingLevel] ?? 'L';
  return `${shortModel} · ${shortLevel}`;
}

export function ModelCapsule({ sessionId }: { sessionId: string | null }) {
  const [open, setOpen] = useState(false);
  const override = useStore((s) => (sessionId ? s.llmOverride[sessionId] : null));
  const def = useStore((s) => s.settings.defaultModel);
  const cur = override ?? def;
  return (
    <>
      <Capsule className="k-model-capsule" onClick={() => setOpen(true)} label="模型与思考档位">
        <span className="k-model-label">
          <UiIcon name="spark" size={15} />
          <span className="k-model-text-full">{modelLabel(cur)}</span>
          <span className="k-model-text-short" aria-hidden="true">
            {modelShortLabel(cur)}
          </span>
        </span>
      </Capsule>
      <Sheet open={open} onClose={() => setOpen(false)} title="模型 × 思考档位">
        <div className="k-model-grid" role="grid">
          <div className="k-model-grid-head" role="row">
            <span />
            {THINKING_LEVELS.map((l) => (
              <span key={l} role="columnheader">
                {LEVEL_LABEL[l]}
              </span>
            ))}
          </div>
          {MODEL_CATALOG.map((m) => (
            <div key={m.model_name} className="k-model-grid-row" role="row">
              <span className="k-model-name" role="rowheader">
                <b>{m.label}</b>
                <small>{m.model_name}</small>
              </span>
              {THINKING_LEVELS.map((l) => {
                const on = cur?.model_name === m.model_name && (cur?.thinking_level ?? 'low') === l;
                return (
                  <button
                    key={l}
                    type="button"
                    role="gridcell"
                    aria-pressed={on}
                    className={'k-model-cell' + (on ? ' is-on' : '')}
                    onClick={() => {
                      void kesoku.setModel(sessionId, { llm: m.llm, model_name: m.model_name, thinking_level: l, stream: true });
                      setOpen(false);
                      actions.toast(`下一条消息使用 ${m.label} · ${LEVEL_LABEL[l]}`);
                    }}
                  >
                    {on ? <UiIcon name="check" size={18} /> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </Sheet>
    </>
  );
}

function RoleOptionAvatar({ role }: { role: { role_id: string; display_name: string; avatar_ref?: string | null; avatar_rev?: number; avatar_ai?: boolean } }) {
  const src = useAvatarUrl(roleAvatarRef(role), role.avatar_rev);
  return <Avatar src={src} name={role.display_name} size={36} ai={role.avatar_ai} />;
}

export function RoleModeCapsule({ sessionId, modeId, nestedTitle }: { sessionId: string | null; modeId: ModeId; nestedTitle?: string }) {
  const [open, setOpen] = useState(false);
  const personas = useStore((s) => s.personas);
  const session = useStore((s) => (sessionId ? s.sessions[sessionId] : undefined));
  const pending = useStore((s) => s.ui.pendingMode);
  const effectiveMode = (pending && pending.sessionId === sessionId ? pending.modeId : modeId) as ModeId;
  const draftRole = useStore((s) => s.ui.draftRole);
  const roleFilter = useStore((s) => s.ui.roleFilter);
  const sessionNotesPinned = useStore((s) => (sessionId ? String(s.stateFiles[sessionId]?.['notes.md'] ?? '').trim().length > 0 : false));
  // New Session (no session yet): the role the user picked here / on the Launchpad starts the next session.
  const role = session?.role ?? draftRole ?? roleFilter ?? fallbackRoleId(personas);
  const persona = personas.find((p) => p.role_id === role);
  const avatarSrc = useAvatarUrl(persona ? roleAvatarRef(persona) : null, persona?.avatar_rev);
  const name = persona?.display_name ?? roleFallbackName(role);
  const meta = modeMeta(effectiveMode);
  // Roles come from the engine (persona list); before it arrives show only the active role, generically named.
  const roles = personas.length ? sortRoles(personas) : [{ role_id: role, display_name: name, tagline: '', builtin: true, avatar_rev: 0 }];
  const isDefaultChat = effectiveMode === 'chat' && !sessionId;
  return (
    <>
      <Capsule className="k-role-capsule" onClick={() => setOpen(true)} label="角色与模式">
        <Avatar src={avatarSrc} name={name} size={30} ai={persona?.avatar_ai} />
        <span className="k-role-label">
          <span className="k-role-name">{name.split(' ')[0]}</span>
          <span className={'k-role-sep' + (isDefaultChat ? ' is-default-chat' : '')}> · </span>
          <span className={'k-role-mode' + (isDefaultChat ? ' is-default-chat' : '')} style={{ color: meta.color }}>
            {nestedTitle ?? meta.title}
          </span>
        </span>
      </Capsule>
      <Sheet open={open} onClose={() => setOpen(false)} title="角色与模式">
        <section className="k-rm-section">
          <h3>{sessionId ? '切换角色' : '选择对话角色'}</h3>
          <div className="k-rm-roles">
            {roles.map((r) => (
              <button
                key={r.role_id}
                type="button"
                className={'k-rm-role' + (r.role_id === role ? ' is-on' : '')}
                aria-pressed={r.role_id === role}
                data-testid={`topbar-role-${r.role_id}`}
                onClick={() => {
                  actions.setUi({ draftRole: r.role_id });
                  if (sessionId) void kesoku.setRole(sessionId, r.role_id).catch(() => actions.toast('切换角色失败', 'error'));
                  else actions.toast(`已选择角色：${r.display_name}`);
                  setOpen(false);
                }}
              >
                <RoleOptionAvatar role={r} />
                <span>
                  <b>{r.display_name}</b>
                  {r.tagline && <small>{r.tagline}</small>}
                </span>
                {r.role_id === role && <span className="k-pill k-pill-primary k-pill-sm">当前</span>}
              </button>
            ))}
          </div>
          {sessionId && (
            <button
              type="button"
              className="k-link-row k-link-row-session-notes"
              data-testid="topbar-session-notes-btn"
              onClick={() => (setOpen(false), actions.setUi({ sessionNotesId: sessionId }))}
            >
              <span>
                <UiIcon name="pin" size={18} /> 置顶 Notes
                {sessionNotesPinned && <span className="k-pill k-pill-primary k-pill-sm">已置顶</span>}
              </span>
              <UiIcon name="chevron-right" size={18} />
            </button>
          )}
        </section>
        {sessionId && effectiveMode !== 'chat' && (
          <section className="k-rm-section k-rm-mode" data-testid="topbar-mode-section">
            <div className="k-rm-mode-row">
              <span className="k-rm-mode-name" style={{ color: meta.color }}>
                <ModeIcon mode={effectiveMode} size={20} /> {meta.title}
              </span>
              <button
                type="button"
                className="k-btn k-btn-ghost k-btn-sm"
                data-testid="topbar-stop-mode"
                onClick={() => (setOpen(false), void kesoku.stopMode(sessionId))}
              >
                退出当前模式
              </button>
            </div>
          </section>
        )}
      </Sheet>
    </>
  );
}

export function TopBar({ sessionId, modeId, nestedTitle, onMenu, showMenu }: { sessionId: string | null; modeId: ModeId; nestedTitle?: string; onMenu: () => void; showMenu: boolean }) {
  return (
    <header className="k-topbar" style={{ ['--mode' as string]: modeMeta(modeId).color }}>
      {showMenu ? (
        <button type="button" className="k-icon-btn" aria-label="打开会话抽屉" onClick={onMenu}>
          <UiIcon name="menu" size={22} />
        </button>
      ) : (
        <span className="k-topbar-spacer" />
      )}
      <div className="k-topbar-center">
        <RoleModeCapsule sessionId={sessionId} modeId={modeId} nestedTitle={nestedTitle} />
      </div>
      <ModelCapsule sessionId={sessionId} />
    </header>
  );
}

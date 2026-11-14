import { useState } from 'react';
import { MODEL_CATALOG, THINKING_LEVELS, type LlmOverride, type ModeId, type ThinkingLevel } from '@kesoku/protocol';
import { Avatar, Capsule, Sheet, modeMeta } from '@kesoku/ui';
import { kesoku } from '../lib/client';
import { actions, useStore } from '../lib/store';
import { PolicySegmented } from '../features/memory/PolicySegmented';
import { useAvatarUrl } from '../features/persona/avatar';
import { roleAvatarRef } from '../features/persona/model';

const LEVEL_LABEL: Record<ThinkingLevel, string> = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High' };

export function modelLabel(o: LlmOverride | null | undefined): string {
  const m = MODEL_CATALOG.find((x) => x.model_name === o?.model_name);
  return `${m?.label ?? 'Hydrogen'} · ${LEVEL_LABEL[(o?.thinking_level ?? 'low') as ThinkingLevel]}`;
}

export function ModelCapsule({ sessionId }: { sessionId: string | null }) {
  const [open, setOpen] = useState(false);
  const override = useStore((s) => (sessionId ? s.llmOverride[sessionId] : null));
  const def = useStore((s) => s.settings.defaultModel);
  const cur = override ?? def;
  return (
    <>
      <Capsule className="k-model-capsule" onClick={() => setOpen(true)} label="模型与思考档位">
        <span className="k-model-label">{modelLabel(cur)}</span>
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
                    {on ? '✓' : ''}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <p className="k-sheet-note">一次点击即生效于下一条消息 · Hydrogen 不支持显式缓存</p>
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
  const role = session?.role ?? 'asuka';
  const persona = personas.find((p) => p.role_id === role);
  const avatarSrc = useAvatarUrl(persona ? roleAvatarRef(persona) : null, persona?.avatar_rev);
  const name = persona?.display_name ?? (role === 'asuka' ? '飞鸟 Asuka' : role);
  const meta = modeMeta(effectiveMode);
  const roles = personas.length
    ? personas
    : [
        { role_id: 'asuka', display_name: '飞鸟 Asuka', tagline: '毒舌傲娇的专属伴游与日语私教', builtin: true, avatar_rev: 0 },
        { role_id: 'coder', display_name: 'Coder', tagline: '将编码任务委派给引擎主机上的本地 CLI 编码代理', builtin: true, avatar_rev: 0 },
        { role_id: 'default', display_name: 'Default', tagline: '通用助手', builtin: true, avatar_rev: 0 },
      ];
  return (
    <>
      <Capsule className="k-role-capsule" onClick={() => setOpen(true)} label="角色与模式">
        <Avatar src={avatarSrc} name={name} size={30} ai={persona?.avatar_ai} />
        <span className="k-role-label">
          {name.split(' ')[0]}
          {effectiveMode !== 'chat' || sessionId ? <span className="k-role-sep"> · </span> : null}
          {(effectiveMode !== 'chat' || sessionId) && (
            <span className="k-role-mode" style={{ color: meta.color }}>
              {nestedTitle ?? meta.title}
            </span>
          )}
        </span>
      </Capsule>
      <Sheet open={open} onClose={() => setOpen(false)} title="角色与模式">
        <section className="k-rm-section">
          <h3>切换角色</h3>
          <div className="k-rm-roles">
            {roles.map((r) => (
              <button
                key={r.role_id}
                type="button"
                className={'k-rm-role' + (r.role_id === role ? ' is-on' : '')}
                disabled={!sessionId}
                onClick={() => {
                  if (sessionId) void kesoku.setRole(sessionId, r.role_id).catch(() => actions.toast('切换角色失败', 'error'));
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
          <button type="button" className="k-link-row" onClick={() => (setOpen(false), actions.setUi({ screen: 'studio' }))}>
            🎭 管理角色与形象 ›
          </button>
          <button type="button" className="k-link-row" onClick={() => (setOpen(false), actions.setUi({ screen: 'files' }))}>
            📁 Agent 目录 (band) ›
          </button>
        </section>
        <section className="k-rm-section">
          <h3>
            当前模式 · <span style={{ color: meta.color }}>{meta.icon} {meta.title}</span>
          </h3>
          <div className="k-rm-actions">
            {effectiveMode !== 'chat' && sessionId && (
              <button type="button" className="k-btn k-btn-ghost" onClick={() => (setOpen(false), void kesoku.stopMode(sessionId))}>
                退出模式
              </button>
            )}
            <button type="button" className="k-btn k-btn-primary" onClick={() => (setOpen(false), actions.setUi({ launchpad: true, screen: 'chat' }))}>
              切换模式
            </button>
          </div>
          <div className="k-rm-policy">
            <span>当前模式记忆：</span>
            <PolicySegmented modeId={effectiveMode} size="sm" />
          </div>
          <p className="k-sheet-note">仅改当前模式 · 其余模式去 设置 → 各模式记忆策略</p>
        </section>
      </Sheet>
    </>
  );
}

export function TopBar({ sessionId, modeId, nestedTitle, onMenu, showMenu }: { sessionId: string | null; modeId: ModeId; nestedTitle?: string; onMenu: () => void; showMenu: boolean }) {
  return (
    <header className="k-topbar" style={{ ['--mode' as string]: modeMeta(modeId).color }}>
      {showMenu ? (
        <button type="button" className="k-icon-btn" aria-label="打开会话抽屉" onClick={onMenu}>
          ☰
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

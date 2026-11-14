import { useRef, useState } from 'react';
import type { MemoryPolicy, ModeId } from '@kesoku/protocol';
import { MODE_LIST, POLICY_BADGE, Sheet, type ModeMeta } from '@kesoku/ui';
import { kesoku } from '../../lib/client';
import { useStore } from '../../lib/store';
import { PolicySegmented } from '../memory/PolicySegmented';

const MODEL_LABEL: Record<string, string> = { 'gemini-3.8-flash': 'Flash 3.8 · Low' };

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
          {m.icon}
        </span>
        {m.badge && <span className="k-mode-badge">{m.badge}</span>}
        <span className="k-mode-policy" title={`记忆：${b.label}`}>
          {b.icon} {b.label}
        </span>
      </span>
      <span className="k-mode-title">{m.title}</span>
      <span className="k-mode-sub">{m.subtitle}</span>
    </button>
  );
}

/** Screen 01 · 8-grid mode launchpad (new session). */
export function Launchpad() {
  const [info, setInfo] = useState<ModeMeta | null>(null);
  const sessions = useStore((s) => s.sessions);
  const recent = Object.values(sessions)
    .filter((x) => (x.chatbot_id ?? 'app') === 'app')
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, 2);
  const policy = useStore((s) => (info ? s.policies.policies[info.id] : undefined));
  return (
    <div className="k-launchpad">
      <div className="k-launch-head">
        <h1>想做点什么？</h1>
        <span className="k-launch-hint">点选模式开始 · 长按查看说明与记忆策略 · 或直接在下方打字</span>
      </div>
      <div className="k-mode-grid">
        {MODE_LIST.map((m) => (
          <ModeTile key={m.id} m={m} onOpen={() => void kesoku.startMode(m.id)} onInfo={() => setInfo(m)} />
        ))}
      </div>
      {recent.length > 0 && (
        <div className="k-resume">
          {recent.map((s) => (
            <button key={s.session_id} type="button" className="k-resume-row" onClick={() => void kesoku.openSession(s.session_id)}>
              <span className="k-resume-title">↩ {s.title || '未命名会话'}</span>
              <span className="k-resume-meta">{new Date(s.updated_at * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            </button>
          ))}
        </div>
      )}
      <Sheet open={!!info} onClose={() => setInfo(null)} title={info ? `${info.icon} ${info.title}` : ''}>
        {info && (
          <div className="k-mode-info">
            <p className="k-mode-info-sub">{info.subtitle}</p>
            <div className="k-kv">
              <span>默认模型</span>
              <b>{info.defaultModel ? MODEL_LABEL[info.defaultModel] ?? info.defaultModel : '跟随顶栏模型胶囊'}</b>
            </div>
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
                void kesoku.startMode(id);
              }}
            >
              进入{info.title}
            </button>
          </div>
        )}
      </Sheet>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { MODE_IDS, type EngineToClientPayload, type MemoryFile } from '@kesoku/protocol';
import { modeMeta, POLICY_BADGE } from '@kesoku/ui';
import { kesoku } from '../../lib/client';
import { actions, useStore } from '../../lib/store';
import { ProposalCard } from '../proposals/ProposalCard';

export function validMemoryPath(p: string): boolean {
  return /^[\w\u4e00-\u9fff\-./]+\.md$/.test(p) && !p.split('/').includes('..') && !p.startsWith('/') && !p.includes('\\');
}

export function policySummary(policies: Record<string, string>, defaults: Record<string, string>): string {
  const dev = MODE_IDS.filter((m) => policies[m] && policies[m] !== defaults[m]);
  if (!dev.length) return '默认：日常聊天[自动] · 其余7模式[确认]（各模式支持单独设 自动/确认/忽略）';
  return dev.map((m) => `${modeMeta(m).title}[${POLICY_BADGE[policies[m] as 'full'].label}]`).join(' · ');
}

/** `$MEMORY_DIR` manager: pending proposals, PINNED-first file list, inline editor (memory.put). */
export function MemoryPanel({ embedded }: { embedded?: boolean }) {
  const current = useStore((s) => s.currentSessionId);
  const sessionRole = useStore((s) => (current ? s.sessions[current]?.role : undefined));
  const personas = useStore((s) => s.personas);
  const proposalsAll = useStore((s) => s.proposals);
  const policies = useStore((s) => s.policies);
  const [role, setRole] = useState(sessionRole ?? 'asuka');
  const [files, setFiles] = useState<MemoryFile[] | null>(null);
  const [open, setOpen] = useState<{ rel_path: string; content: string; pinned: boolean; dirty: boolean } | null>(null);
  const [newPath, setNewPath] = useState('');
  const pending = useMemo(() => Object.values(proposalsAll).filter((p) => (p.status ?? 'pending') === 'pending'), [proposalsAll]);

  useEffect(() => {
    if (sessionRole) setRole(sessionRole);
  }, [sessionRole]);

  const load = useCallback(() => {
    setFiles(null);
    kesoku
      .rpc<EngineToClientPayload<'memory.list.result'>>('memory.list', { role })
      .then((r) => setFiles([...r.files].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.rel_path.localeCompare(b.rel_path))))
      .catch(() => setFiles([]));
  }, [role]);
  useEffect(load, [load]);

  async function openFile(rel_path: string) {
    try {
      const r = await kesoku.rpc<EngineToClientPayload<'memory.get.result'>>('memory.get', { role, rel_path });
      setOpen({ rel_path, content: r.content, pinned: r.pinned, dirty: false });
    } catch {
      actions.toast('读取失败', 'error');
    }
  }
  async function saveFile() {
    if (!open) return;
    try {
      await kesoku.rpc('memory.put', { role, rel_path: open.rel_path, content: open.content });
      setOpen({ ...open, dirty: false });
      actions.toast('已保存');
      load();
    } catch {
      actions.toast('保存失败', 'error');
    }
  }
  async function togglePin(f: { rel_path: string; pinned: boolean }) {
    try {
      await kesoku.rpc('memory.pin', { role, rel_path: f.rel_path, pinned: !f.pinned });
      if (open?.rel_path === f.rel_path) setOpen({ ...open, pinned: !f.pinned });
      load();
    } catch {
      actions.toast('置顶失败', 'error');
    }
  }

  const roles = personas.length ? personas.map((p) => ({ id: p.role_id, name: p.display_name })) : [{ id: 'asuka', name: '飞鸟' }, { id: 'coder', name: 'Coder' }, { id: 'default', name: 'Default' }];

  return (
    <div className={'k-memory' + (embedded ? ' is-embedded' : '')}>
      <div className="k-memory-head">
        <h2>$MEMORY_DIR 记忆库</h2>
        <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="角色">
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </div>

      <section className="k-memory-pending">
        <div className="k-memory-pending-head">
          <b>⏳ 待确认提案 ({pending.length})</b>
          {pending.length > 1 && (
            <span className="k-memory-batch">
              <button type="button" className="k-btn k-btn-sm k-btn-ghost" onClick={() => pending.forEach((p) => void kesoku.resolveProposal(p.proposal_id, 'dismiss').catch(() => {}))}>
                全部忽略
              </button>
              <button type="button" className="k-btn k-btn-sm k-btn-primary" onClick={() => pending.forEach((p) => void kesoku.resolveProposal(p.proposal_id, 'confirm').catch(() => {}))}>
                全部确认
              </button>
            </span>
          )}
        </div>
        {pending.length === 0 ? <div className="k-empty">暂无待确认的记忆提案</div> : pending.map((p) => <ProposalCard key={p.proposal_id} proposal={p} compact />)}
      </section>

      {open ? (
        <section className="k-memory-editor">
          <div className="k-memory-editor-head">
            <button type="button" className="k-icon-btn" aria-label="返回列表" onClick={() => setOpen(null)}>
              ←
            </button>
            <b className="k-memory-path">{open.rel_path}</b>
            <button type="button" className={'k-pill k-pill-sm ' + (open.pinned ? 'k-pill-warn' : 'k-pill-neutral')} onClick={() => void togglePin(open)}>
              {open.pinned ? '📌 PINNED' : '置顶'}
            </button>
          </div>
          <textarea className="k-memory-text" value={open.content} spellCheck={false} onChange={(e) => setOpen({ ...open, content: e.target.value, dirty: true })} aria-label="记忆内容" />
          <div className="k-memory-editor-actions">
            <button type="button" className="k-btn k-btn-primary" disabled={!open.dirty} onClick={() => void saveFile()}>
              保存
            </button>
          </div>
        </section>
      ) : (
        <section className="k-memory-files">
          {files === null && <div className="k-empty">载入中…</div>}
          {files?.map((f) => (
            <div key={f.rel_path} className="k-memory-file">
              <button type="button" className="k-memory-file-main" onClick={() => void openFile(f.rel_path)}>
                {f.pinned && <span className="k-pill k-pill-warn k-pill-sm">[PINNED]</span>}
                <span className="k-memory-path">{f.rel_path}</span>
                {f.tags?.map((t) => (
                  <span key={t} className="k-pill k-pill-accent k-pill-sm">
                    #{t}
                  </span>
                ))}
              </button>
              <button type="button" className="k-btn k-btn-sm k-btn-ghost" onClick={() => void togglePin(f)} aria-label={f.pinned ? '取消置顶' : '置顶'}>
                {f.pinned ? '📌' : '📍'}
              </button>
            </div>
          ))}
          <form
            className="k-memory-new"
            onSubmit={(e) => {
              e.preventDefault();
              const p = newPath.trim();
              if (!validMemoryPath(p)) return actions.toast('路径需为 .md 且不得包含 ..', 'error');
              setOpen({ rel_path: p, content: '', pinned: false, dirty: true });
              setNewPath('');
            }}
          >
            <input value={newPath} onChange={(e) => setNewPath(e.target.value)} placeholder="topics/new_note.md" aria-label="新建记忆文件路径" />
            <button type="submit" className="k-btn k-btn-sm">
              ＋ 新建
            </button>
          </form>
        </section>
      )}

      <button type="button" className="k-memory-foot" onClick={() => actions.setUi({ screen: 'settings' })}>
        {policySummary(policies.policies, policies.defaults)} ›
      </button>
    </div>
  );
}

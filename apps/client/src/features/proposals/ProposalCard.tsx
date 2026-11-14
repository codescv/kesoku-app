import { useState } from 'react';
import type { MemoryProposal, ProposalOp } from '@kesoku/protocol';
import { kesoku } from '../../lib/client';
import { actions } from '../../lib/store';

/**
 * Inline `confirm_only` memory confirmation card (UI doc §5.1). Not a modal, never steals focus.
 * `$MEMORY_DIR` changes only after [✓ 记录到记忆库].
 */
export function ProposalCard({ proposal, compact }: { proposal: MemoryProposal; compact?: boolean }) {
  const [ops, setOps] = useState<ProposalOp[]>(proposal.ops);
  const [checked, setChecked] = useState<boolean[]>(() => proposal.ops.map(() => true));
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const status = proposal.status ?? 'pending';
  const edited = ops.some((o, i) => o.text !== proposal.ops[i]?.text || o.file !== proposal.ops[i]?.file) || checked.some((c) => !c);

  async function resolve(action: 'confirm' | 'dismiss') {
    setBusy(true);
    try {
      const chosen = ops.filter((_, i) => checked[i]);
      await kesoku.resolveProposal(proposal.proposal_id, action, action === 'confirm' && edited ? chosen : undefined);
    } catch (e) {
      const code = (e as { code?: string }).code;
      actions.toast(code === 'PROPOSAL_NOT_PENDING' ? '该提案已处理或已过期' : '操作失败，请重试', 'error');
    } finally {
      setBusy(false);
    }
  }

  if (status !== 'pending') {
    const files = proposal.applied_files?.length ? proposal.applied_files : [...new Set(proposal.ops.map((o) => o.file))];
    return (
      <div className={`k-proposal is-${status}`} role="status">
        {status === 'applied' && <>✓ 已记录 · {files.join('、')}</>}
        {status === 'dismissed' && <>✕ 已忽略 · 同一事实不再提示</>}
        {status === 'expired' && <>⌛ 已过期 · 需在对话中重新提及</>}
      </div>
    );
  }

  return (
    <div className={'k-proposal' + (compact ? ' is-compact' : '')} role="group" aria-label="记忆确认">
      <div className="k-proposal-title">💡 发现可记录的现实记忆 · 需你确认</div>
      <ul className="k-proposal-ops">
        {ops.map((op, i) => (
          <li key={i} className={checked[i] ? '' : 'is-off'}>
            <label className="k-proposal-check">
              <input type="checkbox" checked={checked[i]} onChange={() => setChecked((c) => c.map((x, j) => (j === i ? !x : x)))} aria-label="选择此条" />
            </label>
            <span className="k-pill k-pill-primary k-pill-sm k-proposal-file">{op.file}</span>
            {editing === i ? (
              <input
                className="k-proposal-edit"
                autoFocus
                maxLength={500}
                value={op.text}
                onChange={(e) => setOps((arr) => arr.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                onBlur={() => setEditing(null)}
                onKeyDown={(e) => e.key === 'Enter' && setEditing(null)}
              />
            ) : (
              <button type="button" className="k-proposal-text" onClick={() => setEditing(i)} title="轻点编辑">
                · {op.text}
              </button>
            )}
            {op.tags?.length > 0 && (
              <span className="k-proposal-tags">
                {op.tags.map((t) => (
                  <span key={t} className="k-pill k-pill-accent k-pill-sm">
                    #{t.replace(/^#+/, '')}
                  </span>
                ))}
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className="k-proposal-actions">
        <button type="button" className="k-btn k-btn-ghost" disabled={busy} onClick={() => resolve('dismiss')}>
          ✕ 忽略
        </button>
        <button type="button" className="k-btn k-btn-primary" disabled={busy || !checked.some(Boolean)} onClick={() => resolve('confirm')}>
          ✓ 记录到记忆库
        </button>
      </div>
    </div>
  );
}

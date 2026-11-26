import { useState } from 'react';
import type { MemoryProposal, ProposalOp } from '@kesoku/protocol';
import { kesoku } from '../../lib/client';
import { actions } from '../../lib/store';
import { UiIcon, useT } from '@kesoku/ui';

/**
 * Inline `confirm_only` memory confirmation card (UI doc §5.1). Not a modal, never steals focus.
 * The memory library changes only after confirming.
 */
export function ProposalCard({ proposal, compact }: { proposal: MemoryProposal; compact?: boolean }) {
  const tr = useT();
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
      actions.toast(code === 'PROPOSAL_NOT_PENDING' ? tr('proposal.alreadyResolved') : tr('proposal.actionFailed'), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (status !== 'pending') {
    const files = proposal.applied_files?.length ? proposal.applied_files : [...new Set(proposal.ops.map((o) => o.file))];
    return (
      <div className={`k-proposal is-${status}`} role="status">
        {status === 'applied' && (
          <>
            <UiIcon name="check" size={16} /> {tr('proposal.applied', { files: files.join('、') })}
          </>
        )}
        {status === 'dismissed' && (
          <>
            <UiIcon name="close" size={16} /> {tr('proposal.dismissed')}
          </>
        )}
        {status === 'expired' && (
          <>
            <UiIcon name="clock" size={16} /> {tr('proposal.expired')}
          </>
        )}
      </div>
    );
  }

  return (
    <div className={'k-proposal' + (compact ? ' is-compact' : '')} role="group" aria-label={tr('proposal.ariaLabel')}>
      <div className="k-proposal-title">
        <UiIcon name="brain" size={18} /> {tr('proposal.title')}
      </div>
      <ul className="k-proposal-ops">
        {ops.map((op, i) => (
          <li key={i} className={checked[i] ? '' : 'is-off'}>
            <label className="k-proposal-check">
              <input type="checkbox" checked={checked[i]} onChange={() => setChecked((c) => c.map((x, j) => (j === i ? !x : x)))} aria-label={tr('proposal.selectItemAria')} />
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
              <button type="button" className="k-proposal-text" onClick={() => setEditing(i)} title={tr('proposal.tapToEdit')}>
                · {op.text}
              </button>
            )}
            {op.tags?.length > 0 && (
              <span className="k-proposal-tags">
                {op.tags.map((tag) => (
                  <span key={tag} className="k-pill k-pill-accent k-pill-sm">
                    #{tag.replace(/^#+/, '')}
                  </span>
                ))}
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className="k-proposal-actions">
        <button type="button" className="k-btn k-btn-ghost" disabled={busy} onClick={() => resolve('dismiss')}>
          <UiIcon name="close" size={16} /> {tr('proposal.ignore')}
        </button>
        <button type="button" className="k-btn k-btn-primary" disabled={busy || !checked.some(Boolean)} onClick={() => resolve('confirm')}>
          <UiIcon name="check" size={16} /> {tr('proposal.confirmSave')}
        </button>
      </div>
    </div>
  );
}

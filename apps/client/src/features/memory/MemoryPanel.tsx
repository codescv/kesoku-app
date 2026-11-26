import { useCallback, useEffect, useMemo, useState } from 'react';
import { MODE_IDS, type EngineToClientPayload, type MemoryFile, type MemoryPolicy } from '@kesoku/protocol';
import { fileIconName, getPolicyBadge, modeMeta, t, UiIcon, useLocale, useT } from '@kesoku/ui';
import { kesoku } from '../../lib/client';
import { actions, useStore } from '../../lib/store';
import { ProposalCard } from '../proposals/ProposalCard';
import { Markdown } from '../segments/Markdown';
import { fallbackRoleId } from '../persona/model';

export function validMemoryPath(p: string): boolean {
  return /^[\w\u4e00-\u9fff\-./]+\.md$/.test(p) && !p.split('/').includes('..') && !p.startsWith('/') && !p.includes('\\');
}

export function policySummary(policies: Record<string, string>, defaults: Record<string, string>): string {
  const dev = MODE_IDS.filter((m) => policies[m] && policies[m] !== defaults[m]);
  if (!dev.length) return t('policy.summaryDefault');
  return dev.map((m) => `${modeMeta(m).title}[${getPolicyBadge(policies[m] as MemoryPolicy).label}]`).join(' · ');
}

/**
 * Split a leading YAML frontmatter block (`---\n…\n---`) from a memory file for the read view.
 * Returns simple `key: value` pairs (list values joined) and the Markdown body; no frontmatter → whole text as body.
 */
export function stripFrontmatterForPreview(text: string): { meta: Array<{ key: string; value: string }>; body: string } {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { meta: [], body: text };
  const meta: Array<{ key: string; value: string }> = [];
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      meta.push({ key: kv[1], value: kv[2].trim().replace(/^\[(.*)\]$/, '$1').replace(/^["'](.*)["']$/, '$1') });
      continue;
    }
    const item = /^\s*-\s+(.*)$/.exec(line);
    const last = meta[meta.length - 1];
    if (item && last) last.value = last.value ? `${last.value}, ${item[1].trim()}` : item[1].trim();
  }
  return { meta: meta.filter((x) => x.value), body: text.slice(m[0].length) };
}

function MemoryPreview({ content }: { content: string }) {
  const tr = useT();
  const { meta, body } = useMemo(() => stripFrontmatterForPreview(content), [content]);
  return (
    <div className="k-memory-md-preview">
      {meta.length > 0 && (
        <dl className="k-memory-meta">
          {meta.map((x) => (
            <div key={x.key} className="k-memory-meta-row">
              <dt>{x.key}</dt>
              <dd>{x.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {body.trim() ? <Markdown text={body} /> : <div className="k-empty">{tr('memory.emptyPreview')}</div>}
    </div>
  );
}

/** Memory library: pending proposals, pinned-first file list, inline editor (memory.put). */
export function MemoryPanel({ embedded }: { embedded?: boolean }) {
  const _locale = useLocale();
  const tr = useT();
  const current = useStore((s) => s.currentSessionId);
  const sessionRole = useStore((s) => (current ? s.sessions[current]?.role : undefined));
  const personas = useStore((s) => s.personas);
  const proposalsAll = useStore((s) => s.proposals);
  const policies = useStore((s) => s.policies);
  const [role, setRole] = useState(sessionRole ?? fallbackRoleId(personas));
  const [files, setFiles] = useState<MemoryFile[] | null>(null);
  const [open, setOpen] = useState<{ rel_path: string; content: string; pinned: boolean; dirty: boolean } | null>(null);
  const [newPath, setNewPath] = useState('');
  const [editing, setEditing] = useState(false);
  const pending = useMemo(() => Object.values(proposalsAll).filter((p) => (p.status ?? 'pending') === 'pending'), [proposalsAll]);

  useEffect(() => {
    if (sessionRole) setRole(sessionRole);
  }, [sessionRole]);
  // Roles arrive after mount: fall back to the first known role when the current one does not exist.
  useEffect(() => {
    if (!sessionRole && personas.length && !personas.some((p) => p.role_id === role)) setRole(fallbackRoleId(personas));
  }, [personas, role, sessionRole]);

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
      setEditing(!r.content.trim());
    } catch {
      actions.toast(tr('memory.readFailed'), 'error');
    }
  }
  async function saveFile() {
    if (!open) return;
    try {
      await kesoku.rpc('memory.put', { role, rel_path: open.rel_path, content: open.content });
      setOpen({ ...open, dirty: false });
      actions.toast(tr('common.saved'));
      load();
    } catch {
      actions.toast(tr('common.saveFailed'), 'error');
    }
  }
  async function togglePin(f: { rel_path: string; pinned: boolean }) {
    try {
      await kesoku.rpc('memory.pin', { role, rel_path: f.rel_path, pinned: !f.pinned });
      if (open?.rel_path === f.rel_path) setOpen({ ...open, pinned: !f.pinned });
      load();
    } catch {
      actions.toast(tr('memory.pinFailed'), 'error');
    }
  }

  const roles = personas.length ? personas.map((p) => ({ id: p.role_id, name: p.display_name || p.role_id })) : [{ id: role, name: role }];

  return (
    <div className={'k-memory' + (embedded ? ' is-embedded' : '')} data-locale={_locale}>
      {embedded && (
        <div className="k-inspector-tabs" role="tablist" aria-label={tr('memory.inspectorTabsAria')}>
          <button
            type="button"
            role="tab"
            aria-selected={true}
            className="k-inspector-tab is-active"
            data-testid="inspector-tab-memory"
            onClick={() => actions.setUi({ inspector: { kind: 'memory' } })}
          >
            <UiIcon name="brain" size={15} />
            <span>{tr('session.memory')}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={false}
            className="k-inspector-tab"
            data-testid="inspector-tab-notes"
            onClick={() => actions.setUi({ inspector: { kind: 'notes' } })}
          >
            <UiIcon name="note" size={15} />
            <span>{tr('session.notes')}</span>
          </button>
        </div>
      )}
      <div className="k-memory-head">
        <h2>
          <UiIcon name="brain" size={20} /> {tr('session.memory')}
        </h2>
        <select value={role} onChange={(e) => setRole(e.target.value)} aria-label={tr('memory.roleAria')}>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </div>

      <section className="k-memory-pending">
        <div className="k-memory-pending-head">
          <b>{tr('memory.pendingCount', { count: pending.length })}</b>
          {pending.length > 1 && (
            <span className="k-memory-batch">
              <button type="button" className="k-btn k-btn-sm k-btn-ghost" onClick={() => pending.forEach((p) => void kesoku.resolveProposal(p.proposal_id, 'dismiss').catch(() => {}))}>
                {tr('memory.dismissAll')}
              </button>
              <button type="button" className="k-btn k-btn-sm k-btn-primary" onClick={() => pending.forEach((p) => void kesoku.resolveProposal(p.proposal_id, 'confirm').catch(() => {}))}>
                {tr('memory.confirmAll')}
              </button>
            </span>
          )}
        </div>
        {pending.length === 0 ? <div className="k-empty">{tr('memory.noPending')}</div> : pending.map((p) => <ProposalCard key={p.proposal_id} proposal={p} compact />)}
      </section>

      {open ? (
        <section className="k-memory-editor">
          <div className="k-memory-editor-head">
            <button type="button" className="k-icon-btn" aria-label={tr('memory.backToListAria')} onClick={() => setOpen(null)}>
              <UiIcon name="arrow-left" size={20} />
            </button>
            <b className="k-memory-path">{open.rel_path}</b>
            <button type="button" className={'k-pill k-pill-sm ' + (open.pinned ? 'k-pill-warn' : 'k-pill-neutral')} onClick={() => void togglePin(open)}>
              <UiIcon name="pin" size={13} /> {open.pinned ? tr('memory.pinned') : tr('memory.setPinned')}
            </button>
            <button type="button" className="k-btn k-btn-sm k-btn-ghost k-memory-mode" aria-pressed={editing} onClick={() => setEditing((v) => !v)}>
              <UiIcon name={editing ? 'file-text' : 'edit'} size={14} /> {editing ? tr('common.preview') : tr('common.edit')}
            </button>
          </div>
          {editing ? (
            <textarea className="k-memory-text" value={open.content} spellCheck={false} onChange={(e) => setOpen({ ...open, content: e.target.value, dirty: true })} aria-label={tr('memory.contentAria')} />
          ) : (
            <MemoryPreview content={open.content} />
          )}
          <div className="k-memory-editor-actions">
            <button type="button" className="k-btn k-btn-primary" disabled={!open.dirty} onClick={() => void saveFile()}>
              <UiIcon name="save" size={18} /> {tr('common.save')}
            </button>
          </div>
        </section>
      ) : (
        <section className="k-memory-files">
          {files === null && <div className="k-empty">{tr('common.loading')}</div>}
          {files?.map((f) => (
            <div key={f.rel_path} className="k-memory-file">
              <button type="button" className="k-memory-file-main" onClick={() => void openFile(f.rel_path)}>
                <UiIcon name={fileIconName(f.rel_path)} size={18} className="k-memory-file-icon" />
                {f.pinned && <span className="k-pill k-pill-warn k-pill-sm">{tr('memory.pinned')}</span>}
                <span className="k-memory-path">{f.rel_path}</span>
                {f.tags?.map((tag) => (
                  <span key={tag} className="k-pill k-pill-accent k-pill-sm">
                    #{tag}
                  </span>
                ))}
              </button>
              <button type="button" className="k-btn k-btn-sm k-btn-ghost" onClick={() => void togglePin(f)} aria-label={f.pinned ? tr('memory.unpinAria') : tr('memory.setPinned')} aria-pressed={f.pinned}>
                <UiIcon name="pin" size={18} styleVariant={f.pinned ? 'duotone' : 'line'} className={f.pinned ? 'is-pinned' : undefined} />
              </button>
            </div>
          ))}
          <form
            className="k-memory-new"
            onSubmit={(e) => {
              e.preventDefault();
              const p = newPath.trim();
              if (!validMemoryPath(p)) return actions.toast(tr('memory.invalidPath'), 'error');
              setOpen({ rel_path: p, content: '', pinned: false, dirty: true });
              setEditing(true);
              setNewPath('');
            }}
          >
            <input value={newPath} onChange={(e) => setNewPath(e.target.value)} placeholder="topics/new_note.md" aria-label={tr('memory.newPathAria')} />
            <button type="submit" className="k-btn k-btn-sm">
              <UiIcon name="file-plus" size={16} /> {tr('memory.createNew')}
            </button>
          </form>
        </section>
      )}

      <button type="button" className="k-memory-foot" onClick={() => actions.setUi({ screen: 'settings' })}>
        <span>{policySummary(policies.policies, policies.defaults)}</span>
        <UiIcon name="chevron-right" size={16} />
      </button>
    </div>
  );
}

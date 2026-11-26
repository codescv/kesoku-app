import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { EngineToClientPayload } from '@kesoku/protocol';
import { UiIcon, fileIconName, formatLocaleDate, t as tGlobal, useLocale, useT, type UiIconName, type ResolvedLocale, type MessageKey } from '@kesoku/ui';
import { kesoku } from '../../lib/client';
import { actions, useStore } from '../../lib/store';
import { Markdown } from '../segments/Markdown';
import { CodeHighlight } from './CodeHighlight';
import { overlays } from '../session/overlays';
import './files.css';

type DirEntry = EngineToClientPayload<'workspace.list.result'>['entries'][number];
type ReadResult = EngineToClientPayload<'workspace.read.result'>;
type DownloadResult = EngineToClientPayload<'workspace.download.result'>;

/** Total upload cap per file. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Client → relay frames are capped at 1 MiB; base64 inflates by 4/3, so send ≤512 KiB raw per frame. */
export const UPLOAD_CHUNK_BYTES = 512 * 1024;

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

function fmtRelTime(ts: number, locale: ResolvedLocale, t: (k: MessageKey, p?: Record<string, string | number>) => string): string {
  if (!ts) return '';
  const d = Date.now() / 1000 - ts;
  if (d < 60) return t('common.justNow');
  if (d < 3600) return t('common.minutesAgo', { n: Math.floor(d / 60) });
  if (d < 86400) return t('common.hoursAgo', { n: Math.floor(d / 3600) });
  if (d < 86400 * 7) return t('common.daysAgo', { n: Math.floor(d / 86400) });
  return formatLocaleDate(ts * 1000, { month: 'numeric', day: 'numeric' }, locale);
}

function joinPath(dir: string, name: string): string {
  return dir ? `${dir.replace(/\/+$/, '')}/${name}` : name;
}

/** A single path segment: non-empty, no separators, not `.`/`..`. */
export function validEntryName(raw: string): string | null {
  const name = raw.trim();
  if (!name || name === '.' || name === '..') return null;
  if (/[/\\]/.test(name) || name.includes('\0')) return null;
  return name;
}

function isInside(path: string, target: string): boolean {
  return path === target || path.startsWith(target + '/');
}

function errText(err: unknown, fallback: string): string {
  const msg = err && typeof err === 'object' && 'message' in err ? String((err as { message?: unknown }).message ?? '') : '';
  return msg && msg !== 'unexpected' ? `${fallback}: ${msg}` : fallback;
}

/** Read a browser File as raw base64 (without the `data:…;base64,` prefix). */
function readFileBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const url = String(reader.result ?? '');
      const comma = url.indexOf(',');
      resolve(comma >= 0 ? url.slice(comma + 1) : url);
    };
    reader.readAsDataURL(file);
  });
}

function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'application/octet-stream' });
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

/** Large files come back as a signed URL: fetch it into a Blob, or fall back to opening the URL. */
async function downloadUrl(url: string, name: string): Promise<void> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    saveBlob(await resp.blob(), name);
  } catch {
    // CORS-blocked or offline fetch: let the browser handle the signed URL directly.
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.target = '_blank';
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

const TEXT_ICONS: ReadonlySet<UiIconName> = new Set<UiIconName>(['file-text', 'file-code']);

/** Row-level guess (before reading): text/code extensions are editable. */
function looksEditable(e: DirEntry): boolean {
  return e.kind === 'file' && TEXT_ICONS.has(fileIconName(e.name, 'file'));
}

function canEdit(f: ReadResult): boolean {
  if (f.writable === false) return false;
  return f.writable === true || (f.kind === 'text' && !f.truncated);
}

function ActBtn({
  icon,
  label,
  onClick,
  tone,
  iconOnly,
  disabled,
  ariaLabel,
}: {
  icon: UiIconName;
  label: string;
  onClick: () => void;
  tone?: 'primary' | 'danger';
  iconOnly?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      className={'fb-act' + (tone ? ` is-${tone}` : '') + (iconOnly ? ' is-icon' : '')}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel ?? label}
      title={ariaLabel ?? label}
    >
      <UiIcon name={icon} size={16} />
      {!iconOnly && <span className="fb-act-label">{label}</span>}
    </button>
  );
}

function ConfirmDelete({ name, onConfirm, onCancel, busy }: { name: string; onConfirm: () => void; onCancel: () => void; busy: boolean }): ReactNode {
  const t = useT();
  return (
    <span className="fb-confirm" role="group" aria-label={t('files.confirmDeleteAria', { name })}>
      <span className="fb-confirm-text">{t('files.confirmDeleteQuestion')}</span>
      <ActBtn icon="trash" label={t('common.delete')} tone="danger" onClick={onConfirm} disabled={busy} ariaLabel={t('files.confirmDeleteBtnAria')} />
      <ActBtn icon="close" label={t('common.cancel')} onClick={onCancel} disabled={busy} ariaLabel={t('files.cancelDeleteBtnAria')} />
    </span>
  );
}

function MediaPreview({ file }: { file: ReadResult }) {
  const t = useT();
  const ref = file.ref || file.rel_path;
  const entry = useStore((s) => s.media['ref:' + ref]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const fresh = entry?.url && (!entry.expires_at || entry.expires_at - 30 > Date.now() / 1000);
    if (fresh) return;
    let alive = true;
    setLoading(true);
    setFailed(false);
    kesoku
      .rpc('media.hydrate', { ref }, { timeoutMs: 25_000 })
      .then(() => {
        if (alive) setLoading(false);
      })
      .catch(() => {
        if (alive) {
          setLoading(false);
          setFailed(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [ref, entry?.url, entry?.expires_at]);

  const url = entry?.url;
  if (loading && !url) return <div className="k-empty">{t('files.loadingMedia')}</div>;
  if (failed || !url) return <div className="k-empty">{t('files.mediaUnavailable')}</div>;
  if (file.mime.startsWith('image/')) {
    return (
      <div className="k-fb-media">
        <button type="button" className="k-fb-img-btn" onClick={() => overlays.image(url)} aria-label={t('common.viewLargeImage')}>
          <img src={url} alt={file.name} />
        </button>
      </div>
    );
  }
  if (file.mime.startsWith('audio/')) {
    return (
      <div className="k-fb-media">
        <audio controls src={url} preload="metadata" style={{ width: '100%' }} />
      </div>
    );
  }
  return <div className="k-empty">{t('files.previewUnsupported', { mime: file.mime })}</div>;
}

export function FileBrowser({ onClose }: { onClose: () => void }) {
  const locale = useLocale();
  const t = useT();
  const [relPath, setRelPath] = useState('');
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loadingDir, setLoadingDir] = useState(false);
  const [filter, setFilter] = useState('');
  const [openFile, setOpenFile] = useState<ReadResult | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [mdMode, setMdMode] = useState<'preview' | 'raw'>('preview');
  const [draft, setDraft] = useState<string | null>(null);
  const [creating, setCreating] = useState<'file' | 'dir' | null>(null);
  const [newName, setNewName] = useState('');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const relPathRef = useRef(relPath);
  relPathRef.current = relPath;

  const loadDir = useCallback(async (targetPath: string) => {
    setLoadingDir(true);
    try {
      const res = await kesoku.rpc<EngineToClientPayload<'workspace.list.result'>>('workspace.list', { rel_path: targetPath });
      setRelPath(res.rel_path ?? targetPath);
      setEntries(res.entries ?? []);
      setOpenFile(null);
      setDraft(null);
      setConfirmDel(null);
    } catch {
      actions.toast(tGlobal('files.readDirFailed'), 'error');
    } finally {
      setLoadingDir(false);
    }
  }, []);

  useEffect(() => {
    void loadDir('');
  }, [loadDir]);

  const readFile = useCallback(async (path: string, edit = false): Promise<ReadResult | null> => {
    setLoadingFile(true);
    try {
      const res = await kesoku.rpc<ReadResult>('workspace.read', { rel_path: path });
      setOpenFile(res);
      setMdMode('preview');
      setConfirmDel(null);
      if (edit) {
        if (canEdit(res)) setDraft(res.content ?? '');
        else {
          setDraft(null);
          actions.toast(tGlobal('files.notEditable'), 'error');
        }
      } else setDraft(null);
      return res;
    } catch {
      actions.toast(tGlobal('files.readFileFailed'), 'error');
      return null;
    } finally {
      setLoadingFile(false);
    }
  }, []);

  const openEntry = useCallback(
    async (e: DirEntry, edit = false) => {
      if (e.kind === 'dir') {
        setFilter('');
        await loadDir(e.rel_path);
        return;
      }
      await readFile(e.rel_path, edit);
    },
    [loadDir, readFile],
  );

  const refresh = useCallback(() => {
    if (openFile) void readFile(openFile.rel_path, false);
    else void loadDir(relPathRef.current);
  }, [openFile, readFile, loadDir]);

  // ───────────── mutations ─────────────

  const onUploadPicked = useCallback(
    async (list: FileList | null) => {
      const files = list ? Array.from(list) : [];
      if (fileInput.current) fileInput.current.value = '';
      if (!files.length) return;
      const dir = relPathRef.current;
      setBusy(true);
      let ok = 0;
      try {
        for (const f of files) {
          const name = validEntryName(f.name);
          if (!name) {
            actions.toast(tGlobal('files.invalidFileName', { name: f.name }), 'error');
            continue;
          }
          if (f.size > MAX_UPLOAD_BYTES) {
            actions.toast(tGlobal('files.fileTooLarge', { name, max: fmtSize(MAX_UPLOAD_BYTES) }), 'error');
            continue;
          }
          const exists = entries.some((e) => e.name === name);
          if (exists && typeof window.confirm === 'function' && !window.confirm(tGlobal('files.overwriteConfirm', { name }))) continue;
          const path = joinPath(dir, name);
          const chunks = Math.max(1, Math.ceil(f.size / UPLOAD_CHUNK_BYTES));
          let sent = 0;
          try {
            for (let i = 0; i < chunks; i++) {
              if (chunks > 1) setProgress(tGlobal('files.uploadingProgress', { name, pct: Math.round((i / chunks) * 100) }));
              const base64 = await readFileBase64(f.slice(i * UPLOAD_CHUNK_BYTES, (i + 1) * UPLOAD_CHUNK_BYTES));
              const payload = i === 0 ? { path, base64, overwrite: exists } : { path, base64, append: true };
              await kesoku.rpc('workspace.write', payload, { timeoutMs: 60_000 });
              sent++;
            }
            ok++;
          } catch (err) {
            actions.toast(errText(err, tGlobal('files.uploadFailed', { name })), 'error');
            // Don't leave a truncated new file behind (an overwritten one is already lost either way).
            if (sent > 0 && !exists) void kesoku.rpc('workspace.delete', { path }).catch(() => {});
          }
        }
      } finally {
        setBusy(false);
        setProgress(null);
      }
      if (ok) actions.toast(ok === 1 ? tGlobal('files.uploadedOne') : tGlobal('files.uploadedMany', { count: ok }));
      await loadDir(dir);
    },
    [entries, loadDir],
  );

  const submitCreate = useCallback(async () => {
    if (!creating) return;
    const name = validEntryName(newName);
    if (!name) {
      actions.toast(tGlobal('files.invalidEntryName'), 'error');
      return;
    }
    const kind = creating;
    if (entries.some((e) => e.name === name)) {
      actions.toast(kind === 'dir' ? tGlobal('files.existsDir', { name }) : tGlobal('files.existsFile', { name }), 'error');
      return;
    }
    const dir = relPathRef.current;
    const path = joinPath(dir, name);
    setBusy(true);
    try {
      if (kind === 'dir') await kesoku.rpc('workspace.mkdir', { path });
      else await kesoku.rpc('workspace.write', { path, content: '', overwrite: false });
      setCreating(null);
      setNewName('');
      actions.toast(kind === 'dir' ? tGlobal('files.createdDir', { name }) : tGlobal('files.createdFile', { name }));
    } catch (err) {
      actions.toast(errText(err, kind === 'dir' ? tGlobal('files.createDirFailed') : tGlobal('files.createFileFailed')), 'error');
      return;
    } finally {
      setBusy(false);
    }
    await loadDir(dir);
  }, [creating, newName, entries, loadDir]);

  const saveEdit = useCallback(async () => {
    if (!openFile || draft === null) return;
    const path = openFile.rel_path;
    setBusy(true);
    try {
      await kesoku.rpc('workspace.write', { path, content: draft, overwrite: true });
      actions.toast(tGlobal('common.saved'));
    } catch (err) {
      actions.toast(errText(err, tGlobal('common.saveFailed')), 'error');
      return;
    } finally {
      setBusy(false);
    }
    await readFile(path, false);
  }, [openFile, draft, readFile]);

  const download = useCallback(
    async (path: string, name: string) => {
      try {
        if (openFile && openFile.rel_path === path && openFile.kind === 'text' && !openFile.truncated && openFile.content !== undefined) {
          saveBlob(new Blob([openFile.content], { type: openFile.mime || 'text/plain' }), name);
          return;
        }
        const res = await kesoku.rpc<DownloadResult>('workspace.download', { path }, { timeoutMs: 60_000 });
        const fileName = res.name || name;
        if (typeof res.base64 === 'string') {
          saveBlob(base64ToBlob(res.base64, res.mime_type), fileName);
        } else if (res.url) {
          await downloadUrl(res.url, fileName);
        } else {
          throw new Error(tGlobal('files.noDownloadData'));
        }
      } catch (err) {
        actions.toast(errText(err, tGlobal('files.downloadFailed')), 'error');
      }
    },
    [openFile],
  );

  const doDelete = useCallback(
    async (path: string, name: string) => {
      setBusy(true);
      try {
        const res = await kesoku.rpc<EngineToClientPayload<'workspace.delete.result'>>('workspace.delete', { path });
        if (res && res.deleted === false) actions.toast(tGlobal('files.notFoundOrDeleted', { name }), 'error');
        else actions.toast(tGlobal('files.deleted', { name }));
      } catch (err) {
        actions.toast(errText(err, tGlobal('common.deleteFailed')), 'error');
        return;
      } finally {
        setBusy(false);
        setConfirmDel(null);
      }
      if (openFile && isInside(openFile.rel_path, path)) {
        setOpenFile(null);
        setDraft(null);
      }
      const dir = relPathRef.current;
      await loadDir(isInside(dir, path) ? path.split('/').slice(0, -1).join('/') : dir);
    },
    [openFile, loadDir],
  );

  // ───────────── derived ─────────────

  const crumbs = useMemo(() => {
    const parts = relPath ? relPath.split('/').filter(Boolean) : [];
    const list: Array<{ label: string; path: string }> = [{ label: t('files.root'), path: '' }];
    let acc = '';
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      list.push({ label: p, path: acc });
    }
    return list;
  }, [relPath, t]);

  const parentPath = useMemo(() => {
    if (!relPath) return null;
    const idx = relPath.lastIndexOf('/');
    return idx < 0 ? '' : relPath.slice(0, idx);
  }, [relPath]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => e.name.toLowerCase().includes(q));
  }, [entries, filter]);

  const isMarkdown = openFile?.kind === 'text' && /\.(md|markdown)$/i.test(openFile.name);
  const editing = openFile !== null && draft !== null;

  return (
    <div className="k-screen k-fb" data-testid="file-browser">
      <header className="k-screen-head">
        <button
          type="button"
          className="k-icon-btn"
          aria-label={t('common.back')}
          onClick={() => {
            if (openFile) {
              setOpenFile(null);
              setDraft(null);
              setConfirmDel(null);
            } else onClose();
          }}
        >
          <UiIcon name="arrow-left" size={20} />
        </button>
        <h1 className="fb-title">
          <UiIcon name="folder" size={20} />
          <span>{t('files.title')}</span>
        </h1>
        <span style={{ flex: 1 }} />
        <ActBtn icon="refresh" label={t('common.refresh')} onClick={refresh} disabled={busy || loadingDir || loadingFile} />
      </header>

      <div className="k-screen-body">
        <nav className="k-fb-crumbs" aria-label={t('files.crumbsAria')}>
          {crumbs.map((c, i) => (
            <span key={c.path || 'root'} className="k-fb-crumb-item">
              {i > 0 && (
                <span className="k-fb-sep" aria-hidden>
                  <UiIcon name="chevron-right" size={14} />
                </span>
              )}
              <button
                type="button"
                className={'k-fb-crumb' + (i === crumbs.length - 1 && !openFile ? ' is-current' : '')}
                onClick={() => void loadDir(c.path)}
              >
                {i === 0 && <UiIcon name="folder" size={15} />}
                {c.label}
              </button>
            </span>
          ))}
          {openFile && (
            <span className="k-fb-crumb-item">
              <span className="k-fb-sep" aria-hidden>
                <UiIcon name="chevron-right" size={14} />
              </span>
              <span className="k-fb-crumb is-current">{openFile.name}</span>
            </span>
          )}
        </nav>

        {openFile ? (
          <section className="k-set-card k-fb-viewer" data-testid="fb-viewer">
            <div className="k-fb-viewer-head">
              <div className="k-fb-viewer-meta">
                <b>{openFile.name}</b>
                <small>
                  {openFile.rel_path} · {fmtSize(openFile.size)} · {fmtRelTime(openFile.updated_at, locale, t)}
                  {openFile.truncated ? t('files.truncated') : ''}
                </small>
              </div>
              <div className="k-fb-viewer-actions fb-actions">
                {confirmDel === openFile.rel_path ? (
                  <ConfirmDelete name={openFile.name} busy={busy} onConfirm={() => void doDelete(openFile.rel_path, openFile.name)} onCancel={() => setConfirmDel(null)} />
                ) : editing ? (
                  <>
                    <ActBtn icon="save" label={t('common.save')} tone="primary" onClick={() => void saveEdit()} disabled={busy} />
                    <ActBtn icon="close" label={t('common.cancel')} onClick={() => setDraft(null)} disabled={busy} />
                  </>
                ) : (
                  <>
                    {isMarkdown && (
                      <ActBtn
                        icon={mdMode === 'preview' ? 'file-code' : 'file-text'}
                        label={mdMode === 'preview' ? t('common.source') : t('common.preview')}
                        onClick={() => setMdMode((m) => (m === 'preview' ? 'raw' : 'preview'))}
                      />
                    )}
                    {canEdit(openFile) && <ActBtn icon="edit" label={t('common.edit')} onClick={() => setDraft(openFile.content ?? '')} />}
                    <ActBtn icon="download" label={t('common.download')} onClick={() => void download(openFile.rel_path, openFile.name)} />
                    <ActBtn icon="trash" label={t('common.delete')} tone="danger" onClick={() => setConfirmDel(openFile.rel_path)} />
                    <ActBtn icon="arrow-left" label={t('files.backToList')} onClick={() => setOpenFile(null)} />
                  </>
                )}
              </div>
            </div>
            {editing ? (
              <textarea
                className="fb-editor"
                value={draft ?? ''}
                onChange={(e) => setDraft(e.target.value)}
                aria-label={t('files.editAria', { name: openFile.name })}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                disabled={busy}
              />
            ) : openFile.kind === 'text' ? (
              isMarkdown && mdMode === 'preview' ? (
                <div className="k-fb-md">
                  <Markdown text={openFile.content ?? ''} />
                </div>
              ) : (
                <CodeHighlight code={openFile.content ?? ''} filename={openFile.name} />
              )
            ) : openFile.kind === 'media' ? (
              <MediaPreview file={openFile} />
            ) : (
              <div className="k-empty">{t('files.binaryFile', { mime: openFile.mime, size: fmtSize(openFile.size) })}</div>
            )}
          </section>
        ) : (
          <section className="k-set-card k-fb-list-card">
            <div className="k-fb-toolbar fb-toolbar">
              {parentPath !== null && (
                <ActBtn icon="arrow-left" label={t('files.upDir')} onClick={() => void loadDir(parentPath)} />
              )}
              <input
                type="search"
                className="k-fb-search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t('files.filterPlaceholder')}
                aria-label={t('files.filterAria')}
              />
              <div className="fb-actions fb-dir-actions">
                <ActBtn icon="upload" label={t('common.upload')} onClick={() => fileInput.current?.click()} disabled={busy} />
                <ActBtn
                  icon="file-plus"
                  label={t('files.newFile')}
                  onClick={() => {
                    setCreating('file');
                    setNewName('');
                  }}
                  disabled={busy}
                />
                <ActBtn
                  icon="folder-plus"
                  label={t('files.newDir')}
                  onClick={() => {
                    setCreating('dir');
                    setNewName('');
                  }}
                  disabled={busy}
                />
              </div>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                data-testid="fb-upload-input"
                onChange={(e) => void onUploadPicked(e.target.files)}
              />
            </div>

            {progress && (
              <div className="fb-progress" role="status">
                <UiIcon name="upload" size={16} />
                <span>{progress}</span>
              </div>
            )}

            {creating && (
              <form
                className="fb-create"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitCreate();
                }}
              >
                <UiIcon name={creating === 'dir' ? 'folder-plus' : 'file-plus'} size={18} />
                <input
                  className="fb-create-input"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={creating === 'dir' ? t('files.newDirPlaceholder') : t('files.newFilePlaceholder')}
                  aria-label={creating === 'dir' ? t('files.newDirPlaceholder') : t('files.newFilePlaceholder')}
                  autoFocus
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setCreating(null);
                  }}
                />
                <button type="submit" className="fb-act is-primary" disabled={busy || !validEntryName(newName)} aria-label={t('common.create')} title={t('common.create')}>
                  <UiIcon name="check" size={16} />
                  <span className="fb-act-label">{t('common.create')}</span>
                </button>
                <ActBtn icon="close" label={t('common.cancel')} onClick={() => setCreating(null)} disabled={busy} />
              </form>
            )}

            {loadingDir || loadingFile ? (
              <div className="k-empty">{t('common.loading')}</div>
            ) : filtered.length === 0 ? (
              <div className="k-empty">{filter ? t('files.noMatchingFiles') : t('files.emptyDir')}</div>
            ) : (
              <div className="k-fb-rows" role="list">
                {filtered.map((e) => (
                  <div key={e.rel_path} role="listitem" className={'k-fb-row fb-row is-' + e.kind + (confirmDel === e.rel_path ? ' is-confirming' : '')}>
                    <button type="button" className="fb-row-main" onClick={() => void openEntry(e)}>
                      <span className="k-fb-icon" aria-hidden>
                        <UiIcon name={fileIconName(e.name, e.kind)} size={20} />
                      </span>
                      <span className="k-fb-name">{e.name}</span>
                      <span className="k-fb-meta">
                        {e.kind === 'file' && <span>{fmtSize(e.size)}</span>}
                        <span className="fb-time">{fmtRelTime(e.updated_at, locale, t)}</span>
                        {e.kind === 'dir' && <UiIcon name="chevron-right" size={16} />}
                      </span>
                    </button>
                    <span className="fb-row-actions">
                      {confirmDel === e.rel_path ? (
                        <ConfirmDelete name={e.name} busy={busy} onConfirm={() => void doDelete(e.rel_path, e.name)} onCancel={() => setConfirmDel(null)} />
                      ) : (
                        <>
                          {looksEditable(e) && <ActBtn icon="edit" label={t('common.edit')} iconOnly ariaLabel={t('files.editAria', { name: e.name })} onClick={() => void openEntry(e, true)} />}
                          {e.kind === 'file' && <ActBtn icon="download" label={t('common.download')} iconOnly ariaLabel={t('files.downloadAria', { name: e.name })} onClick={() => void download(e.rel_path, e.name)} />}
                          <ActBtn icon="trash" label={t('common.delete')} iconOnly tone="danger" ariaLabel={t('files.deleteAria', { name: e.name })} onClick={() => setConfirmDel(e.rel_path)} />
                        </>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { EngineToClientPayload } from '@kesoku/protocol';
import { UiIcon, fileIconName, type UiIconName } from '@kesoku/ui';
import { kesoku } from '../../lib/client';
import { actions, useStore } from '../../lib/store';
import { Markdown } from '../segments/Markdown';
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

function fmtRelTime(ts: number): string {
  if (!ts) return '';
  const d = Date.now() / 1000 - ts;
  if (d < 60) return '刚刚';
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)} 天前`;
  return new Date(ts * 1000).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
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
  return (
    <span className="fb-confirm" role="group" aria-label={`确认删除 ${name}`}>
      <span className="fb-confirm-text">确认删除?</span>
      <ActBtn icon="trash" label="删除" tone="danger" onClick={onConfirm} disabled={busy} ariaLabel="确认删除" />
      <ActBtn icon="close" label="取消" onClick={onCancel} disabled={busy} ariaLabel="取消删除" />
    </span>
  );
}

function MediaPreview({ file }: { file: ReadResult }) {
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
  if (loading && !url) return <div className="k-empty">正在加载媒体预览…</div>;
  if (failed || !url) return <div className="k-empty">媒体预览暂不可用</div>;
  if (file.mime.startsWith('image/')) {
    return (
      <div className="k-fb-media">
        <button type="button" className="k-fb-img-btn" onClick={() => overlays.image(url)} aria-label="查看大图">
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
  return <div className="k-empty">不支持预览 ({file.mime})</div>;
}

export function FileBrowser({ onClose }: { onClose: () => void }) {
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
      actions.toast('读取目录失败', 'error');
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
          actions.toast('该文件不可编辑', 'error');
        }
      } else setDraft(null);
      return res;
    } catch {
      actions.toast('读取文件失败', 'error');
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
            actions.toast(`无效文件名: ${f.name}`, 'error');
            continue;
          }
          if (f.size > MAX_UPLOAD_BYTES) {
            actions.toast(`${name} 过大 (上限 ${fmtSize(MAX_UPLOAD_BYTES)})`, 'error');
            continue;
          }
          const exists = entries.some((e) => e.name === name);
          if (exists && typeof window.confirm === 'function' && !window.confirm(`已存在 ${name}，是否覆盖？`)) continue;
          const path = joinPath(dir, name);
          const chunks = Math.max(1, Math.ceil(f.size / UPLOAD_CHUNK_BYTES));
          let sent = 0;
          try {
            for (let i = 0; i < chunks; i++) {
              if (chunks > 1) setProgress(`正在上传 ${name} · ${Math.round((i / chunks) * 100)}%`);
              const base64 = await readFileBase64(f.slice(i * UPLOAD_CHUNK_BYTES, (i + 1) * UPLOAD_CHUNK_BYTES));
              const payload = i === 0 ? { path, base64, overwrite: exists } : { path, base64, append: true };
              await kesoku.rpc('workspace.write', payload, { timeoutMs: 60_000 });
              sent++;
            }
            ok++;
          } catch (err) {
            actions.toast(errText(err, `上传 ${name} 失败`), 'error');
            // Don't leave a truncated new file behind (an overwritten one is already lost either way).
            if (sent > 0 && !exists) void kesoku.rpc('workspace.delete', { path }).catch(() => {});
          }
        }
      } finally {
        setBusy(false);
        setProgress(null);
      }
      if (ok) actions.toast(ok === 1 ? '已上传 1 个文件' : `已上传 ${ok} 个文件`);
      await loadDir(dir);
    },
    [entries, loadDir],
  );

  const submitCreate = useCallback(async () => {
    if (!creating) return;
    const name = validEntryName(newName);
    if (!name) {
      actions.toast('名称无效：不能为空，且不能包含 / 或为 ..', 'error');
      return;
    }
    const kind = creating;
    if (entries.some((e) => e.name === name)) {
      actions.toast(kind === 'dir' ? `已存在同名文件夹: ${name}` : `已存在同名文件: ${name}`, 'error');
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
      actions.toast(kind === 'dir' ? `已创建文件夹 ${name}` : `已创建文件 ${name}`);
    } catch (err) {
      actions.toast(errText(err, kind === 'dir' ? '创建文件夹失败' : '创建文件失败'), 'error');
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
      actions.toast('已保存');
    } catch (err) {
      actions.toast(errText(err, '保存失败'), 'error');
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
          throw new Error('无下载数据');
        }
      } catch (err) {
        actions.toast(errText(err, '下载失败'), 'error');
      }
    },
    [openFile],
  );

  const doDelete = useCallback(
    async (path: string, name: string) => {
      setBusy(true);
      try {
        const res = await kesoku.rpc<EngineToClientPayload<'workspace.delete.result'>>('workspace.delete', { path });
        if (res && res.deleted === false) actions.toast(`${name} 不存在或已删除`, 'error');
        else actions.toast(`已删除 ${name}`);
      } catch (err) {
        actions.toast(errText(err, '删除失败'), 'error');
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
    const list: Array<{ label: string; path: string }> = [{ label: '根目录', path: '' }];
    let acc = '';
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      list.push({ label: p, path: acc });
    }
    return list;
  }, [relPath]);

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
          aria-label="返回"
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
          <span>Agent 目录</span>
        </h1>
        <span style={{ flex: 1 }} />
        <ActBtn icon="refresh" label="刷新" onClick={refresh} disabled={busy || loadingDir || loadingFile} />
      </header>

      <div className="k-screen-body">
        <nav className="k-fb-crumbs" aria-label="目录路径">
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
                  {openFile.rel_path} · {fmtSize(openFile.size)} · {fmtRelTime(openFile.updated_at)}
                  {openFile.truncated ? ' · 已截断前 256 KiB' : ''}
                </small>
              </div>
              <div className="k-fb-viewer-actions fb-actions">
                {confirmDel === openFile.rel_path ? (
                  <ConfirmDelete name={openFile.name} busy={busy} onConfirm={() => void doDelete(openFile.rel_path, openFile.name)} onCancel={() => setConfirmDel(null)} />
                ) : editing ? (
                  <>
                    <ActBtn icon="save" label="保存" tone="primary" onClick={() => void saveEdit()} disabled={busy} />
                    <ActBtn icon="close" label="取消" onClick={() => setDraft(null)} disabled={busy} />
                  </>
                ) : (
                  <>
                    {isMarkdown && (
                      <ActBtn
                        icon={mdMode === 'preview' ? 'file-code' : 'file-text'}
                        label={mdMode === 'preview' ? '源码' : '预览'}
                        onClick={() => setMdMode((m) => (m === 'preview' ? 'raw' : 'preview'))}
                      />
                    )}
                    {canEdit(openFile) && <ActBtn icon="edit" label="编辑" onClick={() => setDraft(openFile.content ?? '')} />}
                    <ActBtn icon="download" label="下载" onClick={() => void download(openFile.rel_path, openFile.name)} />
                    <ActBtn icon="trash" label="删除" tone="danger" onClick={() => setConfirmDel(openFile.rel_path)} />
                    <ActBtn icon="arrow-left" label="返回列表" onClick={() => setOpenFile(null)} />
                  </>
                )}
              </div>
            </div>
            {editing ? (
              <textarea
                className="fb-editor"
                value={draft ?? ''}
                onChange={(e) => setDraft(e.target.value)}
                aria-label={`编辑 ${openFile.name}`}
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
                <pre className="k-fb-pre">{openFile.content ?? ''}</pre>
              )
            ) : openFile.kind === 'media' ? (
              <MediaPreview file={openFile} />
            ) : (
              <div className="k-empty">二进制文件 ({openFile.mime}) · {fmtSize(openFile.size)}</div>
            )}
          </section>
        ) : (
          <section className="k-set-card k-fb-list-card">
            <div className="k-fb-toolbar fb-toolbar">
              {parentPath !== null && (
                <ActBtn icon="arrow-left" label="上一级" onClick={() => void loadDir(parentPath)} />
              )}
              <input
                type="search"
                className="k-fb-search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="筛选当前目录文件名…"
                aria-label="筛选文件名"
              />
              <div className="fb-actions fb-dir-actions">
                <ActBtn icon="upload" label="上传" onClick={() => fileInput.current?.click()} disabled={busy} />
                <ActBtn
                  icon="file-plus"
                  label="新建文件"
                  onClick={() => {
                    setCreating('file');
                    setNewName('');
                  }}
                  disabled={busy}
                />
                <ActBtn
                  icon="folder-plus"
                  label="新建文件夹"
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
                  placeholder={creating === 'dir' ? '新文件夹名称' : '新文件名称，如 notes.md'}
                  aria-label={creating === 'dir' ? '新文件夹名称' : '新文件名称'}
                  autoFocus
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setCreating(null);
                  }}
                />
                <button type="submit" className="fb-act is-primary" disabled={busy || !validEntryName(newName)} aria-label="创建" title="创建">
                  <UiIcon name="check" size={16} />
                  <span className="fb-act-label">创建</span>
                </button>
                <ActBtn icon="close" label="取消" onClick={() => setCreating(null)} disabled={busy} />
              </form>
            )}

            {loadingDir || loadingFile ? (
              <div className="k-empty">载入中…</div>
            ) : filtered.length === 0 ? (
              <div className="k-empty">{filter ? '无匹配文件' : '此目录为空'}</div>
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
                        <span className="fb-time">{fmtRelTime(e.updated_at)}</span>
                        {e.kind === 'dir' && <UiIcon name="chevron-right" size={16} />}
                      </span>
                    </button>
                    <span className="fb-row-actions">
                      {confirmDel === e.rel_path ? (
                        <ConfirmDelete name={e.name} busy={busy} onConfirm={() => void doDelete(e.rel_path, e.name)} onCancel={() => setConfirmDel(null)} />
                      ) : (
                        <>
                          {looksEditable(e) && <ActBtn icon="edit" label="编辑" iconOnly ariaLabel={`编辑 ${e.name}`} onClick={() => void openEntry(e, true)} />}
                          {e.kind === 'file' && <ActBtn icon="download" label="下载" iconOnly ariaLabel={`下载 ${e.name}`} onClick={() => void download(e.rel_path, e.name)} />}
                          <ActBtn icon="trash" label="删除" iconOnly tone="danger" ariaLabel={`删除 ${e.name}`} onClick={() => setConfirmDel(e.rel_path)} />
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

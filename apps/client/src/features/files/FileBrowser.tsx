import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EngineToClientPayload } from '@kesoku/protocol';
import { kesoku } from '../../lib/client';
import { actions, useStore } from '../../lib/store';
import { Markdown } from '../segments/Markdown';
import { overlays } from '../session/overlays';

type DirEntry = EngineToClientPayload<'workspace.list.result'>['entries'][number];
type ReadResult = EngineToClientPayload<'workspace.read.result'>;

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

function iconFor(entry: { kind: 'dir' | 'file'; name: string }): string {
  if (entry.kind === 'dir') return '📁';
  const lower = entry.name.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return '📝';
  if (lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml') || lower.endsWith('.toml')) return '🧾';
  if (/\.(png|jpe?g|webp|gif|svg|heic|heif|bmp)$/.test(lower)) return '🖼';
  if (/\.(mp3|wav|ogg|oga|m4a|aac|opus|flac)$/.test(lower)) return '🔊';
  if (/\.(py|sh|ts|tsx|js|mjs|sql|css|html)$/.test(lower)) return '💻';
  return '📄';
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
  const [awdName, setAwdName] = useState('band');
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loadingDir, setLoadingDir] = useState(false);
  const [filter, setFilter] = useState('');
  const [openFile, setOpenFile] = useState<ReadResult | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [mdMode, setMdMode] = useState<'preview' | 'raw'>('preview');

  const loadDir = useCallback(async (targetPath: string) => {
    setLoadingDir(true);
    try {
      const res = await kesoku.rpc<EngineToClientPayload<'workspace.list.result'>>('workspace.list', { rel_path: targetPath });
      setRelPath(res.rel_path ?? targetPath);
      if (res.awd_name) setAwdName(res.awd_name);
      setEntries(res.entries ?? []);
      setOpenFile(null);
    } catch {
      actions.toast('读取目录失败', 'error');
    } finally {
      setLoadingDir(false);
    }
  }, []);

  useEffect(() => {
    void loadDir('');
  }, [loadDir]);

  const openEntry = useCallback(
    async (e: DirEntry) => {
      if (e.kind === 'dir') {
        setFilter('');
        await loadDir(e.rel_path);
        return;
      }
      setLoadingFile(true);
      try {
        const res = await kesoku.rpc<EngineToClientPayload<'workspace.read.result'>>('workspace.read', { rel_path: e.rel_path });
        setOpenFile(res);
        setMdMode('preview');
      } catch {
        actions.toast('读取文件失败', 'error');
      } finally {
        setLoadingFile(false);
      }
    },
    [loadDir],
  );

  const crumbs = useMemo(() => {
    const parts = relPath ? relPath.split('/').filter(Boolean) : [];
    const list: Array<{ label: string; path: string }> = [{ label: `📁 ${awdName}`, path: '' }];
    let acc = '';
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      list.push({ label: p, path: acc });
    }
    return list;
  }, [relPath, awdName]);

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

  return (
    <div className="k-screen k-fb" data-testid="file-browser">
      <header className="k-screen-head">
        <button
          type="button"
          className="k-icon-btn"
          aria-label="返回"
          onClick={() => {
            if (openFile) setOpenFile(null);
            else onClose();
          }}
        >
          ←
        </button>
        <h1>📁 Agent 目录 ({awdName})</h1>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="k-btn k-btn-sm k-btn-ghost"
          onClick={() => (openFile ? void openEntry({ name: openFile.name, rel_path: openFile.rel_path, kind: 'file', size: openFile.size, updated_at: openFile.updated_at }) : void loadDir(relPath))}
        >
          ↻ 刷新
        </button>
      </header>

      <div className="k-screen-body">
        <nav className="k-fb-crumbs" aria-label="目录路径">
          {crumbs.map((c, i) => (
            <span key={c.path || 'root'} className="k-fb-crumb-item">
              {i > 0 && <span className="k-fb-sep">/</span>}
              <button
                type="button"
                className={'k-fb-crumb' + (i === crumbs.length - 1 && !openFile ? ' is-current' : '')}
                onClick={() => void loadDir(c.path)}
              >
                {c.label}
              </button>
            </span>
          ))}
          {openFile && (
            <span className="k-fb-crumb-item">
              <span className="k-fb-sep">/</span>
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
              <div className="k-fb-viewer-actions">
                {isMarkdown && (
                  <button
                    type="button"
                    className="k-btn k-btn-sm k-btn-ghost"
                    onClick={() => setMdMode((m) => (m === 'preview' ? 'raw' : 'preview'))}
                  >
                    {mdMode === 'preview' ? '源码' : '预览'}
                  </button>
                )}
                <button type="button" className="k-btn k-btn-sm" onClick={() => setOpenFile(null)}>
                  返回列表
                </button>
              </div>
            </div>
            {openFile.kind === 'text' ? (
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
            <div className="k-fb-toolbar">
              {parentPath !== null && (
                <button type="button" className="k-btn k-btn-sm k-btn-ghost" onClick={() => void loadDir(parentPath)}>
                  ↑ 上一级
                </button>
              )}
              <input
                type="search"
                className="k-fb-search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="筛选当前目录文件名…"
                aria-label="筛选文件名"
              />
            </div>

            {loadingDir || loadingFile ? (
              <div className="k-empty">载入中…</div>
            ) : filtered.length === 0 ? (
              <div className="k-empty">{filter ? '无匹配文件' : '此目录为空'}</div>
            ) : (
              <div className="k-fb-rows" role="list">
                {filtered.map((e) => (
                  <button
                    key={e.rel_path}
                    type="button"
                    role="listitem"
                    className={'k-fb-row is-' + e.kind}
                    onClick={() => void openEntry(e)}
                  >
                    <span className="k-fb-icon" aria-hidden>
                      {iconFor(e)}
                    </span>
                    <span className="k-fb-name">{e.name}</span>
                    <span className="k-fb-meta">
                      {e.kind === 'file' && <span>{fmtSize(e.size)}</span>}
                      <span>{fmtRelTime(e.updated_at)}</span>
                      <span aria-hidden>›</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

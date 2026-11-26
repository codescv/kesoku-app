import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Segmented, UiIcon, t as tGlobal, useT } from '@kesoku/ui';
import { kesoku } from '../../lib/client';
import { actions, useStore } from '../../lib/store';
import { Markdown } from '../segments/Markdown';
import { SessionNotesEditor } from './SessionNotesSheet';

export interface StickyNoteItem {
  id: string;
  timestamp: string;
  pinned: boolean;
  body: string;
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const HR_LINE_RE = /^ {0,3}---+\s*$/;
const HTML_COMMENT_ONLY_RE = /^<!--[\s\S]*?-->$/;
const PINNED_HEADER_RE = /^###\s+📌(?:\s+(.*))?$/u;
const TIMESTAMP_HEADER_RE =
  /^###\s+((?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}:\d{2})(?:[T\s]+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[A-Za-z+-][\w:]*)?)?(?:\s+.*)?|便签|Note|メモ)\s*$/u;

function parseHeaderLine(line: string): { pinned: boolean; timestamp: string } | null {
  const pm = PINNED_HEADER_RE.exec(line.trim());
  if (pm) {
    return { pinned: true, timestamp: (pm[1] ?? '').trim() || tGlobal('notes.defaultLabel') };
  }
  const tm = TIMESTAMP_HEADER_RE.exec(line.trim());
  if (tm) {
    return { pinned: false, timestamp: (tm[1] ?? '').trim() || tGlobal('notes.defaultLabel') };
  }
  return null;
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && /^\s*$/.test(lines[start]!)) start++;
  while (end > start && /^\s*$/.test(lines[end - 1]!)) end--;
  return lines.slice(start, end);
}

/**
 * Parse `$AWD/notes.md` into structured sticky note cards.
 * - Splits by `---` horizontal rules (outside fenced code blocks) and `### [📌] <timestamp>` note headers.
 * - Preserves arbitrary Markdown written by the Agent or user without headers as cards (`timestamp: '便签'`).
 */
export function parseStickyNotes(raw: string): StickyNoteItem[] {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!normalized.trim()) return [];

  const lines = normalized.split('\n');
  const rawBlocks: string[][] = [];
  let current: string[] = [];
  let fence: { char: string; len: number } | null = null;

  const flush = () => {
    const trimmed = trimBlankLines(current);
    current = [];
    if (!trimmed.length) return;
    const joined = trimmed.join('\n').trim();
    if (!joined || HTML_COMMENT_ONLY_RE.test(joined)) return;
    rawBlocks.push(trimmed);
  };

  for (const line of lines) {
    if (fence) {
      current.push(line);
      const closeRe = new RegExp(`^ {0,3}${fence.char}{${fence.len},}\\s*$`);
      if (closeRe.test(line)) fence = null;
      continue;
    }

    const fm = FENCE_OPEN_RE.exec(line);
    if (fm) {
      const marker = fm[1]!;
      fence = { char: marker[0]!, len: marker.length };
      current.push(line);
      continue;
    }

    if (HR_LINE_RE.test(line)) {
      flush();
      continue;
    }

    if (parseHeaderLine(line) !== null && current.some((l) => !/^\s*$/.test(l))) {
      flush();
    }

    current.push(line);
  }
  flush();

  return rawBlocks.map((blockLines, idx) => {
    const hdr = parseHeaderLine(blockLines[0]!);
    if (hdr) {
      const body = trimBlankLines(blockLines.slice(1)).join('\n');
      return {
        id: `note-${idx}`,
        timestamp: hdr.timestamp,
        pinned: hdr.pinned,
        body,
      };
    }
    return {
      id: `note-${idx}`,
      timestamp: tGlobal('notes.defaultLabel'),
      pinned: false,
      body: blockLines.join('\n'),
    };
  });
}

/** Serialize sticky note items back into clean, human- & Agent-readable Markdown for `$AWD/notes.md`. */
export function serializeStickyNotes(items: StickyNoteItem[]): string {
  if (!items.length) return '';
  const fallback = tGlobal('notes.defaultLabel');
  return (
    items
      .map((item) => {
        const ts = (item.timestamp || fallback).trim() || fallback;
        const head = item.pinned ? `### 📌 ${ts}` : `### ${ts}`;
        const body = item.body.replace(/\r\n?/g, '\n').trim();
        return body ? `${head}\n${body}` : head;
      })
      .join('\n\n---\n\n') + '\n'
  );
}

/** Keep pinned notes first while preserving relative order within pinned and unpinned groups. */
export function sortStickyNotes(items: StickyNoteItem[]): StickyNoteItem[] {
  const pinned = items.filter((i) => i.pinned);
  const unpinned = items.filter((i) => !i.pinned);
  return [...pinned, ...unpinned];
}

export function formatNoteTimestamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = String((err as { code?: unknown }).code ?? '').toUpperCase();
  if (code === 'NOT_FOUND' || code === 'ENOENT') return true;
  const msg = String((err as { message?: unknown }).message ?? '');
  return /\b(not[_\s-]?found|enoent)\b/i.test(msg);
}

type ViewMode = 'cards' | 'raw';
export type NotesScope = 'session' | 'global';

/** Desktop Inspector tab strip (记忆库 | 便签) shown at the top of the embedded panel. */
function NotesInspectorTabs() {
  const t = useT();
  return (
    <div className="k-inspector-tabs" role="tablist" aria-label={t('memory.inspectorTabsAria')}>
      <button
        type="button"
        role="tab"
        aria-selected={false}
        className="k-inspector-tab"
        data-testid="inspector-tab-memory"
        onClick={() => actions.setUi({ inspector: { kind: 'memory' } })}
      >
        <UiIcon name="brain" size={15} />
        <span>{t('session.memory')}</span>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={true}
        className="k-inspector-tab is-active"
        data-testid="inspector-tab-notes"
        onClick={() => actions.setUi({ inspector: { kind: 'notes' } })}
      >
        <UiIcon name="note" size={15} />
        <span>{t('session.notes')}</span>
      </button>
    </div>
  );
}

/**
 * Notes screen / Inspector tab. With an open session, a scope switcher toggles between the
 * session's pinned notes (`session.notes.*`) and the global scratchpad (`$AWD/notes.md`, default).
 */
export function NotesPanel({ embedded, onClose }: { embedded?: boolean; onClose?: () => void }) {
  const t = useT();
  const currentSessionId = useStore((s) => s.currentSessionId);
  const [scope, setScope] = useState<NotesScope>('global');
  const switcher = currentSessionId ? (
    <div className="k-notes-scope" data-testid="notes-scope-switcher">
      <Segmented
        ariaLabel={t('notes.scopeAria')}
        size="sm"
        value={scope}
        onChange={setScope}
        options={[
          { value: 'session', label: t('notes.scopeSession') },
          { value: 'global', label: t('notes.scopeGlobal') },
        ]}
      />
    </div>
  ) : null;

  if (!currentSessionId || scope === 'global') return <GlobalNotesPanel embedded={embedded} onClose={onClose} scopeSwitcher={switcher} />;

  return (
    <div className={'k-notes' + (embedded ? ' is-embedded' : '')} data-testid="notes-panel" data-scope="session">
      {embedded && <NotesInspectorTabs />}
      <header className="k-notes-head">
        <div className="k-notes-title-row">
          {!embedded && onClose && (
            <button type="button" className="k-icon-btn" aria-label={t('common.back')} onClick={onClose}>
              <UiIcon name="arrow-left" size={20} />
            </button>
          )}
          <h2 className="k-notes-title">
            <UiIcon name="pin" size={embedded ? 18 : 20} />
            <span>{t('notes.scopeSession')}</span>
          </h2>
        </div>
      </header>
      {switcher}
      <div className="k-notes-body">
        <SessionNotesEditor sessionId={currentSessionId} embedded={embedded} />
      </div>
    </div>
  );
}

function GlobalNotesPanel({ embedded, onClose, scopeSwitcher }: { embedded?: boolean; onClose?: () => void; scopeSwitcher?: ReactNode }) {
  const t = useT();
  const [viewMode, setViewMode] = useState<ViewMode>('cards');
  const [items, setItems] = useState<StickyNoteItem[]>([]);
  const [rawContent, setRawContent] = useState('');
  const [rawDraft, setRawDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  // Quick-add composer state
  const [composerText, setComposerText] = useState('');
  const [composerPinned, setComposerPinned] = useState(false);

  // Search & inline card editing
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState('');

  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const flashSaved = useCallback(() => {
    setSavedFlash(true);
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => setSavedFlash(false), 2000);
  }, []);

  const loadNotes = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await kesoku.rpc<{ content?: string; size?: number }>('workspace.read', { rel_path: 'notes.md' });
      const content = res?.content ?? '';
      setRawContent(content);
      setRawDraft(content);
      setItems(sortStickyNotes(parseStickyNotes(content)));
    } catch (err) {
      if (isNotFoundError(err)) {
        setRawContent('');
        setRawDraft('');
        setItems([]);
      } else {
        setLoadError(tGlobal('notes.readFailed'));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadNotes();
  }, [loadNotes]);

  const persistNotes = useCallback(
    async (nextItems: StickyNoteItem[], nextRaw?: string): Promise<boolean> => {
      const content = nextRaw !== undefined ? nextRaw : serializeStickyNotes(nextItems);
      setSaving(true);
      try {
        await kesoku.rpc<{ rel_path?: string; bytes_written?: number }>('workspace.write', {
          path: 'notes.md',
          content,
          overwrite: true,
        });
        setItems(nextItems);
        setRawContent(content);
        setRawDraft(content);
        setLoadError(null);
        flashSaved();
        return true;
      } catch {
        actions.toast(tGlobal('notes.saveFailed'), 'error');
        return false;
      } finally {
        setSaving(false);
      }
    },
    [flashSaved],
  );

  const handleAddNote = useCallback(async () => {
    const body = composerText.trim();
    if (!body || saving) return;
    const newNote: StickyNoteItem = {
      id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: formatNoteTimestamp(),
      pinned: composerPinned,
      body,
    };
    const nextItems = sortStickyNotes([newNote, ...items]);
    const ok = await persistNotes(nextItems);
    if (ok) {
      setComposerText('');
      setComposerPinned(false);
    }
  }, [composerText, composerPinned, items, persistNotes, saving]);

  const handleTogglePin = useCallback(
    async (id: string) => {
      const nextItems = sortStickyNotes(items.map((it) => (it.id === id ? { ...it, pinned: !it.pinned } : it)));
      await persistNotes(nextItems);
    },
    [items, persistNotes],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      const nextItems = items.filter((it) => it.id !== id);
      const ok = await persistNotes(nextItems);
      if (ok) {
        if (editingId === id) {
          setEditingId(null);
          setEditingBody('');
        }
        actions.toast(tGlobal('notes.deleted'));
      }
    },
    [editingId, items, persistNotes],
  );

  const handleSaveCardEdit = useCallback(
    async (id: string) => {
      const trimmed = editingBody.trim();
      if (!trimmed) {
        actions.toast(tGlobal('notes.emptyError'), 'error');
        return;
      }
      const nextItems = items.map((it) => (it.id === id ? { ...it, body: trimmed } : it));
      const ok = await persistNotes(nextItems);
      if (ok) {
        setEditingId(null);
        setEditingBody('');
        actions.toast(tGlobal('notes.savedNote'));
      }
    },
    [editingBody, items, persistNotes],
  );

  const handleCopy = useCallback(async (body: string) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(body);
      }
      actions.toast(tGlobal('common.copiedClipboard'));
    } catch {
      actions.toast(tGlobal('common.copyFailed'), 'error');
    }
  }, []);

  const handleSaveRaw = useCallback(async () => {
    if (saving) return;
    const parsed = sortStickyNotes(parseStickyNotes(rawDraft));
    const ok = await persistNotes(parsed, rawDraft);
    if (ok) actions.toast(tGlobal('notes.savedFile'));
  }, [persistNotes, rawDraft, saving]);

  const handleSwitchMode = useCallback(
    (next: ViewMode) => {
      if (next === 'raw' && viewMode === 'cards') {
        setRawDraft(rawContent);
      }
      setViewMode(next);
    },
    [rawContent, viewMode],
  );

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => it.body.toLowerCase().includes(q) || it.timestamp.toLowerCase().includes(q));
  }, [items, search]);

  const rawDirty = rawDraft !== rawContent;

  return (
    <div className={'k-notes' + (embedded ? ' is-embedded' : '')} data-testid="notes-panel" data-scope="global">
      {embedded && <NotesInspectorTabs />}

      <header className="k-notes-head">
        <div className="k-notes-title-row">
          {!embedded && onClose && (
            <button type="button" className="k-icon-btn" aria-label={t('common.back')} onClick={onClose}>
              <UiIcon name="arrow-left" size={20} />
            </button>
          )}
          <h2 className="k-notes-title">
            <UiIcon name="note" size={embedded ? 18 : 20} />
            <span>{t('notes.title')}</span>
          </h2>
          <span className="k-pill k-pill-sm k-pill-neutral k-notes-badge">{t('notes.badge')}</span>
          {savedFlash && (
            <span className="k-notes-saved" role="status">
              <UiIcon name="check" size={13} /> {t('common.saved')}
            </span>
          )}
        </div>

        <div className="k-notes-controls">
          <Segmented
            ariaLabel={t('notes.viewAria')}
            size="sm"
            value={viewMode}
            onChange={handleSwitchMode}
            options={[
              { value: 'cards', label: t('notes.viewCards') },
              { value: 'raw', label: t('notes.viewRaw') },
            ]}
          />
          <button
            type="button"
            className="k-btn k-btn-sm k-btn-ghost k-notes-refresh"
            aria-label={t('common.refresh')}
            title={t('common.refresh')}
            data-testid="notes-refresh-btn"
            disabled={loading || saving}
            onClick={() => void loadNotes()}
          >
            <UiIcon name="refresh" size={16} />
            {!embedded && <span>{t('common.refresh')}</span>}
          </button>
        </div>
      </header>

      {scopeSwitcher}

      {loadError && (
        <div className="k-notes-error" role="alert">
          <span>{loadError}</span>
          <button type="button" className="k-btn k-btn-sm k-btn-ghost" onClick={() => void loadNotes()}>
            {t('common.retry')}
          </button>
        </div>
      )}

      <div className="k-notes-body">
        {viewMode === 'raw' ? (
          <section className="k-notes-raw-wrap">
            <textarea
              className="k-notes-raw-editor"
              value={rawDraft}
              onChange={(e) => setRawDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                  e.preventDefault();
                  void handleSaveRaw();
                }
              }}
              placeholder={t('notes.rawPlaceholder')}
              aria-label={t('notes.rawAria')}
              spellCheck={false}
              disabled={loading || saving}
            />
            <div className="k-notes-raw-foot">
              <span className="k-notes-hint">{rawDirty ? t('notes.unsavedChanges') : t('notes.savedInWorkspace')}</span>
              <button
                type="button"
                className="k-btn k-btn-sm k-btn-primary"
                data-testid="notes-raw-save-btn"
                disabled={saving || loading}
                onClick={() => void handleSaveRaw()}
              >
                <UiIcon name="save" size={15} /> {t('notes.saveShortcut')}
              </button>
            </div>
          </section>
        ) : (
          <>
            <section className="k-notes-composer" aria-label={t('notes.newNoteAria')}>
              <textarea
                className="k-notes-input"
                rows={embedded ? 3 : 3}
                value={composerText}
                onChange={(e) => setComposerText(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    void handleAddNote();
                  }
                }}
                placeholder={t('notes.composerPlaceholder')}
                aria-label={t('notes.composerInputAria')}
                disabled={saving}
              />
              <div className="k-notes-composer-bar">
                <button
                  type="button"
                  className={'k-pill k-pill-sm k-notes-pin-toggle' + (composerPinned ? ' k-pill-warn is-active' : ' k-pill-neutral')}
                  aria-pressed={composerPinned}
                  data-testid="notes-pin-toggle"
                  onClick={() => setComposerPinned((v) => !v)}
                >
                  {t('notes.pinToggle')}
                </button>
                <span className="k-notes-hint">{t('notes.savedInWorkspace')}</span>
                <button
                  type="button"
                  className="k-btn k-btn-sm k-btn-primary"
                  data-testid="notes-add-btn"
                  disabled={!composerText.trim() || saving}
                  onClick={() => void handleAddNote()}
                >
                  {t('notes.addBtn')}
                </button>
              </div>
            </section>

            {items.length >= 3 && (
              <div className="k-notes-search-wrap">
                <UiIcon name="search" size={16} className="k-notes-search-icon" />
                <input
                  type="search"
                  className="k-notes-search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('notes.searchPlaceholder')}
                  aria-label={t('notes.searchAria')}
                />
              </div>
            )}

            {loading ? (
              <div className="k-empty">{t('notes.loading')}</div>
            ) : items.length === 0 ? (
              <div className="k-notes-empty" data-testid="notes-empty">
                <div className="k-notes-empty-icon">
                  <UiIcon name="note" size={38} />
                </div>
                <p>{t('notes.empty')}</p>
              </div>
            ) : filteredItems.length === 0 ? (
              <div className="k-empty">{t('notes.noMatch')}</div>
            ) : (
              <div className={'k-notes-list' + (!embedded ? ' k-notes-grid' : '')} role="list">
                {filteredItems.map((item) => {
                  const isEditing = editingId === item.id;
                  return (
                    <article
                      key={item.id}
                      role="listitem"
                      className={'k-note-card' + (item.pinned ? ' is-pinned' : '')}
                      data-testid="note-card"
                    >
                      <div className="k-note-head">
                        <span className="k-note-meta">
                          {item.pinned && (
                            <span className="k-note-pin-badge" title={t('notes.pinnedTitle')}>
                              📌
                            </span>
                          )}
                          <span className="k-note-time">{item.timestamp}</span>
                        </span>
                        <div className="k-note-actions">
                          <button
                            type="button"
                            className={'k-note-act' + (item.pinned ? ' is-on' : '')}
                            aria-label={item.pinned ? t('notes.unpin') : t('notes.pin')}
                            title={item.pinned ? t('notes.unpin') : t('notes.pin')}
                            disabled={saving}
                            onClick={() => void handleTogglePin(item.id)}
                          >
                            <UiIcon name="pin" size={15} styleVariant={item.pinned ? 'duotone' : 'line'} />
                          </button>
                          <button
                            type="button"
                            className={'k-note-act' + (isEditing ? ' is-on' : '')}
                            aria-label={t('common.edit')}
                            title={t('common.edit')}
                            disabled={saving}
                            onClick={() => {
                              if (isEditing) {
                                setEditingId(null);
                                setEditingBody('');
                              } else {
                                setEditingId(item.id);
                                setEditingBody(item.body);
                              }
                            }}
                          >
                            <UiIcon name="edit" size={15} />
                          </button>
                          <button
                            type="button"
                            className="k-note-act"
                            aria-label={t('common.copy')}
                            title={t('common.copy')}
                            onClick={() => void handleCopy(item.body)}
                          >
                            <UiIcon name="copy" size={15} />
                          </button>
                          <button
                            type="button"
                            className="k-note-act is-danger"
                            aria-label={t('common.delete')}
                            title={t('common.delete')}
                            disabled={saving}
                            onClick={() => void handleDelete(item.id)}
                          >
                            <UiIcon name="trash" size={15} />
                          </button>
                        </div>
                      </div>

                      <div className="k-note-body">
                        {isEditing ? (
                          <div className="k-note-editor">
                            <textarea
                              className="k-note-edit-input"
                              rows={4}
                              value={editingBody}
                              onChange={(e) => setEditingBody(e.target.value)}
                              onKeyDown={(e) => {
                                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                                  e.preventDefault();
                                  void handleSaveCardEdit(item.id);
                                } else if (e.key === 'Escape') {
                                  setEditingId(null);
                                  setEditingBody('');
                                }
                              }}
                              aria-label={t('notes.editContentAria')}
                              autoFocus
                            />
                            <div className="k-note-edit-actions">
                              <button
                                type="button"
                                className="k-btn k-btn-sm k-btn-ghost"
                                data-testid="note-edit-cancel"
                                onClick={() => {
                                  setEditingId(null);
                                  setEditingBody('');
                                }}
                              >
                                {t('common.cancel')}
                              </button>
                              <button
                                type="button"
                                className="k-btn k-btn-sm k-btn-primary"
                                data-testid="note-edit-save"
                                disabled={!editingBody.trim() || saving}
                                onClick={() => void handleSaveCardEdit(item.id)}
                              >
                                {t('common.save')}
                              </button>
                            </div>
                          </div>
                        ) : item.body.trim() ? (
                          <Markdown text={item.body} />
                        ) : (
                          <span className="k-note-blank">{t('notes.blankCard')}</span>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

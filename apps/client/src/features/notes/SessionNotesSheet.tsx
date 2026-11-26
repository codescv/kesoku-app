import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Sheet, UiIcon, t as tGlobal, useT } from '@kesoku/ui';
import { kesoku } from '../../lib/client';
import { actions, useStore } from '../../lib/store';
import { Markdown } from '../segments/Markdown';
import '../persona/persona.css';

/** Engine-side cap for the session's pinned notes (`session.notes.put` rejects larger payloads). */
export const SESSION_NOTES_MAX_BYTES = 64 * 1024;

const encoder = new TextEncoder();

/** UTF-8 byte length of `text` (what the engine validates against). */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/** Only surface the byte counter once the notes get close to the cap (75%) or exceed it. */
export const SESSION_NOTES_COUNTER_AT = 48 * 1024;

function fmtBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`;
}

/** Read the session's pinned notes from the synced state files (empty string when absent). */
function useStoreNotes(sessionId: string): string {
  return useStore((s) => String(s.stateFiles[sessionId]?.['notes.md'] ?? ''));
}

/**
 * Editor for the current session's pinned notes (`notes.md` in the session's staging dir).
 * - Seeds from `stateFiles[sid]['notes.md']` (zero flash), then fetches the latest via `session.notes.get`.
 * - Live `state.sync` updates replace the content whenever there are no unsaved local edits.
 * - Empty notes open straight into the textarea so the user can type immediately; saved notes show
 *   as a rendered Markdown card (tap it / 编辑 to edit, 完成预览 to go back). Ctrl/Cmd+S or 保存 saves.
 */
export function SessionNotesEditor({ sessionId, embedded }: { sessionId: string; embedded?: boolean }) {
  const t = useT();
  const storeContent = useStoreNotes(sessionId);
  const [saved, setSaved] = useState(storeContent);
  const [draft, setDraft] = useState(storeContent);
  // Starts true: the notes are fetched on mount, so an empty note shows "正在读取…" instead of flashing the editor.
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rev, setRev] = useState(0);
  const [editing, setEditing] = useState(false);
  const dirty = draft !== saved;
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const focusNext = useRef(false);
  // Refs so async results / store updates never clobber edits typed in the meantime.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const sidRef = useRef(sessionId);
  sidRef.current = sessionId;

  // Switching sessions: reset to the new session's synced content.
  useEffect(() => {
    setSaved(storeContent);
    setDraft(storeContent);
    setLoadError(null);
    setRev((r) => r + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Live sync from `state.sync` (agent edited notes.md) while the user has no unsaved edits.
  useEffect(() => {
    if (dirtyRef.current) return;
    setSaved(storeContent);
    setDraft(storeContent);
  }, [storeContent]);

  const load = useCallback(async () => {
    const sid = sessionId;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await kesoku.getSessionNotes(sid);
      if (sidRef.current !== sid) return;
      const content = String(res?.content ?? '');
      if (!dirtyRef.current) {
        setSaved(content);
        setDraft(content);
      }
    } catch {
      if (sidRef.current === sid) setLoadError(tGlobal('snotes.readFailed'));
    } finally {
      if (sidRef.current === sid) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const bytes = utf8Bytes(draft);
  const tooLarge = bytes > SESSION_NOTES_MAX_BYTES;
  const hasSaved = saved.trim().length > 0;
  // Edit mode: explicitly entered, forced while invalid/dirty, or automatically when there is nothing saved yet.
  const showEditor = editing || tooLarge || dirty || (!hasSaved && !loading);
  const showCounter = tooLarge || bytes >= SESSION_NOTES_COUNTER_AT;

  // Any reset (session switch, save, revert) returns to the default view.
  useEffect(() => {
    setEditing(false);
  }, [rev]);

  useEffect(() => {
    if (showEditor && focusNext.current) {
      focusNext.current = false;
      taRef.current?.focus();
    }
  }, [showEditor]);

  const startEdit = () => {
    focusNext.current = true;
    setEditing(true);
  };

  const persist = useCallback(
    async (content: string, okText: string) => {
      if (saving) return;
      if (utf8Bytes(content) > SESSION_NOTES_MAX_BYTES) {
        actions.toast(tGlobal('snotes.tooLargeToast'), 'error');
        return;
      }
      const sid = sessionId;
      setSaving(true);
      try {
        const res = await kesoku.saveSessionNotes(sid, content);
        if (sidRef.current !== sid) return;
        const next = typeof res?.content === 'string' ? res.content : content;
        setSaved(next);
        setDraft(next);
        setLoadError(null);
        setRev((r) => r + 1); // back to the rendered preview
        actions.toast(okText);
      } catch {
        actions.toast(tGlobal('snotes.saveFailed'), 'error');
      } finally {
        setSaving(false);
      }
    },
    [saving, sessionId],
  );

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (dirty && !tooLarge) void persist(draft, t('snotes.saved'));
    }
  };

  return (
    <div className={'k-snotes' + (embedded ? ' is-embedded' : '')} data-testid="session-notes-editor" onKeyDown={onKeyDown}>
      {loadError && (
        <div className="k-notes-error" role="alert">
          <span>{loadError}</span>
          <button type="button" className="k-btn k-btn-sm k-btn-ghost" onClick={() => void load()}>
            {t('common.retry')}
          </button>
        </div>
      )}
      {showEditor ? (
        <textarea
          ref={taRef}
          className={'k-snotes-input' + (tooLarge ? ' is-err' : '')}
          rows={embedded ? 6 : 7}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('snotes.placeholder')}
          aria-label={t('snotes.aria')}
          aria-invalid={tooLarge || undefined}
        />
      ) : hasSaved ? (
        <div
          className="k-snotes-preview"
          data-testid="session-notes-preview"
          role="button"
          tabIndex={0}
          aria-label={t('snotes.ariaClickEdit')}
          title={t('common.clickToEdit')}
          onClick={(e) => {
            // Let links inside the rendered Markdown work without entering edit mode.
            if ((e.target as HTMLElement).closest('a')) return;
            startEdit();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.target === e.currentTarget) {
              e.preventDefault();
              startEdit();
            }
          }}
        >
          <Markdown text={draft} />
        </div>
      ) : (
        <div className="k-snotes-loading" data-testid="session-notes-loading">
          {t('snotes.loading')}
        </div>
      )}
      {tooLarge && (
        <p className="k-snotes-limit" data-testid="session-notes-too-large">
          {t('snotes.tooLargeMsg')}
        </p>
      )}
      <div className="k-snotes-bar">
        <button
          type="button"
          className="k-btn k-btn-sm k-btn-ghost"
          data-testid="session-notes-refresh"
          aria-label={t('common.refresh')}
          disabled={loading || saving}
          onClick={() => void load()}
        >
          <UiIcon name="refresh" size={15} /> {t('common.refresh')}
        </button>
        {hasSaved && (
          <button
            type="button"
            className="k-btn k-btn-sm k-btn-ghost k-snotes-clear"
            data-testid="session-notes-clear"
            disabled={saving}
            onClick={() => void persist('', t('snotes.cleared'))}
          >
            <UiIcon name="trash" size={15} /> {t('common.clear')}
          </button>
        )}
        <span className="k-snotes-spacer" />
        {showCounter && <span className={'ps-count' + (tooLarge ? ' is-err' : '')}>{`${fmtBytes(bytes)} / 64 KiB`}</span>}
        {dirty && (
          <span className="k-pill k-pill-sm k-pill-warn" data-testid="session-notes-dirty">
            {t('common.unsaved')}
          </span>
        )}
        {!showEditor && hasSaved && (
          <button type="button" className="k-btn k-btn-sm k-btn-ghost" data-testid="session-notes-edit" onClick={startEdit}>
            <UiIcon name="edit" size={15} /> {t('common.edit')}
          </button>
        )}
        {showEditor && hasSaved && !dirty && !tooLarge && (
          <button type="button" className="k-btn k-btn-sm k-btn-ghost" data-testid="session-notes-done" onClick={() => setEditing(false)}>
            <UiIcon name="check" size={15} /> {t('common.donePreview')}
          </button>
        )}
        {dirty && (
          <button type="button" className="k-btn k-btn-sm k-btn-ghost" data-testid="session-notes-revert" disabled={saving} onClick={() => (setDraft(saved), setRev((r) => r + 1))}>
            {t('common.revert')}
          </button>
        )}
        <button
          type="button"
          className="k-btn k-btn-sm k-btn-primary"
          data-testid="session-notes-save"
          disabled={!dirty || saving || tooLarge}
          onClick={() => void persist(draft, t('snotes.saved'))}
        >
          <UiIcon name="save" size={15} /> {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  );
}

/** Bottom sheet (centered panel on desktop) wrapping {@link SessionNotesEditor}; `sessionId === null` = closed. */
export function SessionNotesSheet({ sessionId, onClose }: { sessionId: string | null; onClose: () => void }) {
  const t = useT();
  const title = useStore((s) => (sessionId ? s.sessions[sessionId]?.title : undefined));
  return (
    <Sheet
      open={!!sessionId}
      onClose={onClose}
      className="k-snotes-sheet"
      title={
        <span className="k-snotes-title" data-testid="session-notes-sheet-title">
          <UiIcon name="pin" size={18} />
          <span>{t('topbar.pinnedNotes')}</span>
          {title && <span className="k-pill k-pill-sm k-pill-neutral k-snotes-session">{title}</span>}
        </span>
      }
    >
      {sessionId && <SessionNotesEditor sessionId={sessionId} />}
    </Sheet>
  );
}

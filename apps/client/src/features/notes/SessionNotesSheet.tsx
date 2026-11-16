import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Sheet, UiIcon } from '@kesoku/ui';
import { kesoku } from '../../lib/client';
import { actions, useStore } from '../../lib/store';
import { MarkdownEditable } from '../persona/MarkdownEditable';
import '../persona/persona.css';

/** Engine-side cap for the session's pinned notes (`session.notes.put` rejects larger payloads). */
export const SESSION_NOTES_MAX_BYTES = 64 * 1024;

const encoder = new TextEncoder();

/** UTF-8 byte length of `text` (what the engine validates against). */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

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
 * - Rendered Markdown by default; tap the preview / 编辑 to edit, Ctrl/Cmd+S or 保存 to save.
 */
export function SessionNotesEditor({ sessionId, embedded }: { sessionId: string; embedded?: boolean }) {
  const storeContent = useStoreNotes(sessionId);
  const [saved, setSaved] = useState(storeContent);
  const [draft, setDraft] = useState(storeContent);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rev, setRev] = useState(0);
  const dirty = draft !== saved;
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
      if (sidRef.current === sid) setLoadError('读取置顶 Notes 失败，请检查连接后重试');
    } finally {
      if (sidRef.current === sid) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const bytes = utf8Bytes(draft);
  const tooLarge = bytes > SESSION_NOTES_MAX_BYTES;

  const persist = useCallback(
    async (content: string, okText: string) => {
      if (saving) return;
      if (utf8Bytes(content) > SESSION_NOTES_MAX_BYTES) {
        actions.toast('置顶 Notes 超过 64 KiB 上限', 'error');
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
        actions.toast('保存置顶 Notes 失败', 'error');
      } finally {
        setSaving(false);
      }
    },
    [saving, sessionId],
  );

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (dirty && !tooLarge) void persist(draft, '已保存置顶 Notes');
    }
  };

  return (
    <div className={'k-snotes' + (embedded ? ' is-embedded' : '')} data-testid="session-notes-editor" onKeyDown={onKeyDown}>
      <p className="k-snotes-sub" data-testid="session-notes-subtitle">
        <UiIcon name="pin" size={14} /> 仅对当前会话生效：内容会作为 <code>{'<context name="notes">'}</code> 注入本会话的每一轮对话，AI 也会随时更新这里。
      </p>
      {loadError && (
        <div className="k-notes-error" role="alert">
          <span>{loadError}</span>
          <button type="button" className="k-btn k-btn-sm k-btn-ghost" onClick={() => void load()}>
            重试
          </button>
        </div>
      )}
      <MarkdownEditable
        label={
          <span className="k-snotes-label">
            notes.md
            {dirty ? (
              <span className="k-pill k-pill-sm k-pill-warn" data-testid="session-notes-dirty">
                未保存
              </span>
            ) : saved.trim() ? (
              <span className="k-pill k-pill-sm k-pill-primary">已置顶</span>
            ) : null}
          </span>
        }
        ariaLabel="当前会话置顶 Notes"
        value={draft}
        onChange={setDraft}
        rows={embedded ? 8 : 10}
        invalid={tooLarge}
        resetKey={`${sessionId}:${rev}`}
        placeholder={loading ? '正在读取…' : '还没有置顶内容 — 点击输入本会话需要始终记住的信息（支持 Markdown）…'}
        actions={<span className={'ps-count' + (tooLarge ? ' is-err' : '')}>{`${fmtBytes(bytes)} / 64 KiB`}</span>}
      />
      <div className="k-snotes-bar">
        <button
          type="button"
          className="k-btn k-btn-sm k-btn-ghost"
          data-testid="session-notes-refresh"
          aria-label="刷新"
          disabled={loading || saving}
          onClick={() => void load()}
        >
          <UiIcon name="refresh" size={15} /> 刷新
        </button>
        {saved.trim().length > 0 && (
          <button
            type="button"
            className="k-btn k-btn-sm k-btn-ghost k-snotes-clear"
            data-testid="session-notes-clear"
            disabled={saving}
            onClick={() => void persist('', '已清空置顶 Notes')}
          >
            <UiIcon name="trash" size={15} /> 清空
          </button>
        )}
        <span className="k-snotes-spacer" />
        {dirty && (
          <button type="button" className="k-btn k-btn-sm k-btn-ghost" data-testid="session-notes-revert" disabled={saving} onClick={() => (setDraft(saved), setRev((r) => r + 1))}>
            撤销
          </button>
        )}
        <button
          type="button"
          className="k-btn k-btn-sm k-btn-primary"
          data-testid="session-notes-save"
          disabled={!dirty || saving || tooLarge}
          onClick={() => void persist(draft, '已保存置顶 Notes')}
        >
          <UiIcon name="save" size={15} /> {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
}

/** Bottom sheet (centered panel on desktop) wrapping {@link SessionNotesEditor}; `sessionId === null` = closed. */
export function SessionNotesSheet({ sessionId, onClose }: { sessionId: string | null; onClose: () => void }) {
  const title = useStore((s) => (sessionId ? s.sessions[sessionId]?.title : undefined));
  return (
    <Sheet
      open={!!sessionId}
      onClose={onClose}
      height="half"
      className="k-snotes-sheet"
      title={
        <span className="k-snotes-title" data-testid="session-notes-sheet-title">
          <UiIcon name="pin" size={18} /> 当前会话置顶 Notes
          {title && <small className="k-snotes-session">{title}</small>}
        </span>
      }
    >
      {sessionId && <SessionNotesEditor sessionId={sessionId} />}
    </Sheet>
  );
}

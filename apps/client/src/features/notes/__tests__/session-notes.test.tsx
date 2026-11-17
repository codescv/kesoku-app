import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { makeEnvelope } from '@kesoku/protocol';

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  getSessionNotes: vi.fn(),
  saveSessionNotes: vi.fn(),
}));

vi.mock('../../../lib/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/client')>();
  return {
    ...actual,
    kesoku: { ...actual.kesoku, rpc: m.rpc, getSessionNotes: m.getSessionNotes, saveSessionNotes: m.saveSessionNotes },
  };
});

import { SessionNotesEditor, SessionNotesSheet, utf8Bytes, SESSION_NOTES_COUNTER_AT, SESSION_NOTES_MAX_BYTES } from '../SessionNotesSheet';
import { NotesPanel } from '../NotesPanel';
import { SessionPanel } from '../../session/SessionPanel';
import { RoleModeCapsule } from '../../../app/TopBar';
import { actions, initialState, useStore } from '../../../lib/store';

const now = () => Date.now() / 1000;

function notesResult(session_id: string, content: string) {
  return { session_id, content, bytes: utf8Bytes(content), updated_at: content ? 1_700_000_000 : null };
}

/** Make the mocked client behave like the real one (mirror into the store). */
function wireClient(initial: Record<string, string> = {}) {
  const server: Record<string, string> = { ...initial };
  m.getSessionNotes.mockImplementation(async (sid: string) => {
    const content = server[sid] ?? '';
    actions.setSessionNotes(sid, content);
    return notesResult(sid, content);
  });
  m.saveSessionNotes.mockImplementation(async (sid: string, content: string) => {
    server[sid] = content;
    actions.setSessionNotes(sid, content);
    return notesResult(sid, content);
  });
  return server;
}

beforeEach(() => {
  useStore.setState(initialState(), true);
  m.rpc.mockReset();
  m.getSessionNotes.mockReset();
  m.saveSessionNotes.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('store · session notes', () => {
  it('defaults ui.sessionNotesId to null', () => {
    expect(initialState().ui.sessionNotesId).toBeNull();
  });

  it('setSessionNotes mirrors content into stateFiles and deletes it when blank', () => {
    useStore.setState({ stateFiles: { s1: { 'game/party.json': { members: {} } } } });
    actions.setSessionNotes('s1', '# 线索\n- 钥匙在图书馆');
    expect(useStore.getState().stateFiles.s1).toEqual({ 'game/party.json': { members: {} }, 'notes.md': '# 线索\n- 钥匙在图书馆' });
    actions.setSessionNotes('s1', '   \n');
    expect(useStore.getState().stateFiles.s1).toEqual({ 'game/party.json': { members: {} } });
    actions.setSessionNotes('s9', 'x');
    expect(useStore.getState().stateFiles.s9).toEqual({ 'notes.md': 'x' });
  });
});

describe('SessionNotesEditor', () => {
  it('shows the synced stateFiles content immediately (no flash), then refreshes from session.notes.get', async () => {
    useStore.setState({ stateFiles: { s1: { 'notes.md': '旧的置顶' } } });
    let resolve!: (v: unknown) => void;
    m.getSessionNotes.mockImplementation(() => new Promise((r) => (resolve = r)));
    render(<SessionNotesEditor sessionId="s1" />);
    expect(screen.getByText('旧的置顶')).toBeTruthy();
    expect(m.getSessionNotes).toHaveBeenCalledWith('s1');
    await act(async () => resolve(notesResult('s1', '**最新** 置顶')));
    expect(screen.getByText('最新')).toBeTruthy();
    expect(screen.queryByText('旧的置顶')).toBeNull();
  });

  it('never renders the injection jargon, the notes.md filename or the subtitle', async () => {
    wireClient({ s1: '已有内容' });
    render(<SessionNotesEditor sessionId="s1" />);
    await waitFor(() => expect(screen.getByText('已有内容')).toBeTruthy());
    const editor = screen.getByTestId('session-notes-editor');
    expect(screen.queryByTestId('session-notes-subtitle')).toBeNull();
    expect(editor.querySelector('.k-snotes-sub')).toBeNull();
    expect(editor.querySelector('.k-snotes-label')).toBeNull();
    for (const gone of ['<context name="notes">', '注入本会话的每一轮对话', 'AI 也会随时更新这里', 'notes.md', '仅对当前会话生效']) {
      expect(editor.textContent).not.toContain(gone);
    }
    fireEvent.click(screen.getByTestId('session-notes-edit'));
    expect(editor.textContent).not.toContain('notes.md');
  });

  it('opens an empty note straight into the textarea (no 编辑 click needed) after loading', async () => {
    let resolve!: (v: unknown) => void;
    m.getSessionNotes.mockImplementation(() => new Promise((r) => (resolve = r)));
    render(<SessionNotesEditor sessionId="s1" />);
    // While loading an empty note: a calm placeholder, not a flashing editor.
    expect(screen.getByTestId('session-notes-loading').textContent).toContain('正在读取');
    expect(screen.queryByLabelText('当前会话置顶 Notes')).toBeNull();
    await act(async () => resolve(notesResult('s1', '')));
    const ta = screen.getByLabelText('当前会话置顶 Notes') as HTMLTextAreaElement;
    expect(ta.tagName).toBe('TEXTAREA');
    expect(ta.placeholder).toBe('记录本会话需要始终记住的设定、规则或备忘（支持 Markdown）…');
    expect(ta.rows).toBe(7);
    expect(ta.className).toContain('k-snotes-input');
    expect(screen.queryByTestId('session-notes-loading')).toBeNull();
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
    expect(screen.queryByText('完成预览')).toBeNull(); // nothing to preview yet
    expect(screen.queryByTestId('session-notes-clear')).toBeNull();
    expect((screen.getByTestId('session-notes-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('embedded editor uses 6 rows', async () => {
    wireClient({ s1: '' });
    render(<SessionNotesEditor sessionId="s1" embedded />);
    await waitFor(() => expect(screen.getByLabelText('当前会话置顶 Notes')).toBeTruthy());
    expect((screen.getByLabelText('当前会话置顶 Notes') as HTMLTextAreaElement).rows).toBe(6);
    expect(screen.getByTestId('session-notes-editor').className).toContain('is-embedded');
  });

  it('hides the byte counter for small notes and shows it from 48 KiB / when too large', async () => {
    wireClient({ s1: '' });
    render(<SessionNotesEditor sessionId="s1" />);
    const ta = await screen.findByLabelText('当前会话置顶 Notes');
    expect(screen.queryByText(/\/ 64 KiB/)).toBeNull(); // never "0 B / 64 KiB"
    fireEvent.change(ta, { target: { value: 'x'.repeat(1000) } });
    expect(screen.queryByText(/\/ 64 KiB/)).toBeNull();
    fireEvent.change(ta, { target: { value: 'x'.repeat(SESSION_NOTES_COUNTER_AT - 1) } });
    expect(screen.queryByText(/\/ 64 KiB/)).toBeNull();
    fireEvent.change(ta, { target: { value: 'x'.repeat(SESSION_NOTES_COUNTER_AT) } });
    const counter = screen.getByText('48.0 KiB / 64 KiB');
    expect(counter.className).toBe('ps-count');
    expect(screen.queryByTestId('session-notes-too-large')).toBeNull();
  });

  it('edits raw Markdown and saves with the 保存 button', async () => {
    const server = wireClient({ s1: '' });
    render(<SessionNotesEditor sessionId="s1" />);
    const ta = (await screen.findByLabelText('当前会话置顶 Notes')) as HTMLTextAreaElement;
    expect(screen.queryByTestId('session-notes-dirty')).toBeNull();
    fireEvent.change(ta, { target: { value: '- 队长：小张\n- 目标：找到钥匙' } });
    expect(screen.getByTestId('session-notes-dirty').textContent).toBe('未保存');
    expect(screen.getByTestId('session-notes-revert')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByTestId('session-notes-save')));
    expect(m.saveSessionNotes).toHaveBeenCalledWith('s1', '- 队长：小张\n- 目标：找到钥匙');
    expect(server.s1).toBe('- 队长：小张\n- 目标：找到钥匙');
    expect(useStore.getState().stateFiles.s1?.['notes.md']).toBe('- 队长：小张\n- 目标：找到钥匙');
    expect(useStore.getState().toasts.map((t) => t.text)).toContain('已保存置顶 Notes');
    // Back to the rendered preview card after saving.
    expect(screen.queryByLabelText('当前会话置顶 Notes')).toBeNull();
    expect(screen.getByTestId('session-notes-preview')).toBeTruthy();
    expect(screen.getByText('目标：找到钥匙')).toBeTruthy();
    expect(screen.queryByTestId('session-notes-dirty')).toBeNull();
    expect(screen.queryByTestId('session-notes-revert')).toBeNull();
    expect(screen.getByTestId('session-notes-clear')).toBeTruthy();
    expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy();
  });

  it('saved notes default to the preview; 编辑 enters edit mode and 完成预览 returns while clean', async () => {
    wireClient({ s1: '# 规则\n- 不剧透' });
    render(<SessionNotesEditor sessionId="s1" />);
    await waitFor(() => expect(screen.getByText('不剧透')).toBeTruthy());
    expect(screen.queryByLabelText('当前会话置顶 Notes')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const ta = screen.getByLabelText('当前会话置顶 Notes') as HTMLTextAreaElement;
    expect(ta.value).toBe('# 规则\n- 不剧透');
    expect(document.activeElement).toBe(ta);
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
    fireEvent.click(screen.getByTestId('session-notes-done'));
    expect(screen.queryByLabelText('当前会话置顶 Notes')).toBeNull();
    expect(screen.getByText('不剧透')).toBeTruthy();
    // 完成预览 is hidden while there are unsaved edits (save or 撤销 first).
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('当前会话置顶 Notes'), { target: { value: '改了' } });
    expect(screen.queryByTestId('session-notes-done')).toBeNull();
    fireEvent.click(screen.getByTestId('session-notes-revert'));
    expect(screen.queryByLabelText('当前会话置顶 Notes')).toBeNull();
    expect(screen.getByText('不剧透')).toBeTruthy();
  });

  it('Ctrl/Cmd+S saves while editing', async () => {
    wireClient({ s1: 'a' });
    render(<SessionNotesEditor sessionId="s1" />);
    await waitFor(() => expect(m.getSessionNotes).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const ta = screen.getByLabelText('当前会话置顶 Notes');
    fireEvent.change(ta, { target: { value: 'a\nb' } });
    await act(async () => fireEvent.keyDown(ta, { key: 's', ctrlKey: true }));
    expect(m.saveSessionNotes).toHaveBeenCalledWith('s1', 'a\nb');
    m.saveSessionNotes.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('当前会话置顶 Notes'), { target: { value: 'a\nb\nc' } });
    await act(async () => fireEvent.keyDown(screen.getByLabelText('当前会话置顶 Notes'), { key: 'S', metaKey: true }));
    expect(m.saveSessionNotes).toHaveBeenCalledWith('s1', 'a\nb\nc');
    // Clean editor: Ctrl+S is a no-op.
    m.saveSessionNotes.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    await act(async () => fireEvent.keyDown(screen.getByLabelText('当前会话置顶 Notes'), { key: 's', ctrlKey: true }));
    expect(m.saveSessionNotes).not.toHaveBeenCalled();
  });

  it('tapping the rendered preview enters edit mode, but links inside it do not', async () => {
    wireClient({ s1: '点我编辑 [文档](https://example.com/doc)' });
    render(<SessionNotesEditor sessionId="s1" />);
    await waitFor(() => expect(screen.getByText('文档')).toBeTruthy());
    fireEvent.click(screen.getByText('文档'));
    expect(screen.queryByLabelText('当前会话置顶 Notes')).toBeNull();
    fireEvent.click(screen.getByTestId('session-notes-preview'));
    expect((screen.getByLabelText('当前会话置顶 Notes') as HTMLTextAreaElement).value).toBe('点我编辑 [文档](https://example.com/doc)');
  });

  it('Enter on the focused preview card enters edit mode', async () => {
    wireClient({ s1: '键盘编辑' });
    render(<SessionNotesEditor sessionId="s1" />);
    const card = await screen.findByTestId('session-notes-preview');
    expect(card.getAttribute('role')).toBe('button');
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(screen.getByLabelText('当前会话置顶 Notes')).toBeTruthy();
  });

  it('清空 saves an empty string, removes notes.md from stateFiles and reopens the empty editor', async () => {
    wireClient({ s1: '要清空的内容' });
    render(<SessionNotesEditor sessionId="s1" />);
    await waitFor(() => expect(screen.getByTestId('session-notes-clear')).toBeTruthy());
    await act(async () => fireEvent.click(screen.getByTestId('session-notes-clear')));
    expect(m.saveSessionNotes).toHaveBeenCalledWith('s1', '');
    expect(useStore.getState().stateFiles.s1?.['notes.md']).toBeUndefined();
    expect(screen.queryByTestId('session-notes-clear')).toBeNull();
    expect(useStore.getState().toasts.map((t) => t.text)).toContain('已清空置顶 Notes');
    expect((screen.getByLabelText('当前会话置顶 Notes') as HTMLTextAreaElement).value).toBe('');
  });

  it('auto-syncs live state.sync updates when clean, but never clobbers unsaved edits', async () => {
    wireClient({ s1: 'v1' });
    render(<SessionNotesEditor sessionId="s1" />);
    await waitFor(() => expect(screen.getByText('v1')).toBeTruthy());
    act(() => useStore.setState((s) => ({ stateFiles: { ...s.stateFiles, s1: { 'notes.md': 'v2 by agent' } } })));
    expect(screen.getByText('v2 by agent')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('当前会话置顶 Notes'), { target: { value: 'my local edit' } });
    act(() => useStore.setState((s) => ({ stateFiles: { ...s.stateFiles, s1: { 'notes.md': 'v3 by agent' } } })));
    expect((screen.getByLabelText('当前会话置顶 Notes') as HTMLTextAreaElement).value).toBe('my local edit');
    // 撤销 drops the local edit and shows the latest synced content.
    fireEvent.click(screen.getByTestId('session-notes-revert'));
    expect(screen.queryByTestId('session-notes-dirty')).toBeNull();
  });

  it('an empty editor flips to the preview when the agent writes notes while the user has not typed', async () => {
    wireClient({ s1: '' });
    render(<SessionNotesEditor sessionId="s1" />);
    await screen.findByLabelText('当前会话置顶 Notes');
    act(() => useStore.setState((s) => ({ stateFiles: { ...s.stateFiles, s1: { 'notes.md': 'AI 记下的线索' } } })));
    expect(screen.queryByLabelText('当前会话置顶 Notes')).toBeNull();
    expect(screen.getByText('AI 记下的线索')).toBeTruthy();
  });

  it('刷新 refetches; load failures show a retryable error', async () => {
    m.getSessionNotes.mockRejectedValueOnce(new Error('offline'));
    render(<SessionNotesEditor sessionId="s1" />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    m.getSessionNotes.mockResolvedValueOnce(notesResult('s1', '恢复了'));
    await act(async () => fireEvent.click(screen.getByTestId('session-notes-refresh')));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('恢复了')).toBeTruthy();
    expect(m.getSessionNotes).toHaveBeenCalledTimes(2);
  });

  it('重试 in the load error alert refetches', async () => {
    m.getSessionNotes.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(notesResult('s1', '重试成功'));
    render(<SessionNotesEditor sessionId="s1" />);
    const alert = await screen.findByRole('alert');
    await act(async () => fireEvent.click(within(alert).getByRole('button', { name: '重试' })));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('重试成功')).toBeTruthy();
  });

  it('save failure keeps the draft and toasts an error', async () => {
    m.getSessionNotes.mockResolvedValue(notesResult('s1', ''));
    m.saveSessionNotes.mockRejectedValue(new Error('boom'));
    render(<SessionNotesEditor sessionId="s1" />);
    fireEvent.change(await screen.findByLabelText('当前会话置顶 Notes'), { target: { value: '保留我' } });
    await act(async () => fireEvent.click(screen.getByTestId('session-notes-save')));
    expect((screen.getByLabelText('当前会话置顶 Notes') as HTMLTextAreaElement).value).toBe('保留我');
    expect(screen.getByTestId('session-notes-dirty')).toBeTruthy();
    expect(useStore.getState().toasts.map((t) => t.text)).toContain('保存置顶 Notes 失败');
  });

  it('blocks saving content above 64 KiB with an error counter and message', async () => {
    m.getSessionNotes.mockResolvedValue(notesResult('s1', ''));
    render(<SessionNotesEditor sessionId="s1" />);
    const ta = await screen.findByLabelText('当前会话置顶 Notes');
    fireEvent.change(ta, { target: { value: '字'.repeat(SESSION_NOTES_MAX_BYTES / 3 + 10) } });
    expect((screen.getByTestId('session-notes-save') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/\/ 64 KiB/).className).toContain('is-err');
    expect(screen.getByTestId('session-notes-too-large').textContent).toContain('64 KiB');
    expect(screen.getByLabelText('当前会话置顶 Notes').getAttribute('aria-invalid')).toBe('true');
    await act(async () => fireEvent.keyDown(screen.getByLabelText('当前会话置顶 Notes'), { key: 's', ctrlKey: true }));
    expect(m.saveSessionNotes).not.toHaveBeenCalled();
  });
});

describe('SessionNotesSheet', () => {
  it('is closed when sessionId is null and opens with a clean title + session pill, auto-sized', async () => {
    wireClient({ s1: '置顶内容' });
    useStore.setState({ sessions: { s1: { session_id: 's1', title: '校园怪谈调查', mode_id: 'trpg', updated_at: now() } as never } });
    const onClose = vi.fn();
    const { rerender } = render(<SessionNotesSheet sessionId={null} onClose={onClose} />);
    expect(screen.queryByTestId('session-notes-editor')).toBeNull();
    rerender(<SessionNotesSheet sessionId="s1" onClose={onClose} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('k-sheet-auto');
    expect(dialog.className).not.toContain('k-sheet-half');
    const title = within(dialog).getByTestId('session-notes-sheet-title');
    expect(title.className).toBe('k-snotes-title');
    expect(title.querySelector('[data-ui-icon="pin"]')).toBeTruthy();
    expect(title.textContent).toContain('置顶 Notes');
    expect(title.textContent).not.toContain('当前会话置顶 Notes');
    const pill = title.querySelector('.k-snotes-session')!;
    expect(pill.textContent).toBe('校园怪谈调查');
    expect(pill.className).toContain('k-pill');
    expect(pill.className).toContain('k-pill-neutral');
    await waitFor(() => expect(within(dialog).getByText('置顶内容')).toBeTruthy());
    expect(dialog.textContent).not.toContain('notes.md');
    expect(dialog.textContent).not.toContain('<context name="notes">');
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('omits the session pill when the session has no title', () => {
    wireClient({ s1: '' });
    render(<SessionNotesSheet sessionId="s1" onClose={() => {}} />);
    expect(screen.getByTestId('session-notes-sheet-title').querySelector('.k-snotes-session')).toBeNull();
  });
});

describe('entry points', () => {
  it('TopBar RoleMode sheet: 置顶 Notes row with 已置顶 pill opens the sheet; no global entries', () => {
    useStore.setState({ stateFiles: { s1: { 'notes.md': '  \n' } } });
    const { unmount } = render(<RoleModeCapsule sessionId="s1" modeId="chat" />);
    fireEvent.click(screen.getByRole('button', { name: '角色与模式' }));
    const row = screen.getByTestId('topbar-session-notes-btn');
    expect(row.textContent).toContain('置顶 Notes');
    expect(row.querySelector('[data-ui-icon="pin"]')).toBeTruthy();
    expect(row.querySelector('.k-pill-primary')).toBeNull(); // whitespace-only = not pinned
    expect(screen.queryByTestId('topbar-notes-btn')).toBeNull();
    expect(screen.queryByText(/简易便签/)).toBeNull();
    // The session row is the last entry of the role section, right after the role list.
    expect(row.previousElementSibling?.className).toBe('k-rm-roles');
    expect(row.nextElementSibling).toBeNull();
    act(() => actions.setSessionNotes('s1', '记住：钥匙在图书馆'));
    expect(screen.getByTestId('topbar-session-notes-btn').querySelector('.k-pill-primary')?.textContent).toBe('已置顶');
    fireEvent.click(screen.getByTestId('topbar-session-notes-btn'));
    expect(useStore.getState().ui.sessionNotesId).toBe('s1');
    expect(screen.queryByTestId('topbar-session-notes-btn')).toBeNull(); // RoleMode sheet closed
    unmount();
  });

  it('TopBar hides the session notes row before a session exists', () => {
    render(<RoleModeCapsule sessionId={null} modeId="chat" />);
    fireEvent.click(screen.getByRole('button', { name: '角色与模式' }));
    expect(screen.queryByTestId('topbar-session-notes-btn')).toBeNull();
    expect(screen.queryByTestId('topbar-notes-btn')).toBeNull();
  });

  it('SessionEditMenu: 置顶 Notes action opens the sheet for that session and closes the drawer', () => {
    useStore.setState((s) => ({
      sessions: { s2: { session_id: 's2', title: '跑团夜', mode_id: 'trpg', updated_at: now(), role: 'asuka' } as never },
      ui: { ...s.ui, drawerOpen: true },
    }));
    render(<SessionPanel onNavigate={() => {}} />);
    fireEvent.contextMenu(screen.getByText('跑团夜').closest('.k-srow')!.querySelector('.k-srow-main')!);
    const menu = screen.getByTestId('session-edit-menu');
    const btn = within(menu).getByTestId('session-action-notes');
    expect(btn.textContent).toContain('置顶 Notes');
    expect(btn.querySelector('[data-ui-icon="pin"]')).toBeTruthy();
    // Placed right after 重命名对话.
    expect(within(menu).getByTestId('session-action-rename').nextElementSibling).toBe(btn);
    fireEvent.click(btn);
    expect(useStore.getState().ui.sessionNotesId).toBe('s2');
    expect(useStore.getState().ui.drawerOpen).toBe(false);
    expect(screen.queryByTestId('session-edit-menu')).toBeNull();
  });

  it('SessionEditMenu desktop popover reserves room for the extra action (cardH 224)', () => {
    useStore.setState({ sessions: { s2: { session_id: 's2', title: '跑团夜', mode_id: 'trpg', updated_at: now(), role: 'asuka' } as never } });
    const origMatchMedia = window.matchMedia;
    const origH = window.innerHeight;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('1024px'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    try {
      render(<SessionPanel onNavigate={() => {}} />);
      fireEvent.contextMenu(screen.getByText('跑团夜').closest('.k-srow')!.querySelector('.k-srow-main')!, { clientX: 100, clientY: 790 });
      const menu = screen.getByTestId('session-edit-menu');
      expect(menu.getAttribute('data-popover')).toBe('true');
      expect(menu.style.top).toBe(`${800 - 224 - 12}px`);
    } finally {
      window.matchMedia = origMatchMedia;
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: origH });
    }
  });

  it('NotesPanel: no scope switcher without a session; defaults to 全局便签 and switches to 当前会话置顶', async () => {
    m.rpc.mockImplementation(async (type: string) => {
      if (type === 'workspace.read') return { content: '### 2026-11-15 18:20\n全局内容', size: 10 };
      return {};
    });
    wireClient({ s1: '会话置顶内容' });
    const { unmount } = render(<NotesPanel />);
    expect(screen.queryByTestId('notes-scope-switcher')).toBeNull();
    await waitFor(() => expect(screen.getByText('全局内容')).toBeTruthy());
    unmount();

    useStore.setState({ currentSessionId: 's1' });
    render(<NotesPanel embedded />);
    const switcher = screen.getByTestId('notes-scope-switcher');
    expect(within(switcher).getByRole('radio', { name: '全局便签' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('notes-panel').getAttribute('data-scope')).toBe('global');
    await waitFor(() => expect(screen.getByText('全局内容')).toBeTruthy());
    expect(m.getSessionNotes).not.toHaveBeenCalled();

    fireEvent.click(within(switcher).getByRole('radio', { name: '当前会话置顶' }));
    expect(screen.getByTestId('notes-panel').getAttribute('data-scope')).toBe('session');
    expect(screen.getByTestId('session-notes-editor')).toBeTruthy();
    expect(screen.getByTestId('inspector-tab-notes')).toBeTruthy(); // inspector tabs stay
    await waitFor(() => expect(screen.getByText('会话置顶内容')).toBeTruthy());
    expect(m.getSessionNotes).toHaveBeenCalledWith('s1');
    expect(screen.queryByText('全局内容')).toBeNull();
    // Session scope: no filename badge / injection jargon.
    expect(screen.getByTestId('notes-panel').textContent).not.toContain('notes.md');
    expect(screen.getByTestId('notes-panel').querySelector('.k-notes-badge')).toBeNull();
    expect(screen.queryByTestId('session-notes-subtitle')).toBeNull();

    fireEvent.click(within(screen.getByTestId('notes-scope-switcher')).getByRole('radio', { name: '全局便签' }));
    await waitFor(() => expect(screen.getByText('全局内容')).toBeTruthy());
  });
});

describe('KesokuClient · session notes RPCs', () => {
  it('getSessionNotes / saveSessionNotes call session.notes.* and mirror stateFiles', async () => {
    const actual = await vi.importActual<typeof import('../../../lib/client')>('../../../lib/client');
    const rpc = vi.fn(async (type: string, payload: Record<string, unknown>) => {
      if (type === 'session.notes.get') return makeEnvelope('session.notes.get.result', notesResult(String(payload.session_id), '远端内容'));
      if (type === 'session.notes.put') return makeEnvelope('session.notes.put.result', notesResult(String(payload.session_id), String(payload.content)));
      throw new Error(type);
    });
    actual.__test.setSocket({ send: vi.fn(() => 'req'), rpc } as never);
    const got = await actual.kesoku.getSessionNotes('s1');
    expect(rpc).toHaveBeenCalledWith('session.notes.get', { session_id: 's1' }, {});
    expect(got.content).toBe('远端内容');
    expect(useStore.getState().stateFiles.s1?.['notes.md']).toBe('远端内容');

    const put = await actual.kesoku.saveSessionNotes('s1', '');
    expect(rpc).toHaveBeenCalledWith('session.notes.put', { session_id: 's1', content: '' }, {});
    expect(put.bytes).toBe(0);
    expect(useStore.getState().stateFiles.s1?.['notes.md']).toBeUndefined();

    await actual.kesoku.saveSessionNotes('s1', '新内容');
    expect(useStore.getState().stateFiles.s1?.['notes.md']).toBe('新内容');
    actual.__test.setSocket(null as never);
  });
});

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

import { SessionNotesEditor, SessionNotesSheet, utf8Bytes, SESSION_NOTES_MAX_BYTES } from '../SessionNotesSheet';
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
    expect(screen.getByTestId('session-notes-subtitle').textContent).toContain('<context name="notes">');
    await act(async () => resolve(notesResult('s1', '**最新** 置顶')));
    expect(screen.getByText('最新')).toBeTruthy();
    expect(screen.queryByText('旧的置顶')).toBeNull();
  });

  it('edits raw Markdown and saves with the 保存 button', async () => {
    const server = wireClient({ s1: '' });
    render(<SessionNotesEditor sessionId="s1" />);
    await waitFor(() => expect(m.getSessionNotes).toHaveBeenCalled());
    // Empty: tappable placeholder, no 清空 button, 保存 disabled.
    expect(screen.queryByTestId('session-notes-clear')).toBeNull();
    expect((screen.getByTestId('session-notes-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const ta = screen.getByLabelText('当前会话置顶 Notes') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '- 队长：小张\n- 目标：找到钥匙' } });
    expect(screen.getByTestId('session-notes-dirty')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByTestId('session-notes-save')));
    expect(m.saveSessionNotes).toHaveBeenCalledWith('s1', '- 队长：小张\n- 目标：找到钥匙');
    expect(server.s1).toBe('- 队长：小张\n- 目标：找到钥匙');
    expect(useStore.getState().stateFiles.s1?.['notes.md']).toBe('- 队长：小张\n- 目标：找到钥匙');
    expect(useStore.getState().toasts.map((t) => t.text)).toContain('已保存置顶 Notes');
    // Back to the rendered preview after saving.
    expect(screen.queryByLabelText('当前会话置顶 Notes')).toBeNull();
    expect(screen.getByText('目标：找到钥匙')).toBeTruthy();
    expect(screen.queryByTestId('session-notes-dirty')).toBeNull();
    expect(screen.getByTestId('session-notes-clear')).toBeTruthy();
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
  });

  it('tapping the rendered preview enters edit mode', async () => {
    wireClient({ s1: '点我编辑' });
    render(<SessionNotesEditor sessionId="s1" />);
    await waitFor(() => expect(screen.getByText('点我编辑')).toBeTruthy());
    fireEvent.click(screen.getByText('点我编辑'));
    expect((screen.getByLabelText('当前会话置顶 Notes') as HTMLTextAreaElement).value).toBe('点我编辑');
  });

  it('清空 saves an empty string and removes notes.md from stateFiles', async () => {
    wireClient({ s1: '要清空的内容' });
    render(<SessionNotesEditor sessionId="s1" />);
    await waitFor(() => expect(screen.getByTestId('session-notes-clear')).toBeTruthy());
    await act(async () => fireEvent.click(screen.getByTestId('session-notes-clear')));
    expect(m.saveSessionNotes).toHaveBeenCalledWith('s1', '');
    expect(useStore.getState().stateFiles.s1?.['notes.md']).toBeUndefined();
    expect(screen.queryByTestId('session-notes-clear')).toBeNull();
    expect(useStore.getState().toasts.map((t) => t.text)).toContain('已清空置顶 Notes');
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

  it('save failure keeps the draft and toasts an error', async () => {
    m.getSessionNotes.mockResolvedValue(notesResult('s1', ''));
    m.saveSessionNotes.mockRejectedValue(new Error('boom'));
    render(<SessionNotesEditor sessionId="s1" />);
    await waitFor(() => expect(m.getSessionNotes).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('当前会话置顶 Notes'), { target: { value: '保留我' } });
    await act(async () => fireEvent.click(screen.getByTestId('session-notes-save')));
    expect((screen.getByLabelText('当前会话置顶 Notes') as HTMLTextAreaElement).value).toBe('保留我');
    expect(screen.getByTestId('session-notes-dirty')).toBeTruthy();
    expect(useStore.getState().toasts.map((t) => t.text)).toContain('保存置顶 Notes 失败');
  });

  it('blocks saving content above 64 KiB', async () => {
    m.getSessionNotes.mockResolvedValue(notesResult('s1', ''));
    render(<SessionNotesEditor sessionId="s1" />);
    await waitFor(() => expect(m.getSessionNotes).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('当前会话置顶 Notes'), { target: { value: '字'.repeat(SESSION_NOTES_MAX_BYTES / 3 + 10) } });
    expect((screen.getByTestId('session-notes-save') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/\/ 64 KiB/).className).toContain('is-err');
  });
});

describe('SessionNotesSheet', () => {
  it('is closed when sessionId is null and opens with the session title', async () => {
    wireClient({ s1: '置顶内容' });
    useStore.setState({ sessions: { s1: { session_id: 's1', title: '校园怪谈调查', mode_id: 'trpg', updated_at: now() } as never } });
    const onClose = vi.fn();
    const { rerender } = render(<SessionNotesSheet sessionId={null} onClose={onClose} />);
    expect(screen.queryByTestId('session-notes-editor')).toBeNull();
    rerender(<SessionNotesSheet sessionId="s1" onClose={onClose} />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('session-notes-sheet-title').textContent).toContain('当前会话置顶 Notes');
    expect(within(dialog).getByText('校园怪谈调查')).toBeTruthy();
    await waitFor(() => expect(within(dialog).getByText('置顶内容')).toBeTruthy());
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('entry points', () => {
  it('TopBar RoleMode sheet: 当前会话置顶 Notes row with 已置顶 pill opens the sheet; global label clarified', () => {
    useStore.setState({ stateFiles: { s1: { 'notes.md': '  \n' } } });
    const { unmount } = render(<RoleModeCapsule sessionId="s1" modeId="chat" />);
    fireEvent.click(screen.getByRole('button', { name: '角色与模式' }));
    const row = screen.getByTestId('topbar-session-notes-btn');
    expect(row.textContent).toContain('当前会话置顶 Notes');
    expect(row.querySelector('.k-pill-primary')).toBeNull(); // whitespace-only = not pinned
    expect(screen.getByTestId('topbar-notes-btn').textContent).toContain('简易便签 (全局)');
    // The session row sits right above the global scratchpad row.
    expect(row.nextElementSibling).toBe(screen.getByTestId('topbar-notes-btn'));
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
    expect(screen.getByTestId('topbar-notes-btn')).toBeTruthy();
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

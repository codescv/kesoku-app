import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { makeEnvelope } from '@kesoku/protocol';
import { initialState, useStore } from '../src/lib/store';
import { __test, kesoku } from '../src/lib/client';
import type { KesokuSocket } from '../src/lib/ws';
import { SessionPanel } from '../src/features/session/SessionPanel';

function fakeSocket(fail: string[] = []) {
  const rpc = vi.fn(async (type: string, _payload?: unknown, _opts?: unknown) => {
    if (fail.includes(type)) throw new Error('boom');
    return makeEnvelope(`${type}.result`, { ok: true } as Record<string, unknown>);
  });
  __test.setSocket({ send: vi.fn(() => 'req'), rpc } as unknown as KesokuSocket);
  return rpc;
}

const now = () => Date.now() / 1000;

function seed() {
  useStore.setState({
    sessions: {
      s1: { session_id: 's1', title: 'Interactive Japanese Classroom', mode_id: 'chat', updated_at: now(), role: 'asuka' } as never,
      s2: { session_id: 's2', title: '跑团夜', mode_id: 'trpg', updated_at: now() - 100, role: 'asuka' } as never,
    },
  });
}

function rowOf(title: string): HTMLElement {
  return screen.getByText(title).closest('.k-srow') as HTMLElement;
}

function rpcTypes(rpc: ReturnType<typeof fakeSocket>): string[] {
  return rpc.mock.calls.map((c) => c[0] as string);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  useStore.setState(initialState());
  seed();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('session long-press edit menu (v0.1.13)', () => {
  it('long-press (touch held 450ms) opens the edit menu without opening the session or closing the drawer', () => {
    vi.useFakeTimers();
    const rpc = fakeSocket();
    const onNavigate = vi.fn();
    const open = vi.spyOn(kesoku, 'openSession');
    render(<SessionPanel onNavigate={onNavigate} />);
    const row = rowOf('Interactive Japanese Classroom');
    fireEvent.touchStart(row, { touches: [{ clientX: 100, clientY: 100 }] });
    act(() => vi.advanceTimersByTime(450));
    fireEvent.touchEnd(row, { changedTouches: [{ clientX: 100, clientY: 100 }] });
    // A trailing synthetic click must be ignored.
    fireEvent.click(row.querySelector('.k-srow-main')!);
    const menu = screen.getByTestId('session-edit-menu');
    expect(within(menu).getByText('Interactive Japanese Classroom')).toBeTruthy();
    expect(within(menu).getByTestId('session-action-rename').textContent).toContain('重命名对话');
    expect(within(menu).getByTestId('session-action-delete').textContent).toContain('删除对话');
    expect(within(menu).getByTestId('session-action-cancel')).toBeTruthy();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(rpcTypes(rpc)).not.toContain('session.open');
  });

  it('a short tap still opens the session and closes the drawer', () => {
    vi.useFakeTimers();
    fakeSocket();
    const onNavigate = vi.fn();
    const open = vi.spyOn(kesoku, 'openSession').mockResolvedValue(undefined as never);
    render(<SessionPanel onNavigate={onNavigate} />);
    const row = rowOf('跑团夜');
    fireEvent.touchStart(row, { touches: [{ clientX: 100, clientY: 100 }] });
    act(() => vi.advanceTimersByTime(120));
    fireEvent.touchEnd(row, { changedTouches: [{ clientX: 101, clientY: 100 }] });
    fireEvent.click(row.querySelector('.k-srow-main')!);
    expect(open).toHaveBeenCalledWith('s2');
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('session-edit-menu')).toBeNull();
  });

  it('right-click (contextmenu) opens the menu; 取消 closes it', () => {
    fakeSocket();
    const onNavigate = vi.fn();
    render(<SessionPanel onNavigate={onNavigate} />);
    const ev = fireEvent.contextMenu(rowOf('跑团夜').querySelector('.k-srow-main')!);
    expect(ev).toBe(false); // default prevented → no native callout
    expect(screen.getByTestId('session-edit-menu')).toBeTruthy();
    fireEvent.click(screen.getByTestId('session-action-cancel'));
    expect(screen.queryByTestId('session-edit-menu')).toBeNull();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('renames via the menu: optimistic title, session.rename RPC, toast, drawer stays open', async () => {
    const rpc = fakeSocket();
    const onNavigate = vi.fn();
    render(<SessionPanel onNavigate={onNavigate} />);
    fireEvent.contextMenu(rowOf('Interactive Japanese Classroom').querySelector('.k-srow-main')!);
    fireEvent.click(screen.getByTestId('session-action-rename'));
    const input = screen.getByTestId('session-rename-input') as HTMLInputElement;
    expect(input.value).toBe('Interactive Japanese Classroom');
    fireEvent.change(input, { target: { value: '  日语课堂  ' } });
    fireEvent.click(screen.getByTestId('session-rename-save'));
    expect(useStore.getState().sessions.s1!.title).toBe('日语课堂');
    expect(screen.queryByTestId('session-edit-menu')).toBeNull();
    await flush();
    expect(rpc).toHaveBeenCalledWith('session.rename', { session_id: 's1', title: '日语课堂' }, {});
    expect(useStore.getState().toasts.map((t) => t.text)).toContain('已重命名对话');
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.getByText('日语课堂')).toBeTruthy();
  });

  it('deletes via the menu: optimistic removal, session.delete RPC, toast, drawer stays open', async () => {
    const rpc = fakeSocket();
    const onNavigate = vi.fn();
    useStore.setState({ currentSessionId: 's2' });
    render(<SessionPanel onNavigate={onNavigate} />);
    fireEvent.contextMenu(rowOf('跑团夜').querySelector('.k-srow-main')!);
    fireEvent.click(screen.getByTestId('session-action-delete'));
    expect(useStore.getState().sessions.s2).toBeUndefined();
    expect(useStore.getState().currentSessionId).toBeNull();
    expect(useStore.getState().ui.launchpad).toBe(true);
    expect(screen.queryByTestId('session-edit-menu')).toBeNull();
    await flush();
    expect(rpcTypes(rpc)).toContain('session.delete');
    expect(rpc.mock.calls.find((c) => c[0] === 'session.delete')![1]).toEqual({ session_id: 's2' });
    expect(useStore.getState().toasts.map((t) => t.text)).toContain('已删除对话');
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.queryByText('跑团夜')).toBeNull();
  });

  it('foreign channel sessions cannot be deleted from the app menu', () => {
    fakeSocket();
    useStore.setState({
      settings: { ...useStore.getState().settings, allChannels: true },
      sessions: { d1: { session_id: 'd1', title: 'Discord 群聊', chatbot_id: 'discord', mode_id: 'chat', updated_at: now() } as never },
    });
    render(<SessionPanel onNavigate={() => {}} />);
    fireEvent.contextMenu(rowOf('Discord 群聊').querySelector('.k-srow-main')!);
    expect((screen.getByTestId('session-action-delete') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('外部渠道会话不可在 App 内删除')).toBeTruthy();
  });

  it('the ⋯ button opens the menu without navigating', () => {
    fakeSocket();
    const onNavigate = vi.fn();
    render(<SessionPanel onNavigate={onNavigate} />);
    fireEvent.click(within(rowOf('跑团夜')).getByTestId('session-more'));
    expect(screen.getByTestId('session-edit-menu')).toBeTruthy();
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe('swipe-left inline actions (v0.1.13)', () => {
  function swipeLeft(row: HTMLElement) {
    fireEvent.touchStart(row, { touches: [{ clientX: 200, clientY: 50 }] });
    fireEvent.touchMove(row, { touches: [{ clientX: 150, clientY: 52 }] });
    fireEvent.touchEnd(row, { changedTouches: [{ clientX: 100, clientY: 52 }] });
  }

  it('swipe reveals actions; 重命名 → 保存 renames without closing the drawer', async () => {
    const rpc = fakeSocket();
    const onNavigate = vi.fn();
    render(<SessionPanel onNavigate={onNavigate} />);
    const row = rowOf('跑团夜');
    swipeLeft(row);
    // The synthetic click after a swipe must not open the session.
    fireEvent.click(row.querySelector('.k-srow-main')!);
    const actionsBar = row.querySelector('.k-srow-actions') as HTMLElement;
    expect(actionsBar).toBeTruthy();
    fireEvent.click(within(actionsBar).getByText('重命名'));
    const input = within(row).getByTestId('session-rename-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '周五跑团' } });
    fireEvent.click(within(row).getByTestId('session-rename-save'));
    expect(useStore.getState().sessions.s2!.title).toBe('周五跑团');
    await flush();
    expect(rpc).toHaveBeenCalledWith('session.rename', { session_id: 's2', title: '周五跑团' }, {});
    expect(rpcTypes(rpc)).not.toContain('session.open');
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('swipe reveals actions; 删除 deletes in one tap without closing the drawer', async () => {
    const rpc = fakeSocket();
    const onNavigate = vi.fn();
    render(<SessionPanel onNavigate={onNavigate} />);
    const row = rowOf('跑团夜');
    swipeLeft(row);
    fireEvent.click(within(row.querySelector('.k-srow-actions') as HTMLElement).getByText('删除'));
    expect(useStore.getState().sessions.s2).toBeUndefined();
    await flush();
    expect(rpcTypes(rpc)).toContain('session.delete');
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.queryByText('跑团夜')).toBeNull();
    expect(screen.getByText('Interactive Japanese Classroom')).toBeTruthy();
  });

  it('a re-render mid-gesture (conn latency tick) does not break the swipe', () => {
    fakeSocket();
    render(<SessionPanel onNavigate={() => {}} />);
    const row = rowOf('跑团夜');
    fireEvent.touchStart(row, { touches: [{ clientX: 200, clientY: 50 }] });
    act(() => useStore.setState({ conn: { ...useStore.getState().conn, latencyMs: 77 } }));
    fireEvent.touchEnd(row, { changedTouches: [{ clientX: 100, clientY: 50 }] });
    expect(row.querySelector('.k-srow-actions')).toBeTruthy();
  });

  it('swipe right closes the actions', () => {
    fakeSocket();
    render(<SessionPanel onNavigate={() => {}} />);
    const row = rowOf('跑团夜');
    swipeLeft(row);
    expect(row.querySelector('.k-srow-actions')).toBeTruthy();
    fireEvent.touchStart(row, { touches: [{ clientX: 100, clientY: 50 }] });
    fireEvent.touchEnd(row, { changedTouches: [{ clientX: 200, clientY: 50 }] });
    expect(row.querySelector('.k-srow-actions')).toBeNull();
  });
});

describe('kesoku.renameSession / deleteSession rollback (v0.1.13)', () => {
  it('rename failure restores the previous title and toasts an error', async () => {
    fakeSocket(['session.rename']);
    await kesoku.renameSession('s1', '新名字');
    expect(useStore.getState().sessions.s1!.title).toBe('Interactive Japanese Classroom');
    expect(useStore.getState().toasts.find((t) => t.text === '重命名对话失败')?.tone).toBe('error');
  });

  it('rename with a blank title is a no-op', async () => {
    const rpc = fakeSocket();
    await kesoku.renameSession('s1', '   ');
    expect(rpc).not.toHaveBeenCalled();
    expect(useStore.getState().sessions.s1!.title).toBe('Interactive Japanese Classroom');
  });

  it('delete failure restores the session (and current selection) and toasts an error', async () => {
    fakeSocket(['session.delete']);
    useStore.setState({ currentSessionId: 's1' });
    await kesoku.deleteSession('s1');
    expect(useStore.getState().sessions.s1?.title).toBe('Interactive Japanese Classroom');
    expect(useStore.getState().currentSessionId).toBe('s1');
    expect(useStore.getState().toasts.find((t) => t.text === '删除对话失败')?.tone).toBe('error');
  });
});

describe('iOS callout guard CSS (v0.1.13)', () => {
  it('long-pressing panel chrome (新会话 / footer buttons) suppresses the native context menu', () => {
    fakeSocket();
    render(<SessionPanel onNavigate={() => {}} />);
    expect(fireEvent.contextMenu(screen.getByText('新会话'))).toBe(false);
    expect(fireEvent.contextMenu(screen.getByText('设置'))).toBe(false);
    expect(fireEvent.contextMenu(screen.getByRole('searchbox', { name: '搜索历史对话' }))).toBe(true);
  });
});

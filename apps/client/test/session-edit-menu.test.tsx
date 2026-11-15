import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { makeEnvelope } from '@kesoku/protocol';
import { initialState, useStore } from '../src/lib/store';
import { APP_VERSION, __test, kesoku } from '../src/lib/client';
import type { KesokuSocket } from '../src/lib/ws';
import { RECENT_SESSIONS_LIMIT, SessionPanel } from '../src/features/session/SessionPanel';
import { SettingsScreen, compareSemver } from '../src/features/settings/SettingsScreen';
import * as platformMod from '../src/native/platform';

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

describe('session long-press & right-click edit menu (v0.1.17)', () => {
  it('removes ⋯ button and horizontal swipe inline actions, keeping only long-press and right-click', () => {
    fakeSocket();
    render(<SessionPanel onNavigate={() => {}} />);
    const row = rowOf('跑团夜');
    expect(within(row).queryByTestId('session-more')).toBeNull();
    fireEvent.touchStart(row, { touches: [{ clientX: 200, clientY: 50 }] });
    fireEvent.touchMove(row, { touches: [{ clientX: 150, clientY: 52 }] });
    fireEvent.touchEnd(row, { changedTouches: [{ clientX: 100, clientY: 52 }] });
    expect(row.querySelector('.k-srow-actions')).toBeNull();
    expect(within(row).queryByTestId('session-swipe-rename')).toBeNull();
    expect(within(row).queryByTestId('session-swipe-delete')).toBeNull();
  });

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

  it('on desktop large screens, right-click renders an anchored popover near the pointer without a full-screen scrim', () => {
    fakeSocket();
    const origMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('1024px'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    try {
      render(<SessionPanel onNavigate={() => {}} />);
      const btn = rowOf('跑团夜').querySelector('.k-srow-main')!;
      fireEvent.contextMenu(btn, { clientX: 160, clientY: 210 });
      const menu = screen.getByTestId('session-edit-menu');
      expect(menu.getAttribute('data-popover')).toBe('true');
      expect(menu.className).toContain('is-popover');
      expect(menu.querySelector('.k-sedit-scrim')).toBeNull();
      expect(menu.style.left).toBe('160px');
      expect(menu.style.top).toBe('210px');
      // Clicking outside closes the popover.
      fireEvent.mouseDown(document.body);
      expect(screen.queryByTestId('session-edit-menu')).toBeNull();
    } finally {
      window.matchMedia = origMatchMedia;
    }
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
});

describe('sidebar 10 recent sessions cap & 全部会话 sub-view (v0.1.17)', () => {
  it('shows at most 10 recent sessions on the main sidebar and moves search, role filter, and all-channels toggle into 全部会话', () => {
    fakeSocket();
    const many: Record<string, unknown> = {};
    for (let i = 1; i <= 14; i++) {
      many[`s${i}`] = {
        session_id: `s${i}`,
        title: `会话 #${i}`,
        mode_id: 'chat',
        chatbot_id: 'app',
        role: i % 2 === 0 ? 'coder' : 'asuka',
        updated_at: now() - i * 10,
      };
    }
    useStore.setState({
      personas: [
        { role_id: 'asuka', display_name: '飞鸟', tagline: '', builtin: true },
        { role_id: 'coder', display_name: 'Coder', tagline: '', builtin: true },
      ] as never,
      sessions: many as never,
    });
    render(<SessionPanel onNavigate={() => {}} />);
    expect(RECENT_SESSIONS_LIMIT).toBe(10);
    expect(document.querySelectorAll('.k-srow')).toHaveLength(10);
    expect(screen.queryByLabelText('搜索历史对话')).toBeNull();
    expect(screen.queryByRole('tablist', { name: '角色筛选' })).toBeNull();
    expect(screen.queryByText('显示全部渠道 (Discord / 微信)')).toBeNull();

    const allBtn = screen.getByTestId('all-sessions-btn');
    expect(allBtn.textContent).toContain('全部会话');
    expect(allBtn.textContent).toContain('14');
    fireEvent.click(allBtn);

    expect(screen.getByTestId('all-sessions-view')).toBeTruthy();
    expect(screen.getByLabelText('搜索历史对话')).toBeTruthy();
    expect(screen.getByRole('tablist', { name: '角色筛选' })).toBeTruthy();
    expect(screen.getByText('显示全部渠道 (Discord / 微信)')).toBeTruthy();
    expect(document.querySelectorAll('.k-srow')).toHaveLength(14);

    fireEvent.click(screen.getByRole('tab', { name: 'Coder' }));
    expect(document.querySelectorAll('.k-srow')).toHaveLength(7);

    fireEvent.click(screen.getByTestId('all-sessions-back'));
    expect(screen.queryByTestId('all-sessions-view')).toBeNull();
  });
});

describe('Android 检查更新 button in SettingsScreen (v0.1.17)', () => {
  it('compares semver accurately and checks GitHub releases on Android', async () => {
    expect(compareSemver('0.1.18', '0.1.17')).toBe(1);
    expect(compareSemver('v0.1.17', '0.1.17')).toBe(0);
    expect(compareSemver('0.1.16', '0.1.17')).toBe(-1);

    vi.spyOn(platformMod, 'getPlatform').mockReturnValue('android');
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        tag_name: 'v9.9.9',
        html_url: 'https://github.com/codescv/kesoku-app/releases/tag/v9.9.9',
        assets: [{ name: 'kesoku-v9.9.9.apk', browser_download_url: 'https://github.com/codescv/kesoku-app/releases/download/v9.9.9/kesoku-v9.9.9.apk' }],
      }),
    } as Response);

    render(<SettingsScreen onClose={() => {}} />);
    expect(screen.getByText(`Kesoku v${APP_VERSION}`)).toBeTruthy();
    const btn = screen.getByTestId('check-update-btn');
    fireEvent.click(btn);
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('update-status-text').textContent).toContain('发现新版本 v9.9.9');
    expect((screen.getByTestId('download-update-link') as HTMLAnchorElement).href).toContain('kesoku-v9.9.9.apk');
    expect(openSpy).toHaveBeenCalled();
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { makeEnvelope } from '@kesoku/protocol';
import { ICON_STYLE_KEY } from '@kesoku/ui';
import { initialState, actions, useStore } from '../src/lib/store';
import { __test, kesoku } from '../src/lib/client';
import type { KesokuSocket } from '../src/lib/ws';
import { App, THEME_COLORS, applyThemeChrome, resolveTheme } from '../src/app/App';
import { RoleModeCapsule, ModelCapsule, TopBar } from '../src/app/TopBar';
import { IconStyleCard, SettingsScreen } from '../src/features/settings/SettingsScreen';
import { SessionPanel } from '../src/features/session/SessionPanel';
import { Launchpad } from '../src/features/session/Launchpad';
import { MemoryPanel } from '../src/features/memory/MemoryPanel';

const EMOJI = /\p{Extended_Pictographic}/u;
const ORIGINAL_MATCH_MEDIA = window.matchMedia;

function fakeSocket(results: Record<string, unknown> = {}) {
  const rpc = vi.fn(async (type: string) => makeEnvelope(`${type}.result`, (results[type] ?? { ok: true }) as Record<string, unknown>));
  __test.setSocket({ send: vi.fn(() => 'req'), rpc } as unknown as KesokuSocket);
  return rpc;
}

function mockMatchMedia(dark: boolean) {
  const listeners = new Set<() => void>();
  const mq = {
    matches: dark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
  };
  window.matchMedia = vi.fn(() => mq) as unknown as typeof window.matchMedia;
  return {
    set(v: boolean) {
      mq.matches = v;
      listeners.forEach((l) => l());
    },
  };
}

beforeEach(() => {
  useStore.setState(initialState());
  localStorage.clear();
  document.head.innerHTML = '<meta name="theme-color" content="#FAF8F5" media="(prefers-color-scheme: light)" /><meta name="theme-color" content="#15171C" media="(prefers-color-scheme: dark)" />';
});
afterEach(() => {
  cleanup();
  window.matchMedia = ORIGINAL_MATCH_MEDIA;
});

describe('theme chrome sync (Item 5)', () => {
  it('resolves light/dark/system and updates <meta theme-color> + color-scheme', () => {
    const mm = mockMatchMedia(true);
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('system')).toBe('dark');
    expect(applyThemeChrome('light')).toBe('light');
    const metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
    expect(metas.every((m) => m.content === THEME_COLORS.light && !m.hasAttribute('media'))).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    applyThemeChrome('dark');
    expect(metas.every((m) => m.content === '#15171C')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');
    mm.set(false);
    expect(applyThemeChrome('system')).toBe('light');
    expect(document.documentElement.dataset.resolvedTheme).toBe('light');
  });

  it('creates the meta tag when missing', () => {
    mockMatchMedia(false);
    document.head.innerHTML = '';
    applyThemeChrome('dark');
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content).toBe('#15171C');
  });

  it('App follows settings.theme and the OS while on 跟随系统', async () => {
    const mm = mockMatchMedia(false);
    render(<App />);
    act(() => actions.setSettings({ theme: 'system' }));
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content).toBe('#FAF8F5');
    act(() => mm.set(true));
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content).toBe('#15171C');
    act(() => actions.setSettings({ theme: 'light' }));
    expect(document.documentElement.style.colorScheme).toBe('light');
  });
});

describe('TopBar (Items 1, 8, 10)', () => {
  it('uses vector icons for menu / mode / model and no emoji', () => {
    render(<TopBar sessionId="s1" modeId="trpg" onMenu={() => {}} showMenu />);
    const bar = document.querySelector('.k-topbar')!;
    expect(bar.querySelector('[data-ui-icon="menu"]')).toBeTruthy();
    expect(bar.querySelector('[data-ui-icon="spark"]')).toBeTruthy();
    expect(bar.textContent).not.toMatch(EMOJI);
  });

  it('role sheet (v0.1.27) drops global entries and mode switching; keeps roles, 置顶 Notes and 退出当前模式', () => {
    const stop = vi.spyOn(kesoku, 'stopMode').mockResolvedValue();
    render(<RoleModeCapsule sessionId="s1" modeId="jp_classroom" />);
    fireEvent.click(screen.getByRole('button', { name: '角色与模式' }));
    const sheet = screen.getByRole('dialog');
    expect(screen.queryByText(/Agent 目录/)).toBeNull();
    expect(screen.queryByText(/band/)).toBeNull();
    for (const gone of ['角色与形象工坊', '记忆库', '简易便签', '切换模式', '当前模式记忆', '仅改当前模式']) expect(sheet.textContent).not.toContain(gone);
    expect(screen.queryByTestId('topbar-notes-btn')).toBeNull();
    expect(sheet.querySelector('.k-sheet-note')).toBeNull();
    expect(sheet.querySelector('.k-rm-policy')).toBeNull();
    expect(sheet.querySelector('[role="radiogroup"]')).toBeNull(); // no PolicySegmented
    expect(screen.getByText('切换角色')).toBeTruthy();
    expect(sheet.querySelector('.k-rm-roles')).toBeTruthy();
    expect(screen.getByTestId('topbar-session-notes-btn').textContent).toContain('置顶 Notes');
    // Non-chat mode inside a session: compact 退出当前模式 row with the mode icon.
    const modeSection = screen.getByTestId('topbar-mode-section');
    expect(modeSection.querySelector('[data-mode-icon="jp_classroom"]')).toBeTruthy();
    fireEvent.click(screen.getByTestId('topbar-stop-mode'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(stop).toHaveBeenCalledWith('s1');
    stop.mockRestore();
  });

  it('role sheet omits the mode section in chat mode and before a session exists', () => {
    const { unmount } = render(<RoleModeCapsule sessionId="s1" modeId="chat" />);
    fireEvent.click(screen.getByRole('button', { name: '角色与模式' }));
    expect(screen.queryByTestId('topbar-mode-section')).toBeNull();
    expect(screen.queryByText('退出当前模式')).toBeNull();
    expect(screen.getByTestId('topbar-session-notes-btn')).toBeTruthy();
    expect(document.querySelectorAll('.k-rm-section')).toHaveLength(1);
    unmount();

    render(<RoleModeCapsule sessionId={null} modeId="trpg" />);
    fireEvent.click(screen.getByRole('button', { name: '角色与模式' }));
    expect(screen.getByText('选择对话角色')).toBeTruthy();
    expect(screen.queryByTestId('topbar-mode-section')).toBeNull();
    expect(screen.queryByTestId('topbar-session-notes-btn')).toBeNull();
    expect(screen.queryByText('切换模式')).toBeNull();
    expect(document.querySelectorAll('.k-rm-section')).toHaveLength(1);
  });

  it('model sheet drops the Hydrogen caching note and marks the active cell with a check icon', () => {
    render(<ModelCapsule sessionId={null} />);
    fireEvent.click(screen.getByRole('button', { name: '模型与思考档位' }));
    expect(document.body.textContent).not.toMatch(/显式缓存/);
    const on = document.querySelector('.k-model-cell.is-on');
    expect(on?.querySelector('[data-ui-icon="check"]')).toBeTruthy();
  });
});

describe('SessionPanel (Items 1, 6, 7)', () => {
  it('search placeholder is plain, toolbar uses icons and 文件管理 replaces Agent 目录 (band)', () => {
    useStore.setState({ sessions: { s1: { session_id: 's1', title: '跑团夜', mode_id: 'trpg', updated_at: Date.now() / 1000, role: 'asuka' } as never } });
    render(<SessionPanel />);
    expect(document.body.textContent).not.toMatch(/FTS5|band|Agent 目录/);
    expect(screen.getByText('文件管理')).toBeTruthy();
    expect(document.querySelector('.k-srow [data-mode-icon="trpg"]')).toBeTruthy();
    for (const n of ['plus', 'brain', 'folder', 'sliders']) expect(document.querySelector(`[data-ui-icon="${n}"]`)).toBeTruthy();
    expect(document.querySelector('.k-spanel-foot')!.textContent).not.toMatch(EMOJI);
    fireEvent.click(screen.getByTestId('all-sessions-btn'));
    const input = screen.getByRole('searchbox', { name: '搜索历史对话' }) as HTMLInputElement;
    expect(input.placeholder).toBe('搜索历史对话');
    expect(document.querySelector('[data-ui-icon="search"]')).toBeTruthy();
  });

  it('renders a ModeIcon for chat sessions and sessions without mode_id', () => {
    const now = Date.now() / 1000;
    useStore.setState({
      sessions: {
        a: { session_id: 'a', title: '闲聊', mode_id: 'chat', updated_at: now } as never,
        b: { session_id: 'b', title: '无模式', updated_at: now - 1 } as never,
        c: { session_id: 'c', title: '翻译', mode_id: 'translator', updated_at: now - 2 } as never,
      },
    });
    render(<SessionPanel />);
    const rows = Array.from(document.querySelectorAll('.k-srow'));
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.querySelector('.k-srow-mode [data-mode-icon]')).toBeTruthy();
    expect(document.querySelectorAll('.k-srow-mode [data-mode-icon="chat"]')).toHaveLength(2);
    expect(document.querySelector('.k-srow-mode [data-mode-icon="translator"]')).toBeTruthy();
  });
});

describe('Launchpad (Item 1)', () => {
  it('renders a ModeIcon per tile and policy glyphs instead of emoji', () => {
    render(<Launchpad />);
    expect(document.querySelectorAll('.k-mode-tile [data-mode-icon]')).toHaveLength(8);
    expect(document.querySelectorAll('.k-mode-policy [data-ui-icon^="policy-"]')).toHaveLength(8);
    expect(document.querySelector('.k-mode-grid')!.textContent).not.toMatch(EMOJI);
  });
});

describe('SettingsScreen (Items 1, 9, 10 & v0.1.20 streamline)', () => {
  it('removes duplicate navigation entries, channel sync, icon style, translator language fields, and developer jargon', () => {
    fakeSocket({ 'device.list': { devices: [] } });
    render(<SettingsScreen onClose={() => {}} />);
    const text = document.body.textContent ?? '';
    for (const gone of [
      '语音播放',
      '朗读引擎',
      '非 app 会话发送时',
      'Cloud Relay',
      'asia-east1',
      '6位设备配对码',
      '120s一次性',
      'WKWebView',
      'Keychain',
      '显式缓存',
      '出厂默认',
      '各模式记忆策略',
      '缓存路由',
      'Agent 目录',
      'band',
      '角色与形象工坊',
      '简易便签',
      'notes.md',
      '文件管理',
      '渠道同步',
      '默认显示全部渠道',
      '图标风格',
      '翻译母语',
      '常用外语',
    ]) {
      expect(text).not.toContain(gone);
    }
    expect(screen.queryByTestId('settings-notes-btn')).toBeNull();
    expect(screen.getByText('身份与设备')).toBeTruthy();
    expect(screen.getByText('外观')).toBeTruthy();
    expect(screen.getByText('记忆策略')).toBeTruthy();
    expect(screen.getByText('模型与思考深度')).toBeTruthy();
    expect(screen.getByText(/Kesoku v0\.1\./)).toBeTruthy();
    expect(document.querySelectorAll('.k-policy-row [data-mode-icon]')).toHaveLength(8);
    expect(document.querySelector('.k-screen-head')!.textContent).not.toMatch(EMOJI);
    for (const h of document.querySelectorAll('.k-set-card h2')) expect(h.textContent).not.toMatch(EMOJI);
  });

  it('shows a clean connection badge', () => {
    fakeSocket({ 'device.list': { devices: [] } });
    useStore.setState({ conn: { ...useStore.getState().conn, status: 'online', engineOnline: true, latencyMs: 42 } });
    render(<SettingsScreen onClose={() => {}} />);
    expect(document.querySelector('.k-conn-status')!.textContent).toBe('已连接 · 42ms');
    expect(document.querySelector('.k-conn-dot.is-ok')).toBeTruthy();
  });

  it('does not render 图标风格 inside SettingsScreen while IconStyleCard still switches styles app-wide', () => {
    fakeSocket({ 'device.list': { devices: [] } });
    render(
      <>
        <SettingsScreen onClose={() => {}} />
        <IconStyleCard />
      </>,
    );
    // SettingsScreen itself has no 图标风格 card.
    expect(document.querySelector('.k-settings .k-iconstyle-grid')).toBeNull();
    const group = screen.getByRole('radiogroup', { name: '图标风格' });
    const options = group.querySelectorAll('[role="radio"]');
    expect([...options].map((o) => o.querySelector('.k-iconstyle-label')!.textContent)).toEqual(['柔和双色', '极简线性', '立体徽章']);
    expect(group.querySelectorAll('[data-icon-style="badge"]').length).toBe(4);
    expect(options[0]!.getAttribute('aria-checked')).toBe('true');
    act(() => fireEvent.click(options[2]!));
    expect(localStorage.getItem(ICON_STYLE_KEY)).toBe('badge');
    expect(options[2]!.getAttribute('aria-checked')).toBe('true');
    // Non-preview icons in SettingsScreen follow the new style.
    expect(document.querySelector('.k-policy-row [data-mode-icon]')!.getAttribute('data-icon-style')).toBe('badge');
  });
});

describe('MemoryPanel (Item 10)', () => {
  it('shows 记忆库 / 常驻记忆 instead of $MEMORY_DIR / PINNED', async () => {
    fakeSocket({ 'memory.list': { files: [{ rel_path: 'user/profile.md', pinned: true, tags: [] }] } });
    await act(async () => {
      render(<MemoryPanel />);
    });
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/MEMORY_DIR|PINNED/);
    expect(screen.getByText('记忆库')).toBeTruthy();
    expect(screen.getByText('常驻记忆')).toBeTruthy();
  });
});

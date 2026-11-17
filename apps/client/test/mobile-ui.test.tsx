import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Shell } from '../src/app/Shell';
import { ModelCapsule, RoleModeCapsule, modelLabel, modelShortLabel } from '../src/app/TopBar';
import { MessageList } from '../src/features/session/MessageList';
import { Composer } from '../src/features/session/Composer';
import { APP_VERSION } from '../src/lib/client';
import { actions, initialState, useStore } from '../src/lib/store';
import * as cameraMod from '../src/native/camera';
import * as filesMod from '../src/lib/files';

const PERSONAS = [
  { role_id: 'asuka', display_name: '飞鸟 Asuka', tagline: '日语老师', builtin: true, avatar_rev: 0 },
  { role_id: 'coder', display_name: 'Coder', tagline: '编码代理', builtin: true, avatar_rev: 0 },
];

beforeEach(() => {
  useStore.setState(initialState());
  useStore.setState({
    personas: PERSONAS as never,
    conn: { ...useStore.getState().conn, status: 'online', engineOnline: true },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('v0.1.21 – v0.1.28 · version & mobile small-screen (< 768px) UI optimizations', () => {
  it('bumps APP_VERSION to 0.1.28', () => {
    expect(APP_VERSION).toBe('0.1.28');
  });

  it('modelShortLabel formats compact model + thinking level labels across all catalog entries', () => {
    expect(modelShortLabel(null)).toBe('Hydrogen · L');
    expect(modelShortLabel(undefined)).toBe('Hydrogen · L');
    expect(modelShortLabel({ llm: 'gemini', model_name: 'gemini-4-hydrogen', thinking_level: 'minimal', stream: true })).toBe('Hydrogen · Min');
    expect(modelShortLabel({ llm: 'gemini', model_name: 'gemini-3.8-flash', thinking_level: 'low', stream: true })).toBe('Flash · L');
    expect(modelShortLabel({ llm: 'gemini', model_name: 'gemini-3.5-flash-lite', thinking_level: 'low', stream: true })).toBe('Lite · L');
    expect(modelShortLabel({ llm: 'gemini', model_name: 'gemini-4-argon', thinking_level: 'medium', stream: true })).toBe('Argon · M');
    expect(modelShortLabel({ llm: 'claude', model_name: 'claude-sonnet-5-5', thinking_level: 'medium', stream: true })).toBe('Sonnet · M');
    expect(modelShortLabel({ llm: 'claude', model_name: 'claude-opus-5-5', thinking_level: 'high', stream: true })).toBe('Opus · H');
    expect(modelLabel({ llm: 'gemini', model_name: 'gemini-3.8-flash', thinking_level: 'low', stream: true })).toBe('Flash 3.8 · Low');
  });

  it('ModelCapsule renders both .k-model-text-full and .k-model-text-short', () => {
    useStore.setState({
      llmOverride: {
        s1: { llm: 'gemini', model_name: 'gemini-3.8-flash', thinking_level: 'medium', stream: true },
      },
    });
    render(<ModelCapsule sessionId="s1" />);
    const btn = screen.getByRole('button', { name: '模型与思考档位' });
    expect(btn.querySelector('.k-model-text-full')?.textContent).toBe('Flash 3.8 · Medium');
    const shortEl = btn.querySelector('.k-model-text-short');
    expect(shortEl?.textContent).toBe('Flash · M');
    expect(shortEl?.getAttribute('aria-hidden')).toBe('true');
  });

  it('RoleModeCapsule renders .k-role-name and .k-role-mode (with .is-default-chat on new chat session)', () => {
    const { rerender } = render(<RoleModeCapsule sessionId={null} modeId="chat" />);
    const btn = screen.getByRole('button', { name: '角色与模式' });
    expect(btn.querySelector('.k-role-name')?.textContent).toBe('飞鸟');
    expect(btn.querySelector('.k-role-sep')?.className).toContain('is-default-chat');
    expect(btn.querySelector('.k-role-mode')?.className).toContain('is-default-chat');
    expect(btn.querySelector('.k-role-mode')?.textContent).toBe('日常聊天');

    rerender(<RoleModeCapsule sessionId="s1" modeId="jp_classroom" />);
    expect(btn.querySelector('.k-role-name')?.textContent).toBe('飞鸟');
    expect(btn.querySelector('.k-role-sep')?.className).not.toContain('is-default-chat');
    expect(btn.querySelector('.k-role-mode')?.className).not.toContain('is-default-chat');
    expect(btn.querySelector('.k-role-mode')?.textContent).toBe('日语小课堂');
  });

  it('Shell auto-collapses ModeHud on downward scroll and expands on upward scroll, scroll-to-top, or new streaming turn', () => {
    const now = Date.now() / 1000;
    useStore.setState({
      currentSessionId: 'c1',
      sessions: {
        c1: { session_id: 'c1', title: '日语课', role: 'asuka', mode_id: 'jp_classroom', chatbot_id: 'app', updated_at: now } as never,
      },
      stateFiles: {
        c1: {
          'game/games.json': { instances: [{ id: 'g1', game: 'jp_classroom', active: true }] },
          'game/lesson.json': { book: '标日初级上', lesson: 1, segment_index: 0, segments: [{}, {}, {}], due_mistakes: 1 },
        },
      },
      items: {
        c1: [
          { key: 'u1', kind: 'user', text: '开始上课', ts: now - 20 } as never,
          { key: 'a1', kind: 'assistant', text: '今天学习第一课', ts: now - 10 } as never,
        ],
      },
      ui: { ...useStore.getState().ui, launchpad: false, screen: 'chat' },
    });

    render(<Shell />);
    const stage = document.querySelector('main.k-stage') as HTMLElement;
    expect(stage).toBeTruthy();
    expect(stage.className).toContain('has-hud');
    expect(stage.style.getPropertyValue('--hud-offset')).toBe('46px');

    const hudWrap = screen.getByTestId('mode-hud-wrap');
    expect(stage.contains(hudWrap)).toBe(true);
    expect(stage.firstElementChild).toBe(hudWrap);
    expect(hudWrap.className).not.toContain('is-collapsed');

    const scroller = document.querySelector('.k-stage-scroll') as HTMLDivElement;
    expect(scroller).toBeTruthy();
    Object.defineProperty(scroller, 'scrollHeight', { value: 1200, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(scroller, 'scrollTop', { value: 0, writable: true, configurable: true });

    // Scroll down past threshold (> 24px delta and scrollTop > 32) -> HUD collapses while --hud-offset stays constant
    act(() => {
      scroller.scrollTop = 90;
      fireEvent.scroll(scroller);
    });
    expect(hudWrap.className).toContain('is-collapsed');
    expect(stage.style.getPropertyValue('--hud-offset')).toBe('46px');

    // Scroll up (> 20px reverse delta) -> HUD expands while --hud-offset stays constant
    act(() => {
      scroller.scrollTop = 50;
      fireEvent.scroll(scroller);
    });
    expect(hudWrap.className).not.toContain('is-collapsed');
    expect(stage.style.getPropertyValue('--hud-offset')).toBe('46px');

    // Scroll down again -> HUD collapses
    act(() => {
      scroller.scrollTop = 160;
      fireEvent.scroll(scroller);
    });
    expect(hudWrap.className).toContain('is-collapsed');
    expect(stage.style.getPropertyValue('--hud-offset')).toBe('46px');

    // New streaming turn starts -> HUD automatically expands
    act(() => {
      useStore.setState((s) => ({
        previews: {
          ...s.previews,
          c1: { turn_id: 'turn-new', round_id: 0, text: '好，我们继续', thought: '', startedAt: Date.now() },
        },
      }));
    });
    expect(hudWrap.className).not.toContain('is-collapsed');

    // Scroll down to near bottom -> HUD collapses; tiny rubber-band bounce near bottom (< 24px from bottom) does not flicker HUD
    act(() => {
      scroller.scrollTop = 795;
      fireEvent.scroll(scroller);
    });
    expect(hudWrap.className).toContain('is-collapsed');

    act(() => {
      scroller.scrollTop = 780;
      fireEvent.scroll(scroller);
    });
    expect(hudWrap.className).toContain('is-collapsed');

    // Scroll to top (scrollTop <= 12) -> HUD expands
    act(() => {
      scroller.scrollTop = 4;
      fireEvent.scroll(scroller);
    });
    expect(hudWrap.className).not.toContain('is-collapsed');
    expect(stage.style.getPropertyValue('--hud-offset')).toBe('46px');
  });

  it('Shell keeps measured --hud-offset constant across hudCollapsed false <-> true transitions', () => {
    const now = Date.now() / 1000;
    useStore.setState({
      currentSessionId: 'c2',
      sessions: {
        c2: { session_id: 'c2', title: '日语课', role: 'asuka', mode_id: 'jp_classroom', chatbot_id: 'app', updated_at: now } as never,
      },
      stateFiles: {
        c2: {
          'game/games.json': { instances: [{ id: 'g1', game: 'jp_classroom', active: true }] },
          'game/lesson.json': { book: '标日初级上', lesson: 2, segment_index: 1, segments: [{}, {}, {}], due_mistakes: 2 },
        },
      },
      items: {
        c2: [{ key: 'u1', kind: 'user', text: '继续', ts: now - 10 } as never],
      },
      ui: { ...useStore.getState().ui, launchpad: false, screen: 'chat' },
    });

    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const h = this.dataset?.testid === 'mode-hud-wrap' ? (this.className.includes('is-collapsed') ? 0 : 52) : 0;
      return { width: 375, height: h, top: 0, left: 0, bottom: h, right: 375, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });

    render(<Shell />);
    const stage = document.querySelector('main.k-stage.has-hud') as HTMLElement;
    const hudWrap = screen.getByTestId('mode-hud-wrap');
    const scroller = document.querySelector('.k-stage-scroll') as HTMLDivElement;
    Object.defineProperty(scroller, 'scrollHeight', { value: 1200, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(scroller, 'scrollTop', { value: 0, writable: true, configurable: true });

    expect(stage.style.getPropertyValue('--hud-offset')).toBe('52px');

    act(() => {
      scroller.scrollTop = 100;
      fireEvent.scroll(scroller);
    });
    expect(hudWrap.className).toContain('is-collapsed');
    expect(stage.style.getPropertyValue('--hud-offset')).toBe('52px');

    act(() => {
      scroller.scrollTop = 40;
      fireEvent.scroll(scroller);
    });
    expect(hudWrap.className).not.toContain('is-collapsed');
    expect(stage.style.getPropertyValue('--hud-offset')).toBe('52px');

    rectSpy.mockRestore();
  });

  it('MessageList wraps AssistantHeader and ThinkingPill in .k-assistant-meta with full and short labels', () => {
    const now = Date.now() / 1000;
    useStore.setState({
      currentSessionId: 's1',
      sessions: {
        s1: { session_id: 's1', title: '对话', role: 'asuka', mode_id: 'chat', chatbot_id: 'app', updated_at: now } as never,
      },
      items: {
        s1: [
          {
            key: 'a1',
            kind: 'assistant',
            turn_id: 't1',
            text: '回答内容',
            ts: now,
            sender: { kind: 'assistant', role_id: 'asuka', display_name: '飞鸟' },
          } as never,
        ],
      },
      turnEvents: {
        t1: [{ turn_id: 't1', kind: 'thought', title: '思考', elapsed_ms: 1500, ts: now * 1000 }] as never,
      },
    });

    render(<MessageList sessionId="s1" modeId="chat" />);
    const meta = document.querySelector('.k-row-assistant .k-assistant-meta');
    expect(meta).toBeTruthy();
    expect(meta?.querySelector('.k-assistant-head')).toBeTruthy();
    const pill = meta?.querySelector('.k-think-pill') as HTMLButtonElement;
    expect(pill).toBeTruthy();
    expect(pill.querySelector('.k-think-label-full')?.textContent).toBe('思考与工具');
    expect(pill.querySelector('.k-think-label-short')?.textContent).toBe('思考');

    fireEvent.click(pill);
    expect(meta?.querySelector('.k-think-timeline')).toBeTruthy();
  });

  it('Composer toggles .is-empty, .has-text, and .has-files on .k-composer-row', async () => {
    const fakeFile = new File(['img'], 'photo.jpg', { type: 'image/jpeg' });
    vi.spyOn(cameraMod, 'pickImages').mockResolvedValue([fakeFile]);
    vi.spyOn(filesMod, 'compressImage').mockResolvedValue(fakeFile);

    render(<Composer sessionId="s1" modeId="chat" roleName="飞鸟" />);
    const row = document.querySelector('.k-composer-row') as HTMLDivElement;
    expect(row.className).toContain('is-empty');
    expect(row.querySelector('.k-composer-cam')).toBeTruthy();
    expect(row.querySelector('.k-composer-mic')).toBeTruthy();
    expect(row.querySelector('.k-composer-send')).toBeTruthy();

    const input = screen.getByLabelText('消息输入框');
    fireEvent.change(input, { target: { value: '你好' } });
    expect(row.className).toContain('has-text');
    expect(row.className).not.toContain('is-empty');

    fireEvent.change(input, { target: { value: '   ' } });
    expect(row.className).toContain('is-empty');

    await act(async () => {
      fireEvent.click(screen.getByLabelText('拍照或选图'));
    });
    expect(row.className).toContain('has-files');
    expect(row.className).not.toContain('is-empty');

    fireEvent.change(input, { target: { value: '加上文字' } });
    expect(row.className).toContain('has-text');
  });

  it('global.css and hud.css include @media (max-width: 767px) rules for all 6 mobile layout optimizations', () => {
    const globalCss = readFileSync(resolve(__dirname, '../src/app/global.css'), 'utf8');
    const hudCss = readFileSync(resolve(__dirname, '../../../packages/hud/src/hud.css'), 'utf8');

    expect(globalCss).toContain('@media (max-width: 767px)');
    expect(globalCss).toContain('.k-role-name');
    expect(globalCss).toContain('.k-model-text-short');
    expect(globalCss).toContain('.k-hud-collapse-wrap.is-collapsed');
    expect(globalCss).toContain('position: absolute;');
    expect(globalCss).toContain('transform: translate3d(0, -100%, 0);');
    expect(globalCss).not.toContain('max-height: 0;');
    expect(globalCss).toContain('.k-stage.has-hud .k-stage-inner');
    expect(globalCss).toContain('padding-top: calc(var(--hud-offset, 46px) + 10px);');
    expect(globalCss).toContain('.k-assistant-meta');
    expect(globalCss).toContain('.k-composer-row.is-empty .k-composer-send');
    expect(globalCss).toContain('.k-composer-row.has-text .k-composer-cam');
    expect(globalCss).toContain('.k-composer-row.has-files .k-composer-mic');

    expect(hudCss).toContain('@media (max-width: 767px)');
    expect(hudCss).toContain('backdrop-filter: blur(16px);');
    expect(hudCss).toContain('.k-hud-policy-prefix');
    expect(hudCss).toContain('.k-hud-mistakes.has-count .k-hud-mistakes-label');
  });

  it('Composer in jp_classroom mode renders Chinese placeholder without lang="ja" attribute on textarea', () => {
    render(<Composer sessionId="s1" modeId="jp_classroom" roleName="飞鸟" />);
    const textarea = screen.getByLabelText('消息输入框') as HTMLTextAreaElement;
    expect(textarea.placeholder).toBe('用日语造句...');
    expect(textarea.getAttribute('lang')).toBeNull();
  });

  it('Composer keeps textarea.style.height empty for empty and single-line text, and expands only on multiline overflow', () => {
    render(<Composer sessionId="s1" modeId="jp_classroom" roleName="飞鸟" />);
    const textarea = screen.getByLabelText('消息输入框') as HTMLTextAreaElement;

    // Initial empty state: style.height is '' so CSS height (44px mobile / 52px desktop) aligns with buttons
    expect(textarea.style.height).toBe('');

    Object.defineProperty(textarea, 'clientHeight', { value: 41, configurable: true });
    Object.defineProperty(textarea, 'offsetHeight', { value: 44, configurable: true });
    Object.defineProperty(textarea, 'scrollHeight', { value: 41, configurable: true });

    // Single-line input: scrollHeight <= clientHeight + 2 -> style.height remains ''
    fireEvent.change(textarea, { target: { value: 'こんにちは' } });
    expect(textarea.style.height).toBe('');

    // Multiline input: scrollHeight > clientHeight + 2 -> style.height expands with border (capped at 160px)
    Object.defineProperty(textarea, 'scrollHeight', { value: 85, configurable: true });
    fireEvent.change(textarea, { target: { value: 'こんにちは\n元気ですか\n今日はいい天気ですね' } });
    expect(textarea.style.height).toBe('88px');

    // Overflow beyond 160px -> capped at 160px
    Object.defineProperty(textarea, 'scrollHeight', { value: 220, configurable: true });
    fireEvent.change(textarea, { target: { value: '1\n2\n3\n4\n5\n6\n7\n8' } });
    expect(textarea.style.height).toBe('160px');

    // Clearing text resets style.height back to ''
    Object.defineProperty(textarea, 'scrollHeight', { value: 41, configurable: true });
    fireEvent.change(textarea, { target: { value: '' } });
    expect(textarea.style.height).toBe('');
  });

  it('global.css aligns .k-composer-input height and border-radius with .k-composer-btn on desktop and mobile', () => {
    const globalCss = readFileSync(resolve(__dirname, '../src/app/global.css'), 'utf8');
    expect(globalCss).toContain('height: 52px; min-height: 52px; max-height: 160px; resize: none; padding: 12px 16px; border-radius: 16px;');
    expect(globalCss).toContain('.k-composer-input { height: 44px; min-height: 44px; padding: 9.5px 13px; border-radius: 14px; font-size: 16px; line-height: 22px; }');
  });
});

describe('v0.1.27 · TopBar declutter, pinned Notes polish & inline 角色与形象工坊', () => {
  const globalCss = readFileSync(resolve(__dirname, '../src/app/global.css'), 'utf8');
  const personaCss = readFileSync(resolve(__dirname, '../src/features/persona/persona.css'), 'utf8');

  it('Android build.gradle ships versionCode 29 / versionName 0.1.28', () => {
    const gradle = readFileSync(resolve(__dirname, '../android/app/build.gradle'), 'utf8');
    expect(gradle).toMatch(/versionCode 29\b/);
    expect(gradle).toContain('versionName "0.1.28"');
  });

  it('mobile role sheet in a mode session: roles + 置顶 Notes + compact 退出当前模式, nothing else', () => {
    useStore.setState({ sessions: { s1: { session_id: 's1', title: '跑团', role: 'coder', mode_id: 'trpg', updated_at: Date.now() / 1000 } as never } });
    render(<RoleModeCapsule sessionId="s1" modeId="trpg" />);
    fireEvent.click(screen.getByRole('button', { name: '角色与模式' }));
    const sheet = screen.getByRole('dialog');
    expect(sheet.querySelectorAll('.k-rm-role')).toHaveLength(PERSONAS.length);
    expect(sheet.querySelectorAll('.k-link-row')).toHaveLength(1);
    expect(screen.getByTestId('topbar-session-notes-btn')).toBeTruthy();
    const section = screen.getByTestId('topbar-mode-section');
    expect(section.querySelectorAll('button')).toHaveLength(1);
    expect(screen.getByTestId('topbar-stop-mode').textContent).toBe('退出当前模式');
    expect(sheet.textContent).not.toMatch(/切换模式|记忆库|角色与形象工坊|简易便签|当前模式记忆/);
  });

  it('mobile Shell renders 角色与形象工坊 inside .k-col-center like other secondary screens', () => {
    useStore.setState((s) => ({ ui: { ...s.ui, screen: 'studio', launchpad: false } }));
    render(<Shell />);
    const center = document.querySelector('.k-col-center')!;
    const studio = screen.getByTestId('persona-studio');
    expect(center.contains(studio)).toBe(true);
    expect(studio.getAttribute('aria-modal')).toBeNull();
    expect(document.querySelector('.k-topbar')).toBeNull();
  });

  it('global.css: role sheet mode row replaces the policy/note rules; pinned Notes uses sans typography without the subtitle', () => {
    expect(globalCss).not.toContain('.k-rm-policy');
    expect(globalCss).not.toContain('.k-sheet-note');
    expect(globalCss).not.toContain('.k-rm-actions');
    expect(globalCss).toContain('.k-rm-mode-row');
    expect(globalCss).not.toContain('.k-snotes-sub');
    expect(globalCss).not.toContain('.k-snotes-label');
    const input = globalCss.slice(globalCss.indexOf('.k-snotes-input {'), globalCss.indexOf('}', globalCss.indexOf('.k-snotes-input {')));
    expect(input).toContain('font-family: var(--font-sans)');
    expect(input).toContain('font-size: 15px');
    expect(input).toContain('line-height: 1.6');
    expect(input).toContain('background: var(--card)');
    expect(input).not.toContain('--font-mono');
    const preview = globalCss.slice(globalCss.indexOf('.k-snotes-preview {'), globalCss.indexOf('}', globalCss.indexOf('.k-snotes-preview {')));
    expect(preview).toContain('var(--subcard');
    expect(preview).toContain('font-family: var(--font-sans)');
    expect(globalCss).not.toMatch(/\.k-snotes[^{]*\{[^}]*--font-mono/);
  });

  it('persona.css: .ps-root no longer covers the viewport and .ps-top shrinks to 50px on mobile', () => {
    const root = personaCss.slice(personaCss.indexOf('.ps-root {'), personaCss.indexOf('}', personaCss.indexOf('.ps-root {')));
    expect(root).not.toMatch(/position:\s*fixed/);
    expect(root).not.toContain('inset: 0');
    expect(root).not.toContain('var(--safe-t)');
    expect(root).toContain('flex: 1;');
    expect(root).toContain('min-height: 0;');
    expect(personaCss).toMatch(/@media \(max-width: 767px\) \{\s*\.ps-top \{[^}]*min-height: 50px;/);
  });
});

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

describe('v0.1.21 · version & mobile small-screen (< 768px) UI optimizations', () => {
  it('bumps APP_VERSION to 0.1.21', () => {
    expect(APP_VERSION).toBe('0.1.21');
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
    const hudWrap = screen.getByTestId('mode-hud-wrap');
    expect(hudWrap.className).not.toContain('is-collapsed');

    const scroller = document.querySelector('.k-stage-scroll') as HTMLDivElement;
    expect(scroller).toBeTruthy();
    Object.defineProperty(scroller, 'scrollHeight', { value: 1200, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(scroller, 'scrollTop', { value: 0, writable: true, configurable: true });

    // Scroll down past threshold (> 24px delta and scrollTop > 32) -> HUD collapses
    act(() => {
      scroller.scrollTop = 120;
      fireEvent.scroll(scroller);
    });
    expect(hudWrap.className).toContain('is-collapsed');

    // Scroll up (> 48px reverse delta) -> HUD expands
    act(() => {
      scroller.scrollTop = 50;
      fireEvent.scroll(scroller);
    });
    expect(hudWrap.className).not.toContain('is-collapsed');

    // Scroll down again -> HUD collapses
    act(() => {
      scroller.scrollTop = 160;
      fireEvent.scroll(scroller);
    });
    expect(hudWrap.className).toContain('is-collapsed');

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

    // Scroll down again -> HUD collapses, then scroll to top (scrollTop <= 12) -> HUD expands
    act(() => {
      scroller.scrollTop = 240;
      fireEvent.scroll(scroller);
    });
    expect(hudWrap.className).toContain('is-collapsed');

    act(() => {
      scroller.scrollTop = 4;
      fireEvent.scroll(scroller);
    });
    expect(hudWrap.className).not.toContain('is-collapsed');
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
    expect(globalCss).toContain('.k-assistant-meta');
    expect(globalCss).toContain('.k-composer-row.is-empty .k-composer-send');
    expect(globalCss).toContain('.k-composer-row.has-text .k-composer-cam');
    expect(globalCss).toContain('.k-composer-row.has-files .k-composer-mic');

    expect(hudCss).toContain('@media (max-width: 767px)');
    expect(hudCss).toContain('.k-hud-policy-prefix');
    expect(hudCss).toContain('.k-hud-mistakes.has-count .k-hud-mistakes-label');
  });
});

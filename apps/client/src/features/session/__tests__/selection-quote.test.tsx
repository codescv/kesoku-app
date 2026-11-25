import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const m = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  ensureSession: vi.fn(),
  upload: vi.fn(),
}));

vi.mock('../../../lib/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/client')>();
  return {
    ...actual,
    kesoku: {
      ...actual.kesoku,
      sendMessage: m.sendMessage,
      ensureSession: m.ensureSession,
      upload: m.upload,
    },
  };
});

import {
  SelectionQuote,
  computePopoverPosition,
  extractRangeText,
  findQuoteContainer,
  formatQuotedMessage,
  splitUserQuote,
} from '../SelectionQuote';
import { Composer } from '../Composer';
import { MessageList } from '../MessageList';
import { actions, initialState, useStore } from '../../../lib/store';

beforeEach(() => {
  vi.useFakeTimers();
  useStore.setState(initialState());
  actions.setConn({ status: 'online', engineOnline: true });
  m.sendMessage.mockReset().mockResolvedValue(undefined);
  m.ensureSession.mockReset().mockResolvedValue('s1');
  m.upload.mockReset();
});

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers();
});

describe('SelectionQuote helpers', () => {
  it('formats single-line and multi-line quotes into Markdown blockquotes', () => {
    expect(formatQuotedMessage('第一句', '回复内容')).toBe('> 第一句\n\n回复内容');
    expect(formatQuotedMessage('第一行\n\n第二行', '请问这是什么意思？')).toBe('> 第一行\n>\n> 第二行\n\n请问这是什么意思？');
    expect(formatQuotedMessage('   ', '纯回复')).toBe('纯回复');
  });

  it('splits leading Markdown quotes off user messages and leaves plain messages untouched', () => {
    expect(splitUserQuote('> 第一行\n> 第二行\n\n我的回复')).toEqual({
      quote: '第一行\n第二行',
      reply: '我的回复',
    });
    expect(splitUserQuote('普通消息')).toEqual({ reply: '普通消息' });
    expect(splitUserQuote('> 没有空行直接换行\n下一行')).toEqual({ reply: '> 没有空行直接换行\n下一行' });
    expect(splitUserQuote('')).toEqual({ reply: '' });
  });

  it('strips ruby furigana (<rt>/<rp>) and decorative chrome when extracting range text', () => {
    const host = document.createElement('div');
    host.innerHTML =
      '<p>今日は<ruby>漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>を<span class="k-msg-time">12:00</span>勉強する</p>';
    document.body.appendChild(host);
    const range = document.createRange();
    range.selectNodeContents(host);
    expect(extractRangeText(range)).toBe('今日は漢字を勉強する');
    host.remove();
  });

  it('computes viewport-clamped popover placement for desktop and touch', () => {
    const rect = { left: 10, right: 50, top: 200, bottom: 224, width: 40, height: 24 };
    const desktop = computePopoverPosition(rect, { width: 800, height: 600 }, false);
    expect(desktop.placement).toBe('above');
    expect(desktop.left).toBe(76); // clamped to padX
    expect(desktop.top).toBe(190);

    const nearTop = computePopoverPosition({ left: 300, right: 420, top: 20, bottom: 44, width: 120, height: 24 }, { width: 800, height: 600 }, false);
    expect(nearTop.placement).toBe('below');

    const touch = computePopoverPosition({ left: 100, right: 260, top: 200, bottom: 224, width: 160, height: 24 }, { width: 390, height: 844 }, true);
    expect(touch.placement).toBe('below');
    expect(touch.top).toBe(236);
  });

  it('ignores selections outside chat rows or inside editable inputs', () => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <div class="k-row k-row-assistant"><p id="msg">Hello</p></div>
      <div class="k-composer"><textarea id="ta">draft</textarea></div>
      <div id="other">Sidebar</div>
    `;
    document.body.appendChild(wrapper);
    expect(findQuoteContainer(wrapper.querySelector('#msg')!.firstChild)).not.toBeNull();
    expect(findQuoteContainer(wrapper.querySelector('#ta'))).toBeNull();
    expect(findQuoteContainer(wrapper.querySelector('#other')!.firstChild)).toBeNull();
    wrapper.remove();
  });
});

describe('SelectionQuote + Composer + UserBubble integration', () => {
  it('shows floating 引用回复 on message text selection, attaches quote to Composer, and sends formatted blockquote', async () => {
    const { container } = render(
      <div>
        <div className="k-row k-row-assistant">
          <div className="k-assistant-head">
            <span className="k-assistant-name">小鸟</span>
          </div>
          <div className="k-md">
            <p data-testid="assistant-p">这是需要被引用的关键句子。</p>
          </div>
        </div>
        <SelectionQuote sessionId="s1" />
        <Composer sessionId="s1" modeId="chat" roleName="小鸟" />
      </div>,
    );

    const p = screen.getByTestId('assistant-p');
    const range = document.createRange();
    range.selectNodeContents(p);
    range.getBoundingClientRect = vi.fn().mockReturnValue({
      left: 120,
      right: 320,
      top: 180,
      bottom: 204,
      width: 200,
      height: 24,
      x: 120,
      y: 180,
      toJSON: () => ({}),
    } as DOMRect);

    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    act(() => {
      fireEvent(document, new Event('selectionchange'));
      vi.advanceTimersByTime(100);
    });

    const popover = screen.getByTestId('selection-quote-popover');
    expect(popover).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '引用回复' }));

    const quoteChip = screen.getByTestId('composer-quote');
    expect(quoteChip.textContent).toContain('引用 · 小鸟');
    expect(quoteChip.textContent).toContain('这是需要被引用的关键句子。');
    expect(screen.queryByTestId('selection-quote-popover')).toBeNull();

    const ta = container.querySelector<HTMLTextAreaElement>('textarea.k-composer-input')!;
    fireEvent.change(ta, { target: { value: '请展开讲讲这句' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
    });

    expect(m.sendMessage).toHaveBeenCalledWith('s1', '> 这是需要被引用的关键句子。\n\n请展开讲讲这句', []);
    expect(screen.queryByTestId('composer-quote')).toBeNull();
  });

  it('dismisses composer quote on close button or Escape key', () => {
    actions.setUi({ composerQuote: { text: '引用的文本', speaker: '小鸟', sessionId: 's1', n: 1 } });
    const { container } = render(<Composer sessionId="s1" modeId="chat" roleName="小鸟" />);
    expect(screen.getByTestId('composer-quote')).toBeTruthy();

    const ta = container.querySelector<HTMLTextAreaElement>('textarea.k-composer-input')!;
    fireEvent.keyDown(ta, { key: 'Escape' });
    expect(screen.queryByTestId('composer-quote')).toBeNull();

    act(() => {
      actions.setUi({ composerQuote: { text: '另一段引用', sessionId: 's1', n: 2 } });
    });
    expect(screen.getByTestId('composer-quote')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消引用' }));
    expect(screen.queryByTestId('composer-quote')).toBeNull();
  });

  it('renders quoted user messages with a dedicated quote block in MessageList', () => {
    useStore.setState((s) => ({
      ...s,
      items: {
        s1: [
          {
            key: 'u1',
            kind: 'user',
            message_id: 'u1',
            text: '> 被引用的原话\n\n这是我的追问',
            ts: 1_700_000_000,
            status: 'sent',
          },
        ],
      },
    }));

    render(<MessageList sessionId="s1" modeId="chat" />);
    const q = screen.getByTestId('user-quote');
    expect(q.textContent).toBe('被引用的原话');
    expect(screen.getByText('这是我的追问')).toBeTruthy();
  });
});

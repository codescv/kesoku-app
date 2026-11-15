import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { makeEnvelope } from '@kesoku/protocol';
import { actions, initialState, useStore } from '../src/lib/store';
import { __test, kesoku } from '../src/lib/client';
import type { KesokuSocket } from '../src/lib/ws';
import { MessageList, runningToolTitle } from '../src/features/session/MessageList';
import { GalgameStage } from '../src/features/modes';
import { TypingIndicator } from '../src/features/stream/StreamingPreview';
import type { ChatItem, TurnEvent } from '../src/lib/types';
import { makeCtx } from './cards/ctx';

function fakeSocket(impl?: (type: string, payload?: Record<string, unknown>) => Promise<unknown>) {
  const rpc = vi.fn(
    impl ??
      (async (type: string, _payload?: Record<string, unknown>) =>
        makeEnvelope(`${type}.result`, { ok: true, message_id: 'm-1', client_msg_id: 'x', seq: 1 } as Record<string, unknown>)),
  );
  __test.setSocket({ send: vi.fn(() => 'req'), rpc } as unknown as KesokuSocket);
  return rpc;
}

function seedSession(sid = 's1') {
  useStore.setState((s) => ({
    currentSessionId: sid,
    sessions: { ...s.sessions, [sid]: { session_id: sid, title: 'T', role: 'asuka', chatbot_id: 'app', updated_at: 1 } },
    personas: [{ role_id: 'asuka', display_name: '飞鸟' } as never],
  }));
}

const pv = (sid = 's1') => useStore.getState().previews[sid];

beforeEach(() => {
  useStore.setState(initialState(), true);
});
afterEach(() => {
  cleanup();
  __test.setSocket(null);
});

describe('optimistic typing state (store)', () => {
  it('addLocalUser shows an empty typing preview immediately; ack re-keys it; failure clears it', () => {
    actions.addLocalUser('s1', { key: 'c:cm1', kind: 'user', client_msg_id: 'cm1', text: 'hi', ts: 1, status: 'sending' });
    expect(pv()).toMatchObject({ turn_id: 'cm1', text: '', round_id: 0 });
    actions.markUser('s1', 'cm1', { status: 'sent', message_id: 'm1' });
    expect(pv()?.turn_id).toBe('m1');

    actions.addLocalUser('s2', { key: 'c:cm2', kind: 'user', client_msg_id: 'cm2', text: 'hi', ts: 1, status: 'sending' });
    actions.markUser('s2', 'cm2', { status: 'failed' });
    expect(pv('s2')).toBeUndefined();
  });

  it('addLocalUser keeps a live (non-interrupted) preview', () => {
    useStore.setState({ previews: { s1: { turn_id: 't0', round_id: 0, text: 'streaming…', thought: '', startedAt: 1 } } });
    actions.addLocalUser('s1', { key: 'c:cm1', kind: 'user', client_msg_id: 'cm1', text: 'hi', ts: 1, status: 'sending' });
    expect(pv()?.turn_id).toBe('t0');
  });

  it('message.user (from any device) starts typing for its turn and replaces an optimistic one', () => {
    actions.addLocalUser('s1', { key: 'c:cm1', kind: 'user', client_msg_id: 'cm1', text: 'hi', ts: 1, status: 'sending' });
    const startedAt = pv()!.startedAt;
    actions.applySessionEvent('s1', 'message.user', { message_id: 'm1', client_msg_id: 'cm1', text: 'hi', ts: 1 }, 1);
    expect(pv()).toMatchObject({ turn_id: 'm1', text: '', startedAt });
    // Another device: no preview yet → typing appears.
    actions.applySessionEvent('s3', 'message.user', { message_id: 'm9', client_msg_id: 'cmX', text: 'yo', ts: 1 }, 1);
    expect(pv('s3')?.turn_id).toBe('m9');
    // Replayed message.user for an already finalized turn does not resurrect typing.
    useStore.setState((s) => ({ finalized: new Set([...s.finalized, 'old']), previews: { ...s.previews, s4: undefined } }));
    actions.applySessionEvent('s4', 'message.user', { message_id: 'old', client_msg_id: 'c', text: 'x', ts: 1 }, 1);
    expect(pv('s4')).toBeUndefined();
  });

  it('turn.event starts typing when nothing is running (e.g. after reconnect)', () => {
    actions.applySessionEvent('s1', 'turn.event', { turn_id: 't1', kind: 'tool_call', message_id: 'tc1', title: 'search', status: 'running' }, 2);
    expect(pv()).toMatchObject({ turn_id: 't1', text: '' });
  });

  it('message.final clears typing even under a different (self-healing) turn_id; Notification does not', () => {
    actions.applySessionEvent('s1', 'message.user', { message_id: 'm1', client_msg_id: 'cm1', text: 'hi', ts: 1 }, 1);
    actions.applySessionEvent('s1', 'message.final', { message_id: 'n1', turn_id: 'm1', segments: [], raw_markdown: '', ts: 2, sender: { kind: 'assistant', name: 'Notification' } }, 2);
    expect(pv()?.turn_id).toBe('m1');
    actions.applySessionEvent('s1', 'message.final', { message_id: 'a1', turn_id: 'heal-1', segments: [], raw_markdown: 'ok', ts: 3, sender: { kind: 'assistant', name: 'Kesoku' } }, 3);
    expect(pv()).toBeUndefined();
  });

  it('startTyping / clearTyping only touch their own typing preview', () => {
    const id = actions.startTyping('s1');
    expect(pv()?.turn_id).toBe(id);
    actions.clearTyping('s1', 'other');
    expect(pv()).toBeDefined();
    actions.clearTyping('s1', id);
    expect(pv()).toBeUndefined();
    useStore.setState({ previews: { s1: { turn_id: 't', round_id: 0, text: 'partial', thought: '', startedAt: 1 } } });
    actions.clearTyping('s1');
    expect(pv()?.text).toBe('partial');
  });
});

describe('optimistic typing state (client actions)', () => {
  it('sendMessage shows typing before the ack resolves', async () => {
    let resolve!: (v: unknown) => void;
    fakeSocket(() => new Promise((r) => (resolve = r)));
    const p = kesoku.sendMessage('s1', 'hello');
    expect(pv()).toMatchObject({ text: '' });
    const cm = pv()!.turn_id;
    resolve(makeEnvelope('message.ack', { client_msg_id: cm, message_id: 'm-42', seq: 3 }));
    await p;
    expect(pv()?.turn_id).toBe('m-42');
  });

  it('pick shows typing immediately and clears it when ui.pick fails', async () => {
    let reject!: (e: unknown) => void;
    fakeSocket(() => new Promise((_r, j) => (reject = j)));
    useStore.setState({ items: { s1: [{ key: 'q1', kind: 'assistant', message_id: 'q1', ts: 1 }] } });
    const p = kesoku.pick('s1', 'q1', ['A']);
    expect(pv()).toBeDefined();
    expect(useStore.getState().items.s1.filter((x) => x.kind === 'user')).toHaveLength(1);
    reject(new Error('nope'));
    await p;
    expect(pv()).toBeUndefined();
    // Failed pick: optimistic bubble removed, pills come back.
    expect(useStore.getState().items.s1.filter((x) => x.kind === 'user')).toHaveLength(0);
    expect(useStore.getState().items.s1[0].picked).toEqual([]);
  });

  it('pick inserts exactly one optimistic user bubble that message.user updates in place', async () => {
    const rpc = fakeSocket(async (type) => (type === 'ui.pick' ? makeEnvelope('message.ack', { client_msg_id: 'x', message_id: 'mu-1', seq: 2 }) : makeEnvelope(`${type}.result`, {})));
    seedSession();
    const segs = [{ type: 'question', prompt: '', choices: ['下一段', '换一句'], multi: false, question_message_id: 'q1' }];
    useStore.setState({ items: { s1: [{ key: 'q1', kind: 'assistant', message_id: 'q1', ts: 1, segments: segs as never }] } });
    render(<MessageList sessionId="s1" modeId="chat" />);
    expect(document.querySelectorAll('.k-q-choices')).toHaveLength(1);
    await act(async () => {
      await kesoku.pick('s1', 'q1', ['下一段']);
    });
    const pickCall = (rpc.mock.calls as unknown as Array<[string, Record<string, unknown>]>).find(([t]) => t === 'ui.pick');
    const payload = pickCall![1];
    expect(payload).toMatchObject({ question_message_id: 'q1', choices: ['下一段'] });
    const cm = payload.client_msg_id as string;
    expect(cm).toMatch(/^cm/);
    let users = useStore.getState().items.s1.filter((x) => x.kind === 'user');
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ client_msg_id: cm, text: '下一段', status: 'sent', message_id: 'mu-1' });
    // Choices hidden once answered; the pick is visible exactly once.
    expect(document.querySelector('.k-q-choices')).toBeNull();
    expect(screen.getAllByText('下一段')).toHaveLength(1);
    act(() => {
      actions.applySessionEvent('s1', 'message.user', { message_id: 'mu-1', client_msg_id: cm, text: '下一段', ts: 2 }, 2);
    });
    users = useStore.getState().items.s1.filter((x) => x.kind === 'user');
    expect(users).toHaveLength(1);
    expect(screen.getAllByText('下一段')).toHaveLength(1);
    expect(document.querySelectorAll('[data-testid="typing-indicator"]').length).toBe(1);
  });

  it('multi-choice pick formats one 选择：a；b bubble', async () => {
    fakeSocket(async () => makeEnvelope('message.ack', { client_msg_id: 'x', message_id: 'mu-2', seq: 2 }));
    await kesoku.pick('s1', 'q1', [' A ', 'B']);
    const users = useStore.getState().items.s1.filter((x) => x.kind === 'user');
    expect(users.map((u) => u.text)).toEqual(['选择：A；B']);
  });

  it('stopTurn drops an empty typing preview and marks partial text 已打断', async () => {
    fakeSocket();
    actions.startTyping('s1');
    await kesoku.stopTurn('s1');
    expect(pv()).toBeUndefined();
    useStore.setState({ previews: { s1: { turn_id: 't', round_id: 0, text: 'partial', thought: '', startedAt: 1 } } });
    await kesoku.stopTurn('s1');
    expect(pv()?.interrupted).toBe(true);
  });

  it('startMode / stopMode show typing optimistically and roll back on failure', async () => {
    fakeSocket(async (type) => {
      if (type === 'mode.start' || type === 'mode.stop') throw new Error('x');
      return makeEnvelope(`${type}.result`, {});
    });
    seedSession();
    const p = kesoku.startMode('trpg');
    expect(pv()).toBeDefined();
    await p;
    expect(pv()).toBeUndefined();
    const q = kesoku.stopMode('s1');
    expect(pv()).toBeDefined();
    await q;
    expect(pv()).toBeUndefined();
  });
});

describe('<TypingIndicator /> & <MessageList />', () => {
  it('TypingIndicator renders Discord dots + label, or the running tool', () => {
    const { rerender } = render(<TypingIndicator name="飞鸟" />);
    const el = screen.getByTestId('typing-indicator');
    expect(el.getAttribute('role')).toBe('status');
    expect(el.querySelectorAll('.k-typing-dots > span')).toHaveLength(3);
    expect(el.textContent).toContain('飞鸟 正在输入…');
    rerender(<TypingIndicator toolTitle="web_search" />);
    expect(screen.getByTestId('typing-indicator').textContent).toContain('AI 正在执行 web_search…');
  });

  it('runningToolTitle ignores tool calls that already have a result', () => {
    const evs = [
      { turn_id: 't', kind: 'tool_call', message_id: 'a', title: 'search', status: 'running' },
      { turn_id: 't', kind: 'tool_result', message_id: 'r', tool_call_message_id: 'a', title: 'search', status: 'ok' },
    ] as TurnEvent[];
    expect(runningToolTitle(evs)).toBeUndefined();
    expect(runningToolTitle(evs.slice(0, 1))).toBe('search');
  });

  it('shows typing on send, streams text on stream.delta, and clears on a self-healed message.final', () => {
    seedSession();
    actions.addLocalUser('s1', { key: 'c:cm1', kind: 'user', client_msg_id: 'cm1', text: '在吗', ts: 1, status: 'sending' });
    render(<MessageList sessionId="s1" modeId="chat" />);
    // Exactly one typing indicator, inline under the assistant header (which already shows the name).
    expect(document.querySelectorAll('[data-testid="typing-indicator"]').length).toBe(1);
    expect(screen.queryByTestId('typing-bar')).toBeNull();
    const inline = document.querySelector('.k-row.is-streaming [data-testid="typing-indicator"]');
    expect(inline?.textContent).toContain('正在输入…');
    expect(inline?.textContent).not.toContain('飞鸟');
    expect(inline?.getAttribute('aria-label')).toBe('飞鸟 正在输入…');
    expect(document.querySelector('.k-row.is-streaming')?.textContent?.match(/飞鸟/g)?.length).toBe(1);
    // No empty `思考与工具 · 0.0s` pill while only typing.
    expect(document.querySelector('.k-think-pill')).toBeNull();

    act(() => {
      actions.applySessionEvent('s1', 'message.user', { message_id: 'm1', client_msg_id: 'cm1', text: '在吗', ts: 1 }, 1);
      actions.applyStreamBatch([{ sid: 's1', type: 'stream.delta', payload: { turn_id: 'm1', round_id: 0, offset: 0, delta: '在的哦～' } }]);
    });
    expect(document.querySelector('.k-row.is-streaming [data-testid="typing-indicator"]')).toBeNull();
    expect(document.querySelector('.k-row.is-streaming .k-preview')?.textContent).toContain('在的哦～');
    expect(screen.queryByTestId('typing-bar')).toBeNull();
    expect(screen.queryByTestId('typing-indicator')).toBeNull();

    act(() => {
      actions.applySessionEvent('s1', 'message.final', { message_id: 'a1', turn_id: 'heal-9', segments: [{ type: 'text', markdown: '在的哦～' }], raw_markdown: '在的哦～', ts: 2, sender: { kind: 'assistant', name: 'Kesoku', role_id: 'asuka' } }, 2);
    });
    expect(document.querySelector('.k-row.is-streaming')).toBeNull();
    expect(screen.queryByTestId('typing-bar')).toBeNull();
    expect(screen.queryByTestId('typing-indicator')).toBeNull();
  });

  it('shows the running tool in the typing indicator and the thinking pill only with real events', () => {
    seedSession();
    act(() => {
      actions.applySessionEvent('s1', 'message.user', { message_id: 'm1', client_msg_id: 'cm1', text: 'q', ts: 1 }, 1);
      actions.applySessionEvent('s1', 'turn.event', { turn_id: 'm1', kind: 'tool_call', message_id: 'tc', title: 'web_search', status: 'running' }, 2);
    });
    render(<MessageList sessionId="s1" modeId="chat" />);
    expect(document.querySelector('.k-row.is-streaming [data-testid="typing-indicator"]')?.textContent).toContain('正在执行 web_search…');
    expect(document.querySelector('.k-think-pill')).not.toBeNull();
  });
});

describe('<GalgameStage /> typing', () => {
  const ITEMS: ChatItem[] = [{ key: 'u1', kind: 'user', ts: 2, text: '你好' }];
  function stage(preview: Parameters<typeof GalgameStage>[0]['preview']) {
    return render(
      <GalgameStage
        items={ITEMS}
        preview={preview}
        stateFiles={{}}
        ctx={makeCtx({ modeId: 'galgame' })}
        policy="confirm_only"
        onPolicyChange={vi.fn()}
        onPick={vi.fn()}
        onExit={vi.fn()}
        personaName="飞鸟"
      />,
    );
  }

  it('renders gg-typing in the dialogue box while the reply has not started', () => {
    stage({ turn_id: 'm1', round_id: 0, text: '', thought: '', startedAt: 1 });
    const box = screen.getByTestId('gg-box');
    expect(box.querySelector('.gg-nameplate')?.textContent).toBe('飞鸟');
    const typing = screen.getByTestId('gg-typing');
    expect(typing.getAttribute('role')).toBe('status');
    expect(typing.textContent).toContain('飞鸟 正在输入…');
  });

  it('no typing once text streams, when interrupted, or without a preview', () => {
    const { unmount } = stage({ turn_id: 'm1', round_id: 0, text: '「こんにちは」', thought: '', startedAt: 1 });
    expect(screen.queryByTestId('gg-typing')).toBeNull();
    unmount();
    const r2 = stage({ turn_id: 'm1', round_id: 0, text: '', thought: '', startedAt: 1, interrupted: true });
    expect(screen.queryByTestId('gg-typing')).toBeNull();
    r2.unmount();
    stage(null);
    expect(screen.queryByTestId('gg-typing')).toBeNull();
  });
});

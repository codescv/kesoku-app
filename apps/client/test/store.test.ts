import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEnvelope } from '@kesoku/protocol';
import { actions, initialState, upsertItem, useStore } from '../src/lib/store';
import { __test, kesoku } from '../src/lib/client';
import type { KesokuSocket } from '../src/lib/ws';

const S = 'sess0001';

function fakeSocket() {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const rpc = vi.fn(async (type: string, payload: Record<string, unknown>) => {
    sent.push({ type, payload });
    return makeEnvelope(`${type}.result`, { ok: true, status: 'applied' });
  });
  const sock = {
    send: (type: string, payload: Record<string, unknown>) => {
      sent.push({ type, payload });
      return 'req_x';
    },
    rpc,
  } as unknown as KesokuSocket;
  return { sock, sent, rpc };
}

function seqEvt(type: string, seq: number, payload: Record<string, unknown>) {
  return makeEnvelope(type, payload, { session_id: S, seq });
}

beforeEach(() => {
  useStore.setState(initialState());
  __test.tracked.clear();
  __test.gapBuffer.clear();
  __test.resyncing.clear();
});

describe('store reducers', () => {
  it('upsertItem replaces optimistic rows by client_msg_id', () => {
    const list = upsertItem([], { key: 'c:1', kind: 'user', client_msg_id: 'cm1', text: 'hi', ts: 1, status: 'sending' });
    const next = upsertItem(list, { key: 'm1', kind: 'user', message_id: 'm1', client_msg_id: 'cm1', text: 'hi', ts: 1, status: 'sent' });
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ message_id: 'm1', status: 'sent' });
  });

  it('message.final replaces the streaming preview and blocks late deltas', () => {
    actions.applyStreamBatch([{ sid: S, type: 'stream.delta', payload: { turn_id: 't1', round_id: 0, offset: 0, delta: '预览' } }]);
    expect(useStore.getState().previews[S]?.text).toBe('预览');
    actions.applySessionEvent(S, 'message.final', { message_id: 'a1', turn_id: 't1', segments: [{ type: 'text', markdown: '最终' }], raw_markdown: '最终', ts: 2 }, 5);
    const st = useStore.getState();
    expect(st.previews[S]).toBeUndefined();
    expect(st.items[S].find((i) => i.message_id === 'a1')?.segments).toHaveLength(1);
    expect(st.lastSeq[S]).toBe(5);
    actions.applyStreamBatch([{ sid: S, type: 'stream.delta', payload: { turn_id: 't1', round_id: 0, offset: 2, delta: '迟到' } }]);
    expect(useStore.getState().previews[S]).toBeUndefined();
  });

  it('state.sync merges files, removes, and confirms the optimistic mode', () => {
    actions.setUi({ pendingMode: { sessionId: S, modeId: 'galgame', at: 0 } });
    actions.applySessionEvent(S, 'state.sync', { files: { 'game/games.json': [{ game: 'galgame', active: true }], 'game/pokemon.json': {} }, removed: [], staging_rev: 1 }, 1);
    actions.applySessionEvent(S, 'state.sync', { files: {}, removed: ['game/pokemon.json'], staging_rev: 2 }, 2);
    const st = useStore.getState();
    expect(Object.keys(st.stateFiles[S])).toEqual(['game/games.json']);
    expect(st.ui.pendingMode).toBeNull();
  });

  it('memory.proposal then resolved updates status', () => {
    actions.applySessionEvent(S, 'memory.proposal', { proposal_id: 'p1', session_id: S, ops: [{ file: 'user/profile.md', section: '', text: 'x', tags: [] }], expires_at: 9 }, 3);
    expect(useStore.getState().proposals.p1.status).toBe('pending');
    actions.applySessionEvent(S, 'memory.proposal.resolved', { proposal_id: 'p1', status: 'applied', applied_files: ['user/profile.md'] }, 4);
    expect(useStore.getState().proposals.p1.status).toBe('applied');
  });

  it('media.ready indexes by placeholder and object', () => {
    actions.applySessionEvent(S, 'media.ready', { placeholder_id: 'ph', kind: 'file', object: 'media/aaaaaaaa/x.png', url: 'https://u', expires_at: 10 });
    const m = useStore.getState().media;
    expect(m.ph.url).toBe('https://u');
    expect(m['obj:media/aaaaaaaa/x.png'].url).toBe('https://u');
  });

  it('session.snapshot restores items, state, previews from active_turn', () => {
    actions.applySnapshot({
      session: { session_id: S, title: 'T', role: 'asuka', chatbot_id: 'app', updated_at: 1 },
      last_messages: [{ message_id: 'u1', role: 'user', ts: 1, text: 'hi' }, { message_id: 'a1', role: 'assistant', ts: 2, turn_id: 'u1', segments: [{ type: 'text', markdown: 'yo' }] }],
      state_files: { 'game/scene.json': { location: '江之岛' } },
      active_turn: { turn_id: 't9', round_id: 1, preview_text: '进行中' },
      head_seq: 42,
      origin_channel: 'app',
    });
    const st = useStore.getState();
    expect(st.items[S]).toHaveLength(2);
    expect(st.headSeq[S]).toBe(42);
    expect(st.previews[S]?.text).toBe('进行中');
    expect(st.finalized.has('u1')).toBe(true);
  });
});

describe('client seq gap handling', () => {
  it('in-order events apply; duplicates are ignored', () => {
    const { sock } = fakeSocket();
    __test.setSocket(sock);
    __test.tracked.add(S);
    useStore.setState({ lastSeq: { [S]: 10 } });
    __test.onEnvelope(seqEvt('message.user', 11, { message_id: 'u', text: 'a', attachments: [], ts: 1 }));
    __test.onEnvelope(seqEvt('message.user', 11, { message_id: 'u', text: 'a', attachments: [], ts: 1 }));
    expect(useStore.getState().lastSeq[S]).toBe(11);
    expect(useStore.getState().items[S]).toHaveLength(1);
  });

  it('a gap buffers events, sends sync.resume, and merges after sync.done', () => {
    const { sock, sent } = fakeSocket();
    __test.setSocket(sock);
    __test.tracked.add(S);
    useStore.setState({ lastSeq: { [S]: 10 } });
    __test.onEnvelope(seqEvt('message.user', 13, { message_id: 'u13', text: 'c', attachments: [], ts: 3 }));
    expect(useStore.getState().lastSeq[S]).toBe(10);
    expect(sent.find((x) => x.type === 'sync.resume')?.payload).toEqual({ sessions: [{ session_id: S, last_seq: 10 }] });
    // Replayed frames (unicast) fill the gap
    __test.onEnvelope({ ...seqEvt('message.user', 11, { message_id: 'u11', text: 'a', attachments: [], ts: 1 }), device_id: 'dev_me' });
    __test.onEnvelope({ ...seqEvt('message.user', 12, { message_id: 'u12', text: 'b', attachments: [], ts: 2 }), device_id: 'dev_me' });
    __test.onEnvelope(makeEnvelope('sync.done', { session_id: S, replayed_through_seq: 12, head_seq: 13, has_more: false }));
    const st = useStore.getState();
    expect(st.lastSeq[S]).toBe(13);
    expect(st.items[S].map((i) => i.message_id)).toEqual(['u11', 'u12', 'u13']);
  });

  it('has_more continues resuming from replayed_through_seq', () => {
    const { sock, sent } = fakeSocket();
    __test.setSocket(sock);
    __test.resyncing.add(S);
    __test.onEnvelope(makeEnvelope('sync.done', { session_id: S, replayed_through_seq: 500, head_seq: 900, has_more: true }));
    expect(sent.at(-1)).toEqual({ type: 'sync.resume', payload: { sessions: [{ session_id: S, last_seq: 500 }] } });
  });

  it('sync.done active_turn replaces the preview after an offset mismatch', () => {
    const { sock, sent } = fakeSocket();
    __test.setSocket(sock);
    useStore.setState({ lastSeq: { [S]: 3 } });
    __test.onEnvelope(makeEnvelope('stream.delta', { turn_id: 't', round_id: 0, offset: 0, delta: 'abc' }, { session_id: S }));
    __test.onEnvelope(makeEnvelope('stream.delta', { turn_id: 't', round_id: 0, offset: 99, delta: 'zzz' }, { session_id: S }));
    __test.streamBatcher.flushNow();
    expect(sent.some((x) => x.type === 'sync.resume')).toBe(true);
    __test.onEnvelope(makeEnvelope('sync.done', { session_id: S, replayed_through_seq: 3, head_seq: 3, has_more: false, active_turn: { turn_id: 't', round_id: 0, preview_text: 'abcdefzzz' } }));
    expect(useStore.getState().previews[S]?.text).toBe('abcdefzzz');
  });

  it('memory.policy.updated broadcasts refresh the policy map', () => {
    __test.onEnvelope(makeEnvelope('memory.policy.updated', { policies: { galgame: 'isolated' }, changed: ['galgame'], updated_at: 5 }));
    const p = useStore.getState().policies.policies;
    expect(p.galgame).toBe('isolated');
    expect(p.chat).toBe('full');
  });
});

describe('client API', () => {
  it('setPolicy is optimistic and rolls back on failure', async () => {
    const { sock, rpc } = fakeSocket();
    __test.setSocket(sock);
    (kesoku as unknown as { socket: KesokuSocket }).socket;
    rpc.mockRejectedValueOnce(new Error('nope'));
    await kesoku.setPolicy('jp_classroom', 'full');
    expect(useStore.getState().policies.policies.jp_classroom).toBe('confirm_only');
    await kesoku.setPolicy('jp_classroom', 'full');
    expect(useStore.getState().policies.policies.jp_classroom).toBe('full');
    expect(rpc).toHaveBeenLastCalledWith('memory.policy.set', { mode_id: 'jp_classroom', memory_policy: 'full' }, {});
  });

  it('resolveProposal sends edited_ops only when given', async () => {
    const { sock, rpc } = fakeSocket();
    __test.setSocket(sock);
    useStore.setState({ proposals: { p1: { proposal_id: 'p1', session_id: S, ops: [], status: 'pending', expires_at: 1 } } });
    await kesoku.resolveProposal('p1', 'dismiss');
    expect(rpc).toHaveBeenLastCalledWith('memory.proposal.resolve', { proposal_id: 'p1', action: 'dismiss' }, {});
    expect(useStore.getState().proposals.p1.status).toBe('applied');
  });
});

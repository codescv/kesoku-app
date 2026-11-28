import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEnvelope, type Envelope } from '@kesoku/protocol';
import { actions, initialState, upsertItem, useStore } from '../src/lib/store';
import { __test, kesoku } from '../src/lib/client';
import type { KesokuSocket } from '../src/lib/ws';

const S = 'sess0001';

function fakeSocket() {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const rpc = vi.fn<(type: string, payload: Record<string, unknown>) => Promise<Envelope>>(async (type, payload) => {
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

  it('media.ready indexes by placeholder and object and strips expired epoch URLs', () => {
    actions.applySessionEvent(S, 'media.ready', { placeholder_id: 'ph', kind: 'file', object: 'media/aaaaaaaa/x.png', url: 'https://u', expires_at: 10 });
    const m = useStore.getState().media;
    expect(m.ph.url).toBe('https://u');
    expect(m['obj:media/aaaaaaaa/x.png'].url).toBe('https://u');

    actions.applySessionEvent(S, 'media.ready', { placeholder_id: 'ph_exp', kind: 'file', object: 'media/aaaaaaaa/exp.png', url: 'https://expired', expires_at: 1_700_000_000 });
    expect(useStore.getState().media.ph_exp.url).toBeUndefined();
  });

  it('setPersonas updates assistant message sender.display_name in place when a role is renamed', () => {
    useStore.setState({
      sessions: { [S]: { session_id: S, title: 'T', role: 'asuka', chatbot_id: 'app', updated_at: 1 } },
      items: { [S]: [{ key: 'a1', kind: 'assistant', message_id: 'a1', ts: 1, sender: { name: 'asuka', role_id: 'asuka', display_name: '斋藤飞鸟' } }] },
    });
    actions.setPersonas([{ role_id: 'asuka', display_name: '飞鸟酱', tagline: '', builtin: true, avatar_rev: 1 }]);
    expect(useStore.getState().items[S][0].sender?.display_name).toBe('飞鸟酱');
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
    expect(st.sessions[S].updated_at).toBe(2);
  });

  it('bumps session updated_at on addLocalUser, message.user, message.final, and session.updated without regressing', () => {
    actions.setSessions([
      { session_id: 'old_created', title: 'Old', role: 'asuka', chatbot_id: 'app', created_at: 100, updated_at: 100 },
      { session_id: 'new_created', title: 'New', role: 'asuka', chatbot_id: 'app', created_at: 500, updated_at: 500 },
    ], true);

    // Sending a message in the older-created session immediately bumps its updated_at above newer-created ones.
    actions.addLocalUser('old_created', { key: 'c:1', kind: 'user', client_msg_id: 'cm1', text: 'ping', ts: 600, status: 'sending' });
    expect(useStore.getState().sessions.old_created.updated_at).toBe(600);

    // Server message.user and message.final advance updated_at monotonically.
    actions.applySessionEvent('old_created', 'message.user', { message_id: 'u1', client_msg_id: 'cm1', text: 'ping', attachments: [], ts: 605 }, 1);
    expect(useStore.getState().sessions.old_created.updated_at).toBe(605);

    actions.applySessionEvent('old_created', 'message.final', { message_id: 'a1', turn_id: 'u1', segments: [{ type: 'text', markdown: 'pong' }], raw_markdown: 'pong', ts: 620 }, 2);
    expect(useStore.getState().sessions.old_created.updated_at).toBe(620);

    // A stale replay or older session.updated must not regress updated_at.
    actions.applySessionEvent('old_created', 'message.user', { message_id: 'u0', text: 'earlier', attachments: [], ts: 120 }, 3);
    actions.applySessionEvent('old_created', 'session.updated', { session_id: 'old_created', title: 'Old Renamed', updated_at: 610 }, 4);
    expect(useStore.getState().sessions.old_created.updated_at).toBe(620);
    expect(useStore.getState().sessions.old_created.title).toBe('Old Renamed');

    const ordered = Object.values(useStore.getState().sessions)
      .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0) || b.session_id.localeCompare(a.session_id))
      .map((x) => x.session_id);
    expect(ordered).toEqual(['old_created', 'new_created']);
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

  it('getModeDefaults, setModeDefaults, listCharacters, and updateRoster sync store state', async () => {
    const { sock, rpc } = fakeSocket();
    __test.setSocket(sock);

    rpc.mockResolvedValueOnce(makeEnvelope('mode.defaults.get.result', { defaults: { story_theater: { casting_policy: 'ask_all' } } }));
    const defaults = await kesoku.getModeDefaults();
    expect(rpc).toHaveBeenLastCalledWith('mode.defaults.get', {}, {});
    expect(defaults).toEqual({ story_theater: { casting_policy: 'ask_all' } });
    expect(useStore.getState().modeDefaults).toEqual({ story_theater: { casting_policy: 'ask_all' } });

    rpc.mockResolvedValueOnce(makeEnvelope('mode.defaults.set.result', { mode_id: 'story_theater', prefs: { casting_policy: 'auto_random' } }));
    const saved = await kesoku.setModeDefaults('story_theater', { casting_policy: 'auto_random' });
    expect(rpc).toHaveBeenLastCalledWith('mode.defaults.set', { mode_id: 'story_theater', prefs: { casting_policy: 'auto_random' } }, {});
    expect(saved).toEqual({ casting_policy: 'auto_random' });
    expect(useStore.getState().modeDefaults.story_theater).toEqual({ casting_policy: 'auto_random' });

    rpc.mockResolvedValueOnce(
      makeEnvelope('character.list.result', {
        characters: [{ name: '林霜', ref: 'lin_shuang', aliases: ['霜儿'], group: '原创', avatar: 'characters/orig/lin.png' }],
      }),
    );
    const chars = await kesoku.listCharacters();
    expect(rpc).toHaveBeenLastCalledWith('character.list', {}, {});
    expect(chars).toHaveLength(1);
    expect(useStore.getState().characters[0]?.ref).toBe('lin_shuang');

    useStore.setState({
      stateFiles: { [S]: { 'game/roster.json': { members: { 角色甲: { name: '角色甲', ref: '', prompt: '旧设定' } } } } },
    });
    const updatedMember = { name: '角色甲', ref: 'lin_shuang', fusion: true, base_appearance: { ref: 'lin_shuang', prompt: '新设定' } };
    rpc.mockResolvedValueOnce(makeEnvelope('roster.update.result', { session_id: S, key: '角色甲', member: updatedMember }));
    await kesoku.updateRoster(S, { key: '角色甲', ref: 'lin_shuang', prompt: '新设定', fusion: true });
    expect(rpc).toHaveBeenLastCalledWith(
      'roster.update',
      { session_id: S, key: '角色甲', ref: 'lin_shuang', prompt: '新设定', fusion: true },
      { session_id: S },
    );
    const roster = useStore.getState().stateFiles[S]['game/roster.json'] as { members: Record<string, unknown> };
    expect(roster.members['角色甲']).toEqual(updatedMember);
  });

  it('refreshAll fetches mode.defaults.get and ignores failures on older engines', async () => {
    const { sock, rpc } = fakeSocket();
    __test.setSocket(sock);
    rpc.mockImplementation(async (type: string) => {
      if (type === 'session.list') return makeEnvelope('session.list.result', { sessions: [] });
      if (type === 'memory.policy.list') return makeEnvelope('memory.policy.list.result', { policies: {}, defaults: {}, updated_at: 1 });
      if (type === 'persona.list') return makeEnvelope('persona.list.result', { roles: [] });
      if (type === 'user_profile.get') return makeEnvelope('user_profile.get.result', { nickname: '', bio: '', cameo_opt_in: false, avatar_rev: 0 });
      if (type === 'memory.proposal.list') return makeEnvelope('memory.proposal.list.result', { proposals: [] });
      if (type === 'mode.defaults.get') throw new Error('UNKNOWN_TYPE');
      return makeEnvelope(`${type}.result`, { ok: true });
    });
    await expect(kesoku.refreshAll()).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith('mode.defaults.get', {}, {});

    rpc.mockImplementation(async (type: string) => {
      if (type === 'session.list') return makeEnvelope('session.list.result', { sessions: [] });
      if (type === 'mode.defaults.get') return makeEnvelope('mode.defaults.get.result', { defaults: { story_theater: { casting_policy: 'manual_only' } } });
      return makeEnvelope(`${type}.result`, { ok: true, roles: [], proposals: [], policies: {}, defaults: {}, updated_at: 1 });
    });
    await kesoku.refreshAll();
    expect(useStore.getState().modeDefaults.story_theater).toEqual({ casting_policy: 'manual_only' });
  });
});

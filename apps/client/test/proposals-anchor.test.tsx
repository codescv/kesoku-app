import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MemoryProposal } from '@kesoku/protocol';
import { actions, initialState, useStore } from '../src/lib/store';
import { watchPendingMode } from '../src/lib/client';
import { MessageList, anchorProposals } from '../src/features/session/MessageList';
import type { ChatItem } from '../src/lib/types';

const S = 'sess0002';
const user: ChatItem = { key: 'u1', kind: 'user', message_id: 'u1', text: '下个月要去大阪出差', ts: 1, status: 'sent' };
const reply: ChatItem = { key: 'a1', kind: 'assistant', message_id: 'a1', turn_id: 'u1', segments: [{ type: 'text', markdown: '好的' }], ts: 2 };
const prop = (message_id: string | null): MemoryProposal => ({
  proposal_id: `p-${message_id}`,
  session_id: S,
  message_id,
  source_mode: 'jp_classroom',
  ops: [{ file: 'user/profile.md', section: '', text: '11 月大阪出差', tags: [] }],
  status: 'pending',
  expires_at: 9,
});

beforeEach(() => useStore.setState(initialState()));
afterEach(() => vi.useRealTimers());

describe('proposal anchoring (live engine uses the triggering user message_id)', () => {
  it('a user message_id anchors under that turn’s assistant reply', () => {
    const { m, tail } = anchorProposals([user, reply], [prop('u1')]);
    expect(m.get('a1')?.map((p) => p.proposal_id)).toEqual(['p-u1']);
    expect(tail).toEqual([]);
  });
  it('falls back to the user row when the reply has not arrived yet', () => {
    const { m } = anchorProposals([user], [prop('u1')]);
    expect(m.get('u1')).toHaveLength(1);
  });
  it('an assistant message_id anchors to itself; unknown / null ids go to the tail', () => {
    const { m, tail } = anchorProposals([user, reply], [prop('a1'), prop('zzz'), prop(null)]);
    expect(m.get('a1')).toHaveLength(1);
    expect(tail.map((p) => p.message_id)).toEqual(['zzz', null]);
  });
  it('prefers turn_id when present', () => {
    const { m } = anchorProposals([user, reply], [{ ...prop(null), turn_id: 'u1' }]);
    expect(m.get('a1')).toHaveLength(1);
  });
  it('MessageList renders a proposal whose message_id is a user message', () => {
    useStore.setState({
      items: { [S]: [user, reply] },
      proposals: { 'p-u1': prop('u1') },
      sessions: { [S]: { session_id: S, title: '', role: 'asuka', chatbot_id: 'app', updated_at: 1 } },
    });
    render(<MessageList sessionId={S} modeId="jp_classroom" />);
    expect(screen.getByText('发现可记录的现实记忆 · 需你确认')).toBeTruthy();
    expect(screen.getByText(/11 月大阪出差/)).toBeTruthy();
  });
  it('renders right after the user bubble before the reply exists', () => {
    useStore.setState({ items: { [S]: [user] }, proposals: { 'p-u1': prop('u1') } });
    const { container } = render(<MessageList sessionId={S} modeId="jp_classroom" />);
    const rows = [...container.querySelectorAll('.k-row-user, .k-proposal')].map((e) => e.className.split(' ')[0]);
    expect(rows).toEqual(['k-row', 'k-proposal']);
  });
});

describe('optimistic mode capsule rollback', () => {
  it('rolls back after 2.5 s when nothing happens', async () => {
    vi.useFakeTimers();
    actions.setUi({ pendingMode: { sessionId: S, modeId: 'galgame', at: Date.now() } });
    watchPendingMode(S, 'galgame');
    await vi.advanceTimersByTimeAsync(2000);
    expect(useStore.getState().ui.pendingMode).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(useStore.getState().ui.pendingMode).toBeNull();
  });
  it('keeps waiting while the launch turn streams, and stops once state.sync confirms', async () => {
    vi.useFakeTimers();
    actions.setUi({ pendingMode: { sessionId: S, modeId: 'galgame', at: Date.now() } });
    watchPendingMode(S, 'galgame');
    actions.applyStreamBatch([{ sid: S, type: 'stream.delta', payload: { turn_id: 't', round_id: 0, offset: 0, delta: '…' } }]);
    await vi.advanceTimersByTimeAsync(8000);
    expect(useStore.getState().ui.pendingMode?.modeId).toBe('galgame');
    actions.applySessionEvent(S, 'state.sync', { files: { 'game/games.json': [{ game: 'galgame', active: true }] }, removed: [], staging_rev: 1 }, 1);
    expect(useStore.getState().ui.pendingMode).toBeNull();
  });
  it('rolls back when the launch turn finalises without a confirming state.sync', async () => {
    vi.useFakeTimers();
    actions.setUi({ pendingMode: { sessionId: S, modeId: 'trpg', at: Date.now() } });
    watchPendingMode(S, 'trpg');
    actions.applyStreamBatch([{ sid: S, type: 'stream.delta', payload: { turn_id: 't', round_id: 0, offset: 0, delta: '…' } }]);
    await vi.advanceTimersByTimeAsync(4000);
    actions.applySessionEvent(S, 'message.final', { message_id: 'a', turn_id: 't', segments: [], raw_markdown: '', ts: Date.now() / 1000 }, 2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(useStore.getState().ui.pendingMode).toBeNull();
  });
});

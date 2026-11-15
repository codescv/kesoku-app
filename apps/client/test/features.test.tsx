import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MODE_IDS, makeEnvelope } from '@kesoku/protocol';
import { initialState, useStore } from '../src/lib/store';
import { __test } from '../src/lib/client';
import type { KesokuSocket } from '../src/lib/ws';
import { MemoryPolicyCard } from '../src/features/settings/SettingsScreen';
import { PolicySegmented } from '../src/features/memory/PolicySegmented';
import { ProposalCard } from '../src/features/proposals/ProposalCard';
import { policySummary, validMemoryPath } from '../src/features/memory/MemoryPanel';
import { Launchpad } from '../src/features/session/Launchpad';
import { Composer } from '../src/features/session/Composer';

function fakeSocket() {
  const rpc = vi.fn(async (type: string, _payload?: unknown, _opts?: unknown) => makeEnvelope(`${type}.result`, { ok: true }));
  const sock = { send: vi.fn(() => 'req'), rpc } as unknown as KesokuSocket;
  __test.setSocket(sock);
  return rpc;
}

beforeEach(() => {
  useStore.setState(initialState());
});

describe('Settings · 各模式记忆策略', () => {
  it('shows factory defaults: chat = 自动, the other 7 = 确认', () => {
    render(<MemoryPolicyCard />);
    const rows = document.querySelectorAll('.k-policy-row');
    expect(rows).toHaveLength(8);
    for (const id of MODE_IDS) {
      const row = document.querySelector(`.k-policy-row[data-mode="${id}"]`)!;
      const on = row.querySelector('[role="radio"][aria-checked="true"]')!;
      expect(on.textContent).toBe(id === 'chat' ? '自动' : '确认');
    }
    expect((screen.getByText('恢复默认') as HTMLButtonElement).disabled).toBe(true);
  });

  it('toggling a mode sends memory.policy.set (optimistic) and enables 恢复默认', async () => {
    const rpc = fakeSocket();
    render(<MemoryPolicyCard />);
    const row = document.querySelector('.k-policy-row[data-mode="galgame"]')!;
    await act(async () => fireEvent.click(row.querySelector('[role="radio"]:nth-child(3)')!));
    expect(rpc).toHaveBeenCalledWith('memory.policy.set', { mode_id: 'galgame', memory_policy: 'isolated' }, {});
    expect(useStore.getState().policies.policies.galgame).toBe('isolated');
    expect((screen.getByText('恢复默认') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => fireEvent.click(screen.getByText('恢复默认')));
    expect(rpc).toHaveBeenLastCalledWith('memory.policy.set', { mode_id: 'galgame', memory_policy: 'confirm_only' }, {});
  });

  it('memory.policy.updated from another device refreshes every entry point', () => {
    render(
      <>
        <MemoryPolicyCard />
        <div data-testid="capsule">
          <PolicySegmented modeId="jp_classroom" />
        </div>
      </>,
    );
    act(() => __test.onEnvelope(makeEnvelope('memory.policy.updated', { policies: { jp_classroom: 'full' }, changed: ['jp_classroom'], updated_at: 2 })));
    const capsule = screen.getByTestId('capsule');
    expect(capsule.querySelector('[aria-checked="true"]')?.textContent).toBe('自动');
  });

  it('policy summary lists deviations', () => {
    const d = Object.fromEntries(MODE_IDS.map((m) => [m, m === 'chat' ? 'full' : 'confirm_only']));
    expect(policySummary(d, d)).toContain('默认：日常聊天[自动]');
    expect(policySummary({ ...d, galgame: 'isolated', jp_classroom: 'full' }, d)).toBe('约会 Galgame[忽略] · 日语小课堂[自动]');
  });
});

describe('ProposalCard (confirm_only)', () => {
  const proposal = {
    proposal_id: 'p1',
    session_id: 's',
    message_id: 'm',
    source_mode: 'jp_classroom',
    ops: [{ file: 'user/profile.md', section: '近况', text: '11 月大阪出差，想练商务敬语', tags: ['session'] }],
    status: 'pending' as const,
    expires_at: 9,
  };

  it('renders title, target file and both actions', () => {
    render(<ProposalCard proposal={proposal} />);
    expect(screen.getByText('发现可记录的现实记忆 · 需你确认')).toBeTruthy();
    expect(screen.getByText('user/profile.md')).toBeTruthy();
    expect(screen.getByRole('button', { name: '忽略' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '记录到记忆库' })).toBeTruthy();
  });

  it('confirm without edits sends no edited_ops; with edits sends them', async () => {
    const rpc = fakeSocket();
    useStore.setState({ proposals: { p1: proposal } });
    const { unmount } = render(<ProposalCard proposal={proposal} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '记录到记忆库' })));
    expect(rpc).toHaveBeenLastCalledWith('memory.proposal.resolve', { proposal_id: 'p1', action: 'confirm' }, {});
    unmount();
    render(<ProposalCard proposal={proposal} />);
    fireEvent.click(screen.getByTitle('轻点编辑'));
    fireEvent.change(screen.getByDisplayValue('11 月大阪出差，想练商务敬语'), { target: { value: '12 月大阪出差' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '记录到记忆库' })));
    expect(rpc.mock.calls.at(-1)?.[1]).toMatchObject({ action: 'confirm', edited_ops: [{ file: 'user/profile.md', text: '12 月大阪出差' }] });
  });

  it('dismiss sends dismiss', async () => {
    const rpc = fakeSocket();
    render(<ProposalCard proposal={proposal} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '忽略' })));
    expect(rpc).toHaveBeenLastCalledWith('memory.proposal.resolve', { proposal_id: 'p1', action: 'dismiss' }, {});
  });

  it('resolved proposals show final state', () => {
    render(<ProposalCard proposal={{ ...proposal, status: 'applied', applied_files: ['user/profile.md'] }} />);
    expect(screen.getByText(/已记录 · user\/profile.md/)).toBeTruthy();
  });

  it('memory paths are whitelisted', () => {
    expect(validMemoryPath('topics/japanese_study.md')).toBe(true);
    expect(validMemoryPath('../etc/passwd.md')).toBe(false);
    expect(validMemoryPath('/abs.md')).toBe(false);
    expect(validMemoryPath('notes.txt')).toBe(false);
  });
});

describe('Launchpad & Composer', () => {
  it('renders exactly 8 mode tiles with policy badges', () => {
    render(<Launchpad />);
    const tiles = document.querySelectorAll('.k-mode-tile');
    expect(tiles).toHaveLength(8);
    expect(screen.getByLabelText('宝可梦助手').textContent).toContain('朱紫 / Z-A');
    expect(screen.getByLabelText('日常聊天').textContent).toContain('自动');
    expect(screen.getByLabelText('约会 Galgame').textContent).toContain('确认');
    expect(document.querySelector('[role="tablist"].k-bottom-tabs, nav.k-tabbar')).toBeNull();
  });

  it.each(['travel_companion', 'translator', 'pokemon_assistant'])('%s keeps a persistent text box + 📷 + 🎙️', (mode) => {
    render(<Composer sessionId="s" modeId={mode} roleName="飞鸟" />);
    expect(screen.getByLabelText('消息输入框')).toBeTruthy();
    expect(screen.getByLabelText('拍照或选图')).toBeTruthy();
    expect(screen.getByLabelText('开始语音输入')).toBeTruthy();
  });

  it('send is disabled while offline', () => {
    render(<Composer sessionId="s" modeId="chat" roleName="飞鸟" />);
    fireEvent.change(screen.getByLabelText('消息输入框'), { target: { value: 'hi' } });
    expect((screen.getByLabelText('发送') as HTMLButtonElement).disabled).toBe(true);
    act(() => useStore.setState((s) => ({ conn: { ...s.conn, status: 'online' } })));
    expect((screen.getByLabelText('发送') as HTMLButtonElement).disabled).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { makeEnvelope } from '@kesoku/protocol';
import { modeMeta } from '@kesoku/ui';
import { initialState, actions, useStore } from '../src/lib/store';
import { __test, kesoku } from '../src/lib/client';
import type { KesokuSocket } from '../src/lib/ws';
import { Shell } from '../src/app/Shell';
import { TopBar } from '../src/app/TopBar';
import { Launchpad } from '../src/features/session/Launchpad';
import { SessionPanel } from '../src/features/session/SessionPanel';

const CLASSROOM = modeMeta('jp_classroom').title;
const CHAT = modeMeta('chat').title;
const now = () => Date.now() / 1000;

const PERSONAS = [
  { role_id: 'asuka', display_name: '飞鸟', tagline: '日语老师', builtin: true, avatar_rev: 0 },
  { role_id: 'coder', display_name: 'Coder', tagline: '编码代理', builtin: true, avatar_rev: 0 },
  { role_id: 'default', display_name: 'Kesoku Agent', tagline: '', builtin: true, avatar_rev: 0 },
];

const GAMES = { instances: [{ id: 'g1', game: 'jp_classroom', title: '标日初级 第3课', active: true }] };

function snapshot(sid: string, extra: { role?: string; mode_id?: string; state_files?: Record<string, unknown> } = {}) {
  return {
    session: { session_id: sid, title: '会话', role: extra.role ?? 'asuka', mode_id: extra.mode_id ?? 'chat', chatbot_id: 'app', updated_at: now() },
    last_messages: [],
    head_seq: 3,
    state_files: extra.state_files ?? {},
    mode_prefs: {},
    llm_override: null,
  };
}

/** Fake socket: `session.open` returns a classroom snapshot (with games.json); `session.create` echoes role/mode. */
function fakeSocket() {
  const rpc = vi.fn(async (type: string, payload?: Record<string, unknown>) => {
    if (type === 'session.open') return makeEnvelope('session.snapshot', snapshot(String(payload?.session_id), { mode_id: 'jp_classroom', state_files: { 'game/games.json': GAMES } }) as never);
    if (type === 'session.create')
      return makeEnvelope('session.snapshot', snapshot('new1', { role: String(payload?.role), mode_id: String(payload?.mode ?? 'chat') }) as never);
    return makeEnvelope(`${type}.result`, { ok: true } as Record<string, unknown>);
  });
  __test.setSocket({ send: vi.fn(() => 'req'), rpc } as unknown as KesokuSocket);
  return rpc;
}

function callsOf(rpc: ReturnType<typeof fakeSocket>, type: string) {
  return rpc.mock.calls.filter((c) => c[0] === type).map((c) => c[1] as Record<string, unknown>);
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  useStore.setState(initialState());
  useStore.setState({ personas: PERSONAS as never });
  __test.tracked.clear();
});
afterEach(() => {
  cleanup();
  __test.setSocket(null);
  vi.restoreAllMocks();
});

describe('v0.1.14 · classroom session restored from IndexedDB', () => {
  function seedRestoredClassroom() {
    useStore.setState({
      sessions: { c1: { session_id: 'c1', title: '日语课', role: 'asuka', mode_id: 'jp_classroom', chatbot_id: 'app', updated_at: now() } as never },
      items: { c1: [{ key: 'm1', kind: 'assistant', text: 'こんにちは', ts: now() - 10 } as never] },
      lastSeq: { c1: 3 },
      currentSessionId: 'c1',
    });
    useStore.setState((s) => ({ ui: { ...s.ui, launchpad: false } }));
  }

  it('TopBar shows the session mode (never 日常聊天) while stateFiles are still empty', () => {
    seedRestoredClassroom();
    render(<Shell />);
    const capsule = screen.getByRole('button', { name: '角色与模式' });
    expect(capsule.textContent).toContain('飞鸟');
    expect(capsule.textContent).toContain(CLASSROOM);
    expect(capsule.textContent).not.toContain(CHAT);
    expect(document.querySelector('.k-shell')!.getAttribute('data-mode')).toBe('jp_classroom');
  });

  it('openSession still calls session.open when games.json is missing even if items + tracked are populated', async () => {
    seedRestoredClassroom();
    __test.tracked.add('c1');
    const rpc = fakeSocket();
    await act(async () => {
      await kesoku.openSession('c1');
    });
    expect(callsOf(rpc, 'session.open')).toEqual([{ session_id: 'c1' }]);
    expect(useStore.getState().stateFiles.c1?.['game/games.json']).toEqual(GAMES);
    // Now hydrated (messages + games.json): a second open is served from the cache.
    useStore.setState((s) => ({ items: { ...s.items, c1: [{ key: 'm1', kind: 'assistant', text: 'こんにちは', ts: now() - 10 } as never] } }));
    await act(async () => {
      await kesoku.openSession('c1');
    });
    expect(callsOf(rpc, 'session.open')).toHaveLength(1);
  });

  it('chat sessions with hydrated (empty) state files keep the cached fast path', async () => {
    useStore.setState({
      sessions: { s1: { session_id: 's1', title: '聊天', role: 'asuka', mode_id: 'chat', chatbot_id: 'app', updated_at: now() } as never },
      items: { s1: [{ key: 'm1', kind: 'assistant', text: 'hi', ts: now() } as never] },
      stateFiles: { s1: {} },
    });
    __test.tracked.add('s1');
    const rpc = fakeSocket();
    await act(async () => {
      await kesoku.openSession('s1');
    });
    expect(callsOf(rpc, 'session.open')).toHaveLength(0);
  });

  it('state.sync of game/games.json keeps sessions[sid].mode_id in sync (sidebar pill + TopBar)', () => {
    seedRestoredClassroom();
    act(() => actions.applySessionEvent('c1', 'state.sync', { files: { 'game/games.json': GAMES }, removed: [] }, 4));
    expect(useStore.getState().sessions.c1!.mode_id).toBe('jp_classroom');
    act(() => actions.applySessionEvent('c1', 'state.sync', { files: { 'game/games.json': { instances: [{ ...GAMES.instances[0], active: false }] } }, removed: [] }, 5));
    expect(useStore.getState().sessions.c1!.mode_id).toBe('chat');
    render(<Shell />);
    expect(screen.getByRole('button', { name: '角色与模式' }).textContent).toContain(CHAT);
  });
});

describe('v0.1.14 · role selection on New Session', () => {
  function seedNewSession() {
    useStore.setState({
      sessions: { s1: { session_id: 's1', title: '旧会话', role: 'asuka', mode_id: 'chat', chatbot_id: 'app', updated_at: now() } as never },
      currentSessionId: null,
    });
    useStore.setState((s) => ({ ui: { ...s.ui, launchpad: true, screen: 'chat' } }));
  }

  it('TopBar role buttons are enabled with no session; picking one updates draftRole, capsule and Composer placeholder', () => {
    seedNewSession();
    fakeSocket();
    render(<Shell />);
    const capsule = screen.getByRole('button', { name: '角色与模式' });
    expect(capsule.textContent).toContain('飞鸟');
    fireEvent.click(capsule);
    const btn = screen.getByTestId('topbar-role-coder') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    for (const b of document.querySelectorAll<HTMLButtonElement>('.k-rm-role')) expect(b.disabled).toBe(false);
    fireEvent.click(btn);
    expect(useStore.getState().ui.draftRole).toBe('coder');
    expect(screen.getByRole('button', { name: '角色与模式' }).textContent).toContain('Coder');
    const ta = document.querySelector<HTMLTextAreaElement>('.k-composer textarea, textarea')!;
    expect(ta.placeholder).toContain('Coder');
  });

  it('Launchpad renders a role picker; picking coder then a mode tile creates the session as coder', async () => {
    seedNewSession();
    const rpc = fakeSocket();
    render(<Launchpad />);
    const picker = screen.getByTestId('launchpad-role-picker');
    expect(within(picker).getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByTestId('launchpad-role-asuka').className).toContain('is-on');
    fireEvent.click(screen.getByTestId('launchpad-role-coder'));
    expect(useStore.getState().ui.draftRole).toBe('coder');
    expect(screen.getByTestId('launchpad-role-coder').className).toContain('is-on');
    fireEvent.click(screen.getByRole('button', { name: CLASSROOM }));
    await flush();
    expect(callsOf(rpc, 'session.create')[0]).toMatchObject({ role: 'coder', mode: 'jp_classroom' });
    expect(useStore.getState().currentSessionId).toBe('new1');
    expect(useStore.getState().sessions.new1!.role).toBe('coder');
  });

  it('chat tile and the long-press info sheet also use the picked role', async () => {
    seedNewSession();
    const rpc = fakeSocket();
    render(<Launchpad />);
    fireEvent.click(screen.getByTestId('launchpad-role-default'));
    fireEvent.contextMenu(screen.getByRole('button', { name: CHAT }));
    const confirm = screen.getByRole('button', { name: `使用「Kesoku Agent」进入${CHAT}` });
    fireEvent.click(confirm);
    await flush();
    expect(callsOf(rpc, 'session.create')[0]).toMatchObject({ role: 'default', mode: 'chat' });
  });

  it('direct typing (ensureSession) creates the session with the picked role', async () => {
    seedNewSession();
    const rpc = fakeSocket();
    act(() => actions.setUi({ draftRole: 'coder' }));
    await act(async () => {
      await kesoku.ensureSession();
    });
    expect(callsOf(rpc, 'session.create')[0]).toMatchObject({ role: 'coder', mode: 'chat' });
  });

  it('+ 新会话 carries the role filter / current session role into draftRole', () => {
    useStore.setState({
      sessions: { s1: { session_id: 's1', title: 'Coder 会话', role: 'coder', mode_id: 'chat', chatbot_id: 'app', updated_at: now() } as never },
      currentSessionId: 's1',
    });
    fakeSocket();
    render(<SessionPanel />);
    fireEvent.click(screen.getByTestId('new-session'));
    expect(useStore.getState().currentSessionId).toBeNull();
    expect(useStore.getState().ui.draftRole).toBe('coder');
    // Role filter chip inside the 全部会话 sub-view also picks the draft role when on New Session.
    fireEvent.click(screen.getByTestId('all-sessions-btn'));
    fireEvent.click(screen.getByRole('tab', { name: 'Kesoku Agent' }));
    expect(useStore.getState().ui.draftRole).toBe('default');
  });

  it('clicking a mode on New Session (or empty session) does not auto-send a message or start a rollback timer', async () => {
    seedNewSession();
    const rpc = fakeSocket();
    render(<Launchpad />);
    fireEvent.click(screen.getByRole('button', { name: CLASSROOM }));
    await flush();
    expect(callsOf(rpc, 'session.create')).toHaveLength(1);
    expect(callsOf(rpc, 'message.send')).toHaveLength(0);
    expect(callsOf(rpc, 'mode.start')).toHaveLength(0);
    expect(useStore.getState().ui.pendingMode).toBeNull();
    expect(useStore.getState().previews.new1).toBeUndefined();
    expect(useStore.getState().sessions.new1?.mode_id).toBe('jp_classroom');

    // Switching mode again while the session still has 0 messages calls mode.start with defer: true and no typing preview.
    await act(async () => {
      await kesoku.startMode('trpg');
    });
    expect(callsOf(rpc, 'mode.start')).toEqual([{ session_id: 'new1', mode_id: 'trpg', defer: true }]);
    expect(useStore.getState().sessions.new1?.mode_id).toBe('trpg');
    expect(useStore.getState().previews.new1).toBeUndefined();
  });

  it('opening an existing session drops the draft role (its own role wins)', async () => {
    seedNewSession();
    fakeSocket();
    act(() => actions.setUi({ draftRole: 'coder' }));
    await act(async () => {
      await kesoku.openSession('s1');
    });
    expect(useStore.getState().ui.draftRole).toBeNull();
    render(<TopBar sessionId="s1" modeId="chat" onMenu={() => {}} showMenu={false} />);
    expect(screen.getByRole('button', { name: '角色与模式' }).textContent).toContain('飞鸟');
  });
});

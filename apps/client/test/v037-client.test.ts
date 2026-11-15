import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientToEngine, makeEnvelope } from '@kesoku/protocol';
import { initialState, useStore } from '../src/lib/store';
import { __test, kesoku } from '../src/lib/client';
import type { KesokuSocket } from '../src/lib/ws';

function fakeSocket(results: Record<string, unknown> = {}) {
  const rpc = vi.fn(async (type: string, _payload?: Record<string, unknown>) =>
    makeEnvelope(`${type}.result`, (results[type] ?? { ok: true }) as Record<string, unknown>),
  );
  __test.setSocket({ send: vi.fn(() => 'req'), rpc } as unknown as KesokuSocket);
  return rpc;
}

beforeEach(() => {
  vi.useFakeTimers();
  useStore.setState(initialState(), true);
});
afterEach(() => {
  __test.setSocket(null);
  vi.useRealTimers();
});

describe('translator native / foreign languages on mode start (v0.3.7 Item 4)', () => {
  it('protocol accepts optional prefs on mode.start and session.create', () => {
    const prefs = { native_lang: 'zh-CN', foreign_langs: ['ja'] };
    expect(ClientToEngine['mode.start'].parse({ session_id: 's1', mode_id: 'translator', prefs }).prefs).toEqual(prefs);
    expect(ClientToEngine['session.create'].parse({ mode: 'translator', prefs }).prefs).toEqual(prefs);
    expect(ClientToEngine['mode.start'].parse({ session_id: 's1', mode_id: 'chat' }).prefs).toBeUndefined();
  });

  it('startMode(translator) stores 母语/常用外语 prefs before mode.start and passes them along', async () => {
    const rpc = fakeSocket();
    useStore.setState((s) => ({
      currentSessionId: 's1',
      settings: { ...s.settings, translatorNativeLang: 'zh-TW', translatorForeignLangs: ['en', 'fr'] },
    }));
    await kesoku.startMode('translator');
    const types = rpc.mock.calls.map((c) => c[0]);
    expect(types.indexOf('mode.prefs.set')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('mode.prefs.set')).toBeLessThan(types.indexOf('mode.start'));
    const expected = { native_lang: 'zh-TW', foreign_langs: ['en', 'fr'], src_lang: 'en', dst_lang: 'zh-TW' };
    expect(rpc.mock.calls.find((c) => c[0] === 'mode.prefs.set')![1]).toEqual({ session_id: 's1', prefs: expected });
    expect(rpc.mock.calls.find((c) => c[0] === 'mode.start')![1]).toEqual({ session_id: 's1', mode_id: 'translator', prefs: expected });
    expect(useStore.getState().modePrefs.s1).toMatchObject(expected);
  });

  it('startMode for other modes sends no prefs', async () => {
    const rpc = fakeSocket();
    useStore.setState({ currentSessionId: 's1' });
    await kesoku.startMode('trpg');
    expect(rpc.mock.calls.some((c) => c[0] === 'mode.prefs.set')).toBe(false);
    expect(rpc.mock.calls.find((c) => c[0] === 'mode.start')![1]).toEqual({ session_id: 's1', mode_id: 'trpg' });
  });

  it('createSession({mode: translator}) sends prefs with session.create and persists them as mode prefs', async () => {
    const rpc = fakeSocket({
      'session.create': {
        session: { session_id: 's9', title: 'T', role: 'default', chatbot_id: 'app', updated_at: 1 },
        last_messages: [],
        state_files: {},
        head_seq: 0,
      },
    });
    const sid = await kesoku.createSession({ mode: 'translator' });
    expect(sid).toBe('s9');
    const expected = { native_lang: 'zh-CN', foreign_langs: ['ja', 'en', 'ko'], src_lang: 'ja', dst_lang: 'zh-CN' };
    expect(rpc.mock.calls[0][0]).toBe('session.create');
    expect(rpc.mock.calls[0][1]).toEqual({ mode: 'translator', role: 'default', prefs: expected });
    await vi.waitFor(() => expect(rpc.mock.calls.some((c) => c[0] === 'mode.prefs.set')).toBe(true));
    expect(useStore.getState().modePrefs.s9).toMatchObject(expected);
  });
});

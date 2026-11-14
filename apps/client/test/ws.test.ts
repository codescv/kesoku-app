import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeEnvelope } from '@kesoku/protocol';
import { KesokuSocket, RpcError } from '../src/lib/ws';

class FakeWS {
  static last: FakeWS | null = null;
  static all: FakeWS[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.last = this;
    FakeWS.all.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  recv(env: object) {
    this.onmessage?.({ data: JSON.stringify(env) });
  }
}

afterEach(() => {
  FakeWS.all = [];
  vi.useRealTimers();
});

async function connect(token: string | null = 'kdt1.x.y') {
  const statuses: string[] = [];
  const envs: string[] = [];
  const s = new KesokuSocket({
    url: 'ws://127.0.0.1:1/ws',
    getToken: async () => token,
    client: { platform: 'web', version: '0.1.0', locale: 'zh-CN' },
    onEnvelope: (e) => envs.push(e.type),
    onStatus: (st) => statuses.push(st),
    WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    rpcTimeoutMs: 1000,
  });
  s.start();
  await Promise.resolve();
  await Promise.resolve();
  const ws = FakeWS.last!;
  ws.open();
  return { s, ws, statuses, envs };
}

describe('KesokuSocket', () => {
  it('sends auth.hello as the first frame (token only when present)', async () => {
    const { ws } = await connect();
    const hello = JSON.parse(ws.sent[0]);
    expect(hello.type).toBe('auth.hello');
    expect(hello.payload.device_token).toBe('kdt1.x.y');
    expect(hello.payload.client.platform).toBe('web');
    const { ws: ws2 } = await connect(null);
    expect(JSON.parse(ws2.sent[0]).payload.device_token).toBeUndefined();
  });

  it('queues frames until auth.ok then flushes', async () => {
    const { s, ws, statuses } = await connect();
    s.send('session.list', {});
    expect(ws.sent).toHaveLength(1);
    ws.recv(makeEnvelope('auth.ok', { device_id: 'dev_abcdefghij', engine_online: true, server_ts: 1 }));
    expect(statuses).toContain('online');
    expect(ws.sent.map((f) => JSON.parse(f).type).filter((t) => t !== 'ping')).toEqual(['auth.hello', 'session.list']);
    expect(s.deviceId).toBe('dev_abcdefghij');
  });

  it('pairs rpc replies by reply_to and rejects on error', async () => {
    const { s, ws } = await connect();
    ws.recv(makeEnvelope('auth.ok', { device_id: 'dev_abcdefghij', engine_online: true, server_ts: 1 }));
    const p = s.rpc('session.open', { session_id: 'a' });
    const req = JSON.parse(ws.sent.at(-1)!);
    ws.recv(makeEnvelope('session.snapshot', { ok: 1 }, { reply_to: req.id }));
    await expect(p).resolves.toMatchObject({ type: 'session.snapshot' });
    const p2 = s.rpc('persona.delete', { role_id: 'asuka' });
    const req2 = JSON.parse(ws.sent.at(-1)!);
    ws.recv(makeEnvelope('error', { code: 'PERSONA_BUILTIN', message: 'builtin' }, { reply_to: req2.id }));
    await expect(p2).rejects.toBeInstanceOf(RpcError);
  });

  it('4401 close → unauthorized (no reconnect loop)', async () => {
    const { ws, statuses } = await connect();
    ws.close(4401);
    expect(statuses.at(-1)).toBe('unauthorized');
  });

  it('abnormal close schedules a reconnect with backoff', async () => {
    vi.useFakeTimers();
    const { ws, statuses } = await connect();
    const before = FakeWS.all.length;
    ws.close(1006);
    expect(statuses.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1500);
    expect(FakeWS.all.length).toBe(before + 1);
  });

  it('relay.rotate opens a new leg while the old one drains', async () => {
    const { ws } = await connect();
    ws.recv(makeEnvelope('auth.ok', { device_id: 'dev_abcdefghij', engine_online: true, server_ts: 1 }));
    const n = FakeWS.all.length;
    ws.recv(makeEnvelope('relay.rotate', { grace_ms: 3000 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(FakeWS.all.length).toBe(n + 1);
  });
});

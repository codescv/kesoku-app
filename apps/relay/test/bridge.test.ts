import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { WS_CLOSE, makeEnvelope } from '@kesoku/protocol';
import { ENGINE_TOKEN, Peer, makeConfig, openClient, openEngine, sleep, startRelay, type Harness } from './helpers';
import type { RelayLimits } from '../src/config';

let h: Harness | null = null;
afterEach(async () => {
  await h?.stop();
  h = null;
});

async function start(limits: Partial<RelayLimits> = {}) {
  h = await startRelay(makeConfig({}, limits));
  return h;
}

function token(kind: 'pair' | 'google' = 'pair') {
  return h!.relay.auth.issue(kind);
}

function rawClient(path = '/ws', headers: Record<string, string> = {}) {
  return new Peer(new WebSocket(`${h!.wsBase}${path}`, { headers }));
}

const hello = (payload: Record<string, unknown> = {}) =>
  makeEnvelope('auth.hello', { client: { platform: 'web', version: '1', locale: 'en' }, ...payload });

describe('client leg auth', () => {
  it('closes 4401 when no auth.hello arrives in time', async () => {
    await start({ authHelloTimeoutMs: 150 });
    const p = rawClient();
    await p.opened;
    expect((await p.closed).code).toBe(WS_CLOSE.UNAUTHORIZED);
  });

  it('closes 4401 on bad token, wrong first frame, device mismatch, cross-origin cookie', async () => {
    await start();
    const bad = rawClient();
    await bad.opened;
    bad.send(hello({ device_token: 'kdt1.AAAA.BBBB' }));
    expect((await bad.closed).code).toBe(WS_CLOSE.UNAUTHORIZED);

    const wrong = rawClient();
    await wrong.opened;
    wrong.send(makeEnvelope('session.list', {}));
    expect((await wrong.closed).code).toBe(WS_CLOSE.UNAUTHORIZED);

    const t = token();
    const mism = rawClient('/ws?device=dev_someoneelse000');
    await mism.opened;
    mism.send(hello({ device_token: t.token }));
    expect((await mism.closed).code).toBe(WS_CLOSE.UNAUTHORIZED);

    const evil = rawClient('/ws', { Cookie: `__Host-kesoku_session=${t.token}`, Origin: 'https://evil.example' });
    await evil.opened;
    evil.send(hello());
    expect((await evil.closed).code).toBe(WS_CLOSE.UNAUTHORIZED);
  });

  it('auth.ok with device id, engine_online and kind; ?device= matching is accepted; __Secure- cookie works', async () => {
    await start();
    const t = token('google');
    const { peer, ok } = await openClient(h!, { token: t.token, device: t.claims.device_id });
    expect(ok.payload).toMatchObject({ device_id: t.claims.device_id, engine_online: false, kind: 'google', server_ts: expect.any(Number) });
    expect(ok.reply_to).toBeTruthy();
    const { ok: ok2 } = await openClient(h!, { cookie: `other=1; __Secure-kesoku_session=${t.token}` });
    expect(ok2.payload.device_id).toBe(t.claims.device_id);
    peer.close();
  });

  it('per-IP handshake limits: concurrent and per-minute', async () => {
    await start({ handshakeConcurrentPerIp: 2, handshakePerMinutePerIp: 4 });
    const a = rawClient();
    const b = rawClient();
    await Promise.all([a.opened, b.opened]);
    const c = rawClient();
    await expect(c.opened).rejects.toThrow(/429/);
    // Authenticating frees the slot.
    a.send(hello({ device_token: token().token }));
    await a.next('auth.ok');
    const d = rawClient();
    await d.opened;
    // 4 attempts used (a, b, c, d) → the 5th within a minute is refused.
    const e = rawClient();
    await expect(e.opened).rejects.toThrow(/429/);
    for (const p of [a, b, d]) p.close();
  });
});

describe('bridge routing', () => {
  it('forwards client frames with device_id overwritten; answers ping itself; refuses control types', async () => {
    await start();
    const { peer: engine } = await openEngine(h!);
    const t = token();
    const { peer: client } = await openClient(h!, { token: t.token });
    const req = makeEnvelope('session.list', { limit: 10 }, { device_id: 'dev_spoofed000000' });
    client.send(req);
    const got = await engine.next('session.list');
    expect(got.id).toBe(req.id);
    expect(got.device_id).toBe(t.claims.device_id);
    expect(got.payload).toEqual({ limit: 10 });

    const ping = makeEnvelope('ping', {});
    client.send(ping);
    const pong = await client.next('pong');
    expect(pong.reply_to).toBe(ping.id);
    expect(await engine.none('ping')).toBe(true);

    const forged = makeEnvelope('pair.offer', { code_hash: 'x' });
    client.send(forged);
    expect((await client.next('error')).payload).toMatchObject({ code: 'BAD_REQUEST', reply_to: forged.id });
    client.send('not json');
    expect((await client.next('error')).payload.code).toBe('BAD_REQUEST');
    engine.close();
    client.close();
  });

  it('unicasts frames with device_id and broadcasts frames without', async () => {
    await start();
    const { peer: engine } = await openEngine(h!);
    const ta = token();
    const tb = token();
    const { peer: a } = await openClient(h!, { token: ta.token });
    const { peer: b } = await openClient(h!, { token: tb.token });
    engine.send(makeEnvelope('session.list.result', { sessions: [] }, { device_id: ta.claims.device_id, reply_to: 'req_1' }));
    expect((await a.next('session.list.result')).reply_to).toBe('req_1');
    expect(await b.none('session.list.result')).toBe(true);
    engine.send(makeEnvelope('stream.delta', { turn_id: 't', round_id: 0, offset: 0, delta: 'hi' }, { session_id: 's1' }));
    expect((await a.next('stream.delta')).payload.delta).toBe('hi');
    expect((await b.next('stream.delta')).payload.delta).toBe('hi');
    for (const p of [engine, a, b]) p.close();
  });

  it('engine.status is broadcast when the engine goes online/offline; engine ping → pong', async () => {
    await start();
    const { peer: client } = await openClient(h!, { token: token().token });
    const { peer: engine } = await openEngine(h!);
    expect((await client.next('engine.status')).payload).toMatchObject({ online: true });
    const ping = makeEnvelope('ping', {});
    engine.send(ping);
    expect((await engine.next('pong')).reply_to).toBe(ping.id);
    engine.close();
    expect((await client.next('engine.status')).payload).toMatchObject({ online: false });
    client.close();
  });

  it('queues while the engine is offline, overflows with ENGINE_OFFLINE, replays after hello minus last_inbound_id', async () => {
    await start({ inboundQueue: 3 });
    const t = token();
    const { peer: client } = await openClient(h!, { token: t.token });
    const sent = [0, 1, 2, 3].map((i) => makeEnvelope('session.open', { session_id: `s${i}` }));
    for (const e of sent) client.send(e);
    const err = await client.next('error');
    expect(err.payload).toMatchObject({ code: 'ENGINE_OFFLINE', reply_to: sent[3].id });
    expect(err.reply_to).toBe(sent[3].id);
    expect(h!.relay.bridge.queueLength).toBe(3);

    const { peer: engine, welcome } = await openEngine(h!, { boot_id: 5, conn_seq: 1, last_inbound_id: sent[0].id });
    expect(welcome.payload.queued).toBe(2);
    const a = await engine.next('session.open');
    const b = await engine.next('session.open');
    expect([a.id, b.id]).toEqual([sent[1].id, sent[2].id]);
    expect(a.device_id).toBe(t.claims.device_id);
    expect(await engine.none('session.open')).toBe(true);
    engine.close();
    client.close();
  });

  it('greater (boot_id, conn_seq) takes over instantly; old leg drains then closes 4409; older legs are rejected', async () => {
    await start({ engineDrainMs: 250 });
    const t = token();
    const { peer: client } = await openClient(h!, { token: t.token });
    const { peer: e1 } = await openEngine(h!, { boot_id: 1_700_000_000_000, conn_seq: 1 });
    await client.next('engine.status');
    const { peer: e2, welcome } = await openEngine(h!, { boot_id: 1_700_000_000_000, conn_seq: 2 });
    expect(welcome.payload.primary).toBe(true);
    // Routing switched immediately.
    client.send(makeEnvelope('session.list', {}));
    await e2.next('session.list');
    expect(await e1.none('session.list', 100)).toBe(true);
    // Old leg can still flush in-flight frames during the drain.
    e1.send(makeEnvelope('stream.delta', { turn_id: 't', round_id: 0, offset: 0, delta: 'late' }, { session_id: 's1' }));
    expect((await client.next('stream.delta')).payload.delta).toBe('late');
    expect((await e1.closed).code).toBe(WS_CLOSE.SUPERSEDED);
    // No offline flap during takeover.
    expect(await client.none((m) => m.type === 'engine.status' && m.payload.online === false, 100)).toBe(true);
    // A restarted process (greater boot_id) also wins; a stale one is refused.
    const stale = new Peer(new WebSocket(`${h!.wsBase}/engine`, { headers: { Authorization: `Bearer ${ENGINE_TOKEN}` } }));
    await stale.opened;
    stale.send(makeEnvelope('engine.hello', { boot_id: 1_699_999_999_999, conn_seq: 99, revoked_device_ids: [] }));
    expect((await stale.closed).code).toBe(WS_CLOSE.SUPERSEDED);
    const { peer: e3 } = await openEngine(h!, { boot_id: 1_700_000_000_500, conn_seq: 1 });
    client.send(makeEnvelope('session.list', {}));
    await e3.next('session.list');
    expect((await e2.closed).code).toBe(WS_CLOSE.SUPERSEDED);
    e3.close();
    client.close();
  });

  it('rejects engine legs with a bad token (401) or without engine.hello (4401)', async () => {
    await start();
    const bad = new Peer(new WebSocket(`${h!.wsBase}/engine`, { headers: { Authorization: 'Bearer nope' } }));
    await expect(bad.opened).rejects.toThrow(/401/);
    const none = new Peer(new WebSocket(`${h!.wsBase}/engine`));
    await expect(none.opened).rejects.toThrow(/401/);
    const nohello = new Peer(new WebSocket(`${h!.wsBase}/engine`, { headers: { Authorization: `Bearer ${ENGINE_TOKEN}` } }));
    await nohello.opened;
    nohello.send(makeEnvelope('ping', {}));
    expect((await nohello.closed).code).toBe(WS_CLOSE.UNAUTHORIZED);
  });

  it('device.revoked closes those legs with 4410 and their tokens stop working; hello revoked list too', async () => {
    await start();
    const { peer: engine } = await openEngine(h!);
    const ta = token();
    const tb = token();
    const { peer: a } = await openClient(h!, { token: ta.token });
    const { peer: b } = await openClient(h!, { token: tb.token });
    engine.send(makeEnvelope('device.revoked', { device_ids: [ta.claims.device_id] }));
    expect((await a.closed).code).toBe(WS_CLOSE.REVOKED);
    expect(await b.none(() => true, 100)).toBe(true);
    const again = rawClient();
    await again.opened;
    again.send(hello({ device_token: ta.token }));
    expect((await again.closed).code).toBe(WS_CLOSE.REVOKED);
    // Full list on (re)connect.
    const { peer: e2 } = await openEngine(h!, { boot_id: 1_800_000_000_000, conn_seq: 1, revoked_device_ids: [tb.claims.device_id] });
    expect((await b.closed).code).toBe(WS_CLOSE.REVOKED);
    e2.close();
    engine.close();
  });

  it('sends relay.rotate{grace_ms:3000} on both legs after the rotation timer', async () => {
    await start({ rotateAfterMs: 150, rotateForceCloseMs: 5000 });
    const { peer: engine } = await openEngine(h!);
    const { peer: client } = await openClient(h!, { token: token().token });
    expect((await engine.next('relay.rotate')).payload).toEqual({ grace_ms: 3000 });
    expect((await client.next('relay.rotate')).payload).toEqual({ grace_ms: 3000 });
    engine.close();
    client.close();
  });

  it('force-closes a leg that ignores relay.rotate', async () => {
    await start({ rotateAfterMs: 50, rotateForceCloseMs: 100 });
    const { peer: client } = await openClient(h!, { token: token().token });
    await client.next('relay.rotate');
    expect((await client.closed).code).toBe(WS_CLOSE.ROTATE);
  });

  it('shutdown sends relay.restarting{retry_ms} on both legs then closes', async () => {
    await start();
    const { peer: engine } = await openEngine(h!);
    const { peer: client } = await openClient(h!, { token: token().token });
    const done = h!.relay.shutdown();
    expect((await engine.next('relay.restarting')).payload).toEqual({ retry_ms: 3000 });
    expect((await client.next('relay.restarting')).payload).toEqual({ retry_ms: 3000 });
    await done;
    expect((await client.closed).code).toBe(1012);
    expect((await engine.closed).code).toBe(1012);
  });
});

describe('ring buffer + sync.resume', () => {
  const seqd = (sid: string, seq: number) =>
    makeEnvelope('message.final', { message_id: `m${seq}`, turn_id: 't', segments: [], raw_markdown: '', ts: seq }, { session_id: sid, seq });

  it('ring hit → replays from the ring (unicast) then forwards sync.replay with after_seq = last replayed', async () => {
    await start();
    const { peer: engine } = await openEngine(h!);
    const ta = token();
    const tb = token();
    const { peer: a } = await openClient(h!, { token: ta.token });
    const { peer: b } = await openClient(h!, { token: tb.token });
    for (let s = 1; s <= 5; s++) engine.send(seqd('3f9a1c2b', s));
    for (let s = 1; s <= 5; s++) await b.next((m) => m.seq === s);
    // Unicast replies are not ringed.
    engine.send(makeEnvelope('message.final', { message_id: 'x' }, { session_id: '3f9a1c2b', seq: 6, device_id: ta.claims.device_id }));
    await a.next((m) => m.seq === 6);
    a.msgs.length = 0;

    const resume = makeEnvelope('sync.resume', { sessions: [{ session_id: '3f9a1c2b', last_seq: 2 }] });
    a.send(resume);
    const replayed = [await a.next('message.final'), await a.next('message.final'), await a.next('message.final')];
    expect(replayed.map((m) => m.seq)).toEqual([3, 4, 5]);
    const fwd = await engine.next('sync.replay');
    expect(fwd.payload).toEqual({ session_id: '3f9a1c2b', after_seq: 5, limit: 500 });
    expect(fwd.device_id).toBe(ta.claims.device_id);
    expect(await b.none('message.final', 100)).toBe(true);
    expect(await engine.none('sync.resume', 50)).toBe(true);
    for (const p of [engine, a, b]) p.close();
  });

  it('ring miss → forwards sync.replay{after_seq:last_seq}', async () => {
    await start({ ringPerSession: 3 });
    const { peer: engine } = await openEngine(h!);
    const t = token();
    const { peer: c } = await openClient(h!, { token: t.token });
    for (let s = 10; s <= 15; s++) engine.send(seqd('aaaa0001', s));
    await c.next((m) => m.seq === 15);
    c.msgs.length = 0;
    c.send(makeEnvelope('sync.resume', { sessions: [{ session_id: 'aaaa0001', last_seq: 4 }, { session_id: 'unknown1', last_seq: 7 }] }));
    const f1 = await engine.next('sync.replay');
    const f2 = await engine.next('sync.replay');
    expect(f1.payload).toEqual({ session_id: 'aaaa0001', after_seq: 4, limit: 500 });
    expect(f2.payload).toEqual({ session_id: 'unknown1', after_seq: 7, limit: 500 });
    expect(await c.none('message.final', 100)).toBe(true);
    engine.close();
    c.close();
  });

  it('engine offline → relay replays the ring and answers sync.done{has_more:false} itself', async () => {
    await start();
    const { peer: engine } = await openEngine(h!);
    const t = token();
    const { peer: c } = await openClient(h!, { token: t.token });
    for (let s = 1; s <= 4; s++) engine.send(seqd('bbbb0002', s));
    await c.next((m) => m.seq === 4);
    engine.close();
    await c.next((m) => m.type === 'engine.status' && m.payload.online === false);
    c.msgs.length = 0;
    const resume = makeEnvelope('sync.resume', { sessions: [{ session_id: 'bbbb0002', last_seq: 1 }, { session_id: 'cccc0003', last_seq: 9 }] });
    c.send(resume);
    expect((await c.next('message.final')).seq).toBe(2);
    expect((await c.next('message.final')).seq).toBe(3);
    expect((await c.next('message.final')).seq).toBe(4);
    const d1 = await c.next((m) => m.type === 'sync.done' && m.payload.session_id === 'bbbb0002');
    expect(d1.payload).toMatchObject({ replayed_through_seq: 4, head_seq: 4, has_more: false });
    expect(d1.reply_to).toBe(resume.id);
    const d2 = await c.next((m) => m.type === 'sync.done' && m.payload.session_id === 'cccc0003');
    expect(d2.payload).toMatchObject({ replayed_through_seq: 9, head_seq: 9, has_more: false });
    expect(h!.relay.bridge.queueLength).toBe(0);
    c.close();
  });

  it('invalid sync.resume → BAD_REQUEST', async () => {
    await start();
    const { peer: c } = await openClient(h!, { token: token().token });
    const bad = makeEnvelope('sync.resume', { sessions: 'nope' });
    c.send(bad);
    expect((await c.next('error')).payload).toMatchObject({ code: 'BAD_REQUEST', reply_to: bad.id });
    c.close();
  });
});

describe('heartbeat', () => {
  it('keeps responsive legs alive across heartbeat intervals', async () => {
    await start({ heartbeatMs: 50 });
    const { peer: c } = await openClient(h!, { token: token().token });
    await sleep(200);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.close();
  });
});

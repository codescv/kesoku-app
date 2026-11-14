import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeEnvelope } from '@kesoku/protocol';
import { GcsMedia, OBJECT_RE, objectName } from '../src/media';
import { makeConfig, openClient, openEngine, startRelay, type Harness } from './helpers';
import type { RelayLimits } from '../src/config';

let h: Harness | null = null;
afterEach(async () => {
  await h?.stop();
  h = null;
});

async function start(limits: Partial<RelayLimits> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kesoku-media-'));
  h = await startRelay(makeConfig({ localMediaDir: dir, localMode: true }, limits));
  return { h, dir };
}

describe('local media mode', () => {
  it('client media.ticket → signed PUT → media.refresh → signed GET roundtrip', async () => {
    await start();
    const t = h!.relay.auth.issue('pair');
    const { peer: c } = await openClient(h!, { token: t.token });
    const req = makeEnvelope('media.ticket', { session_id: '3f9a1c2b', purpose: 'message', mime: 'image/png', bytes: 5, filename: 'a.png' });
    c.send(req);
    const ok = await c.next('media.ticket.ok');
    expect(ok.reply_to).toBe(req.id);
    expect(ok.payload.object).toMatch(/^media\/3f9a1c2b\/[0-9a-f-]{36}\.png$/);
    expect(ok.payload.max_bytes).toBe(25 * 1024 * 1024);
    expect(ok.payload.put_url.startsWith(`${h!.base}/local-media/${ok.payload.object}?`)).toBe(true);
    const put = await fetch(ok.payload.put_url, { method: 'PUT', headers: ok.payload.headers, body: Buffer.from('hello') });
    expect(put.status).toBe(200);

    const ref = makeEnvelope('media.refresh', { object: ok.payload.object });
    c.send(ref);
    const r = await c.next('media.refresh.ok');
    expect(r.reply_to).toBe(ref.id);
    expect(r.payload.expires_at).toBeGreaterThan(Date.now() / 1000);
    const got = await fetch(r.payload.url);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await got.arrayBuffer()).toString()).toBe('hello');
    c.close();
  });

  it('rejects bad / tampered signatures, oversize uploads and path traversal', async () => {
    const { dir } = await start({ messageMediaMaxBytes: 8 });
    const t = h!.relay.auth.issue('pair');
    const { peer: c } = await openClient(h!, { token: t.token });
    c.send(makeEnvelope('media.ticket', { session_id: 'abcd1234', purpose: 'message', mime: 'audio/ogg', bytes: 8, filename: 'v.ogg' }));
    const ok = await c.next('media.ticket.ok');
    const u = new URL(ok.payload.put_url);
    // Tampered signature.
    const badSig = new URL(u);
    badSig.searchParams.set('sig', '0'.repeat(64));
    expect((await fetch(badSig, { method: 'PUT', body: 'x' })).status).toBe(403);
    // Tampered max (signature no longer matches).
    const badMax = new URL(u);
    badMax.searchParams.set('max', '999999');
    expect((await fetch(badMax, { method: 'PUT', body: 'x' })).status).toBe(403);
    // Expired.
    const expired = new URL(u);
    expired.searchParams.set('exp', '1000');
    expect((await fetch(expired, { method: 'PUT', body: 'x' })).status).toBe(403);
    // A PUT signature is not a GET signature.
    expect((await fetch(u)).status).toBe(403);
    // Oversize body.
    expect((await fetch(u, { method: 'PUT', body: Buffer.alloc(9) })).status).toBe(413);
    // Missing signature.
    expect((await fetch(`${h!.base}/local-media/${ok.payload.object}`)).status).toBe(403);
    // Traversal (encoded and raw) never reaches the filesystem.
    writeFileSync(path.join(path.dirname(dir), 'secret.txt'), 'top secret');
    for (const p of [
      '/local-media/media/..%2f..%2fsecret.txt',
      '/local-media/media%2f..%2f..%2fsecret.txt',
      '/local-media/..%2fsecret.txt',
      '/local-media/media/abcd1234/..%2f..%2f..%2fsecret.txt',
      '/local-media/%2e%2e/secret.txt',
    ]) {
      const r = await fetch(`${h!.base}${p}?exp=9999999999&sig=${'0'.repeat(64)}`);
      expect([400, 403, 404]).toContain(r.status);
      expect(await r.text()).not.toContain('top secret');
    }
    c.close();
  });

  it('enforces media.ticket limits (avatar_source mime + 12 MiB, message size, session id)', async () => {
    await start();
    const { peer: c } = await openClient(h!, { token: h!.relay.auth.issue('pair').token });
    const cases: [Record<string, unknown>, string][] = [
      [{ purpose: 'avatar_source', mime: 'image/gif', bytes: 100, filename: 'a.gif' }, 'AVATAR_SOURCE_INVALID'],
      [{ purpose: 'avatar_source', mime: 'image/png', bytes: 12 * 1024 * 1024 + 1, filename: 'a.png' }, 'AVATAR_SOURCE_INVALID'],
      [{ purpose: 'message', session_id: 'abcd1234', mime: 'video/mp4', bytes: 25 * 1024 * 1024 + 1, filename: 'v.mp4' }, 'BAD_REQUEST'],
      [{ purpose: 'message', mime: 'image/png', bytes: 10, filename: 'a.png' }, 'BAD_REQUEST'],
      [{ purpose: 'message', session_id: '../etc', mime: 'image/png', bytes: 10, filename: 'a.png' }, 'BAD_REQUEST'],
      [{ purpose: 'other', mime: 'image/png', bytes: 10, filename: 'a.png' }, 'BAD_REQUEST'],
    ];
    for (const [payload, code] of cases) {
      const e = makeEnvelope('media.ticket', payload);
      c.send(e);
      const err = await c.next((m) => m.reply_to === e.id);
      expect(err.type).toBe('error');
      expect(err.payload.code).toBe(code);
    }
    const ok = makeEnvelope('media.ticket', { purpose: 'avatar_source', mime: 'image/heic', bytes: 12 * 1024 * 1024, filename: 'me.heic' });
    c.send(ok);
    const res = await c.next((m) => m.reply_to === ok.id);
    expect(res.type).toBe('media.ticket.ok');
    expect(res.payload.object).toMatch(/^media\/avatar\/[0-9a-f-]{36}\.heic$/);
    expect(res.payload.max_bytes).toBe(12 * 1024 * 1024);
    c.close();
  });

  it('engine media: upload.ticket (+get_url), media.sign with issuer, binary media.put, media.ready url fill-in', async () => {
    await start();
    const { peer: engine } = await openEngine(h!);
    const t = h!.relay.auth.issue('pair');
    const { peer: c } = await openClient(h!, { token: t.token });

    // upload ticket for an avatar candidate
    const tk = makeEnvelope('media.upload.ticket', { purpose: 'avatar_candidate', mime: 'image/webp', bytes: 4, index: 2 });
    engine.send(tk);
    const ok = await engine.next((m) => m.reply_to === tk.id);
    expect(ok.type).toBe('media.ticket.ok');
    expect(ok.payload.object).toMatch(/^media\/avatar\/[0-9a-f-]{36}-cand2\.webp$/);
    expect(ok.payload.get_url).toContain('/local-media/');
    expect(ok.payload.get_expires_at).toBeGreaterThan(ok.payload.expires_at - 1);
    expect((await fetch(ok.payload.put_url, { method: 'PUT', body: 'WEBP' })).status).toBe(200);
    expect(await (await fetch(ok.payload.get_url)).text()).toBe('WEBP');

    // asset + message naming
    const tk2 = makeEnvelope('media.upload.ticket', { purpose: 'asset', mime: 'audio/mpeg', bytes: 4 });
    engine.send(tk2);
    expect((await engine.next((m) => m.reply_to === tk2.id)).payload.object).toMatch(/^media\/asset\/[0-9a-f-]{36}\.mp3$/);

    // media.sign of a client-issued object carries the issuer
    const ct = makeEnvelope('media.ticket', { purpose: 'avatar_source', mime: 'image/jpeg', bytes: 3, filename: 'me.jpg' });
    c.send(ct);
    const cok = await c.next('media.ticket.ok');
    const sg = makeEnvelope('media.sign', { object: cok.payload.object });
    engine.send(sg);
    const signed = await engine.next((m) => m.reply_to === sg.id);
    expect(signed.type).toBe('media.signed');
    expect(signed.payload).toMatchObject({ object: cok.payload.object, issued_device_id: t.claims.device_id, issued_at: expect.any(Number) });
    const bad = makeEnvelope('media.sign', { object: '../../etc/passwd' });
    engine.send(bad);
    expect((await engine.next((m) => m.reply_to === bad.id)).payload.code).toBe('BAD_REQUEST');

    // binary media.put
    const header = Buffer.from(JSON.stringify({ v: 1, type: 'media.put', id: 'req_put1', purpose: 'message', session_id: '3f9a1c2b', mime: 'audio/ogg', filename: 'v.ogg' }));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(header.length);
    const data = Buffer.from('OggS-voice-bytes');
    engine.send(Buffer.concat([len, header, data]));
    const put = await engine.next((m) => m.reply_to === 'req_put1');
    expect(put.type).toBe('media.put.ok');
    expect(put.payload).toMatchObject({ mime: 'audio/ogg', bytes: data.length });
    expect(put.payload.object).toMatch(/^media\/3f9a1c2b\/[0-9a-f-]{36}\.ogg$/);
    const fetched = await fetch(put.payload.url);
    expect(fetched.headers.get('content-type')).toBe('audio/ogg');
    expect(Buffer.from(await fetched.arrayBuffer()).equals(data)).toBe(true);
    // malformed binary frame
    engine.send(Buffer.from([0, 0, 0, 200, 1, 2]));
    expect((await engine.next('error')).payload.code).toBe('BAD_REQUEST');

    // media.ready without url → relay signs
    engine.send(makeEnvelope('media.ready', { placeholder_id: 'ph1', kind: 'voice', object: put.payload.object }, { session_id: '3f9a1c2b', seq: 7 }));
    const ready = await c.next('media.ready');
    expect(ready.payload.url).toContain(`/local-media/${put.payload.object}?`);
    expect(ready.payload.expires_at).toBeGreaterThan(Date.now() / 1000);
    engine.close();
    c.close();
  });

  it('media not configured → INTERNAL error reply', async () => {
    h = await startRelay(makeConfig());
    const { peer: c } = await openClient(h!, { token: h!.relay.auth.issue('pair').token });
    const e = makeEnvelope('media.ticket', { purpose: 'message', session_id: 'abcd1234', mime: 'image/png', bytes: 1, filename: 'a.png' });
    c.send(e);
    expect((await c.next('error')).payload).toMatchObject({ code: 'INTERNAL', reply_to: e.id });
    c.close();
  });
});

describe('object naming + GCS signer', () => {
  it('names objects per PROTOCOL.md §3', () => {
    expect(objectName('message', { session_id: '3f9a1c2b', mime: 'image/jpeg' })).toMatch(/^media\/3f9a1c2b\/[0-9a-f-]{36}\.jpg$/);
    expect(objectName('asset', { mime: 'application/x-unknown', filename: 'x.Dat' })).toMatch(/^media\/asset\/[0-9a-f-]{36}\.dat$/);
    expect(objectName('avatar_source', { mime: 'image/webp' })).toMatch(/^media\/avatar\/[0-9a-f-]{36}\.webp$/);
    expect(objectName('avatar_candidate', { mime: 'image/webp', index: 3 })).toMatch(/-cand3\.webp$/);
    expect(() => objectName('avatar_candidate', { mime: 'image/webp', index: 4 })).toThrow();
    expect(OBJECT_RE.test('media/../x.png')).toBe(false);
  });

  it('GCS backend signs V4 PUT (content type + length range) and GET with the right TTLs', async () => {
    const calls: { name: string; cfg: Record<string, unknown> }[] = [];
    const saved: { name: string; size: number; opts: Record<string, unknown> }[] = [];
    const bucket = {
      file: (name: string) => ({
        getSignedUrl: async (cfg: Record<string, unknown>) => {
          calls.push({ name, cfg });
          return [`https://storage.googleapis.com/b/${name}?X-Goog-Signature=abc`] as [string];
        },
        save: async (data: Buffer, opts: Record<string, unknown>) => {
          saved.push({ name, size: data.length, opts });
        },
      }),
    };
    const g = new GcsMedia('b', { putTtlS: 600, getTtlS: 900 }, bucket);
    const now = Date.now();
    const put = await g.signPut('media/abcd1234/x.png', 'image/png', 100);
    expect(calls[0].cfg).toMatchObject({ version: 'v4', action: 'write', contentType: 'image/png', extensionHeaders: { 'x-goog-content-length-range': '0,100' } });
    expect(put.headers).toEqual({ 'Content-Type': 'image/png', 'x-goog-content-length-range': '0,100' });
    expect(Math.abs((calls[0].cfg.expires as number) - (now + 600_000))).toBeLessThan(2000);
    const get = await g.signGet('media/abcd1234/x.png');
    expect(calls[1].cfg).toMatchObject({ version: 'v4', action: 'read' });
    expect(Math.abs((calls[1].cfg.expires as number) - (now + 900_000))).toBeLessThan(2000);
    expect(get.expires_at).toBeGreaterThan(now / 1000 + 890);
    await g.put('media/asset/y.mp3', Buffer.from('abc'), 'audio/mpeg');
    expect(saved[0]).toMatchObject({ name: 'media/asset/y.mp3', size: 3, opts: { contentType: 'audio/mpeg', resumable: false } });
  });
});

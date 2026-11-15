import { describe, expect, it } from 'vitest';
import {
  ClientToEngine,
  DEFAULT_MEMORY_POLICIES,
  EngineToClient,
  EngineToRelay,
  MODE_IDS,
  MediaPutHeaderSchema,
  RelayToEngine,
  SEQ_EVENT_TYPES,
  SegmentSchema,
  b64urlDecode,
  b64urlEncode,
  decodeClaims,
  encodeClaims,
  makeEnvelope,
  newId,
  parseEnvelope,
  splitDeviceToken,
  ulid,
  validatePayload,
} from '../src';

describe('envelope', () => {
  it('builds a V1 envelope with optional header fields', () => {
    const env = makeEnvelope('stream.delta', { turn_id: 't', round_id: 0, offset: 0, delta: 'a' }, { session_id: 's1', seq: 3, reply_to: 'req_1' });
    expect(env.v).toBe(1);
    expect(env.type).toBe('stream.delta');
    expect(env.id).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(env.session_id).toBe('s1');
    expect(env.seq).toBe(3);
    expect(env.reply_to).toBe('req_1');
    expect(typeof env.ts).toBe('number');
  });

  it('omits undefined optional fields', () => {
    const env = makeEnvelope('ping', {});
    expect(Object.keys(env).sort()).toEqual(['id', 'payload', 'ts', 'type', 'v']);
  });

  it('parses valid frames and rejects invalid ones', () => {
    const raw = JSON.stringify(makeEnvelope('ping', {}));
    expect(parseEnvelope(raw).ok).toBe(true);
    expect(parseEnvelope('{not json').ok).toBe(false);
    expect(parseEnvelope(JSON.stringify({ v: 2, type: 'x', id: 'a', ts: 1, payload: {} })).ok).toBe(false);
    expect(parseEnvelope(JSON.stringify({ v: 1, type: 'x', id: 'a', ts: 1, seq: -1, payload: {} })).ok).toBe(false);
    expect(parseEnvelope('x'.repeat(100), 10).ok).toBe(false);
  });

  it('defaults payload to {} and keeps device_id', () => {
    const r = parseEnvelope(JSON.stringify({ v: 1, type: 'x', id: 'a', ts: 1, device_id: 'dev_abcdefghijk' }));
    expect(r.ok && r.envelope.payload).toEqual({});
    expect(r.ok && r.envelope.device_id).toBe('dev_abcdefghijk');
  });

  it('ulids are time sortable and unique', () => {
    const a = ulid(1_000);
    const b = ulid(2_000);
    expect(a < b).toBe(true);
    const ids = new Set(Array.from({ length: 500 }, () => newId()));
    expect(ids.size).toBe(500);
  });
});

describe('constants', () => {
  it('has 8 modes with chat=full and the other 7 confirm_only', () => {
    expect(MODE_IDS).toHaveLength(8);
    expect(DEFAULT_MEMORY_POLICIES.chat).toBe('full');
    for (const m of MODE_IDS.filter((x) => x !== 'chat')) expect(DEFAULT_MEMORY_POLICIES[m]).toBe('confirm_only');
  });
  it('seq types exclude volatile stream events', () => {
    expect(SEQ_EVENT_TYPES).not.toContain('stream.delta');
    expect(SEQ_EVENT_TYPES).not.toContain('stream.clear');
    expect(SEQ_EVENT_TYPES).toContain('memory.proposal');
  });
});

describe('client → engine payloads', () => {
  it('validates message.send and defaults attachments', () => {
    const r = validatePayload(ClientToEngine, 'message.send', { client_msg_id: 'c1', session_id: 's1', text: 'hi' });
    expect(r?.ok).toBe(true);
    expect(r && r.ok && (r.data as { attachments: unknown[] }).attachments).toEqual([]);
  });
  it('rejects unknown llm_override keys', () => {
    const r = validatePayload(ClientToEngine, 'message.send', { client_msg_id: 'c1', session_id: 's1', text: 'hi', llm_override: { model_name: 'x', evil: 1 } });
    expect(r?.ok).toBe(false);
  });
  it('memory.policy.set requires a known mode and one of three policies', () => {
    expect(validatePayload(ClientToEngine, 'memory.policy.set', { mode_id: 'galgame', memory_policy: 'isolated' })?.ok).toBe(true);
    expect(validatePayload(ClientToEngine, 'memory.policy.set', { mode_id: 'stage_contest', memory_policy: 'full' })?.ok).toBe(false);
    expect(validatePayload(ClientToEngine, 'memory.policy.set', { mode_id: 'chat', memory_policy: 'real_facts_only' })?.ok).toBe(false);
  });
  it('persona.upsert enforces role_id and limits', () => {
    const base = { display_name: '飞鸟', tagline: '', intro_md: '', preferences_md: '' };
    expect(validatePayload(ClientToEngine, 'persona.upsert', { ...base, role_id: 'asuka' })?.ok).toBe(true);
    expect(validatePayload(ClientToEngine, 'persona.upsert', { ...base, role_id: '../x' })?.ok).toBe(false);
    expect(validatePayload(ClientToEngine, 'persona.upsert', { ...base, display_name: 'x'.repeat(33) })?.ok).toBe(false);
  });
  it('avatar.generate only accepts the 4 presets and count 4', () => {
    const p = { target_type: 'role', target_id: 'asuka', source_object: 'media/avatar/x.png', style_preset: 'pixel' };
    expect(validatePayload(ClientToEngine, 'avatar.generate', p)?.ok).toBe(true);
    expect(validatePayload(ClientToEngine, 'avatar.generate', { ...p, style_preset: 'oil' })?.ok).toBe(false);
    expect(validatePayload(ClientToEngine, 'avatar.generate', { ...p, count: 8 })?.ok).toBe(false);
  });
  it('avatar.generate may omit source_object (regenerate from the existing original image)', () => {
    const p = { target_type: 'role', target_id: 'asuka', style_preset: 'pixel' };
    expect(validatePayload(ClientToEngine, 'avatar.generate', p)?.ok).toBe(true);
    expect(validatePayload(ClientToEngine, 'avatar.generate', { ...p, source_object: '' })?.ok).toBe(false);
  });
  it('returns null for unknown types', () => {
    expect(validatePayload(ClientToEngine, 'nope', {})).toBeNull();
  });
});

describe('engine → client payloads', () => {
  it('validates message.final with all segment kinds', () => {
    const segs = [
      { type: 'text', markdown: 'hi' },
      { type: 'bilingual', ja_plain: '今日は', zh: '今天', ruby_parts: [{ base: '今日', rt: 'きょう' }, { base: 'は' }], voice: { placeholder_id: 'p1' } },
      { type: 'question', prompt: '?', choices: ['A', 'B'], multi: false },
      { type: 'details', title: 't', body_markdown: 'b' },
      { type: 'file', ref: 'x.png', placeholder_id: 'p2' },
      { type: 'voice', placeholder_id: 'p3' },
      { type: 'card', kind: 'order_card', data: { items: [] }, media: { photo: 'p4' } },
    ];
    const r = validatePayload(EngineToClient, 'message.final', { message_id: 'm', turn_id: 't', segments: segs, raw_markdown: '', ts: 1 });
    expect(r?.ok).toBe(true);
  });
  it('rejects unknown segment types', () => {
    expect(SegmentSchema.safeParse({ type: 'html', html: '<b>' }).success).toBe(false);
  });
  it('validates stream.delta offsets as non-negative ints', () => {
    expect(validatePayload(EngineToClient, 'stream.delta', { turn_id: 't', round_id: 1, offset: 5, delta: 'x' })?.ok).toBe(true);
    expect(validatePayload(EngineToClient, 'stream.delta', { turn_id: 't', round_id: 1, offset: -1, delta: 'x' })?.ok).toBe(false);
  });
  it('validates memory.policy.list.result and proposals', () => {
    expect(validatePayload(EngineToClient, 'memory.policy.list.result', { policies: { ...DEFAULT_MEMORY_POLICIES }, defaults: { ...DEFAULT_MEMORY_POLICIES }, updated_at: 1 })?.ok).toBe(true);
    expect(
      validatePayload(EngineToClient, 'memory.proposal', { proposal_id: 'p', session_id: 's', source_mode: 'jp_classroom', ops: [{ file: 'user/profile.md', section: '', text: '大阪出差', tags: [] }], expires_at: 2 })?.ok,
    ).toBe(true);
  });
  it('session.snapshot defaults', () => {
    const r = validatePayload(EngineToClient, 'session.snapshot', { session: { session_id: 's', updated_at: 1 }, head_seq: 0 });
    expect(r?.ok).toBe(true);
  });
});

describe('relay ⇄ engine', () => {
  it('engine.hello accepts int or string boot ids', () => {
    expect(validatePayload(EngineToRelay, 'engine.hello', { boot_id: 1763100000000, conn_seq: 1 })?.ok).toBe(true);
    expect(validatePayload(EngineToRelay, 'engine.hello', { boot_id: '0001763100000000-ab', conn_seq: 0 })?.ok).toBe(true);
  });
  it('pair.offer requires a sha256 hex hash', () => {
    expect(validatePayload(EngineToRelay, 'pair.offer', { code_hash: 'a'.repeat(64), salt: 'b'.repeat(32), expires_at: 1 })?.ok).toBe(true);
    expect(validatePayload(EngineToRelay, 'pair.offer', { code_hash: 'zz', salt: 'b'.repeat(32), expires_at: 1 })?.ok).toBe(false);
  });
  it('media ticket / sign replies', () => {
    expect(validatePayload(RelayToEngine, 'media.ticket.ok', { object: 'o', put_url: 'u', expires_at: 1, max_bytes: 2, get_url: 'g', get_expires_at: 3 })?.ok).toBe(true);
    expect(validatePayload(RelayToEngine, 'media.signed', { object: 'o', url: 'u', expires_at: 1, issued_device_id: 'dev_x' })?.ok).toBe(true);
    expect(MediaPutHeaderSchema.safeParse({ v: 1, type: 'media.put', id: 'x', mime: 'image/webp', purpose: 'avatar_candidate', index: 2 }).success).toBe(true);
  });
});

describe('device token format', () => {
  it('round-trips claims and base64url', () => {
    const body = encodeClaims({ device_id: 'dev_0123456789AB', issued_at: 1763100000, kind: 'pair' });
    expect(decodeClaims(body)).toEqual({ device_id: 'dev_0123456789AB', issued_at: 1763100000, kind: 'pair' });
    const bytes = new TextEncoder().encode(body);
    expect(new TextDecoder().decode(b64urlDecode(b64urlEncode(bytes)))).toBe(body);
  });
  it('splits valid tokens and rejects malformed', () => {
    const body = encodeClaims({ device_id: 'dev_0123456789AB', issued_at: 1, kind: 'google' });
    const tok = `kdt1.${b64urlEncode(new TextEncoder().encode(body))}.${b64urlEncode(new Uint8Array(32))}`;
    expect(splitDeviceToken(tok)?.claims.kind).toBe('google');
    expect(splitDeviceToken('kdt2.a.b')).toBeNull();
    expect(splitDeviceToken('kdt1.@@@.b')).toBeNull();
    expect(decodeClaims('dev_x|1|root')).toBeNull();
  });

  it('google claims bind a lower-cased email as a 4th field; pair stays 3-part', () => {
    const g = encodeClaims({ device_id: 'dev_0123456789AB', issued_at: 1763100000.9, kind: 'google', email: ' Owner@Example.com ' });
    expect(g).toBe('dev_0123456789AB|1763100000|google|owner@example.com');
    expect(decodeClaims(g)).toEqual({ device_id: 'dev_0123456789AB', issued_at: 1763100000, kind: 'google', email: 'owner@example.com' });
    // `email` is ignored for pair tokens (backward-compatible 3-part body).
    const p = encodeClaims({ device_id: 'dev_0123456789AB', issued_at: 1763100000, kind: 'pair', email: 'x@example.com' });
    expect(p).toBe('dev_0123456789AB|1763100000|pair');
    expect(decodeClaims(p)).toEqual({ device_id: 'dev_0123456789AB', issued_at: 1763100000, kind: 'pair' });
    // Legacy 3-part google bodies still decode.
    expect(decodeClaims('dev_0123456789AB|1|google')).toEqual({ device_id: 'dev_0123456789AB', issued_at: 1, kind: 'google' });
  });

  it('rejects malformed 4-part bodies', () => {
    expect(decodeClaims('dev_0123456789AB|1|pair|owner@example.com')).toBeNull();
    expect(decodeClaims('dev_0123456789AB|1|google|')).toBeNull();
    expect(decodeClaims('dev_0123456789AB|1|google|not-an-email')).toBeNull();
    expect(decodeClaims(`dev_0123456789AB|1|google|${'a'.repeat(250)}@x.io`)).toBeNull();
    expect(decodeClaims('dev_0123456789AB|1|google|a@b.c|extra')).toBeNull();
  });

  it('splits 4-part google tokens and allows longer tokens up to 768 chars', () => {
    const email = `${'a'.repeat(200)}@example.com`;
    const body = encodeClaims({ device_id: 'dev_0123456789AB', issued_at: 1, kind: 'google', email });
    const tok = `kdt1.${b64urlEncode(new TextEncoder().encode(body))}.${'A'.repeat(43)}`;
    expect(tok.length).toBeGreaterThan(300);
    expect(splitDeviceToken(tok)?.claims).toEqual({ device_id: 'dev_0123456789AB', issued_at: 1, kind: 'google', email });
    expect(splitDeviceToken(`kdt1.${'A'.repeat(800)}.B`)).toBeNull();
  });
});

describe('workspace CRUD frames', () => {
  it('validates write/mkdir/delete/download requests (path, not rel_path)', () => {
    expect(ClientToEngine['workspace.write'].safeParse({ path: 'a.md', content: '' }).success).toBe(true);
    expect(ClientToEngine['workspace.write'].safeParse({ path: 'b.bin', base64: 'AAAA', overwrite: true }).success).toBe(true);
    expect(ClientToEngine['workspace.write'].safeParse({ path: '' }).success).toBe(false);
    expect(ClientToEngine['workspace.write'].safeParse({ path: 'x'.repeat(401) }).success).toBe(false);
    expect(ClientToEngine['workspace.write'].safeParse({ path: 'b.bin', base64: 'AAAA', append: true }).success).toBe(true);
    expect(ClientToEngine['workspace.mkdir'].safeParse({ path: 'dir' }).success).toBe(true);
    expect(ClientToEngine['workspace.delete'].safeParse({ rel_path: 'dir' }).success).toBe(false);
    expect(ClientToEngine['workspace.download'].safeParse({ path: 'a.png' }).success).toBe(true);
  });

  it('parses CRUD results and the optional writable flag', () => {
    expect(EngineToClient['workspace.write.result'].safeParse({ path: 'a.md', name: 'a.md', size: 0, mtime: 1, kind: 'text' }).success).toBe(true);
    expect(EngineToClient['workspace.mkdir.result'].safeParse({ path: 'd', name: 'd', kind: 'dir' }).success).toBe(true);
    expect(EngineToClient['workspace.delete.result'].safeParse({ path: 'd', deleted: true }).success).toBe(true);
    expect(EngineToClient['workspace.download.result'].safeParse({ path: 'a', name: 'a', size: 1, mime_type: 'text/plain', base64: 'YQ==' }).success).toBe(true);
    expect(EngineToClient['workspace.download.result'].safeParse({ path: 'a', name: 'a', size: 9e5, mime_type: 'image/png', url: 'https://x/y', object: 'o', expires_at: 1 }).success).toBe(true);
    const read = EngineToClient['workspace.read.result'].parse({ rel_path: 'a', name: 'a', kind: 'text', size: 1, updated_at: 0, mime: 'text/plain', writable: true });
    expect(read.writable).toBe(true);
  });
});

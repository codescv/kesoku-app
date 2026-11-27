import { z } from 'zod';
import {
  ActiveTurnSchema,
  AttachmentSchema,
  AvatarStylePresetSchema,
  DeviceSchema,
  LexTokenSchema,
  LlmOverrideSchema,
  MemoryFileSchema,
  MemoryPolicySchema,
  MemoryProposalSchema,
  MessageRecordSchema,
  ModeIdSchema,
  PersonaDetailSchema,
  PersonaSummarySchema,
  PlatformSchema,
  PolicyMapSchema,
  ProposalOpSchema,
  ProposalStatusSchema,
  SearchHitSchema,
  SegmentSchema,
  SenderSchema,
  SessionSummarySchema,
  UserProfileSchema,
} from './common';
import { ERROR_CODES } from './constants';

const sid = z.string().min(1).max(64);
const empty = z.object({}).passthrough();
const ok = z.object({ ok: z.literal(true) }).passthrough();
/** Result of `session.notes.get` / `session.notes.put` (the session's pinned `notes.md`). */
const SessionNotesResultSchema = z
  .object({ session_id: z.string(), content: z.string(), bytes: z.number().nonnegative(), updated_at: z.number().nullable().optional() })
  .passthrough();

// ───────────────────────────── Client → Engine (via relay) ─────────────────────────────

export const ClientToEngine = {
  /** Relay-consumed: first frame. Web may omit `device_token` (HttpOnly cookie is used). */
  'auth.hello': z.object({
    device_token: z.string().max(512).optional(),
    client: z.object({ platform: PlatformSchema, version: z.string().max(32), locale: z.string().max(16) }).passthrough(),
    last_inbound_id: z.string().optional(),
  }),
  /** Relay-consumed heartbeat (25 s). */
  ping: empty,
  'sync.resume': z.object({
    sessions: z.array(z.object({ session_id: sid, last_seq: z.number().int().nonnegative() })).max(32),
  }),
  'session.list': z.object({
    all_channels: z.boolean().default(false),
    role: z.string().optional(),
    cursor: z.string().nullable().optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  'session.create': z.object({
    role: z.string().optional(),
    title: z.string().max(120).optional(),
    mode: ModeIdSchema.optional(),
    /** Initial mode prefs (e.g. translator `native_lang` / `foreign_langs` / `src_lang` / `dst_lang`). */
    prefs: z.record(z.unknown()).optional(),
  }),
  'session.open': z.object({ session_id: sid }),
  'session.rename': z.object({ session_id: sid, title: z.string().min(1).max(120) }),
  'session.delete': z.object({ session_id: sid }),
  /** Read the session's pinned notes (`notes.md`, injected as `<context name="notes">` on every turn). */
  'session.notes.get': z.object({ session_id: sid }),
  /** Overwrite the session's pinned notes (empty string clears them). */
  'session.notes.put': z.object({ session_id: sid, content: z.string().max(64 * 1024) }),
  'session.search': z.object({
    q: z.string().min(1).max(200),
    role: z.string().optional(),
    all_channels: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  'history.page': z.object({ session_id: sid, before_ts: z.number(), limit: z.number().int().min(1).max(200).default(50) }),
  'message.send': z.object({
    client_msg_id: z.string().min(1).max(64),
    session_id: sid,
    text: z.string().max(32_000),
    attachments: z.array(AttachmentSchema).max(6).default([]),
    llm_override: LlmOverrideSchema.optional(),
    reply_to_question: z.string().optional(),
  }),
  'ui.pick': z.object({ session_id: sid, question_message_id: z.string(), choices: z.array(z.string()).min(1), client_msg_id: z.string().optional() }),
  'turn.stop': z.object({ session_id: sid }),
  'mode.start': z.object({ session_id: sid, mode_id: ModeIdSchema, prefs: z.record(z.unknown()).optional() }),
  'mode.stop': z.object({ session_id: sid, instance_id: z.string().optional() }),
  'mode.prefs.set': z.object({ session_id: sid, prefs: z.record(z.unknown()) }),
  'model.set': z.object({ session_id: sid, llm_override: LlmOverrideSchema.nullable() }),
  'role.set': z.object({ session_id: sid, role: z.string().min(1).max(32) }),
  'memory.list': z.object({ role: z.string() }),
  'memory.get': z.object({ role: z.string(), rel_path: z.string().max(200) }),
  'memory.put': z.object({ role: z.string(), rel_path: z.string().max(200), content: z.string().max(256 * 1024) }),
  'memory.pin': z.object({ role: z.string(), rel_path: z.string().max(200), pinned: z.boolean() }),
  'memory.proposal.list': z.object({ status: ProposalStatusSchema.optional(), limit: z.number().int().min(1).max(200).default(50) }),
  'memory.proposal.resolve': z.object({
    proposal_id: z.string(),
    action: z.enum(['confirm', 'dismiss']),
    edited_ops: z.array(ProposalOpSchema).max(10).optional(),
  }),
  'memory.policy.list': empty,
  'memory.policy.set': z.object({ mode_id: ModeIdSchema, memory_policy: MemoryPolicySchema }),
  'persona.list': empty,
  'persona.get': z.object({ role_id: z.string() }),
  'persona.upsert': z.object({
    role_id: z.string().regex(/^[a-z0-9_]{2,32}$/).optional(),
    display_name: z.string().min(1).max(32),
    tagline: z.string().max(80).default(''),
    intro_md: z.string().max(64 * 1024),
    preferences_md: z.string().max(64 * 1024),
    voice_preset: z.string().max(64).nullable().optional(),
    avatar_object: z.string().optional(),
  }),
  'persona.delete': z.object({ role_id: z.string() }),
  'voice.preview': z.object({ voice_preset: z.string().max(64), role_id: z.string().max(64).optional(), text: z.string().max(80).optional() }),
  'user_profile.get': empty,
  'user_profile.put': z.object({
    nickname: z.string().max(32),
    bio: z.string().max(2048).optional(),
    profile_md: z.string().optional(),
    cameo_opt_in: z.boolean(),
    avatar_object: z.string().optional(),
  }),
  'avatar.generate': z.object({
    target_type: z.enum(['user', 'role']),
    target_id: z.string(),
    /**
     * Freshly uploaded source photo. Omit to regenerate from the target's existing original image
     * (the role's / user's current avatar source kept by the engine) — no re-upload needed.
     */
    source_object: z.string().min(1).optional(),
    /** Added by the relay (signed GET of `source_object`). */
    source_url: z.string().optional(),
    style_preset: AvatarStylePresetSchema,
    prompt_hint: z.string().max(80).optional(),
    count: z.literal(4).default(4),
  }),
  'avatar.apply': z.object({
    job_id: z.string(),
    index: z.number().int().min(0).max(3),
    target_type: z.enum(['user', 'role']),
    target_id: z.string(),
    register_reference: z.boolean(),
  }),
  /** Relay-consumed. */
  'media.ticket': z.object({
    session_id: sid.optional(),
    purpose: z.enum(['message', 'avatar_source']),
    mime: z.string().max(100),
    bytes: z.number().int().positive(),
    filename: z.string().max(200),
  }),
  /** Relay-consumed. */
  'media.refresh': z.object({ object: z.string().max(200) }),
  'media.hydrate': z.object({ session_id: sid.optional(), message_id: z.string().optional(), ref: z.string().max(400) }),
  'lexical.explain': z.object({ session_id: sid, text: z.string().max(2000), token: z.string().max(100) }),
  'workspace.list': z.object({ rel_path: z.string().max(400).default('') }),
  'workspace.read': z.object({ rel_path: z.string().min(1).max(400) }),
  /** Create/overwrite a file: `content` (utf-8 text) or `base64` (binary upload). Uses `path`, not `rel_path`. */
  'workspace.write': z.object({
    path: z.string().min(1).max(400),
    content: z.string().optional(),
    base64: z.string().optional(),
    overwrite: z.boolean().optional(),
    /** Append this chunk to an existing file (chunked uploads; ≤512 KiB raw per chunk). */
    append: z.boolean().optional(),
    /** Optional CAS guard: `null` = must not exist; 64-char hex = must match raw disk bytes sha256; omitted = unchecked. */
    expected_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  }),
  'workspace.mkdir': z.object({ path: z.string().min(1).max(400) }),
  'workspace.delete': z.object({ path: z.string().min(1).max(400) }),
  'workspace.download': z.object({ path: z.string().min(1).max(400) }),
  'device.list': empty,
  'device.revoke': z.object({ device_id: z.string() }),
} as const;

export type ClientToEngineType = keyof typeof ClientToEngine;
export type ClientToEnginePayload<T extends ClientToEngineType> = z.input<(typeof ClientToEngine)[T]>;

/** Client frames that the relay answers itself and never forwards to the engine. */
export const RELAY_CONSUMED_TYPES: readonly ClientToEngineType[] = ['auth.hello', 'ping', 'media.ticket', 'media.refresh'];

// ───────────────────────────── Engine → Client (via relay) ─────────────────────────────

const StreamPhase = z.enum(['text', 'thought']);

export const EngineToClient = {
  /** Relay-generated. */
  'auth.ok': z.object({ device_id: z.string(), engine_online: z.boolean(), server_ts: z.number(), kind: z.enum(['pair', 'google']).optional() }).passthrough(),
  pong: z.object({ server_ts: z.number() }).passthrough(),

  // seq'd session events (persisted in app_outbox, replayable)
  'message.user': z
    .object({
      message_id: z.string(),
      client_msg_id: z.string().optional(),
      text: z.string(),
      attachments: z.array(AttachmentSchema).default([]),
      ts: z.number(),
      sender: SenderSchema.optional(),
    })
    .passthrough(),
  'turn.event': z
    .object({
      turn_id: z.string(),
      kind: z.enum(['thought', 'tool_call', 'tool_result', 'system']),
      message_id: z.string().optional(),
      title: z.string(),
      body: z.string().optional(),
      status: z.string().optional(),
      elapsed_ms: z.number().optional(),
    })
    .passthrough(),
  'message.final': z
    .object({
      message_id: z.string(),
      turn_id: z.string(),
      segments: z.array(SegmentSchema),
      raw_markdown: z.string().default(''),
      ts: z.number(),
      sender: SenderSchema.optional(),
    })
    .passthrough(),
  'media.pending': z.object({ placeholder_id: z.string(), message_id: z.string().optional(), kind: z.string(), label: z.string().default('') }).passthrough(),
  'media.ready': z
    .object({
      placeholder_id: z.string().optional(),
      message_id: z.string().optional(),
      kind: z.string(),
      object: z.string().optional(),
      ref: z.string().optional(),
      url: z.string().optional(),
      mime: z.string().optional(),
      bytes: z.number().optional(),
      duration_ms: z.number().optional(),
      expires_at: z.number().optional(),
      job_id: z.string().optional(),
      index: z.number().int().optional(),
    })
    .passthrough(),
  'media.failed': z.object({ placeholder_id: z.string(), reason: z.string().default('') }).passthrough(),
  'state.sync': z
    .object({ files: z.record(z.unknown()).default({}), removed: z.array(z.string()).default([]), staging_rev: z.number().default(0) })
    .passthrough(),
  'session.updated': z
    .object({ session_id: z.string(), title: z.string().optional(), role: z.string().optional(), mode_id: z.string().nullable().optional(), updated_at: z.number(), deleted: z.boolean().optional() })
    .passthrough(),
  'memory.proposal': MemoryProposalSchema,
  'memory.proposal.resolved': z
    .object({ proposal_id: z.string(), status: z.enum(['applied', 'dismissed', 'expired']), applied_files: z.array(z.string()).optional() })
    .passthrough(),

  // volatile stream (no seq)
  'stream.delta': z
    .object({
      turn_id: z.string(),
      round_id: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
      delta: z.string(),
      phase: StreamPhase.default('text'),
    })
    .passthrough(),
  'stream.clear': z.object({ turn_id: z.string(), round_id: z.number().int().nonnegative() }).passthrough(),

  // sync
  'sync.done': z
    .object({
      session_id: z.string(),
      replayed_through_seq: z.number().int().nonnegative(),
      head_seq: z.number().int().nonnegative(),
      has_more: z.boolean(),
      active_turn: ActiveTurnSchema.nullable().optional(),
    })
    .passthrough(),
  'sync.reset': z.object({ session_id: z.string(), reason: z.literal('OUTBOX_PRUNED'), head_seq: z.number().int().nonnegative() }).passthrough(),

  // RPC replies (reply_to + device_id)
  'message.ack': z.object({ client_msg_id: z.string(), message_id: z.string(), seq: z.number().int().nonnegative() }).passthrough(),
  'session.snapshot': z
    .object({
      session: SessionSummarySchema,
      last_messages: z.array(MessageRecordSchema).default([]),
      state_files: z.record(z.unknown()).default({}),
      active_turn: ActiveTurnSchema.nullable().optional(),
      head_seq: z.number().int().nonnegative(),
      origin_channel: z.string().nullable().default('app'),
      llm_override: LlmOverrideSchema.nullable().optional(),
      mode_prefs: z.record(z.unknown()).nullable().optional(),
      pending_proposals: z.array(MemoryProposalSchema).optional(),
    })
    .passthrough(),
  'session.list.result': z.object({ sessions: z.array(SessionSummarySchema), next_cursor: z.string().nullable().optional() }).passthrough(),
  'session.rename.result': ok,
  'session.delete.result': ok,
  'session.notes.get.result': SessionNotesResultSchema,
  'session.notes.put.result': SessionNotesResultSchema,
  'session.search.result': z.object({ hits: z.array(SearchHitSchema) }).passthrough(),
  'history.page.result': z.object({ session_id: z.string(), messages: z.array(MessageRecordSchema), has_more: z.boolean() }).passthrough(),
  'ui.pick.result': ok,
  'turn.stop.result': ok,
  'mode.start.result': ok,
  'mode.stop.result': ok,
  'mode.prefs.set.result': z.object({ ok: z.literal(true), prefs: z.record(z.unknown()) }).passthrough(),
  'model.set.result': z.object({ ok: z.literal(true), llm_override: LlmOverrideSchema.nullable() }).passthrough(),
  'role.set.result': z.object({ ok: z.literal(true), role: z.string() }).passthrough(),
  'memory.list.result': z.object({ role: z.string(), files: z.array(MemoryFileSchema), pinned_count: z.number().int().optional() }).passthrough(),
  'memory.get.result': z.object({ role: z.string(), rel_path: z.string(), content: z.string(), pinned: z.boolean().default(false), updated_at: z.number().optional() }).passthrough(),
  'memory.put.result': z.object({ ok: z.literal(true), rel_path: z.string(), updated_at: z.number().optional() }).passthrough(),
  'memory.proposal.resolve.result': z.object({ ok: z.literal(true), proposal_id: z.string(), status: ProposalStatusSchema }).passthrough(),
  'memory.pin.result': z.object({ ok: z.literal(true), rel_path: z.string(), pinned: z.boolean() }).passthrough(),
  'memory.proposal.list.result': z.object({ proposals: z.array(MemoryProposalSchema) }).passthrough(),
  'memory.policy.list.result': z.object({ policies: PolicyMapSchema, defaults: PolicyMapSchema, updated_at: z.number() }).passthrough(),
  'memory.policy.updated': z.object({ policies: PolicyMapSchema, changed: z.array(z.string()), updated_at: z.number() }).passthrough(),
  'persona.list.result': z.object({ roles: z.array(PersonaSummarySchema) }).passthrough(),
  'persona.get.result': PersonaDetailSchema,
  'persona.upsert.result': z.object({ ok: z.literal(true), role: PersonaSummarySchema }).passthrough(),
  'persona.delete.result': ok,
  'persona.updated': z.object({ roles: z.array(PersonaSummarySchema), deleted: z.array(z.string()).optional() }).passthrough(),
  'user_profile.get.result': UserProfileSchema,
  'user_profile.put.result': z.object({ ok: z.literal(true), profile: UserProfileSchema }).passthrough(),
  'user_profile.updated': UserProfileSchema,
  'avatar.job': z.object({ job_id: z.string(), placeholders: z.array(z.string()), eta_ms: z.number().default(20000) }).passthrough(),
  'avatar.apply.result': z.object({ ok: z.literal(true), avatar_rev: z.number().int().optional() }).passthrough(),
  'voice.preview.result': ok,
  'media.ticket.ok': z.object({ object: z.string(), put_url: z.string(), expires_at: z.number(), max_bytes: z.number().int(), headers: z.record(z.string()).optional() }).passthrough(),
  'media.refresh.ok': z.object({ object: z.string(), url: z.string(), expires_at: z.number() }).passthrough(),
  'lexical.explain.result': z.object({ text: z.string().optional(), token: LexTokenSchema, tokens: z.array(LexTokenSchema).optional() }).passthrough(),
  'workspace.list.result': z
    .object({
      rel_path: z.string().default(''),
      awd_name: z.string().default('band'),
      workspace_id: z.string().optional(),
      workspace_cas: z.boolean().optional(),
      entries: z.array(
        z
          .object({
            name: z.string(),
            rel_path: z.string(),
            kind: z.enum(['dir', 'file']),
            size: z.number().int().nonnegative(),
            updated_at: z.number(),
            bytes: z.number().int().nonnegative().optional(),
            mtime: z.number().optional(),
          })
          .passthrough(),
      ),
    })
    .passthrough(),
  'workspace.read.result': z
    .object({
      rel_path: z.string(),
      name: z.string(),
      kind: z.enum(['text', 'media', 'binary']),
      size: z.number().int().nonnegative().optional(),
      updated_at: z.number().optional(),
      bytes: z.number().int().nonnegative().optional(),
      mtime: z.number().optional(),
      sha256: z.string().optional(),
      mime: z.string(),
      content: z.string().optional(),
      truncated: z.boolean().optional(),
      ref: z.string().optional(),
      writable: z.boolean().optional(),
    })
    .passthrough(),
  'workspace.write.result': z.union([
    z
      .object({
        conflict: z.literal(true),
        cas: z.boolean().optional(),
        path: z.string(),
        sha256: z.string().nullable().optional(),
        mtime: z.number().nullable().optional(),
      })
      .passthrough(),
    z
      .object({
        conflict: z.literal(false).optional(),
        path: z.string(),
        name: z.string(),
        size: z.number().int().nonnegative(),
        mtime: z.number().optional(),
        kind: z.string().optional(),
        sha256: z.string().optional(),
        cas: z.boolean().optional(),
      })
      .passthrough(),
  ]),
  'workspace.mkdir.result': z.object({ path: z.string(), name: z.string(), kind: z.literal('dir') }).passthrough(),
  'workspace.delete.result': z.object({ path: z.string(), deleted: z.boolean() }).passthrough(),
  'workspace.download.result': z
    .object({
      path: z.string(),
      name: z.string(),
      size: z.number().int().nonnegative(),
      mime_type: z.string(),
      /** Inlined only for files ≤ 640 KiB; larger files come back as a signed `url` instead. */
      base64: z.string().optional(),
      url: z.string().optional(),
      object: z.string().optional(),
      expires_at: z.number().optional(),
    })
    .passthrough(),
  'device.list.result': z.object({ devices: z.array(DeviceSchema) }).passthrough(),
  'device.revoke.result': ok,

  // relay lifecycle
  'engine.status': z.object({ online: z.boolean(), since: z.number(), latency_ms: z.number().nullable().optional() }).passthrough(),
  'relay.rotate': z.object({ grace_ms: z.number().int() }).passthrough(),
  'relay.restarting': z.object({ retry_ms: z.number().int() }).passthrough(),
  error: z.object({ code: z.enum(ERROR_CODES).or(z.string()), message: z.string().default(''), reply_to: z.string().optional() }).passthrough(),
} as const;

export type EngineToClientType = keyof typeof EngineToClient;
export type EngineToClientPayload<T extends EngineToClientType> = z.output<(typeof EngineToClient)[T]>;

/** Session events that carry a `seq` and are persisted in `app_outbox` (replayable). */
export const SEQ_EVENT_TYPES: readonly EngineToClientType[] = [
  'message.user',
  'message.final',
  'turn.event',
  'media.pending',
  'media.ready',
  'media.failed',
  'state.sync',
  'session.updated',
  'memory.proposal',
  'memory.proposal.resolved',
];

// ───────────────────────────── Relay ⇄ Engine (engine leg only) ─────────────────────────────

export const EngineToRelay = {
  'engine.hello': z
    .object({
      /** Per-process id: int ms epoch at process start (or a sortable string). */
      boot_id: z.union([z.number().int().nonnegative(), z.string().min(1).max(64)]),
      conn_seq: z.number().int().nonnegative(),
      engine_version: z.string().optional(),
      last_inbound_id: z.string().optional(),
      revoked_device_ids: z.array(z.string()).default([]),
    })
    .passthrough(),
  /** code_hash = hex(sha256(utf8(code + salt))), code = 6 ASCII digits, salt = 32 hex chars. */
  'pair.offer': z.object({ code_hash: z.string().regex(/^[0-9a-f]{64}$/), salt: z.string().min(8).max(128), expires_at: z.number(), name: z.string().max(64).default('') }).passthrough(),
  'device.revoked': z.object({ device_ids: z.array(z.string()) }).passthrough(),
  'media.upload.ticket': z
    .object({
      session_id: sid.optional(),
      purpose: z.enum(['message', 'asset', 'avatar_candidate']).default('message'),
      mime: z.string().max(100),
      bytes: z.number().int().positive(),
      filename: z.string().max(200).optional(),
      index: z.number().int().min(0).max(3).optional(),
    })
    .passthrough(),
  'media.sign': z.object({ object: z.string().max(200) }).passthrough(),
  ping: empty,
} as const;
export type EngineToRelayType = keyof typeof EngineToRelay;

/** Binary frame header (engine → relay): `uint32 BE header_len | header JSON | bytes` (≤ 1 MiB total). */
export const MediaPutHeaderSchema = z
  .object({
    v: z.literal(1),
    type: z.literal('media.put'),
    id: z.string(),
    purpose: z.enum(['message', 'asset', 'avatar_candidate']).default('message'),
    session_id: sid.optional(),
    mime: z.string().max(100),
    filename: z.string().max(200).optional(),
    index: z.number().int().min(0).max(3).optional(),
  })
  .passthrough();
export type MediaPutHeader = z.infer<typeof MediaPutHeaderSchema>;

export const RelayToEngine = {
  'engine.welcome': z.object({ primary: z.boolean(), server_ts: z.number(), queued: z.number().int().nonnegative() }).passthrough(),
  'pair.redeem': z.object({ device_id: z.string(), name: z.string(), platform: z.string().default('web'), model: z.string().optional() }).passthrough(),
  'pair.burned': z.object({ code_hash: z.string().optional(), attempts: z.number().int().optional() }).passthrough(),
  'device.registered': z.object({ device_id: z.string(), kind: z.literal('google'), name: z.string(), email: z.string().optional(), platform: z.string().optional() }).passthrough(),
  'sync.replay': z.object({ session_id: sid, after_seq: z.number().int().nonnegative(), limit: z.number().int().min(1).max(500).default(500) }).passthrough(),
  /** Reply to `media.upload.ticket`. */
  'media.ticket.ok': z
    .object({
      object: z.string(),
      put_url: z.string(),
      expires_at: z.number(),
      max_bytes: z.number().int(),
      get_url: z.string(),
      get_expires_at: z.number(),
      headers: z.record(z.string()).optional(),
    })
    .passthrough(),
  /** Reply to `media.sign`. */
  'media.signed': z
    .object({ object: z.string(), url: z.string(), expires_at: z.number(), issued_device_id: z.string().optional(), issued_at: z.number().optional() })
    .passthrough(),
  /** Reply to a binary `media.put` frame. */
  'media.put.ok': z.object({ object: z.string(), url: z.string(), expires_at: z.number(), mime: z.string(), bytes: z.number().int() }).passthrough(),
  pong: z.object({ server_ts: z.number() }).passthrough(),
  'relay.rotate': z.object({ grace_ms: z.number().int() }).passthrough(),
  'relay.restarting': z.object({ retry_ms: z.number().int() }).passthrough(),
  error: z.object({ code: z.string(), message: z.string().default(''), reply_to: z.string().optional() }).passthrough(),
} as const;
export type RelayToEngineType = keyof typeof RelayToEngine;

/** Validate a payload for a known type (returns `null` when the type is unknown). */
export function validatePayload(
  table: Record<string, z.ZodTypeAny>,
  type: string,
  payload: unknown,
): { ok: true; data: unknown } | { ok: false; error: string } | null {
  const schema = table[type];
  if (!schema) return null;
  const res = schema.safeParse(payload);
  if (res.success) return { ok: true, data: res.data };
  return { ok: false, error: res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
}

export { SegmentSchema };

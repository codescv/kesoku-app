import { z } from 'zod';
import {
  AVATAR_STYLE_PRESETS,
  MEMORY_POLICIES,
  MODE_IDS,
  PROPOSAL_STATUSES,
  THINKING_LEVELS,
} from './constants';

export const ModeIdSchema = z.enum(MODE_IDS);
export const MemoryPolicySchema = z.enum(MEMORY_POLICIES);
export const ProposalStatusSchema = z.enum(PROPOSAL_STATUSES);
export const AvatarStylePresetSchema = z.enum(AVATAR_STYLE_PRESETS);
export const PlatformSchema = z.enum(['web', 'android', 'ios']);
export const ChatbotIdSchema = z.string().min(1).max(64); // 'app' | 'discord' | 'discord_asuka' | 'wechat' | …

/** Per-mode policy map. Engines may add extra mode ids; clients render the known 8. */
export const PolicyMapSchema = z.record(MemoryPolicySchema);

/** Generalised per-message LLM override (Blueprint §3.4). */
export const LlmOverrideSchema = z
  .object({
    llm: z.enum(['gemini', 'claude']).optional(),
    model_name: z.string().max(80).optional(),
    thinking_level: z.enum(THINKING_LEVELS).optional(),
    stream: z.boolean().optional(),
  })
  .strict();
export type LlmOverride = z.infer<typeof LlmOverrideSchema>;

/** Inline lexical breakdown token for bilingual cards. */
export const LexTokenSchema = z
  .object({
    surface: z.string(),
    reading: z.string().optional(),
    lemma: z.string().optional(),
    pos: z.string().optional(),
    gloss_zh: z.string().optional(),
    conj: z.string().optional(),
    /** 📘 textbook form */
    textbook: z.string().optional(),
    /** 🔥 colloquial / contracted form */
    colloquial: z.string().optional(),
    note: z.string().optional(),
    start: z.number().int().nonnegative().optional(),
    end: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type LexToken = z.infer<typeof LexTokenSchema>;

/** Explicit ruby annotations: `[{base, rt}]`, `[[base, rt]]`, a `{base: rt}` map, or inline `漢字(かな)` notation. */
export const RubySpecSchema = z.union([
  z.string(),
  z.array(z.union([z.object({ base: z.string(), rt: z.string() }).passthrough(), z.tuple([z.string(), z.string()])])),
  z.record(z.string()),
]);
export type RubySpec = z.infer<typeof RubySpecSchema>;

export const VoiceRefSchema = z
  .object({
    object: z.string().optional(),
    ref: z.string().optional(),
    url: z.string().optional(),
    placeholder_id: z.string().optional(),
    duration_ms: z.number().nonnegative().optional(),
  })
  .passthrough();

/** Segment union (Blueprint §3.4). `ja_html` is NEVER rendered as HTML by clients. */
export const TextSegmentSchema = z.object({ type: z.literal('text'), markdown: z.string() }).passthrough();
export const BilingualSegmentSchema = z
  .object({
    type: z.literal('bilingual'),
    ja_html: z.string().optional(),
    ja_plain: z.string(),
    /** Source notation (may contain `漢字(かな)`). */
    ja: z.string().optional(),
    ruby: RubySpecSchema.optional(),
    /** Engine-normalised ruby runs — preferred render source. */
    ruby_parts: z.array(z.object({ base: z.string(), rt: z.string().optional() }).passthrough()).optional(),
    zh: z.string().default(''),
    speaker: z.string().optional(),
    voice: VoiceRefSchema.optional(),
    tokens: z.array(LexTokenSchema).optional(),
  })
  .passthrough();
export const QuestionSegmentSchema = z
  .object({
    type: z.literal('question'),
    prompt: z.string().default(''),
    choices: z.array(z.string()),
    multi: z.boolean().default(false),
    max: z.number().int().positive().optional(),
    question_message_id: z.string().optional(),
  })
  .passthrough();
export const DetailsSegmentSchema = z
  .object({ type: z.literal('details'), title: z.string(), body_markdown: z.string() })
  .passthrough();
export const FileSegmentSchema = z
  .object({
    type: z.enum(['file', 'voice']),
    object: z.string().optional(),
    ref: z.string().optional(),
    url: z.string().optional(),
    placeholder_id: z.string().optional(),
    mime: z.string().optional(),
    name: z.string().optional(),
    duration_ms: z.number().optional(),
  })
  .passthrough();
export const CardSegmentSchema = z
  .object({
    type: z.literal('card'),
    kind: z.string().min(1),
    data: z.record(z.unknown()).default({}),
    /** `{<data key>: placeholder_id}` for media referenced by the card. */
    media: z.record(z.string()).optional(),
  })
  .passthrough();

export const SegmentSchema = z.discriminatedUnion('type', [
  TextSegmentSchema,
  BilingualSegmentSchema,
  QuestionSegmentSchema,
  DetailsSegmentSchema,
  FileSegmentSchema.extend({ type: z.literal('file') }),
  FileSegmentSchema.extend({ type: z.literal('voice') }),
  CardSegmentSchema,
]);
export type Segment = z.infer<typeof SegmentSchema>;
export type TextSegment = z.infer<typeof TextSegmentSchema>;
export type BilingualSegment = z.infer<typeof BilingualSegmentSchema>;
export type QuestionSegment = z.infer<typeof QuestionSegmentSchema>;
export type DetailsSegment = z.infer<typeof DetailsSegmentSchema>;
export type FileSegment = z.infer<typeof FileSegmentSchema>;
export type CardSegment = z.infer<typeof CardSegmentSchema>;

export const AttachmentSchema = z
  .object({
    object: z.string().max(200),
    mime: z.string().max(100),
    filename: z.string().max(200),
    bytes: z.number().int().nonnegative(),
    /** Added by the relay (signed GET) before forwarding to the engine. Never sent by clients. */
    url: z.string().optional(),
    ref: z.string().optional(),
  })
  .passthrough();
export type Attachment = z.infer<typeof AttachmentSchema>;

export const ActiveTurnSchema = z.object({
  turn_id: z.string(),
  round_id: z.number().int().nonnegative(),
  preview_text: z.string(),
});
export type ActiveTurn = z.infer<typeof ActiveTurnSchema>;

export const SessionSummarySchema = z
  .object({
    session_id: z.string(),
    title: z.string().default(''),
    role: z.string().default('asuka'),
    chatbot_id: ChatbotIdSchema.default('app'),
    origin_channel: z.string().nullable().optional(),
    mode_id: z.string().nullable().optional(),
    created_at: z.number().optional(),
    updated_at: z.number(),
    head_seq: z.number().int().nonnegative().optional(),
    preview: z.string().optional(),
    unread: z.number().int().nonnegative().optional(),
    /** True once an `app` binding exists for a non-app session (cross-channel takeover). */
    app_bound: z.boolean().optional(),
  })
  .passthrough();
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const SenderSchema = z
  .object({
    kind: z.enum(['user', 'assistant', 'system']).optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    role_id: z.string().optional(),
    display_name: z.string().optional(),
    chatbot_id: z.string().optional(),
    device_id: z.string().optional(),
  })
  .passthrough();

/** Historic message record (snapshot + history.page). */
export const MessageRecordSchema = z
  .object({
    message_id: z.string(),
    role: z.enum(['user', 'assistant', 'system']),
    ts: z.number(),
    text: z.string().optional(),
    segments: z.array(SegmentSchema).optional(),
    raw_markdown: z.string().optional(),
    turn_id: z.string().optional(),
    seq: z.number().int().nonnegative().optional(),
    client_msg_id: z.string().optional(),
    attachments: z.array(AttachmentSchema).optional(),
    sender: SenderSchema.optional(),
    chatbot_id: z.string().optional(),
  })
  .passthrough();
export type MessageRecord = z.infer<typeof MessageRecordSchema>;

export const ProposalOpSchema = z
  .object({
    file: z.string().max(200),
    section: z.string().max(200).default(''),
    text: z.string().max(500),
    tags: z.array(z.string().max(40)).default([]),
  })
  .passthrough();
export type ProposalOp = z.infer<typeof ProposalOpSchema>;

export const MemoryProposalSchema = z
  .object({
    proposal_id: z.string(),
    session_id: z.string(),
    message_id: z.string().nullable().optional(),
    /** Triggering user message id (= assistant turn_id); preferred anchor for the inline card. */
    turn_id: z.string().nullable().optional(),
    role: z.string().optional(),
    source_mode: z.string().nullable().optional(),
    ops: z.array(ProposalOpSchema),
    status: ProposalStatusSchema.default('pending'),
    created_at: z.number().optional(),
    expires_at: z.number(),
    applied_files: z.array(z.string()).optional(),
  })
  .passthrough();
export type MemoryProposal = z.infer<typeof MemoryProposalSchema>;

export const PersonaSummarySchema = z
  .object({
    role_id: z.string(),
    display_name: z.string(),
    tagline: z.string().default(''),
    builtin: z.boolean().default(false),
    avatar_rev: z.number().int().nonnegative().default(0),
    avatar_ref: z.string().nullable().optional(),
    avatar_ai: z.boolean().optional(),
    /** The engine keeps an original source image, so `avatar.generate` may omit `source_object`. */
    has_source_image: z.boolean().optional(),
    voice_preset: z.string().nullable().optional(),
    updated_at: z.number().optional(),
  })
  .passthrough();
export type PersonaSummary = z.infer<typeof PersonaSummarySchema>;

export const PersonaDetailSchema = PersonaSummarySchema.extend({
  intro_md: z.string().default(''),
  preferences_md: z.string().default(''),
  readonly_notes: z.string().optional(),
});
export type PersonaDetail = z.infer<typeof PersonaDetailSchema>;

export const UserProfileSchema = z
  .object({
    nickname: z.string().default(''),
    bio: z.string().default(''),
    cameo_opt_in: z.boolean().default(false),
    avatar_rev: z.number().int().nonnegative().default(0),
    avatar_ref: z.string().nullable().optional(),
    avatar_ai: z.boolean().optional(),
    /** The engine keeps an original source image, so `avatar.generate` may omit `source_object`. */
    has_source_image: z.boolean().optional(),
    character_dir: z.string().optional(),
  })
  .passthrough();
export type UserProfile = z.infer<typeof UserProfileSchema>;

export const MemoryFileSchema = z
  .object({
    rel_path: z.string(),
    pinned: z.boolean().default(false),
    bytes: z.number().int().nonnegative().optional(),
    updated_at: z.number().optional(),
    tags: z.array(z.string()).optional(),
    title: z.string().optional(),
  })
  .passthrough();
export type MemoryFile = z.infer<typeof MemoryFileSchema>;

export const DeviceSchema = z
  .object({
    device_id: z.string(),
    name: z.string(),
    kind: z.enum(['pair', 'google']),
    platform: z.string().nullable().optional(),
    created_at: z.number(),
    last_seen_at: z.number().nullable().optional(),
    revoked_at: z.number().nullable().optional(),
    current: z.boolean().optional(),
  })
  .passthrough();
export type Device = z.infer<typeof DeviceSchema>;

export const SearchHitSchema = z
  .object({
    session_id: z.string(),
    message_id: z.string().nullable().optional(),
    snippet: z.string(),
    ts: z.number(),
    role: z.string().optional(),
    chatbot_id: z.string().optional(),
    title: z.string().optional(),
  })
  .passthrough();
export type SearchHit = z.infer<typeof SearchHitSchema>;

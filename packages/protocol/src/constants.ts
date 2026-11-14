/**
 * Shared constants for the Kesoku wire protocol (V1.2).
 * Mirrors kesoku `src/kesoku/gateway/chatbot/app/protocol.py`.
 */

export const PROTOCOL_VERSION = 1 as const;

/** The 8 experience modes (launchpad order). */
export const MODE_IDS = [
  'chat',
  'galgame',
  'travel_companion',
  'translator',
  'jp_classroom',
  'trpg',
  'pokemon_assistant',
  'story_theater',
] as const;
export type ModeId = (typeof MODE_IDS)[number];

/** 3-state per-mode memory policy (UI: 自动 / 确认 / 忽略). */
export const MEMORY_POLICIES = ['full', 'confirm_only', 'isolated'] as const;
export type MemoryPolicy = (typeof MEMORY_POLICIES)[number];

/** Factory defaults: chat = full (自动), every other mode = confirm_only (确认). */
export const DEFAULT_MEMORY_POLICIES: Readonly<Record<ModeId, MemoryPolicy>> = Object.freeze({
  chat: 'full',
  galgame: 'confirm_only',
  travel_companion: 'confirm_only',
  translator: 'confirm_only',
  jp_classroom: 'confirm_only',
  trpg: 'confirm_only',
  pokemon_assistant: 'confirm_only',
  story_theater: 'confirm_only',
});

export const MEMORY_POLICY_LABELS: Readonly<Record<MemoryPolicy, string>> = Object.freeze({
  full: '自动',
  confirm_only: '确认',
  isolated: '忽略',
});

export const PROPOSAL_STATUSES = ['pending', 'applied', 'dismissed', 'expired'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const AVATAR_STYLE_PRESETS = ['anime_clean', 'cyber_flat', 'watercolor', 'pixel'] as const;
export type AvatarStylePreset = (typeof AVATAR_STYLE_PRESETS)[number];

export const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ModelCatalogEntry {
  /** Exact model name sent as `llm_override.model_name` (must be in `allowed_models`). */
  model_name: string;
  llm: 'gemini' | 'claude';
  /** Short capsule label shown in the top bar. */
  label: string;
  supports_explicit_cache: boolean;
}

/** The 6 routable models (Blueprint §6.4 `allowed_models`). */
export const MODEL_CATALOG: readonly ModelCatalogEntry[] = Object.freeze([
  { model_name: 'gemini-4-hydrogen', llm: 'gemini', label: 'Hydrogen', supports_explicit_cache: false },
  { model_name: 'gemini-3.8-flash', llm: 'gemini', label: 'Flash 3.8', supports_explicit_cache: true },
  { model_name: 'gemini-3.5-flash-lite', llm: 'gemini', label: 'Flash Lite', supports_explicit_cache: true },
  { model_name: 'gemini-4-argon', llm: 'gemini', label: 'Argon', supports_explicit_cache: true },
  { model_name: 'claude-sonnet-5-5', llm: 'claude', label: 'Sonnet 5.5', supports_explicit_cache: true },
  { model_name: 'claude-opus-5-5', llm: 'claude', label: 'Opus 5.5', supports_explicit_cache: true },
]);

export const ERROR_CODES = [
  'UNAUTHORIZED',
  'FORBIDDEN_EMAIL',
  'ENGINE_OFFLINE',
  'RATE_LIMITED',
  'BAD_REQUEST',
  'NOT_FOUND',
  'TURN_BUSY',
  'PERSONA_BUILTIN',
  'AVATAR_SOURCE_INVALID',
  'PROPOSAL_NOT_PENDING',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** WebSocket close codes used by the relay. */
export const WS_CLOSE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001,
  UNAUTHORIZED: 4401,
  FORBIDDEN: 4403,
  REVOKED: 4410,
  SUPERSEDED: 4409,
  ROTATE: 4000,
  RATE_LIMITED: 4429,
});

/** Session-scoped media object names (relay-issued). */
export const SESSION_MEDIA_OBJECT_RE = /^media\/[0-9a-f]{8}\/[0-9a-f-]{36}\.[a-z0-9]{1,5}$/;
/** Avatar source / candidate object names. */
export const AVATAR_MEDIA_OBJECT_RE = /^media\/avatar\/[0-9a-f-]{36}(-cand[0-3])?\.(jpg|png|webp|heic)$/;
/** `media.hydrate` refs that need no session (avatars). */
export const AVATAR_REF_RE = /^(roles\/[a-z0-9_]{2,32}|user)\/avatar\.webp$/;
export const ROLE_ID_RE = /^[a-z0-9_]{2,32}$/;

export const LIMITS = Object.freeze({
  RING_BUFFER_PER_SESSION: 2000,
  ENGINE_INBOUND_QUEUE: 1000,
  ROTATE_AFTER_MS: 55 * 60 * 1000,
  ROTATE_GRACE_MS: 3000,
  ENGINE_DRAIN_MS: 3000,
  AUTH_HELLO_TIMEOUT_MS: 5000,
  PING_INTERVAL_MS: 25_000,
  PAIR_MAX_ATTEMPTS_PER_OFFER: 5,
  PAIR_IP_LIMIT: 5,
  PAIR_IP_WINDOW_MS: 10 * 60 * 1000,
  MEDIA_PUT_TTL_S: 600,
  MEDIA_GET_TTL_S: 900,
  MESSAGE_MEDIA_MAX_BYTES: 25 * 1024 * 1024,
  AVATAR_SOURCE_MAX_BYTES: 12 * 1024 * 1024,
  MODE_PREFS_MAX_BYTES: 2048,
  PROMPT_HINT_MAX: 80,
  DISPLAY_NAME_MAX: 32,
  TAGLINE_MAX: 80,
  PERSONA_FILE_MAX_BYTES: 64 * 1024,
  BIO_MAX_BYTES: 2048,
  PROPOSAL_TEXT_MAX: 500,
});

export const SESSION_COOKIE_SECURE = '__Host-kesoku_session';
export const SESSION_COOKIE_FALLBACK = '__Secure-kesoku_session';

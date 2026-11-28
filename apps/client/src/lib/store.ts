import { create } from 'zustand';
import {
  DEFAULT_MEMORY_POLICIES,
  type Attachment,
  type EngineToClientPayload,
  type LlmOverride,
  type MemoryPolicy,
  type MemoryProposal,
  type MessageRecord,
  type PersonaSummary,
  type RegisteredCharacter,
  type SessionSummary,
  type UserProfile,
} from '@kesoku/protocol';
import { detectActiveMode } from '@kesoku/hud';
import { setUiLanguage, type LanguageSetting } from '@kesoku/ui';
import type { SocketStatus } from './ws';
import type { ChatItem, InspectorPanel, PolicyState, StreamPreview, TurnEvent } from './types';
import { applyClear, applyDelta, fromActiveTurn, type DeltaPayload } from '../features/stream/previewBuffer';

const GAMES_FILE = 'game/games.json';

export interface MediaEntry {
  status: 'pending' | 'ready' | 'failed';
  url?: string;
  object?: string;
  mime?: string;
  kind?: string;
  label?: string;
  reason?: string;
  expires_at?: number;
  duration_ms?: number;
}

export interface AvatarJob {
  job_id: string;
  placeholders: string[];
  eta_ms: number;
  startedAt: number;
}

export interface Settings {
  language: LanguageSetting;
  theme: 'system' | 'light' | 'dark';
  fontSize: 'standard' | 'large';
  allChannels: boolean;
  ttsEngine: 'native' | 'server';
  defaultModel: LlmOverride;
  translatorModel: string;
  /** Translator mode native language (TRANSLATOR_LANGS code). */
  translatorNativeLang: string;
  /** Translator mode foreign languages (quick-switch pills; at least one). */
  translatorForeignLangs: string[];
}

export type Screen = 'chat' | 'settings' | 'memory' | 'notes' | 'studio' | 'files' | 'tools' | 'workout';

export interface Toast {
  id: number;
  text: string;
  tone?: 'info' | 'error';
}

export interface ComposerQuote {
  text: string;
  speaker?: string;
  sessionId?: string | null;
  n: number;
}

export interface KesokuState {
  conn: { status: SocketStatus; engineOnline: boolean; latencyMs: number | null; deviceId: string | null; retryInMs?: number; engineSince?: number };
  auth: 'unknown' | 'needed' | 'ok';
  authKind: 'pair' | 'google' | null;
  email: string | null;
  sessions: Record<string, SessionSummary>;
  currentSessionId: string | null;
  items: Record<string, ChatItem[]>;
  previews: Record<string, StreamPreview | undefined>;
  finalized: Set<string>;
  turnEvents: Record<string, TurnEvent[]>;
  lastSeq: Record<string, number>;
  headSeq: Record<string, number>;
  stateFiles: Record<string, Record<string, unknown>>;
  modePrefs: Record<string, Record<string, unknown>>;
  modeDefaults: Record<string, Record<string, unknown>>;
  characters: RegisteredCharacter[];
  llmOverride: Record<string, LlmOverride | null>;
  origin: Record<string, string>;
  takenOver: Record<string, boolean>;
  hasMoreHistory: Record<string, boolean>;
  policies: PolicyState;
  personas: PersonaSummary[];
  profile: UserProfile | null;
  proposals: Record<string, MemoryProposal>;
  media: Record<string, MediaEntry>;
  avatarJobs: Record<string, AvatarJob>;
  searchHits: EngineToClientPayload<'session.search.result'>['hits'];
  settings: Settings;
  ui: {
    drawerOpen: boolean;
    launchpad: boolean;
    inspector: InspectorPanel | null;
    screen: Screen;
    /** Destination screen when closing a tool panel (`'tools'` if opened from Tools hub, else `'chat'`). */
    toolReturnScreen: 'chat' | 'tools';
    stageView: 'stage' | 'bubbles';
    roleFilter: string | null;
    /** Role picked for the next new session (New Session screen / Launchpad / TopBar sheet before a session exists). */
    draftRole: string | null;
    pendingMode: { sessionId: string; modeId: string; at: number } | null;
    composerInsert: { text: string; n: number } | null;
    /** Active text quote attached to the composer reply bar. */
    composerQuote: ComposerQuote | null;
    /** Session whose pinned notes (`notes.md`) sheet is open, or null. */
    sessionNotesId: string | null;
  };
  toasts: Toast[];
}

export const DEFAULT_SETTINGS: Settings = {
  language: 'system',
  theme: 'system',
  fontSize: 'standard',
  allChannels: false,
  ttsEngine: 'native',
  defaultModel: { llm: 'gemini', model_name: 'gemini-4-neon', thinking_level: 'low', stream: true },
  translatorModel: 'gemini-4-neon',
  translatorNativeLang: 'zh-CN',
  translatorForeignLangs: ['ja', 'en', 'ko'],
};

export function initialState(): KesokuState {
  return {
    conn: { status: 'idle', engineOnline: false, latencyMs: null, deviceId: null },
    auth: 'unknown',
    authKind: null,
    email: null,
    sessions: {},
    currentSessionId: null,
    items: {},
    previews: {},
    finalized: new Set(),
    turnEvents: {},
    lastSeq: {},
    headSeq: {},
    stateFiles: {},
    modePrefs: {},
    modeDefaults: {},
    characters: [],
    llmOverride: {},
    origin: {},
    takenOver: {},
    hasMoreHistory: {},
    policies: { policies: { ...DEFAULT_MEMORY_POLICIES }, defaults: { ...DEFAULT_MEMORY_POLICIES }, updated_at: 0 },
    personas: [],
    profile: null,
    proposals: {},
    media: {},
    avatarJobs: {},
    searchHits: [],
    settings: { ...DEFAULT_SETTINGS },
    ui: { drawerOpen: false, launchpad: true, inspector: null, screen: 'chat', toolReturnScreen: 'chat', stageView: 'stage', roleFilter: null, draftRole: null, pendingMode: null, composerInsert: null, composerQuote: null, sessionNotesId: null },
    toasts: [],
  };
}

export const useStore = create<KesokuState>(() => initialState());

// ───────────────────────── pure helpers ─────────────────────────

const ATTACHMENT_LISTING_RE = /\n*\s*Attachments:\n(?:\[Attachment: [^\n]*\]\n?)+\s*$/;
const ATTACHMENT_LINE_RE = /^\[Attachment: (.*?) \(([^()\s]*)\) saved at (.+?)(?: — [^\n]*)?\]$/gm;

/**
 * Split the engine-injected `Attachments:\n[Attachment: f (mime) saved at /path …]` listing off a user message
 * (older engines / cross-channel rows put it in `text`), returning the clean text and the attachments it named.
 */
export function splitAttachmentListing(text: string | undefined): { text: string | undefined; attachments: Attachment[] } {
  if (!text) return { text, attachments: [] };
  const m = ATTACHMENT_LISTING_RE.exec(text);
  if (!m) return { text, attachments: [] };
  const attachments: Attachment[] = [];
  for (const l of m[0].matchAll(ATTACHMENT_LINE_RE)) {
    attachments.push({ object: '', mime: l[2] || 'application/octet-stream', filename: l[1], bytes: 0, ref: l[3].trim() });
  }
  return { text: text.slice(0, m.index), attachments };
}

export function recordToItem(m: MessageRecord): ChatItem {
  const kind = m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'system';
  let text = m.text;
  let attachments = m.attachments;
  if (kind === 'user') {
    const split = splitAttachmentListing(text);
    text = split.text;
    if (!attachments?.length && split.attachments.length) attachments = split.attachments;
  }
  return {
    key: m.message_id,
    kind,
    message_id: m.message_id,
    turn_id: m.turn_id,
    client_msg_id: m.client_msg_id,
    text,
    segments: m.segments,
    raw_markdown: m.raw_markdown,
    ts: m.ts,
    seq: m.seq,
    attachments,
    status: kind === 'user' ? 'sent' : undefined,
    sender: m.sender as ChatItem['sender'],
  };
}

function sortItems(items: ChatItem[]): ChatItem[] {
  return [...items].sort((a, b) => a.ts - b.ts || (a.seq ?? 0) - (b.seq ?? 0));
}

/** Insert or replace by key (and by client_msg_id for optimistic user rows). */
export function upsertItem(list: ChatItem[] | undefined, item: ChatItem): ChatItem[] {
  const out = [...(list ?? [])];
  let idx = out.findIndex((x) => x.key === item.key || (item.message_id && x.message_id === item.message_id));
  if (idx < 0 && item.client_msg_id) idx = out.findIndex((x) => x.client_msg_id === item.client_msg_id);
  if (idx >= 0) {
    out[idx] = { ...out[idx], ...item, events: item.events ?? out[idx].events, picked: out[idx].picked ?? item.picked };
    return out;
  }
  out.push(item);
  return out.length > 1 && out[out.length - 2].ts > item.ts ? sortItems(out) : out;
}

/** An empty (typing-only) preview for `turnId`. */
export function typingPreview(turnId: string, startedAt = Date.now()): StreamPreview {
  return { turn_id: turnId, round_id: 0, text: '', thought: '', startedAt };
}

// ───────────────────────── actions ─────────────────────────

const set = useStore.setState;
const get = useStore.getState;
let toastSeq = 0;

export const actions = {
  reset() {
    set(initialState());
    setUiLanguage(DEFAULT_SETTINGS.language);
  },
  toast(text: string, tone: Toast['tone'] = 'info') {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, text, tone }].slice(-3) }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3200);
  },
  setConn(patch: Partial<KesokuState['conn']>) {
    set((s) => ({ conn: { ...s.conn, ...patch } }));
  },
  setUi(patch: Partial<KesokuState['ui']>) {
    set((s) => ({ ui: { ...s.ui, ...patch } }));
  },
  /** Mirror the session's pinned notes into `stateFiles[sid]['notes.md']` (blank content removes the entry). */
  setSessionNotes(sessionId: string, content: string) {
    set((s) => {
      const files = { ...(s.stateFiles[sessionId] ?? {}) };
      if (content.trim()) files['notes.md'] = content;
      else delete files['notes.md'];
      return { stateFiles: { ...s.stateFiles, [sessionId]: files } };
    });
  },
  setSettings(patch: Partial<Settings>) {
    set((s) => ({ settings: { ...s.settings, ...patch } }));
    if (patch.language !== undefined) setUiLanguage(patch.language);
  },
  setSessions(list: SessionSummary[], replace = false) {
    set((s) => {
      const sessions = replace ? {} : { ...s.sessions };
      for (const x of list) sessions[x.session_id] = { ...sessions[x.session_id], ...x };
      return { sessions };
    });
  },
  removeSession(id: string) {
    set((s) => {
      const sessions = { ...s.sessions };
      delete sessions[id];
      return { sessions, currentSessionId: s.currentSessionId === id ? null : s.currentSessionId };
    });
  },
  applySnapshot(p: EngineToClientPayload<'session.snapshot'>) {
    const sid = p.session.session_id;
    set((s) => {
      const finalized = new Set(s.finalized);
      const items = p.last_messages.map(recordToItem);
      for (const it of items) if (it.turn_id && it.kind === 'assistant') finalized.add(it.turn_id);
      // Keep optimistic unsent rows.
      const pendingLocal = (s.items[sid] ?? []).filter((x) => x.status === 'sending' || x.status === 'failed');
      const proposals = { ...s.proposals };
      for (const pr of p.pending_proposals ?? []) proposals[pr.proposal_id] = pr;
      const nestedPrefs = (p as { prefs?: { mode_prefs?: Record<string, unknown>; llm_override?: LlmOverride | null } }).prefs;
      const latestMsgTs = items.reduce((m, it) => (Number.isFinite(it.ts) && it.ts > m ? it.ts : m), 0);
      const nextUpdatedAt = Math.max(s.sessions[sid]?.updated_at ?? 0, p.session.updated_at ?? 0, latestMsgTs);
      return {
        sessions: { ...s.sessions, [sid]: { ...s.sessions[sid], ...p.session, updated_at: nextUpdatedAt } },
        items: { ...s.items, [sid]: sortItems([...items, ...pendingLocal]) },
        stateFiles: { ...s.stateFiles, [sid]: { ...(p.state_files ?? {}) } },
        modePrefs: { ...s.modePrefs, [sid]: { ...(p.mode_prefs ?? nestedPrefs?.mode_prefs ?? {}) } },
        llmOverride: { ...s.llmOverride, [sid]: p.llm_override ?? nestedPrefs?.llm_override ?? null },
        origin: { ...s.origin, [sid]: p.origin_channel ?? p.session.chatbot_id ?? 'app' },
        takenOver: { ...s.takenOver, [sid]: !!p.session.app_bound },
        lastSeq: { ...s.lastSeq, [sid]: Math.max(p.head_seq, 0) },
        headSeq: { ...s.headSeq, [sid]: p.head_seq },
        previews: { ...s.previews, [sid]: fromActiveTurn(p.active_turn, finalized) },
        hasMoreHistory: { ...s.hasMoreHistory, [sid]: p.last_messages.length >= 50 },
        finalized,
        proposals,
      };
    });
  },
  prependHistory(sid: string, records: MessageRecord[], hasMore: boolean) {
    set((s) => {
      let list = s.items[sid] ?? [];
      for (const r of records) list = upsertItem(list, recordToItem(r));
      return { items: { ...s.items, [sid]: sortItems(list) }, hasMoreHistory: { ...s.hasMoreHistory, [sid]: hasMore } };
    });
  },
  addLocalUser(sid: string, item: ChatItem) {
    set((s) => {
      const pv = s.previews[sid];
      // Discord-style typing indicator with 0 ms latency: show it before the engine acks / streams.
      const typing = pv && !pv.interrupted ? pv : typingPreview(item.client_msg_id || item.key);
      const existing = s.sessions[sid];
      const nextSessions =
        existing && Number.isFinite(item.ts) && item.ts > (existing.updated_at ?? 0)
          ? { ...s.sessions, [sid]: { ...existing, updated_at: item.ts } }
          : undefined;
      return {
        ...(nextSessions ? { sessions: nextSessions } : {}),
        items: { ...s.items, [sid]: upsertItem(s.items[sid], item) },
        previews: { ...s.previews, [sid]: typing },
      };
    });
  },
  markUser(sid: string, clientMsgId: string, patch: Partial<ChatItem>) {
    set((s) => {
      const out: Partial<KesokuState> = {
        items: { ...s.items, [sid]: (s.items[sid] ?? []).map((x) => (x.client_msg_id === clientMsgId ? { ...x, ...patch } : x)) },
      };
      const pv = s.previews[sid];
      if (pv && pv.turn_id === clientMsgId) {
        if (patch.status === 'failed') out.previews = { ...s.previews, [sid]: undefined };
        else if (patch.message_id) out.previews = { ...s.previews, [sid]: { ...pv, turn_id: patch.message_id } };
      }
      return out;
    });
  },
  /** Optimistically show the typing indicator (no-op while a live preview is running). Returns the preview's turn id. */
  startTyping(sid: string, turnId?: string): string {
    const pv = get().previews[sid];
    if (pv && !pv.interrupted) return pv.turn_id;
    const typing = typingPreview(turnId ?? `typing:${Date.now().toString(36)}`);
    set((s) => ({ previews: { ...s.previews, [sid]: typing } }));
    return typing.turn_id;
  },
  /** Drop the typing indicator (only the one for `turnId` when given; otherwise only a still-empty one). */
  clearTyping(sid: string, turnId?: string) {
    set((s) => {
      const pv = s.previews[sid];
      if (!pv) return {};
      if (turnId ? pv.turn_id !== turnId : pv.text.trim() !== '') return {};
      return { previews: { ...s.previews, [sid]: undefined } };
    });
  },
  markPicked(sid: string, messageId: string, choices: string[]) {
    set((s) => ({ items: { ...s.items, [sid]: (s.items[sid] ?? []).map((x) => (x.message_id === messageId ? { ...x, picked: choices } : x)) } }));
  },
  /** Apply one seq'd / non-seq'd engine event for a session (gap handling is done by the controller). */
  applySessionEvent(sid: string, type: string, payload: Record<string, unknown>, seq?: number) {
    set((s) => {
      const patch: Partial<KesokuState> = {};
      if (seq !== undefined) {
        patch.lastSeq = { ...s.lastSeq, [sid]: Math.max(s.lastSeq[sid] ?? 0, seq) };
        patch.headSeq = { ...s.headSeq, [sid]: Math.max(s.headSeq[sid] ?? 0, seq) };
      }
      switch (type) {
        case 'message.user': {
          const p = payload as EngineToClientPayload<'message.user'>;
          const item: ChatItem = {
            key: p.message_id,
            kind: 'user',
            message_id: p.message_id,
            client_msg_id: p.client_msg_id,
            text: p.text,
            attachments: p.attachments,
            ts: p.ts,
            seq,
            status: 'sent',
            sender: p.sender as ChatItem['sender'],
          };
          patch.items = { ...s.items, [sid]: upsertItem(s.items[sid], item) };
          if (s.sessions[sid] && Number.isFinite(p.ts) && p.ts > (s.sessions[sid]!.updated_at ?? 0)) {
            patch.sessions = { ...s.sessions, [sid]: { ...s.sessions[sid]!, updated_at: p.ts } };
          }
          // The agent now works on this message: show its typing indicator (replacing an optimistic or interrupted one).
          const pv = s.previews[sid];
          if (!s.finalized.has(p.message_id) && pv?.turn_id !== p.message_id) {
            const keep = pv && !pv.interrupted && (pv.turn_id === p.client_msg_id || !pv.text);
            patch.previews = { ...s.previews, [sid]: typingPreview(p.message_id, keep ? pv.startedAt : undefined) };
          }
          break;
        }
        case 'turn.event': {
          const p = payload as TurnEvent;
          const evs = [...(s.turnEvents[p.turn_id] ?? [])];
          const i = evs.findIndex((e) => e.message_id && e.message_id === p.message_id && e.kind === p.kind);
          if (i >= 0) evs[i] = { ...evs[i], ...p };
          else evs.push({ ...p, ts: Date.now() });
          patch.turnEvents = { ...s.turnEvents, [p.turn_id]: evs };
          if (!s.finalized.has(p.turn_id) && !s.previews[sid]) patch.previews = { ...s.previews, [sid]: typingPreview(p.turn_id) };
          break;
        }
        case 'message.final': {
          const p = payload as EngineToClientPayload<'message.final'>;
          const finalized = new Set(s.finalized);
          finalized.add(p.turn_id);
          const item: ChatItem = {
            key: p.message_id,
            kind: 'assistant',
            message_id: p.message_id,
            turn_id: p.turn_id,
            segments: p.segments,
            raw_markdown: p.raw_markdown,
            ts: p.ts,
            seq,
            sender: p.sender as ChatItem['sender'],
          };
          patch.items = { ...s.items, [sid]: upsertItem(s.items[sid], item) };
          if (s.sessions[sid] && Number.isFinite(p.ts) && p.ts > (s.sessions[sid]!.updated_at ?? 0)) {
            patch.sessions = { ...s.sessions, [sid]: { ...s.sessions[sid]!, updated_at: p.ts } };
          }
          patch.finalized = finalized;
          // Any real reply ends the typing indicator, even when its turn_id differs from the preview's
          // (optimistic client_msg_id, or a self-healing retry finalizing under a new turn id).
          if (p.sender?.name !== 'Notification' && s.previews[sid]) patch.previews = { ...s.previews, [sid]: undefined };
          break;
        }
        case 'media.pending': {
          const p = payload as EngineToClientPayload<'media.pending'>;
          patch.media = { ...s.media, [p.placeholder_id]: { ...s.media[p.placeholder_id], status: 'pending', kind: p.kind, label: p.label } };
          break;
        }
        case 'media.ready': {
          const p = payload as EngineToClientPayload<'media.ready'>;
          const nowSec = Date.now() / 1000;
          const freshUrl = p.url && (!p.expires_at || p.expires_at < 1_000_000_000 || p.expires_at - 30 > nowSec) ? p.url : undefined;
          const entry: MediaEntry = { status: 'ready', url: freshUrl, object: p.object, mime: p.mime, kind: p.kind, expires_at: p.expires_at, duration_ms: p.duration_ms };
          const media = { ...s.media };
          if (p.placeholder_id) media[p.placeholder_id] = entry;
          if (p.object) media[`obj:${p.object}`] = entry;
          if (p.ref) media[`ref:${p.ref}`] = entry;
          patch.media = media;
          break;
        }
        case 'media.failed': {
          const p = payload as EngineToClientPayload<'media.failed'>;
          patch.media = { ...s.media, [p.placeholder_id]: { ...s.media[p.placeholder_id], status: 'failed', reason: p.reason } };
          break;
        }
        case 'state.sync': {
          const p = payload as EngineToClientPayload<'state.sync'>;
          const files = { ...(s.stateFiles[sid] ?? {}), ...p.files };
          for (const r of p.removed) delete files[r];
          patch.stateFiles = { ...s.stateFiles, [sid]: files };
          // Keep the session's mode_id (sidebar pill, TopBar fallback) in sync with game/games.json.
          if (s.sessions[sid] && (GAMES_FILE in p.files || p.removed.includes(GAMES_FILE))) {
            const modeId = detectActiveMode(files).modeId;
            if (s.sessions[sid]!.mode_id !== modeId) patch.sessions = { ...s.sessions, [sid]: { ...s.sessions[sid]!, mode_id: modeId } };
          }
          if (s.ui.pendingMode?.sessionId === sid) patch.ui = { ...s.ui, pendingMode: null };
          break;
        }
        case 'session.updated': {
          const p = payload as EngineToClientPayload<'session.updated'>;
          if (p.deleted) {
            const sessions = { ...s.sessions };
            delete sessions[sid];
            patch.sessions = sessions;
          } else {
            const prev = s.sessions[sid];
            const incomingTs = typeof p.updated_at === 'number' && Number.isFinite(p.updated_at) ? p.updated_at : undefined;
            const updatedAt = Math.max(prev?.updated_at ?? 0, incomingTs ?? 0) || Date.now() / 1000;
            patch.sessions = {
              ...s.sessions,
              [sid]: {
                ...(prev ?? { session_id: sid, title: '', role: 'default', chatbot_id: 'app' }),
                ...p,
                session_id: sid,
                updated_at: updatedAt,
              } as SessionSummary,
            };
          }
          break;
        }
        case 'memory.proposal': {
          const p = payload as MemoryProposal;
          patch.proposals = { ...s.proposals, [p.proposal_id]: { ...p, status: p.status ?? 'pending' } };
          break;
        }
        case 'memory.proposal.resolved': {
          const p = payload as EngineToClientPayload<'memory.proposal.resolved'>;
          const prev = s.proposals[p.proposal_id];
          if (prev) patch.proposals = { ...s.proposals, [p.proposal_id]: { ...prev, status: p.status, applied_files: p.applied_files } };
          break;
        }
      }
      return patch;
    });
  },
  /** One rAF batch of stream frames. Returns session ids that need a resync. */
  applyStreamBatch(frames: Array<{ sid: string; type: 'stream.delta' | 'stream.clear'; payload: Record<string, unknown> }>): string[] {
    const resync = new Set<string>();
    set((s) => {
      const previews = { ...s.previews };
      for (const f of frames) {
        if (f.type === 'stream.clear') {
          previews[f.sid] = applyClear(previews[f.sid], f.payload as { turn_id: string; round_id: number }, s.finalized);
        } else {
          const r = applyDelta(previews[f.sid], f.payload as unknown as DeltaPayload, s.finalized);
          previews[f.sid] = r.preview;
          if (r.needResync) resync.add(f.sid);
        }
      }
      return { previews };
    });
    return [...resync];
  },
  applySyncDone(p: EngineToClientPayload<'sync.done'>) {
    set((s) => {
      const patch: Partial<KesokuState> = {
        lastSeq: { ...s.lastSeq, [p.session_id]: Math.max(s.lastSeq[p.session_id] ?? 0, p.replayed_through_seq) },
        headSeq: { ...s.headSeq, [p.session_id]: p.head_seq },
      };
      if (p.active_turn !== undefined) {
        patch.previews = { ...s.previews, [p.session_id]: fromActiveTurn(p.active_turn, s.finalized) };
      }
      return patch;
    });
  },
  setPolicies(p: Partial<PolicyState>) {
    set((s) => ({ policies: { ...s.policies, ...p, policies: { ...s.policies.policies, ...(p.policies ?? {}) } } }));
  },
  setPolicyOptimistic(modeId: string, policy: MemoryPolicy) {
    set((s) => ({ policies: { ...s.policies, policies: { ...s.policies.policies, [modeId]: policy } } }));
  },
  setPersonas(roles: PersonaSummary[], deleted: string[] = [], replace = false) {
    set((s) => {
      const map = new Map((replace ? [] : s.personas).map((r) => [r.role_id, r]));
      for (const r of roles) map.set(r.role_id, { ...map.get(r.role_id), ...r });
      for (const d of deleted) map.delete(d);
      const updatedNames = new Map<string, string>();
      for (const r of roles) {
        if (r.display_name) updatedNames.set(r.role_id, r.display_name);
      }
      let itemsPatch: Record<string, ChatItem[]> | undefined;
      if (updatedNames.size > 0) {
        for (const [sid, list] of Object.entries(s.items)) {
          const sessionRole = s.sessions[sid]?.role ?? 'default';
          let changed = false;
          const nextList = list.map((it) => {
            if (it.kind !== 'assistant') return it;
            const rid = it.sender?.role_id ?? sessionRole;
            const newName = updatedNames.get(rid);
            if (!newName || it.sender?.display_name === newName) return it;
            changed = true;
            return { ...it, sender: { ...(it.sender ?? { name: rid }), role_id: rid, display_name: newName } };
          });
          if (changed) {
            if (!itemsPatch) itemsPatch = { ...s.items };
            itemsPatch[sid] = nextList;
          }
        }
      }
      return { personas: [...map.values()], ...(itemsPatch ? { items: itemsPatch } : {}) };
    });
  },
  setProfile(p: UserProfile) {
    set({ profile: p });
  },
  setProposals(list: MemoryProposal[]) {
    set((s) => {
      const proposals = { ...s.proposals };
      for (const p of list) proposals[p.proposal_id] = p;
      return { proposals };
    });
  },
  setModePrefs(sid: string, prefs: Record<string, unknown>) {
    set((s) => ({ modePrefs: { ...s.modePrefs, [sid]: { ...(s.modePrefs[sid] ?? {}), ...prefs } } }));
  },
  setModeDefaults(defaults: Record<string, Record<string, unknown>>, replace = false) {
    set((s) => {
      if (replace) return { modeDefaults: { ...defaults } };
      const next = { ...s.modeDefaults };
      for (const [modeId, prefs] of Object.entries(defaults)) {
        next[modeId] = { ...prefs };
      }
      return { modeDefaults: next };
    });
  },
  setModeDefaultPrefs(modeId: string, prefs: Record<string, unknown>) {
    set((s) => ({ modeDefaults: { ...s.modeDefaults, [modeId]: { ...prefs } } }));
  },
  setCharacters(characters: RegisteredCharacter[]) {
    set({ characters: [...characters] });
  },
  setRosterMember(sessionId: string, key: string, member: Record<string, unknown>) {
    set((s) => {
      const files = { ...(s.stateFiles[sessionId] ?? {}) };
      const rawRoster = files['game/roster.json'];
      const roster =
        rawRoster && typeof rawRoster === 'object' && !Array.isArray(rawRoster)
          ? { ...(rawRoster as Record<string, unknown>) }
          : {};
      const rawMembers = roster.members;
      const members =
        rawMembers && typeof rawMembers === 'object' && !Array.isArray(rawMembers)
          ? { ...(rawMembers as Record<string, unknown>) }
          : {};
      members[key] = member;
      roster.members = members;
      files['game/roster.json'] = roster;
      return { stateFiles: { ...s.stateFiles, [sessionId]: files } };
    });
  },
  setLlmOverride(sid: string, o: LlmOverride | null) {
    set((s) => ({ llmOverride: { ...s.llmOverride, [sid]: o } }));
  },
  setMedia(key: string, entry: MediaEntry) {
    set((s) => ({ media: { ...s.media, [key]: entry } }));
  },
  addAvatarJob(job: AvatarJob) {
    set((s) => ({ avatarJobs: { ...s.avatarJobs, [job.job_id]: job } }));
  },
};

export const selectCurrentItems = (s: KesokuState) => (s.currentSessionId ? s.items[s.currentSessionId] ?? EMPTY : EMPTY);
const EMPTY: ChatItem[] = [];
export function getState() {
  return get();
}

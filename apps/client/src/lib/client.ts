import {
  SEQ_EVENT_TYPES,
  newId,
  type ClientToEngineType,
  type EngineToClientPayload,
  type Envelope,
  type LlmOverride,
  type MemoryPolicy,
  type ModeId,
  type ProposalOp,
} from '@kesoku/protocol';
import { getUiLocale, t } from '@kesoku/ui';
import { getPlatform } from '../native/platform';
import { getDeviceToken, wsUrl } from './auth';
import { allCursors, db, kvSet, purgeSessionFromDb, reconcileSessionsInDb, saveMessages, setCursor } from './db';
import {
  buildMediaAliases,
  clearMediaCache,
  fetchAndCacheImage,
  getCachedImageUrl,
  invalidateCachedImage,
  isImageMedia,
  isLiveCachedBlobUrl,
  onMediaCacheClear,
  onMediaCacheRevoke,
} from './mediaCache';
import { createFrameBatcher } from '../features/stream/previewBuffer';
import { KesokuSocket, RpcError, type SocketStatus } from './ws';
import { actions, getState, useStore } from './store';
import type { ChatItem } from './types';
import type { MediaRef, ResolveMediaOptions } from '../features/cards/types';
import { translatorStartPrefs } from './translatorPrefs';
import { fallbackRoleId } from '../features/persona/model';
import { workoutSync } from '../features/workout/sync';

const SEQ_TYPES = new Set<string>(SEQ_EVENT_TYPES);
export const APP_VERSION = '0.1.34';

type Payload = Record<string, unknown>;

/** Session ids with a known cursor get strict gap detection. */
const tracked = new Set<string>();
const resyncing = new Set<string>();
const gapBuffer = new Map<string, Envelope[]>();
let socket: KesokuSocket | null = null;
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

const streamBatcher = createFrameBatcher<{ sid: string; type: 'stream.delta' | 'stream.clear'; payload: Payload }>((frames) => {
  const need = actions.applyStreamBatch(frames);
  for (const sid of need) requestResync(sid);
});

// Strip revoked `blob:` URLs from the Zustand media table whenever the persistent image cache clears or evicts/revokes a blob URL.
onMediaCacheClear(() => {
  const cur = getState().media;
  let changed = false;
  const next: typeof cur = {};
  for (const [k, entry] of Object.entries(cur)) {
    if (entry?.url?.startsWith('blob:')) {
      changed = true;
      next[k] = { ...entry, url: undefined };
    } else {
      next[k] = entry;
    }
  }
  if (changed) useStore.setState({ media: next });
});

onMediaCacheRevoke((revokedUrl) => {
  const cur = getState().media;
  let changed = false;
  const next: typeof cur = {};
  for (const [k, entry] of Object.entries(cur)) {
    if (entry?.url === revokedUrl) {
      changed = true;
      next[k] = { ...entry, url: undefined };
    } else {
      next[k] = entry;
    }
  }
  if (changed) useStore.setState({ media: next });
});

function schedulePersist(sid: string) {
  const t = persistTimers.get(sid);
  if (t) clearTimeout(t);
  persistTimers.set(
    sid,
    setTimeout(() => {
      persistTimers.delete(sid);
      const s = getState();
      const items = s.items[sid];
      if (items) void saveMessages(sid, items).catch(() => {});
      const seq = s.lastSeq[sid];
      if (seq !== undefined) void setCursor(sid, seq).catch(() => {});
      const sess = s.sessions[sid];
      if (sess) void db.sessions.put({ session_id: sid, data: sess, updated_at: sess.updated_at }).catch(() => {});
    }, 400),
  );
}

function requestResync(sid: string) {
  if (resyncing.has(sid) || !socket) return;
  resyncing.add(sid);
  const last = getState().lastSeq[sid] ?? 0;
  socket.send('sync.resume', { sessions: [{ session_id: sid, last_seq: last }] });
}

function flushGapBuffer(sid: string) {
  const buf = gapBuffer.get(sid);
  if (!buf?.length) return;
  gapBuffer.delete(sid);
  buf.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  for (const env of buf) handleSeqEvent(env);
}

function handleSeqEvent(env: Envelope) {
  const sid = env.session_id!;
  const seq = env.seq!;
  const last = getState().lastSeq[sid];
  if (tracked.has(sid) && last !== undefined) {
    if (seq <= last) return; // duplicate (idempotent)
    if (seq > last + 1 && !env.device_id) {
      // Gap: hold and resume.
      const buf = gapBuffer.get(sid) ?? [];
      if (!buf.some((e) => e.id === env.id)) buf.push(env);
      gapBuffer.set(sid, buf);
      requestResync(sid);
      return;
    }
    if (seq > last + 1 && env.device_id) {
      // Replay frames arrive in order for us; accept.
    }
  }
  actions.applySessionEvent(sid, env.type, env.payload, seq);
  schedulePersist(sid);
}

function onEnvelope(env: Envelope) {
  const p = env.payload;
  if (env.session_id && env.seq !== undefined && SEQ_TYPES.has(env.type)) {
    handleSeqEvent(env);
    return;
  }
  switch (env.type) {
    case 'stream.delta':
    case 'stream.clear':
      if (env.session_id) streamBatcher.push({ sid: env.session_id, type: env.type, payload: p });
      return;
    case 'sync.done': {
      const d = p as EngineToClientPayload<'sync.done'>;
      actions.applySyncDone(d);
      tracked.add(d.session_id);
      schedulePersist(d.session_id);
      if (d.has_more && d.replayed_through_seq < d.head_seq) {
        socket?.send('sync.resume', { sessions: [{ session_id: d.session_id, last_seq: d.replayed_through_seq }] });
      } else {
        resyncing.delete(d.session_id);
        flushGapBuffer(d.session_id);
      }
      return;
    }
    case 'sync.reset': {
      const r = p as EngineToClientPayload<'sync.reset'>;
      resyncing.delete(r.session_id);
      gapBuffer.delete(r.session_id);
      void kesoku.openSession(r.session_id, { force: true });
      return;
    }
    case 'session.updated':
      // Non-seq'd variant (should not happen, but be lenient).
      if (env.session_id) actions.applySessionEvent(env.session_id, env.type, p);
      return;
    case 'session.deleted': {
      const sid = (p as { session_id?: string })?.session_id ?? env.session_id;
      if (sid) {
        const wasCurrent = getState().currentSessionId === sid;
        actions.removeSession(sid);
        if (wasCurrent) actions.setUi({ launchpad: true });
        void purgeSessionFromDb(sid).catch(() => {});
      }
      return;
    }
    case 'memory.policy.updated': {
      const u = p as EngineToClientPayload<'memory.policy.updated'>;
      actions.setPolicies({ policies: u.policies, updated_at: u.updated_at });
      return;
    }
    case 'persona.updated': {
      const u = p as EngineToClientPayload<'persona.updated'>;
      actions.setPersonas(u.roles, u.deleted ?? []);
      return;
    }
    case 'user_profile.updated':
      actions.setProfile(p as EngineToClientPayload<'user_profile.updated'>);
      return;
    case 'media.ready':
    case 'media.failed':
    case 'media.pending':
      // Non-seq'd (e.g. avatar candidates, hydrate replies, voice previews).
      actions.applySessionEvent(env.session_id ?? '_', env.type, p);
      return;
    case 'engine.status': {
      const e = p as EngineToClientPayload<'engine.status'>;
      actions.setConn({ engineOnline: e.online, engineSince: e.since, latencyMs: e.latency_ms ?? getState().conn.latencyMs });
      if (e.online) void workoutSync.onEngineOnline();
      return;
    }
    case 'error': {
      if (!env.reply_to) {
        const e = p as { code?: string; message?: string };
        if (e.code === 'ENGINE_OFFLINE') actions.toast(t('client.engineOfflineRetry'), 'error');
        else actions.toast(`⚠️ ${e.message || e.code || t('client.errorFallback')}`, 'error');
      }
      return;
    }
  }
}

function onStatus(status: SocketStatus, info?: { retryInMs?: number; deviceId?: string; engineOnline?: boolean; latencyMs?: number }) {
  const patch: Parameters<typeof actions.setConn>[0] = { status };
  if (info?.retryInMs !== undefined) patch.retryInMs = info.retryInMs;
  if (info?.deviceId) patch.deviceId = info.deviceId;
  if (info?.engineOnline !== undefined) patch.engineOnline = info.engineOnline;
  if (info?.latencyMs !== undefined) patch.latencyMs = info.latencyMs;
  actions.setConn(patch);
  if (status === 'unauthorized') {
    // Rejected / revoked / forbidden session (e.g. an older Web pairing session once Google Sign-In is
    // required): drop the local marker so the next boot shows the sign-in screen instead of retrying.
    useStore.setState({ auth: 'needed', authKind: null, email: null });
    void db.kv.delete('auth').catch(() => {});
    void clearMediaCache().catch(() => {});
  }
  if (status === 'online' && info?.deviceId) {
    useStore.setState({ auth: 'ok' });
    void afterConnect();
  }
}

async function afterConnect() {
  resyncing.clear();
  const s = getState();
  // Resume current + 10 most recent sessions.
  const cursors = await allCursors().catch(() => []);
  const known = new Map(cursors.map((c) => [c.session_id, c.last_seq]));
  for (const [sid, seq] of Object.entries(s.lastSeq)) known.set(sid, Math.max(seq, known.get(sid) ?? 0));
  const recent = Object.values(s.sessions)
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, 10)
    .map((x) => x.session_id);
  const ids = new Set<string>([...(s.currentSessionId ? [s.currentSessionId] : []), ...recent].filter((id) => known.has(id)));
  const sessions = [...ids].map((id) => ({ session_id: id, last_seq: known.get(id) ?? 0 }));
  for (const x of sessions) {
    tracked.add(x.session_id);
    resyncing.add(x.session_id);
    useStore.setState((st) => ({ lastSeq: { ...st.lastSeq, [x.session_id]: Math.max(st.lastSeq[x.session_id] ?? 0, x.last_seq) } }));
  }
  if (sessions.length) socket?.send('sync.resume', { sessions });
  // sync.resume only replays events: the restored (IndexedDB) current session has no state_files /
  // mode_prefs / llm_override yet, so fetch its snapshot or the TopBar falls back to 日常聊天.
  const cur = getState().currentSessionId;
  if (cur && !hasSessionState(cur)) void kesoku.openSession(cur, { force: true, keepUi: true }).catch(() => {});
  void kesoku.refreshAll();
  if (getState().conn.engineOnline) void workoutSync.onEngineOnline();
}

/** True when a session's state files (incl. `game/games.json` for non-chat modes) have been hydrated. */
function hasSessionState(sessionId: string): boolean {
  const st = getState();
  const sf = st.stateFiles[sessionId];
  const mode = st.sessions[sessionId]?.mode_id;
  return sf !== undefined && (!mode || mode === 'chat' || 'game/games.json' in sf);
}

/** Role used when a new session is created: explicit → user-picked draft → role filter → first persona. */
function resolveDraftRole(explicit?: string | null): string {
  const st = getState();
  return explicit ?? st.ui.draftRole ?? st.ui.roleFilter ?? fallbackRoleId(st.personas);
}

export const kesoku = {
  async start(): Promise<void> {
    if (socket) return;
    const url = await wsUrl();
    socket = new KesokuSocket({
      url,
      getToken: getDeviceToken,
      client: { platform: getPlatform(), version: APP_VERSION, locale: getUiLocale() },
      onEnvelope,
      onStatus,
    });
    socket.start();
  },
  stop(): void {
    socket?.stop();
    socket = null;
  },
  suspend(): void {
    socket?.suspend();
  },
  resume(): void {
    socket?.resume();
  },
  get socket(): KesokuSocket | null {
    return socket;
  },

  async rpc<T = Payload>(type: ClientToEngineType, payload: Payload, opts: { session_id?: string; timeoutMs?: number; noQueue?: boolean } = {}): Promise<T> {
    if (!socket) throw new RpcError('OFFLINE', t('client.notConnected'));
    const env = await socket.rpc(type, payload, opts);
    return env.payload as T;
  },

  async refreshAll(): Promise<void> {
    const results = await Promise.allSettled([
      kesoku.listSessions(),
      kesoku.rpc<EngineToClientPayload<'memory.policy.list.result'>>('memory.policy.list', {}),
      kesoku.rpc<EngineToClientPayload<'persona.list.result'>>('persona.list', {}),
      kesoku.rpc<EngineToClientPayload<'user_profile.get.result'>>('user_profile.get', {}),
      kesoku.rpc<EngineToClientPayload<'memory.proposal.list.result'>>('memory.proposal.list', { status: 'pending', limit: 50 }),
    ]);
    const [, pol, per, prof, props] = results;
    if (pol.status === 'fulfilled') actions.setPolicies(pol.value);
    if (per.status === 'fulfilled') actions.setPersonas(per.value.roles, [], true);
    if (prof.status === 'fulfilled') actions.setProfile(prof.value);
    if (props.status === 'fulfilled') actions.setProposals(props.value.proposals);
  },

  async listSessions(): Promise<void> {
    const s = getState();
    const roleFilter = s.ui.roleFilter;
    const res = await kesoku.rpc<EngineToClientPayload<'session.list.result'>>('session.list', {
      all_channels: s.settings.allChannels,
      role: roleFilter ?? undefined,
      limit: 50,
    });
    actions.setSessions(res.sessions, true);
    const nextSessions = getState().sessions;
    void reconcileSessionsInDb(nextSessions, roleFilter).catch(() => {});
    const cur = getState().currentSessionId;
    if (cur && !roleFilter && !nextSessions[cur]) {
      useStore.setState({ currentSessionId: null });
      actions.setUi({ launchpad: true });
      void kvSet('last_session', null).catch(() => {});
    }
  },

  async search(q: string) {
    const s = getState();
    const res = await kesoku.rpc<EngineToClientPayload<'session.search.result'>>('session.search', {
      q,
      role: s.ui.roleFilter ?? undefined,
      all_channels: s.settings.allChannels,
      limit: 20,
    });
    useStore.setState({ searchHits: res.hits });
    return res.hits;
  },

  async openSession(sessionId: string, opts: { force?: boolean; keepUi?: boolean } = {}): Promise<void> {
    if (!opts.keepUi) {
      // An existing session carries its own role: drop any New Session draft pick.
      actions.setUi({ launchpad: false, screen: 'chat', drawerOpen: false, draftRole: null });
      useStore.setState({ currentSessionId: sessionId });
      void kvSet('last_session', sessionId);
    }
    // Skip session.open only when messages AND state files (game/games.json for modes) are already loaded.
    if (!opts.force && getState().items[sessionId]?.length && hasSessionState(sessionId) && tracked.has(sessionId)) return;
    const snap = await kesoku.rpc<EngineToClientPayload<'session.snapshot'>>('session.open', { session_id: sessionId });
    actions.applySnapshot(snap);
    tracked.add(sessionId);
    schedulePersist(sessionId);
  },

  async createSession(opts: { role?: string; mode?: ModeId; title?: string } = {}): Promise<string> {
    const tPrefs = opts.mode === 'translator' ? translatorStartPrefs(getState().settings) : null;
    const req: Payload = { ...opts, role: resolveDraftRole(opts.role), mode: opts.mode ?? 'chat' };
    if (opts.title === undefined) delete req.title;
    if (tPrefs) req.prefs = tPrefs;
    const snap = await kesoku.rpc<EngineToClientPayload<'session.snapshot'>>('session.create', req);
    actions.applySnapshot(snap);
    const sid = snap.session.session_id;
    tracked.add(sid);
    // 翻译模式：母语 + 常用外语 (also persisted as session mode prefs so the HUD and the engine agree).
    if (tPrefs) void kesoku.setModePrefs(sid, tPrefs);
    if (opts.mode && opts.mode !== 'chat') {
      useStore.setState((st) => ({
        sessions: st.sessions[sid] ? { ...st.sessions, [sid]: { ...st.sessions[sid]!, mode_id: opts.mode! } } : st.sessions,
      }));
    }
    useStore.setState({ currentSessionId: sid });
    actions.setUi({
      launchpad: !opts.mode,
      screen: 'chat',
      drawerOpen: false,
      draftRole: null,
      pendingMode: null,
      stageView: opts.mode === 'galgame' ? 'stage' : getState().ui.stageView,
    });
    return sid;
  },

  /** Ensure a session exists (Launchpad direct typing creates one lazily). */
  async ensureSession(): Promise<string> {
    const cur = getState().currentSessionId;
    if (cur) return cur;
    return kesoku.createSession({});
  },

  async loadOlder(sessionId: string): Promise<void> {
    const items = getState().items[sessionId] ?? [];
    const before = items[0]?.ts ?? Date.now() / 1000;
    const res = await kesoku.rpc<EngineToClientPayload<'history.page.result'>>('history.page', { session_id: sessionId, before_ts: before, limit: 50 });
    actions.prependHistory(sessionId, res.messages, res.has_more);
  },

  async sendMessage(sessionId: string, text: string, attachments: Array<{ object: string; mime: string; filename: string; bytes: number }> = []): Promise<void> {
    const client_msg_id = newId('cm');
    const s = getState();
    const item: ChatItem = {
      key: `c:${client_msg_id}`,
      kind: 'user',
      client_msg_id,
      text,
      attachments,
      ts: Date.now() / 1000,
      status: 'sending',
    };
    actions.addLocalUser(sessionId, item);
    actions.setUi({ launchpad: false });
    const override = s.llmOverride[sessionId] ?? undefined;
    try {
      const ack = await kesoku.rpc<EngineToClientPayload<'message.ack'>>(
        'message.send',
        { client_msg_id, session_id: sessionId, text, attachments, ...(override ? { llm_override: override } : {}) },
        { session_id: sessionId, timeoutMs: 30_000 },
      );
      actions.markUser(sessionId, client_msg_id, { status: 'sent', message_id: ack.message_id });
      if (getState().origin[sessionId] && getState().origin[sessionId] !== 'app') {
        useStore.setState((st) => ({ takenOver: { ...st.takenOver, [sessionId]: true } }));
      }
    } catch (e) {
      actions.markUser(sessionId, client_msg_id, { status: 'failed' });
      const code = e instanceof RpcError ? e.code : '';
      if (code === 'TURN_BUSY') actions.toast(t('client.turnBusy'), 'error');
      else if (code === 'ENGINE_OFFLINE') actions.toast(t('client.engineOfflineNotSent'), 'error');
      else actions.toast(t('client.sendFailed'), 'error');
    }
  },

  async retry(sessionId: string, item: ChatItem): Promise<void> {
    useStore.setState((st) => ({ items: { ...st.items, [sessionId]: (st.items[sessionId] ?? []).filter((x) => x.key !== item.key) } }));
    await kesoku.sendMessage(sessionId, item.text ?? '', (item.attachments ?? []) as never);
  },

  async pick(sessionId: string, questionMessageId: string, choices: string[]): Promise<void> {
    const text = choices.length === 1 ? choices[0].trim() : t('client.pickPrefix') + choices.map((c) => c.trim()).join(t('client.pickSep'));
    const client_msg_id = newId('cm');
    actions.markPicked(sessionId, questionMessageId, choices);
    // One optimistic user bubble (also starts the 0 ms typing preview keyed by client_msg_id);
    // the engine's message.user carries the same client_msg_id and updates it in place.
    actions.addLocalUser(sessionId, { key: `c:${client_msg_id}`, kind: 'user', client_msg_id, text, ts: Date.now() / 1000, status: 'sending' });
    try {
      const ack = await kesoku.rpc<EngineToClientPayload<'message.ack'>>(
        'ui.pick',
        { session_id: sessionId, question_message_id: questionMessageId, choices, client_msg_id },
        { session_id: sessionId },
      );
      actions.markUser(sessionId, client_msg_id, { status: 'sent', ...(ack?.message_id ? { message_id: ack.message_id } : {}) });
    } catch {
      useStore.setState((st) => ({ items: { ...st.items, [sessionId]: (st.items[sessionId] ?? []).filter((x) => x.client_msg_id !== client_msg_id) } }));
      actions.markPicked(sessionId, questionMessageId, []);
      actions.clearTyping(sessionId, client_msg_id);
      actions.toast(t('client.pickFailed'), 'error');
    }
  },

  async stopTurn(sessionId: string) {
    // Stop typing right away: keep partial text marked 已打断, drop an empty typing indicator.
    useStore.setState((st) => {
      const pv = st.previews[sessionId];
      if (!pv) return {};
      return { previews: { ...st.previews, [sessionId]: pv.text.trim() ? { ...pv, interrupted: true } : undefined } };
    });
    await kesoku.rpc('turn.stop', { session_id: sessionId }).catch(() => {});
  },

  async startMode(modeId: ModeId, opts: { role?: string } = {}): Promise<void> {
    const sid = getState().currentSessionId;
    if (!sid) {
      await kesoku.createSession({ mode: modeId, role: resolveDraftRole(opts.role) });
      return;
    }
    // Existing session: a role picked on the Launchpad / TopBar applies before the mode launches.
    const wantRole = opts.role ?? getState().ui.draftRole;
    const curRole = getState().sessions[sid]?.role;
    if (wantRole && curRole && wantRole !== curRole) await kesoku.setRole(sid, wantRole).catch(() => actions.toast(t('topbar.switchRoleFailed'), 'error'));
    let tPrefs: Record<string, unknown> | null = null;
    if (modeId === 'translator') {
      const o: LlmOverride = { llm: 'gemini', model_name: getState().settings.translatorModel, thinking_level: 'low', stream: true };
      actions.setLlmOverride(sid, o);
      // native ⇄ first foreign language, stored before the launch prompt so the engine formats it with the user's languages.
      tPrefs = translatorStartPrefs(getState().settings);
      await kesoku.setModePrefs(sid, tPrefs);
    }
    const rawItems = getState().items[sid];
    const isEmpty = Array.isArray(rawItems) && rawItems.length === 0 && !getState().previews[sid];
    if (isEmpty) {
      useStore.setState((st) => ({
        sessions: st.sessions[sid] ? { ...st.sessions, [sid]: { ...st.sessions[sid]!, mode_id: modeId } } : st.sessions,
      }));
      actions.setUi({
        launchpad: false,
        pendingMode: null,
        stageView: modeId === 'galgame' ? 'stage' : 'bubbles',
      });
      await kesoku
        .rpc('mode.start', { session_id: sid, mode_id: modeId, defer: true, ...(tPrefs ? { prefs: tPrefs } : {}) }, { session_id: sid })
        .catch(() => actions.toast(t('client.modeSwitchFailed'), 'error'));
      return;
    }
    actions.setUi({ launchpad: false, pendingMode: { sessionId: sid, modeId, at: Date.now() } });
    const typing = actions.startTyping(sid);
    await kesoku.rpc('mode.start', { session_id: sid, mode_id: modeId, ...(tPrefs ? { prefs: tPrefs } : {}) }, { session_id: sid }).catch(() => {
      actions.clearTyping(sid, typing);
      actions.setUi({ pendingMode: null });
      actions.toast(t('client.modeStartFailed'), 'error');
    });
    watchPendingMode(sid, modeId);
  },

  async stopMode(sessionId: string): Promise<void> {
    const rawItems = getState().items[sessionId];
    const isEmpty = Array.isArray(rawItems) && rawItems.length === 0 && !getState().previews[sessionId];
    if (isEmpty) {
      useStore.setState((st) => ({
        sessions: st.sessions[sessionId] ? { ...st.sessions, [sessionId]: { ...st.sessions[sessionId]!, mode_id: 'chat' } } : st.sessions,
      }));
      actions.setUi({ pendingMode: null, stageView: 'bubbles' });
      await kesoku.rpc('mode.stop', { session_id: sessionId, defer: true }, { session_id: sessionId }).catch(() => actions.toast(t('client.modeStopFailed'), 'error'));
      return;
    }
    const typing = actions.startTyping(sessionId);
    await kesoku.rpc('mode.stop', { session_id: sessionId }, { session_id: sessionId }).catch(() => {
      actions.clearTyping(sessionId, typing);
      actions.toast(t('client.modeStopFailed'), 'error');
    });
  },

  async setModePrefs(sessionId: string, prefs: Payload): Promise<void> {
    actions.setModePrefs(sessionId, prefs);
    await kesoku.rpc('mode.prefs.set', { session_id: sessionId, prefs: getState().modePrefs[sessionId] ?? prefs }, { session_id: sessionId }).catch(() => {});
  },

  async setModel(sessionId: string | null, o: LlmOverride): Promise<void> {
    if (!sessionId) {
      actions.setSettings({ defaultModel: o });
      void kvSet('settings', getState().settings);
      return;
    }
    actions.setLlmOverride(sessionId, o);
    await kesoku.rpc('model.set', { session_id: sessionId, llm_override: o }, { session_id: sessionId }).catch(() => {});
  },

  async setRole(sessionId: string, role: string): Promise<void> {
    await kesoku.rpc('role.set', { session_id: sessionId, role }, { session_id: sessionId });
    useStore.setState((st) => ({ sessions: { ...st.sessions, [sessionId]: { ...st.sessions[sessionId], role } } }));
  },

  /** Optimistic rename: the row updates immediately, rolls back + toasts on RPC failure. Never throws. */
  async renameSession(sessionId: string, rawTitle: string): Promise<void> {
    const title = rawTitle.trim();
    if (!title) return;
    const prev = getState().sessions[sessionId]?.title;
    const setTitle = (t: string) =>
      useStore.setState((st) => ({ sessions: st.sessions[sessionId] ? { ...st.sessions, [sessionId]: { ...st.sessions[sessionId]!, title: t } } : st.sessions }));
    setTitle(title);
    try {
      await kesoku.rpc('session.rename', { session_id: sessionId, title });
      actions.toast(t('client.renamedSession'));
    } catch {
      if (prev !== undefined) setTitle(prev);
      actions.toast(t('client.renameSessionFailed'), 'error');
    }
  },

  /** Optimistic delete: the row disappears immediately, is restored + toasts on RPC failure. Never throws. */
  async deleteSession(sessionId: string): Promise<void> {
    const prev = getState().sessions[sessionId];
    const wasCurrent = getState().currentSessionId === sessionId;
    actions.removeSession(sessionId);
    if (wasCurrent) actions.setUi({ launchpad: true });
    void purgeSessionFromDb(sessionId).catch(() => {});
    try {
      await kesoku.rpc('session.delete', { session_id: sessionId });
      void purgeSessionFromDb(sessionId).catch(() => {});
      actions.toast(t('client.deletedSession'));
    } catch {
      if (prev) actions.setSessions([prev]);
      if (wasCurrent) {
        useStore.setState({ currentSessionId: sessionId });
        actions.setUi({ launchpad: false });
      }
      actions.toast(t('client.deleteSessionFailed'), 'error');
    }
  },

  // ── session pinned notes (`notes.md`, injected as <context name="notes"> every turn) ──
  /** Fetch the session's pinned notes and mirror them into `stateFiles[sid]['notes.md']`. */
  async getSessionNotes(sessionId: string): Promise<EngineToClientPayload<'session.notes.get.result'>> {
    const res = await kesoku.rpc<EngineToClientPayload<'session.notes.get.result'>>('session.notes.get', { session_id: sessionId });
    actions.setSessionNotes(sessionId, String(res?.content ?? ''));
    return res;
  },

  /** Overwrite the session's pinned notes (empty string clears them) and mirror the saved content locally. */
  async saveSessionNotes(sessionId: string, content: string): Promise<EngineToClientPayload<'session.notes.put.result'>> {
    const res = await kesoku.rpc<EngineToClientPayload<'session.notes.put.result'>>('session.notes.put', { session_id: sessionId, content });
    actions.setSessionNotes(sessionId, typeof res?.content === 'string' ? res.content : content);
    return res;
  },

  // ── memory policies (V1.2) ──
  async setPolicy(modeId: ModeId, policy: MemoryPolicy): Promise<void> {
    const prev = getState().policies.policies[modeId];
    actions.setPolicyOptimistic(modeId, policy);
    try {
      await kesoku.rpc('memory.policy.set', { mode_id: modeId, memory_policy: policy });
    } catch {
      if (prev) actions.setPolicyOptimistic(modeId, prev);
      actions.toast(t('policy.saveFailedRollback'), 'error');
    }
  },
  async resetPolicies(): Promise<void> {
    const { defaults, policies } = getState().policies;
    for (const [mode, pol] of Object.entries(defaults)) {
      if (policies[mode] !== pol) await kesoku.setPolicy(mode as ModeId, pol);
    }
  },

  // ── memory ──
  async resolveProposal(proposalId: string, action: 'confirm' | 'dismiss', editedOps?: ProposalOp[]): Promise<void> {
    const res = await kesoku.rpc<{ status?: string }>('memory.proposal.resolve', { proposal_id: proposalId, action, ...(editedOps ? { edited_ops: editedOps } : {}) });
    const status = (res.status as 'applied' | 'dismissed' | undefined) ?? (action === 'confirm' ? 'applied' : 'dismissed');
    useStore.setState((st) => {
      const p = st.proposals[proposalId];
      return p ? { proposals: { ...st.proposals, [proposalId]: { ...p, status } } } : {};
    });
  },

  // ── media ──
  async upload(file: Blob & { name?: string }, purpose: 'message' | 'avatar_source', sessionId?: string) {
    const filename = file.name || (purpose === 'avatar_source' ? 'avatar.jpg' : 'file');
    const mime = file.type || 'application/octet-stream';
    const ticket = await kesoku.rpc<EngineToClientPayload<'media.ticket.ok'>>('media.ticket', {
      purpose,
      mime,
      bytes: file.size,
      filename,
      ...(sessionId ? { session_id: sessionId } : {}),
    });
    const res = await fetch(ticket.put_url, { method: 'PUT', body: file, headers: { 'Content-Type': mime, ...(ticket.headers ?? {}) } });
    if (!res.ok) throw new Error(`upload failed (${res.status})`);
    return { object: ticket.object, mime, filename, bytes: file.size };
  },

  /** Resolve a media reference lazily (called on tap / when an image scrolls into view). */
  async resolveMedia(
    ref: MediaRef,
    ctx: { sessionId?: string; messageId?: string } & ResolveMediaOptions = {},
  ): Promise<string | null> {
    const now = Date.now() / 1000;
    const s = getState();
    const isImage =
      ctx.kind === 'audio'
        ? false
        : ctx.kind === 'image' ||
          ctx.avatarRev !== undefined ||
          isImageMedia({ mime: ctx.mime, object: ref.object, ref: ref.ref, url: ref.url });
    const baseAliases = isImage
      ? buildMediaAliases({ object: ref.object, ref: ref.ref, sessionId: ctx.sessionId, avatarRev: ctx.avatarRev })
      : [];

    if (ctx.forceRefresh) {
      if (baseAliases.length) await invalidateCachedImage(baseAliases);
      for (const k of [
        ref.placeholder_id,
        ref.object ? `obj:${ref.object}` : undefined,
        ref.ref ? `ref:${ref.ref}` : undefined,
      ]) {
        if (k && s.media[k]?.url) {
          actions.setMedia(k, { ...s.media[k], url: undefined });
        }
      }
    }

    const placeholderPending = !!(ref.placeholder_id && getState().media[ref.placeholder_id]?.status === 'pending');
    if (isImage && !ctx.forceRefresh && !placeholderPending && baseAliases.length > 0) {
      const cached = await getCachedImageUrl(baseAliases);
      if (cached) return cached;
    }

    const latest = getState();
    const fresh = (e?: { status: string; url?: string; expires_at?: number }) =>
      e &&
      e.status === 'ready' &&
      e.url &&
      (!e.url.startsWith('blob:') || isLiveCachedBlobUrl(e.url)) &&
      (!e.expires_at || e.expires_at - 30 > now);

    const cacheImageIfNeeded = async (
      url: string | null | undefined,
      extra: { object?: string; mime?: string; kind?: string } = {},
    ): Promise<string | null> => {
      if (!url) return null;
      const shouldCache =
        ctx.kind !== 'audio' &&
        (isImage ||
          extra.kind === 'image' ||
          isImageMedia({ mime: ctx.mime || extra.mime, object: ref.object || extra.object, ref: ref.ref, url }));
      if (!shouldCache) return url;
      const aliases = buildMediaAliases({
        object: ref.object || extra.object,
        ref: ref.ref,
        sessionId: ctx.sessionId,
        avatarRev: ctx.avatarRev,
      });
      if (!aliases.length) return url;
      return fetchAndCacheImage(url, aliases, { mime: ctx.mime || extra.mime });
    };

    if (ref.placeholder_id) {
      const e = latest.media[ref.placeholder_id];
      // A durable fallback (`object` / `ref`, e.g. `pkmn/0987.webp`) means we never park on a lost placeholder.
      const hasFallback = !!(ref.object || ref.ref);
      if (!ctx.forceRefresh && fresh(e)) {
        return cacheImageIfNeeded(e!.url!, { object: e?.object, mime: e?.mime, kind: e?.kind });
      }
      if (e?.object) return kesoku.resolveMedia({ object: e.object, ref: ref.ref }, ctx);
      if (e?.status === 'failed' && !hasFallback) return null;
      if (e?.status === 'pending') {
        // Still generating: wait (briefly when a fallback exists), then fall back to object / ref.
        const url = await waitForMedia(ref.placeholder_id, hasFallback ? 15_000 : 240_000);
        if (url) {
          const resolved = getState().media[ref.placeholder_id];
          return cacheImageIfNeeded(url, { object: resolved?.object, mime: resolved?.mime, kind: resolved?.kind });
        }
      } else if (!e && !hasFallback) {
        // Unknown placeholder (e.g. its media.ready has not arrived yet) and nothing else to try.
        const url = await waitForMedia(ref.placeholder_id, 240_000);
        if (url) {
          const resolved = getState().media[ref.placeholder_id];
          return cacheImageIfNeeded(url, { object: resolved?.object, mime: resolved?.mime, kind: resolved?.kind });
        }
      }
      // Unknown placeholder with a fallback (after reload / store reset): go straight to object / ref below.
    }
    if (ref.object) {
      const e = getState().media[`obj:${ref.object}`];
      if (!ctx.forceRefresh && fresh(e)) {
        return cacheImageIfNeeded(e!.url!, { object: ref.object, mime: e?.mime, kind: e?.kind });
      }
      try {
        const r = await kesoku.rpc<EngineToClientPayload<'media.refresh.ok'>>('media.refresh', { object: ref.object });
        const finalUrl = await cacheImageIfNeeded(r.url, { object: ref.object });
        actions.setMedia(`obj:${ref.object}`, {
          status: 'ready',
          url: finalUrl ?? r.url,
          object: ref.object,
          expires_at: finalUrl?.startsWith('blob:') ? undefined : r.expires_at,
        });
        return finalUrl ?? r.url;
      } catch {
        /* fall through to hydrate */
      }
    }
    if (ref.ref) {
      const key = `ref:${ref.ref}`;
      const e = getState().media[key];
      if (!ctx.forceRefresh && fresh(e)) {
        return cacheImageIfNeeded(e!.url!, { object: e?.object, mime: e?.mime, kind: e?.kind });
      }
      const r = await kesoku.rpc<EngineToClientPayload<'media.ready'>>(
        'media.hydrate',
        {
          ref: ref.ref,
          ...(ctx.sessionId ? { session_id: ctx.sessionId } : {}),
          ...(ctx.messageId ? { message_id: ctx.messageId } : {}),
        },
        { timeoutMs: 60_000 },
      );
      const finalUrl = await cacheImageIfNeeded(r.url, { object: r.object, mime: r.mime, kind: r.kind });
      actions.setMedia(key, {
        status: 'ready',
        url: finalUrl ?? r.url,
        object: r.object,
        expires_at: finalUrl?.startsWith('blob:') ? undefined : r.expires_at,
        mime: r.mime,
        duration_ms: r.duration_ms,
      });
      return finalUrl ?? null;
    }
    return cacheImageIfNeeded(ref.url);
  },
};

/**
 * Optimistic mode capsule rollback (UI doc Screen 01 §3): if no `state.sync` confirms the mode within 2.5 s
 * and the engine shows no turn activity, roll back. While the launch turn is running (preview / turn events),
 * keep waiting; roll back if that turn finalises without a confirming `state.sync` (2 s grace) or after 20 s.
 */
export function watchPendingMode(targetSid: string, modeId: string, now: () => number = Date.now): void {
  const startedAt = now();
  const startTs = startedAt / 1000;
  const tick = () => {
    const s = getState();
    const pm = s.ui.pendingMode;
    if (!pm || pm.sessionId !== targetSid || pm.modeId !== modeId) return; // confirmed or superseded
    const elapsed = now() - startedAt;
    const items = s.items[targetSid] ?? [];
    const finalAfter = items.find((i) => i.kind === 'assistant' && i.ts >= startTs);
    const streaming = !!s.previews[targetSid] && !s.previews[targetSid]?.interrupted;
    const active = streaming || items.some((i) => i.kind === 'user' && i.ts >= startTs - 1) || !!finalAfter;
    const finalGraceOver = finalAfter ? now() / 1000 - Math.max(finalAfter.ts, startTs) > 2 : false;
    if ((elapsed >= 2500 && !active) || finalGraceOver || (!streaming && elapsed >= 20_000) || elapsed >= 120_000) {
      actions.setUi({ pendingMode: null });
      actions.toast(t('client.modeRollback'));
      return;
    }
    setTimeout(tick, 500);
  };
  setTimeout(tick, 500);
}

function waitForMedia(placeholderId: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const check = () => {
      const e = getState().media[placeholderId];
      if (e?.status === 'ready' && e.url) return e.url;
      if (e?.status === 'failed') return null;
      return undefined;
    };
    const first = check();
    if (first !== undefined) return resolve(first);
    const timer = setTimeout(() => {
      unsub();
      resolve(null);
    }, timeoutMs);
    const unsub = useStore.subscribe(() => {
      const v = check();
      if (v !== undefined) {
        clearTimeout(timer);
        unsub();
        resolve(v);
      }
    });
  });
}

/** Test seam. */
export const __test = { onEnvelope, tracked, gapBuffer, resyncing, setSocket: (s: KesokuSocket | null) => (socket = s), streamBatcher };

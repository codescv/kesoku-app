import Dexie, { type Table } from 'dexie';
import type { SessionSummary } from '@kesoku/protocol';
import type { ChatItem } from './types';

export interface SessionRow {
  session_id: string;
  data: SessionSummary;
  updated_at: number;
}
export interface MessageRow {
  id: string; // `${session_id}|${key}`
  session_id: string;
  ts: number;
  data: ChatItem;
}
export interface CursorRow {
  session_id: string;
  last_seq: number;
}
export interface StateRow {
  session_id: string;
  files: Record<string, unknown>;
  mode_prefs: Record<string, unknown>;
}
export interface KvRow {
  key: string;
  value: unknown;
}
export interface WorkoutDocRow {
  id: string; // `${ownerKey}|${docKey}`
  ownerKey: string;
  docKey: string; // 'catalog' | 'log:YYYY-MM'
  content: string;
  /** Numeric flag (0 | 1) for IndexedDB compound index `[ownerKey+dirty]` compatibility. */
  dirty: 0 | 1;
  remoteSha256: string | null;
  needsReadBeforeWrite: boolean;
  corruptRemote?: boolean;
  updatedAt: number;
}

/** Local snapshot cache (IndexedDB): recent sessions, messages, `last_seq` cursors, UI settings, workout docs. No auth secrets here. */
export class KesokuDB extends Dexie {
  sessions!: Table<SessionRow, string>;
  messages!: Table<MessageRow, string>;
  cursors!: Table<CursorRow, string>;
  states!: Table<StateRow, string>;
  kv!: Table<KvRow, string>;
  workout_docs!: Table<WorkoutDocRow, string>;

  constructor(name = 'kesoku') {
    super(name);
    this.version(1).stores({
      sessions: 'session_id, updated_at',
      messages: 'id, session_id, [session_id+ts]',
      cursors: 'session_id',
      states: 'session_id',
      kv: 'key',
    });
    this.version(2).stores({
      sessions: 'session_id, updated_at',
      messages: 'id, session_id, [session_id+ts]',
      cursors: 'session_id',
      states: 'session_id',
      kv: 'key',
      workout_docs: 'id, ownerKey, [ownerKey+dirty], [ownerKey+docKey]',
    });
  }
}

export const db = new KesokuDB();

const MAX_CACHED_MESSAGES = 200;

export async function saveMessages(sessionId: string, items: ChatItem[]): Promise<void> {
  const rows = items.slice(-MAX_CACHED_MESSAGES).map((m) => ({ id: `${sessionId}|${m.key}`, session_id: sessionId, ts: m.ts, data: m }));
  await db.transaction('rw', db.messages, async () => {
    await db.messages.where('session_id').equals(sessionId).delete();
    await db.messages.bulkPut(rows);
  });
}

export async function loadMessages(sessionId: string): Promise<ChatItem[]> {
  const rows = await db.messages.where('[session_id+ts]').between([sessionId, -Infinity], [sessionId, Infinity]).toArray();
  return rows.map((r) => r.data);
}

export async function getCursor(sessionId: string): Promise<number> {
  return (await db.cursors.get(sessionId))?.last_seq ?? 0;
}

export async function setCursor(sessionId: string, lastSeq: number): Promise<void> {
  await db.cursors.put({ session_id: sessionId, last_seq: lastSeq });
}

export async function allCursors(): Promise<CursorRow[]> {
  return db.cursors.toArray();
}

export async function kvGet<T>(key: string, fallback: T): Promise<T> {
  const row = await db.kv.get(key);
  return row ? (row.value as T) : fallback;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await db.kv.put({ key, value });
}

/** Completely purge a deleted session and its messages/cursors/states/last_session pointer from IndexedDB. */
export async function purgeSessionFromDb(sessionId: string): Promise<void> {
  await db.transaction('rw', [db.sessions, db.messages, db.cursors, db.states, db.kv], async () => {
    await db.sessions.delete(sessionId);
    await db.messages.where('session_id').equals(sessionId).delete();
    await db.cursors.delete(sessionId);
    await db.states.delete(sessionId);
    const last = await db.kv.get('last_session');
    if (last?.value === sessionId) {
      await db.kv.delete('last_session');
    }
  });
}

/**
 * Reconcile IndexedDB sessions against the authoritative active session map so deleted sessions
 * never linger in IndexedDB and flash on web page reload.
 */
export async function reconcileSessionsInDb(
  sessions: Record<string, SessionSummary>,
  roleFilter?: string | null,
): Promise<void> {
  const keepIds = new Set(Object.keys(sessions));
  const rows = Object.values(sessions).map((d) => ({
    session_id: d.session_id,
    data: d,
    updated_at: d.updated_at,
  }));
  await db.transaction('rw', [db.sessions, db.messages, db.cursors, db.states, db.kv], async () => {
    const existing = await db.sessions.toArray();
    const staleIds = existing
      .filter((row) => (!roleFilter || row.data?.role === roleFilter) && !keepIds.has(row.session_id))
      .map((row) => row.session_id);
    if (staleIds.length > 0) {
      await db.sessions.bulkDelete(staleIds);
      await db.cursors.bulkDelete(staleIds);
      await db.states.bulkDelete(staleIds);
      for (const id of staleIds) {
        await db.messages.where('session_id').equals(id).delete();
      }
      const last = await db.kv.get('last_session');
      if (typeof last?.value === 'string' && staleIds.includes(last.value)) {
        await db.kv.delete('last_session');
      }
    }
    if (rows.length > 0) {
      await db.sessions.bulkPut(rows);
    }
  });
}

// ───────────────────────── workout docs helpers ─────────────────────────

export function workoutDocId(ownerKey: string, docKey: string): string {
  return `${ownerKey}|${docKey}`;
}

export async function getWorkoutDoc(ownerKey: string, docKey: string): Promise<WorkoutDocRow | undefined> {
  return db.workout_docs.get(workoutDocId(ownerKey, docKey));
}

export async function putWorkoutDoc(row: WorkoutDocRow): Promise<void> {
  await db.workout_docs.put(row);
}

export async function listWorkoutDocs(ownerKey: string): Promise<WorkoutDocRow[]> {
  return db.workout_docs.where('ownerKey').equals(ownerKey).toArray();
}

export async function listDirtyWorkoutDocs(ownerKey: string): Promise<WorkoutDocRow[]> {
  return db.workout_docs.where('[ownerKey+dirty]').equals([ownerKey, 1]).toArray();
}

export async function listAllDirtyWorkoutDocs(): Promise<WorkoutDocRow[]> {
  const all = await db.workout_docs.toArray();
  return all.filter((r) => r.dirty === 1);
}

export async function deleteWorkoutDocsByOwner(ownerKey: string): Promise<void> {
  await db.workout_docs.where('ownerKey').equals(ownerKey).delete();
}

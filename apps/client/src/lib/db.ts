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

/** Local snapshot cache (IndexedDB): recent sessions, messages, `last_seq` cursors, UI settings. No auth secrets here. */
export class KesokuDB extends Dexie {
  sessions!: Table<SessionRow, string>;
  messages!: Table<MessageRow, string>;
  cursors!: Table<CursorRow, string>;
  states!: Table<StateRow, string>;
  kv!: Table<KvRow, string>;

  constructor(name = 'kesoku') {
    super(name);
    this.version(1).stores({
      sessions: 'session_id, updated_at',
      messages: 'id, session_id, [session_id+ts]',
      cursors: 'session_id',
      states: 'session_id',
      kv: 'key',
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

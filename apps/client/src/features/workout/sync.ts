import type { EngineToClientPayload } from '@kesoku/protocol';
import { kesoku } from '../../lib/client';
import {
  deleteWorkoutDocsByOwner,
  getWorkoutDoc,
  kvGet,
  kvSet,
  listAllDirtyWorkoutDocs,
  listDirtyWorkoutDocs,
  listWorkoutDocs,
  putWorkoutDoc,
  workoutDocId,
  type WorkoutDocRow,
} from '../../lib/db';
import { useStore } from '../../lib/store';
import { RpcError } from '../../lib/ws';
import { generateRecentMarkdown } from './format';
import { mergeCatalog, mergeMonthlyLog, parseCatalogJson, parseMonthlyLogJson } from './merge';
import { allSessionsFromLogs, loadOwnerIntoStore, onWorkoutDirty, useWorkoutStore, workoutActions } from './store';
import {
  LOCAL_ONLY_OWNER,
  MONTH_LOG_FILE_RE,
  docKeyToPath,
  emptyCatalog,
  emptyMonthlyLog,
  monthToDocKey,
  type ExerciseCatalogFile,
  type MonthlyWorkoutLogFile,
} from './types';

type WriteResult = EngineToClientPayload<'workspace.write.result'>;
type ReadResult = EngineToClientPayload<'workspace.read.result'>;
type ListResult = EngineToClientPayload<'workspace.list.result'>;

const MAX_CAS_RETRIES = 3;
const FLUSH_DEBOUNCE_MS = 600;

function isOnlineAndEngineReady(): boolean {
  const conn = useStore.getState().conn;
  return conn.status === 'online' && conn.engineOnline;
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof RpcError && (err.code === 'NOT_FOUND' || err.code === 'ENOENT');
}

function isWriteConflict(res: WriteResult): res is Extract<WriteResult, { conflict: true }> {
  return 'conflict' in res && res.conflict === true;
}

function getRecentMonths(count = 3, now = Date.now()): string[] {
  const out: string[] = [];
  const d = new Date(now);
  for (let i = 0; i < count; i++) {
    const dt = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

class WorkoutSyncEngine {
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;
  private pendingWriteRecent = false;
  private lockRelease: (() => void) | null = null;
  private lockAcquired = false;
  private channel: BroadcastChannel | null = null;
  private unsubDirty: (() => void) | null = null;

  constructor() {
    this.unsubDirty = onWorkoutDirty((_docKey, opts) => {
      if (opts?.writeRecent) this.pendingWriteRecent = true;
      this.scheduleFlush();
    });
  }

  /** Acquire Web single-writer lock (`navigator.locks`) and subscribe to peer BroadcastChannel updates. */
  async acquireTabLock(): Promise<boolean> {
    if (this.lockAcquired) return true;

    if (typeof BroadcastChannel !== 'undefined' && !this.channel) {
      try {
        this.channel = new BroadcastChannel('kesoku-workout');
        this.channel.onmessage = (ev) => {
          const data = ev.data as { type?: string; ownerKey?: string } | null;
          if (data?.type === 'doc-updated') {
            const curOwner = useWorkoutStore.getState().ownerKey;
            if (!data.ownerKey || data.ownerKey === curOwner) {
              void loadOwnerIntoStore(curOwner);
            }
          }
        };
      } catch {
        /* ignore */
      }
    }

    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!locks?.request) {
      this.lockAcquired = true;
      useWorkoutStore.setState({ isReadOnlyTab: false });
      return true;
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      void locks
        .request('kesoku-workout-writer', { ifAvailable: true }, (lock) => {
          if (!lock) {
            useWorkoutStore.setState({ isReadOnlyTab: true });
            if (!settled) {
              settled = true;
              resolve(false);
            }
            return;
          }
          this.lockAcquired = true;
          useWorkoutStore.setState({ isReadOnlyTab: false });
          if (!settled) {
            settled = true;
            resolve(true);
          }
          return new Promise<void>((release) => {
            this.lockRelease = release;
          });
        })
        .catch(() => {
          if (!settled) {
            settled = true;
            this.lockAcquired = true;
            useWorkoutStore.setState({ isReadOnlyTab: false });
            resolve(true);
          }
        });
    });
  }

  releaseTabLock(): void {
    this.lockRelease?.();
    this.lockRelease = null;
    this.lockAcquired = false;
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
  }

  scheduleFlush(delayMs = FLUSH_DEBOUNCE_MS): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushIfReady();
    }, delayMs);
  }

  async onEngineOnline(): Promise<void> {
    if (!useWorkoutStore.getState().hydrated) {
      await workoutActions.hydrate();
    }
    await this.probeAndSync();
  }

  /** Foreground handler: refreshes clock + syncs, NEVER switches screens. */
  async onForeground(): Promise<void> {
    workoutActions.tickClock();
    if (isOnlineAndEngineReady()) {
      await this.probeAndSync();
    }
  }

  /** Pre-write capability probe (`workspace.list('', { noQueue: true })`) + ownerKey check + sync. */
  async probeAndSync(): Promise<void> {
    if (useWorkoutStore.getState().isReadOnlyTab) {
      await loadOwnerIntoStore(useWorkoutStore.getState().ownerKey);
      return;
    }
    if (!isOnlineAndEngineReady()) {
      const cur = useWorkoutStore.getState();
      if (cur.syncStatus !== 'corrupt') {
        useWorkoutStore.setState({ syncStatus: cur.engineLegacy ? 'local_only' : 'offline' });
      }
      return;
    }
    if (this.syncing) return;
    this.syncing = true;
    useWorkoutStore.setState({ syncStatus: 'syncing' });

    try {
      const root = await kesoku.rpc<ListResult>('workspace.list', { rel_path: '' }, { noQueue: true });
      const wsId = typeof root.workspace_id === 'string' && root.workspace_id.trim() ? root.workspace_id.trim() : null;
      const hasCas = root.workspace_cas === true;

      // Legacy engine: enter local-only mode, NEVER write anything to $AWD
      if (!wsId || !hasCas) {
        useWorkoutStore.setState({
          engineLegacy: true,
          syncStatus: 'local_only',
        });
        return;
      }

      useWorkoutStore.setState({ engineLegacy: false });
      const prevOwner = await kvGet<string>('workout_owner_key', LOCAL_ONLY_OWNER).catch(() => LOCAL_ONLY_OWNER);

      if (prevOwner === LOCAL_ONLY_OWNER) {
        const localDocs = await listWorkoutDocs(LOCAL_ONLY_OWNER).catch(() => []);
        const localSessionCount = countSessionsInRows(localDocs);
        const hasLocalTemplates = countTemplatesInRows(localDocs) > 0;
        if (localSessionCount > 0 || hasLocalTemplates) {
          // Engine upgraded from legacy/offline -> real workspace_id: ask user once to merge instead of freezing
          useWorkoutStore.setState({
            pendingUpgradeMerge: { targetOwnerKey: wsId, localSessionCount },
            syncStatus: 'local_only',
          });
          return;
        }
        await kvSet('workout_owner_key', wsId).catch(() => {});
        await loadOwnerIntoStore(wsId);
      } else if (prevOwner !== wsId) {
        // Genuine workspace switch: freeze previous owner's dirty docs, NEVER push across workspaces
        const oldDirty = await listDirtyWorkoutDocs(prevOwner).catch(() => []);
        await kvSet('workout_owner_key', wsId).catch(() => {});
        await loadOwnerIntoStore(wsId);
        if (oldDirty.length > 0) {
          useWorkoutStore.setState({
            frozenWorkspaceNotice: { oldOwnerKey: prevOwner, newOwnerKey: wsId, dirtyCount: oldDirty.length },
          });
        }
      } else if (useWorkoutStore.getState().ownerKey !== wsId) {
        await loadOwnerIntoStore(wsId);
      }

      await this.pullRemoteInternal(wsId);
      await this.flushDirtyInternal(wsId);
      if (this.pendingWriteRecent) {
        this.pendingWriteRecent = false;
        await this.writeRecentMarkdownInternal(wsId);
      }

      const hasCorrupt = Object.keys(useWorkoutStore.getState().corruptDocs).length > 0;
      useWorkoutStore.setState({ syncStatus: hasCorrupt ? 'corrupt' : 'synced' });
    } catch (err) {
      if (err instanceof RpcError && err.code === 'OFFLINE') {
        useWorkoutStore.setState({ syncStatus: 'offline' });
      } else {
        const hasCorrupt = Object.keys(useWorkoutStore.getState().corruptDocs).length > 0;
        useWorkoutStore.setState({ syncStatus: hasCorrupt ? 'corrupt' : 'error' });
      }
    } finally {
      this.syncing = false;
    }
  }

  /** User confirmed merging `__local_only__` docs into the newly upgraded engine's `workspace_id`. */
  async confirmUpgradeMerge(): Promise<void> {
    const pending = useWorkoutStore.getState().pendingUpgradeMerge;
    if (!pending) return;
    const targetOwner = pending.targetOwnerKey;
    const localDocs = await listWorkoutDocs(LOCAL_ONLY_OWNER).catch(() => []);
    for (const row of localDocs) {
      const existingTarget = await getWorkoutDoc(targetOwner, row.docKey).catch(() => undefined);
      let mergedContent = row.content;
      if (existingTarget) {
        if (row.docKey === 'catalog') {
          const a = parseCatalogJson(row.content);
          const b = parseCatalogJson(existingTarget.content);
          if (a.ok && b.ok) mergedContent = JSON.stringify(mergeCatalog(a.data, b.data));
        } else if (row.docKey.startsWith('log:')) {
          const month = row.docKey.slice(4);
          const a = parseMonthlyLogJson(row.content, month);
          const b = parseMonthlyLogJson(existingTarget.content, month);
          if (a.ok && b.ok) mergedContent = JSON.stringify(mergeMonthlyLog(a.data, b.data));
        }
      }
      await putWorkoutDoc({
        id: workoutDocId(targetOwner, row.docKey),
        ownerKey: targetOwner,
        docKey: row.docKey,
        content: mergedContent,
        dirty: 1,
        remoteSha256: existingTarget?.remoteSha256 ?? null,
        needsReadBeforeWrite: true,
        corruptRemote: false,
        updatedAt: Date.now(),
      });
    }
    await deleteWorkoutDocsByOwner(LOCAL_ONLY_OWNER).catch(() => {});
    await kvSet('workout_owner_key', targetOwner).catch(() => {});
    useWorkoutStore.setState({ pendingUpgradeMerge: null });
    await loadOwnerIntoStore(targetOwner);
    this.pendingWriteRecent = true;
    await this.probeAndSync();
  }

  /** User chose not to merge `__local_only__` docs into the new workspace (keeps them isolated locally). */
  async skipUpgradeMerge(): Promise<void> {
    const pending = useWorkoutStore.getState().pendingUpgradeMerge;
    if (!pending) return;
    const targetOwner = pending.targetOwnerKey;
    await kvSet('workout_owner_key', targetOwner).catch(() => {});
    useWorkoutStore.setState({ pendingUpgradeMerge: null });
    await loadOwnerIntoStore(targetOwner);
    await this.probeAndSync();
  }

  dismissFrozenNotice(): void {
    useWorkoutStore.setState({ frozenWorkspaceNotice: null });
  }

  async flushIfReady(): Promise<void> {
    const st = useWorkoutStore.getState();
    if (st.isReadOnlyTab || st.engineLegacy || st.pendingUpgradeMerge) return;
    if (st.ownerKey === LOCAL_ONLY_OWNER) {
      if (isOnlineAndEngineReady()) await this.probeAndSync();
      return;
    }
    if (!isOnlineAndEngineReady()) {
      if (st.syncStatus !== 'corrupt') useWorkoutStore.setState({ syncStatus: 'offline' });
      return;
    }
    if (this.syncing) return;
    this.syncing = true;
    useWorkoutStore.setState({ syncStatus: 'syncing' });
    try {
      await this.flushDirtyInternal(st.ownerKey);
      if (this.pendingWriteRecent) {
        this.pendingWriteRecent = false;
        await this.writeRecentMarkdownInternal(st.ownerKey);
      }
      const hasCorrupt = Object.keys(useWorkoutStore.getState().corruptDocs).length > 0;
      useWorkoutStore.setState({ syncStatus: hasCorrupt ? 'corrupt' : 'synced' });
    } catch (err) {
      if (err instanceof RpcError && err.code === 'OFFLINE') {
        useWorkoutStore.setState({ syncStatus: 'offline' });
      } else {
        const hasCorrupt = Object.keys(useWorkoutStore.getState().corruptDocs).length > 0;
        useWorkoutStore.setState({ syncStatus: hasCorrupt ? 'corrupt' : 'error' });
      }
    } finally {
      this.syncing = false;
    }
  }

  /** Pull remote catalog & recent monthly logs (strictly validating JSON & truncated flag). */
  private async pullRemoteInternal(ownerKey: string): Promise<void> {
    await this.pullSingleDoc(ownerKey, 'catalog');

    const months = new Set<string>(getRecentMonths(3));
    try {
      const listRes = await kesoku.rpc<ListResult>('workspace.list', { rel_path: 'workouts/logs' }, { noQueue: true });
      const logFiles = (listRes.entries ?? [])
        .filter((e) => e.kind === 'file' && MONTH_LOG_FILE_RE.test(e.name))
        .map((e) => e.name.slice(0, 7))
        .sort()
        .reverse()
        .slice(0, 6);
      for (const m of logFiles) months.add(m);
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }

    for (const month of months) {
      await this.pullSingleDoc(ownerKey, monthToDocKey(month));
    }
  }

  /** Pull one document from engine, validate, merge with local if present, and save to Dexie + Zustand. */
  async pullSingleDoc(
    ownerKey: string,
    docKey: string,
  ): Promise<{ ok: true; remoteSha256: string | null } | { ok: false; reason: 'corrupt' | 'truncated' | 'offline' | 'error' }> {
    const path = docKeyToPath(docKey);
    let readRes: ReadResult;
    try {
      readRes = await kesoku.rpc<ReadResult>('workspace.read', { rel_path: path }, { noQueue: true });
    } catch (err) {
      if (isNotFoundError(err)) {
        // Remote file does not exist yet: expected_sha256 for next write is null
        const existing = await getWorkoutDoc(ownerKey, docKey).catch(() => undefined);
        if (existing) {
          await putWorkoutDoc({
            ...existing,
            remoteSha256: null,
            needsReadBeforeWrite: false,
            corruptRemote: false,
          });
        }
        return { ok: true, remoteSha256: null };
      }
      if (err instanceof RpcError && err.code === 'OFFLINE') return { ok: false, reason: 'offline' };
      return { ok: false, reason: 'error' };
    }

    if (readRes.truncated) {
      return { ok: false, reason: 'truncated' };
    }

    const remoteSha = typeof readRes.sha256 === 'string' && readRes.sha256 ? readRes.sha256 : null;
    const rawContent = readRes.content ?? '';

    if (docKey === 'catalog') {
      const parsed = parseCatalogJson(rawContent);
      if (!parsed.ok) {
        await this.markCorruptDoc(ownerKey, docKey, path, parsed.error);
        return { ok: false, reason: 'corrupt' };
      }
      const existing = await getWorkoutDoc(ownerKey, docKey).catch(() => undefined);
      let merged: ExerciseCatalogFile = parsed.data;
      let dirty: 0 | 1 = 0;
      if (existing) {
        const localParsed = parseCatalogJson(existing.content);
        if (localParsed.ok) {
          merged = mergeCatalog(localParsed.data, parsed.data);
          dirty = JSON.stringify(merged) === JSON.stringify(parsed.data) ? 0 : 1;
        }
      }
      await putWorkoutDoc({
        id: workoutDocId(ownerKey, docKey),
        ownerKey,
        docKey,
        content: JSON.stringify(merged),
        dirty,
        remoteSha256: remoteSha,
        needsReadBeforeWrite: false,
        corruptRemote: false,
        updatedAt: merged.updatedAt || Date.now(),
      });
      this.clearCorruptDoc(docKey);
      if (useWorkoutStore.getState().ownerKey === ownerKey) {
        useWorkoutStore.setState({ catalog: merged });
      }
      return { ok: true, remoteSha256: remoteSha };
    }

    if (docKey.startsWith('log:')) {
      const month = docKey.slice(4);
      const parsed = parseMonthlyLogJson(rawContent, month);
      if (!parsed.ok) {
        await this.markCorruptDoc(ownerKey, docKey, path, parsed.error);
        return { ok: false, reason: 'corrupt' };
      }
      const existing = await getWorkoutDoc(ownerKey, docKey).catch(() => undefined);
      let merged: MonthlyWorkoutLogFile = parsed.data;
      let dirty: 0 | 1 = 0;
      if (existing) {
        const localParsed = parseMonthlyLogJson(existing.content, month);
        if (localParsed.ok) {
          merged = mergeMonthlyLog(localParsed.data, parsed.data);
          dirty = JSON.stringify(merged) === JSON.stringify(parsed.data) ? 0 : 1;
        }
      }
      await putWorkoutDoc({
        id: workoutDocId(ownerKey, docKey),
        ownerKey,
        docKey,
        content: JSON.stringify(merged),
        dirty,
        remoteSha256: remoteSha,
        needsReadBeforeWrite: false,
        corruptRemote: false,
        updatedAt: merged.updatedAt || Date.now(),
      });
      this.clearCorruptDoc(docKey);
      if (useWorkoutStore.getState().ownerKey === ownerKey) {
        useWorkoutStore.setState((prev) => ({ logs: { ...prev.logs, [month]: merged } }));
      }
      return { ok: true, remoteSha256: remoteSha };
    }

    return { ok: true, remoteSha256: remoteSha };
  }

  private async markCorruptDoc(ownerKey: string, docKey: string, path: string, error: string): Promise<void> {
    const existing = await getWorkoutDoc(ownerKey, docKey).catch(() => undefined);
    if (existing) {
      await putWorkoutDoc({ ...existing, corruptRemote: true });
    } else {
      const fallback = docKey === 'catalog' ? emptyCatalog() : emptyMonthlyLog(docKey.slice(4));
      await putWorkoutDoc({
        id: workoutDocId(ownerKey, docKey),
        ownerKey,
        docKey,
        content: JSON.stringify(fallback),
        dirty: 0,
        remoteSha256: null,
        needsReadBeforeWrite: true,
        corruptRemote: true,
        updatedAt: Date.now(),
      });
    }
    useWorkoutStore.setState((prev) => ({
      syncStatus: 'corrupt',
      corruptDocs: { ...prev.corruptDocs, [docKey]: { docKey, path, error } },
    }));
  }

  private clearCorruptDoc(docKey: string): void {
    const cur = useWorkoutStore.getState().corruptDocs;
    if (!(docKey in cur)) return;
    const next = { ...cur };
    delete next[docKey];
    useWorkoutStore.setState({ corruptDocs: next });
  }

  /** Explicit user confirmation to overwrite a corrupt remote JSON file with local clean data. */
  async forceOverwriteCorruptDoc(docKey: string): Promise<boolean> {
    const st = useWorkoutStore.getState();
    if (!isOnlineAndEngineReady() || st.engineLegacy || st.ownerKey === LOCAL_ONLY_OWNER) return false;
    const path = docKeyToPath(docKey);
    const localRow = await getWorkoutDoc(st.ownerKey, docKey).catch(() => undefined);
    if (!localRow) return false;

    try {
      let currentSha: string | null = null;
      try {
        const readRes = await kesoku.rpc<ReadResult>('workspace.read', { rel_path: path }, { noQueue: true });
        currentSha = typeof readRes.sha256 === 'string' ? readRes.sha256 : null;
      } catch (err) {
        if (!isNotFoundError(err)) return false;
      }
      const res = await kesoku.rpc<WriteResult>(
        'workspace.write',
        { path, content: localRow.content, overwrite: true, expected_sha256: currentSha },
        { noQueue: true },
      );
      if (isWriteConflict(res)) return false;
      await putWorkoutDoc({
        ...localRow,
        dirty: 0,
        remoteSha256: typeof res.sha256 === 'string' ? res.sha256 : null,
        needsReadBeforeWrite: false,
        corruptRemote: false,
      });
      this.clearCorruptDoc(docKey);
      const hasCorrupt = Object.keys(useWorkoutStore.getState().corruptDocs).length > 0;
      useWorkoutStore.setState({ syncStatus: hasCorrupt ? 'corrupt' : 'synced' });
      return true;
    } catch {
      return false;
    }
  }

  private async flushDirtyInternal(ownerKey: string): Promise<void> {
    const dirtyRows = await listDirtyWorkoutDocs(ownerKey).catch(() => []);
    for (const row of dirtyRows) {
      if (row.corruptRemote) continue;
      await this.flushSingleDoc(ownerKey, row.docKey);
    }
  }

  private async flushSingleDoc(ownerKey: string, docKey: string): Promise<void> {
    const path = docKeyToPath(docKey);
    let row = await getWorkoutDoc(ownerKey, docKey).catch(() => undefined);
    if (!row || row.dirty === 0 || row.corruptRemote) return;

    if (row.needsReadBeforeWrite) {
      const pulled = await this.pullSingleDoc(ownerKey, docKey);
      if (!pulled.ok) return;
      row = await getWorkoutDoc(ownerKey, docKey).catch(() => undefined);
      if (!row || row.dirty === 0 || row.corruptRemote) return;
    }

    let expectedSha: string | null = row.remoteSha256;

    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const contentToWrite = row.content;
      try {
        const res = await kesoku.rpc<WriteResult>(
          'workspace.write',
          {
            path,
            content: contentToWrite,
            overwrite: true,
            expected_sha256: expectedSha,
          },
          { noQueue: true },
        );

        if (isWriteConflict(res)) {
          const pulled = await this.pullSingleDoc(ownerKey, docKey);
          if (!pulled.ok) return;
          row = await getWorkoutDoc(ownerKey, docKey).catch(() => undefined);
          if (!row || row.dirty === 0 || row.corruptRemote) return;
          expectedSha = pulled.remoteSha256;
          continue;
        }

        const newSha = typeof res.sha256 === 'string' && res.sha256 ? res.sha256 : null;
        // Re-check latest Dexie row in case the user edited again while RPC was in flight
        const latest = await getWorkoutDoc(ownerKey, docKey).catch(() => undefined);
        const unchanged = !latest || latest.content === contentToWrite;
        await putWorkoutDoc({
          ...(latest ?? row),
          remoteSha256: newSha,
          dirty: unchanged ? 0 : 1,
          needsReadBeforeWrite: false,
          corruptRemote: false,
        });
        return;
      } catch (err) {
        if (err instanceof RpcError && (err.code === 'TIMEOUT' || err.code === 'OFFLINE')) {
          const latest = await getWorkoutDoc(ownerKey, docKey).catch(() => undefined);
          if (latest) {
            await putWorkoutDoc({ ...latest, dirty: 1, needsReadBeforeWrite: true });
          }
        }
        throw err;
      }
    }
  }

  /** Pull a month's log before unlocking history editing. Offline strictly returns read-only. */
  async pullMonthForEdit(
    month: string,
  ): Promise<{ ok: true } | { ok: false; reason: 'offline' | 'legacy' | 'corrupt' | 'truncated' | 'error' }> {
    const st = useWorkoutStore.getState();
    if (st.engineLegacy || st.ownerKey === LOCAL_ONLY_OWNER) {
      // In local-only mode, there is no remote to conflict with
      return { ok: true };
    }
    if (!isOnlineAndEngineReady()) return { ok: false, reason: 'offline' };
    const res = await this.pullSingleDoc(st.ownerKey, monthToDocKey(month));
    if (!res.ok) return { ok: false, reason: res.reason };
    return { ok: true };
  }

  /** Write derived `$AWD/workouts/RECENT.md` (explicit finish / history edit / manual refresh only). */
  async writeRecentMarkdown(): Promise<void> {
    const st = useWorkoutStore.getState();
    if (st.engineLegacy || st.ownerKey === LOCAL_ONLY_OWNER || !isOnlineAndEngineReady()) return;
    await this.writeRecentMarkdownInternal(st.ownerKey);
  }

  private async writeRecentMarkdownInternal(ownerKey: string): Promise<void> {
    if (ownerKey === LOCAL_ONLY_OWNER || !isOnlineAndEngineReady()) return;
    const allSessions = allSessionsFromLogs(useWorkoutStore.getState().logs);
    const md = generateRecentMarkdown(allSessions, 10);
    try {
      await kesoku.rpc<WriteResult>(
        'workspace.write',
        { path: 'workouts/RECENT.md', content: md, overwrite: true },
        { noQueue: true },
      );
    } catch {
      /* best-effort digest */
    }
  }

  /** Check whether any owner has unsynced dirty workout docs (used before logout in SettingsScreen). */
  async countAllDirtyDocs(): Promise<number> {
    const rows = await listAllDirtyWorkoutDocs().catch(() => []);
    return rows.length;
  }

  /** Export all local workout docs for an owner (or all owners if omitted) as a JSON backup string. */
  async exportBackupJson(ownerKey?: string): Promise<string> {
    const rows = ownerKey
      ? await listWorkoutDocs(ownerKey).catch(() => [])
      : await listAllDirtyWorkoutDocs().catch(() => []);
    const payload = {
      exportedAt: new Date().toISOString(),
      ownerKey: ownerKey ?? 'all_dirty',
      docs: rows.map((r) => {
        let parsed: unknown = r.content;
        try {
          parsed = JSON.parse(r.content);
        } catch {
          /* keep raw */
        }
        return { ownerKey: r.ownerKey, docKey: r.docKey, dirty: r.dirty === 1, updatedAt: r.updatedAt, data: parsed };
      }),
    };
    return JSON.stringify(payload, null, 2);
  }

  /** Test / cleanup helper. */
  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.releaseTabLock();
    this.unsubDirty?.();
    this.unsubDirty = null;
  }
}

function countSessionsInRows(rows: readonly WorkoutDocRow[]): number {
  let count = 0;
  for (const r of rows) {
    if (!r.docKey.startsWith('log:')) continue;
    const parsed = parseMonthlyLogJson(r.content, r.docKey.slice(4));
    if (parsed.ok) count += parsed.data.sessions.filter((s) => !s.deletedAt).length;
  }
  return count;
}

function countTemplatesInRows(rows: readonly WorkoutDocRow[]): number {
  const cat = rows.find((r) => r.docKey === 'catalog');
  if (!cat) return 0;
  const parsed = parseCatalogJson(cat.content);
  return parsed.ok ? parsed.data.templates.length : 0;
}

export const workoutSync = new WorkoutSyncEngine();

/** Trigger a browser download of a JSON string (best-effort). */
export function downloadJsonFile(json: string, filename: string): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

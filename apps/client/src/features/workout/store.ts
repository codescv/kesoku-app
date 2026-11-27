import { create } from 'zustand';
import {
  db,
  kvGet,
  kvSet,
  listWorkoutDocs,
  workoutDocId,
  type WorkoutDocRow,
} from '../../lib/db';
import {
  DEFAULT_REST_TARGET_SEC,
  DEFAULT_STEP_KG,
  DEFAULT_WEIGHT_BASIS,
  LOCAL_ONLY_OWNER,
  docKeyToPath,
  emptyCatalog,
  emptyMonthlyLog,
  isSessionActive,
  localDateString,
  localTzOffsetMin,
  makeTemplateId,
  monthFromDate,
  monthToDocKey,
  newDeviceId,
  newExerciseId,
  newSessionId,
  newSetId,
  roundWeightKg,
  type EquipmentType,
  type ExerciseCatalogFile,
  type ExerciseEntry,
  type ExerciseTemplate,
  type MonthlyWorkoutLogFile,
  type SetEntry,
  type WeightBasis,
  type WorkoutSession,
} from './types';
import { deriveTemplateStats, mergeCatalog, mergeMonthlyLog, parseCatalogJson, parseMonthlyLogJson } from './merge';
import { broadcastWorkoutEvent } from './channel';

export type WorkoutSyncStatus = 'idle' | 'syncing' | 'synced' | 'offline' | 'local_only' | 'error' | 'corrupt';

export interface UndoDeletedExercise {
  sessionId: string;
  month: string;
  exercise: ExerciseEntry;
  index: number;
  expiresAt: number;
}

export interface CorruptDocNotice {
  docKey: string;
  path: string;
  error: string;
}

export interface WorkoutStoreState {
  hydrated: boolean;
  ownerKey: string;
  deviceId: string;
  catalog: ExerciseCatalogFile;
  logs: Record<string, MonthlyWorkoutLogFile>;
  /** Remote sha256 that the in-memory copy of each docKey is actually based on. */
  baseShaByDocKey: Record<string, string | null>;
  expandedExerciseId: string | null;
  focusedSetByExercise: Record<string, number>;
  editingHistorySessionId: string | null;
  editingHistoryReadOnly: boolean;
  undoDeleted: UndoDeletedExercise | null;
  restStartedAt: number | null;
  restTargetSec: number;
  restVibrated: boolean;
  syncStatus: WorkoutSyncStatus;
  engineLegacy: boolean;
  pendingUpgradeMerge: { targetOwnerKey: string; localSessionCount: number } | null;
  frozenWorkspaceNotice: { oldOwnerKey: string; newOwnerKey: string; dirtyCount: number } | null;
  corruptDocs: Record<string, CorruptDocNotice>;
  isReadOnlyTab: boolean;
  clockTick: number;
}

type DirtyListener = (docKey: string, opts?: { writeRecent?: boolean }) => void;
const dirtyListeners = new Set<DirtyListener>();

export function onWorkoutDirty(fn: DirtyListener): () => void {
  dirtyListeners.add(fn);
  return () => dirtyListeners.delete(fn);
}

function emitDirty(docKey: string, opts?: { writeRecent?: boolean }): void {
  for (const fn of dirtyListeners) {
    try {
      fn(docKey, opts);
    } catch {
      /* isolate listener errors */
    }
  }
}

export function initialWorkoutState(): WorkoutStoreState {
  return {
    hydrated: false,
    ownerKey: LOCAL_ONLY_OWNER,
    deviceId: '',
    catalog: emptyCatalog(),
    logs: {},
    baseShaByDocKey: {},
    expandedExerciseId: null,
    focusedSetByExercise: {},
    editingHistorySessionId: null,
    editingHistoryReadOnly: true,
    undoDeleted: null,
    restStartedAt: null,
    restTargetSec: DEFAULT_REST_TARGET_SEC,
    restVibrated: false,
    syncStatus: 'idle',
    engineLegacy: false,
    pendingUpgradeMerge: null,
    frozenWorkspaceNotice: null,
    corruptDocs: {},
    isReadOnlyTab: false,
    clockTick: 0,
  };
}

export const useWorkoutStore = create<WorkoutStoreState>(() => initialWorkoutState());

const set = useWorkoutStore.setState;
const get = useWorkoutStore.getState;

// ───────────────────────── selectors ─────────────────────────

export function allSessionsFromLogs(logs: Record<string, MonthlyWorkoutLogFile>): WorkoutSession[] {
  const out: WorkoutSession[] = [];
  for (const file of Object.values(logs)) {
    for (const s of file.sessions) {
      if (!s.deletedAt) out.push(s);
    }
  }
  out.sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
  return out;
}

export function selectActiveSession(s: WorkoutStoreState, now = Date.now()): WorkoutSession | null {
  void s.clockTick;
  let best: WorkoutSession | null = null;
  for (const file of Object.values(s.logs)) {
    for (const sess of file.sessions) {
      if (isSessionActive(sess, now)) {
        if (!best || sess.updatedAt > best.updatedAt) best = sess;
      }
    }
  }
  return best;
}

export function selectHasActiveWorkout(s: WorkoutStoreState): boolean {
  return selectActiveSession(s) !== null;
}

export function findSessionById(
  logs: Record<string, MonthlyWorkoutLogFile>,
  sessionId: string | null,
): { session: WorkoutSession; month: string } | null {
  if (!sessionId) return null;
  for (const [month, file] of Object.entries(logs)) {
    const found = file.sessions.find((s) => s.id === sessionId && !s.deletedAt);
    if (found) return { session: found, month };
  }
  return null;
}

export function selectTargetSession(s: WorkoutStoreState): WorkoutSession | null {
  if (s.editingHistorySessionId) {
    return findSessionById(s.logs, s.editingHistorySessionId)?.session ?? null;
  }
  return selectActiveSession(s);
}

export function defaultFocusIndex(sets: readonly SetEntry[]): number {
  const idx = sets.findIndex((st) => !st.done);
  return idx >= 0 ? idx : Math.max(0, sets.length - 1);
}

export function getFocusedSetIndex(s: WorkoutStoreState, ex: ExerciseEntry): number {
  const stored = s.focusedSetByExercise[ex.id];
  if (typeof stored === 'number' && stored >= 0 && stored < ex.sets.length) {
    return stored;
  }
  return defaultFocusIndex(ex.sets);
}

// ───────────────────────── Dexie persistence (transactional & serialized) ─────────────────────────

let persistQueue: Promise<void> = Promise.resolve();

/** Await all queued Dexie workout document writes (used by sync before flushing & in tests). */
export function waitForPendingPersists(): Promise<void> {
  return persistQueue;
}

function persistDocToDb(
  ownerKey: string,
  docKey: string,
  payload: ExerciseCatalogFile | MonthlyWorkoutLogFile,
  opts: { dirty?: 0 | 1; writeRecent?: boolean } = {},
): Promise<void> {
  const run = async () => {
    const dirty = opts.dirty ?? 1;
    const knownBaseSha = get().baseShaByDocKey[docKey] ?? null;
    let finalPayload: ExerciseCatalogFile | MonthlyWorkoutLogFile = payload;
    let finalBaseSha: string | null = knownBaseSha;

    await db
      .transaction('rw', db.workout_docs, async () => {
        const id = workoutDocId(ownerKey, docKey);
        const existing = await db.workout_docs.get(id);
        const needsReadBeforeWrite = existing?.needsReadBeforeWrite ?? false;

        if (existing) {
          // Never silently inherit an unknown remoteSha256 without first merging existing Dexie content
          if (existing.remoteSha256 !== knownBaseSha) {
            if (docKey === 'catalog') {
              const p = parseCatalogJson(existing.content);
              if (p.ok) finalPayload = mergeCatalog(payload as ExerciseCatalogFile, p.data);
            } else if (docKey.startsWith('log:')) {
              const month = docKey.slice(4);
              const p = parseMonthlyLogJson(existing.content, month);
              if (p.ok) finalPayload = mergeMonthlyLog(payload as MonthlyWorkoutLogFile, p.data);
            }
            finalBaseSha = existing.remoteSha256;
          }
        }

        const row: WorkoutDocRow = {
          id,
          ownerKey,
          docKey,
          content: JSON.stringify(finalPayload),
          dirty,
          remoteSha256: finalBaseSha,
          needsReadBeforeWrite,
          corruptRemote: existing?.corruptRemote ?? false,
          updatedAt: finalPayload.updatedAt || Date.now(),
        };
        await db.workout_docs.put(row);
      })
      .catch(() => {});

    // If we merged in unknown Dexie updates, reflect them functionally into memory too
    if (finalPayload !== payload) {
      set((prev) => {
        if (prev.ownerKey !== ownerKey) return {};
        if (docKey === 'catalog') {
          return {
            catalog: mergeCatalog(prev.catalog, finalPayload as ExerciseCatalogFile),
            baseShaByDocKey: { ...prev.baseShaByDocKey, [docKey]: finalBaseSha },
          };
        }
        if (docKey.startsWith('log:')) {
          const month = docKey.slice(4);
          const cur = prev.logs[month];
          const merged = cur
            ? mergeMonthlyLog(cur, finalPayload as MonthlyWorkoutLogFile)
            : (finalPayload as MonthlyWorkoutLogFile);
          return {
            logs: { ...prev.logs, [month]: merged },
            baseShaByDocKey: { ...prev.baseShaByDocKey, [docKey]: finalBaseSha },
          };
        }
        return {};
      });
    }

    broadcastWorkoutEvent({ type: 'doc-updated', ownerKey, docKey, ts: Date.now() });
    if (dirty === 1) emitDirty(docKey, { writeRecent: opts.writeRecent });
  };

  persistQueue = persistQueue.then(run, run);
  return persistQueue;
}

/** Full owner switch load (resets UI state because we switched workspace owner or cold-booted). */
export async function loadOwnerIntoStore(ownerKey: string): Promise<void> {
  const rows = await listWorkoutDocs(ownerKey).catch(() => []);
  let catalog = emptyCatalog();
  const logs: Record<string, MonthlyWorkoutLogFile> = {};
  const corruptDocs: Record<string, CorruptDocNotice> = {};
  const baseShaByDocKey: Record<string, string | null> = {};

  for (const row of rows) {
    baseShaByDocKey[row.docKey] = row.remoteSha256;
    if (row.corruptRemote) {
      corruptDocs[row.docKey] = {
        docKey: row.docKey,
        path: docKeyToPath(row.docKey),
        error: 'remote parse error',
      };
    }
    if (row.docKey === 'catalog') {
      const parsed = parseCatalogJson(row.content);
      if (parsed.ok) catalog = parsed.data;
    } else if (row.docKey.startsWith('log:')) {
      const month = row.docKey.slice(4);
      const parsed = parseMonthlyLogJson(row.content, month);
      if (parsed.ok) logs[month] = parsed.data;
    }
  }

  set({
    ownerKey,
    catalog,
    logs,
    baseShaByDocKey,
    corruptDocs,
    expandedExerciseId: null,
    focusedSetByExercise: {},
    undoDeleted: null,
  });
}

/**
 * Peer-tab / background Dexie reload: merges catalog & logs functionally into Zustand
 * WITHOUT resetting local UI state (`expandedExerciseId`, `focusedSetByExercise`, `undoDeleted`).
 */
export async function mergeOwnerFromDbIntoStore(ownerKey: string): Promise<void> {
  const rows = await listWorkoutDocs(ownerKey).catch(() => []);
  set((prev) => {
    if (prev.ownerKey !== ownerKey) return {};
    let nextCatalog = prev.catalog;
    const nextLogs = { ...prev.logs };
    const nextBaseSha = { ...prev.baseShaByDocKey };
    const nextCorrupt = { ...prev.corruptDocs };

    for (const row of rows) {
      nextBaseSha[row.docKey] = row.remoteSha256;
      if (row.corruptRemote) {
        nextCorrupt[row.docKey] = {
          docKey: row.docKey,
          path: docKeyToPath(row.docKey),
          error: 'remote parse error',
        };
      } else {
        delete nextCorrupt[row.docKey];
      }
      if (row.docKey === 'catalog') {
        const parsed = parseCatalogJson(row.content);
        if (parsed.ok) nextCatalog = mergeCatalog(nextCatalog, parsed.data);
      } else if (row.docKey.startsWith('log:')) {
        const month = row.docKey.slice(4);
        const parsed = parseMonthlyLogJson(row.content, month);
        if (parsed.ok) {
          nextLogs[month] = nextLogs[month] ? mergeMonthlyLog(nextLogs[month]!, parsed.data) : parsed.data;
        }
      }
    }

    return {
      catalog: nextCatalog,
      logs: nextLogs,
      baseShaByDocKey: nextBaseSha,
      corruptDocs: nextCorrupt,
    };
  });
}

// ───────────────────────── internal mutation helper ─────────────────────────

function canMutateTarget(s: WorkoutStoreState): boolean {
  if (s.isReadOnlyTab) return false;
  if (s.editingHistorySessionId && s.editingHistoryReadOnly) return false;
  return true;
}

function findLastDoneTimestamp(sess: WorkoutSession): number | null {
  let latest = 0;
  for (const ex of sess.exercises) {
    for (const st of ex.sets) {
      if (typeof st.doneAt === 'number' && st.doneAt > latest) latest = st.doneAt;
    }
  }
  return latest > 0 ? latest : null;
}

function mutateTargetSession(
  updater: (session: WorkoutSession, now: number) => WorkoutSession | null,
  opts?: { writeRecent?: boolean; extraPatch?: Partial<WorkoutStoreState> },
): WorkoutSession | null {
  const s = get();
  if (!canMutateTarget(s)) return null;
  const target = selectTargetSession(s);
  if (!target) return null;
  const month = monthFromDate(target.date);
  const now = Date.now();
  const updated = updater(target, now);
  if (!updated) return null;

  // P2 fix: editing an expired (>3h idle) `in_progress` history session explicitly archives it as `completed`
  // so bumping `updatedAt` never resurrects an old stale session as an active live workout.
  let finalized: WorkoutSession = updated;
  const isExpiredHistoricalInProgress =
    s.editingHistorySessionId !== null &&
    target.status === 'in_progress' &&
    !isSessionActive(target, now);
  if (isExpiredHistoricalInProgress) {
    finalized = {
      ...updated,
      status: 'completed',
      finishedAt: updated.finishedAt ?? findLastDoneTimestamp(target) ?? target.updatedAt,
    };
  }

  const stamped: WorkoutSession = { ...finalized, updatedAt: now, deviceId: s.deviceId || finalized.deviceId };
  let persistedFile: MonthlyWorkoutLogFile | null = null;

  set((prev) => {
    const file = prev.logs[month] ?? emptyMonthlyLog(month);
    const nextSessions = file.sessions.map((x) => (x.id === stamped.id ? stamped : x));
    if (!nextSessions.some((x) => x.id === stamped.id)) nextSessions.unshift(stamped);
    const nextFile: MonthlyWorkoutLogFile = {
      schemaVersion: 1,
      month,
      updatedAt: now,
      sessions: nextSessions,
    };
    persistedFile = nextFile;
    return {
      logs: { ...prev.logs, [month]: nextFile },
      ...(opts?.extraPatch ?? {}),
    };
  });

  if (persistedFile) {
    void persistDocToDb(s.ownerKey, monthToDocKey(month), persistedFile, {
      dirty: 1,
      writeRecent: opts?.writeRecent ?? Boolean(s.editingHistorySessionId),
    });
  }
  return stamped;
}

// ───────────────────────── actions ─────────────────────────

let undoTimer: ReturnType<typeof setTimeout> | null = null;

export const workoutActions = {
  reset() {
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = null;
    set(initialWorkoutState());
  },

  async hydrate(): Promise<void> {
    const ownerKey = await kvGet<string>('workout_owner_key', LOCAL_ONLY_OWNER).catch(() => LOCAL_ONLY_OWNER);
    let deviceId = await kvGet<string>('workout_device_id', '').catch(() => '');
    if (!deviceId) {
      deviceId = newDeviceId();
      await kvSet('workout_device_id', deviceId).catch(() => {});
    }
    const restTargetSec = await kvGet<number>('workout_rest_target_sec', DEFAULT_REST_TARGET_SEC).catch(
      () => DEFAULT_REST_TARGET_SEC,
    );
    set({ deviceId, restTargetSec });
    await loadOwnerIntoStore(ownerKey || LOCAL_ONLY_OWNER);
    set({ hydrated: true });
  },

  tickClock() {
    set((s) => ({ clockTick: s.clockTick + 1 }));
  },

  setRestTargetSec(sec: number) {
    set((s) => ({
      restTargetSec: sec,
      restStartedAt: sec === 0 ? null : s.restStartedAt,
    }));
    void kvSet('workout_rest_target_sec', sec).catch(() => {});
  },

  markRestVibrated() {
    set({ restVibrated: true });
  },

  clearRestTimer() {
    set({ restStartedAt: null, restVibrated: false });
  },

  startBlankSession(title?: string): WorkoutSession | null {
    const s = get();
    if (s.isReadOnlyTab) return null;
    const now = Date.now();
    const date = localDateString(now);
    const month = monthFromDate(date);
    const session: WorkoutSession = {
      id: newSessionId(),
      date,
      tzOffsetMin: localTzOffsetMin(now),
      startedAt: now,
      finishedAt: null,
      status: 'in_progress',
      title: title?.trim() || undefined,
      exercises: [],
      deviceId: s.deviceId || undefined,
      updatedAt: now,
    };
    let nextFile!: MonthlyWorkoutLogFile;
    set((prev) => {
      const file = prev.logs[month] ?? emptyMonthlyLog(month);
      nextFile = {
        schemaVersion: 1,
        month,
        updatedAt: now,
        sessions: [session, ...file.sessions],
      };
      return {
        logs: { ...prev.logs, [month]: nextFile },
        editingHistorySessionId: null,
        editingHistoryReadOnly: true,
        expandedExerciseId: null,
        focusedSetByExercise: {},
        restStartedAt: null,
        restVibrated: false,
      };
    });
    void persistDocToDb(s.ownerKey, monthToDocKey(month), nextFile, { dirty: 1 });
    return session;
  },

  /** 1-Tap clone of a past session's exercises (all sets unchecked, weights & reps preserved). */
  cloneSession(sourceSessionId: string): WorkoutSession | null {
    const s = get();
    if (s.isReadOnlyTab) return null;
    const found = findSessionById(s.logs, sourceSessionId);
    if (!found) return null;
    const now = Date.now();
    const date = localDateString(now);
    const month = monthFromDate(date);
    const clonedExercises: ExerciseEntry[] = found.session.exercises.map((ex) => ({
      id: newExerciseId(),
      templateId: ex.templateId,
      name: ex.name,
      equipment: ex.equipment,
      weightBasis: ex.weightBasis,
      sets: ex.sets.map((st) => ({
        id: newSetId(),
        weightKg: st.weightKg,
        reps: st.reps,
        done: false,
      })),
    }));
    const session: WorkoutSession = {
      id: newSessionId(),
      date,
      tzOffsetMin: localTzOffsetMin(now),
      startedAt: now,
      finishedAt: null,
      status: 'in_progress',
      title: found.session.title,
      exercises: clonedExercises,
      deviceId: s.deviceId || undefined,
      updatedAt: now,
    };
    const firstId = clonedExercises[0]?.id ?? null;
    let nextFile!: MonthlyWorkoutLogFile;
    set((prev) => {
      const file = prev.logs[month] ?? emptyMonthlyLog(month);
      nextFile = {
        schemaVersion: 1,
        month,
        updatedAt: now,
        sessions: [session, ...file.sessions],
      };
      return {
        logs: { ...prev.logs, [month]: nextFile },
        editingHistorySessionId: null,
        editingHistoryReadOnly: true,
        expandedExerciseId: firstId,
        focusedSetByExercise: firstId ? { [firstId]: 0 } : {},
        restStartedAt: null,
        restVibrated: false,
      };
    });
    void persistDocToDb(s.ownerKey, monthToDocKey(month), nextFile, { dirty: 1 });
    return session;
  },

  addExerciseFromTemplate(templateId: string): ExerciseEntry | null {
    const s = get();
    if (!canMutateTarget(s)) return null;
    const tpl = s.catalog.templates.find((t) => t.id === templateId);
    if (!tpl) return null;
    const stats = deriveTemplateStats(s.logs);
    const last = stats.get(tpl.id)?.lastExercise;

    const sets: SetEntry[] =
      last && last.sets.length > 0
        ? last.sets.map((st) => ({
            id: newSetId(),
            weightKg: st.weightKg,
            reps: st.reps,
            done: false,
          }))
        : Array.from({ length: 3 }, () => ({
            id: newSetId(),
            weightKg: null,
            reps: 10,
            done: false,
          }));

    const entry: ExerciseEntry = {
      id: newExerciseId(),
      templateId: tpl.id,
      name: tpl.name,
      equipment: tpl.equipment,
      weightBasis: last?.weightBasis ?? tpl.weightBasis,
      sets,
    };

    const updated = mutateTargetSession(
      (sess) => ({ ...sess, exercises: [...sess.exercises, entry] }),
      {
        extraPatch: {
          expandedExerciseId: entry.id,
          focusedSetByExercise: { ...s.focusedSetByExercise, [entry.id]: 0 },
        },
      },
    );
    return updated ? entry : null;
  },

  createTemplateAndAdd(
    rawName: string,
    equipment: EquipmentType,
  ): { exercise: ExerciseEntry; template: ExerciseTemplate; shouldOpenWeightPad: boolean } | null {
    const s = get();
    if (!canMutateTarget(s)) return null;
    const name = rawName.trim();
    if (!name) return null;
    const id = makeTemplateId(name, equipment);
    const existing = s.catalog.templates.find((t) => t.id === id);
    const now = Date.now();
    let template = existing;
    if (!template) {
      template = {
        id,
        name,
        equipment,
        weightBasis: DEFAULT_WEIGHT_BASIS[equipment],
        stepKg: DEFAULT_STEP_KG[equipment],
        createdAt: now,
        updatedAt: now,
      };
      let nextCatalog!: ExerciseCatalogFile;
      set((prev) => {
        nextCatalog = {
          schemaVersion: 1,
          updatedAt: now,
          templates: [...prev.catalog.templates.filter((t) => t.id !== id), template!].sort((a, b) =>
            a.id.localeCompare(b.id),
          ),
        };
        return { catalog: nextCatalog };
      });
      void persistDocToDb(s.ownerKey, 'catalog', nextCatalog, { dirty: 1 });
    } else if (template.archived) {
      template = { ...template, archived: false, updatedAt: now };
      let nextCatalog!: ExerciseCatalogFile;
      set((prev) => {
        nextCatalog = {
          schemaVersion: 1,
          updatedAt: now,
          templates: prev.catalog.templates.map((t) => (t.id === id ? template! : t)),
        };
        return { catalog: nextCatalog };
      });
      void persistDocToDb(s.ownerKey, 'catalog', nextCatalog, { dirty: 1 });
    }

    const exercise = workoutActions.addExerciseFromTemplate(template.id);
    if (!exercise) return null;
    const isFreshNoWeight = exercise.sets.every((st) => st.weightKg === null);
    return {
      exercise,
      template,
      shouldOpenWeightPad: !existing && isFreshNoWeight && equipment !== 'bodyweight',
    };
  },

  setExpandedExercise(exerciseId: string | null) {
    set((s) => {
      if (!exerciseId) return { expandedExerciseId: null };
      const target = selectTargetSession(s);
      const ex = target?.exercises.find((e) => e.id === exerciseId);
      if (!ex) return { expandedExerciseId: exerciseId };
      const curFocus = s.focusedSetByExercise[exerciseId];
      const nextFocus =
        typeof curFocus === 'number' && curFocus >= 0 && curFocus < ex.sets.length
          ? curFocus
          : defaultFocusIndex(ex.sets);
      return {
        expandedExerciseId: exerciseId,
        focusedSetByExercise: { ...s.focusedSetByExercise, [exerciseId]: nextFocus },
      };
    });
  },

  focusSet(exerciseId: string, setIndex: number) {
    set((s) => ({
      expandedExerciseId: exerciseId,
      focusedSetByExercise: { ...s.focusedSetByExercise, [exerciseId]: setIndex },
    }));
  },

  /**
   * Single fill-forward rule: adjusts weight for focused set and all subsequent UNDONE sets.
   * Completed (`done === true`) sets are NEVER modified; focus NEVER moves.
   */
  adjustWeight(exerciseId: string, delta: number) {
    const s = get();
    mutateTargetSession((sess) => {
      const idx = sess.exercises.findIndex((e) => e.id === exerciseId);
      if (idx < 0) return null;
      const ex = sess.exercises[idx]!;
      const focusIdx = getFocusedSetIndex(s, ex);
      const focused = ex.sets[focusIdx];
      if (!focused || focused.done) return null;

      let nextWeight: number | null;
      if (ex.equipment === 'bodyweight') {
        const base = focused.weightKg ?? 0;
        const val = roundWeightKg(base + delta);
        nextWeight = val === 0 ? null : val;
      } else {
        if (focused.weightKg === null) {
          if (delta < 0) return null;
          nextWeight = roundWeightKg(Math.max(0, delta));
        } else {
          nextWeight = roundWeightKg(Math.max(0, focused.weightKg + delta));
        }
      }

      const nextSets = ex.sets.map((st, j) => (j >= focusIdx && !st.done ? { ...st, weightKg: nextWeight } : st));
      const nextEx: ExerciseEntry = { ...ex, sets: nextSets };
      return { ...sess, exercises: sess.exercises.map((e, i) => (i === idx ? nextEx : e)) };
    });
  },

  setWeightExact(exerciseId: string, weightKg: number | null, weightBasis?: WeightBasis) {
    const s = get();
    const rounded = weightKg === null ? null : roundWeightKg(weightKg);
    let templateToUpdate: { id: string; basis: WeightBasis } | null = null;
    mutateTargetSession((sess) => {
      const idx = sess.exercises.findIndex((e) => e.id === exerciseId);
      if (idx < 0) return null;
      const ex = sess.exercises[idx]!;
      const focusIdx = getFocusedSetIndex(s, ex);
      const nextBasis = weightBasis ?? ex.weightBasis;
      if (weightBasis && weightBasis !== ex.weightBasis) {
        templateToUpdate = { id: ex.templateId, basis: weightBasis };
      }
      const nextSets = ex.sets.map((st, j) => (j >= focusIdx && !st.done ? { ...st, weightKg: rounded } : st));
      const nextEx: ExerciseEntry = { ...ex, weightBasis: nextBasis, sets: nextSets };
      return { ...sess, exercises: sess.exercises.map((e, i) => (i === idx ? nextEx : e)) };
    });
    if (templateToUpdate) {
      const upd = templateToUpdate as { id: string; basis: WeightBasis };
      const cur = get();
      const tpl = cur.catalog.templates.find((t) => t.id === upd.id);
      if (tpl && tpl.weightBasis !== upd.basis) {
        const now = Date.now();
        let nextCatalog!: ExerciseCatalogFile;
        set((prev) => {
          nextCatalog = {
            schemaVersion: 1,
            updatedAt: now,
            templates: prev.catalog.templates.map((t) =>
              t.id === upd.id ? { ...t, weightBasis: upd.basis, updatedAt: now } : t,
            ),
          };
          return { catalog: nextCatalog };
        });
        void persistDocToDb(cur.ownerKey, 'catalog', nextCatalog, { dirty: 1 });
      }
    }
  },

  /**
   * Single fill-forward rule: adjusts reps for focused set and all subsequent UNDONE sets.
   * Completed (`done === true`) sets are NEVER modified; focus NEVER moves.
   */
  adjustReps(exerciseId: string, delta: number) {
    const s = get();
    mutateTargetSession((sess) => {
      const idx = sess.exercises.findIndex((e) => e.id === exerciseId);
      if (idx < 0) return null;
      const ex = sess.exercises[idx]!;
      const focusIdx = getFocusedSetIndex(s, ex);
      const focused = ex.sets[focusIdx];
      if (!focused || focused.done) return null;
      const nextReps = Math.max(1, focused.reps + delta);
      if (nextReps === focused.reps) return null;
      const nextSets = ex.sets.map((st, j) => (j >= focusIdx && !st.done ? { ...st, reps: nextReps } : st));
      const nextEx: ExerciseEntry = { ...ex, sets: nextSets };
      return { ...sess, exercises: sess.exercises.map((e, i) => (i === idx ? nextEx : e)) };
    });
  },

  /** Explicit `[−] 组数 [+]` stepper — never creates ghost sets, never silently deletes completed sets. */
  adjustSetCount(exerciseId: string, delta: 1 | -1) {
    const s = get();
    let nextFocusMap: Record<string, number> | undefined;
    mutateTargetSession((sess) => {
      const idx = sess.exercises.findIndex((e) => e.id === exerciseId);
      if (idx < 0) return null;
      const ex = sess.exercises[idx]!;
      if (delta === 1) {
        if (ex.sets.length >= 20) return null;
        const tail = ex.sets[ex.sets.length - 1];
        const added: SetEntry = {
          id: newSetId(),
          weightKg: tail?.weightKg ?? null,
          reps: tail?.reps ?? 10,
          done: false,
        };
        const nextSets = [...ex.sets, added];
        const curFocus = getFocusedSetIndex(s, ex);
        if (ex.sets.every((st) => st.done)) {
          nextFocusMap = { ...s.focusedSetByExercise, [exerciseId]: nextSets.length - 1 };
        } else if (curFocus >= nextSets.length) {
          nextFocusMap = { ...s.focusedSetByExercise, [exerciseId]: nextSets.length - 1 };
        }
        return { ...sess, exercises: sess.exercises.map((e, i) => (i === idx ? { ...ex, sets: nextSets } : e)) };
      } else {
        if (ex.sets.length <= 1) return null;
        let removeIdx = -1;
        for (let j = ex.sets.length - 1; j >= 0; j--) {
          if (!ex.sets[j]!.done) {
            removeIdx = j;
            break;
          }
        }
        if (removeIdx < 0) return null;
        const nextSets = ex.sets.filter((_, j) => j !== removeIdx);
        const curFocus = getFocusedSetIndex(s, ex);
        const clamped = curFocus >= nextSets.length ? defaultFocusIndex(nextSets) : curFocus;
        nextFocusMap = { ...s.focusedSetByExercise, [exerciseId]: clamped };
        return { ...sess, exercises: sess.exercises.map((e, i) => (i === idx ? { ...ex, sets: nextSets } : e)) };
      }
    });
    if (nextFocusMap) set({ focusedSetByExercise: nextFocusMap });
  },

  /** Single-set checkmark: marks focused UNDONE set done, starts rest timer (active workout), advances focus or collapses if all done. */
  completeFocusedSet(exerciseId: string): { allDone: boolean } {
    const s = get();
    let allDone = false;
    let extraPatch: Partial<WorkoutStoreState> = {};
    mutateTargetSession((sess, now) => {
      const idx = sess.exercises.findIndex((e) => e.id === exerciseId);
      if (idx < 0) return null;
      const ex = sess.exercises[idx]!;
      const focusIdx = getFocusedSetIndex(s, ex);
      const targetSet = ex.sets[focusIdx];
      // P2 fix: if targetSet is already done, never overwrite doneAt or restart rest timer
      if (!targetSet || targetSet.done) {
        allDone = ex.sets.every((st) => st.done);
        return null;
      }
      const nextSets = ex.sets.map((st, j) => (j === focusIdx ? { ...st, done: true, doneAt: now } : st));
      let nextFocus = nextSets.findIndex((st, j) => j > focusIdx && !st.done);
      if (nextFocus < 0) nextFocus = nextSets.findIndex((st) => !st.done);
      allDone = nextFocus < 0;

      const isActiveLive = !s.editingHistorySessionId;
      extraPatch = {
        focusedSetByExercise: {
          ...s.focusedSetByExercise,
          [exerciseId]: allDone ? focusIdx : nextFocus,
        },
        ...(allDone ? { expandedExerciseId: null } : {}),
        ...(isActiveLive && s.restTargetSec > 0 ? { restStartedAt: now, restVibrated: false } : {}),
      };
      return { ...sess, exercises: sess.exercises.map((e, i) => (i === idx ? { ...ex, sets: nextSets } : e)) };
    });
    if (Object.keys(extraPatch).length) set(extraPatch);
    return { allDone };
  },

  /** Toggle a set capsule directly: undone -> focus it; done -> uncheck and focus it. */
  tapSetCapsule(exerciseId: string, setIndex: number) {
    const s = get();
    const target = selectTargetSession(s);
    const ex = target?.exercises.find((e) => e.id === exerciseId);
    const st = ex?.sets[setIndex];
    if (!ex || !st) return;
    if (!st.done) {
      set({
        expandedExerciseId: exerciseId,
        focusedSetByExercise: { ...s.focusedSetByExercise, [exerciseId]: setIndex },
      });
      return;
    }
    mutateTargetSession(
      (sess) => {
        const idx = sess.exercises.findIndex((e) => e.id === exerciseId);
        if (idx < 0) return null;
        const curEx = sess.exercises[idx]!;
        const nextSets = curEx.sets.map((item, j) =>
          j === setIndex ? { ...item, done: false, doneAt: undefined } : item,
        );
        return { ...sess, exercises: sess.exercises.map((e, i) => (i === idx ? { ...curEx, sets: nextSets } : e)) };
      },
      {
        extraPatch: {
          expandedExerciseId: exerciseId,
          focusedSetByExercise: { ...s.focusedSetByExercise, [exerciseId]: setIndex },
        },
      },
    );
  },

  /** Batch complete all undone sets (0-done CTA or NumericPadSheet ✓ 完成N组). Never triggers rest timer. */
  completeAllSets(exerciseId: string) {
    mutateTargetSession(
      (sess, now) => {
        const idx = sess.exercises.findIndex((e) => e.id === exerciseId);
        if (idx < 0) return null;
        const ex = sess.exercises[idx]!;
        const nextSets = ex.sets.map((st) => (st.done ? st : { ...st, done: true, doneAt: now }));
        return { ...sess, exercises: sess.exercises.map((e, i) => (i === idx ? { ...ex, sets: nextSets } : e)) };
      },
      { extraPatch: { expandedExerciseId: null } },
    );
  },

  /**
   * Apply edited sets from `<NumericPadSheet mode="reps-seq">`.
   * P2 fix: merges edited reps/new sets functionally against the latest store `ex.sets` (preserving
   * already-done sets & any weight/field updates merged while the pad was open). Never starts rest timer.
   */
  applyRepsSeqResult(exerciseId: string, editedSets: SetEntry[], completeAll: boolean) {
    const s = get();
    let finalLen = editedSets.length;
    mutateTargetSession(
      (sess, now) => {
        const idx = sess.exercises.findIndex((e) => e.id === exerciseId);
        if (idx < 0) return null;
        const ex = sess.exercises[idx]!;
        const liveById = new Map(ex.sets.map((st) => [st.id, st]));

        const mergedSets: SetEntry[] = editedSets.map((ed) => {
          const live = liveById.get(ed.id);
          if (live) {
            // Preserve live done state & latest weightKg while applying reps from pad
            if (live.done) return live;
            return {
              ...live,
              reps: ed.reps,
              ...(completeAll ? { done: true, doneAt: now } : {}),
            };
          }
          // Newly appended set from pad
          return {
            ...ed,
            ...(completeAll && !ed.done ? { done: true, doneAt: now } : {}),
          };
        });
        finalLen = mergedSets.length;
        return { ...sess, exercises: sess.exercises.map((e, i) => (i === idx ? { ...ex, sets: mergedSets } : e)) };
      },
      {
        extraPatch: completeAll
          ? { expandedExerciseId: null }
          : {
              focusedSetByExercise: {
                ...s.focusedSetByExercise,
                [exerciseId]: Math.min(s.focusedSetByExercise[exerciseId] ?? 0, Math.max(0, finalLen - 1)),
              },
            },
      },
    );
  },

  removeExercise(exerciseId: string) {
    const s = get();
    const target = selectTargetSession(s);
    if (!target || !canMutateTarget(s)) return;
    const index = target.exercises.findIndex((e) => e.id === exerciseId);
    if (index < 0) return;
    const removed = target.exercises[index]!;
    const month = monthFromDate(target.date);
    mutateTargetSession((sess) => ({
      ...sess,
      exercises: sess.exercises.filter((e) => e.id !== exerciseId),
    }));
    if (undoTimer) clearTimeout(undoTimer);
    const expiresAt = Date.now() + 4000;
    set((prev) => ({
      expandedExerciseId: prev.expandedExerciseId === exerciseId ? null : prev.expandedExerciseId,
      undoDeleted: { sessionId: target.id, month, exercise: removed, index, expiresAt },
    }));
    undoTimer = setTimeout(() => {
      undoTimer = null;
      set((prev) => (prev.undoDeleted?.expiresAt === expiresAt ? { undoDeleted: null } : {}));
    }, 4000);
  },

  undoRemoveExercise() {
    const s = get();
    const u = s.undoDeleted;
    if (!u || !canMutateTarget(s)) return;
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = null;
    const file = s.logs[u.month];
    const sess = file?.sessions.find((x) => x.id === u.sessionId && !x.deletedAt);
    if (!file || !sess) {
      set({ undoDeleted: null });
      return;
    }
    const now = Date.now();
    let nextFile: MonthlyWorkoutLogFile | null = null;
    set((prev) => {
      const curFile = prev.logs[u.month];
      const curSess = curFile?.sessions.find((x) => x.id === u.sessionId && !x.deletedAt);
      if (!curFile || !curSess) return { undoDeleted: null };
      const exercises = [...curSess.exercises];
      exercises.splice(Math.min(u.index, exercises.length), 0, u.exercise);
      const updated: WorkoutSession = { ...curSess, exercises, updatedAt: now, deviceId: prev.deviceId || curSess.deviceId };
      nextFile = {
        schemaVersion: 1,
        month: u.month,
        updatedAt: now,
        sessions: curFile.sessions.map((x) => (x.id === updated.id ? updated : x)),
      };
      return {
        logs: { ...prev.logs, [u.month]: nextFile },
        undoDeleted: null,
        expandedExerciseId: u.exercise.id,
      };
    });
    if (nextFile) void persistDocToDb(s.ownerKey, monthToDocKey(u.month), nextFile, { dirty: 1 });
  },

  /** Explicitly finish and archive the active session (writes `completed`, triggers `RECENT.md` update). */
  finishActiveSession(title?: string, note?: string): WorkoutSession | null {
    const s = get();
    if (s.isReadOnlyTab) return null;
    const active = selectActiveSession(s);
    if (!active) return null;
    const month = monthFromDate(active.date);
    const now = Date.now();
    const completed: WorkoutSession = {
      ...active,
      status: 'completed',
      finishedAt: now,
      title: title !== undefined ? title.trim() || undefined : active.title,
      note: note !== undefined ? note.trim() || undefined : active.note,
      updatedAt: now,
      deviceId: s.deviceId || active.deviceId,
    };
    let nextFile!: MonthlyWorkoutLogFile;
    set((prev) => {
      const file = prev.logs[month] ?? emptyMonthlyLog(month);
      nextFile = {
        schemaVersion: 1,
        month,
        updatedAt: now,
        sessions: file.sessions.map((x) => (x.id === completed.id ? completed : x)),
      };
      return {
        logs: { ...prev.logs, [month]: nextFile },
        expandedExerciseId: null,
        focusedSetByExercise: {},
        restStartedAt: null,
        restVibrated: false,
        undoDeleted: null,
      };
    });
    void persistDocToDb(s.ownerKey, monthToDocKey(month), nextFile, { dirty: 1, writeRecent: true });
    return completed;
  },

  updateSessionMeta(sessionId: string, patch: { title?: string; note?: string }) {
    const s = get();
    if (!canMutateTarget(s)) return;
    const found = findSessionById(s.logs, sessionId);
    if (!found) return;
    const now = Date.now();
    let nextFile: MonthlyWorkoutLogFile | null = null;
    let isCompleted = false;
    set((prev) => {
      const curFound = findSessionById(prev.logs, sessionId);
      if (!curFound) return {};
      const updated: WorkoutSession = {
        ...curFound.session,
        ...(patch.title !== undefined ? { title: patch.title.trim() || undefined } : {}),
        ...(patch.note !== undefined ? { note: patch.note.trim() || undefined } : {}),
        updatedAt: now,
        deviceId: prev.deviceId || curFound.session.deviceId,
      };
      isCompleted = updated.status === 'completed';
      const file = prev.logs[curFound.month]!;
      nextFile = {
        schemaVersion: 1,
        month: curFound.month,
        updatedAt: now,
        sessions: file.sessions.map((x) => (x.id === updated.id ? updated : x)),
      };
      return { logs: { ...prev.logs, [curFound.month]: nextFile } };
    });
    if (nextFile) {
      void persistDocToDb(s.ownerKey, monthToDocKey(found.month), nextFile, {
        dirty: 1,
        writeRecent: isCompleted,
      });
    }
  },

  deleteSession(sessionId: string) {
    const s = get();
    if (s.isReadOnlyTab) return;
    const found = findSessionById(s.logs, sessionId);
    if (!found) return;
    const now = Date.now();
    let nextFile: MonthlyWorkoutLogFile | null = null;
    set((prev) => {
      const curFound = findSessionById(prev.logs, sessionId);
      if (!curFound) return {};
      const tombstoned: WorkoutSession = {
        ...curFound.session,
        deletedAt: now,
        updatedAt: now,
        deviceId: prev.deviceId || curFound.session.deviceId,
      };
      const file = prev.logs[curFound.month]!;
      nextFile = {
        schemaVersion: 1,
        month: curFound.month,
        updatedAt: now,
        sessions: file.sessions.map((x) => (x.id === tombstoned.id ? tombstoned : x)),
      };
      return {
        logs: { ...prev.logs, [curFound.month]: nextFile },
        editingHistorySessionId: prev.editingHistorySessionId === sessionId ? null : prev.editingHistorySessionId,
        expandedExerciseId: null,
      };
    });
    if (nextFile) {
      void persistDocToDb(s.ownerKey, monthToDocKey(found.month), nextFile, { dirty: 1, writeRecent: true });
    }
  },

  openHistorySession(sessionId: string, readOnly = true) {
    set({
      editingHistorySessionId: sessionId,
      editingHistoryReadOnly: readOnly,
      expandedExerciseId: null,
    });
  },

  setHistoryReadOnly(readOnly: boolean) {
    set({ editingHistoryReadOnly: readOnly });
  },

  closeHistorySession() {
    set({
      editingHistorySessionId: null,
      editingHistoryReadOnly: true,
      expandedExerciseId: null,
    });
  },
};

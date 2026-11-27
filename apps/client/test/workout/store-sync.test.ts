import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, getWorkoutDoc, kvGet, kvSet, listDirtyWorkoutDocs, putWorkoutDoc, workoutDocId } from '../../src/lib/db';
import { kesoku } from '../../src/lib/client';
import { actions } from '../../src/lib/store';
import { RpcError } from '../../src/lib/ws';
import {
  ACTIVE_IDLE_MS,
  LOCAL_ONLY_OWNER,
  isSessionActive,
  monthFromDate,
  monthToDocKey,
  type MonthlyWorkoutLogFile,
} from '../../src/features/workout/types';
import { resetWorkoutChannelForTest } from '../../src/features/workout/channel';
import { selectActiveSession, useWorkoutStore, waitForPendingPersists, workoutActions } from '../../src/features/workout/store';
import { workoutSync } from '../../src/features/workout/sync';

async function clearDb() {
  await db.workout_docs.clear();
  await db.kv.clear();
}

beforeEach(async () => {
  await clearDb();
  actions.reset();
  workoutActions.reset();
  vi.restoreAllMocks();
});

afterEach(async () => {
  workoutSync.releaseTabLock();
  await clearDb();
  vi.restoreAllMocks();
});

describe('workout store: fill-forward, set stepper, completion & clone', () => {
  it('cold-starts offline with __local_only__ ownerKey when kv is unset', async () => {
    await workoutActions.hydrate();
    expect(useWorkoutStore.getState().ownerKey).toBe(LOCAL_ONLY_OWNER);
    expect(useWorkoutStore.getState().hydrated).toBe(true);
  });

  it('fill-forward modifies focused + subsequent undone sets, never completed sets, never moves focus', async () => {
    await workoutActions.hydrate();
    workoutActions.startBlankSession('Push');
    const created = workoutActions.createTemplateAndAdd('哑铃卧推', 'dumbbell')!;
    expect(created.shouldOpenWeightPad).toBe(true);

    const exId = created.exercise.id;
    // Set exact weight 18kg (3 sets: 18/18/18, reps 10/10/10)
    workoutActions.setWeightExact(exId, 18, 'per_hand');
    workoutActions.adjustSetCount(exId, 1); // now 4 sets

    // Complete set #1 (focus moves to #2)
    workoutActions.completeFocusedSet(exId);
    expect(useWorkoutStore.getState().focusedSetByExercise[exId]).toBe(1);
    expect(useWorkoutStore.getState().restStartedAt).not.toBeNull();

    // Now adjust weight +2kg and reps -2 on focus #2 -> #1 must stay 18kg / 10 reps, #2..#4 become 20kg / 8 reps, focus stays at 1
    workoutActions.adjustWeight(exId, 2);
    workoutActions.adjustReps(exId, -2);

    const ex = selectActiveSession(useWorkoutStore.getState())!.exercises[0]!;
    expect(ex.sets.map((s) => s.weightKg)).toEqual([18, 20, 20, 20]);
    expect(ex.sets.map((s) => s.reps)).toEqual([10, 8, 8, 8]);
    expect(ex.sets[0]!.done).toBe(true);
    expect(useWorkoutStore.getState().focusedSetByExercise[exId]).toBe(1);
  });

  it('batch completeAllSets marks all done, collapses card, and does NOT trigger rest timer', async () => {
    await workoutActions.hydrate();
    workoutActions.startBlankSession();
    const { exercise } = workoutActions.createTemplateAndAdd('弯臂下压', 'cable')!;
    expect(useWorkoutStore.getState().restStartedAt).toBeNull();

    workoutActions.completeAllSets(exercise.id);
    const st = useWorkoutStore.getState();
    expect(st.expandedExerciseId).toBeNull();
    expect(st.restStartedAt).toBeNull();
    expect(selectActiveSession(st)!.exercises[0]!.sets.every((s) => s.done)).toBe(true);
  });

  it('supports 1-tap clone of completed workout and 4s undo after removing an exercise', async () => {
    await workoutActions.hydrate();
    const s1 = workoutActions.startBlankSession('Chest')!;
    const { exercise } = workoutActions.createTemplateAndAdd('卧推', 'barbell')!;
    workoutActions.setWeightExact(exercise.id, 60);
    workoutActions.completeAllSets(exercise.id);
    workoutActions.finishActiveSession('Chest', 'Felt great');

    const s2 = workoutActions.cloneSession(s1.id)!;
    expect(s2.id).not.toBe(s1.id);
    expect(s2.status).toBe('in_progress');
    expect(s2.exercises[0]!.sets.every((st) => st.weightKg === 60 && !st.done)).toBe(true);

    // Remove and undo
    const clonedExId = s2.exercises[0]!.id;
    workoutActions.removeExercise(clonedExId);
    expect(selectActiveSession(useWorkoutStore.getState())!.exercises).toHaveLength(0);
    workoutActions.undoRemoveExercise();
    expect(selectActiveSession(useWorkoutStore.getState())!.exercises).toHaveLength(1);
  });
});

describe('WorkoutSyncEngine: CAS, legacy engine, upgrade merge, workspace isolation & corrupt JSON', () => {
  function setOnline(online = true, engineOnline = true) {
    actions.setConn({ status: online ? 'online' : 'reconnecting', engineOnline });
  }

  it('legacy engine (missing workspace_id or workspace_cas) stays local-only and NEVER writes to $AWD', async () => {
    await workoutActions.hydrate();
    workoutActions.startBlankSession('Offline Workout');
    setOnline(true, true);

    const rpcSpy = vi.spyOn(kesoku, 'rpc').mockImplementation(async (type) => {
      if (type === 'workspace.list') return { rel_path: '', awd_name: 'band', entries: [] };
      throw new Error(`unexpected rpc ${type}`);
    });

    await workoutSync.probeAndSync();
    expect(useWorkoutStore.getState().engineLegacy).toBe(true);
    expect(useWorkoutStore.getState().syncStatus).toBe('local_only');
    expect(rpcSpy).toHaveBeenCalledWith('workspace.list', { rel_path: '' }, { noQueue: true });
    expect(rpcSpy.mock.calls.some((c) => c[0] === 'workspace.write')).toBe(false);
  });

  it('prompts one-time merge when upgrading from __local_only__ to real workspace_id, then merges & syncs on confirm', async () => {
    await workoutActions.hydrate();
    const sess = workoutActions.startBlankSession('Local Session')!;
    const month = monthFromDate(sess.date);
    setOnline(true, true);

    const writes: Array<Record<string, unknown>> = [];
    vi.spyOn(kesoku, 'rpc').mockImplementation(async (type, payload) => {
      if (type === 'workspace.list' && payload.rel_path === '') {
        return { rel_path: '', awd_name: 'band', workspace_id: 'ws_real_01', workspace_cas: true, entries: [] };
      }
      if (type === 'workspace.list') return { rel_path: String(payload.rel_path), entries: [] };
      if (type === 'workspace.read') throw new RpcError('NOT_FOUND', 'not found');
      if (type === 'workspace.write') {
        writes.push(payload);
        return { path: String(payload.path), name: 'file', size: 10, sha256: 'a'.repeat(64), cas: true };
      }
      return {};
    });

    await workoutSync.probeAndSync();
    expect(useWorkoutStore.getState().pendingUpgradeMerge).toEqual({
      targetOwnerKey: 'ws_real_01',
      localSessionCount: 1,
    });
    expect(writes).toHaveLength(0);

    // User confirms merge
    await workoutSync.confirmUpgradeMerge();
    expect(useWorkoutStore.getState().pendingUpgradeMerge).toBeNull();
    expect(useWorkoutStore.getState().ownerKey).toBe('ws_real_01');
    expect(await kvGet('workout_owner_key', '')).toBe('ws_real_01');
    expect(writes.some((w) => w.path === `workouts/logs/${month}.json` && w.expected_sha256 === null)).toBe(true);
  });

  it('freezes old dirty docs on genuine workspace switch and never pushes across workspaces', async () => {
    await kvSet('workout_owner_key', 'ws_old');
    await workoutActions.hydrate();
    workoutActions.startBlankSession('Old WS Workout');
    setOnline(true, true);

    const writes: Array<Record<string, unknown>> = [];
    vi.spyOn(kesoku, 'rpc').mockImplementation(async (type, payload) => {
      if (type === 'workspace.list' && payload.rel_path === '') {
        return { rel_path: '', awd_name: 'band', workspace_id: 'ws_new', workspace_cas: true, entries: [] };
      }
      if (type === 'workspace.list') return { rel_path: String(payload.rel_path), entries: [] };
      if (type === 'workspace.read') throw new RpcError('NOT_FOUND', 'missing');
      if (type === 'workspace.write') {
        writes.push(payload);
        return { path: String(payload.path), name: 'x', size: 1, sha256: 'b'.repeat(64), cas: true };
      }
      return {};
    });

    await workoutSync.probeAndSync();
    expect(useWorkoutStore.getState().ownerKey).toBe('ws_new');
    expect(useWorkoutStore.getState().frozenWorkspaceNotice).toMatchObject({
      oldOwnerKey: 'ws_old',
      newOwnerKey: 'ws_new',
      dirtyCount: 1,
    });
    expect(writes).toHaveLength(0);
    expect(await listDirtyWorkoutDocs('ws_old')).toHaveLength(1);
  });

  it('resolves CAS write conflict by reading remote, merging LWW, and retrying with server sha256', async () => {
    await kvSet('workout_owner_key', 'ws_cas');
    await workoutActions.hydrate();
    const localSess = workoutActions.startBlankSession('Local A')!;
    const month = monthFromDate(localSess.date);
    const logPath = `workouts/logs/${month}.json`;
    setOnline(true, true);

    const remoteLog: MonthlyWorkoutLogFile = {
      schemaVersion: 1,
      month,
      updatedAt: localSess.updatedAt - 1000,
      sessions: [
        {
          id: 'wk_remote_b',
          date: localSess.date,
          tzOffsetMin: 480,
          startedAt: localSess.startedAt - 10_000,
          finishedAt: localSess.startedAt - 5_000,
          status: 'completed',
          title: 'Remote B',
          exercises: [],
          updatedAt: localSess.updatedAt - 1000,
        },
      ],
    };

    let writeAttempts = 0;
    const seenExpectedShas: Array<string | null | undefined> = [];
    vi.spyOn(kesoku, 'rpc').mockImplementation(async (type, payload) => {
      if (type === 'workspace.list' && payload.rel_path === '') {
        return { rel_path: '', awd_name: 'band', workspace_id: 'ws_cas', workspace_cas: true, entries: [] };
      }
      if (type === 'workspace.list') return { rel_path: String(payload.rel_path), entries: [] };
      if (type === 'workspace.read') {
        if (payload.rel_path === logPath && writeAttempts >= 1) {
          return {
            rel_path: logPath,
            name: `${month}.json`,
            kind: 'text',
            mime: 'application/json',
            content: JSON.stringify(remoteLog),
            sha256: '1'.repeat(64),
          };
        }
        throw new RpcError('NOT_FOUND', 'missing');
      }
      if (type === 'workspace.write') {
        writeAttempts += 1;
        seenExpectedShas.push(payload.expected_sha256 as string | null | undefined);
        if (writeAttempts === 1) {
          return { conflict: true, cas: true, path: logPath, sha256: '1'.repeat(64), mtime: 100 };
        }
        return { path: logPath, name: `${month}.json`, size: 100, sha256: '2'.repeat(64), cas: true };
      }
      return {};
    });

    await workoutSync.probeAndSync();
    expect(writeAttempts).toBe(2);
    expect(seenExpectedShas).toEqual([null, '1'.repeat(64)]);
    const mergedSessions = useWorkoutStore.getState().logs[month]!.sessions;
    expect(mergedSessions.map((s) => s.id).sort()).toEqual([localSess.id, 'wk_remote_b'].sort());
    const docRow = await getWorkoutDoc('ws_cas', monthToDocKey(month));
    expect(docRow?.dirty).toBe(0);
    expect(docRow?.remoteSha256).toBe('2'.repeat(64));
  });

  it('pauses sync and preserves remote file untouched when remote JSON is corrupt', async () => {
    await kvSet('workout_owner_key', 'ws_corrupt');
    await workoutActions.hydrate();
    setOnline(true, true);

    const writes: unknown[] = [];
    vi.spyOn(kesoku, 'rpc').mockImplementation(async (type, payload) => {
      if (type === 'workspace.list' && payload.rel_path === '') {
        return { rel_path: '', awd_name: 'band', workspace_id: 'ws_corrupt', workspace_cas: true, entries: [] };
      }
      if (type === 'workspace.list') return { rel_path: String(payload.rel_path), entries: [] };
      if (type === 'workspace.read' && payload.rel_path === 'workouts/catalog.json') {
        return {
          rel_path: 'workouts/catalog.json',
          name: 'catalog.json',
          kind: 'text',
          mime: 'application/json',
          content: '{corrupt json!!!',
          sha256: '9'.repeat(64),
        };
      }
      if (type === 'workspace.read') throw new RpcError('NOT_FOUND', 'missing');
      if (type === 'workspace.write') {
        writes.push(payload);
        return { path: String(payload.path), name: 'x', size: 1, sha256: '0'.repeat(64), cas: true };
      }
      return {};
    });

    await workoutSync.probeAndSync();
    expect(useWorkoutStore.getState().syncStatus).toBe('corrupt');
    expect(useWorkoutStore.getState().corruptDocs.catalog).toBeTruthy();
    expect(writes).toHaveLength(0);
  });

  it('enforces offline history read-only and pulls before editing when online', async () => {
    await kvSet('workout_owner_key', 'ws_hist');
    await workoutActions.hydrate();
    setOnline(false, false);
    const offlineRes = await workoutSync.pullMonthForEdit('2026-11');
    expect(offlineRes).toEqual({ ok: false, reason: 'offline' });

    setOnline(true, true);
    const readSpy = vi.spyOn(kesoku, 'rpc').mockImplementation(async (type) => {
      if (type === 'workspace.read') {
        return {
          rel_path: 'workouts/logs/2026-11.json',
          name: '2026-11.json',
          kind: 'text',
          mime: 'application/json',
          content: JSON.stringify({ schemaVersion: 1, month: '2026-11', updatedAt: 100, sessions: [] }),
          sha256: '5'.repeat(64),
        };
      }
      return {};
    });
    const onlineRes = await workoutSync.pullMonthForEdit('2026-11');
    expect(onlineRes).toEqual({ ok: true });
    expect(readSpy).toHaveBeenCalledWith('workspace.read', { rel_path: 'workouts/logs/2026-11.json' }, { noQueue: true });
  });

  it('TIMEOUT sets needsReadBeforeWrite=true and forces workspace.read before next workspace.write', async () => {
    await kvSet('workout_owner_key', 'ws_timeout');
    await workoutActions.hydrate();
    const sess = workoutActions.startBlankSession('Timeout Test')!;
    const month = monthFromDate(sess.date);
    const docKey = monthToDocKey(month);
    const logPath = `workouts/logs/${month}.json`;
    setOnline(true, true);

    const callOrder: string[] = [];
    let failWriteOnce = true;
    vi.spyOn(kesoku, 'rpc').mockImplementation(async (type, payload) => {
      if (type === 'workspace.read' && payload.rel_path === logPath) {
        callOrder.push('read');
        throw new RpcError('NOT_FOUND', 'missing');
      }
      if (type === 'workspace.write' && payload.path === logPath) {
        callOrder.push('write');
        if (failWriteOnce) {
          failWriteOnce = false;
          throw new RpcError('TIMEOUT', 'workspace.write timed out');
        }
        return { path: logPath, name: `${month}.json`, size: 42, sha256: 'a'.repeat(64), cas: true };
      }
      throw new RpcError('NOT_FOUND', 'missing');
    });

    await workoutSync.flushIfReady();
    const afterTimeout = await getWorkoutDoc('ws_timeout', docKey);
    expect(afterTimeout?.dirty).toBe(1);
    expect(afterTimeout?.needsReadBeforeWrite).toBe(true);

    // Next flush MUST read before writing
    callOrder.length = 0;
    await workoutSync.flushIfReady();
    expect(callOrder).toEqual(['read', 'write']);
    const afterSuccess = await getWorkoutDoc('ws_timeout', docKey);
    expect(afterSuccess?.dirty).toBe(0);
    expect(afterSuccess?.needsReadBeforeWrite).toBe(false);
  });

  it('truncated: true aborts merge and forbids writing back', async () => {
    await kvSet('workout_owner_key', 'ws_trunc');
    await workoutActions.hydrate();
    const sess = workoutActions.startBlankSession('Truncated Test')!;
    const month = monthFromDate(sess.date);
    const docKey = monthToDocKey(month);
    const logPath = `workouts/logs/${month}.json`;
    // Force needsReadBeforeWrite so flush reads first
    await waitForPendingPersists();
    const row = (await getWorkoutDoc('ws_trunc', docKey))!;
    await putWorkoutDoc({ ...row, needsReadBeforeWrite: true });
    setOnline(true, true);

    const writes: unknown[] = [];
    vi.spyOn(kesoku, 'rpc').mockImplementation(async (type, payload) => {
      if (type === 'workspace.read' && payload.rel_path === logPath) {
        return {
          rel_path: logPath,
          name: `${month}.json`,
          kind: 'text',
          mime: 'application/json',
          content: '{"schemaVersion":1,"month":',
          truncated: true,
          sha256: '3'.repeat(64),
        };
      }
      if (type === 'workspace.write') {
        writes.push(payload);
        return { path: String(payload.path), name: 'x', size: 1, sha256: '4'.repeat(64), cas: true };
      }
      throw new RpcError('NOT_FOUND', 'missing');
    });

    const pullRes = await workoutSync.pullSingleDoc('ws_trunc', docKey);
    expect(pullRes).toEqual({ ok: false, reason: 'truncated' });
    await workoutSync.flushIfReady();
    expect(writes).toHaveLength(0);
  });

  it('first-boot NOT_FOUND for catalog.json and workouts/logs finishes with syncStatus="synced" (not "error")', async () => {
    await workoutActions.hydrate();
    setOnline(true, true);

    vi.spyOn(kesoku, 'rpc').mockImplementation(async (type, payload) => {
      if (type === 'workspace.list' && payload.rel_path === '') {
        return { rel_path: '', awd_name: 'band', workspace_id: 'ws_brand_new', workspace_cas: true, entries: [] };
      }
      if (type === 'workspace.list' && payload.rel_path === 'workouts/logs') {
        throw new RpcError('NOT_FOUND', 'workouts/logs does not exist');
      }
      if (type === 'workspace.read') {
        throw new RpcError('NOT_FOUND', 'file not found');
      }
      return {};
    });

    await workoutSync.probeAndSync();
    expect(useWorkoutStore.getState().ownerKey).toBe('ws_brand_new');
    expect(useWorkoutStore.getState().syncStatus).toBe('synced');
  });

  it('same-tab BroadcastChannel self-echo is ignored and never resets expandedExerciseId, focus, or undoDeleted', async () => {
    // Mock BroadcastChannel that delivers to all open instances (simulating real browser same-tab echo if not filtered)
    const instances = new Set<{ name: string; onmessage: ((ev: MessageEvent) => void) | null }>();
    class MockBC {
      onmessage: ((ev: MessageEvent) => void) | null = null;
      constructor(public name: string) {
        instances.add(this);
      }
      postMessage(data: unknown) {
        for (const inst of instances) {
          if (inst !== this && inst.name === this.name) {
            inst.onmessage?.({ data } as MessageEvent);
          }
        }
      }
      close() {
        instances.delete(this);
      }
    }
    const origBC = globalThis.BroadcastChannel;
    globalThis.BroadcastChannel = MockBC as unknown as typeof BroadcastChannel;
    resetWorkoutChannelForTest();

    try {
      await workoutActions.hydrate();
      await workoutSync.acquireTabLock();
      workoutActions.startBlankSession('Echo Guard');
      const ex1 = workoutActions.createTemplateAndAdd('卧推', 'barbell')!.exercise;
      const ex2 = workoutActions.createTemplateAndAdd('划船', 'barbell')!.exercise;
      workoutActions.focusSet(ex1.id, 1);
      // Remove ex2 to create an active undoDeleted bar, then adjust weight on ex1
      workoutActions.removeExercise(ex2.id);
      workoutActions.focusSet(ex1.id, 1);
      workoutActions.adjustWeight(ex1.id, 2.5);

      // Flush microtasks so any bogus echo handler would have fired
      await Promise.resolve();
      await Promise.resolve();

      const st = useWorkoutStore.getState();
      expect(st.expandedExerciseId).toBe(ex1.id);
      expect(st.focusedSetByExercise[ex1.id]).toBe(1);
      expect(st.undoDeleted?.exercise.id).toBe(ex2.id);
    } finally {
      workoutSync.releaseTabLock();
      globalThis.BroadcastChannel = origBC;
      resetWorkoutChannelForTest();
    }
  });

  it('tab lock released before navigator.locks.request resolves does NOT leak (another caller can acquire immediately)', async () => {
    let held = false;
    let triggerFirstGrant!: () => void;
    const mockLocks = {
      request: vi.fn((_name: string, _opts: unknown, cb: (lock: unknown) => Promise<void> | void) => {
        if (mockLocks.request.mock.calls.length === 1) {
          // Delay granting the first request until after releaseTabLock() has already run
          return new Promise<void>((resolve) => {
            triggerFirstGrant = () => {
              held = true;
              const ret = cb({ name: 'kesoku-workout-writer' });
              Promise.resolve(ret).then(() => {
                held = false;
                resolve();
              });
            };
          });
        }
        // Second caller tries ifAvailable: true
        if (held) return Promise.resolve(cb(null));
        held = true;
        const ret = cb({ name: 'kesoku-workout-writer' });
        return Promise.resolve(ret).then(() => {
          held = false;
        });
      }),
    };
    const origLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', { configurable: true, value: mockLocks });

    try {
      const firstPromise = workoutSync.acquireTabLock();
      // Unmount / StrictMode cleanup happens BEFORE lock is granted
      workoutSync.releaseTabLock();
      // Now the first lock finally resolves -> must release immediately!
      triggerFirstGrant();
      expect(await firstPromise).toBe(false);
      await Promise.resolve();
      expect(held).toBe(false);

      // Another caller can now acquire the lock cleanly
      let secondGotLock = false;
      await navigator.locks.request('kesoku-workout-writer', { ifAvailable: true }, (lock) => {
        secondGotLock = Boolean(lock);
      });
      expect(secondGotLock).toBe(true);
    } finally {
      workoutSync.releaseTabLock();
      if (origLocks) Object.defineProperty(navigator, 'locks', origLocks);
      else delete (navigator as unknown as Record<string, unknown>).locks;
    }
  });

  it('does not drop a flush requested while a sync is already in progress', async () => {
    await kvSet('workout_owner_key', 'ws_queue_flush');
    await workoutActions.hydrate();
    const sess = workoutActions.startBlankSession('Concurrent Flush')!;
    const month = monthFromDate(sess.date);
    const logPath = `workouts/logs/${month}.json`;
    setOnline(true, true);

    let releaseFirstWrite!: () => void;
    let writeCount = 0;
    const writtenStatuses: string[] = [];

    vi.spyOn(kesoku, 'rpc').mockImplementation(async (type, payload) => {
      if (type === 'workspace.write' && payload.path === logPath) {
        writeCount += 1;
        const parsed = JSON.parse(String(payload.content)) as MonthlyWorkoutLogFile;
        writtenStatuses.push(parsed.sessions[0]?.status ?? '');
        if (writeCount === 1) {
          await new Promise<void>((r) => {
            releaseFirstWrite = r;
          });
          return { path: logPath, name: `${month}.json`, size: 50, sha256: '1'.repeat(64), cas: true };
        }
        return { path: logPath, name: `${month}.json`, size: 60, sha256: '2'.repeat(64), cas: true };
      }
      if (type === 'workspace.write' && payload.path === 'workouts/RECENT.md') {
        return { path: 'workouts/RECENT.md', name: 'RECENT.md', size: 10 };
      }
      throw new RpcError('NOT_FOUND', 'missing');
    });

    const firstFlush = workoutSync.flushIfReady();
    // Wait until first write is in flight
    await vi.waitFor(() => expect(writeCount).toBe(1));
    // User finishes session while first write is still in flight
    workoutActions.finishActiveSession('Done', '');
    await Promise.resolve();
    // Trigger flush while syncing=true -> must set flushRequested instead of dropping
    void workoutSync.flushIfReady();
    releaseFirstWrite();
    await firstFlush;

    await vi.waitFor(() => expect(writeCount).toBe(2));
    expect(writtenStatuses).toEqual(['in_progress', 'completed']);
    const doc = await getWorkoutDoc('ws_queue_flush', monthToDocKey(month));
    expect(doc?.dirty).toBe(0);
  });

  it('P2 guards: completeFocusedSet ignores already-done set; editing expired >3h in_progress history archives it to completed; legacy switches to __local_only__', async () => {
    await kvSet('workout_owner_key', 'ws_prev');
    await workoutActions.hydrate();

    // 1. completeFocusedSet on already-done set does not overwrite doneAt or restart timer
    workoutActions.startBlankSession('Guard Test');
    const { exercise } = workoutActions.createTemplateAndAdd('卧推', 'barbell')!;
    workoutActions.completeAllSets(exercise.id);
    const origDoneAt = selectActiveSession(useWorkoutStore.getState())!.exercises[0]!.sets[0]!.doneAt;
    workoutActions.focusSet(exercise.id, 0);
    workoutActions.completeFocusedSet(exercise.id);
    expect(useWorkoutStore.getState().restStartedAt).toBeNull();
    expect(selectActiveSession(useWorkoutStore.getState())!.exercises[0]!.sets[0]!.doneAt).toBe(origDoneAt);

    // 2. Editing an expired (>3h idle) in_progress historical session archives it as completed instead of resurrecting it
    const oldTime = Date.now() - ACTIVE_IDLE_MS - 60_000;
    const oldMonth = '2026-10';
    const expiredLog: MonthlyWorkoutLogFile = {
      schemaVersion: 1,
      month: oldMonth,
      updatedAt: oldTime,
      sessions: [
        {
          id: 'wk_stale',
          date: '2026-10-15',
          tzOffsetMin: 480,
          startedAt: oldTime - 30 * 60_000,
          finishedAt: null,
          status: 'in_progress',
          exercises: [
            {
              id: 'ex_old',
              templateId: 'barbell:深蹲',
              name: '深蹲',
              equipment: 'barbell',
              weightBasis: 'total',
              sets: [{ id: 's_old', weightKg: 80, reps: 5, done: false }],
            },
          ],
          updatedAt: oldTime,
        },
      ],
    };
    await putWorkoutDoc({
      id: workoutDocId('ws_prev', monthToDocKey(oldMonth)),
      ownerKey: 'ws_prev',
      docKey: monthToDocKey(oldMonth),
      content: JSON.stringify(expiredLog),
      dirty: 0,
      remoteSha256: null,
      needsReadBeforeWrite: false,
      updatedAt: oldTime,
    });
    await workoutActions.hydrate();
    workoutActions.openHistorySession('wk_stale', false);
    workoutActions.adjustWeight('ex_old', 2.5);
    const edited = useWorkoutStore.getState().logs[oldMonth]!.sessions.find((x) => x.id === 'wk_stale')!;
    expect(edited.status).toBe('completed');
    expect(edited.finishedAt).toBe(oldTime);
    expect(isSessionActive(edited)).toBe(false);

    // 3. Legacy engine downgrade switches active ownerKey to __local_only__
    setOnline(true, true);
    vi.spyOn(kesoku, 'rpc').mockResolvedValueOnce({ rel_path: '', awd_name: 'band', entries: [] } as never);
    await workoutSync.probeAndSync();
    expect(useWorkoutStore.getState().engineLegacy).toBe(true);
    expect(useWorkoutStore.getState().ownerKey).toBe(LOCAL_ONLY_OWNER);
  });
});

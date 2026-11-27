import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, getWorkoutDoc, kvGet, kvSet, listDirtyWorkoutDocs } from '../../src/lib/db';
import { kesoku } from '../../src/lib/client';
import { actions, useStore } from '../../src/lib/store';
import { RpcError } from '../../src/lib/ws';
import {
  LOCAL_ONLY_OWNER,
  monthFromDate,
  monthToDocKey,
  type MonthlyWorkoutLogFile,
} from '../../src/features/workout/types';
import { selectActiveSession, useWorkoutStore, workoutActions } from '../../src/features/workout/store';
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
});

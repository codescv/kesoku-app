import { describe, expect, it } from 'vitest';
import {
  ACTIVE_IDLE_MS,
  TOMBSTONE_TTL_MS,
  isSessionActive,
  makeTemplateId,
  normalizeExerciseName,
  type ExerciseCatalogFile,
  type MonthlyWorkoutLogFile,
  type WorkoutSession,
} from '../../src/features/workout/types';
import {
  deriveTemplateStats,
  mergeCatalog,
  mergeMonthlyLog,
  parseCatalogJson,
  parseMonthlyLogJson,
} from '../../src/features/workout/merge';
import {
  formatRepsSequence,
  formatTzOffset,
  formatWeightSummary,
  generateRecentMarkdown,
  generateShareSummary,
} from '../../src/features/workout/format';

function makeSession(overrides: Partial<WorkoutSession> = {}): WorkoutSession {
  return {
    id: 'wk_01',
    date: '2026-11-27',
    tzOffsetMin: 480,
    startedAt: 1_795_700_000_000,
    finishedAt: 1_795_703_120_000,
    status: 'completed',
    title: '胸肩训练',
    exercises: [
      {
        id: 'ex_1',
        templateId: 'dumbbell:卧推',
        name: '卧推',
        equipment: 'dumbbell',
        weightBasis: 'per_hand',
        sets: [
          { id: 's_1', weightKg: 18, reps: 12, done: true },
          { id: 's_2', weightKg: 18, reps: 12, done: true },
          { id: 's_3', weightKg: 18, reps: 10, done: true },
          { id: 's_4', weightKg: 18, reps: 8, done: true },
        ],
      },
      {
        id: 'ex_2',
        templateId: 'cable:弯臂下压',
        name: '弯臂下压',
        equipment: 'cable',
        weightBasis: 'total',
        sets: [
          { id: 's_5', weightKg: 25, reps: 12, done: true },
          { id: 's_6', weightKg: 25, reps: 12, done: true },
          { id: 's_7', weightKg: 25, reps: 12, done: true },
          { id: 's_8', weightKg: 25, reps: 12, done: true },
        ],
      },
    ],
    deviceId: 'dev_a',
    updatedAt: 1_795_703_120_000,
    ...overrides,
  };
}

describe('workout types & runtime active check', () => {
  it('normalizes NFKC whitespace and generates deterministic template IDs', () => {
    expect(normalizeExerciseName('  Bench   Press　1 ')).toBe('bench press 1');
    expect(makeTemplateId('  卧推 ', 'dumbbell')).toBe('dumbbell:卧推');
  });

  it('computes isSessionActive purely at runtime with 3h threshold', () => {
    const now = 1_800_000_000_000;
    const active = makeSession({ status: 'in_progress', finishedAt: null, updatedAt: now - ACTIVE_IDLE_MS + 1000 });
    const expired = makeSession({ status: 'in_progress', finishedAt: null, updatedAt: now - ACTIVE_IDLE_MS - 1 });
    const done = makeSession({ status: 'completed', updatedAt: now - 1000 });
    const deleted = makeSession({ status: 'in_progress', updatedAt: now - 1000, deletedAt: now - 500 });

    expect(isSessionActive(active, now)).toBe(true);
    expect(isSessionActive(expired, now)).toBe(false);
    expect(isSessionActive(done, now)).toBe(false);
    expect(isSessionActive(deleted, now)).toBe(false);
  });
});

describe('workout merge & validation', () => {
  it('merges monthly logs by session ID using LWW updatedAt + deviceId tie-break and GCs old tombstones', () => {
    const now = 1_800_000_000_000;
    const local: MonthlyWorkoutLogFile = {
      schemaVersion: 1,
      month: '2026-11',
      updatedAt: 200,
      sessions: [
        makeSession({ id: 'wk_same', title: 'Local Newer', updatedAt: 500, deviceId: 'dev_a' }),
        makeSession({ id: 'wk_tie', title: 'Tie B', updatedAt: 300, deviceId: 'dev_b' }),
        makeSession({ id: 'wk_old_del', updatedAt: now - TOMBSTONE_TTL_MS - 10, deletedAt: now - TOMBSTONE_TTL_MS - 10 }),
        makeSession({ id: 'wk_recent_del', updatedAt: now - 1000, deletedAt: now - 1000 }),
      ],
    };
    const remote: MonthlyWorkoutLogFile = {
      schemaVersion: 1,
      month: '2026-11',
      updatedAt: 250,
      sessions: [
        makeSession({ id: 'wk_same', title: 'Remote Older', updatedAt: 400, deviceId: 'dev_z' }),
        makeSession({ id: 'wk_tie', title: 'Tie A', updatedAt: 300, deviceId: 'dev_a' }),
        makeSession({ id: 'wk_remote_only', title: 'Remote Only', updatedAt: 600, deviceId: 'dev_z' }),
      ],
    };

    const merged = mergeMonthlyLog(local, remote, now);
    const byId = new Map(merged.sessions.map((s) => [s.id, s]));
    expect(byId.get('wk_same')?.title).toBe('Local Newer');
    expect(byId.get('wk_tie')?.title).toBe('Tie B');
    expect(byId.get('wk_remote_only')?.title).toBe('Remote Only');
    expect(byId.has('wk_old_del')).toBe(false);
    expect(byId.get('wk_recent_del')?.deletedAt).toBe(now - 1000);
  });

  it('merges catalogs by template id LWW', () => {
    const a: ExerciseCatalogFile = {
      schemaVersion: 1,
      updatedAt: 100,
      templates: [{ id: 'dumbbell:卧推', name: '卧推', equipment: 'dumbbell', weightBasis: 'per_hand', stepKg: 2, createdAt: 1, updatedAt: 200 }],
    };
    const b: ExerciseCatalogFile = {
      schemaVersion: 1,
      updatedAt: 150,
      templates: [
        { id: 'dumbbell:卧推', name: '卧推', equipment: 'dumbbell', weightBasis: 'total', stepKg: 2, createdAt: 1, updatedAt: 100 },
        { id: 'barbell:深蹲', name: '深蹲', equipment: 'barbell', weightBasis: 'total', stepKg: 2.5, createdAt: 2, updatedAt: 150 },
      ],
    };
    const merged = mergeCatalog(a, b);
    expect(merged.templates).toHaveLength(2);
    expect(merged.templates.find((t) => t.id === 'dumbbell:卧推')?.weightBasis).toBe('per_hand');
  });

  it('rejects corrupt JSON and schema violations safely', () => {
    expect(parseMonthlyLogJson('{bad json').ok).toBe(false);
    expect(parseMonthlyLogJson(JSON.stringify({ schemaVersion: 2, month: '2026-11', updatedAt: 1, sessions: [] })).ok).toBe(false);
    expect(parseMonthlyLogJson(JSON.stringify({ schemaVersion: 1, month: '2026-10', updatedAt: 1, sessions: [] }), '2026-11').ok).toBe(false);
    expect(parseCatalogJson('[]').ok).toBe(false);
    const validLog = parseMonthlyLogJson(
      JSON.stringify({ schemaVersion: 1, month: '2026-11', updatedAt: 10, sessions: [makeSession()] }),
      '2026-11',
    );
    expect(validLog.ok).toBe(true);
  });

  it('derives template runtime lastUsedAt & lastExercise from recent logs without persisting into catalog', () => {
    const now = 1_795_710_000_000;
    const logs: Record<string, MonthlyWorkoutLogFile> = {
      '2026-11': {
        schemaVersion: 1,
        month: '2026-11',
        updatedAt: now,
        sessions: [
          makeSession({ id: 'wk_older', startedAt: now - 5 * 86400_000, updatedAt: now - 5 * 86400_000, finishedAt: now - 5 * 86400_000 }),
          makeSession({
            id: 'wk_newer',
            startedAt: now - 86400_000,
            updatedAt: now - 86400_000,
            finishedAt: now - 86400_000,
            exercises: [
              {
                id: 'ex_new',
                templateId: 'dumbbell:卧推',
                name: '卧推',
                equipment: 'dumbbell',
                weightBasis: 'per_hand',
                sets: [{ id: 's_9', weightKg: 20, reps: 10, done: true }],
              },
            ],
          }),
        ],
      },
    };
    const stats = deriveTemplateStats(logs, now);
    expect(stats.get('dumbbell:卧推')?.lastExercise.sets[0]?.weightKg).toBe(20);
    expect(stats.get('cable:弯臂下压')?.lastExercise.sets[0]?.weightKg).toBe(25);
  });
});

describe('workout formatting & RECENT.md generation', () => {
  it('formats uniform & non-uniform reps, weights, and timezone offsets', () => {
    expect(formatRepsSequence([
      { id: '1', weightKg: 25, reps: 12, done: true },
      { id: '2', weightKg: 25, reps: 12, done: true },
      { id: '3', weightKg: 25, reps: 12, done: true },
      { id: '4', weightKg: 25, reps: 12, done: true },
    ])).toBe('4×12');
    expect(formatRepsSequence([
      { id: '1', weightKg: 18, reps: 12, done: true },
      { id: '2', weightKg: 18, reps: 10, done: true },
      { id: '3', weightKg: 18, reps: 8, done: true },
    ])).toBe('12 / 10 / 8');
    expect(formatTzOffset(480)).toBe('UTC+8');
    expect(formatTzOffset(-300)).toBe('UTC-5');
    expect(formatTzOffset(330)).toBe('UTC+5:30');
    expect(formatWeightSummary(null, 'barbell', 'total', 'zh-CN')).toBe('— kg');
    expect(formatWeightSummary(null, 'bodyweight', 'total', 'zh-CN')).toBe('自重');
    expect(formatWeightSummary(-15, 'bodyweight', 'total', 'zh-CN')).toBe('辅助15kg');
    expect(formatWeightSummary(18, 'dumbbell', 'per_hand', 'zh-CN')).toBe('18kg(单只)');
  });

  it('generates RECENT.md with read-only header, timezone, and no volume math', () => {
    const md = generateRecentMarkdown([makeSession()]);
    expect(md).toContain('read-only for assistant');
    expect(md).toContain('## 2026-11-27 (UTC+8) · 胸肩训练（52分钟 · 8组）');
    expect(md).toContain('- 卧推 [哑铃·单只]: 18kg · 4组 · 12 / 12 / 10 / 8');
    expect(md).toContain('- 弯臂下压 [龙门架]: 25kg · 4×12');
    expect(md).not.toMatch(/总容量|volume/i);
  });

  it('generates concise share summary for composer insert', () => {
    const summary = generateShareSummary(makeSession(), 'zh-CN');
    expect(summary).toContain('2026-11-27 (UTC+8)');
    expect(summary).toContain('卧推');
  });
});

import {
  EQUIPMENT_TYPES,
  MONTH_KEY_RE,
  TOMBSTONE_TTL_MS,
  roundWeightKg,
  type EquipmentType,
  type ExerciseCatalogFile,
  type ExerciseEntry,
  type ExerciseTemplate,
  type MonthlyWorkoutLogFile,
  type SetEntry,
  type TemplateRuntimeStat,
  type WeightBasis,
  type WorkoutSession,
} from './types';

const EQ_SET = new Set<string>(EQUIPMENT_TYPES);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isEquipment(v: unknown): v is EquipmentType {
  return typeof v === 'string' && EQ_SET.has(v);
}

function isWeightBasis(v: unknown): v is WeightBasis {
  return v === 'total' || v === 'per_hand';
}

function validateSetEntry(raw: unknown): SetEntry | null {
  if (!isObj(raw)) return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (raw.weightKg !== null && !isFiniteNum(raw.weightKg)) return null;
  if (!isFiniteNum(raw.reps) || !Number.isInteger(raw.reps) || raw.reps < 1) return null;
  if (typeof raw.done !== 'boolean') return null;
  const out: SetEntry = {
    id: raw.id,
    weightKg: raw.weightKg === null ? null : roundWeightKg(raw.weightKg),
    reps: raw.reps,
    done: raw.done,
  };
  if (isFiniteNum(raw.doneAt)) out.doneAt = raw.doneAt;
  if (raw.kind === 'working' || raw.kind === 'warmup' || raw.kind === 'dropset') out.kind = raw.kind;
  if (isFiniteNum(raw.durationSec) && raw.durationSec >= 0) out.durationSec = raw.durationSec;
  return out;
}

function validateExerciseEntry(raw: unknown): ExerciseEntry | null {
  if (!isObj(raw)) return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.templateId !== 'string' || !raw.templateId) return null;
  if (typeof raw.name !== 'string' || !raw.name) return null;
  if (!isEquipment(raw.equipment)) return null;
  if (!isWeightBasis(raw.weightBasis)) return null;
  if (!Array.isArray(raw.sets)) return null;
  const sets: SetEntry[] = [];
  for (const s of raw.sets) {
    const parsed = validateSetEntry(s);
    if (!parsed) return null;
    sets.push(parsed);
  }
  const out: ExerciseEntry = {
    id: raw.id,
    templateId: raw.templateId,
    name: raw.name,
    equipment: raw.equipment,
    weightBasis: raw.weightBasis,
    sets,
  };
  if (typeof raw.note === 'string') out.note = raw.note;
  return out;
}

function validateWorkoutSession(raw: unknown): WorkoutSession | null {
  if (!isObj(raw)) return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) return null;
  if (!isFiniteNum(raw.tzOffsetMin)) return null;
  if (!isFiniteNum(raw.startedAt)) return null;
  if (raw.finishedAt !== null && !isFiniteNum(raw.finishedAt)) return null;
  if (raw.status !== 'in_progress' && raw.status !== 'completed') return null;
  if (!Array.isArray(raw.exercises)) return null;
  if (!isFiniteNum(raw.updatedAt)) return null;
  const exercises: ExerciseEntry[] = [];
  for (const ex of raw.exercises) {
    const parsed = validateExerciseEntry(ex);
    if (!parsed) return null;
    exercises.push(parsed);
  }
  const out: WorkoutSession = {
    id: raw.id,
    date: raw.date,
    tzOffsetMin: raw.tzOffsetMin,
    startedAt: raw.startedAt,
    finishedAt: raw.finishedAt,
    status: raw.status,
    exercises,
    updatedAt: raw.updatedAt,
  };
  if (typeof raw.title === 'string') out.title = raw.title;
  if (typeof raw.note === 'string') out.note = raw.note;
  if (typeof raw.deviceId === 'string') out.deviceId = raw.deviceId;
  if (raw.deletedAt === null || isFiniteNum(raw.deletedAt)) out.deletedAt = raw.deletedAt;
  return out;
}

function validateExerciseTemplate(raw: unknown): ExerciseTemplate | null {
  if (!isObj(raw)) return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.name !== 'string' || !raw.name) return null;
  if (!isEquipment(raw.equipment)) return null;
  if (!isWeightBasis(raw.weightBasis)) return null;
  if (!isFiniteNum(raw.stepKg) || raw.stepKg <= 0) return null;
  if (!isFiniteNum(raw.createdAt) || !isFiniteNum(raw.updatedAt)) return null;
  const out: ExerciseTemplate = {
    id: raw.id,
    name: raw.name,
    equipment: raw.equipment,
    weightBasis: raw.weightBasis,
    stepKg: roundWeightKg(raw.stepKg),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
  if (typeof raw.archived === 'boolean') out.archived = raw.archived;
  return out;
}

export type ParseResult<T> = { ok: true; data: T } | { ok: false; error: string };

export function parseMonthlyLogJson(raw: string, expectedMonth?: string): ParseResult<MonthlyWorkoutLogFile> {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isObj(obj)) return { ok: false, error: 'root must be an object' };
  if (obj.schemaVersion !== 1) return { ok: false, error: `unsupported schemaVersion: ${String(obj.schemaVersion)}` };
  if (typeof obj.month !== 'string' || !MONTH_KEY_RE.test(obj.month)) {
    return { ok: false, error: `invalid month: ${String(obj.month)}` };
  }
  if (expectedMonth && obj.month !== expectedMonth) {
    return { ok: false, error: `month mismatch: expected ${expectedMonth}, got ${obj.month}` };
  }
  if (!isFiniteNum(obj.updatedAt)) return { ok: false, error: 'invalid updatedAt' };
  if (!Array.isArray(obj.sessions)) return { ok: false, error: 'sessions must be an array' };
  const sessions: WorkoutSession[] = [];
  for (let i = 0; i < obj.sessions.length; i++) {
    const s = validateWorkoutSession(obj.sessions[i]);
    if (!s) return { ok: false, error: `invalid session at index ${i}` };
    sessions.push(s);
  }
  return {
    ok: true,
    data: {
      schemaVersion: 1,
      month: obj.month,
      updatedAt: obj.updatedAt,
      sessions,
    },
  };
}

export function parseCatalogJson(raw: string): ParseResult<ExerciseCatalogFile> {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isObj(obj)) return { ok: false, error: 'root must be an object' };
  if (obj.schemaVersion !== 1) return { ok: false, error: `unsupported schemaVersion: ${String(obj.schemaVersion)}` };
  if (!isFiniteNum(obj.updatedAt)) return { ok: false, error: 'invalid updatedAt' };
  if (!Array.isArray(obj.templates)) return { ok: false, error: 'templates must be an array' };
  const templates: ExerciseTemplate[] = [];
  for (let i = 0; i < obj.templates.length; i++) {
    const tpl = validateExerciseTemplate(obj.templates[i]);
    if (!tpl) return { ok: false, error: `invalid template at index ${i}` };
    templates.push(tpl);
  }
  return {
    ok: true,
    data: {
      schemaVersion: 1,
      updatedAt: obj.updatedAt,
      templates,
    },
  };
}

function pickWinningSession(a: WorkoutSession, b: WorkoutSession): WorkoutSession {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  const da = a.deviceId ?? '';
  const db = b.deviceId ?? '';
  if (da !== db) return da > db ? a : b;
  // Deterministic fallback when both timestamps & deviceIds match
  if (a.deletedAt && !b.deletedAt) return a;
  if (b.deletedAt && !a.deletedAt) return b;
  return a;
}

/**
 * Session-level LWW union by `WorkoutSession.id`.
 * Conflict resolution picks higher `updatedAt` (tie-break on `deviceId`), and GCs tombstones older than 90 days.
 */
export function mergeMonthlyLog(
  local: MonthlyWorkoutLogFile,
  remote: MonthlyWorkoutLogFile,
  now = Date.now(),
): MonthlyWorkoutLogFile {
  const map = new Map<string, WorkoutSession>();
  for (const s of remote.sessions) map.set(s.id, s);
  for (const s of local.sessions) {
    const prev = map.get(s.id);
    map.set(s.id, prev ? pickWinningSession(s, prev) : s);
  }
  const sessions = [...map.values()]
    .filter((s) => !(typeof s.deletedAt === 'number' && now - s.deletedAt > TOMBSTONE_TTL_MS))
    .sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));

  const maxSessionTs = sessions.reduce((m, s) => Math.max(m, s.updatedAt), 0);
  return {
    schemaVersion: 1,
    month: local.month || remote.month,
    updatedAt: Math.max(local.updatedAt, remote.updatedAt, maxSessionTs),
    sessions,
  };
}

/** Template-level LWW union by deterministic `ExerciseTemplate.id`. */
export function mergeCatalog(local: ExerciseCatalogFile, remote: ExerciseCatalogFile): ExerciseCatalogFile {
  const map = new Map<string, ExerciseTemplate>();
  for (const tpl of remote.templates) map.set(tpl.id, tpl);
  for (const tpl of local.templates) {
    const prev = map.get(tpl.id);
    if (!prev || tpl.updatedAt >= prev.updatedAt) map.set(tpl.id, tpl);
  }
  const templates = [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
  const maxTs = templates.reduce((m, tpl) => Math.max(m, tpl.updatedAt), 0);
  return {
    schemaVersion: 1,
    updatedAt: Math.max(local.updatedAt, remote.updatedAt, maxTs),
    templates,
  };
}

/**
 * Derive per-template `lastUsedAt` and `lastPerformed` snapshot at runtime from recent ~3 months of logs.
 * Never persisted into `catalog.json`.
 */
export function deriveTemplateStats(
  logs: Record<string, MonthlyWorkoutLogFile>,
  now = Date.now(),
  lookbackDays = 95,
): Map<string, TemplateRuntimeStat> {
  const cutoff = now - lookbackDays * 24 * 3600 * 1000;
  const stats = new Map<string, TemplateRuntimeStat>();
  const allSessions: WorkoutSession[] = [];
  for (const file of Object.values(logs)) {
    for (const s of file.sessions) {
      if (s.deletedAt) continue;
      if (s.startedAt < cutoff && s.updatedAt < cutoff) continue;
      allSessions.push(s);
    }
  }
  // Sort newest first so the first encounter is the latest usage
  allSessions.sort((a, b) => b.startedAt - a.startedAt || b.updatedAt - a.updatedAt);

  for (const s of allSessions) {
    const usedAt = s.finishedAt ?? s.updatedAt ?? s.startedAt;
    for (let i = s.exercises.length - 1; i >= 0; i--) {
      const ex = s.exercises[i]!;
      const prev = stats.get(ex.templateId);
      if (!prev || usedAt > prev.lastUsedAt) {
        stats.set(ex.templateId, { lastUsedAt: usedAt, lastExercise: ex });
      }
    }
  }
  return stats;
}

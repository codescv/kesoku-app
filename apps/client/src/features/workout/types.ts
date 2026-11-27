import { ulid } from '@kesoku/protocol';

export type EquipmentType =
  | 'barbell'
  | 'dumbbell'
  | 'cable'
  | 'machine'
  | 'smith'
  | 'kettlebell'
  | 'bodyweight'
  | 'other';

export const EQUIPMENT_TYPES: readonly EquipmentType[] = [
  'dumbbell',
  'barbell',
  'cable',
  'machine',
  'smith',
  'kettlebell',
  'bodyweight',
  'other',
] as const;

export type WeightBasis = 'total' | 'per_hand';
export type SetKind = 'working' | 'warmup' | 'dropset';

export const LOCAL_ONLY_OWNER = '__local_only__';
export const ACTIVE_IDLE_MS = 3 * 3600 * 1000;
export const TOMBSTONE_TTL_MS = 90 * 24 * 3600 * 1000;
export const MONTH_KEY_RE = /^\d{4}-\d{2}$/;
export const MONTH_LOG_FILE_RE = /^\d{4}-\d{2}\.json$/;
export const REST_TARGET_OPTIONS = [60, 90, 120, 180, 0] as const;
export const DEFAULT_REST_TARGET_SEC = 90;

export const DEFAULT_STEP_KG: Record<EquipmentType, number> = {
  barbell: 2.5,
  dumbbell: 2,
  cable: 5,
  machine: 5,
  smith: 2.5,
  kettlebell: 2,
  bodyweight: 2.5,
  other: 5,
};

export const DEFAULT_WEIGHT_BASIS: Record<EquipmentType, WeightBasis> = {
  barbell: 'total',
  dumbbell: 'per_hand',
  cable: 'total',
  machine: 'total',
  smith: 'total',
  kettlebell: 'per_hand',
  bodyweight: 'total',
  other: 'total',
};

export function supportsWeightBasisToggle(eq: EquipmentType): boolean {
  return eq === 'dumbbell' || eq === 'kettlebell';
}

export function normalizeExerciseName(raw: string): string {
  return raw.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Deterministic template ID across devices (e.g. "dumbbell:卧推"); V1 does not support renaming. */
export function makeTemplateId(name: string, equipment: EquipmentType): string {
  return `${equipment}:${normalizeExerciseName(name)}`;
}

export interface SetEntry {
  id: string; // "s_<8hex>"
  weightKg: number | null; // 2 decimal places; non-BW null = "— kg"; BW null = pure BW, >0 weighted, <0 assisted
  reps: number; // positive integer >= 1
  done: boolean;
  doneAt?: number; // epoch ms
  kind?: SetKind;
  durationSec?: number;
}

export interface ExerciseEntry {
  id: string; // "ex_<ULID>"
  templateId: string;
  name: string;
  equipment: EquipmentType;
  weightBasis: WeightBasis;
  sets: SetEntry[];
  note?: string;
}

export interface WorkoutSession {
  id: string; // "wk_<ULID>"
  date: string; // local date at workout start "YYYY-MM-DD"
  tzOffsetMin: number; // offset relative to UTC in minutes (e.g. UTC+8 = 480)
  startedAt: number; // epoch ms
  finishedAt: number | null; // written only on explicit Finish
  status: 'in_progress' | 'completed';
  title?: string;
  exercises: ExerciseEntry[];
  note?: string;
  deviceId?: string;
  updatedAt: number; // epoch ms (session-level LWW & 3h active check)
  deletedAt?: number | null; // tombstone retained for 90 days then GC'd
}

export interface MonthlyWorkoutLogFile {
  schemaVersion: 1;
  month: string; // "YYYY-MM"
  updatedAt: number;
  sessions: WorkoutSession[];
}

export interface ExerciseTemplate {
  id: string; // makeTemplateId(name, equipment)
  name: string;
  equipment: EquipmentType;
  weightBasis: WeightBasis;
  stepKg: number;
  archived?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ExerciseCatalogFile {
  schemaVersion: 1;
  updatedAt: number;
  templates: ExerciseTemplate[];
}

export interface TemplateRuntimeStat {
  lastUsedAt: number;
  lastExercise: ExerciseEntry;
}

export function roundWeightKg(n: number): number {
  const rounded = Math.round(n * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Pure runtime active check — NEVER written back to monthly logs on timeout. */
export function isSessionActive(s: WorkoutSession | null | undefined, now = Date.now()): boolean {
  if (!s) return false;
  if (s.deletedAt) return false;
  if (s.status !== 'in_progress') return false;
  return now - s.updatedAt < ACTIVE_IDLE_MS;
}

export function newSetId(): string {
  const bytes = new Uint8Array(4);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 4; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `s_${hex}`;
}

export function newExerciseId(): string {
  return `ex_${ulid()}`;
}

export function newSessionId(): string {
  return `wk_${ulid()}`;
}

export function newDeviceId(): string {
  return `wkd_${ulid()}`;
}

export function emptyCatalog(now = 0): ExerciseCatalogFile {
  return { schemaVersion: 1, updatedAt: now, templates: [] };
}

export function emptyMonthlyLog(month: string, now = 0): MonthlyWorkoutLogFile {
  return { schemaVersion: 1, month, updatedAt: now, sessions: [] };
}

export function docKeyToPath(docKey: string): string {
  if (docKey === 'catalog') return 'workouts/catalog.json';
  if (docKey.startsWith('log:')) return `workouts/logs/${docKey.slice(4)}.json`;
  return `workouts/${docKey}`;
}

export function monthToDocKey(month: string): string {
  return `log:${month}`;
}

export function localDateString(ts = Date.now()): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function monthFromDate(date: string): string {
  return date.slice(0, 7);
}

export function localTzOffsetMin(ts = Date.now()): number {
  return -new Date(ts).getTimezoneOffset();
}

import { getUiLocale, t, type MessageKey, type ResolvedLocale } from '@kesoku/ui';
import {
  roundWeightKg,
  supportsWeightBasisToggle,
  type EquipmentType,
  type ExerciseEntry,
  type SetEntry,
  type WeightBasis,
  type WorkoutSession,
} from './types';

export function formatNumberCompact(n: number): string {
  const r = roundWeightKg(n);
  if (Number.isInteger(r)) return String(r);
  return String(r);
}

export function equipmentLabel(eq: EquipmentType, locale?: ResolvedLocale): string {
  return t(`workout.eq.${eq}` as MessageKey, undefined, locale);
}

export function formatWeightValue(weightKg: number | null, equipment: EquipmentType, locale?: ResolvedLocale): string {
  if (weightKg === null) {
    return equipment === 'bodyweight' ? t('workout.bodyweight', undefined, locale) : '—';
  }
  if (equipment === 'bodyweight') {
    if (weightKg === 0) return t('workout.bodyweight', undefined, locale);
    return weightKg > 0 ? `+${formatNumberCompact(weightKg)}` : formatNumberCompact(weightKg);
  }
  return formatNumberCompact(weightKg);
}

export function formatWeightSummary(
  weightKg: number | null,
  equipment: EquipmentType,
  weightBasis: WeightBasis,
  locale?: ResolvedLocale,
): string {
  const basisSuffix =
    supportsWeightBasisToggle(equipment) && weightKg !== null
      ? `(${t(weightBasis === 'per_hand' ? 'workout.perHand' : 'workout.totalWeight', undefined, locale)})`
      : '';
  if (weightKg === null) {
    if (equipment === 'bodyweight') return t('workout.bodyweight', undefined, locale);
    return '— kg';
  }
  if (equipment === 'bodyweight') {
    if (weightKg === 0) return t('workout.bodyweight', undefined, locale);
    if (weightKg > 0) return `${t('workout.bodyweight', undefined, locale)}+${formatNumberCompact(weightKg)}kg`;
    return `${t('workout.assisted', undefined, locale)}${formatNumberCompact(Math.abs(weightKg))}kg`;
  }
  return `${formatNumberCompact(weightKg)}kg${basisSuffix}`;
}

/** Compact reps formatting: uniform `[12,12,12,12]` -> `"4×12"`, non-uniform -> `"12 / 12 / 10 / 8"`. */
export function formatRepsSequence(sets: readonly SetEntry[]): string {
  if (!sets.length) return '0';
  const reps = sets.map((s) => s.reps);
  const allSame = reps.every((r) => r === reps[0]);
  if (allSame && reps.length > 1) return `${reps.length}×${reps[0]}`;
  return reps.join(' / ');
}

/** Compact inline summary for collapsed cards and QuickAdd last-performed preview. */
export function formatExerciseInlineSummary(ex: ExerciseEntry, locale?: ResolvedLocale): string {
  const sets = ex.sets;
  if (!sets.length) return '';
  const weights = sets.map((s) => s.weightKg);
  const sameWeight = weights.every((w) => w === weights[0]);
  if (sameWeight) {
    const w = formatWeightSummary(weights[0] ?? null, ex.equipment, ex.weightBasis, locale);
    const repsStr = formatRepsSequence(sets);
    const isUniform = sets.length > 1 && sets.every((s) => s.reps === sets[0]!.reps);
    if (isUniform) return `${w} · ${repsStr}`;
    return `${w} · ${t('workout.setsCount', { n: sets.length }, locale)} · ${repsStr}`;
  }
  return sets
    .map((s) => {
      const w = s.weightKg === null ? (ex.equipment === 'bodyweight' ? t('workout.bodyweight', undefined, locale) : '—') : `${formatNumberCompact(s.weightKg)}kg`;
      return `${w}×${s.reps}`;
    })
    .join(' / ');
}

export function formatTzOffset(tzOffsetMin: number): string {
  const sign = tzOffsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(Math.round(tzOffsetMin));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(m).padStart(2, '0')}`;
}

export function sessionDurationMinutes(startedAt: number, finishedAt: number | null, updatedAt: number): number {
  const end = finishedAt ?? updatedAt;
  return Math.max(1, Math.round(Math.max(0, end - startedAt) / 60_000));
}

export function formatRestElapsed(sec: number): string {
  const clamped = Math.max(0, Math.floor(sec));
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatShortDate(date: string): string {
  const parts = date.split('-');
  if (parts.length === 3) return `${parts[1]}/${parts[2]}`;
  return date;
}

const ZH_EQ: Record<EquipmentType, string> = {
  barbell: '杠铃',
  dumbbell: '哑铃',
  cable: '龙门架',
  machine: '固定器械',
  smith: '史密斯',
  kettlebell: '壶铃',
  bodyweight: '自重',
  other: '其他',
};

function formatExerciseLineForRecentMd(ex: ExerciseEntry): string {
  const eq = ZH_EQ[ex.equipment] ?? ex.equipment;
  const basis = supportsWeightBasisToggle(ex.equipment) ? `·${ex.weightBasis === 'per_hand' ? '单只' : '双只总重'}` : '';
  const doneSets = ex.sets.filter((s) => s.done);
  const sets = doneSets.length ? doneSets : ex.sets;
  if (!sets.length) return `- ${ex.name} [${eq}${basis}]: 0组`;

  const sameWeight = sets.every((s) => s.weightKg === sets[0]!.weightKg);
  if (sameWeight) {
    const wVal = sets[0]!.weightKg;
    const wText =
      wVal === null
        ? ex.equipment === 'bodyweight'
          ? '自重'
          : '— kg'
        : ex.equipment === 'bodyweight'
          ? wVal === 0
            ? '自重'
            : wVal > 0
              ? `自重+${formatNumberCompact(wVal)}kg`
              : `辅助${formatNumberCompact(Math.abs(wVal))}kg`
          : `${formatNumberCompact(wVal)}kg`;
    const isUniform = sets.length > 1 && sets.every((s) => s.reps === sets[0]!.reps);
    const repsText = isUniform ? `${sets.length}×${sets[0]!.reps}` : `${sets.length}组 · ${sets.map((s) => s.reps).join(' / ')}`;
    return `- ${ex.name} [${eq}${basis}]: ${wText} · ${repsText}`;
  }
  const perSet = sets
    .map((s) => {
      const w = s.weightKg === null ? (ex.equipment === 'bodyweight' ? '自重' : '—') : `${formatNumberCompact(s.weightKg)}kg`;
      return `${w}×${s.reps}`;
    })
    .join(' / ');
  return `- ${ex.name} [${eq}${basis}]: ${sets.length}组 · ${perSet}`;
}

/** Generate `$AWD/workouts/RECENT.md` (read-only digest for the AI assistant; max 10 recent sessions, no volume math). */
export function generateRecentMarkdown(allSessions: readonly WorkoutSession[], limit = 10): string {
  const header =
    '<!-- auto-generated by Kesoku Workout Helper (read-only for assistant); source: workouts/logs/*.json -->\n# 最近训练记录\n';
  const eligible = allSessions
    .filter((s) => !s.deletedAt && (s.status === 'completed' || s.exercises.some((e) => e.sets.some((st) => st.done))))
    .sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id))
    .slice(0, limit);

  if (!eligible.length) {
    return `${header}\n（暂无训练记录）\n`;
  }

  const blocks = eligible.map((s) => {
    const tz = formatTzOffset(s.tzOffsetMin);
    const title = (s.title || '').trim() || '力量训练';
    const dur = sessionDurationMinutes(s.startedAt, s.finishedAt, s.updatedAt);
    const totalDoneSets = s.exercises.reduce((acc, ex) => {
      const done = ex.sets.filter((st) => st.done).length;
      return acc + (done > 0 ? done : ex.sets.length);
    }, 0);
    const lines: string[] = [`## ${s.date} (${tz}) · ${title}（${dur}分钟 · ${totalDoneSets}组）`];
    for (const ex of s.exercises) {
      lines.push(formatExerciseLineForRecentMd(ex));
    }
    if (s.note?.trim()) {
      lines.push(`> 备注：${s.note.trim().replace(/\n+/g, ' ')}`);
    }
    return lines.join('\n');
  });

  return `${header}\n${blocks.join('\n\n')}\n`;
}

/** Generate concise user message for "发给助手点评" (Composer insert). */
export function generateShareSummary(session: WorkoutSession, locale: ResolvedLocale = getUiLocale()): string {
  const prefix = t('workout.askPromptPrefix', undefined, locale);
  const tz = formatTzOffset(session.tzOffsetMin);
  const title = (session.title || '').trim() || t('workout.defaultSessionTitle', undefined, locale);
  const dur = sessionDurationMinutes(session.startedAt, session.finishedAt, session.updatedAt);
  const lines: string[] = [
    prefix,
    `${session.date} (${tz}) · ${title} (${t('workout.durationMin', { m: dur }, locale)})`,
  ];
  for (const ex of session.exercises) {
    const eq = equipmentLabel(ex.equipment, locale);
    const summary = formatExerciseInlineSummary(ex, locale);
    lines.push(`- ${ex.name} [${eq}]: ${summary}`);
  }
  if (session.note?.trim()) {
    lines.push(`${t('workout.sessionNoteLabel', undefined, locale)}: ${session.note.trim()}`);
  }
  return lines.join('\n');
}

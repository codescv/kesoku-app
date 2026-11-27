import { UiIcon, useLocale, useT } from '@kesoku/ui';
import { hapticTap } from '../../native/haptics';
import { equipmentLabel, formatExerciseInlineSummary, formatNumberCompact } from './format';
import { type ExerciseEntry } from './types';

export interface ActiveExerciseCardProps {
  exercise: ExerciseEntry;
  focusedSetIndex: number;
  lastPerformed: ExerciseEntry | null;
  readOnly?: boolean;
  onTapSet: (setIndex: number) => void;
  onCollapse: () => void;
  onRemove: () => void;
}

export function ActiveExerciseCard({
  exercise,
  focusedSetIndex,
  lastPerformed,
  readOnly = false,
  onTapSet,
  onCollapse,
  onRemove,
}: ActiveExerciseCardProps) {
  const locale = useLocale();
  const tr = useT();
  const eqText = equipmentLabel(exercise.equipment, locale);
  const lastSummary = lastPerformed ? formatExerciseInlineSummary(lastPerformed, locale) : null;

  return (
    <article className="k-wk-card is-active" data-testid={`active-exercise-${exercise.id}`}>
      <header className="k-wk-card-head">
        <div className="k-wk-card-title-group">
          <span className="k-wk-active-dot" aria-hidden />
          <h2 className="k-wk-card-name">{exercise.name}</h2>
          <span className="k-wk-eq-tag">{eqText}</span>
        </div>
        <div className="k-wk-card-head-actions">
          {!readOnly && (
            <button
              type="button"
              className="k-wk-mini-btn is-danger"
              aria-label={tr('workout.removeExerciseAria', { name: exercise.name })}
              data-testid="exercise-remove-btn"
              onClick={() => {
                void hapticTap();
                onRemove();
              }}
            >
              <UiIcon name="trash" size={16} />
            </button>
          )}
          <button
            type="button"
            className="k-wk-mini-btn"
            aria-label={tr('workout.collapseExerciseAria', { name: exercise.name })}
            data-testid="exercise-collapse-btn"
            onClick={() => {
              void hapticTap();
              onCollapse();
            }}
          >
            <UiIcon name="chevron-down" size={18} />
          </button>
        </div>
      </header>

      <div className="k-wk-last-row">
        {lastSummary ? tr('workout.lastPerformed', { summary: lastSummary }) : tr('workout.noHistory')}
      </div>

      <div className="k-wk-set-grid" role="list" aria-label={exercise.name}>
        {exercise.sets.map((st, idx) => {
          const isFocused = idx === focusedSetIndex && !readOnly;
          const weightText =
            st.weightKg === null
              ? exercise.equipment === 'bodyweight'
                ? tr('workout.bodyweight')
                : '—'
              : exercise.equipment === 'bodyweight'
                ? st.weightKg > 0
                  ? `+${formatNumberCompact(st.weightKg)}`
                  : formatNumberCompact(st.weightKg)
                : `${formatNumberCompact(st.weightKg)}`;
          return (
            <button
              key={st.id}
              type="button"
              role="listitem"
              disabled={readOnly}
              data-testid={`set-capsule-${idx + 1}`}
              aria-pressed={st.done}
              aria-current={isFocused ? 'step' : undefined}
              className={
                'k-wk-set-capsule' +
                (st.done ? ' is-done' : '') +
                (isFocused ? ' is-focused' : '')
              }
              onClick={() => {
                void hapticTap();
                onTapSet(idx);
              }}
            >
              <span className="k-wk-set-idx">
                {st.done ? '✓' : isFocused ? '▶' : ''}#{idx + 1}
              </span>
              <span className="k-wk-set-val">
                <b>{st.reps}</b>
                <small>{weightText}</small>
              </span>
            </button>
          );
        })}
      </div>
    </article>
  );
}

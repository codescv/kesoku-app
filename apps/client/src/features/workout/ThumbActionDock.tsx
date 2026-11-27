import { UiIcon, useLocale, useT } from '@kesoku/ui';
import { hapticSuccess, hapticTap } from '../../native/haptics';
import { formatWeightValue } from './format';
import { DEFAULT_STEP_KG, supportsWeightBasisToggle, type ExerciseEntry } from './types';

export interface ThumbActionDockProps {
  exercise: ExerciseEntry | null;
  focusedSetIndex: number;
  stepKg?: number;
  readOnly?: boolean;
  onAddExercise: () => void;
  onAdjustWeight: (delta: number) => void;
  onOpenWeightPad: () => void;
  onAdjustSetCount: (delta: 1 | -1) => void;
  onAdjustReps: (delta: number) => void;
  onOpenRepsPad: () => void;
  onCompleteSet: () => void;
  onCompleteAll: () => void;
  onCollapseDone: () => void;
}

/**
 * 2-row 120px compact thumb dock (fits 375px screens with >=44px hit targets and zero overflow across zh/en/ja).
 * Collapses to a single 52px "+ Add Exercise" bar when no exercise is expanded.
 */
export function ThumbActionDock({
  exercise,
  focusedSetIndex,
  stepKg,
  readOnly = false,
  onAddExercise,
  onAdjustWeight,
  onOpenWeightPad,
  onAdjustSetCount,
  onAdjustReps,
  onOpenRepsPad,
  onCompleteSet,
  onCompleteAll,
  onCollapseDone,
}: ThumbActionDockProps) {
  const locale = useLocale();
  const tr = useT();

  if (readOnly) return null;

  if (!exercise) {
    return (
      <div className="k-wk-dock is-collapsed" data-testid="workout-dock-collapsed">
        <button
          type="button"
          className="k-wk-dock-add-btn"
          data-testid="dock-add-exercise"
          onClick={() => {
            void hapticTap();
            onAddExercise();
          }}
        >
          <UiIcon name="plus" size={20} />
          <span>{tr('workout.addExercise')}</span>
        </button>
      </div>
    );
  }

  const sets = exercise.sets;
  const safeFocus = Math.min(Math.max(0, focusedSetIndex), Math.max(0, sets.length - 1));
  const focused = sets[safeFocus];
  const doneCount = sets.filter((s) => s.done).length;
  const allDone = sets.length > 0 && doneCount === sets.length;
  const hasUndone = sets.some((s) => !s.done);
  const effectiveStep = stepKg ?? DEFAULT_STEP_KG[exercise.equipment];

  const weightUnitLabel = supportsWeightBasisToggle(exercise.equipment)
    ? exercise.weightBasis === 'per_hand'
      ? tr('workout.kgPerHand')
      : tr('workout.kgTotal')
    : exercise.equipment === 'bodyweight'
      ? focused?.weightKg !== null && focused && focused.weightKg < 0
        ? tr('workout.assisted')
        : tr('workout.kgUnit')
      : tr('workout.kgUnit');

  const weightValText = focused ? formatWeightValue(focused.weightKg, exercise.equipment, locale) : '—';
  const weightMinusDisabled =
    !focused || focused.done || (exercise.equipment !== 'bodyweight' && focused.weightKg === null);
  const weightPlusDisabled = !focused || focused.done;
  const repsMinusDisabled = !focused || focused.done || focused.reps <= 1;
  const repsPlusDisabled = !focused || focused.done;
  const setsMinusDisabled = sets.length <= 1 || !hasUndone;
  const setsPlusDisabled = sets.length >= 20;

  return (
    <div className="k-wk-dock is-expanded" data-testid="workout-dock-expanded">
      {/* Row 1 (46px): Weight stepper [215] + Sets stepper [128] */}
      <div className="k-wk-dock-row k-wk-dock-row-1">
        <div className="k-wk-stepper k-wk-stepper-weight">
          <button
            type="button"
            className="k-wk-step-btn"
            disabled={weightMinusDisabled}
            aria-label={tr('workout.weightDownAria')}
            data-testid="dock-weight-minus"
            onClick={() => {
              void hapticTap();
              onAdjustWeight(-effectiveStep);
            }}
          >
            −
          </button>
          <button
            type="button"
            className="k-wk-step-center"
            disabled={!focused || focused.done}
            aria-label={tr('workout.editWeightAria')}
            data-testid="dock-weight-display"
            onClick={() => {
              void hapticTap();
              onOpenWeightPad();
            }}
          >
            <span className="k-wk-unit-top">{weightUnitLabel}</span>
            <span className="k-wk-val-main">{weightValText}</span>
          </button>
          <button
            type="button"
            className="k-wk-step-btn"
            disabled={weightPlusDisabled}
            aria-label={tr('workout.weightUpAria')}
            data-testid="dock-weight-plus"
            onClick={() => {
              void hapticTap();
              onAdjustWeight(effectiveStep);
            }}
          >
            +
          </button>
        </div>

        <div className="k-wk-stepper k-wk-stepper-sets">
          <button
            type="button"
            className="k-wk-step-btn is-compact"
            disabled={setsMinusDisabled}
            aria-label={tr('workout.setsDownAria')}
            data-testid="dock-sets-minus"
            onClick={() => {
              void hapticTap();
              onAdjustSetCount(-1);
            }}
          >
            −
          </button>
          <div className="k-wk-step-center is-static" data-testid="dock-sets-display">
            <span className="k-wk-unit-top">{tr('workout.setsUnit')}</span>
            <span className="k-wk-val-main">{sets.length}</span>
          </div>
          <button
            type="button"
            className="k-wk-step-btn is-compact"
            disabled={setsPlusDisabled}
            aria-label={tr('workout.setsUpAria')}
            data-testid="dock-sets-plus"
            onClick={() => {
              void hapticTap();
              onAdjustSetCount(1);
            }}
          >
            +
          </button>
        </div>
      </div>

      {/* Row 2 (48px): Reps stepper [144] + CTA zone [201] */}
      <div className="k-wk-dock-row k-wk-dock-row-2">
        <div className="k-wk-stepper k-wk-stepper-reps">
          <button
            type="button"
            className="k-wk-step-btn is-compact"
            disabled={repsMinusDisabled}
            aria-label={tr('workout.repsDownAria')}
            data-testid="dock-reps-minus"
            onClick={() => {
              void hapticTap();
              onAdjustReps(-1);
            }}
          >
            −1
          </button>
          <button
            type="button"
            className="k-wk-step-center"
            aria-label={tr('workout.editRepsSeqAria')}
            data-testid="dock-reps-display"
            onClick={() => {
              void hapticTap();
              onOpenRepsPad();
            }}
          >
            <span className="k-wk-unit-top">{tr('workout.repsUnit')} ⌨</span>
            <span className="k-wk-val-main">{focused?.reps ?? 10}</span>
          </button>
          <button
            type="button"
            className="k-wk-step-btn is-compact"
            disabled={repsPlusDisabled}
            aria-label={tr('workout.repsUpAria')}
            data-testid="dock-reps-plus"
            onClick={() => {
              void hapticTap();
              onAdjustReps(1);
            }}
          >
            +1
          </button>
        </div>

        <div className="k-wk-cta-zone">
          {allDone ? (
            <button
              type="button"
              className="k-wk-cta is-done-collapse"
              data-testid="dock-collapse-done"
              onClick={() => {
                void hapticTap();
                onCollapseDone();
              }}
            >
              <span className="k-wk-cta-label">{tr('workout.allDoneCollapse')}</span>
            </button>
          ) : doneCount === 0 ? (
            <>
              <button
                type="button"
                className="k-wk-cta is-batch"
                data-testid="dock-complete-all"
                onClick={() => {
                  void hapticSuccess();
                  onCompleteAll();
                }}
              >
                <span className="k-wk-cta-label">{tr('workout.completeAll', { n: sets.length })}</span>
              </button>
              <button
                type="button"
                className="k-wk-cta is-primary"
                data-testid="dock-complete-set"
                onClick={() => {
                  void hapticSuccess();
                  onCompleteSet();
                }}
              >
                <span className="k-wk-cta-label">{tr('workout.completeSet', { n: safeFocus + 1 })}</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              className="k-wk-cta is-primary is-wide"
              data-testid="dock-complete-set"
              onClick={() => {
                void hapticSuccess();
                onCompleteSet();
              }}
            >
              <span className="k-wk-cta-label">{tr('workout.completeSet', { n: safeFocus + 1 })}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

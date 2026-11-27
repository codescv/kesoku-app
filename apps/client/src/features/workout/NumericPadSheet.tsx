import { useEffect, useState } from 'react';
import { Sheet, useT } from '@kesoku/ui';
import { hapticSuccess, hapticTap } from '../../native/haptics';
import {
  newSetId,
  roundWeightKg,
  supportsWeightBasisToggle,
  type ExerciseEntry,
  type SetEntry,
  type WeightBasis,
} from './types';

interface DraftSet extends SetEntry {
  provisional?: boolean;
}

const QUICK_REPS = [6, 8, 10, 12] as const;

export interface NumericPadSheetProps {
  open: boolean;
  mode: 'weight' | 'reps-seq';
  exercise: ExerciseEntry | null;
  initialFocusIndex: number;
  onClose: () => void;
  onCommitWeight: (weightKg: number | null, weightBasis?: WeightBasis) => void;
  onCommitRepsSeq: (nextSets: SetEntry[], completeAll: boolean) => void;
}

function findInitialUndoneCursor(sets: readonly DraftSet[], preferred: number): number {
  if (preferred >= 0 && preferred < sets.length && !sets[preferred]!.done) return preferred;
  const firstUndone = sets.findIndex((s) => !s.done);
  return firstUndone >= 0 ? firstUndone : Math.max(0, sets.length - 1);
}

function findNextUndoneAfter(sets: readonly DraftSet[], fromIdx: number): number {
  for (let i = fromIdx + 1; i < sets.length; i++) {
    if (!sets[i]!.done) return i;
  }
  return -1;
}

function findPrevUndoneBefore(sets: readonly DraftSet[], fromIdx: number): number {
  for (let i = fromIdx - 1; i >= 0; i--) {
    if (!sets[i]!.done) return i;
  }
  return -1;
}

function stripProvisional(sets: readonly DraftSet[]): SetEntry[] {
  return sets
    .filter((s) => !s.provisional)
    .map(({ provisional: _p, ...rest }) => rest);
}

/**
 * Custom zero-system-keyboard numeric pad supporting:
 * - `mode="reps-seq"`: full 6-rule sequential reps pad (fast 10 8 6 4 entry, no ghost sets, buffer commit on complete).
 * - `mode="weight"`: 2-decimal weight input + per-hand / total toggle for dumbbells & kettlebells + +/- for bodyweight.
 */
export function NumericPadSheet({
  open,
  mode,
  exercise,
  initialFocusIndex,
  onClose,
  onCommitWeight,
  onCommitRepsSeq,
}: NumericPadSheetProps) {
  const tr = useT();

  // Weight mode state
  const [weightBuf, setWeightBuf] = useState('');
  const [weightNeg, setWeightNeg] = useState(false);
  const [weightBasis, setWeightBasis] = useState<WeightBasis>('total');

  // Reps-seq mode state
  const [draftSets, setDraftSets] = useState<DraftSet[]>([]);
  const [cursor, setCursor] = useState(0);
  const [repsBuf, setRepsBuf] = useState('');
  const [lastCommittedReps, setLastCommittedReps] = useState<number | null>(null);
  const [lastCommittedIdx, setLastCommittedIdx] = useState<number | null>(null);
  const [dirtySeq, setDirtySeq] = useState(false);

  useEffect(() => {
    if (!open || !exercise) return;
    if (mode === 'weight') {
      const safeIdx = Math.min(Math.max(0, initialFocusIndex), Math.max(0, exercise.sets.length - 1));
      const curW = exercise.sets[safeIdx]?.weightKg ?? null;
      if (curW === null) {
        setWeightBuf('');
        setWeightNeg(false);
      } else {
        setWeightNeg(curW < 0);
        setWeightBuf(String(Math.abs(roundWeightKg(curW))));
      }
      setWeightBasis(exercise.weightBasis);
    } else {
      const initial: DraftSet[] = exercise.sets.map((s) => ({ ...s, provisional: false }));
      setDraftSets(initial);
      setCursor(findInitialUndoneCursor(initial, initialFocusIndex));
      setRepsBuf('');
      setLastCommittedReps(null);
      setLastCommittedIdx(null);
      setDirtySeq(false);
    }
  }, [open, mode, exercise?.id, initialFocusIndex]);

  if (!exercise) return null;

  // ───────────────────────── reps-seq handlers (6 rules) ─────────────────────────

  const handleClose = () => {
    if (mode === 'reps-seq' && dirtySeq) {
      // Rule 2: automatically drop unassigned provisional sets on close
      const clean = stripProvisional(draftSets);
      if (clean.length > 0) onCommitRepsSeq(clean, false);
    }
    onClose();
  };

  /** Commit a concrete reps value to `draftSets[cursor]` and advance per Rule 2. */
  const commitRepsAtCursor = (val: number) => {
    const clamped = Math.max(1, Math.min(999, Math.floor(val)));
    const nextSets = draftSets.map((s, i) =>
      i === cursor ? { ...s, reps: clamped, provisional: false } : s,
    );
    const nextIdx = findNextUndoneAfter(nextSets, cursor);
    setDraftSets(nextSets);
    setRepsBuf('');
    setLastCommittedReps(clamped);
    setLastCommittedIdx(cursor);
    setDirtySeq(true);
    // Rule 2: advance if not at last set; if at last set, stay on last set (NEVER auto-append)
    if (nextIdx >= 0) {
      setCursor(nextIdx);
    }
  };

  /** Rule 1: digit key appends to buffer (max 3 digits, ignore leading 0 on empty buffer). */
  const onRepsDigit = (d: string) => {
    if (draftSets[cursor]?.done) return;
    if (repsBuf === '' && d === '0') return;
    if (repsBuf.length >= 3) return;
    void hapticTap();
    setRepsBuf(repsBuf + d);
  };

  /** Rule 1 + 5: quick chip discards uncommitted buffer and commits immediately. */
  const onQuickRepsChip = (val: number) => {
    if (draftSets[cursor]?.done) return;
    void hapticTap();
    commitRepsAtCursor(val);
  };

  /** Rule 1 + 2: `下一组 ›` commits buffer if non-empty, or advances / appends 1 provisional set ONLY at last set with empty buffer. */
  const onNextSet = () => {
    void hapticTap();
    if (repsBuf.length > 0) {
      const val = parseInt(repsBuf, 10);
      if (Number.isFinite(val) && val >= 1) {
        commitRepsAtCursor(val);
      } else {
        setRepsBuf('');
      }
      return;
    }
    const nextIdx = findNextUndoneAfter(draftSets, cursor);
    if (nextIdx >= 0) {
      setCursor(nextIdx);
      return;
    }
    // At last set and buffer is empty: append 1 provisional set (unless current set is already an unassigned provisional set)
    const curSet = draftSets[cursor];
    if (curSet && !curSet.provisional && draftSets.length < 20) {
      const tail = draftSets[draftSets.length - 1]!;
      const provisionalSet: DraftSet = {
        id: newSetId(),
        weightKg: tail.weightKg,
        reps: tail.reps,
        done: false,
        provisional: true,
      };
      const nextSets = [...draftSets, provisionalSet];
      setDraftSets(nextSets);
      setCursor(nextSets.length - 1);
    }
  };

  /** Rule 1: backspace deletes buffer tail if non-empty; otherwise retreats to previous UNDONE set (never onto a done set). */
  const onRepsBackspace = () => {
    void hapticTap();
    if (repsBuf.length > 0) {
      setRepsBuf(repsBuf.slice(0, -1));
      return;
    }
    const prevUndone = findPrevUndoneBefore(draftSets, cursor);
    if (prevUndone < 0) return;
    if (draftSets[cursor]?.provisional) {
      setDraftSets(draftSets.filter((_, i) => i !== cursor));
    }
    setCursor(prevUndone);
  };

  /** Rule 4: commit non-empty buffer, fill-forward remaining undone sets with last committed value, drop provisional sets, close without marking done. */
  const onApplyRemaining = () => {
    void hapticTap();
    let working = draftSets;
    let fillVal = lastCommittedReps;
    let afterIdx = lastCommittedIdx;

    if (repsBuf.length > 0 && !working[cursor]?.done) {
      const parsed = parseInt(repsBuf, 10);
      if (Number.isFinite(parsed) && parsed >= 1) {
        working = working.map((s, i) =>
          i === cursor ? { ...s, reps: parsed, provisional: false } : s,
        );
        fillVal = parsed;
        afterIdx = cursor;
      }
    }

    const clean = stripProvisional(working);
    if (!clean.length) {
      onClose();
      return;
    }
    const effectiveIdx = afterIdx !== null ? Math.min(afterIdx, clean.length - 1) : Math.min(cursor, clean.length - 1);
    const effectiveVal = fillVal ?? clean[effectiveIdx]?.reps ?? 10;
    const filled = clean.map((s, i) => (i > effectiveIdx && !s.done ? { ...s, reps: effectiveVal } : s));
    onCommitRepsSeq(filled, false);
    onClose();
  };

  /** Rule 3: commit non-empty buffer first, drop unassigned provisional sets, mark all undone sets done, collapse card, NO rest timer. */
  const onCompleteAllFromPad = () => {
    void hapticSuccess();
    let working = draftSets;
    if (repsBuf.length > 0 && !working[cursor]?.done) {
      const parsed = parseInt(repsBuf, 10);
      if (Number.isFinite(parsed) && parsed >= 1) {
        working = working.map((s, i) =>
          i === cursor ? { ...s, reps: parsed, provisional: false } : s,
        );
      }
    }
    const clean = stripProvisional(working);
    if (clean.length > 0) {
      onCommitRepsSeq(clean, true);
    }
    onClose();
  };

  // Count for `✓ 完成N组` button: real sets + current provisional set if buffer is non-empty
  const effectiveCompleteCount = draftSets.filter(
    (s, i) => !s.provisional || (i === cursor && repsBuf.length > 0),
  ).length;

  // ───────────────────────── weight handlers (Rule 6) ─────────────────────────

  const onWeightKey = (key: string) => {
    void hapticTap();
    if (key === 'back') {
      setWeightBuf((prev) => prev.slice(0, -1));
      return;
    }
    if (key === '.') {
      if (weightBuf.includes('.')) return;
      setWeightBuf(weightBuf ? `${weightBuf}.` : '0.');
      return;
    }
    // Digit
    const dotIdx = weightBuf.indexOf('.');
    if (dotIdx >= 0 && weightBuf.length - dotIdx - 1 >= 2) return; // max 2 decimal places
    if (dotIdx < 0 && weightBuf.length >= 4) return;
    if (weightBuf === '0' && key === '0') return;
    setWeightBuf(weightBuf === '0' ? key : weightBuf + key);
  };

  const onConfirmWeight = () => {
    void hapticTap();
    if (!weightBuf.trim()) {
      onCommitWeight(null, weightBasis);
      onClose();
      return;
    }
    const num = Number(weightBuf);
    if (!Number.isFinite(num)) return;
    const signed = exercise.equipment === 'bodyweight' && weightNeg ? -Math.abs(num) : Math.abs(num);
    const val = exercise.equipment === 'bodyweight' && signed === 0 ? null : roundWeightKg(signed);
    onCommitWeight(val, weightBasis);
    onClose();
  };

  const isBw = exercise.equipment === 'bodyweight';
  const showBasis = supportsWeightBasisToggle(exercise.equipment);

  return (
    <Sheet
      open={open}
      onClose={handleClose}
      title={mode === 'weight' ? tr('workout.padWeightTitle') : tr('workout.padRepsTitle')}
      className="k-wk-pad-sheet"
    >
      {mode === 'reps-seq' ? (
        <div className="k-wk-pad" data-testid="numpad-reps-seq" data-sheet-no-drag>
          {/* Set capsules live preview strip */}
          <div className="k-wk-pad-strip" role="list">
            {draftSets.map((st, idx) => {
              const isCur = idx === cursor;
              const display = isCur && repsBuf.length > 0 ? repsBuf : st.provisional ? '…' : String(st.reps);
              return (
                <button
                  key={st.id}
                  type="button"
                  role="listitem"
                  disabled={st.done}
                  data-testid={`numpad-set-${idx + 1}`}
                  aria-current={isCur ? 'step' : undefined}
                  className={
                    'k-wk-pad-set' +
                    (isCur ? ' is-current' : '') +
                    (st.done ? ' is-done' : '') +
                    (st.provisional ? ' is-provisional' : '')
                  }
                  onClick={() => {
                    if (st.done) return;
                    void hapticTap();
                    setRepsBuf('');
                    setCursor(idx);
                  }}
                >
                  <span className="k-wk-pad-set-num">
                    {st.done ? '✓' : st.provisional ? tr('workout.provisionalSet') : `#${idx + 1}`}
                  </span>
                  <span className="k-wk-pad-set-val">{display}</span>
                </button>
              );
            })}
          </div>

          {/* Quick reps chips [6] [8] [10] [12] */}
          <div className="k-wk-pad-chips">
            {QUICK_REPS.map((n) => (
              <button
                key={n}
                type="button"
                className="k-wk-pad-chip"
                data-testid={`numpad-chip-${n}`}
                onClick={() => onQuickRepsChip(n)}
              >
                {n}
              </button>
            ))}
          </div>

          {/* 3-column keypad */}
          <div className="k-wk-pad-grid">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
              <button
                key={d}
                type="button"
                className="k-wk-pad-key"
                data-testid={`numpad-key-${d}`}
                onClick={() => onRepsDigit(d)}
              >
                {d}
              </button>
            ))}
            <button
              type="button"
              className="k-wk-pad-key is-fn"
              aria-label={tr('workout.padBackspaceAria')}
              data-testid="numpad-backspace"
              onClick={onRepsBackspace}
            >
              ⌫
            </button>
            <button
              type="button"
              className="k-wk-pad-key"
              data-testid="numpad-key-0"
              onClick={() => onRepsDigit('0')}
            >
              0
            </button>
            <button
              type="button"
              className="k-wk-pad-key is-next"
              data-testid="numpad-next-set"
              onClick={onNextSet}
            >
              {tr('workout.padNextSet')}
            </button>
          </div>

          {/* Bottom actions: Apply Remaining + Complete N sets */}
          <div className="k-wk-pad-actions">
            <button
              type="button"
              className="k-wk-pad-act is-secondary"
              data-testid="numpad-apply-remaining"
              onClick={onApplyRemaining}
            >
              {tr('workout.padApplyRemaining')}
            </button>
            <button
              type="button"
              className="k-wk-pad-act is-primary"
              data-testid="numpad-complete-all"
              onClick={onCompleteAllFromPad}
            >
              {tr('workout.padCompleteN', { n: effectiveCompleteCount })}
            </button>
          </div>
        </div>
      ) : (
        <div className="k-wk-pad" data-testid="numpad-weight" data-sheet-no-drag>
          {showBasis && (
            <div className="k-wk-basis-toggle" role="radiogroup" aria-label={tr('workout.padWeightTitle')}>
              <button
                type="button"
                role="radio"
                aria-checked={weightBasis === 'per_hand'}
                className={'k-wk-basis-pill' + (weightBasis === 'per_hand' ? ' is-on' : '')}
                data-testid="weight-basis-per-hand"
                onClick={() => {
                  void hapticTap();
                  setWeightBasis('per_hand');
                }}
              >
                {tr('workout.perHand')}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={weightBasis === 'total'}
                className={'k-wk-basis-pill' + (weightBasis === 'total' ? ' is-on' : '')}
                data-testid="weight-basis-total"
                onClick={() => {
                  void hapticTap();
                  setWeightBasis('total');
                }}
              >
                {tr('workout.totalWeight')}
              </button>
            </div>
          )}

          <div className="k-wk-weight-display" data-testid="numpad-weight-display">
            <span className="k-wk-weight-num">
              {weightBuf ? `${isBw && weightNeg ? '−' : isBw ? '+' : ''}${weightBuf}` : isBw ? tr('workout.bodyweight') : '—'}
            </span>
            <span className="k-wk-weight-unit">{tr('workout.kgUnit')}</span>
          </div>

          {isBw && (
            <div className="k-wk-bw-helpers">
              <button
                type="button"
                className="k-wk-pad-chip"
                data-testid="numpad-weight-sign"
                onClick={() => {
                  void hapticTap();
                  setWeightNeg((v) => !v);
                }}
              >
                {tr('workout.padToggleSign')} ({weightNeg ? tr('workout.assisted') : tr('workout.weighted')})
              </button>
              <button
                type="button"
                className="k-wk-pad-chip"
                data-testid="numpad-weight-pure-bw"
                onClick={() => {
                  void hapticTap();
                  onCommitWeight(null, weightBasis);
                  onClose();
                }}
              >
                {tr('workout.pureBodyweight')}
              </button>
            </div>
          )}

          <div className="k-wk-pad-grid">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
              <button
                key={d}
                type="button"
                className="k-wk-pad-key"
                data-testid={`weight-key-${d}`}
                onClick={() => onWeightKey(d)}
              >
                {d}
              </button>
            ))}
            <button
              type="button"
              className="k-wk-pad-key is-fn"
              data-testid="weight-key-dot"
              onClick={() => onWeightKey('.')}
            >
              .
            </button>
            <button
              type="button"
              className="k-wk-pad-key"
              data-testid="weight-key-0"
              onClick={() => onWeightKey('0')}
            >
              0
            </button>
            <button
              type="button"
              className="k-wk-pad-key is-fn"
              aria-label={tr('workout.padBackspaceAria')}
              data-testid="weight-key-back"
              onClick={() => onWeightKey('back')}
            >
              ⌫
            </button>
          </div>

          <div className="k-wk-pad-actions">
            <button
              type="button"
              className="k-wk-pad-act is-primary is-full"
              data-testid="numpad-weight-confirm"
              onClick={onConfirmWeight}
            >
              {tr('workout.padConfirm')}
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

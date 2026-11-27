import { useEffect, useState } from 'react';
import { Sheet, UiIcon, useLocale, useT } from '@kesoku/ui';
import { hapticSuccess } from '../../native/haptics';
import { equipmentLabel, formatExerciseInlineSummary, sessionDurationMinutes } from './format';
import type { WorkoutSession } from './types';

export interface WorkoutSummarySheetProps {
  open: boolean;
  session: WorkoutSession | null;
  onClose: () => void;
  onArchive: (title: string, note: string, askAssistant: boolean) => void;
}

export function WorkoutSummarySheet({ open, session, onClose, onArchive }: WorkoutSummarySheetProps) {
  const locale = useLocale();
  const tr = useT();
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (open && session) {
      setTitle(session.title ?? '');
      setNote(session.note ?? '');
    }
  }, [open, session?.id]);

  if (!session) return null;

  const dur = sessionDurationMinutes(session.startedAt, Date.now(), session.updatedAt);
  const totalSets = session.exercises.reduce((acc, ex) => acc + ex.sets.length, 0);
  const doneSets = session.exercises.reduce((acc, ex) => acc + ex.sets.filter((s) => s.done).length, 0);

  return (
    <Sheet open={open} onClose={onClose} title={tr('workout.summaryTitle')} className="k-wk-summary-sheet">
      <div className="k-wk-summary" data-testid="workout-summary-sheet">
        <div className="k-wk-summary-stats">
          <span className="k-pill k-pill-neutral k-pill-sm">
            <UiIcon name="clock" size={14} /> {tr('workout.durationMin', { m: dur })}
          </span>
          <span className="k-pill k-pill-ok k-pill-sm">
            <UiIcon name="check" size={14} /> {tr('workout.completedSetsStat', { done: doneSets, total: totalSets })}
          </span>
        </div>

        <label className="k-wk-field">
          <span>{tr('workout.sessionTitleLabel')}</span>
          <input
            type="text"
            maxLength={60}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={tr('workout.defaultSessionTitle')}
            data-testid="summary-title-input"
          />
        </label>

        {session.exercises.length > 0 && (
          <ul className="k-wk-summary-list">
            {session.exercises.map((ex) => (
              <li key={ex.id}>
                <b>{ex.name}</b>
                <span className="k-wk-eq-tag">{equipmentLabel(ex.equipment, locale)}</span>
                <span className="k-wk-summary-detail">{formatExerciseInlineSummary(ex, locale)}</span>
              </li>
            ))}
          </ul>
        )}

        <label className="k-wk-field">
          <span>{tr('workout.sessionNoteLabel')}</span>
          <textarea
            rows={2}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={tr('workout.sessionNotePlaceholder')}
            data-testid="summary-note-input"
          />
        </label>

        <div className="k-wk-summary-actions">
          <button
            type="button"
            className="k-btn k-btn-ghost"
            data-testid="workout-archive-btn"
            onClick={() => {
              void hapticSuccess();
              onArchive(title, note, false);
              onClose();
            }}
          >
            {tr('workout.archiveBtn')}
          </button>
          <button
            type="button"
            className="k-btn k-btn-primary"
            data-testid="workout-send-ai-btn"
            onClick={() => {
              void hapticSuccess();
              onArchive(title, note, true);
              onClose();
            }}
          >
            <UiIcon name="spark" size={16} /> {tr('workout.archiveAndAskBtn')}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

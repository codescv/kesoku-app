import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setUiLanguage } from '@kesoku/ui';
import { db } from '../../src/lib/db';
import { kesoku } from '../../src/lib/client';
import { actions, useStore } from '../../src/lib/store';
import { Shell } from '../../src/app/Shell';
import { TopBar } from '../../src/app/TopBar';
import { SessionPanel } from '../../src/features/session/SessionPanel';
import { ToolsPanel } from '../../src/features/tools/ToolsPanel';
import { SettingsScreen } from '../../src/features/settings/SettingsScreen';
import { NumericPadSheet } from '../../src/features/workout/NumericPadSheet';
import { ThumbActionDock } from '../../src/features/workout/ThumbActionDock';
import { useWorkoutStore, workoutActions } from '../../src/features/workout/store';
import type { ExerciseEntry, SetEntry } from '../../src/features/workout/types';

beforeAll(() => setUiLanguage('zh-CN'));
afterAll(() => setUiLanguage('system'));

function makeEx(reps: number[], doneFlags?: boolean[], weightKg: number | null = 60, equipment: ExerciseEntry['equipment'] = 'barbell'): ExerciseEntry {
  return {
    id: 'ex_1',
    templateId: `${equipment}:卧推`,
    name: '卧推',
    equipment,
    weightBasis: equipment === 'dumbbell' ? 'per_hand' : 'total',
    sets: reps.map((r, i) => ({
      id: `s_${i + 1}`,
      weightKg,
      reps: r,
      done: doneFlags?.[i] ?? false,
    })),
  };
}

beforeEach(async () => {
  await db.workout_docs.clear();
  await db.kv.clear();
  actions.reset();
  workoutActions.reset();
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('<NumericPadSheet> 6-rule sequential reps pad & weight pad', () => {
  it('Flow D (10 8 6 4): quick chips auto-advance, trailing digit buffer commits on ✓ 完成4组 without ghost sets', () => {
    const committed: Array<{ sets: SetEntry[]; completeAll: boolean }> = [];
    const onClose = vi.fn();
    render(
      <NumericPadSheet
        open
        mode="reps-seq"
        exercise={makeEx([12, 12, 12, 12])}
        initialFocusIndex={0}
        onClose={onClose}
        onCommitWeight={() => {}}
        onCommitRepsSeq={(sets, completeAll) => committed.push({ sets, completeAll })}
      />,
    );

    fireEvent.click(screen.getByTestId('numpad-chip-10'));
    fireEvent.click(screen.getByTestId('numpad-chip-8'));
    fireEvent.click(screen.getByTestId('numpad-chip-6'));
    fireEvent.click(screen.getByTestId('numpad-key-4'));
    // Preview shows "4" in #4
    expect(screen.getByTestId('numpad-set-4').textContent).toContain('4');
    fireEvent.click(screen.getByTestId('numpad-complete-all'));

    expect(committed).toHaveLength(1);
    expect(committed[0]!.completeAll).toBe(true);
    expect(committed[0]!.sets.map((s) => s.reps)).toEqual([10, 8, 6, 4]);
    expect(onClose).toHaveBeenCalled();
  });

  it("Flow D' (8 5 5 6): stays on last set after chip commit (never auto-appends ghost 5th set)", () => {
    const committed: Array<{ sets: SetEntry[]; completeAll: boolean }> = [];
    render(
      <NumericPadSheet
        open
        mode="reps-seq"
        exercise={makeEx([12, 12, 12, 12])}
        initialFocusIndex={0}
        onClose={() => {}}
        onCommitWeight={() => {}}
        onCommitRepsSeq={(sets, completeAll) => committed.push({ sets, completeAll })}
      />,
    );

    fireEvent.click(screen.getByTestId('numpad-chip-8'));
    fireEvent.click(screen.getByTestId('numpad-key-5'));
    fireEvent.click(screen.getByTestId('numpad-next-set'));
    fireEvent.click(screen.getByTestId('numpad-key-5'));
    fireEvent.click(screen.getByTestId('numpad-next-set'));
    fireEvent.click(screen.getByTestId('numpad-chip-6'));
    // Must STILL have only 4 sets, no 5th ghost set
    expect(screen.queryByTestId('numpad-set-5')).toBeNull();
    fireEvent.click(screen.getByTestId('numpad-complete-all'));

    expect(committed[0]!.sets.map((s) => s.reps)).toEqual([8, 5, 5, 6]);
  });

  it('appends 1 provisional set ONLY when at last set with empty buffer, and drops unassigned provisional set on complete/apply', () => {
    const committed: Array<{ sets: SetEntry[]; completeAll: boolean }> = [];
    render(
      <NumericPadSheet
        open
        mode="reps-seq"
        exercise={makeEx([10, 10, 10])}
        initialFocusIndex={0}
        onClose={() => {}}
        onCommitWeight={() => {}}
        onCommitRepsSeq={(sets, completeAll) => committed.push({ sets, completeAll })}
      />,
    );

    // Move to last set (#3) and tap Next with empty buffer -> creates provisional #4
    fireEvent.click(screen.getByTestId('numpad-chip-10'));
    fireEvent.click(screen.getByTestId('numpad-chip-8'));
    fireEvent.click(screen.getByTestId('numpad-chip-6'));
    expect(screen.queryByTestId('numpad-set-4')).toBeNull();
    fireEvent.click(screen.getByTestId('numpad-next-set'));
    expect(screen.getByTestId('numpad-set-4')).toBeTruthy();

    // Without typing into #4, complete -> provisional #4 must be dropped (only 3 sets)
    fireEvent.click(screen.getByTestId('numpad-complete-all'));
    expect(committed[0]!.sets.map((s) => s.reps)).toEqual([10, 8, 6]);
  });

  it('Rule 4 应用剩余组 fill-forwards remaining undone sets without marking done; Rule 1 backspace never retreats into completed set', () => {
    const committed: Array<{ sets: SetEntry[]; completeAll: boolean }> = [];
    render(
      <NumericPadSheet
        open
        mode="reps-seq"
        exercise={makeEx([12, 12, 12, 12], [true, false, false, false])}
        initialFocusIndex={1}
        onClose={() => {}}
        onCommitWeight={() => {}}
        onCommitRepsSeq={(sets, completeAll) => committed.push({ sets, completeAll })}
      />,
    );

    // Set #1 is done/disabled; backspace on empty buffer at #2 must NOT retreat to #1
    expect((screen.getByTestId('numpad-set-1') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('numpad-backspace'));
    expect(screen.getByTestId('numpad-set-2').getAttribute('aria-current')).toBe('step');

    // Quick chip [8] on #2 commits 8 & advances to #3, then Apply Remaining fills #3 and #4 with 8 without marking done
    fireEvent.click(screen.getByTestId('numpad-chip-8'));
    fireEvent.click(screen.getByTestId('numpad-apply-remaining'));
    expect(committed[0]!.completeAll).toBe(false);
    expect(committed[0]!.sets.map((s) => s.reps)).toEqual([12, 8, 8, 8]);
  });

  it('Rule 6 weight mode supports 2 decimals and dumbbell per-hand/total toggle', () => {
    const onWeight = vi.fn();
    render(
      <NumericPadSheet
        open
        mode="weight"
        exercise={makeEx([10, 10], undefined, null, 'dumbbell')}
        initialFocusIndex={0}
        onClose={() => {}}
        onCommitWeight={onWeight}
        onCommitRepsSeq={() => {}}
      />,
    );

    fireEvent.click(screen.getByTestId('weight-basis-total'));
    fireEvent.click(screen.getByTestId('weight-key-1'));
    fireEvent.click(screen.getByTestId('weight-key-7'));
    fireEvent.click(screen.getByTestId('weight-key-dot'));
    fireEvent.click(screen.getByTestId('weight-key-5'));
    fireEvent.click(screen.getByTestId('numpad-weight-confirm'));
    expect(onWeight).toHaveBeenCalledWith(17.5, 'total');
  });
});

describe('<ThumbActionDock> states & 375px layout semantics', () => {
  const noop = () => {};

  it('shows batch CTA only in 0-done state and hides it in partial-done state', () => {
    const { rerender } = render(
      <ThumbActionDock
        exercise={makeEx([12, 12, 12, 12], [false, false, false, false], null)}
        focusedSetIndex={0}
        onAddExercise={noop}
        onAdjustWeight={noop}
        onOpenWeightPad={noop}
        onAdjustSetCount={noop}
        onAdjustReps={noop}
        onOpenRepsPad={noop}
        onCompleteSet={noop}
        onCompleteAll={noop}
        onCollapseDone={noop}
      />,
    );

    // 0-done: both batch CTA and single-set CTA present; weight minus disabled when null
    expect(screen.getByTestId('dock-complete-all')).toBeTruthy();
    expect(screen.getByTestId('dock-complete-set')).toBeTruthy();
    expect((screen.getByTestId('dock-weight-minus') as HTMLButtonElement).disabled).toBe(true);

    // >=1 done: batch CTA hidden, wide single-set CTA shown
    rerender(
      <ThumbActionDock
        exercise={makeEx([12, 12, 12, 12], [true, false, false, false], 20)}
        focusedSetIndex={1}
        onAddExercise={noop}
        onAdjustWeight={noop}
        onOpenWeightPad={noop}
        onAdjustSetCount={noop}
        onAdjustReps={noop}
        onOpenRepsPad={noop}
        onCompleteSet={noop}
        onCompleteAll={noop}
        onCollapseDone={noop}
      />,
    );
    expect(screen.queryByTestId('dock-complete-all')).toBeNull();
    expect(screen.getByTestId('dock-complete-set').className).toContain('is-wide');
  });
});

describe('Tools hub, SessionPanel foot, TopBar active indicator & return paths', () => {
  it('SessionPanel consolidates Notes/Files/Workout into Tools button with active green dot', () => {
    const { rerender } = render(<SessionPanel />);
    expect(screen.getByTestId('sidebar-memory-btn')).toBeTruthy();
    expect(screen.getByTestId('sidebar-tools-btn')).toBeTruthy();
    expect(screen.getByTestId('sidebar-studio-btn')).toBeTruthy();
    expect(screen.getByTestId('sidebar-settings-btn')).toBeTruthy();
    expect(screen.queryByTestId('sidebar-notes-btn')).toBeNull();
    expect(screen.queryByTestId('sidebar-files-btn')).toBeNull();
    expect(screen.queryByTestId('sidebar-tools-active-dot')).toBeNull();

    workoutActions.startBlankSession('Push');
    rerender(<SessionPanel />);
    expect(screen.getByTestId('sidebar-tools-active-dot')).toBeTruthy();
  });

  it('ToolsPanel renders WeChat Mini Program style tiles and returns naturally to tools -> chat', async () => {
    vi.spyOn(kesoku, 'rpc').mockResolvedValue({ rel_path: '', entries: [], content: '' } as never);
    workoutActions.startBlankSession('Leg Day');
    actions.setUi({ screen: 'tools', toolReturnScreen: 'chat' });

    render(<Shell />);
    expect(screen.getByTestId('tools-panel')).toBeTruthy();
    expect(screen.getByTestId('tool-tile-workout')).toBeTruthy();
    expect(screen.getByTestId('tool-tile-notes')).toBeTruthy();
    expect(screen.getByTestId('tool-tile-files')).toBeTruthy();
    expect(screen.getByTestId('tool-workout-active-badge')).toBeTruthy();

    // Open Workout from Tools -> back goes to Tools
    fireEvent.click(screen.getByTestId('tool-tile-workout'));
    expect(useStore.getState().ui.screen).toBe('workout');
    expect(useStore.getState().ui.toolReturnScreen).toBe('tools');
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(useStore.getState().ui.screen).toBe('tools');

    // Back from Tools goes to Chat
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(useStore.getState().ui.screen).toBe('chat');
  });

  it('TopBar shows active workout dumbbell button in chat and returns straight to chat on back', () => {
    workoutActions.startBlankSession('Pull');
    actions.setUi({ screen: 'chat' });
    render(<TopBar sessionId="s1" modeId="chat" onMenu={() => {}} showMenu />);
    const btn = screen.getByTestId('topbar-workout-btn');
    fireEvent.click(btn);
    expect(useStore.getState().ui.screen).toBe('workout');
    expect(useStore.getState().ui.toolReturnScreen).toBe('chat');
  });

  it('SettingsScreen shows inline dirty workout warning (no window.confirm) before logout', async () => {
    vi.spyOn(kesoku, 'rpc').mockResolvedValue({ devices: [] } as never);
    const confirmSpy = vi.spyOn(window, 'confirm');
    await workoutActions.hydrate();
    workoutActions.startBlankSession('Unsynced');
    // Wait for async Dexie put
    await waitFor(async () => expect((await db.workout_docs.toArray()).length).toBeGreaterThan(0));

    render(<SettingsScreen onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('settings-logout-btn'));
    await screen.findByTestId('logout-dirty-workout-warn');
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('ToolsPanel renders cleanly standalone', () => {
    const onClose = vi.fn();
    render(<ToolsPanel onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(onClose).toHaveBeenCalled();
  });
});

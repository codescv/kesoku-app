import { useEffect, useMemo, useState } from 'react';
import { Sheet, UiIcon, useLocale, useT, type MessageKey } from '@kesoku/ui';
import { actions, useStore } from '../../lib/store';
import { kvSet } from '../../lib/db';
import { hapticTap } from '../../native/haptics';
import { ActiveExerciseCard } from './ActiveExerciseCard';
import {
  equipmentLabel,
  formatExerciseInlineSummary,
  formatRestElapsed,
  formatShortDate,
  generateShareSummary,
  sessionDurationMinutes,
} from './format';
import { deriveTemplateStats } from './merge';
import { NumericPadSheet } from './NumericPadSheet';
import { QuickAddSheet } from './QuickAddSheet';
import {
  allSessionsFromLogs,
  findSessionById,
  getFocusedSetIndex,
  selectActiveSession,
  useWorkoutStore,
  workoutActions,
  type WorkoutSyncStatus,
} from './store';
import { downloadJsonFile, workoutSync } from './sync';
import { ThumbActionDock } from './ThumbActionDock';
import {
  DEFAULT_STEP_KG,
  REST_TARGET_OPTIONS,
  monthFromDate,
  type EquipmentType,
  type WorkoutSession,
} from './types';
import { WorkoutSummarySheet } from './WorkoutSummarySheet';
import './workout.css';

function syncDotTone(status: WorkoutSyncStatus): string {
  switch (status) {
    case 'synced':
      return 'is-ok';
    case 'syncing':
      return 'is-warn';
    case 'error':
    case 'corrupt':
      return 'is-bad';
    default:
      return 'is-muted';
  }
}

function syncLabelKey(status: WorkoutSyncStatus): MessageKey {
  switch (status) {
    case 'synced':
      return 'workout.sync.synced';
    case 'syncing':
      return 'workout.sync.syncing';
    case 'local_only':
      return 'workout.sync.localOnly';
    case 'error':
      return 'workout.sync.error';
    case 'corrupt':
      return 'workout.sync.corrupt';
    default:
      return 'workout.sync.offline';
  }
}

export function WorkoutPanel({ onClose }: { onClose: () => void }) {
  const locale = useLocale();
  const tr = useT();
  const conn = useStore((s) => s.conn);
  const wk = useWorkoutStore();

  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [padState, setPadState] = useState<{ open: boolean; mode: 'weight' | 'reps-seq'; exerciseId: string | null }>({
    open: false,
    mode: 'reps-seq',
    exerciseId: null,
  });
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [restSheetOpen, setRestSheetOpen] = useState(false);
  const [historyListMode, setHistoryListMode] = useState(false);
  const [pullingHistory, setPullingHistory] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmCorruptKey, setConfirmCorruptKey] = useState<string | null>(null);
  const [restNow, setRestNow] = useState(() => Date.now());

  // Mount lifecycle: hydrate Dexie, acquire Web single-writer lock, trigger capability probe if online
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!useWorkoutStore.getState().hydrated) {
        await workoutActions.hydrate();
      }
      if (!alive) return;
      await workoutSync.acquireTabLock();
      if (!alive) {
        workoutSync.releaseTabLock();
        return;
      }
      if (useStore.getState().conn.status === 'online' && useStore.getState().conn.engineOnline) {
        void workoutSync.probeAndSync();
      }
    })();
    return () => {
      alive = false;
      workoutSync.releaseTabLock();
    };
  }, []);

  // Periodic 60s tick to refresh pure-runtime 3h active idle check without writing logs
  useEffect(() => {
    const id = setInterval(() => workoutActions.tickClock(), 60_000);
    return () => clearInterval(id);
  }, []);

  // Wall-clock rest timer tick (immune to screen-lock drift because elapsed = Date.now() - restStartedAt)
  useEffect(() => {
    if (!wk.restStartedAt || wk.restTargetSec === 0) return;
    setRestNow(Date.now());
    const id = setInterval(() => {
      const now = Date.now();
      setRestNow(now);
      const st = useWorkoutStore.getState();
      if (st.restStartedAt && st.restTargetSec > 0 && !st.restVibrated) {
        const elapsed = Math.floor((now - st.restStartedAt) / 1000);
        if (elapsed >= st.restTargetSec) {
          workoutActions.markRestVibrated();
          void hapticTap();
        }
      }
    }, 1000);
    return () => clearInterval(id);
  }, [wk.restStartedAt, wk.restTargetSec]);

  const activeSession = selectActiveSession(wk);
  const historyFound = findSessionById(wk.logs, wk.editingHistorySessionId);
  const historySession = historyFound?.session ?? null;

  const displaySession: WorkoutSession | null = historySession ?? (!historyListMode ? activeSession : null);
  const isEditingHistory = historySession !== null;
  const isReadOnly = wk.isReadOnlyTab || (isEditingHistory && wk.editingHistoryReadOnly);
  const isLiveWorkout = !isEditingHistory && activeSession !== null && !historyListMode;

  const allSessions = useMemo(() => allSessionsFromLogs(wk.logs), [wk.logs]);
  const completedOrPast = useMemo(
    () => allSessions.filter((s) => s.id !== activeSession?.id),
    [allSessions, activeSession?.id],
  );
  const templateStats = useMemo(() => deriveTemplateStats(wk.logs), [wk.logs]);

  const expandedExercise = useMemo(
    () => displaySession?.exercises.find((e) => e.id === wk.expandedExerciseId) ?? null,
    [displaySession, wk.expandedExerciseId],
  );
  const padExercise = useMemo(
    () => displaySession?.exercises.find((e) => e.id === padState.exerciseId) ?? expandedExercise,
    [displaySession, padState.exerciseId, expandedExercise],
  );

  const restElapsedSec =
    wk.restStartedAt && wk.restTargetSec > 0 ? Math.max(0, Math.floor((restNow - wk.restStartedAt) / 1000)) : 0;
  const restReached = wk.restStartedAt !== null && wk.restTargetSec > 0 && restElapsedSec >= wk.restTargetSec;

  const sendSummaryToChat = (sess: WorkoutSession) => {
    const text = generateShareSummary(sess, locale);
    const prevN = useStore.getState().ui.composerInsert?.n ?? 0;
    actions.setUi({
      composerInsert: { text, n: prevN + 1 },
      screen: 'chat',
      toolReturnScreen: 'chat',
      drawerOpen: false,
    });
    void kvSet('last_screen', 'chat').catch(() => {});
  };

  const handleBack = () => {
    if (isEditingHistory) {
      workoutActions.closeHistorySession();
      setConfirmDeleteId(null);
      return;
    }
    if (historyListMode) {
      setHistoryListMode(false);
      return;
    }
    onClose();
  };

  const handleUnlockHistoryEdit = async () => {
    if (!historySession || pullingHistory) return;
    setPullingHistory(true);
    try {
      const res = await workoutSync.pullMonthForEdit(monthFromDate(historySession.date));
      if (res.ok) {
        workoutActions.setHistoryReadOnly(false);
      } else {
        actions.toast(
          res.reason === 'offline' ? tr('workout.historyReadOnlyOffline') : tr('workout.pullHistoryFailed'),
          'error',
        );
      }
    } finally {
      setPullingHistory(false);
    }
  };

  const handleSelectTemplate = (templateId: string) => {
    workoutActions.addExerciseFromTemplate(templateId);
  };

  const handleCreateAndAdd = (name: string, equipment: EquipmentType) => {
    const res = workoutActions.createTemplateAndAdd(name, equipment);
    if (res && res.shouldOpenWeightPad) {
      setPadState({ open: true, mode: 'weight', exerciseId: res.exercise.id });
    }
  };

  const handleArchive = (title: string, note: string, askAssistant: boolean) => {
    const completed = workoutActions.finishActiveSession(title, note);
    if (!completed) return;
    actions.toast(tr('workout.archivedToast'));
    if (askAssistant) sendSummaryToChat(completed);
  };

  const handleExportBackup = async (ownerKey?: string) => {
    const json = await workoutSync.exportBackupJson(ownerKey);
    downloadJsonFile(json, `kesoku-workouts-backup-${new Date().toISOString().slice(0, 10)}.json`);
  };

  const headerTitle = isEditingHistory
    ? `${historySession.title || tr('workout.defaultSessionTitle')} · ${formatShortDate(historySession.date)}`
    : historyListMode
      ? tr('workout.history')
      : isLiveWorkout
        ? `${activeSession.title || tr('workout.defaultSessionTitle')} · ${formatShortDate(activeSession.date)}`
        : tr('workout.title');

  const corruptList = Object.values(wk.corruptDocs);

  return (
    <div className="k-screen k-wk" data-testid="workout-panel">
      {/* Single-row compact topbar (50px) */}
      <header className="k-wk-topbar">
        <button type="button" className="k-icon-btn" aria-label={tr('common.back')} onClick={handleBack}>
          <UiIcon name="arrow-left" size={20} />
        </button>

        <div className="k-wk-topbar-title-wrap">
          <h1 className="k-wk-topbar-title">{headerTitle}</h1>
          <button
            type="button"
            className="k-wk-sync-btn"
            title={tr(syncLabelKey(wk.syncStatus))}
            aria-label={tr(syncLabelKey(wk.syncStatus))}
            data-testid="workout-sync-dot"
            onClick={() => {
              actions.toast(tr(syncLabelKey(wk.syncStatus)));
              if (conn.status === 'online' && conn.engineOnline) {
                void workoutSync.probeAndSync();
              }
            }}
          >
            <span className={'k-wk-sync-dot ' + syncDotTone(wk.syncStatus)} aria-hidden />
          </button>
        </div>

        <div className="k-wk-topbar-right">
          {isLiveWorkout && (
            <button
              type="button"
              className={'k-wk-rest-pill' + (restReached ? ' is-ready' : '') + (wk.restTargetSec === 0 ? ' is-off' : '')}
              aria-label={tr('workout.restTimerAria')}
              data-testid="workout-rest-pill"
              onClick={() => {
                void hapticTap();
                setRestSheetOpen(true);
              }}
            >
              <UiIcon name="clock" size={14} />
              <span>
                {wk.restTargetSec === 0
                  ? tr('workout.restOff')
                  : wk.restStartedAt
                    ? formatRestElapsed(restElapsedSec)
                    : tr('workout.restSec', { s: wk.restTargetSec })}
              </span>
            </button>
          )}

          {isLiveWorkout ? (
            <button
              type="button"
              className="k-wk-finish-btn"
              data-testid="workout-finish-btn"
              disabled={wk.isReadOnlyTab}
              onClick={() => {
                void hapticTap();
                setSummaryOpen(true);
              }}
            >
              {tr('workout.finish')}
            </button>
          ) : !isEditingHistory && !historyListMode && allSessions.length > 0 ? (
            <button
              type="button"
              className="k-wk-head-ghost"
              data-testid="workout-history-btn"
              onClick={() => setHistoryListMode(true)}
            >
              {tr('workout.history')}
            </button>
          ) : null}
        </div>
      </header>

      {/* Non-blocking notices & confirmations (zero window.alert / window.confirm) */}
      {wk.isReadOnlyTab && (
        <div className="k-wk-banner is-warn" role="status" data-testid="workout-readonly-tab-banner">
          <span>{tr('workout.readOnlyTabBanner')}</span>
        </div>
      )}

      {wk.engineLegacy && !wk.pendingUpgradeMerge && (
        <div className="k-wk-banner is-info" role="status" data-testid="workout-legacy-banner">
          <span>{tr('workout.legacyBanner')}</span>
        </div>
      )}

      {wk.pendingUpgradeMerge && (
        <div className="k-wk-notice-card" role="region" data-testid="workout-upgrade-merge-card">
          <b>{tr('workout.upgradeMergeTitle')}</b>
          <p>{tr('workout.upgradeMergeBody', { count: wk.pendingUpgradeMerge.localSessionCount })}</p>
          <div className="k-wk-notice-actions">
            <button
              type="button"
              className="k-btn k-btn-primary k-btn-sm"
              data-testid="workout-upgrade-merge-confirm"
              onClick={() => void workoutSync.confirmUpgradeMerge()}
            >
              {tr('workout.upgradeMergeConfirm')}
            </button>
            <button
              type="button"
              className="k-btn k-btn-ghost k-btn-sm"
              data-testid="workout-upgrade-merge-skip"
              onClick={() => void workoutSync.skipUpgradeMerge()}
            >
              {tr('workout.upgradeMergeSkip')}
            </button>
          </div>
        </div>
      )}

      {wk.frozenWorkspaceNotice && (
        <div className="k-wk-notice-card is-warn" role="region" data-testid="workout-frozen-workspace-card">
          <b>{tr('workout.workspaceSwitchTitle')}</b>
          <p>{tr('workout.workspaceSwitchBody', { count: wk.frozenWorkspaceNotice.dirtyCount })}</p>
          <div className="k-wk-notice-actions">
            <button
              type="button"
              className="k-btn k-btn-ghost k-btn-sm"
              data-testid="workout-export-frozen-btn"
              onClick={() => void handleExportBackup(wk.frozenWorkspaceNotice?.oldOwnerKey)}
            >
              {tr('workout.exportBackup')}
            </button>
            <button
              type="button"
              className="k-btn k-btn-primary k-btn-sm"
              onClick={() => workoutSync.dismissFrozenNotice()}
            >
              {tr('workout.dismiss')}
            </button>
          </div>
        </div>
      )}

      {corruptList.map((doc) => (
        <div key={doc.docKey} className="k-wk-notice-card is-danger" role="alert" data-testid={`corrupt-doc-${doc.docKey}`}>
          <b>{tr('workout.corruptBannerTitle')}</b>
          <p>{tr('workout.corruptBannerBody', { path: doc.path })}</p>
          <div className="k-wk-notice-actions">
            {confirmCorruptKey === doc.docKey ? (
              <>
                <button
                  type="button"
                  className="k-btn k-btn-danger k-btn-sm"
                  data-testid="corrupt-confirm-overwrite"
                  onClick={() => {
                    setConfirmCorruptKey(null);
                    void workoutSync.forceOverwriteCorruptDoc(doc.docKey);
                  }}
                >
                  {tr('workout.corruptConfirmOverwrite')}
                </button>
                <button type="button" className="k-btn k-btn-ghost k-btn-sm" onClick={() => setConfirmCorruptKey(null)}>
                  {tr('common.cancel')}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="k-btn k-btn-danger-ghost k-btn-sm"
                data-testid="corrupt-overwrite-btn"
                onClick={() => setConfirmCorruptKey(doc.docKey)}
              >
                {tr('workout.corruptOverwrite')}
              </button>
            )}
          </div>
        </div>
      ))}

      {/* Main content stage */}
      {displaySession ? (
        <>
          <div className="k-wk-stage">
            {isEditingHistory && (
              <div className="k-wk-history-bar" data-testid="history-mode-bar">
                {wk.editingHistoryReadOnly ? (
                  <>
                    <span className="k-wk-history-status">
                      {conn.status === 'online' && conn.engineOnline
                        ? formatShortDate(historySession.date)
                        : tr('workout.historyReadOnlyOffline')}
                    </span>
                    <div className="k-wk-history-bar-actions">
                      <button
                        type="button"
                        className="k-btn k-btn-ghost k-btn-sm"
                        data-testid="history-ask-ai-btn"
                        onClick={() => sendSummaryToChat(historySession)}
                      >
                        <UiIcon name="spark" size={14} /> {tr('workout.askAssistantBtn')}
                      </button>
                      <button
                        type="button"
                        className="k-btn k-btn-primary k-btn-sm"
                        disabled={wk.isReadOnlyTab || pullingHistory || (!wk.engineLegacy && !(conn.status === 'online' && conn.engineOnline))}
                        data-testid="history-unlock-edit-btn"
                        onClick={() => void handleUnlockHistoryEdit()}
                      >
                        {pullingHistory ? tr('workout.pullingHistory') : tr('workout.editHistory')}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="k-wk-history-status is-editing">{tr('workout.editHistory')}</span>
                    <div className="k-wk-history-bar-actions">
                      {confirmDeleteId === historySession.id ? (
                        <>
                          <button
                            type="button"
                            className="k-btn k-btn-danger k-btn-sm"
                            data-testid="history-confirm-delete-btn"
                            onClick={() => {
                              workoutActions.deleteSession(historySession.id);
                              setConfirmDeleteId(null);
                            }}
                          >
                            {tr('workout.confirmDeleteSession')}
                          </button>
                          <button type="button" className="k-btn k-btn-ghost k-btn-sm" onClick={() => setConfirmDeleteId(null)}>
                            {tr('common.cancel')}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="k-btn k-btn-danger-ghost k-btn-sm"
                          data-testid="history-delete-btn"
                          onClick={() => setConfirmDeleteId(historySession.id)}
                        >
                          {tr('workout.deleteSession')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="k-btn k-btn-primary k-btn-sm"
                        data-testid="history-done-edit-btn"
                        onClick={() => workoutActions.setHistoryReadOnly(true)}
                      >
                        {tr('workout.doneEditingHistory')}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {displaySession.exercises.length === 0 ? (
              <div className="k-wk-empty-stage" data-testid="workout-empty-active">
                <UiIcon name="dumbbell" size={34} />
                <p>{tr('workout.emptyActiveHint')}</p>
              </div>
            ) : (
              <div className="k-wk-card-list">
                {displaySession.exercises.map((ex) => {
                  const isExpanded = ex.id === wk.expandedExerciseId && !isReadOnly;
                  if (isExpanded) {
                    const lastEx = templateStats.get(ex.templateId)?.lastExercise ?? null;
                    const lastPerformed = lastEx && lastEx.id !== ex.id ? lastEx : null;
                    return (
                      <ActiveExerciseCard
                        key={ex.id}
                        exercise={ex}
                        focusedSetIndex={getFocusedSetIndex(wk, ex)}
                        lastPerformed={lastPerformed}
                        readOnly={isReadOnly}
                        onTapSet={(setIdx) => workoutActions.tapSetCapsule(ex.id, setIdx)}
                        onCollapse={() => workoutActions.setExpandedExercise(null)}
                        onRemove={() => workoutActions.removeExercise(ex.id)}
                      />
                    );
                  }
                  const doneCount = ex.sets.filter((s) => s.done).length;
                  const allDone = ex.sets.length > 0 && doneCount === ex.sets.length;
                  return (
                    <button
                      key={ex.id}
                      type="button"
                      className={'k-wk-card is-collapsed' + (allDone ? ' is-all-done' : '')}
                      data-testid={`collapsed-exercise-${ex.id}`}
                      aria-label={tr('workout.expandExerciseAria', { name: ex.name })}
                      onClick={() => {
                        if (isReadOnly) return;
                        void hapticTap();
                        workoutActions.setExpandedExercise(ex.id);
                      }}
                    >
                      <span className="k-wk-collapsed-main">
                        <span className={'k-wk-collapsed-mark' + (allDone ? ' is-done' : '')} aria-hidden>
                          {allDone ? '✓' : '○'}
                        </span>
                        <b className="k-wk-collapsed-name">{ex.name}</b>
                        <span className="k-wk-eq-tag">{equipmentLabel(ex.equipment, locale)}</span>
                      </span>
                      <span className="k-wk-collapsed-summary">{formatExerciseInlineSummary(ex, locale)}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* 40px inline undo bar (only after exercise deletion, never obscures Dock) */}
          {wk.undoDeleted && wk.undoDeleted.sessionId === displaySession.id && (
            <div className="k-wk-undo-bar" role="status" data-testid="workout-undo-bar">
              <span>{tr('workout.deletedUndo', { name: wk.undoDeleted.exercise.name })}</span>
              <button
                type="button"
                className="k-wk-undo-btn"
                data-testid="workout-undo-btn"
                onClick={() => {
                  void hapticTap();
                  workoutActions.undoRemoveExercise();
                }}
              >
                {tr('workout.undo')}
              </button>
            </div>
          )}

          {/* 2-row 120px Thumb Action Dock */}
          <ThumbActionDock
            exercise={expandedExercise}
            focusedSetIndex={expandedExercise ? getFocusedSetIndex(wk, expandedExercise) : 0}
            stepKg={
              expandedExercise
                ? wk.catalog.templates.find((t) => t.id === expandedExercise.templateId)?.stepKg ??
                  DEFAULT_STEP_KG[expandedExercise.equipment]
                : undefined
            }
            readOnly={isReadOnly}
            onAddExercise={() => setQuickAddOpen(true)}
            onAdjustWeight={(delta) => expandedExercise && workoutActions.adjustWeight(expandedExercise.id, delta)}
            onOpenWeightPad={() =>
              expandedExercise && setPadState({ open: true, mode: 'weight', exerciseId: expandedExercise.id })
            }
            onAdjustSetCount={(delta) => expandedExercise && workoutActions.adjustSetCount(expandedExercise.id, delta)}
            onAdjustReps={(delta) => expandedExercise && workoutActions.adjustReps(expandedExercise.id, delta)}
            onOpenRepsPad={() =>
              expandedExercise && setPadState({ open: true, mode: 'reps-seq', exerciseId: expandedExercise.id })
            }
            onCompleteSet={() => expandedExercise && workoutActions.completeFocusedSet(expandedExercise.id)}
            onCompleteAll={() => expandedExercise && workoutActions.completeAllSets(expandedExercise.id)}
            onCollapseDone={() => workoutActions.setExpandedExercise(null)}
          />
        </>
      ) : (
        /* Idle Home / History List */
        <div className="k-wk-home" data-testid={historyListMode ? 'workout-history-list' : 'workout-idle-home'}>
          {!historyListMode && (
            <button
              type="button"
              className="k-wk-start-btn"
              disabled={wk.isReadOnlyTab}
              data-testid="workout-start-blank"
              onClick={() => {
                void hapticTap();
                workoutActions.startBlankSession();
              }}
            >
              <UiIcon name="plus" size={20} />
              <span>{tr('workout.startBlank')}</span>
            </button>
          )}

          <section className="k-wk-recent-section">
            <h2 className="k-wk-section-heading">
              {historyListMode ? tr('workout.history') : tr('workout.recentWorkouts')}
            </h2>

            {(historyListMode ? allSessions : completedOrPast.slice(0, 3)).length === 0 ? (
              <div className="k-empty">{tr('workout.noWorkoutsYet')}</div>
            ) : (
              <div className="k-wk-recent-list">
                {(historyListMode ? allSessions : completedOrPast.slice(0, 3)).map((sess) => {
                  const title = sess.title || tr('workout.defaultSessionTitle');
                  const dur = sessionDurationMinutes(sess.startedAt, sess.finishedAt, sess.updatedAt);
                  const totalSets = sess.exercises.reduce((a, ex) => a + ex.sets.length, 0);
                  const preview = sess.exercises
                    .slice(0, 3)
                    .map((ex) => ex.name)
                    .join(' · ');
                  return (
                    <div key={sess.id} className="k-wk-recent-card" data-testid={`recent-workout-${sess.id}`}>
                      <button
                        type="button"
                        className="k-wk-recent-main"
                        onClick={() => workoutActions.openHistorySession(sess.id, true)}
                      >
                        <div className="k-wk-recent-top">
                          <b>{title}</b>
                          <span className="k-wk-recent-date">{sess.date}</span>
                        </div>
                        <div className="k-wk-recent-meta">
                          <span>{tr('workout.durationMin', { m: dur })}</span>
                          <span>·</span>
                          <span>{tr('workout.setsCount', { n: totalSets })}</span>
                        </div>
                        {preview && <div className="k-wk-recent-preview">{preview}</div>}
                      </button>
                      {!historyListMode && !wk.isReadOnlyTab && sess.exercises.length > 0 && (
                        <button
                          type="button"
                          className="k-wk-clone-btn"
                          aria-label={tr('workout.cloneAria', { title })}
                          data-testid={`clone-workout-${sess.id}`}
                          onClick={() => {
                            void hapticTap();
                            workoutActions.cloneSession(sess.id);
                          }}
                        >
                          <UiIcon name="copy" size={15} />
                          <span>{tr('workout.cloneLast')}</span>
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}

      {/* Sheets */}
      <QuickAddSheet
        open={quickAddOpen}
        templates={wk.catalog.templates}
        logs={wk.logs}
        onClose={() => setQuickAddOpen(false)}
        onSelectTemplate={handleSelectTemplate}
        onCreateAndAdd={handleCreateAndAdd}
      />

      <NumericPadSheet
        open={padState.open && !!padExercise}
        mode={padState.mode}
        exercise={padExercise}
        initialFocusIndex={padExercise ? getFocusedSetIndex(wk, padExercise) : 0}
        onClose={() => setPadState((p) => ({ ...p, open: false }))}
        onCommitWeight={(weightKg, weightBasis) => {
          if (padExercise) workoutActions.setWeightExact(padExercise.id, weightKg, weightBasis);
        }}
        onCommitRepsSeq={(nextSets, completeAll) => {
          if (padExercise) workoutActions.applyRepsSeqResult(padExercise.id, nextSets, completeAll);
        }}
      />

      <WorkoutSummarySheet
        open={summaryOpen}
        session={activeSession}
        onClose={() => setSummaryOpen(false)}
        onArchive={handleArchive}
      />

      {/* Rest timer target picker sheet */}
      <Sheet open={restSheetOpen} onClose={() => setRestSheetOpen(false)} title={tr('workout.restTargetTitle')}>
        <div className="k-wk-rest-options" data-testid="rest-target-options">
          {REST_TARGET_OPTIONS.map((sec) => {
            const on = wk.restTargetSec === sec;
            return (
              <button
                key={sec}
                type="button"
                className={'k-wk-rest-opt' + (on ? ' is-on' : '')}
                aria-pressed={on}
                data-testid={`rest-opt-${sec}`}
                onClick={() => {
                  void hapticTap();
                  workoutActions.setRestTargetSec(sec);
                  setRestSheetOpen(false);
                }}
              >
                {sec === 0 ? tr('workout.restOff') : tr('workout.restSec', { s: sec })}
              </button>
            );
          })}
        </div>
      </Sheet>
    </div>
  );
}

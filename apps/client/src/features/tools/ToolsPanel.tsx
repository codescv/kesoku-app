import { UiIcon, useT, type MessageKey, type UiIconName } from '@kesoku/ui';
import { actions, type Screen } from '../../lib/store';
import { kvSet } from '../../lib/db';
import { hapticTap } from '../../native/haptics';
import { selectHasActiveWorkout, useWorkoutStore } from '../workout/store';
import './tools.css';

interface ToolTileDef {
  id: 'workout' | 'notes' | 'files';
  screen: Extract<Screen, 'workout' | 'notes' | 'files'>;
  icon: UiIconName;
  titleKey: MessageKey;
  descKey: MessageKey;
  toneClass: string;
}

const TOOL_TILES: readonly ToolTileDef[] = [
  {
    id: 'workout',
    screen: 'workout',
    icon: 'dumbbell',
    titleKey: 'tools.workout',
    descKey: 'tools.workoutDesc',
    toneClass: 'is-workout',
  },
  {
    id: 'notes',
    screen: 'notes',
    icon: 'note',
    titleKey: 'tools.notes',
    descKey: 'tools.notesDesc',
    toneClass: 'is-notes',
  },
  {
    id: 'files',
    screen: 'files',
    icon: 'folder',
    titleKey: 'tools.files',
    descKey: 'tools.filesDesc',
    toneClass: 'is-files',
  },
];

/** WeChat Mini Program style Tools hub (`ui.screen === 'tools'`). */
export function ToolsPanel({ onClose }: { onClose: () => void }) {
  const tr = useT();
  const hasActiveWorkout = useWorkoutStore(selectHasActiveWorkout);

  const openTool = (screen: ToolTileDef['screen']) => {
    void hapticTap();
    actions.setUi({ screen, toolReturnScreen: 'tools', drawerOpen: false });
    void kvSet('last_screen', screen).catch(() => {});
  };

  return (
    <div className="k-screen k-tools" data-testid="tools-panel">
      <header className="k-screen-head k-tools-head">
        <button type="button" className="k-icon-btn" aria-label={tr('common.back')} onClick={onClose}>
          <UiIcon name="arrow-left" size={22} />
        </button>
        <h1>{tr('tools.title')}</h1>
      </header>

      <div className="k-tools-body">
        {hasActiveWorkout && (
          <button
            type="button"
            className="k-tools-active-banner"
            data-testid="tools-resume-workout"
            onClick={() => openTool('workout')}
          >
            <span className="k-tools-live-dot" aria-hidden />
            <span className="k-tools-active-text">{tr('tools.resumeActive')}</span>
            <UiIcon name="chevron-right" size={18} />
          </button>
        )}

        <section className="k-tools-section" aria-labelledby="k-tools-section-title">
          <h2 id="k-tools-section-title" className="k-tools-section-title">
            {tr('tools.sectionCommon')}
          </h2>
          <div className="k-tools-grid" role="list">
            {TOOL_TILES.map((tile) => {
              const showLive = tile.id === 'workout' && hasActiveWorkout;
              return (
                <button
                  key={tile.id}
                  type="button"
                  role="listitem"
                  className="k-tool-tile"
                  data-testid={`tool-tile-${tile.id}`}
                  onClick={() => openTool(tile.screen)}
                >
                  <span className={`k-tool-icon-plate ${tile.toneClass}`} aria-hidden>
                    <UiIcon name={tile.icon} size={28} styleVariant="line" />
                    {showLive && <span className="k-tool-live-badge-dot" />}
                  </span>
                  <span className="k-tool-name">{tr(tile.titleKey)}</span>
                  {showLive ? (
                    <span className="k-tool-status-pill" data-testid="tool-workout-active-badge">
                      {tr('tools.activeBadge')}
                    </span>
                  ) : (
                    <span className="k-tool-desc">{tr(tile.descKey)}</span>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

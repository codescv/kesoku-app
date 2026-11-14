import './hud.css';

export { detectActiveMode, normalizeModeId } from './activeMode';
export type { ActiveMode, GameInstance } from './activeMode';
export {
  ModeHud,
  HUD_PANELS,
  SceneChips,
  VERSION_LABELS,
  resolveGameVersion,
  timedMarks,
  formatRemaining,
  mistakesCount,
  squad,
} from './ModeHud';
export type { ModeHudProps, HudPanel, GameVersion } from './ModeHud';
export { PolicyBadge } from './PolicyBadge';
export type { PolicyBadgeProps } from './PolicyBadge';

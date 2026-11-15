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
  TRANSLATOR_LANGS,
  DEFAULT_NATIVE_LANG,
  DEFAULT_FOREIGN_LANGS,
  MAX_FOREIGN_LANGS,
  langKey,
  isNativeLang,
  translatorLangLabel,
  normalizeForeignLangs,
  resolveTranslatorPair,
} from './ModeHud';
export type { ModeHudProps, HudPanel, GameVersion, TranslatorLang, TranslatorPair } from './ModeHud';
export { PolicyBadge } from './PolicyBadge';
export type { PolicyBadgeProps } from './PolicyBadge';

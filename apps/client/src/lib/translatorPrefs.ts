import { DEFAULT_FOREIGN_LANGS, DEFAULT_NATIVE_LANG, isNativeLang, normalizeForeignLangs } from '@kesoku/hud';
import type { Settings } from './store';

/** User-level translator languages (母语 + 常用外语) from settings, always valid. */
export function translatorLangs(settings: Pick<Settings, 'translatorNativeLang' | 'translatorForeignLangs'>): {
  native_lang: string;
  foreign_langs: string[];
} {
  const native = (settings.translatorNativeLang || '').trim() || DEFAULT_NATIVE_LANG;
  let foreign = normalizeForeignLangs(settings.translatorForeignLangs, native);
  if (!foreign.length) foreign = DEFAULT_FOREIGN_LANGS.filter((c) => !isNativeLang(c, native));
  if (!foreign.length) foreign = ['en'];
  return { native_lang: native, foreign_langs: foreign };
}

/** `mode.prefs` sent when the translator starts: 母语 ⇄ first 常用外语. */
export function translatorStartPrefs(settings: Pick<Settings, 'translatorNativeLang' | 'translatorForeignLangs'>): Record<string, unknown> {
  const { native_lang, foreign_langs } = translatorLangs(settings);
  return { native_lang, foreign_langs, src_lang: foreign_langs[0] || 'ja', dst_lang: native_lang };
}

/** HUD view of the session prefs: the user's configured 母语 / 常用外语 always win over stale session copies. */
export function mergeTranslatorModePrefs(
  modePrefs: Record<string, unknown>,
  settings: Pick<Settings, 'translatorNativeLang' | 'translatorForeignLangs'>,
): Record<string, unknown> {
  return { ...modePrefs, ...translatorLangs(settings) };
}

/** Settings patch for HUD prefs carrying `native_lang` / `foreign_langs` (null when nothing to persist). */
export function translatorSettingsPatch(prefs: Record<string, unknown>): Partial<Settings> | null {
  const patch: Partial<Settings> = {};
  if (typeof prefs.native_lang === 'string' && prefs.native_lang.trim()) patch.translatorNativeLang = prefs.native_lang.trim();
  if (Array.isArray(prefs.foreign_langs)) {
    const list = prefs.foreign_langs.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim());
    if (list.length) patch.translatorForeignLangs = list;
  }
  return Object.keys(patch).length ? patch : null;
}

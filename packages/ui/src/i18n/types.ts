export type LanguageSetting = 'system' | 'zh-CN' | 'en' | 'ja';
export type ResolvedLocale = 'zh-CN' | 'en' | 'ja';
export type TranslationParams = Record<string, string | number | undefined>;

export const LANGUAGE_SETTINGS: readonly LanguageSetting[] = Object.freeze(['system', 'zh-CN', 'en', 'ja']);
export const RESOLVED_LOCALES: readonly ResolvedLocale[] = Object.freeze(['zh-CN', 'en', 'ja']);

export function isLanguageSetting(v: unknown): v is LanguageSetting {
  return v === 'system' || v === 'zh-CN' || v === 'en' || v === 'ja';
}

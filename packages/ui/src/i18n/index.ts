import { useCallback, useSyncExternalStore } from 'react';
import { en, type MessageKey } from './locales/en';
import { zhCN } from './locales/zh-CN';
import { ja } from './locales/ja';
import {
  LANGUAGE_SETTINGS,
  RESOLVED_LOCALES,
  isLanguageSetting,
  type LanguageSetting,
  type ResolvedLocale,
  type TranslationParams,
} from './types';

export { LANGUAGE_SETTINGS, RESOLVED_LOCALES, isLanguageSetting };
export type { LanguageSetting, ResolvedLocale, TranslationParams, MessageKey };

export const LOCALE_MESSAGES: Readonly<Record<ResolvedLocale, Readonly<Record<MessageKey, string>>>> = Object.freeze({
  en,
  'zh-CN': zhCN,
  ja,
});

function detectNavigatorLanguage(): string {
  if (typeof navigator === 'undefined') return '';
  const first = Array.isArray(navigator.languages) ? navigator.languages.find((l) => typeof l === 'string' && l.trim()) : undefined;
  return (first || navigator.language || '').trim();
}

/** Resolve `'system'` or an explicit setting to one of `'zh-CN' | 'en' | 'ja'`. */
export function resolveLanguage(setting: LanguageSetting | string | null | undefined, navLang?: string): ResolvedLocale {
  if (setting === 'zh-CN' || setting === 'en' || setting === 'ja') return setting;
  const raw = (navLang !== undefined ? navLang : detectNavigatorLanguage()).trim().toLowerCase();
  if (raw.startsWith('zh')) return 'zh-CN';
  if (raw.startsWith('ja')) return 'ja';
  return 'en';
}

interface Snapshot {
  setting: LanguageSetting;
  locale: ResolvedLocale;
}

let state: Snapshot = {
  setting: 'system',
  locale: resolveLanguage('system'),
};

const listeners = new Set<() => void>();

function applyDocumentLang(locale: ResolvedLocale): void {
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = locale;
  }
}

function notify(): void {
  for (const fn of listeners) fn();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): Snapshot {
  return state;
}

/** Update the active UI language (`'system' | 'zh-CN' | 'en' | 'ja'`), sync `<html lang>`, and re-render subscribers. */
export function setUiLanguage(setting: LanguageSetting): ResolvedLocale {
  const nextSetting: LanguageSetting = isLanguageSetting(setting) ? setting : 'system';
  const nextLocale = resolveLanguage(nextSetting);
  applyDocumentLang(nextLocale);
  if (state.setting !== nextSetting || state.locale !== nextLocale) {
    state = { setting: nextSetting, locale: nextLocale };
    notify();
  }
  return nextLocale;
}

/** Re-evaluate `'system'` against the current `navigator.language` (e.g. on `languagechange`). */
export function refreshSystemLanguage(): ResolvedLocale {
  if (state.setting !== 'system') return state.locale;
  const nextLocale = resolveLanguage('system');
  applyDocumentLang(nextLocale);
  if (state.locale !== nextLocale) {
    state = { setting: 'system', locale: nextLocale };
    notify();
  }
  return nextLocale;
}

export function getUiLanguageSetting(): LanguageSetting {
  return state.setting;
}

export function getUiLocale(): ResolvedLocale {
  return state.locale;
}

export function useLocale(): ResolvedLocale {
  return useSyncExternalStore(subscribe, () => getSnapshot().locale, () => state.locale);
}

export function useLanguageSetting(): LanguageSetting {
  return useSyncExternalStore(subscribe, () => getSnapshot().setting, () => state.setting);
}

export function t(key: MessageKey, params?: TranslationParams, locale: ResolvedLocale = state.locale): string {
  const dict = LOCALE_MESSAGES[locale] ?? LOCALE_MESSAGES.en;
  const template = dict[key] ?? LOCALE_MESSAGES.en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = params[k];
    return v === undefined ? '' : String(v);
  });
}

export function useT(): (key: MessageKey, params?: TranslationParams) => string {
  const locale = useLocale();
  return useCallback((key: MessageKey, params?: TranslationParams) => t(key, params, locale), [locale]);
}

export function formatLocaleDate(date: Date | number, options?: Intl.DateTimeFormatOptions, locale: ResolvedLocale = state.locale): string {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleDateString(locale, options);
}

export function formatLocaleDateTime(date: Date | number, options?: Intl.DateTimeFormatOptions, locale: ResolvedLocale = state.locale): string {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleString(locale, options);
}

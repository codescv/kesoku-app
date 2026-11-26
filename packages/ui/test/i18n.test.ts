import { afterEach, describe, expect, it } from 'vitest';
import {
  ICON_STYLE_OPTIONS,
  LOCALE_MESSAGES,
  MODES,
  MODE_LIST,
  POLICY_BADGE,
  RESOLVED_LOCALES,
  getUiLanguageSetting,
  getUiLocale,
  refreshSystemLanguage,
  resolveLanguage,
  setUiLanguage,
  t,
  type MessageKey,
} from '../src';

const CJK_RE = /[\u4e00-\u9fff\u3040-\u30ff]/;
const PLACEHOLDER_RE = /\{(\w+)\}/g;

function placeholdersOf(s: string): string[] {
  return Array.from(s.matchAll(PLACEHOLDER_RE), (m) => m[1]!).sort();
}

describe('i18n core', () => {
  afterEach(() => {
    setUiLanguage('system');
  });

  it('resolves system language: zh* -> zh-CN, ja* -> ja, everything else -> en', () => {
    expect(resolveLanguage('system', 'zh')).toBe('zh-CN');
    expect(resolveLanguage('system', 'zh-CN')).toBe('zh-CN');
    expect(resolveLanguage('system', 'zh-Hans-CN')).toBe('zh-CN');
    expect(resolveLanguage('system', 'zh-TW')).toBe('zh-CN');
    expect(resolveLanguage('system', 'ZH-HK')).toBe('zh-CN');

    expect(resolveLanguage('system', 'ja')).toBe('ja');
    expect(resolveLanguage('system', 'ja-JP')).toBe('ja');
    expect(resolveLanguage('system', 'JA')).toBe('ja');

    expect(resolveLanguage('system', 'en')).toBe('en');
    expect(resolveLanguage('system', 'en-US')).toBe('en');
    expect(resolveLanguage('system', 'fr-FR')).toBe('en');
    expect(resolveLanguage('system', 'de-DE')).toBe('en');
    expect(resolveLanguage('system', 'ko-KR')).toBe('en');
    expect(resolveLanguage('system', '')).toBe('en');
  });

  it('respects explicit overrides regardless of navigator language', () => {
    expect(resolveLanguage('en', 'zh-CN')).toBe('en');
    expect(resolveLanguage('zh-CN', 'en-US')).toBe('zh-CN');
    expect(resolveLanguage('ja', 'en-US')).toBe('ja');
  });

  it('has 100% key parity, non-empty values, and matching placeholders across en, zh-CN, ja', () => {
    const enKeys = Object.keys(LOCALE_MESSAGES.en).sort() as MessageKey[];
    expect(enKeys.length).toBeGreaterThan(300);

    for (const locale of RESOLVED_LOCALES) {
      const dict = LOCALE_MESSAGES[locale];
      const keys = Object.keys(dict).sort();
      expect(keys, `${locale} key parity`).toEqual(enKeys);

      for (const k of enKeys) {
        const val = dict[k];
        expect(typeof val, `${locale}.${k} type`).toBe('string');
        expect(val.trim().length, `${locale}.${k} non-empty`).toBeGreaterThan(0);
        expect(placeholdersOf(val), `${locale}.${k} placeholders`).toEqual(placeholdersOf(LOCALE_MESSAGES.en[k]));
      }
    }
  });

  it('contains zero CJK characters in the English dictionary', () => {
    const offenders: string[] = [];
    for (const [k, v] of Object.entries(LOCALE_MESSAGES.en)) {
      if (CJK_RE.test(v)) offenders.push(`${k}: ${v}`);
    }
    expect(offenders).toEqual([]);
  });

  it('eliminates CN+EN mixed chrome in zh-CN dictionary', () => {
    const zh = LOCALE_MESSAGES['zh-CN'];
    expect(zh['thinking.minimal']).toBe('极简');
    expect(zh['thinking.low']).toBe('低');
    expect(zh['thinking.medium']).toBe('中');
    expect(zh['thinking.high']).toBe('高');
    expect(zh['topbar.pinnedNotes']).toBe('置顶便签');
    expect(zh['card.stepCompare']).toBe('课本与地道对比');
    expect(zh['mode.galgame.title']).toBe('恋爱物语');
    expect(zh['mode.trpg.title']).toBe('桌面跑团');
    expect(zh['panel.dexTitle']).toBe('🔴 图鉴');
    expect(zh['card.moveCooldown']).not.toContain('CD');
    expect(zh['card.gradingPass']).not.toContain('PASS');
    expect(zh['settings.sessionSeqLabel'].replace(/\{seq\}/g, '')).not.toContain('seq');
    expect(zh['shell.takenOverBanner']).not.toContain('App');
  });

  it('updates active locale, document.documentElement.lang, and live getters reactively', () => {
    setUiLanguage('en');
    expect(getUiLanguageSetting()).toBe('en');
    expect(getUiLocale()).toBe('en');
    expect(t('settings.title')).toBe('Settings');
    expect(MODES.translator.title).toBe('Translator');
    expect(MODE_LIST.find((m) => m.id === 'chat')?.title).toBe('General Chat');
    expect(POLICY_BADGE.full.label).toBe('Auto');
    expect(ICON_STYLE_OPTIONS[0]?.label).toBe('Soft Duotone');
    if (typeof document !== 'undefined') expect(document.documentElement.lang).toBe('en');

    setUiLanguage('ja');
    expect(getUiLocale()).toBe('ja');
    expect(t('settings.title')).toBe('設定');
    expect(MODES.translator.title).toBe('万能翻訳');
    expect(POLICY_BADGE.full.label).toBe('自動');
    if (typeof document !== 'undefined') expect(document.documentElement.lang).toBe('ja');

    setUiLanguage('zh-CN');
    expect(getUiLocale()).toBe('zh-CN');
    expect(t('settings.title')).toBe('设置');
    expect(MODES.translator.title).toBe('通用翻译');
    expect(POLICY_BADGE.full.label).toBe('自动');
    if (typeof document !== 'undefined') expect(document.documentElement.lang).toBe('zh-CN');
  });

  it('refreshes system language only when setting is system', () => {
    const origLang = Object.getOwnPropertyDescriptor(Navigator.prototype, 'language');
    const origLangs = Object.getOwnPropertyDescriptor(Navigator.prototype, 'languages');
    const setNav = (lang: string) => {
      Object.defineProperty(navigator, 'language', { configurable: true, value: lang });
      Object.defineProperty(navigator, 'languages', { configurable: true, value: [lang] });
    };
    try {
      setNav('ja-JP');
      setUiLanguage('system');
      expect(getUiLocale()).toBe('ja');

      setNav('en-US');
      expect(refreshSystemLanguage()).toBe('en');
      expect(getUiLocale()).toBe('en');

      setUiLanguage('zh-CN');
      setNav('ja-JP');
      expect(refreshSystemLanguage()).toBe('zh-CN');
      expect(getUiLocale()).toBe('zh-CN');
    } finally {
      if (origLang) Object.defineProperty(Navigator.prototype, 'language', origLang);
      else delete (navigator as unknown as Record<string, unknown>).language;
      if (origLangs) Object.defineProperty(Navigator.prototype, 'languages', origLangs);
      else delete (navigator as unknown as Record<string, unknown>).languages;
      setUiLanguage('system');
    }
  });
});

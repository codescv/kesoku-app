import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { MemoryPolicy } from '@kesoku/protocol';
import {
  ModeHud,
  TRANSLATOR_LANGS,
  isNativeLang,
  langKey,
  normalizeForeignLangs,
  resolveTranslatorPair,
  translatorLangLabel,
  type ModeHudProps,
} from '../src';
import { setUiLanguage } from '@kesoku/ui';
import { beforeAll as __beforeAll, afterAll as __afterAll } from 'vitest';

__beforeAll(() => setUiLanguage('zh-CN'));
__afterAll(() => setUiLanguage('system'));

afterEach(() => cleanup());

function setup(modePrefs: Record<string, unknown> = {}, stateFiles: Record<string, unknown> = {}) {
  const onPrefsChange = vi.fn<(p: Record<string, unknown>) => void>();
  render(
    <ModeHud
      modeId="translator"
      stateFiles={stateFiles}
      modePrefs={modePrefs}
      policy={'confirm_only' as MemoryPolicy}
      onPolicyChange={vi.fn()}
      onPrefsChange={onPrefsChange}
      onOpenPanel={vi.fn<ModeHudProps['onOpenPanel']>()}
    />,
  );
  return { onPrefsChange };
}

describe('translator language catalog (v0.3.7 Item 4)', () => {
  it('exports the 13-language catalog with labels and endonyms', () => {
    expect(TRANSLATOR_LANGS.map((l) => l.code)).toEqual(['zh-CN', 'zh-TW', 'ja', 'en', 'ko', 'fr', 'de', 'es', 'ru', 'th', 'vi', 'it', 'pt']);
    expect(TRANSLATOR_LANGS.find((l) => l.code === 'zh-CN')).toEqual({ code: 'zh-CN', label: '简中', name: '简体中文' });
    expect(TRANSLATOR_LANGS.find((l) => l.code === 'pt')?.label).toBe('葡语');
  });

  it('normalises aliases', () => {
    expect(langKey('zh')).toBe('zh-cn');
    expect(langKey('zh_Hant')).toBe('zh-tw');
    expect(isNativeLang('zh', 'zh-CN')).toBe(true);
    expect(isNativeLang('zh-TW', 'zh-CN')).toBe(false);
    expect(translatorLangLabel('zh-hans')).toBe('简中');
    expect(translatorLangLabel('xx')).toBe('xx');
    expect(normalizeForeignLangs('ja,en，ko zh-CN', 'zh-CN')).toEqual(['ja', 'en', 'ko']);
    expect(normalizeForeignLangs(['ja', 'JA', 'zh'], 'zh-CN')).toEqual(['ja']);
  });

  it('resolves prefs → translator.json → slots → defaults', () => {
    expect(resolveTranslatorPair({}, {})).toMatchObject({ nativeLang: 'zh-CN', foreignLangs: ['ja', 'en', 'ko'], src: 'ja', dst: 'zh-CN', foreign: 'ja' });
    const fromFile = resolveTranslatorPair({}, { 'game/translator.json': { native_lang: 'ja', foreign_langs: ['en', 'ja'], formality: 'casual' } });
    expect(fromFile).toMatchObject({ nativeLang: 'ja', foreignLangs: ['en'], src: 'en', dst: 'ja', foreign: 'en', formality: 'casual' });
    const slots = resolveTranslatorPair({}, {}, { id: 't', game: 'translator', slots: { native_lang: { value: 'en' }, foreign_langs: 'ja,ko' } } as never);
    expect(slots).toMatchObject({ nativeLang: 'en', foreignLangs: ['ja', 'ko'], src: 'ja', dst: 'en' });
    expect(resolveTranslatorPair({ native_lang: 'zh-CN', src_lang: 'zh-CN', dst_lang: 'ko' }, {}).foreign).toBe('ko');
    // `auto` slot defaults are treated as unset.
    const auto = resolveTranslatorPair({}, {}, { id: 't', game: 'translator', slots: { src_lang: 'auto', dst_lang: 'auto' } } as never);
    expect(auto).toMatchObject({ src: 'ja', dst: 'zh-CN', foreign: 'ja' });
  });
});

describe('TranslatorHud native / foreign languages (v0.3.7 Item 4)', () => {
  it('renders a quick pill per configured foreign language and keeps the native side when switching', () => {
    const { onPrefsChange } = setup({ native_lang: 'zh-CN', foreign_langs: ['ja', 'fr', 'th'], src_lang: 'ja', dst_lang: 'zh-CN' });
    expect(screen.getByRole('group', { name: '语言对' }).textContent).toBe('日语简中');
    for (const n of ['日语', '法语', '泰语']) expect(screen.getByRole('button', { name: n })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '韩语' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '法语' }));
    expect(onPrefsChange).toHaveBeenLastCalledWith({ src_lang: 'fr', dst_lang: 'zh-CN' });
  });

  it('switches the foreign side when the native language is the source', () => {
    const { onPrefsChange } = setup({ native_lang: 'zh-CN', foreign_langs: ['ja', 'en'], src_lang: 'zh-CN', dst_lang: 'ja' });
    expect(screen.getByRole('button', { name: '日语' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '英语' }));
    expect(onPrefsChange).toHaveBeenLastCalledWith({ src_lang: 'zh-CN', dst_lang: 'en' });
  });

  it('a foreign↔foreign pair snaps back to the native language on quick switch', () => {
    const { onPrefsChange } = setup({ native_lang: 'ja', foreign_langs: ['en', 'ko'], src_lang: 'en', dst_lang: 'ko' });
    fireEvent.click(screen.getByRole('button', { name: '韩语' }));
    expect(onPrefsChange).toHaveBeenLastCalledWith({ src_lang: 'ko', dst_lang: 'ja' });
  });

  it('语言设置 opens an inline configurator for 母语 / 常用外语 / 语体', () => {
    const { onPrefsChange } = setup({ native_lang: 'zh-CN', foreign_langs: ['ja', 'en', 'ko'], src_lang: 'ja', dst_lang: 'zh-CN' });
    const btn = screen.getByRole('button', { name: '语言设置' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('region', { name: '翻译语言设置' })).toBeNull();
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('region', { name: '翻译语言设置' })).toBeTruthy();

    const native = screen.getByRole('combobox', { name: '母语' }) as HTMLSelectElement;
    expect(native.value).toBe('zh-CN');
    expect(native.options).toHaveLength(TRANSLATOR_LANGS.length);
    fireEvent.change(native, { target: { value: 'ja' } });
    expect(onPrefsChange).toHaveBeenLastCalledWith({ native_lang: 'ja', foreign_langs: ['en', 'ko', 'zh-CN'], src_lang: 'en', dst_lang: 'ja' });

    fireEvent.click(screen.getByRole('button', { name: '常用外语 德语' }));
    expect(onPrefsChange).toHaveBeenLastCalledWith({ foreign_langs: ['ja', 'en', 'ko', 'de'] });
    fireEvent.click(screen.getByRole('button', { name: '常用外语 日语' }));
    expect(onPrefsChange).toHaveBeenLastCalledWith({ foreign_langs: ['en', 'ko'], src_lang: 'en', dst_lang: 'zh-CN' });

    fireEvent.click(screen.getByRole('button', { name: '礼貌敬体' }));
    expect(onPrefsChange).toHaveBeenLastCalledWith({ formality: 'polite' });
    fireEvent.click(screen.getByRole('button', { name: '自然口语' }));
    expect(onPrefsChange).toHaveBeenLastCalledWith({ formality: 'casual' });
  });

  it('never removes the last foreign language', () => {
    const { onPrefsChange } = setup({ native_lang: 'zh-CN', foreign_langs: ['ja'], src_lang: 'ja', dst_lang: 'zh-CN' });
    fireEvent.click(screen.getByRole('button', { name: '语言设置' }));
    fireEvent.click(screen.getByRole('button', { name: '常用外语 日语' }));
    expect(onPrefsChange).not.toHaveBeenCalled();
  });

  it('defaults (no prefs) show ja / en / ko pills with 日语 ⇄ 简中', () => {
    setup();
    expect(screen.getByRole('group', { name: '语言对' }).textContent).toBe('日语简中');
    for (const n of ['日语', '英语', '韩语']) expect(screen.getByRole('button', { name: n })).toBeTruthy();
  });
});

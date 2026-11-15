import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  setModePrefs: vi.fn(),
}));
vi.mock('../src/lib/client', () => ({ kesoku: m }));

import { TranslatorLangFields } from '../src/features/settings/SettingsScreen';
import { DEFAULT_SETTINGS, initialState, useStore } from '../src/lib/store';
import { mergeTranslatorModePrefs, translatorLangs, translatorSettingsPatch, translatorStartPrefs } from '../src/lib/translatorPrefs';

beforeEach(() => {
  useStore.setState(initialState(), true);
});
afterEach(() => cleanup());

describe('translator language settings', () => {
  it('defaults to 简中 native with ja/en/ko foreign languages', () => {
    expect(DEFAULT_SETTINGS.translatorNativeLang).toBe('zh-CN');
    expect(DEFAULT_SETTINGS.translatorForeignLangs).toEqual(['ja', 'en', 'ko']);
    expect(translatorStartPrefs(DEFAULT_SETTINGS)).toEqual({ native_lang: 'zh-CN', foreign_langs: ['ja', 'en', 'ko'], src_lang: 'ja', dst_lang: 'zh-CN' });
  });

  it('sanitises settings and merges them over session prefs', () => {
    expect(translatorLangs({ translatorNativeLang: 'ja', translatorForeignLangs: ['ja', 'en'] })).toEqual({ native_lang: 'ja', foreign_langs: ['en'] });
    expect(translatorLangs({ translatorNativeLang: '', translatorForeignLangs: [] }).foreign_langs).toEqual(['ja', 'en', 'ko']);
    expect(mergeTranslatorModePrefs({ src_lang: 'en', native_lang: 'old' }, { translatorNativeLang: 'zh-TW', translatorForeignLangs: ['en'] })).toEqual({
      src_lang: 'en',
      native_lang: 'zh-TW',
      foreign_langs: ['en'],
    });
    expect(translatorSettingsPatch({ src_lang: 'en' })).toBeNull();
    expect(translatorSettingsPatch({ native_lang: 'ko', foreign_langs: ['ja', 1] })).toEqual({ translatorNativeLang: 'ko', translatorForeignLangs: ['ja'] });
  });

  it('SettingsScreen fields change 翻译母语 and toggle 常用外语 (keeping at least one)', () => {
    render(<TranslatorLangFields />);
    const sel = screen.getByRole('combobox', { name: '翻译母语' }) as HTMLSelectElement;
    expect(sel.value).toBe('zh-CN');
    expect(sel.options).toHaveLength(13);
    const group = screen.getByRole('group', { name: '常用外语' });
    expect(group.querySelectorAll('button')).toHaveLength(12); // all but the native language
    fireEvent.click(screen.getByRole('button', { name: /法语/ }));
    expect(useStore.getState().settings.translatorForeignLangs).toEqual(['ja', 'en', 'ko', 'fr']);
    fireEvent.click(screen.getByRole('button', { name: /韩语/ }));
    expect(useStore.getState().settings.translatorForeignLangs).toEqual(['ja', 'en', 'fr']);
    fireEvent.change(sel, { target: { value: 'ja' } });
    expect(useStore.getState().settings.translatorNativeLang).toBe('ja');
    expect(useStore.getState().settings.translatorForeignLangs).toEqual(['en', 'fr']);
    // At least one foreign language is always kept.
    act(() => useStore.setState((s) => ({ settings: { ...s.settings, translatorForeignLangs: ['en'] } })));
    const en = screen.getByRole('button', { name: /英语/ }) as HTMLButtonElement;
    expect(en.disabled).toBe(true);
    fireEvent.click(en);
    expect(useStore.getState().settings.translatorForeignLangs).toEqual(['en']);
  });
});

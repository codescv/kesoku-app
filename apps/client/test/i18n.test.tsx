import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { getUiLocale, setUiLanguage } from '@kesoku/ui';
import { ModeHud } from '@kesoku/hud';
import { DEFAULT_SETTINGS, actions, useStore } from '../src/lib/store';
import { SettingsScreen } from '../src/features/settings/SettingsScreen';
import { TopBar } from '../src/app/TopBar';

vi.mock('../src/lib/client', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/client')>('../src/lib/client');
  return {
    ...actual,
    kesoku: {
      ...actual.kesoku,
      rpc: vi.fn().mockResolvedValue({ devices: [] }),
      setRole: vi.fn().mockResolvedValue(undefined),
      setMode: vi.fn().mockResolvedValue(undefined),
      setModePrefs: vi.fn().mockResolvedValue(undefined),
    },
  };
});

describe('client UI i18n reactivity & settings integration', () => {
  beforeEach(() => {
    actions.reset();
    useStore.setState({
      currentSessionId: 's1',
      sessions: {
        s1: { session_id: 's1', title: 'Test', mode_id: 'translator', updated_at: 1_700_000_000 } as never,
      },
    });
  });

  afterEach(() => {
    setUiLanguage('system');
  });

  it('defaults Settings.language to system', () => {
    expect(DEFAULT_SETTINGS.language).toBe('system');
    expect(useStore.getState().settings.language).toBe('system');
  });

  it('renders 4-option Language selector in Settings Appearance card and switches UI reactively without reload', () => {
    setUiLanguage('en');
    actions.setSettings({ language: 'en' });

    render(
      <>
        <TopBar sessionId={null} modeId="chat" onMenu={() => {}} showMenu={false} />
        <ModeHud modeId="translator" stateFiles={{}} modePrefs={{}} policy="confirm_only" onPolicyChange={() => {}} onPrefsChange={() => {}} onOpenPanel={() => {}} />
        <SettingsScreen onClose={() => {}} />
      </>,
    );

    const langRow = screen.getByTestId('settings-language-row');
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    expect(within(langRow).getByRole('radio', { name: 'System Default' })).toBeTruthy();
    expect(within(langRow).getByRole('radio', { name: '中文' })).toBeTruthy();
    expect(within(langRow).getByRole('radio', { name: 'English' }).getAttribute('aria-checked')).toBe('true');
    expect(within(langRow).getByRole('radio', { name: '日本語' })).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
    expect(screen.getByRole('button', { name: 'Language settings' })).toBeTruthy();

    // Translator language pair must stay intact across UI language switches.
    const origNative = useStore.getState().settings.translatorNativeLang;
    const origForeign = [...useStore.getState().settings.translatorForeignLangs];

    // Switch to Japanese live
    fireEvent.click(within(langRow).getByRole('radio', { name: '日本語' }));
    expect(useStore.getState().settings.language).toBe('ja');
    expect(getUiLocale()).toBe('ja');
    expect(document.documentElement.lang).toBe('ja');
    expect(screen.getByRole('heading', { level: 1, name: '設定' })).toBeTruthy();
    expect(within(langRow).getByRole('radio', { name: 'システムに従う' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '言語設定' })).toBeTruthy();

    // Switch to Chinese live
    fireEvent.click(within(langRow).getByRole('radio', { name: '中文' }));
    expect(useStore.getState().settings.language).toBe('zh-CN');
    expect(getUiLocale()).toBe('zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(screen.getByRole('heading', { level: 1, name: '设置' })).toBeTruthy();
    expect(within(langRow).getByRole('radio', { name: '跟随系统' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '语言设置' })).toBeTruthy();

    // Translator language pair untouched
    expect(useStore.getState().settings.translatorNativeLang).toBe(origNative);
    expect(useStore.getState().settings.translatorForeignLangs).toEqual(origForeign);

    // Switch back to System Default
    fireEvent.click(within(langRow).getByRole('radio', { name: '跟随系统' }));
    expect(useStore.getState().settings.language).toBe('system');
  });
});

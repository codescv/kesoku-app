import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setUiLanguage } from '@kesoku/ui';

vi.mock('../src/lib/client', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/client')>('../src/lib/client');
  return {
    ...actual,
    kesoku: {
      ...actual.kesoku,
      rpc: vi.fn().mockResolvedValue({ devices: [] }),
    },
  };
});

import { SettingsScreen, formatBytes } from '../src/features/settings/SettingsScreen';
import { __mediaCacheTest, getMediaCacheStats, putCachedImage } from '../src/lib/mediaCache';
import { actions, useStore } from '../src/lib/store';

let blobSeq = 0;

beforeEach(async () => {
  blobSeq = 0;
  actions.reset();
  setUiLanguage('zh-CN');
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:settings/${++blobSeq}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  await __mediaCacheTest.resetAll();
});

afterEach(async () => {
  setUiLanguage('system');
  vi.restoreAllMocks();
  await __mediaCacheTest.resetAll();
});

describe('formatBytes', () => {
  it('formats bytes cleanly across B, KB, MB, and GB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(42.3 * 1024 * 1024)).toBe('42.3 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
  });
});

describe('SettingsScreen · Image Cache section', () => {
  it('shows 0 B / 1 GB and disables clear button when cache is empty', async () => {
    render(<SettingsScreen onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('media-cache-usage').textContent).toBe('0 B / 1 GB（0 张）'));
    const btn = screen.getByTestId('clear-media-cache-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain('清除图片缓存');
  });

  it('displays populated cache usage, clears cache on click without native dialogs, updates stats, and shows toast', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    await putCachedImage(['obj:media/s1/a.png'], new Blob([new Uint8Array(2048)], { type: 'image/png' }), 'image/png');
    await putCachedImage(['obj:media/s1/b.webp'], new Blob([new Uint8Array(4096)], { type: 'image/webp' }), 'image/webp');

    render(<SettingsScreen onClose={() => {}} />);

    await waitFor(() => expect(screen.getByTestId('media-cache-usage').textContent).toBe('6 KB / 1 GB（2 张）'));
    const btn = screen.getByTestId('clear-media-cache-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() => expect(screen.getByTestId('media-cache-usage').textContent).toBe('0 B / 1 GB（0 张）'));
    expect(btn.disabled).toBe(true);
    expect((await getMediaCacheStats()).count).toBe(0);
    expect(useStore.getState().toasts.some((t) => t.text === '已清除图片缓存')).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('renders localized labels in English and Japanese', async () => {
    await putCachedImage(['obj:media/s1/only.png'], new Blob([new Uint8Array(1024)], { type: 'image/png' }), 'image/png');

    setUiLanguage('en');
    const { rerender } = render(<SettingsScreen onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('media-cache-usage').textContent).toBe('1 KB / 1 GB (1 image)'));
    expect(screen.getByTestId('clear-media-cache-btn').textContent).toContain('Clear image cache');

    act(() => {
      setUiLanguage('ja');
    });
    rerender(<SettingsScreen onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('media-cache-usage').textContent).toBe('1 KB / 1 GB（1 枚）'));
    expect(screen.getByTestId('clear-media-cache-btn').textContent).toContain('画像キャッシュを削除');
  });
});

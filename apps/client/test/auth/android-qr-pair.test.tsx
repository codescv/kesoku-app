import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Capacitor } from '@capacitor/core';
import { initialState, useStore } from '../../src/lib/store';
import { AuthScreen } from '../../src/features/auth/AuthScreen';
import { tryNativeQrScan } from '../../src/native/qr';

// Native secure storage is not available under jsdom (AuthScreen reads the relay on native platforms).
vi.mock('../../src/native/secureStore', () => ({
  secureStore: { get: async () => null, set: async () => {}, remove: async () => {} },
}));

describe('Android 扫码配对', () => {
  type CapGlobal = { nativePromise?: (...a: unknown[]) => Promise<unknown> };
  let savedNativePromise: CapGlobal['nativePromise'];
  let hanging: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useStore.setState(initialState());
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    // Android's Bridge logs InvalidPluginMethodException for Camera.scanQRCode and never settles the call.
    hanging = vi.fn(() => new Promise(() => {}));
    const g = globalThis as unknown as { Capacitor?: CapGlobal };
    g.Capacitor ??= {};
    savedNativePromise = g.Capacitor.nativePromise;
    g.Capacitor.nativePromise = hanging as never;
  });
  afterEach(() => {
    cleanup();
    const g = globalThis as unknown as { Capacitor?: CapGlobal };
    if (g.Capacitor) g.Capacitor.nativePromise = savedNativePromise;
    vi.restoreAllMocks();
  });

  it('tryNativeQrScan resolves unavailable immediately on Android without calling Camera.scanQRCode', async () => {
    await expect(tryNativeQrScan()).resolves.toEqual({ status: 'unavailable' });
    expect(hanging).not.toHaveBeenCalled();
  });

  it('tapping 扫码配对 on Android opens QrScannerModal with 拍照识别 + 从相册选择', async () => {
    render(<AuthScreen onDone={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /扫码配对/ }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: '扫描配对二维码' })).toBeTruthy());
    expect(hanging).not.toHaveBeenCalledWith('Camera', 'scanQRCode', expect.anything());
    expect(screen.getByTestId('qr-take-photo').textContent).toContain('拍照识别');
    expect(screen.getByTestId('qr-pick-gallery').textContent).toContain('从相册选择');
  });
});

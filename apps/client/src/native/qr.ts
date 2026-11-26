import jsQR from 'jsqr';
import { getUiLocale } from '@kesoku/ui';
import { getPlatform, isNative } from './platform';

interface BarcodeDetectorLike {
  detect(source: ImageBitmapSource): Promise<Array<{ rawValue?: string }>>;
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
}

/**
 * Decodes a QR code from raw RGBA pixels using `jsQR` with `attemptBoth` inversion so both
 * standard dark-on-light QR codes and inverted terminal ASCII QR codes (`invert=True`) decode.
 */
export function decodeQrFromImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): string | null {
  if (width <= 0 || height <= 0 || data.length < width * height * 4) return null;
  const hit = jsQR(data, width, height, { inversionAttempts: 'attemptBoth' });
  const text = hit?.data?.trim();
  return text ? text : null;
}

/**
 * Decodes a QR code from a `<video>` or `<img>` / `ImageBitmap` element using the browser's
 * hardware `BarcodeDetector` when available, falling back to `<canvas>` + `jsQR`.
 */
export async function decodeQrFromSource(
  source: HTMLVideoElement | HTMLImageElement | ImageBitmap,
  canvas: HTMLCanvasElement,
  maxDim = 960,
): Promise<string | null> {
  const Ctor = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
  if (typeof Ctor === 'function') {
    try {
      const detector = new Ctor({ formats: ['qr_code'] });
      const results = await detector.detect(source);
      const val = results?.[0]?.rawValue?.trim();
      if (val) return val;
    } catch {
      // Fall through to canvas + jsQR.
    }
  }

  const rawW =
    source instanceof HTMLVideoElement
      ? source.videoWidth
      : source instanceof HTMLImageElement
        ? source.naturalWidth || source.width
        : source.width;
  const rawH =
    source instanceof HTMLVideoElement
      ? source.videoHeight
      : source instanceof HTMLImageElement
        ? source.naturalHeight || source.height
        : source.height;
  if (!rawW || !rawH) return null;

  const scale = Math.min(1, maxDim / Math.max(rawW, rawH));
  const w = Math.max(1, Math.round(rawW * scale));
  const h = Math.max(1, Math.round(rawH * scale));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, w, h);
  const imgData = ctx.getImageData(0, 0, w, h);
  return decodeQrFromImageData(imgData.data, w, h);
}

/**
 * Decodes a QR code from a picked image `Blob` / `File`.
 */
export async function decodeQrFromBlob(blob: Blob): Promise<string | null> {
  const canvas = document.createElement('canvas');
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob);
      try {
        return await decodeQrFromSource(bmp, canvas, 1280);
      } finally {
        bmp.close?.();
      }
    } catch {
      // Fall back to HTMLImageElement below.
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Image load failed'));
      el.src = url;
    });
    return await decodeQrFromSource(img, canvas, 1280);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export type NativeQrOutcome =
  | { status: 'scanned'; value: string }
  | { status: 'cancelled' }
  | { status: 'unavailable' };

/**
 * Invokes the native iOS `Camera.scanQRCode` sheet when available on the Capacitor bridge.
 * Returns `{ status: 'unavailable' }` on platforms where the in-WebView `<QrScannerModal>` should be used.
 *
 * iOS only: `scanQRCode` exists solely in our iOS bridge. On Android, `@capacitor/camera`'s CameraPlugin
 * has no such method and Capacitor's Bridge only logs the InvalidPluginMethodException without rejecting
 * the call, so the promise would hang forever and 扫码配对 would do nothing.
 */
export async function tryNativeQrScan(): Promise<NativeQrOutcome> {
  if (!isNative() || getPlatform() !== 'ios') return { status: 'unavailable' };
  const cap = (globalThis as unknown as {
    Capacitor?: {
      nativePromise?: (plugin: string, method: string, options: Record<string, unknown>) => Promise<{ value?: string }>;
    };
  }).Capacitor;
  if (typeof cap?.nativePromise !== 'function') return { status: 'unavailable' };
  try {
    const res = await cap.nativePromise('Camera', 'scanQRCode', { lang: getUiLocale() });
    const val = res?.value?.trim();
    return val ? { status: 'scanned', value: val } : { status: 'cancelled' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/cancel/i.test(msg)) return { status: 'cancelled' };
    return { status: 'unavailable' };
  }
}

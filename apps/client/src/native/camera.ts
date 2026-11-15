import { Camera, CameraResultType, CameraSource, MediaTypeSelection } from '@capacitor/camera';
import { isNative } from './platform';

export interface PickImagesOptions {
  /**
   * `'camera'` takes a new photo (native: system camera via `Camera.takePhoto`; web: the `capture`
   * attribute so mobile browsers open the camera directly); `'gallery'` (default) shows the photo picker.
   */
  source?: 'gallery' | 'camera';
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
};

function clampMax(max: number): number {
  if (!Number.isFinite(max)) return 1;
  return Math.max(1, Math.min(20, Math.floor(max)));
}

async function webPathToFile(webPath: string, index: number): Promise<File> {
  const res = await fetch(webPath);
  if (!res.ok) throw new Error(`camera: cannot read picked image (${res.status})`);
  const blob = await res.blob();
  const ext = (webPath.split('?')[0]?.split('.').pop() ?? '').toLowerCase();
  const type = blob.type || MIME_BY_EXT[ext] || 'image/jpeg';
  const suffix = Object.keys(MIME_BY_EXT).includes(ext) ? ext : 'jpg';
  return new File([blob], `image-${Date.now()}-${index}.${suffix}`, { type });
}

/** Web picker: hidden <input type=file>. Resolves [] when the user cancels. */
function pickWithInput(max: number, source: 'gallery' | 'camera'): Promise<File[]> {
  return new Promise<File[]>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = max > 1;
    if (source === 'camera') input.setAttribute('capture', 'environment');
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.style.opacity = '0';
    let settled = false;
    const finish = (files: File[]): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []).filter((f) => f.type.startsWith('image/'));
      finish(files.slice(0, max));
    });
    input.addEventListener('cancel', () => finish([]));
    document.body.appendChild(input);
    input.click();
  });
}

function isCancel(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /cancel/i.test(msg);
}

/**
 * Ensures the OS camera permission (Android `Manifest.permission.CAMERA` / iOS camera usage) is granted
 * before `getUserMedia` / the system camera. Resolves `true` when granted or on web; never throws.
 */
export async function ensureCameraPermission(): Promise<boolean> {
  if (!isNative()) return true;
  try {
    const cur = await Camera.checkPermissions();
    if (cur.camera === 'granted' || cur.camera === 'limited') return true;
    const next = await Camera.requestPermissions({ permissions: ['camera'] });
    return next.camera === 'granted' || next.camera === 'limited';
  } catch {
    return false;
  }
}

/** Native system camera: one new photo. Resolves [] when the user cancels. */
async function takeNativePhoto(): Promise<File[]> {
  let webPath: string | undefined;
  try {
    webPath = (await Camera.takePhoto({ quality: 90, correctOrientation: true, editable: 'no' })).webPath;
  } catch (err) {
    if (isCancel(err)) return [];
    // Older native plugin builds without takePhoto: fall back to the legacy getPhoto API.
    try {
      webPath = (await Camera.getPhoto({ quality: 90, correctOrientation: true, resultType: CameraResultType.Uri, source: CameraSource.Camera })).webPath;
    } catch (err2) {
      if (isCancel(err2)) return [];
      throw err2;
    }
  }
  return webPath ? [await webPathToFile(webPath, 0)] : [];
}

/**
 * Lets the user pick up to `max` images (call from a tap handler).
 * Native: system photo picker via @capacitor/camera. Web: file input.
 * Resolves to an empty array if the user cancels.
 */
export async function pickImages(max: number, options: PickImagesOptions = {}): Promise<File[]> {
  const limit = clampMax(max);
  if (!isNative()) return pickWithInput(limit, options.source ?? 'gallery');
  if (options.source === 'camera') return takeNativePhoto();

  let results;
  try {
    ({ results } = await Camera.chooseFromGallery({
      mediaType: MediaTypeSelection.Photo,
      allowMultipleSelection: limit > 1,
      limit,
      quality: 85,
      correctOrientation: true,
    }));
  } catch (err) {
    if (isCancel(err)) return [];
    throw err;
  }
  const paths = results
    .map((r) => r.webPath)
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .slice(0, limit);
  return Promise.all(paths.map((p, i) => webPathToFile(p, i)));
}

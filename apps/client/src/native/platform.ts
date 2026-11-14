import { Capacitor } from '@capacitor/core';

export type Platform = 'web' | 'android' | 'ios';

/** Runtime platform: the Capacitor Android / iOS shells, or a plain browser (PWA). */
export function getPlatform(): Platform {
  const p = Capacitor.getPlatform();
  return p === 'android' || p === 'ios' ? p : 'web';
}

/** True inside the Capacitor Android / iOS shells. */
export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

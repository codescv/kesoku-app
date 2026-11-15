import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface ApkInstallResult {
  filePath: string;
  sizeBytes?: number;
  installerLaunched: boolean;
  installed: boolean;
  needsPermission: boolean;
}

export interface ApkDownloadProgressEvent {
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
}

export interface ApkInstallResumedEvent {
  filePath: string;
  installerLaunched: boolean;
}

export interface KesokuUpdaterPlugin {
  downloadAndInstallApk(options: { url: string; version: string }): Promise<ApkInstallResult>;
  installApkFile(options: { filePath: string }): Promise<ApkInstallResult>;
  addListener(
    eventName: 'apkDownloadProgress',
    listenerFunc: (event: ApkDownloadProgressEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'apkInstallResumed',
    listenerFunc: (event: ApkInstallResumedEvent) => void,
  ): Promise<PluginListenerHandle>;
}

const NOOP_HANDLE: PluginListenerHandle = {
  remove: async () => {},
};

export const NativeUpdater = registerPlugin<KesokuUpdaterPlugin>('KesokuUpdater');

export async function downloadAndInstallApk(options: { url: string; version: string }): Promise<ApkInstallResult> {
  return NativeUpdater.downloadAndInstallApk(options);
}

export async function installApkFile(options: { filePath: string }): Promise<ApkInstallResult> {
  return NativeUpdater.installApkFile(options);
}

export async function onApkDownloadProgress(
  listener: (event: ApkDownloadProgressEvent) => void,
): Promise<PluginListenerHandle> {
  try {
    if (typeof NativeUpdater.addListener !== 'function') return NOOP_HANDLE;
    return await NativeUpdater.addListener('apkDownloadProgress', listener);
  } catch {
    return NOOP_HANDLE;
  }
}

export async function onApkInstallResumed(
  listener: (event: ApkInstallResumedEvent) => void,
): Promise<PluginListenerHandle> {
  try {
    if (typeof NativeUpdater.addListener !== 'function') return NOOP_HANDLE;
    return await NativeUpdater.addListener('apkInstallResumed', listener);
  } catch {
    return NOOP_HANDLE;
  }
}

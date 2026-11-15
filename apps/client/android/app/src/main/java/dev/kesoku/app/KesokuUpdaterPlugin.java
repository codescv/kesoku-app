package dev.kesoku.app;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.annotation.Nullable;
import androidx.core.content.FileProvider;
import androidx.core.content.pm.PackageInfoCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native in-app APK updater (`KesokuUpdater`):
 * <ul>
 *   <li>{@link #downloadAndInstallApk(PluginCall)}: streams a GitHub Release APK into
 *       {@code <cacheDir>/updates/kesoku-<version>.apk} via atomic {@code .tmp} rename, following
 *       up to 5 redirects (rejecting HTTPS -> HTTP downgrades), emitting
 *       {@code apkDownloadProgress} events, verifying ZIP magic ({@code PK\x03\x04}) and
 *       {@link PackageManager#getPackageArchiveInfo} ({@code dev.kesoku.app} + non-downgrade
 *       {@code versionCode}), and launching the Android system package installer via
 *       {@link FileProvider}.</li>
 *   <li>{@link #installApkFile(PluginCall)}: re-verifies and launches the system package installer
 *       for an already-downloaded cached APK.</li>
 *   <li>{@link #resumePendingApkInstall(Context)}: called from {@code MainActivity.onResume()} so
 *       returning from {@link Settings#ACTION_MANAGE_UNKNOWN_APP_SOURCES} automatically launches
 *       the pending APK installer and notifies JS ({@code apkInstallResumed}).</li>
 * </ul>
 */
@CapacitorPlugin(name = "KesokuUpdater")
public class KesokuUpdaterPlugin extends Plugin {
    private static final String EXPECTED_PACKAGE_NAME = "dev.kesoku.app";
    private static final long DOWNLOAD_PROGRESS_THROTTLE_MS = 200L;

    @Nullable private static volatile KesokuUpdaterPlugin activeInstance;
    @Nullable private static volatile File pendingInstallApkFile;

    private final ExecutorService ioPool = Executors.newSingleThreadExecutor();

    @Override
    public void load() {
        super.load();
        activeInstance = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (activeInstance == this) {
            activeInstance = null;
        }
        ioPool.shutdownNow();
        super.handleOnDestroy();
    }

    @PluginMethod
    public void downloadAndInstallApk(PluginCall call) {
        final String rawUrl = call.getString("url", "");
        final String version = call.getString("version", "latest");
        if (rawUrl == null || rawUrl.trim().isEmpty()) {
            call.reject("Missing APK download URL", "invalid-argument");
            return;
        }

        ioPool.execute(() -> {
            File tmpFile = null;
            try {
                File updatesDir = new File(getContext().getCacheDir(), "updates");
                if (!updatesDir.exists() && !updatesDir.mkdirs() && !updatesDir.exists()) {
                    throw new IOException("Cannot create updates cache directory");
                }
                String safeVer = (version != null ? version : "latest")
                    .replaceAll("[^a-zA-Z0-9._-]", "_");
                if (safeVer.isEmpty()) safeVer = "latest";

                File apkFile = new File(updatesDir, "kesoku-" + safeVer + ".apk");
                tmpFile = new File(updatesDir, "kesoku-" + safeVer + ".apk.tmp");

                URL parsedCurrent = new URL(rawUrl.trim());
                String initialScheme = parsedCurrent.getProtocol();
                if (!"https".equalsIgnoreCase(initialScheme) && !"http".equalsIgnoreCase(initialScheme)) {
                    throw new IllegalArgumentException("Unsupported APK URL scheme: " + initialScheme);
                }

                HttpURLConnection conn = null;
                for (int redirect = 0; ; redirect++) {
                    conn = (HttpURLConnection) parsedCurrent.openConnection();
                    conn.setInstanceFollowRedirects(false);
                    conn.setConnectTimeout(15_000);
                    conn.setReadTimeout(60_000);
                    conn.setRequestProperty("User-Agent", "Kesoku-Updater/1.0");
                    conn.setRequestProperty(
                        "Accept",
                        "application/octet-stream, application/vnd.android.package-archive, */*"
                    );
                    conn.setRequestProperty("Accept-Encoding", "identity");

                    int status = conn.getResponseCode();
                    if (status == HttpURLConnection.HTTP_MOVED_PERM
                        || status == HttpURLConnection.HTTP_MOVED_TEMP
                        || status == HttpURLConnection.HTTP_SEE_OTHER
                        || status == 307
                        || status == 308) {
                        if (redirect >= 5) {
                            conn.disconnect();
                            throw new IOException("Too many redirects (>5) when downloading APK");
                        }
                        String loc = conn.getHeaderField("Location");
                        conn.disconnect();
                        if (loc == null || loc.trim().isEmpty()) {
                            throw new IOException("Redirect HTTP " + status + " missing Location header");
                        }
                        URL nextUrl = new URL(parsedCurrent, loc.trim());
                        if ("https".equalsIgnoreCase(parsedCurrent.getProtocol())
                            && !"https".equalsIgnoreCase(nextUrl.getProtocol())) {
                            throw new SecurityException(
                                "Refusing HTTPS -> HTTP downgrade redirect when downloading APK"
                            );
                        }
                        parsedCurrent = nextUrl;
                        continue;
                    }

                    if (status < 200 || status >= 300) {
                        conn.disconnect();
                        throw new IOException("HTTP " + status + " when downloading APK");
                    }
                    break;
                }

                long totalBytes = conn.getContentLengthLong();
                long downloadedBytes = 0L;
                long lastNotifyMs = 0L;

                try (InputStream in = conn.getInputStream();
                     FileOutputStream out = new FileOutputStream(tmpFile)) {
                    byte[] buf = new byte[32_768];
                    int n;
                    while ((n = in.read(buf)) >= 0) {
                        out.write(buf, 0, n);
                        downloadedBytes += n;
                        long now = System.currentTimeMillis();
                        if (now - lastNotifyMs >= DOWNLOAD_PROGRESS_THROTTLE_MS
                            || (totalBytes > 0 && downloadedBytes >= totalBytes)) {
                            lastNotifyMs = now;
                            JSObject progress = new JSObject();
                            progress.put("downloadedBytes", downloadedBytes);
                            progress.put("totalBytes", totalBytes);
                            progress.put(
                                "percent",
                                totalBytes > 0
                                    ? Math.min(100, (int) ((downloadedBytes * 100L) / totalBytes))
                                    : -1
                            );
                            notifyListeners("apkDownloadProgress", progress);
                        }
                    }
                    out.flush();
                    out.getFD().sync();
                } finally {
                    conn.disconnect();
                }

                verifyApkArchive(getContext(), tmpFile);

                if (apkFile.exists() && !apkFile.delete()) {
                    throw new IOException("Cannot replace existing cached APK");
                }
                if (!tmpFile.renameTo(apkFile)) {
                    throw new IOException("Failed to finalize downloaded APK via atomic rename");
                }

                boolean launched = launchApkInstaller(getContext(), apkFile);
                JSObject ret = new JSObject();
                ret.put("filePath", apkFile.getAbsolutePath());
                ret.put("sizeBytes", apkFile.length());
                ret.put("installerLaunched", launched);
                ret.put("installed", launched);
                ret.put("needsPermission", !launched);
                call.resolve(ret);
            } catch (Exception e) {
                if (tmpFile != null && tmpFile.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    tmpFile.delete();
                }
                call.reject("APK download failed: " + e.getMessage(), "update-failed", e);
            }
        });
    }

    @PluginMethod
    public void installApkFile(PluginCall call) {
        String filePath = call.getString("filePath", "");
        if (filePath == null || filePath.trim().isEmpty()) {
            call.reject("Missing filePath", "invalid-argument");
            return;
        }
        try {
            File updatesCanonical = new File(getContext().getCacheDir(), "updates").getCanonicalFile();
            File apkFile = new File(filePath).getCanonicalFile();
            String allowedPrefix = updatesCanonical.getPath() + File.separator;
            if (!apkFile.getPath().startsWith(allowedPrefix) || !apkFile.exists()) {
                call.reject("APK file not found in updates cache", "not-found");
                return;
            }
            verifyApkArchive(getContext(), apkFile);
            boolean launched = launchApkInstaller(getContext(), apkFile);
            JSObject ret = new JSObject();
            ret.put("filePath", apkFile.getAbsolutePath());
            ret.put("installerLaunched", launched);
            ret.put("installed", launched);
            ret.put("needsPermission", !launched);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to launch APK installer: " + e.getMessage(), "update-failed", e);
        }
    }

    public static void resumePendingApkInstall(Context context) {
        File pending = pendingInstallApkFile;
        if (pending == null || !pending.exists()) {
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && !context.getPackageManager().canRequestPackageInstalls()) {
            return;
        }
        pendingInstallApkFile = null;
        try {
            startPackageInstallViewIntent(context, pending);
            KesokuUpdaterPlugin plugin = activeInstance;
            if (plugin != null) {
                JSObject ev = new JSObject();
                ev.put("filePath", pending.getAbsolutePath());
                ev.put("installerLaunched", true);
                plugin.notifyListeners("apkInstallResumed", ev);
            }
        } catch (Exception ignored) {
            // User can still tap the install button manually in Settings
        }
    }

    @SuppressWarnings("deprecation")
    private static void verifyApkArchive(Context context, File file) throws Exception {
        if (file.length() < 1024L) {
            throw new IOException("Downloaded file is too small (" + file.length() + " bytes)");
        }
        try (FileInputStream checkIn = new FileInputStream(file)) {
            byte[] magic = new byte[4];
            if (checkIn.read(magic) != 4
                || magic[0] != 0x50
                || magic[1] != 0x4B
                || magic[2] != 0x03
                || magic[3] != 0x04) {
                throw new SecurityException("Downloaded file does not have ZIP/APK magic (PK\\x03\\x04)");
            }
        }

        PackageManager pm = context.getPackageManager();
        PackageInfo archiveInfo = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            ? pm.getPackageArchiveInfo(file.getAbsolutePath(), PackageManager.PackageInfoFlags.of(0))
            : pm.getPackageArchiveInfo(file.getAbsolutePath(), 0);
        if (archiveInfo == null || !EXPECTED_PACKAGE_NAME.equals(archiveInfo.packageName)) {
            String foundPkg = archiveInfo != null ? archiveInfo.packageName : "null";
            throw new SecurityException(
                "APK packageName mismatch (expected " + EXPECTED_PACKAGE_NAME + ", got " + foundPkg + ")"
            );
        }

        PackageInfo installedInfo = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            ? pm.getPackageInfo(context.getPackageName(), PackageManager.PackageInfoFlags.of(0))
            : pm.getPackageInfo(context.getPackageName(), 0);
        long archiveVersionCode = PackageInfoCompat.getLongVersionCode(archiveInfo);
        long installedVersionCode = PackageInfoCompat.getLongVersionCode(installedInfo);
        if (archiveVersionCode < installedVersionCode) {
            throw new SecurityException(
                "Refusing APK versionCode downgrade (" + archiveVersionCode + " < " + installedVersionCode + ")"
            );
        }
    }

    private static boolean launchApkInstaller(Context context, File apkFile) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (!context.getPackageManager().canRequestPackageInstalls()) {
                pendingInstallApkFile = apkFile;
                Intent permIntent = new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + context.getPackageName())
                );
                permIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    context.startActivity(permIntent);
                } catch (ActivityNotFoundException fallbackErr) {
                    Intent fallback = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
                    fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    context.startActivity(fallback);
                }
                return false;
            }
        }
        pendingInstallApkFile = null;
        startPackageInstallViewIntent(context, apkFile);
        return true;
    }

    private static void startPackageInstallViewIntent(Context context, File apkFile) {
        Uri apkUri = FileProvider.getUriForFile(
            context,
            context.getPackageName() + ".fileprovider",
            apkFile
        );
        Intent installIntent = new Intent(Intent.ACTION_VIEW);
        installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
        installIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        context.startActivity(installIntent);
    }
}

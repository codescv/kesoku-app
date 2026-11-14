import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.kesoku.app',
  appName: 'Kesoku',
  // Output of `vite build` (see vite.config.ts).
  webDir: 'dist',
  server: {
    // Secure origin https://localhost on Android (IndexedDB, crypto.subtle, ES modules).
    androidScheme: 'https',
    // iOS uses capacitor://localhost served by WKURLSchemeHandler.
    iosScheme: 'capacitor',
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
    captureInput: false,
  },
  ios: {
    // WKWebView is laid out edge-to-edge; the web layer handles safe areas via env().
    contentInset: 'never',
    limitsNavigationsToAppBoundDomains: false,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    Keyboard: {
      resize: 'body',
      resizeOnFullScreen: true,
    },
    // Disable Capacitor's default SystemBars DecorView padding so MainActivity can keep the
    // WebView fully edge-to-edge and expose the insets as --safe-* CSS variables.
    SystemBars: {
      insetsHandling: 'disable',
    },
  },
};

export default config;

package dev.kesoku.app;

import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import java.util.Locale;

/**
 * Edge-to-edge host activity.
 *
 * <p>The WebView always covers the whole window (behind the status bar, navigation bar and
 * display cutout). System bar / cutout insets are forwarded to the page as the CSS custom
 * properties {@code --safe-top/--safe-right/--safe-bottom/--safe-left} (in CSS px), which the
 * client uses as the fallback for {@code env(safe-area-inset-*)}. While the soft keyboard is
 * visible the window is padded at the bottom by the IME height so the page shrinks above it,
 * and {@code --safe-bottom} drops to 0 because the navigation bar is covered by the keyboard.
 */
public class MainActivity extends BridgeActivity {
    private float safeTopDp = 0f;
    private float safeRightDp = 0f;
    private float safeBottomDp = 0f;
    private float safeLeftDp = 0f;
    private float imeDp = 0f;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins must be registered before super.onCreate() builds the bridge.
        registerPlugin(KesokuSecureStorePlugin.class);
        registerPlugin(KesokuTtsPlugin.class);
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        if (window != null) {
            WindowCompat.setDecorFitsSystemWindows(window, false);
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.TRANSPARENT);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                window.setStatusBarContrastEnforced(false);
                window.setNavigationBarContrastEnforced(false);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                WindowManager.LayoutParams lp = window.getAttributes();
                lp.layoutInDisplayCutoutMode =
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                        ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                        : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                window.setAttributes(lp);
            }
            applySystemBarAppearance();

            View decorView = window.getDecorView();
            View content = findViewById(android.R.id.content);
            if (content != null) {
                content.setPadding(0, 0, 0, 0);
            }

            ViewCompat.setOnApplyWindowInsetsListener(decorView, (v, windowInsets) -> {
                Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
                );
                Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
                boolean kbVisible = windowInsets.isVisible(WindowInsetsCompat.Type.ime());
                float density = getResources().getDisplayMetrics().density;
                if (density <= 0f) density = 1f;

                safeTopDp = bars.top / density;
                safeRightDp = bars.right / density;
                safeBottomDp = (kbVisible ? 0 : bars.bottom) / density;
                safeLeftDp = bars.left / density;

                // Keep the WebView full-screen; only lift it above the keyboard while it is open.
                int imePadBottom = kbVisible && ime.bottom > 0 ? ime.bottom : 0;
                imeDp = imePadBottom / density;
                v.setPadding(0, 0, 0, imePadBottom);
                if (content != null) {
                    content.setPadding(0, 0, 0, 0);
                }
                syncSafeAreaCssVars();

                return new WindowInsetsCompat.Builder(windowInsets)
                    .setInsets(
                        WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout(),
                        Insets.of(0, 0, 0, 0)
                    )
                    .build();
            });
            ViewCompat.requestApplyInsets(decorView);
        }

        if (getBridge() != null) {
            getBridge().addWebViewListener(new WebViewListener() {
                @Override
                public void onPageCommitVisible(WebView view, String url) {
                    syncSafeAreaCssVars();
                }

                @Override
                public void onPageLoaded(WebView view) {
                    syncSafeAreaCssVars();
                }
            });
            WebView webView = getBridge().getWebView();
            if (webView != null) {
                webView.setBackgroundColor(Color.TRANSPARENT);
                webView.postDelayed(this::syncSafeAreaCssVars, 150);
                webView.postDelayed(this::syncSafeAreaCssVars, 600);
            }
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        if (getWindow() != null) {
            ViewCompat.requestApplyInsets(getWindow().getDecorView());
        }
        syncSafeAreaCssVars();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applySystemBarAppearance();
        if (getWindow() != null) {
            ViewCompat.requestApplyInsets(getWindow().getDecorView());
        }
    }

    /** Dark status/navigation icons on the light theme, light icons on the dark theme. */
    private void applySystemBarAppearance() {
        Window window = getWindow();
        if (window == null) return;
        boolean night =
            (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        WindowInsetsControllerCompat controller =
            WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setAppearanceLightStatusBars(!night);
        controller.setAppearanceLightNavigationBars(!night);
    }

    private void syncSafeAreaCssVars() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        WebView webView = getBridge().getWebView();
        String js = String.format(
            Locale.US,
            "(function(){var r=document.documentElement.style;"
                + "r.setProperty('--safe-top','%.2fpx');"
                + "r.setProperty('--safe-right','%.2fpx');"
                + "r.setProperty('--safe-bottom','%.2fpx');"
                + "r.setProperty('--safe-left','%.2fpx');"
                + "r.setProperty('--keyboard-height','%.2fpx');"
                + "})();",
            safeTopDp, safeRightDp, safeBottomDp, safeLeftDp, imeDp
        );
        webView.post(() -> webView.evaluateJavascript(js, null));
    }
}

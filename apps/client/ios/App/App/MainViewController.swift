import UIKit
import Capacitor

/// Root view controller: the standard Capacitor bridge plus Kesoku's local plugins.
///
/// The WKWebView is laid out edge-to-edge (`ios.contentInset = 'never'` in
/// capacitor.config.ts); the page handles notches and the home indicator itself with
/// `env(safe-area-inset-*)` (index.html uses `viewport-fit=cover`).
class MainViewController: CAPBridgeViewController {
    private var hasAppeared = false

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(KesokuSecureStorePlugin())
        bridge?.registerPluginInstance(KesokuTtsPlugin())
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        let background = UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0x15 / 255.0, green: 0x17 / 255.0, blue: 0x1C / 255.0, alpha: 1)
                : UIColor(red: 0xFA / 255.0, green: 0xF8 / 255.0, blue: 0xF5 / 255.0, alpha: 1)
        }
        view.backgroundColor = background
        webView?.isOpaque = false
        webView?.backgroundColor = background
        webView?.scrollView.backgroundColor = background
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if !hasAppeared {
            hasAppeared = true
            // Plugins are registered and listening now; release deep links queued by App
            // Intents that ran before the bridge finished loading.
            DispatchQueue.main.async {
                KesokuDeepLinkRouter.markReady()
            }
        }
    }
}

/// Delivers in-app `kesoku://` URLs (from App Intents) to the web layer through the same
/// path as URLs opened by the system, i.e. the App plugin's `appUrlOpen` event.
enum KesokuDeepLinkRouter {
    @MainActor private static var ready = false
    @MainActor private static var pending: [URL] = []

    @MainActor static func open(_ url: URL) {
        if ready {
            deliver(url)
        } else {
            pending.append(url)
        }
    }

    @MainActor static func markReady() {
        ready = true
        let queued = pending
        pending.removeAll()
        queued.forEach(deliver)
    }

    @MainActor private static func deliver(_ url: URL) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
    }
}

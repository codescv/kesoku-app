import AppIntents
import Foundation

// App Shortcuts (Shortcuts app, Spotlight, Siri and the Action button). No extra entitlement
// is required. Each intent foregrounds Kesoku and opens the matching kesoku://mode/* deep
// link, which the web layer maps to a mode (src/native/deeplinks.ts).

@available(iOS 16.0, *)
struct OpenTranslatorIntent: AppIntent {
    static let title: LocalizedStringResource = "打开通用翻译"
    static let openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        KesokuDeepLinkRouter.open(KesokuModeLink.translator)
        return .result()
    }
}

@available(iOS 16.0, *)
struct OpenTravelIntent: AppIntent {
    static let title: LocalizedStringResource = "打开旅游助手"
    static let openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        KesokuDeepLinkRouter.open(KesokuModeLink.travel)
        return .result()
    }
}

@available(iOS 16.0, *)
struct OpenPokemonIntent: AppIntent {
    static let title: LocalizedStringResource = "打开宝可梦助手"
    static let openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        KesokuDeepLinkRouter.open(KesokuModeLink.pokemon)
        return .result()
    }
}

@available(iOS 16.0, *)
struct KesokuAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: OpenTranslatorIntent(),
            phrases: [
                "用\(.applicationName)打开通用翻译",
                "\(.applicationName)通用翻译"
            ]
        )
        AppShortcut(
            intent: OpenTravelIntent(),
            phrases: [
                "用\(.applicationName)打开旅游助手",
                "\(.applicationName)旅游助手"
            ]
        )
        AppShortcut(
            intent: OpenPokemonIntent(),
            phrases: [
                "用\(.applicationName)打开宝可梦助手",
                "\(.applicationName)宝可梦助手"
            ]
        )
    }
}

enum KesokuModeLink {
    // Static, well-formed URLs.
    // swiftlint:disable force_unwrapping
    static let translator = URL(string: "kesoku://mode/translator")!
    static let travel = URL(string: "kesoku://mode/travel")!
    static let pokemon = URL(string: "kesoku://mode/pokemon")!
    // swiftlint:enable force_unwrapping
}

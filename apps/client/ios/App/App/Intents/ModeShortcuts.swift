import AppIntents
import Foundation

// App Shortcuts (Shortcuts app, Spotlight, Siri and the Action button). No extra entitlement
// is required. Each intent foregrounds Kesoku and opens the matching kesoku://mode/* deep
// link, which the web layer maps to a mode (src/native/deeplinks.ts).

@available(iOS 16.0, *)
struct OpenTranslatorIntent: AppIntent {
    static let title: LocalizedStringResource = LocalizedStringResource("intent.open_translator.title", defaultValue: "Open Translator")
    static let openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        KesokuDeepLinkRouter.open(KesokuModeLink.translator)
        return .result()
    }
}

@available(iOS 16.0, *)
struct OpenTravelIntent: AppIntent {
    static let title: LocalizedStringResource = LocalizedStringResource("intent.open_travel.title", defaultValue: "Open Travel Assistant")
    static let openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        KesokuDeepLinkRouter.open(KesokuModeLink.travel)
        return .result()
    }
}

@available(iOS 16.0, *)
struct OpenPokemonIntent: AppIntent {
    static let title: LocalizedStringResource = LocalizedStringResource("intent.open_pokemon.title", defaultValue: "Open Pokémon Assistant")
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
                "Open Translator in \(.applicationName)",
                "\(.applicationName) Translator"
            ],
            shortTitle: LocalizedStringResource("intent.open_translator.short_title", defaultValue: "Translator"),
            systemImageName: "character.bubble"
        )
        AppShortcut(
            intent: OpenTravelIntent(),
            phrases: [
                "Open Travel Assistant in \(.applicationName)",
                "\(.applicationName) Travel Assistant"
            ],
            shortTitle: LocalizedStringResource("intent.open_travel.short_title", defaultValue: "Travel Assistant"),
            systemImageName: "airplane.departure"
        )
        AppShortcut(
            intent: OpenPokemonIntent(),
            phrases: [
                "Open Pokémon Assistant in \(.applicationName)",
                "\(.applicationName) Pokémon Assistant"
            ],
            shortTitle: LocalizedStringResource("intent.open_pokemon.short_title", defaultValue: "Pokémon Assistant"),
            systemImageName: "sparkles"
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

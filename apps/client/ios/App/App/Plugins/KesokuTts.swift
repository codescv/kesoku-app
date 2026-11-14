import Foundation
import AVFoundation
import Capacitor

/// Native text-to-speech using `AVSpeechSynthesizer`.
///
/// Only invoked by the web layer in response to an explicit user tap. A new `speak`
/// interrupts the current utterance.
///
/// JS API: `speak({text, lang?, rate?}) -> {interrupted: boolean}` (resolves when the
/// utterance finishes or is interrupted), `stop()`.
@objc(KesokuTtsPlugin)
public class KesokuTtsPlugin: CAPPlugin, CAPBridgedPlugin, AVSpeechSynthesizerDelegate {
    public let identifier = "KesokuTtsPlugin"
    public let jsName = "KesokuTts"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    private static let maxTextChars = 4000

    // Accessed on the main queue only.
    private var synthesizer: AVSpeechSynthesizer?
    private var inFlight: [ObjectIdentifier: CAPPluginCall] = [:]

    @objc func speak(_ call: CAPPluginCall) {
        let text = (call.getString("text") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.count <= Self.maxTextChars else {
            call.reject("Invalid text", "INVALID_TEXT")
            return
        }
        let lang = call.getString("lang")
        let rateArg = call.getDouble("rate") ?? 1.0

        var voice: AVSpeechSynthesisVoice?
        if let lang, !lang.isEmpty {
            voice = AVSpeechSynthesisVoice(language: lang)
            if voice == nil {
                call.reject("Language not supported: \(lang)", "LANG_UNSUPPORTED")
                return
            }
        }

        DispatchQueue.main.async {
            let synth = self.ensureSynthesizer()
            if synth.isSpeaking {
                // Triggers didCancel for the previous utterance, resolving it as interrupted.
                synth.stopSpeaking(at: .immediate)
            }
            let session = AVAudioSession.sharedInstance()
            try? session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try? session.setActive(true)

            let utterance = AVSpeechUtterance(string: text)
            if let voice { utterance.voice = voice }
            let factor = Float(min(3.0, max(0.25, rateArg)))
            utterance.rate = min(
                AVSpeechUtteranceMaximumSpeechRate,
                max(AVSpeechUtteranceMinimumSpeechRate, AVSpeechUtteranceDefaultSpeechRate * factor)
            )
            self.inFlight[ObjectIdentifier(utterance)] = call
            synth.speak(utterance)
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.synthesizer?.stopSpeaking(at: .immediate)
            call.resolve()
        }
    }

    private func ensureSynthesizer() -> AVSpeechSynthesizer {
        if let synthesizer { return synthesizer }
        let synth = AVSpeechSynthesizer()
        synth.delegate = self
        synthesizer = synth
        return synth
    }

    private func finish(_ utterance: AVSpeechUtterance, interrupted: Bool) {
        if let call = inFlight.removeValue(forKey: ObjectIdentifier(utterance)) {
            call.resolve(["interrupted": interrupted])
        }
        if inFlight.isEmpty {
            try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        }
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        finish(utterance, interrupted: false)
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        finish(utterance, interrupted: true)
    }
}

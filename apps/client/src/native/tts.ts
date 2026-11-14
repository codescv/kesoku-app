import { registerPlugin } from '@capacitor/core';
import { isNative } from './platform';

/**
 * Text-to-speech.
 *
 * - Android: `KesokuTts` local plugin (android.speech.tts.TextToSpeech).
 * - iOS: `KesokuTts` local plugin (AVSpeechSynthesizer).
 * - Web: `window.speechSynthesis`.
 *
 * Product rule: speech is only ever produced in direct response to a user tap (never
 * automatically). `speak()` must be called synchronously from a click / pointer handler; on the
 * web it refuses to run without transient user activation.
 */
export interface SpeakOptions {
  text: string;
  /** BCP-47 language tag, e.g. `ja-JP`, `zh-CN`, `en-US`. */
  lang?: string;
  /** 0.25-3, 1 = normal. */
  rate?: number;
}

export interface SpeakResult {
  /** True when stopped by `stop()` or replaced by a newer `speak()`. */
  interrupted: boolean;
}

interface KesokuTtsPlugin {
  speak(options: { text: string; lang?: string; rate?: number }): Promise<SpeakResult>;
  stop(): Promise<void>;
}

const NativeTts = registerPlugin<KesokuTtsPlugin>('KesokuTts');

const MAX_TEXT_CHARS = 4000;

interface UserActivationLike {
  readonly isActive: boolean;
  readonly hasBeenActive: boolean;
}

function userActivation(): UserActivationLike | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as Navigator & { userActivation?: UserActivationLike }).userActivation;
}

function clampRate(rate: number | undefined): number {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return 1;
  return Math.min(3, Math.max(0.25, rate));
}

export function isTtsAvailable(): boolean {
  return isNative() || (typeof window !== 'undefined' && 'speechSynthesis' in window);
}

export async function speak(options: SpeakOptions): Promise<SpeakResult> {
  const text = typeof options.text === 'string' ? options.text.trim() : '';
  if (!text || text.length > MAX_TEXT_CHARS) throw new TypeError('tts: invalid text');
  const rate = clampRate(options.rate);
  const activation = userActivation();

  if (isNative()) {
    // The native engines do not need activation; still refuse before any user interaction.
    if (activation && !activation.hasBeenActive) throw new Error('tts: requires a user gesture');
    return NativeTts.speak({ text, lang: options.lang, rate });
  }

  if (activation && !activation.isActive) throw new Error('tts: requires a user gesture');
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    throw new Error('tts: speechSynthesis unavailable');
  }
  const synth = window.speechSynthesis;
  synth.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  if (options.lang) {
    utter.lang = options.lang;
    const lang = options.lang.toLowerCase();
    const voice =
      synth.getVoices().find((v) => v.lang.toLowerCase() === lang) ??
      synth.getVoices().find((v) => v.lang.toLowerCase().startsWith(lang.split('-')[0] ?? lang));
    if (voice) utter.voice = voice;
  }
  utter.rate = rate;
  return new Promise<SpeakResult>((resolve, reject) => {
    utter.onend = () => resolve({ interrupted: false });
    utter.onerror = (ev: SpeechSynthesisErrorEvent) => {
      if (ev.error === 'interrupted' || ev.error === 'canceled') resolve({ interrupted: true });
      else reject(new Error(`tts: ${ev.error}`));
    };
    synth.speak(utter);
  });
}

export async function stop(): Promise<void> {
  if (isNative()) {
    await NativeTts.stop();
    return;
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}

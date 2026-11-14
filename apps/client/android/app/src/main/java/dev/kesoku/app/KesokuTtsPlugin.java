package dev.kesoku.app;

import android.media.AudioAttributes;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Native text-to-speech using the system {@link TextToSpeech} engine.
 *
 * <p>The engine is bound lazily on the first {@code speak} call, which the web layer only
 * issues from an explicit user tap. A new {@code speak} interrupts the current utterance.
 *
 * <p>JS API: {@code speak({text, lang?, rate?}) -> {interrupted: boolean}} (resolves when the
 * utterance finishes or is interrupted), {@code stop()}.
 */
@CapacitorPlugin(name = "KesokuTts")
public class KesokuTtsPlugin extends Plugin {
    private static final int MAX_TEXT_CHARS = 4000;

    private TextToSpeech tts;
    private boolean ready = false;
    private boolean initFailed = false;
    private final List<PluginCall> waitingForInit = new ArrayList<>();
    private final Map<String, PluginCall> inFlight = new HashMap<>();
    private final AtomicLong nextId = new AtomicLong(1);

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text");
        if (text == null || text.trim().isEmpty() || text.length() > MAX_TEXT_CHARS) {
            call.reject("Invalid text", "INVALID_TEXT");
            return;
        }
        synchronized (this) {
            if (initFailed) {
                call.reject("Text-to-speech engine unavailable", "UNAVAILABLE");
                return;
            }
            if (!ready) {
                waitingForInit.add(call);
                ensureEngine();
                return;
            }
        }
        doSpeak(call);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        synchronized (this) {
            if (tts != null && ready) {
                tts.stop();
            }
            for (PluginCall pending : waitingForInit) {
                resolveInterrupted(pending, true);
            }
            waitingForInit.clear();
        }
        call.resolve();
    }

    private void ensureEngine() {
        if (tts != null) return;
        tts = new TextToSpeech(getContext().getApplicationContext(), status -> {
            List<PluginCall> queued;
            synchronized (KesokuTtsPlugin.this) {
                if (status == TextToSpeech.SUCCESS) {
                    ready = true;
                    tts.setAudioAttributes(
                        new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build()
                    );
                    tts.setOnUtteranceProgressListener(new Progress());
                } else {
                    initFailed = true;
                }
                queued = new ArrayList<>(waitingForInit);
                waitingForInit.clear();
            }
            for (PluginCall c : queued) {
                if (status == TextToSpeech.SUCCESS) {
                    doSpeak(c);
                } else {
                    c.reject("Text-to-speech engine unavailable", "UNAVAILABLE");
                }
            }
        });
    }

    private void doSpeak(PluginCall call) {
        String text = call.getString("text", "");
        String lang = call.getString("lang");
        Float rateArg = call.getFloat("rate", 1.0f);
        float rate = rateArg == null ? 1.0f : Math.max(0.25f, Math.min(rateArg, 3.0f));

        synchronized (this) {
            if (lang != null && !lang.isEmpty()) {
                int res = tts.setLanguage(Locale.forLanguageTag(lang));
                if (res == TextToSpeech.LANG_MISSING_DATA || res == TextToSpeech.LANG_NOT_SUPPORTED) {
                    call.reject("Language not supported: " + lang, "LANG_UNSUPPORTED");
                    return;
                }
            }
            tts.setSpeechRate(rate);
            String id = "kesoku-" + nextId.getAndIncrement();
            inFlight.put(id, call);
            int res = tts.speak(text, TextToSpeech.QUEUE_FLUSH, new Bundle(), id);
            if (res != TextToSpeech.SUCCESS) {
                inFlight.remove(id);
                call.reject("Speak failed", "SPEAK_FAILED");
            }
        }
    }

    private PluginCall take(String id) {
        synchronized (this) {
            return inFlight.remove(id);
        }
    }

    private static void resolveInterrupted(PluginCall call, boolean interrupted) {
        JSObject ret = new JSObject();
        ret.put("interrupted", interrupted);
        call.resolve(ret);
    }

    private final class Progress extends UtteranceProgressListener {
        @Override
        public void onStart(String utteranceId) {}

        @Override
        public void onDone(String utteranceId) {
            PluginCall call = take(utteranceId);
            if (call != null) resolveInterrupted(call, false);
        }

        @Override
        public void onStop(String utteranceId, boolean interrupted) {
            PluginCall call = take(utteranceId);
            if (call != null) resolveInterrupted(call, true);
        }

        @Override
        @Deprecated
        public void onError(String utteranceId) {
            PluginCall call = take(utteranceId);
            if (call != null) call.reject("Speech synthesis error", "SPEAK_FAILED");
        }

        @Override
        public void onError(String utteranceId, int errorCode) {
            PluginCall call = take(utteranceId);
            if (call != null) call.reject("Speech synthesis error " + errorCode, "SPEAK_FAILED");
        }
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (this) {
            if (tts != null) {
                tts.stop();
                tts.shutdown();
                tts = null;
            }
            ready = false;
            for (PluginCall c : inFlight.values()) resolveInterrupted(c, true);
            inFlight.clear();
            for (PluginCall c : waitingForInit) resolveInterrupted(c, true);
            waitingForInit.clear();
        }
        super.handleOnDestroy();
    }
}

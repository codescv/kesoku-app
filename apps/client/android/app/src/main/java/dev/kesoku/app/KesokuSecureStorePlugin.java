package dev.kesoku.app;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.regex.Pattern;
import org.json.JSONObject;

/**
 * Small encrypted key/value store for device credentials.
 *
 * <p>Values are kept in {@link EncryptedSharedPreferences} (AES-256-SIV keys, AES-256-GCM
 * values) under a hardware-backed master key when available. The file is excluded from backup
 * and device transfer (see AndroidManifest / data_extraction_rules.xml), so credentials never
 * leave this install.
 *
 * <p>JS API: {@code get({key}) -> {value: string|null}}, {@code set({key, value})},
 * {@code remove({key})}.
 */
@CapacitorPlugin(name = "KesokuSecureStore")
@SuppressWarnings("deprecation")
public class KesokuSecureStorePlugin extends Plugin {
    private static final String PREFS_NAME = "kesoku_secure_store";
    private static final Pattern KEY_PATTERN = Pattern.compile("^[A-Za-z0-9._:-]{1,128}$");
    private static final int MAX_VALUE_CHARS = 64 * 1024;

    private SharedPreferences prefs;

    private synchronized SharedPreferences prefs() throws Exception {
        if (prefs != null) return prefs;
        Context context = getContext().getApplicationContext();
        try {
            prefs = open(context);
        } catch (Exception first) {
            // The master key can become unusable (e.g. keystore reset after a device restore).
            // The stored credential is then unrecoverable anyway: start from an empty store so
            // the user can simply pair again.
            context.deleteSharedPreferences(PREFS_NAME);
            prefs = open(context);
        }
        return prefs;
    }

    private static SharedPreferences open(Context context) throws Exception {
        MasterKey masterKey = new MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build();
        return EncryptedSharedPreferences.create(
            context,
            PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        );
    }

    private static String validKey(PluginCall call) {
        String key = call.getString("key");
        if (key == null || !KEY_PATTERN.matcher(key).matches()) {
            call.reject("Invalid key", "INVALID_KEY");
            return null;
        }
        return key;
    }

    @PluginMethod
    public void get(PluginCall call) {
        String key = validKey(call);
        if (key == null) return;
        try {
            String value = prefs().getString(key, null);
            JSObject ret = new JSObject();
            ret.put("value", value == null ? JSONObject.NULL : value);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Secure store unavailable", "UNAVAILABLE", e);
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = validKey(call);
        if (key == null) return;
        String value = call.getString("value");
        if (value == null || value.length() > MAX_VALUE_CHARS) {
            call.reject("Invalid value", "INVALID_VALUE");
            return;
        }
        try {
            if (prefs().edit().putString(key, value).commit()) {
                call.resolve();
            } else {
                call.reject("Write failed", "WRITE_FAILED");
            }
        } catch (Exception e) {
            call.reject("Secure store unavailable", "UNAVAILABLE", e);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = validKey(call);
        if (key == null) return;
        try {
            if (prefs().edit().remove(key).commit()) {
                call.resolve();
            } else {
                call.reject("Write failed", "WRITE_FAILED");
            }
        } catch (Exception e) {
            call.reject("Secure store unavailable", "UNAVAILABLE", e);
        }
    }
}

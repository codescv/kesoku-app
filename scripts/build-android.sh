#!/usr/bin/env bash
# Build a signed release APK of the Kesoku client.
#
#   scripts/build-android.sh
#
# Steps: (1) create a local release keystore + apps/client/android/keystore.properties on first
# run (both gitignored; the random password is written only to keystore.properties, never
# printed), (2) build the web client, (3) `cap sync android`, (4) `gradlew assembleRelease`,
# (5) verify the signature. Output: apps/client/android/app/build/outputs/apk/release/
#
# Requirements: Node 22 + pnpm, JDK 21 (JAVA_HOME or `java` on PATH; keytool), Android SDK
# (ANDROID_HOME / ANDROID_SDK_ROOT) with platform 36 and build-tools installed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT="$ROOT/apps/client"
ANDROID_DIR="$CLIENT/android"
PROPS="$ANDROID_DIR/keystore.properties"
KEYSTORE_NAME="kesoku-release.jks"
KEY_ALIAS="kesoku"
APK_DIR="$ANDROID_DIR/app/build/outputs/apk/release"

log() { printf '\033[1;34m[build-android]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[build-android]\033[0m %s\n' "$*" >&2; exit 1; }

command -v pnpm >/dev/null 2>&1 || die "pnpm not found on PATH"
if [[ -n "${JAVA_HOME:-}" ]]; then
  KEYTOOL="$JAVA_HOME/bin/keytool"
else
  KEYTOOL="$(command -v keytool || true)"
fi
[[ -x "$KEYTOOL" ]] || die "keytool not found (set JAVA_HOME to a JDK 21 install)"

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[[ -n "$SDK" && -d "$SDK" ]] || die "Android SDK not found (set ANDROID_HOME)"
if [[ ! -f "$ANDROID_DIR/local.properties" ]]; then
  printf 'sdk.dir=%s\n' "$SDK" > "$ANDROID_DIR/local.properties"
fi

# 1. Release keystore (local, self-managed; APKs are side-loaded, not store-distributed).
if [[ ! -f "$PROPS" ]]; then
  [[ -f "$ANDROID_DIR/$KEYSTORE_NAME" ]] && die "$KEYSTORE_NAME exists but keystore.properties is missing; restore it or move the keystore away"
  log "Generating local release keystore ($KEYSTORE_NAME)"
  umask 077
  PASS="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)"
  [[ ${#PASS} -ge 32 ]] || die "failed to generate keystore password"
  # Write the properties file first (0600) so the password never touches argv of other tools
  # or the terminal; keytool reads it from the environment.
  {
    printf 'storeFile=%s\n' "$KEYSTORE_NAME"
    printf 'storePassword=%s\n' "$PASS"
    printf 'keyAlias=%s\n' "$KEY_ALIAS"
    printf 'keyPassword=%s\n' "$PASS"
  } > "$PROPS"
  chmod 600 "$PROPS"
  KESOKU_KS_PASS="$PASS" "$KEYTOOL" -genkeypair -noprompt \
    -keystore "$ANDROID_DIR/$KEYSTORE_NAME" -storetype PKCS12 \
    -storepass:env KESOKU_KS_PASS -keypass:env KESOKU_KS_PASS \
    -alias "$KEY_ALIAS" -keyalg RSA -keysize 4096 -validity 10000 \
    -dname "CN=Kesoku, O=Kesoku" >/dev/null 2>&1 || { rm -f "$PROPS" "$ANDROID_DIR/$KEYSTORE_NAME"; die "keytool failed"; }
  chmod 600 "$ANDROID_DIR/$KEYSTORE_NAME"
  unset PASS
  log "Keystore created. Back up apps/client/android/$KEYSTORE_NAME and keystore.properties privately: updates must be signed with the same key."
fi

# 2. Web client.
log "Building web client"
(cd "$ROOT" && pnpm --filter @kesoku/client build)

# 3. Copy web assets + plugin config into the Android project.
log "cap sync android"
(cd "$CLIENT" && pnpm exec cap sync android)

# 4. Gradle release build (signed via keystore.properties).
log "gradlew assembleRelease"
(cd "$ANDROID_DIR" && ./gradlew --no-daemon assembleRelease)

APK="$APK_DIR/app-release.apk"
[[ -f "$APK" ]] || die "release APK not found at $APK (is keystore.properties valid?)"

# 5. Verify signature.
APKSIGNER="$(ls -1d "$SDK"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -n 1 || true)"
if [[ -n "$APKSIGNER" ]]; then
  "$APKSIGNER" verify --print-certs "$APK" | grep -E 'Signer #1 certificate (DN|SHA-256)' || die "apksigner verification failed"
fi

VERSION="$(grep -m1 'versionName' "$ANDROID_DIR/app/build.gradle" | sed -E 's/.*"([^"]+)".*/\1/')"
cp -f "$APK" "$APK_DIR/kesoku-$VERSION-release.apk"
log "Done: $APK_DIR/kesoku-$VERSION-release.apk"

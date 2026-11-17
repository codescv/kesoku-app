#!/usr/bin/env bash
# Build and export a signed Kesoku .ipa for side-loading (macOS + Xcode only).
#
#   APPLE_TEAM_ID=ABCDE12345 scripts/build-ios.sh [development|ad-hoc]
#
# development (default): devices registered in your Development profile (Xcode automatic
#   signing registers connected devices).
# ad-hoc: up to 100 registered devices, installed via Apple Configurator / Finder.
# Neither needs push certificates or App Store review. Output: apps/client/ios/App/output/
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/dev-env.sh
. "$ROOT/scripts/dev-env.sh"

METHOD="${1:-development}"
case "$METHOD" in
  development|ad-hoc) ;;
  *) echo "usage: APPLE_TEAM_ID=<team id> $0 [development|ad-hoc]" >&2; exit 2 ;;
esac

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[build-ios] iOS builds require macOS with Xcode 16+; skipping on $(uname -s)." >&2
  echo "[build-ios] The Xcode project lives in apps/client/ios/App (open App.xcodeproj on a Mac)." >&2
  exit 1
fi
command -v xcodebuild >/dev/null 2>&1 || { echo "[build-ios] xcodebuild not found (install Xcode)" >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "[build-ios] pnpm not found on PATH" >&2; exit 1; }

TEAM="${APPLE_TEAM_ID:-}"
if [[ ! "$TEAM" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "[build-ios] set APPLE_TEAM_ID to your 10-character Apple Developer Team ID" >&2
  exit 1
fi

CLIENT="$ROOT/apps/client"
IOS_APP="$CLIENT/ios/App"
BUILD_DIR="$IOS_APP/build"
OUT_DIR="$IOS_APP/output"
ARCHIVE="$BUILD_DIR/Kesoku.xcarchive"

log() { printf '\033[1;34m[build-ios]\033[0m %s\n' "$*"; }

log "Building web client"
(cd "$ROOT" && pnpm --filter @kesoku/client build)

log "cap sync ios"
(cd "$CLIENT" && pnpm exec cap sync ios)

mkdir -p "$BUILD_DIR" "$OUT_DIR"
EXPORT_PLIST="$BUILD_DIR/ExportOptions.$METHOD.plist"
sed -e "s/&lt;APPLE_TEAM_ID&gt;/$TEAM/" \
    -e "s#<string>development</string>#<string>$METHOD</string>#" \
    "$IOS_APP/ExportOptions.plist" > "$EXPORT_PLIST"

log "xcodebuild archive"
rm -rf "$ARCHIVE"
xcodebuild \
  -project "$IOS_APP/App.xcodeproj" \
  -scheme App \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM" \
  CODE_SIGN_STYLE=Automatic \
  archive

log "xcodebuild -exportArchive ($METHOD)"
xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$EXPORT_PLIST" \
  -exportPath "$OUT_DIR" \
  -allowProvisioningUpdates

IPA="$(ls -1 "$OUT_DIR"/*.ipa 2>/dev/null | head -n 1 || true)"
[[ -n "$IPA" ]] || { echo "[build-ios] export finished but no .ipa found in $OUT_DIR" >&2; exit 1; }
log "Done: $IPA"

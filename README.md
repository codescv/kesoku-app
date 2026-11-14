# Kesoku

Kesoku is a 4-platform client (Web PWA · Android · iOS) plus a Cloud Run relay for the
self-hosted **Kesoku Engine**. All intelligence and storage stay on the engine host; the relay is a
stateless authenticated WebSocket bridge that also serves the PWA and issues short-lived signed media URLs.

```
apps/
  client/   React 19 + Vite 6 + Zustand + Dexie, packaged with Capacitor 8 (android/, ios/)
  relay/    Node 22 + Hono + ws (two-leg bridge, /pair, /auth/*, signed media, static PWA)
packages/
  protocol/ zod schemas + TS types for the V1.2 wire protocol (see packages/protocol/PROTOCOL.md)
  ui/       design tokens (Warm Washi Light × Frosted Night Dark) + atomic components
  hud/      $STAGING_DIR/game/*.json → mode HUD registry
scripts/    deploy-relay.sh · build-android.sh · build-ios.sh · check-native-deps.mjs · check-terms.mjs
```

## Requirements

Node ≥ 22.13, pnpm 10. No native Node addons anywhere (`pnpm-workspace.yaml` keeps
`onlyBuiltDependencies: []`; verify with `pnpm check:native`).

## Develop

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm build

# local relay (binds 127.0.0.1; offline local-disk media)
ENGINE_TOKEN=$(openssl rand -hex 32) DEVICE_HMAC_KEY=$(openssl rand -hex 32) \
LOCAL_MEDIA_DIR=/tmp/kesoku-media PORT=8787 STATIC_DIR=apps/client/dist \
  node apps/relay/dist/index.js

# client dev server (proxies /ws /auth /pair to 127.0.0.1:8787)
pnpm dev:client
```

Pair a device: on the engine host run `kesoku app pair --name "My phone"` and enter the 6-digit
code within 2 minutes (5 wrong attempts burn the code).

## Mobile

* Android (`dev.kesoku.app`, minSdk 26 / target 35): `pnpm build:apk` → signed APK under
  `apps/client/android/app/build/outputs/apk/release/` (local keystore is generated on first run and
  never committed — back it up privately).
* iOS (`apps/client/ios/App`, Bundle ID `dev.kesoku.app`): `scripts/build-ios.sh development|ad-hoc`
  on macOS with `APPLE_TEAM_ID` set. Entitlements contain only `keychain-access-groups`.

## Deploy the relay

`scripts/deploy-relay.sh` deploys `kesoku-relay` to Cloud Run (single instance, 60-min WebSocket
timeout, secrets from Secret Manager). See the script header for required environment variables.

## Security notes

* Device tokens: `kdt1.*` HMAC, stored in Keychain / EncryptedSharedPreferences on mobile; on the Web
  the token lives only in an `HttpOnly; Secure; SameSite=Lax` `__Host-kesoku_session` cookie.
* With Google Sign-In configured, the Web app accepts only allowlisted Google accounts (`ALLOWED_EMAILS`);
  6-digit pairing remains for the iOS / Android apps (and for the Web in local mode without Firebase).
* No `innerHTML` / `dangerouslySetInnerHTML`: Markdown and `<ruby>` are rendered as React elements.
* Voice never autoplays: audio URLs are resolved only inside the ▶ tap handler.
* Relay sends strict CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`.

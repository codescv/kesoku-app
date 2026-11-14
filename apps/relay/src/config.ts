import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS } from '@kesoku/protocol';

/** Tunable limits (overridable in tests). */
export interface RelayLimits {
  inboundQueue: number;
  ringPerSession: number;
  rotateAfterMs: number;
  rotateGraceMs: number;
  /** Hard close of a leg that ignored `relay.rotate` (Cloud Run kills it at 60 min anyway). */
  rotateForceCloseMs: number;
  engineDrainMs: number;
  authHelloTimeoutMs: number;
  engineHelloTimeoutMs: number;
  restartRetryMs: number;
  heartbeatMs: number;
  handshakeConcurrentPerIp: number;
  handshakePerMinutePerIp: number;
  pairMaxAttemptsPerOffer: number;
  pairIpLimit: number;
  pairIpWindowMs: number;
  authGoogleIpLimit: number;
  authGoogleIpWindowMs: number;
  clientMaxFrameBytes: number;
  engineMaxFrameBytes: number;
  mediaPutMaxBytes: number;
  messageMediaMaxBytes: number;
  avatarSourceMaxBytes: number;
  mediaPutTtlS: number;
  mediaGetTtlS: number;
}

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
}

export interface RelayConfig {
  engineToken: string;
  deviceHmacKey: string;
  /** Lower-cased. */
  allowedEmails: string[];
  firebaseProjectId?: string;
  /** Public Firebase web config for the client's Google popup (not secret); null when unset. */
  firebaseWeb: FirebaseWebConfig | null;
  mediaBucket?: string;
  localMediaDir?: string;
  staticDir?: string;
  /** e.g. `https://relay.example.com` (no trailing slash). */
  publicOrigin?: string;
  /** Extra origins allowed for CORS on `/pair` + `/auth/*` and cookie-less WS (native WebViews). */
  corsOrigins: string[];
  /** Use rightmost `X-Forwarded-For` as client IP. */
  trustProxy: boolean;
  /** Running on Cloud Run (`K_SERVICE` set) → HSTS. */
  cloudRun: boolean;
  /** Local (offline) mode: LOCAL_MEDIA_DIR set → CSP also allows loopback http/ws. */
  localMode: boolean;
  limits: RelayLimits;
}

export const DEFAULT_LIMITS: RelayLimits = Object.freeze({
  inboundQueue: LIMITS.ENGINE_INBOUND_QUEUE,
  ringPerSession: LIMITS.RING_BUFFER_PER_SESSION,
  rotateAfterMs: LIMITS.ROTATE_AFTER_MS,
  rotateGraceMs: LIMITS.ROTATE_GRACE_MS,
  rotateForceCloseMs: 60_000,
  engineDrainMs: LIMITS.ENGINE_DRAIN_MS,
  authHelloTimeoutMs: LIMITS.AUTH_HELLO_TIMEOUT_MS,
  engineHelloTimeoutMs: LIMITS.AUTH_HELLO_TIMEOUT_MS,
  restartRetryMs: 3000,
  heartbeatMs: LIMITS.PING_INTERVAL_MS,
  handshakeConcurrentPerIp: 5,
  handshakePerMinutePerIp: 30,
  pairMaxAttemptsPerOffer: LIMITS.PAIR_MAX_ATTEMPTS_PER_OFFER,
  pairIpLimit: LIMITS.PAIR_IP_LIMIT,
  pairIpWindowMs: LIMITS.PAIR_IP_WINDOW_MS,
  authGoogleIpLimit: 20,
  authGoogleIpWindowMs: 10 * 60 * 1000,
  clientMaxFrameBytes: 1_048_576,
  engineMaxFrameBytes: 2 * 1_048_576,
  mediaPutMaxBytes: 1_048_576,
  messageMediaMaxBytes: LIMITS.MESSAGE_MEDIA_MAX_BYTES,
  avatarSourceMaxBytes: LIMITS.AVATAR_SOURCE_MAX_BYTES,
  mediaPutTtlS: LIMITS.MEDIA_PUT_TTL_S,
  mediaGetTtlS: LIMITS.MEDIA_GET_TTL_S,
});

export const DEFAULT_CORS_ORIGINS = ['capacitor://localhost', 'https://localhost', 'http://localhost'];

export class ConfigError extends Error {}

function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function defaultStaticDir(): string {
  // Bundle lives at apps/relay/dist/index.js (or src/config.ts in dev) → ../../client/dist.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../client/dist');
}

/** Build a config from environment variables. Throws `ConfigError` on missing/weak secrets. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const engineToken = env.ENGINE_TOKEN ?? '';
  const deviceHmacKey = env.DEVICE_HMAC_KEY ?? '';
  if (engineToken.length < 16) throw new ConfigError('ENGINE_TOKEN is required (>= 16 chars)');
  if (deviceHmacKey.length < 32) throw new ConfigError('DEVICE_HMAC_KEY is required (>= 32 chars)');
  const cloudRun = Boolean(env.K_SERVICE);
  const localMediaDir = env.LOCAL_MEDIA_DIR ? path.resolve(env.LOCAL_MEDIA_DIR) : undefined;
  const publicOrigin = env.PUBLIC_ORIGIN ? env.PUBLIC_ORIGIN.replace(/\/+$/, '') : undefined;
  const extraCors = list(env.CORS_ORIGINS);
  const firebaseProjectId = env.FIREBASE_PROJECT_ID || undefined;
  const firebaseWeb: FirebaseWebConfig | null =
    env.FIREBASE_WEB_API_KEY && firebaseProjectId
      ? {
          apiKey: env.FIREBASE_WEB_API_KEY,
          authDomain: env.FIREBASE_AUTH_DOMAIN || `${firebaseProjectId}.firebaseapp.com`,
          projectId: firebaseProjectId,
        }
      : null;
  return {
    engineToken,
    deviceHmacKey,
    allowedEmails: list(env.ALLOWED_EMAILS).map((e) => e.toLowerCase()),
    firebaseProjectId,
    firebaseWeb,
    mediaBucket: env.MEDIA_BUCKET || undefined,
    localMediaDir,
    staticDir: env.STATIC_DIR ? path.resolve(env.STATIC_DIR) : defaultStaticDir(),
    publicOrigin,
    corsOrigins: [...new Set([...DEFAULT_CORS_ORIGINS, ...extraCors])],
    trustProxy: cloudRun || env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    cloudRun,
    localMode: Boolean(localMediaDir),
    limits: { ...DEFAULT_LIMITS },
  };
}

/** Bind host: 0.0.0.0 only on Cloud Run (K_SERVICE) or when RELAY_HOST is set (RELAY_HOST wins). */
export function resolveBind(env: NodeJS.ProcessEnv = process.env): { host: string; port: number } {
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError('PORT must be 0..65535');
  const host = env.RELAY_HOST ? env.RELAY_HOST : env.K_SERVICE ? '0.0.0.0' : '127.0.0.1';
  return { host, port };
}

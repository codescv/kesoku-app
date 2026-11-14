import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { makeEnvelope } from '@kesoku/protocol';
import { DEFAULT_LIMITS, DEFAULT_CORS_ORIGINS, type RelayConfig, type RelayLimits } from '../src/config';
import { createRelay, type Relay, type RelayDeps } from '../src/app';
import { silentLogger } from '../src/log';

export const ENGINE_TOKEN = 'test-engine-token-0123456789abcdef0123456789';
export const HMAC_KEY = 'test-device-hmac-key-0123456789abcdef0123456789';

export function makeStaticDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kesoku-static-'));
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Kesoku</title>');
  writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
  writeFileSync(path.join(dir, 'sw.js'), 'self.addEventListener("fetch",()=>{})');
  writeFileSync(path.join(dir, 'manifest.webmanifest'), '{}');
  return dir;
}

export function makeConfig(over: Partial<RelayConfig> = {}, limits: Partial<RelayLimits> = {}): RelayConfig {
  return {
    engineToken: ENGINE_TOKEN,
    deviceHmacKey: HMAC_KEY,
    allowedEmails: ['owner@example.com'],
    firebaseWeb: null,
    staticDir: makeStaticDir(),
    corsOrigins: [...DEFAULT_CORS_ORIGINS],
    trustProxy: false,
    cloudRun: false,
    localMode: false,
    ...over,
    limits: { ...DEFAULT_LIMITS, heartbeatMs: 0, ...limits },
  };
}

export interface Harness {
  relay: Relay;
  base: string;
  wsBase: string;
  stop(): Promise<void>;
}

export async function startRelay(config: RelayConfig = makeConfig(), deps: RelayDeps = {}): Promise<Harness> {
  const relay = createRelay(config, { logger: silentLogger, ...deps });
  const addr = await relay.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  return {
    relay,
    base,
    wsBase: `ws://127.0.0.1:${addr.port}`,
    stop: () => relay.close(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Frame = any;

/** WebSocket wrapper with a buffered, predicate-based `next()`. */
export class Peer {
  readonly msgs: Frame[] = [];
  private waiters: { pred: (m: Frame) => boolean; resolve: (m: Frame) => void }[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly opened: Promise<void>;

  constructor(readonly ws: WebSocket) {
    this.opened = new Promise((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
    this.opened.catch(() => undefined);
    this.closed = new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    ws.on('message', (data, isBinary) => {
      const m = isBinary ? { binary: data } : JSON.parse(data.toString());
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) {
        const [w] = this.waiters.splice(i, 1);
        w.resolve(m);
      } else {
        this.msgs.push(m);
      }
    });
  }

  send(obj: unknown): void {
    this.ws.send(typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj));
  }

  next(pred: string | ((m: Frame) => boolean) = () => true, timeoutMs = 3000): Promise<Frame> {
    const p = typeof pred === 'string' ? (m: Frame) => m.type === pred : pred;
    const i = this.msgs.findIndex(p);
    if (i >= 0) return Promise.resolve(this.msgs.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred: p, resolve: (m: Frame) => (clearTimeout(t), resolve(m)) };
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`timeout waiting for ${typeof pred === 'string' ? pred : 'frame'}; buffered: ${JSON.stringify(this.msgs.map((m) => m.type))}`));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  /** Resolves true if no matching frame arrives within `ms`. */
  async none(pred: string | ((m: Frame) => boolean), ms = 200): Promise<boolean> {
    try {
      await this.next(pred, ms);
      return false;
    } catch {
      return true;
    }
  }

  close(): void {
    this.ws.close();
  }
}

export async function openEngine(
  h: Harness,
  hello: { boot_id: number | string; conn_seq: number; last_inbound_id?: string; revoked_device_ids?: string[] } = { boot_id: 1_700_000_000_000, conn_seq: 1 },
  token = ENGINE_TOKEN,
): Promise<{ peer: Peer; welcome: Frame }> {
  const peer = new Peer(new WebSocket(`${h.wsBase}/engine`, { headers: { Authorization: `Bearer ${token}` } }));
  await peer.opened;
  peer.send(makeEnvelope('engine.hello', { revoked_device_ids: [], ...hello }));
  const welcome = await peer.next('engine.welcome');
  return { peer, welcome };
}

export async function openClient(
  h: Harness,
  opts: { token?: string; cookie?: string; device?: string; headers?: Record<string, string> } = {},
): Promise<{ peer: Peer; ok: Frame }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.cookie) headers.Cookie = opts.cookie;
  const q = opts.device ? `?device=${encodeURIComponent(opts.device)}` : '';
  const peer = new Peer(new WebSocket(`${h.wsBase}/ws${q}`, { headers }));
  await peer.opened;
  const payload: Record<string, unknown> = { client: { platform: 'web', version: '0.1.0', locale: 'zh-CN' } };
  if (opts.token) payload.device_token = opts.token;
  peer.send(makeEnvelope('auth.hello', payload));
  const ok = await peer.next((m) => m.type === 'auth.ok');
  return { peer, ok };
}

export function codeHash(code: string, salt: string): string {
  return createHash('sha256').update(code + salt, 'utf8').digest('hex');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function json(r: Response): Promise<Frame> {
  return (await r.json()) as Frame;
}

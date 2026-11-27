import { LIMITS, WS_CLOSE, makeEnvelope, newId, parseEnvelope, type Envelope } from '@kesoku/protocol';

export type SocketStatus = 'idle' | 'connecting' | 'authenticating' | 'online' | 'reconnecting' | 'unauthorized' | 'suspended';

export interface SocketOptions {
  url: string;
  /** Device token from secure storage; `null` → rely on the HttpOnly cookie (Web). */
  getToken: () => Promise<string | null>;
  client: { platform: 'web' | 'android' | 'ios'; version: string; locale: string };
  onEnvelope: (env: Envelope) => void;
  onStatus: (status: SocketStatus, info?: { retryInMs?: number; deviceId?: string; engineOnline?: boolean; latencyMs?: number }) => void;
  /** Test seam. */
  WebSocketImpl?: typeof WebSocket;
  rpcTimeoutMs?: number;
}

interface Pending {
  resolve: (env: Envelope) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RpcError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message || code);
    this.name = 'RpcError';
  }
}

/**
 * Client leg: auth.hello first frame, 25 s ping, exponential backoff (1 s → 30 s), seamless
 * `relay.rotate`, request/response pairing via `reply_to`. Never logs tokens.
 */
export class KesokuSocket {
  private ws: WebSocket | null = null;
  private status: SocketStatus = 'idle';
  private attempt = 0;
  private pending = new Map<string, Pending>();
  private queue: string[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private missedPongs = 0;
  private lastPingAt = 0;
  private stopped = false;
  deviceId: string | null = null;
  engineOnline = false;

  constructor(private opts: SocketOptions) {}

  get state(): SocketStatus {
    return this.status;
  }

  private setStatus(s: SocketStatus, info?: Parameters<SocketOptions['onStatus']>[1]) {
    this.status = s;
    this.opts.onStatus(s, info);
  }

  start(): void {
    this.stopped = false;
    if (this.ws) return;
    void this.open();
  }

  /** Background suspension (Android: 30 s after hide). */
  suspend(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close(WS_CLOSE.NORMAL, 'suspend');
    this.ws = null;
    this.setStatus('suspended');
  }

  resume(): void {
    if (this.status === 'online' || this.status === 'connecting' || this.status === 'authenticating') return;
    this.attempt = 0;
    this.stopped = false;
    void this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close(WS_CLOSE.NORMAL, 'bye');
    this.ws = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new RpcError('CLOSED', 'socket closed'));
    }
    this.pending.clear();
    this.setStatus('idle');
  }

  private clearTimers() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
  }

  private async open(): Promise<void> {
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    this.setStatus(this.attempt ? 'reconnecting' : 'connecting');
    const token = await this.opts.getToken();
    const ws = new Impl(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.setStatus('authenticating');
      const payload: Record<string, unknown> = { client: this.opts.client };
      if (token) payload.device_token = token;
      ws.send(JSON.stringify(makeEnvelope('auth.hello', payload, { id: newId('req') })));
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws && !(ws as unknown as { __rotating?: boolean }).__rotating) return;
      if (typeof ev.data !== 'string') return;
      const res = parseEnvelope(ev.data);
      if (!res.ok) return;
      this.handle(res.envelope, ws);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      if (ev.code === WS_CLOSE.UNAUTHORIZED || ev.code === WS_CLOSE.REVOKED || ev.code === WS_CLOSE.FORBIDDEN) {
        this.setStatus('unauthorized');
        return;
      }
      if (!this.stopped) this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect(delayOverride?: number) {
    this.attempt += 1;
    const base = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt - 1, 5));
    const delay = delayOverride ?? Math.round(base * (0.8 + Math.random() * 0.4));
    this.setStatus('reconnecting', { retryInMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) void this.open();
    }, delay);
  }

  private handle(env: Envelope, ws: WebSocket) {
    switch (env.type) {
      case 'auth.ok': {
        const p = env.payload as { device_id: string; engine_online: boolean };
        this.deviceId = p.device_id;
        this.engineOnline = !!p.engine_online;
        this.attempt = 0;
        this.missedPongs = 0;
        this.startPing();
        // Immediate probe so the latency badge fills in right away.
        this.missedPongs = 1;
        this.lastPingAt = Date.now();
        ws.send(JSON.stringify(makeEnvelope('ping', {})));
        this.setStatus('online', { deviceId: p.device_id, engineOnline: this.engineOnline });
        const q = this.queue.splice(0);
        for (const frame of q) ws.send(frame);
        break;
      }
      case 'pong': {
        this.missedPongs = 0;
        const latency = Date.now() - this.lastPingAt;
        this.opts.onStatus('online', { latencyMs: latency, engineOnline: this.engineOnline });
        return;
      }
      case 'engine.status': {
        this.engineOnline = !!(env.payload as { online?: boolean }).online;
        break;
      }
      case 'relay.rotate': {
        // Open a fresh leg; the old one is closed by the relay after grace.
        const old = this.ws;
        if (old) (old as unknown as { __rotating?: boolean }).__rotating = true;
        this.ws = null;
        this.clearTimers();
        void this.open();
        break;
      }
      case 'relay.restarting': {
        const retry = Number((env.payload as { retry_ms?: number }).retry_ms ?? 3000);
        this.ws = null;
        this.clearTimers();
        try {
          ws.close(WS_CLOSE.NORMAL, 'restart');
        } catch {
          /* ignore */
        }
        this.scheduleReconnect(retry);
        break;
      }
    }
    if (env.reply_to) {
      const p = this.pending.get(env.reply_to);
      if (p) {
        this.pending.delete(env.reply_to);
        clearTimeout(p.timer);
        if (env.type === 'error') {
          const e = env.payload as { code?: string; message?: string };
          p.reject(new RpcError(String(e.code ?? 'ERROR'), String(e.message ?? '')));
        } else p.resolve(env);
      }
    }
    this.opts.onEnvelope(env);
  }

  private startPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.status !== 'online') return;
      if (this.missedPongs >= 2) {
        this.ws.close(WS_CLOSE.GOING_AWAY, 'ping timeout');
        return;
      }
      this.missedPongs += 1;
      this.lastPingAt = Date.now();
      this.ws.send(JSON.stringify(makeEnvelope('ping', {})));
    }, LIMITS.PING_INTERVAL_MS);
  }

  /** Fire-and-forget (queued while reconnecting unless `noQueue: true`). Returns the envelope id. */
  send(type: string, payload: Record<string, unknown>, opts: { session_id?: string; id?: string; noQueue?: boolean } = {}): string {
    const env = makeEnvelope(type, payload, { id: opts.id ?? newId('req'), session_id: opts.session_id });
    const frame = JSON.stringify(env);
    if (this.ws && this.status === 'online' && this.ws.readyState === 1) this.ws.send(frame);
    else if (opts.noQueue) throw new RpcError('OFFLINE', 'socket offline');
    else this.queue.push(frame);
    return env.id;
  }

  /** Request/response via `reply_to`. Rejects with RpcError on `error` (or `OFFLINE` immediately when `noQueue: true`). */
  rpc(type: string, payload: Record<string, unknown>, opts: { session_id?: string; timeoutMs?: number; noQueue?: boolean } = {}): Promise<Envelope> {
    if (opts.noQueue && (!this.ws || this.status !== 'online' || this.ws.readyState !== 1)) {
      return Promise.reject(new RpcError('OFFLINE', 'socket offline'));
    }
    const id = newId('req');
    return new Promise<Envelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError('TIMEOUT', `${type} timed out`));
      }, opts.timeoutMs ?? this.opts.rpcTimeoutMs ?? 20_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send(type, payload, { session_id: opts.session_id, id, noQueue: opts.noQueue });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new RpcError('OFFLINE', String(err)));
      }
    });
  }
}

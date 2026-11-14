import { isIP } from 'node:net';

/**
 * Client IP for rate limiting. Behind Cloud Run's front end the socket address is internal and the
 * LEFTMOST X-Forwarded-For entries are client-controlled, so we take the RIGHTMOST entry (appended by
 * the load balancer). Without a trusted proxy we use the socket address.
 */
export function clientIp(xff: string | string[] | undefined | null, socketAddr: string | undefined, trustProxy: boolean): string {
  if (trustProxy && xff) {
    const raw = Array.isArray(xff) ? xff.join(',') : xff;
    const parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return normalizeIp(last);
  }
  return normalizeIp(socketAddr ?? 'unknown');
}

function normalizeIp(ip: string): string {
  let v = ip.trim();
  if (v.startsWith('[')) v = v.slice(1, v.indexOf(']') > 0 ? v.indexOf(']') : undefined);
  if (v.startsWith('::ffff:') && isIP(v.slice(7)) === 4) v = v.slice(7);
  return v.slice(0, 64) || 'unknown';
}

/** Fixed-capacity sliding-window counter per key. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records an attempt; returns false (and does not record) when the key is over its limit. */
  hit(key: string): boolean {
    const t = this.now();
    this.sweep(t);
    const arr = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(t);
    this.hits.set(key, arr);
    return true;
  }

  private sweep(t: number): void {
    if (t - this.lastSweep < this.windowMs) return;
    this.lastSweep = t;
    for (const [k, arr] of this.hits) {
      const live = arr.filter((x) => t - x < this.windowMs);
      if (live.length) this.hits.set(k, live);
      else this.hits.delete(k);
    }
  }

  reset(): void {
    this.hits.clear();
  }
}

/** Concurrent-slot counter per key (e.g. unauthenticated WS handshakes). */
export class ConcurrencyLimiter {
  private readonly counts = new Map<string, number>();

  constructor(private readonly limit: number) {}

  acquire(key: string): boolean {
    const n = this.counts.get(key) ?? 0;
    if (n >= this.limit) return false;
    this.counts.set(key, n + 1);
    return true;
  }

  release(key: string): void {
    const n = (this.counts.get(key) ?? 0) - 1;
    if (n <= 0) this.counts.delete(key);
    else this.counts.set(key, n);
  }

  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }
}

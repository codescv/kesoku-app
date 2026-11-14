import { z } from 'zod';
import { PROTOCOL_VERSION } from './constants';

/**
 * V1.2 envelope (Blueprint §3.1).
 *
 * Routing extension (relay ⇄ engine leg only):
 * - `device_id` — on client→engine frames the relay ALWAYS overwrites it with the authenticated
 *   device id (clients never choose it). On engine→client frames, when present, the relay unicasts
 *   the frame to that device only (RPC replies, replays); when absent it broadcasts to every
 *   authenticated client leg (single-user system).
 */
export const EnvelopeSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.string().min(1).max(64),
    id: z.string().min(1).max(64),
    ts: z.number(),
    session_id: z.string().min(1).max(64).optional(),
    seq: z.number().int().nonnegative().optional(),
    reply_to: z.string().min(1).max(64).optional(),
    device_id: z.string().min(1).max(64).optional(),
    payload: z.record(z.unknown()).default({}),
  })
  .passthrough();

export type Envelope<P = Record<string, unknown>, T extends string = string> = {
  v: typeof PROTOCOL_VERSION;
  type: T;
  id: string;
  ts: number;
  session_id?: string;
  seq?: number;
  reply_to?: string;
  device_id?: string;
  payload: P;
};

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** Monotonic-ish ULID (time-sortable, 26 chars, Crockford base32). */
export function ulid(now: number = Date.now()): string {
  let time = '';
  let t = Math.floor(now);
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rnd = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[rnd[i] % 32];
  return time + rand;
}

/** `evt_01J…` / `req_01J…` style ids. */
export function newId(prefix = 'evt'): string {
  return `${prefix}_${ulid()}`;
}

export function nowTs(): number {
  return Date.now() / 1000;
}

export interface MakeEnvelopeOpts {
  id?: string;
  session_id?: string;
  seq?: number;
  reply_to?: string;
  device_id?: string;
  ts?: number;
}

export function makeEnvelope<P extends Record<string, unknown>, T extends string>(
  type: T,
  payload: P,
  opts: MakeEnvelopeOpts = {},
): Envelope<P, T> {
  const env: Envelope<P, T> = {
    v: PROTOCOL_VERSION,
    type,
    id: opts.id ?? newId(type.startsWith('req') ? 'req' : 'evt'),
    ts: opts.ts ?? nowTs(),
    payload,
  };
  if (opts.session_id !== undefined) env.session_id = opts.session_id;
  if (opts.seq !== undefined) env.seq = opts.seq;
  if (opts.reply_to !== undefined) env.reply_to = opts.reply_to;
  if (opts.device_id !== undefined) env.device_id = opts.device_id;
  return env;
}

export type ParseResult =
  | { ok: true; envelope: Envelope }
  | { ok: false; error: string };

/** Parse a raw text frame into a validated envelope (header only; payload validated separately). */
export function parseEnvelope(raw: string | unknown, maxBytes = 1_048_576): ParseResult {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length > maxBytes) return { ok: false, error: 'frame too large' };
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'invalid json' };
    }
  }
  const res = EnvelopeSchema.safeParse(data);
  if (!res.success) return { ok: false, error: res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  return { ok: true, envelope: res.data as Envelope };
}

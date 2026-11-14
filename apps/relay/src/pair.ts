import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface PairOffer {
  code_hash: string;
  salt: string;
  /** Unix seconds. */
  expires_at: number;
  name: string;
  attempts: number;
}

export type RedeemResult =
  | { ok: true; offer: PairOffer }
  | { ok: false; reason: 'no_offer' | 'expired' | 'wrong' }
  | { ok: false; reason: 'burned'; code_hash: string; attempts: number };

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

/** Normalise seconds-or-milliseconds epoch to seconds. */
function toSeconds(t: number): number {
  return t > 1e12 ? t / 1000 : t;
}

/**
 * Single active pairing offer (pushed by the engine as `pair.offer`). Burned after N failed attempts
 * across all IPs; any redemption (success or burn) destroys it.
 */
export class Pairing {
  private offer: PairOffer | null = null;
  private readonly dummySalt = randomBytes(16).toString('hex');
  private readonly dummyHash = sha256(randomBytes(16).toString('hex'));

  constructor(
    private readonly maxAttempts: number,
    private readonly now: () => number = () => Date.now() / 1000,
  ) {}

  setOffer(p: { code_hash: string; salt: string; expires_at: number; name?: string }): void {
    this.offer = { code_hash: p.code_hash.toLowerCase(), salt: p.salt, expires_at: toSeconds(p.expires_at), name: p.name ?? '', attempts: 0 };
  }

  get active(): PairOffer | null {
    return this.offer ? { ...this.offer } : null;
  }

  clear(): void {
    this.offer = null;
  }

  redeem(code: string): RedeemResult {
    const offer = this.offer;
    if (!offer) {
      // Same amount of hashing work as a real attempt.
      timingSafeEqual(sha256(code + this.dummySalt), this.dummyHash);
      return { ok: false, reason: 'no_offer' };
    }
    const computed = sha256(code + offer.salt);
    const expected = Buffer.from(offer.code_hash, 'hex');
    const match = expected.length === computed.length && timingSafeEqual(computed, expected);
    if (this.now() >= offer.expires_at) {
      this.offer = null;
      return { ok: false, reason: 'expired' };
    }
    if (match) {
      this.offer = null;
      return { ok: true, offer };
    }
    offer.attempts += 1;
    if (offer.attempts >= this.maxAttempts) {
      this.offer = null;
      return { ok: false, reason: 'burned', code_hash: offer.code_hash, attempts: offer.attempts };
    }
    return { ok: false, reason: 'wrong' };
  }
}

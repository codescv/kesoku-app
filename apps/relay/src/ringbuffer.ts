/**
 * Per-session ring of the most recent seq'd engine→client frames (broadcast ones only), used to answer
 * `sync.resume` without a round trip to the engine. Kept contiguous: a seq gap resets the ring.
 */
export interface RingEntry {
  seq: number;
  /** Serialized envelope, replayed verbatim. */
  frame: string;
}

export class SessionRing {
  private buf: (RingEntry | undefined)[];
  private start = 0;
  private size = 0;

  constructor(readonly capacity: number) {
    this.buf = new Array(capacity);
  }

  get length(): number {
    return this.size;
  }

  get firstSeq(): number | undefined {
    return this.size ? this.buf[this.start]!.seq : undefined;
  }

  get headSeq(): number | undefined {
    return this.size ? this.buf[(this.start + this.size - 1) % this.capacity]!.seq : undefined;
  }

  push(seq: number, frame: string): void {
    const head = this.headSeq;
    if (head !== undefined) {
      if (seq <= head) return; // duplicate / out of order → ignore
      if (seq !== head + 1) this.clear(); // gap → restart contiguous window
    }
    if (this.size < this.capacity) {
      this.buf[(this.start + this.size) % this.capacity] = { seq, frame };
      this.size++;
    } else {
      this.buf[this.start] = { seq, frame };
      this.start = (this.start + 1) % this.capacity;
    }
  }

  clear(): void {
    this.buf = new Array(this.capacity);
    this.start = 0;
    this.size = 0;
  }

  /**
   * Entries with seq > afterSeq, or `null` when the ring does not cover `afterSeq + 1`
   * (empty ring, or the oldest entry is newer than afterSeq + 1).
   */
  after(afterSeq: number): RingEntry[] | null {
    const first = this.firstSeq;
    const head = this.headSeq;
    if (first === undefined || head === undefined) return null;
    if (first > afterSeq + 1) return null;
    if (afterSeq >= head) return [];
    const out: RingEntry[] = [];
    const startIdx = Math.max(0, afterSeq + 1 - first);
    for (let i = startIdx; i < this.size; i++) out.push(this.buf[(this.start + i) % this.capacity]!);
    return out;
  }
}

export class RingStore {
  private readonly rings = new Map<string, SessionRing>();

  constructor(
    private readonly capacity: number,
    private readonly maxSessions = 512,
  ) {}

  push(sessionId: string, seq: number, frame: string): void {
    let ring = this.rings.get(sessionId);
    if (!ring) {
      if (this.rings.size >= this.maxSessions) {
        const oldest = this.rings.keys().next().value;
        if (oldest !== undefined) this.rings.delete(oldest);
      }
      ring = new SessionRing(this.capacity);
    } else {
      this.rings.delete(sessionId); // LRU: re-insert at the end
    }
    this.rings.set(sessionId, ring);
    ring.push(seq, frame);
  }

  get(sessionId: string): SessionRing | undefined {
    return this.rings.get(sessionId);
  }

  get sessionCount(): number {
    return this.rings.size;
  }
}

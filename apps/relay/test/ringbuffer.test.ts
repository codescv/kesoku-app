import { describe, expect, it } from 'vitest';
import { RingStore, SessionRing } from '../src/ringbuffer';

const f = (seq: number) => `{"seq":${seq}}`;

describe('SessionRing', () => {
  it('keeps the last 2000 entries and evicts the oldest', () => {
    const r = new SessionRing(2000);
    for (let s = 1; s <= 2500; s++) r.push(s, f(s));
    expect(r.length).toBe(2000);
    expect(r.firstSeq).toBe(501);
    expect(r.headSeq).toBe(2500);
  });

  it('range queries: covered, exact head, uncovered, empty', () => {
    const r = new SessionRing(2000);
    expect(r.after(0)).toBeNull();
    for (let s = 1; s <= 2500; s++) r.push(s, f(s));
    const a = r.after(2400)!;
    expect(a.map((e) => e.seq)).toEqual(Array.from({ length: 100 }, (_, i) => 2401 + i));
    expect(a[0].frame).toBe(f(2401));
    expect(r.after(500)!.length).toBe(2000); // 501 is the oldest → covered
    expect(r.after(499)).toBeNull(); // needs 500 → evicted
    expect(r.after(2500)).toEqual([]);
    expect(r.after(9999)).toEqual([]);
  });

  it('ignores duplicates and resets on a gap', () => {
    const r = new SessionRing(10);
    r.push(5, f(5));
    r.push(6, f(6));
    r.push(6, f(6));
    r.push(4, f(4));
    expect(r.length).toBe(2);
    r.push(9, f(9));
    expect(r.firstSeq).toBe(9);
    expect(r.length).toBe(1);
    expect(r.after(7)).toBeNull();
    expect(r.after(8)!.map((e) => e.seq)).toEqual([9]);
  });

  it('wraps correctly with small capacity', () => {
    const r = new SessionRing(3);
    for (let s = 1; s <= 7; s++) r.push(s, f(s));
    expect(r.after(4)!.map((e) => e.seq)).toEqual([5, 6, 7]);
    expect(r.after(5)!.map((e) => e.seq)).toEqual([6, 7]);
    expect(r.after(3)).toBeNull();
  });
});

describe('RingStore', () => {
  it('is per session and bounded by session count (LRU)', () => {
    const s = new RingStore(5, 2);
    s.push('a', 1, f(1));
    s.push('b', 1, f(1));
    s.push('a', 2, f(2));
    s.push('c', 1, f(1)); // evicts b (least recently used)
    expect(s.get('b')).toBeUndefined();
    expect(s.get('a')!.headSeq).toBe(2);
    expect(s.sessionCount).toBe(2);
  });
});

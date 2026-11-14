import { describe, expect, it, vi } from 'vitest';
import { parseStreaming, readYamlScalars } from '../src/features/stream/streamParser';
import { applyClear, applyDelta, cpLen, createFrameBatcher, fromActiveTurn } from '../src/features/stream/previewBuffer';

describe('streamParser (fence-aware progressive rendering)', () => {
  it('passes plain text through', () => {
    expect(parseStreaming('你好，今天')).toEqual([{ kind: 'text', text: '你好，今天' }]);
  });

  it('never exposes raw YAML of an unclosed ```bilingual fence', () => {
    const blocks = parseStreaming('先说一句：\n```bilingual\nja: "今日(きょう)は暑(あつ)いね"\nzh: 今天');
    expect(blocks[0]).toEqual({ kind: 'text', text: '先说一句：' });
    expect(blocks[1]).toMatchObject({ kind: 'bilingual', closed: false, ja: '今日(きょう)は暑(あつ)いね', zh: '今天' });
    expect(JSON.stringify(blocks)).not.toContain('ja:');
  });

  it('shows a skeleton for open ```card and hides ```ui entirely', () => {
    const card = parseStreaming('```card\nkind: pokemon_dex\ntitle: 超级快龙\nstats:');
    expect(card).toEqual([{ kind: 'card', closed: false, cardKind: 'pokemon_dex', title: '超级快龙' }]);
    const ui = parseStreaming('选一个：\n```ui\ntype: select\noptions:\n  - A\n```\n之后');
    expect(ui.map((b) => b.kind)).toEqual(['text', 'ui', 'text']);
    expect(JSON.stringify(ui)).not.toContain('options');
  });

  it('hides half-typed fence openers and media markers at the tail', () => {
    expect(parseStreaming('好的\n``')).toEqual([{ kind: 'text', text: '好的' }]);
    expect(parseStreaming('好的\n```bilin')).toEqual([{ kind: 'text', text: '好的' }]);
    expect(parseStreaming('看图 [fil')).toEqual([{ kind: 'text', text: '看图 ' }]);
    expect(parseStreaming('看图 [file:abc')).toEqual([{ kind: 'text', text: '看图 ' }]);
  });

  it('turns complete [file:] / [voice:] markers into media blocks', () => {
    expect(parseStreaming('图来了 [file:cg/1.webp] 好看吗')).toEqual([
      { kind: 'text', text: '图来了 ' },
      { kind: 'media', media: 'file', ref: 'cg/1.webp' },
      { kind: 'text', text: ' 好看吗' },
    ]);
  });

  it('keeps regular code fences as code', () => {
    expect(parseStreaming('```ts\nconst a = 1;\n```')).toEqual([{ kind: 'code', closed: true, lang: 'ts', text: 'const a = 1;' }]);
  });

  it('reads YAML scalars incl. block scalars and quotes', () => {
    expect(readYamlScalars('ja: |\n  一行目\n  二行目\nzh: \'它\'\'s\'\nspeaker: "飞鸟"')).toEqual({ ja: '一行目\n二行目', zh: "它's", speaker: '飞鸟' });
  });
});

describe('preview buffer (turn_id, round_id, offset)', () => {
  const none = new Set<string>();

  it('counts code points like Python len()', () => {
    expect(cpLen('a😀b')).toBe(3);
    expect(cpLen('今日')).toBe(2);
  });

  it('appends when offset matches, resets on offset 0', () => {
    let r = applyDelta(undefined, { turn_id: 't1', round_id: 0, offset: 0, delta: '今日' }, none, 1);
    expect(r.preview?.text).toBe('今日');
    r = applyDelta(r.preview, { turn_id: 't1', round_id: 0, offset: 2, delta: 'は😀' }, none);
    expect(r.preview?.text).toBe('今日は😀');
    r = applyDelta(r.preview, { turn_id: 't1', round_id: 0, offset: 4, delta: '!' }, none);
    expect(r.preview?.text).toBe('今日は😀!');
    r = applyDelta(r.preview, { turn_id: 't1', round_id: 0, offset: 0, delta: 'X' }, none);
    expect(r.preview?.text).toBe('X');
  });

  it('requests a resync on offset mismatch without splicing', () => {
    const a = applyDelta(undefined, { turn_id: 't1', round_id: 0, offset: 0, delta: 'abc' }, none);
    const b = applyDelta(a.preview, { turn_id: 't1', round_id: 0, offset: 10, delta: 'zzz' }, none);
    expect(b.needResync).toBe(true);
    expect(b.preview?.text).toBe('abc');
  });

  it('a new round resets the buffer; stale rounds are dropped', () => {
    const a = applyDelta(undefined, { turn_id: 't1', round_id: 0, offset: 0, delta: 'round0' }, none);
    const b = applyDelta(a.preview, { turn_id: 't1', round_id: 1, offset: 0, delta: 'round1' }, none);
    expect(b.preview?.text).toBe('round1');
    const c = applyDelta(b.preview, { turn_id: 't1', round_id: 0, offset: 6, delta: 'late' }, none);
    expect(c.dropped).toBe(true);
    expect(c.preview?.text).toBe('round1');
  });

  it('drops late deltas/clears after message.final', () => {
    const fin = new Set(['t1']);
    expect(applyDelta(undefined, { turn_id: 't1', round_id: 0, offset: 0, delta: 'x' }, fin).dropped).toBe(true);
    expect(applyClear(undefined, { turn_id: 't1', round_id: 0 }, fin)).toBeUndefined();
  });

  it('stream.clear empties the buffer for the next tool round', () => {
    const a = applyDelta(undefined, { turn_id: 't1', round_id: 0, offset: 0, delta: 'thinking…' }, none);
    const c = applyClear(a.preview, { turn_id: 't1', round_id: 0 }, none);
    expect(c?.text).toBe('');
    const d = applyDelta(c, { turn_id: 't1', round_id: 1, offset: 0, delta: 'next' }, none);
    expect(d.preview?.text).toBe('next');
  });

  it('thought phase uses a separate buffer', () => {
    const a = applyDelta(undefined, { turn_id: 't', round_id: 0, offset: 0, delta: 'hmm', phase: 'thought' }, none);
    const b = applyDelta(a.preview, { turn_id: 't', round_id: 0, offset: 0, delta: 'answer' }, none);
    expect(b.preview).toMatchObject({ thought: 'hmm', text: 'answer' });
  });

  it('rebuilds from active_turn', () => {
    expect(fromActiveTurn({ turn_id: 't', round_id: 2, preview_text: 'abc' }, none)?.text).toBe('abc');
    expect(fromActiveTurn({ turn_id: 't', round_id: 2, preview_text: 'abc' }, new Set(['t']))).toBeUndefined();
  });

  it('frame batcher coalesces pushes into one flush per frame', () => {
    const cbs: Array<() => void> = [];
    const flush = vi.fn();
    const b = createFrameBatcher<number>(flush, (cb) => cbs.push(cb));
    for (let i = 0; i < 100; i++) b.push(i);
    expect(cbs).toHaveLength(1);
    cbs[0]();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0][0]).toHaveLength(100);
  });
});

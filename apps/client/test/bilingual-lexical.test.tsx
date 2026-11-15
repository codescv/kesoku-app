import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { LexToken } from '@kesoku/protocol';
import { BilingualCard, cacheSentenceLex, clearLexCacheForTest, explainLexCached, getCachedSentenceLex } from '../src/features/segments/BilingualCard';

beforeEach(() => clearLexCacheForTest());
afterEach(() => cleanup());

describe('BilingualCard whole-sentence lexical analysis', () => {
  const plain = '天気はいいね';
  const seg = { type: 'bilingual' as const, ja_plain: plain, zh: '天气真好呢' };
  const SENTENCE: LexToken[] = [
    { surface: '天気', reading: 'てんき', gloss_zh: '天气-整句' },
    { surface: 'は', gloss_zh: '提示助词-整句' },
    { surface: 'いい', gloss_zh: '好-整句' },
    { surface: 'ね', gloss_zh: '语气-整句' },
  ];

  it('caches every 意群 and serves other words with zero extra requests and no spinner', async () => {
    const explain = vi.fn(async (text: string, tok: string) => {
      cacheSentenceLex(text, SENTENCE); // what MessageList does with lexical.explain.result.tokens
      return SENTENCE.find((t) => t.surface === tok) ?? { surface: tok };
    });
    const onWord = vi.fn();
    const { container } = render(<BilingualCard seg={seg} resolveVoice={vi.fn()} explain={explain} onWord={onWord} />);
    const words = () => Array.from(container.querySelectorAll('.k-word')) as HTMLElement[];
    await act(async () => fireEvent.click(words()[0]));
    expect(explain).toHaveBeenCalledTimes(1);
    expect(screen.getByText('天气-整句')).toBeTruthy();
    expect(getCachedSentenceLex(plain)).toHaveLength(4);

    // Units are now re-split along the sentence analysis: 天気 / は / いい / ね.
    expect(words().map((w) => w.textContent)).toEqual(['天気', 'は', 'いい', 'ね']);
    const iiBtn = words().find((w) => w.textContent === 'いい')!;
    act(() => {
      fireEvent.click(iiBtn); // synchronous: no awaiting needed
    });
    expect(explain).toHaveBeenCalledTimes(1);
    expect(screen.getByText('好-整句')).toBeTruthy();
    expect(container.querySelector('.k-lex-loading')).toBeNull();
    expect(onWord).toHaveBeenLastCalledWith(SENTENCE[2], plain);
  });

  it('a fresh card for an already-analysed sentence needs no request at all', () => {
    cacheSentenceLex(plain, SENTENCE);
    const explain = vi.fn();
    const { container } = render(<BilingualCard seg={seg} resolveVoice={vi.fn()} explain={explain} />);
    const ne = (Array.from(container.querySelectorAll('.k-word')) as HTMLElement[]).find((w) => w.textContent === 'ね')!;
    act(() => {
      fireEvent.click(ne);
    });
    expect(explain).not.toHaveBeenCalled();
    expect(screen.getByText('语气-整句')).toBeTruthy();
  });

  it('taps on other words while the sentence is loading share the single request', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fetcher = vi.fn(async (text: string, tok: string) => {
      await gate;
      cacheSentenceLex(text, SENTENCE);
      return SENTENCE.find((t) => t.surface === tok) ?? null;
    });
    const a = explainLexCached(plain, '天気', fetcher);
    const b = explainLexCached(plain, 'いい', fetcher);
    release();
    expect((await a)?.gloss_zh).toBe('天气-整句');
    expect((await b)?.gloss_zh).toBe('好-整句');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

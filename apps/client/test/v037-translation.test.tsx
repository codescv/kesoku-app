import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LexToken } from '@kesoku/protocol';
import { GenericCardSafe, getCard } from '../src/features/cards';
import { TranslationShow, jaSides } from '../src/features/cards/kinds/Translation';
import { clearLexCacheForTest } from '../src/features/segments/BilingualCard';
import { makeCtx } from './cards/ctx';

beforeEach(() => clearLexCacheForTest());
afterEach(() => cleanup());

function renderTranslation(data: Record<string, unknown>, explain?: (text: string, token: string) => Promise<LexToken | null>) {
  const ctx = makeCtx({ explain: explain ?? vi.fn(async (_t: string, token: string) => ({ surface: token, gloss_zh: `释义:${token}` })), onWord: vi.fn() });
  const Card = getCard('translation') ?? GenericCardSafe;
  const r = render(<Card data={data} ctx={ctx} />);
  return { ...r, ctx };
}

const ZH_TO_JA = {
  src_lang: 'zh-CN',
  dst_lang: 'ja',
  source: '我对荞麦过敏',
  target: '私はそばアレルギーです',
  target_ruby: '<ruby>私<rt>わたし</rt></ruby>はそばアレルギーです',
};

describe('translation card Japanese furigana + tap-a-word (v0.3.7 Item 7)', () => {
  it('detects which side is Japanese', () => {
    expect(jaSides(ZH_TO_JA, ZH_TO_JA.source, ZH_TO_JA.target)).toEqual({ srcIsJa: false, dstIsJa: true });
    expect(jaSides({}, '当店です', '本店')).toEqual({ srcIsJa: true, dstIsJa: false });
    expect(jaSides({ target_ruby: '{東京|とうきょう}' }, '去东京', '東京')).toEqual({ srcIsJa: false, dstIsJa: true });
  });

  it('renders the Japanese target with <ruby> furigana (no raw tags)', () => {
    const { container } = renderTranslation(ZH_TO_JA);
    const target = container.querySelector('.kc-tr-target')!;
    expect(target.querySelector('ruby')?.textContent).toBe('私わたし');
    expect(target.querySelector('rt')?.textContent).toBe('わたし');
    expect(target.textContent).not.toMatch(/<\/?r(uby|t)>/);
    // Chinese source stays plain text.
    expect(container.querySelector('.kc-tr-source')!.querySelector('.k-word')).toBeNull();
  });

  it('tapping a Japanese word in the target pops up the LexCard via lexical.explain', async () => {
    const { ctx, container } = renderTranslation(ZH_TO_JA);
    const word = Array.from(container.querySelectorAll('.kc-tr-target .k-word')).find((w) => w.textContent === 'アレルギー')!;
    expect(word).toBeTruthy();
    await act(async () => fireEvent.click(word));
    await waitFor(() => expect(screen.getByRole('region', { name: '词汇与语法拆解' })).toBeTruthy());
    expect(ctx.explain).toHaveBeenCalledWith('私はそばアレルギーです', 'アレルギー');
    expect(screen.getByText('释义:アレルギー')).toBeTruthy();
    expect(ctx.onWord).toHaveBeenCalledWith(expect.objectContaining({ surface: 'アレルギー' }), '私はそばアレルギーです');
    // Tap again closes it.
    await act(async () => fireEvent.click(word));
    expect(screen.queryByRole('region', { name: '词汇与语法拆解' })).toBeNull();
  });

  it('bundled tokens answer source-word taps with zero requests and fill missing furigana', async () => {
    const explain = vi.fn(async () => null);
    const data = {
      source: '当店は現金のみです',
      target: '本店只收现金',
      tokens: [
        { surface: '当店', reading: 'とうてん', gloss_zh: '本店' },
        { surface: 'は', reading: 'は' },
        { surface: '現金', reading: 'げんきん', gloss_zh: '现金' },
        { surface: 'のみ', reading: 'のみ', gloss_zh: '仅' },
        { surface: 'です', reading: 'です' },
      ],
    };
    const { container } = renderTranslation(data, explain);
    const src = container.querySelector('.kc-tr-source')!;
    expect(Array.from(src.querySelectorAll('rt')).map((r) => r.textContent)).toEqual(['とうてん', 'げんきん']);
    const word = Array.from(src.querySelectorAll('.k-word')).find((w) => w.textContent?.startsWith('現金'))!;
    await act(async () => fireEvent.click(word));
    expect(screen.getByText('现金')).toBeTruthy();
    expect(explain).not.toHaveBeenCalled();
  });

  it('without ctx.explain the card stays non-interactive (furigana only)', () => {
    const Card = getCard('translation') ?? GenericCardSafe;
    const { container } = render(<Card data={ZH_TO_JA} ctx={makeCtx()} />);
    expect(container.querySelector('.kc-tr-target rt')?.textContent).toBe('わたし');
    expect(container.querySelector('.kc-tr-target .k-word')).toBeNull();
  });

  it('fullscreen show card and regions render furigana cleanly', () => {
    const { container } = render(<TranslationShow data={{ ...ZH_TO_JA }} />);
    expect(container.querySelector('.kc-show-headline rt')?.textContent).toBe('わたし');
    expect(container.textContent).not.toMatch(/<ruby>|\(わたし\)/);
    cleanup();
    const r = renderTranslation({ source: '看板', target: 'x', src_lang: 'ja', regions: [{ source: '出口(でぐち)', target: '出口' }] });
    expect(r.container.querySelector('.kc-tr-regions rt')?.textContent).toBe('でぐち');
  });
});

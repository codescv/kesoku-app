import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Markdown, parseBlocks } from '../src/features/segments/Markdown';

afterEach(() => cleanup());

const SHOT2 = [
  '### ① 原文',
  '> 森(もり)さんは　毎晩(まいばん)　テレビを　見(み)る。',
  '> 甲(こう)：明日(あした)　ボーリングに　行(い)かない？ / 乙(おつ)：ごめん。　明日(あした)は　仕事(しごと)が　あるから…',
  '<spoiler>森先生每天晚上看电视。',
  '甲：明天去打保龄球怎么样？ / 乙：抱歉，明天还有工作……</spoiler>',
].join('\n');

describe('Markdown multi-line <spoiler>', () => {
  it('parses a spoiler opening with text and closing on a later line as a spoiler block', () => {
    const blocks = parseBlocks(SHOT2);
    expect(blocks.map((b) => b.t)).toEqual(['h', 'quote', 'spoiler']);
    const sp = blocks[2] as { t: 'spoiler'; lines: string[]; body: string };
    expect(sp.body).toBe('森先生每天晚上看电视。\n甲：明天去打保龄球怎么样？ / 乙：抱歉，明天还有工作……');
    expect(sp.lines).toHaveLength(2);
  });

  it('renders the screenshot sample with no literal tags and a <br /> inside the Spoiler', () => {
    const { container } = render(<Markdown text={SHOT2} />);
    expect(container.textContent).not.toMatch(/<\/?spoiler>/i);
    const sp = container.querySelector('.k-spoiler')!;
    expect(sp).toBeTruthy();
    expect(sp.querySelectorAll('br').length).toBe(1);
    expect(sp.textContent).toContain('森先生每天晚上看电视。');
    expect(sp.textContent).toContain('乙：抱歉，明天还有工作……');
    expect(container.querySelector('blockquote ruby')).toBeTruthy();
  });

  it('keeps blank lines inside block spoilers and supports the legacy lone-tag form', () => {
    const b = parseBlocks('<spoiler>第一行\n\n第三行\n</spoiler>');
    expect(b).toHaveLength(1);
    expect((b[0] as { body: string }).body).toBe('第一行\n\n第三行');
    const legacy = parseBlocks('<spoiler>\nA\nB\n</spoiler>\nafter');
    expect(legacy.map((x) => x.t)).toEqual(['spoiler', 'p']);
    expect((legacy[0] as { lines: string[] }).lines).toEqual(['A', 'B']);
  });

  it('matches spoilers spanning lines inside a paragraph and a blockquote', () => {
    const { container } = render(<Markdown text={'前文 <spoiler>行一\n行二</spoiler> 后文\n\n> 引用 ||甲\n> 乙|| 结束'} />);
    expect(container.textContent).not.toMatch(/<\/?spoiler>|\|\|/);
    const spoilers = container.querySelectorAll('.k-spoiler');
    expect(spoilers).toHaveLength(2);
    expect(spoilers[0].querySelector('br')).toBeTruthy();
    expect(spoilers[1].closest('blockquote')).toBeTruthy();
    expect(container.querySelector('p')!.textContent).toBe('前文 行一行二 后文');
  });

  it('single-line inline spoilers and plain multi-line paragraphs are unchanged', () => {
    const { container } = render(<Markdown text={'a <spoiler>x</spoiler> b\nline2'} />);
    const p = container.querySelector('p')!;
    expect(p.querySelectorAll('br')).toHaveLength(1);
    expect(p.querySelector('.k-spoiler')!.textContent).toBe('x');
    expect(parseBlocks('```\n<spoiler>\n```').map((x) => x.t)).toEqual(['code']);
  });
});

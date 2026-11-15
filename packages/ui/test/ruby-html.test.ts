import { describe, expect, it } from 'vitest';
import { fromRubySpec, parseRubyNotation, resolveRubyParts, stripRubyNotation } from '../src/ruby';

describe('ruby HTML / brace notation (v0.3.7 Item 7)', () => {
  it('parses <ruby>漢字<rt>かな</rt></ruby> (with optional <rp>) into parts', () => {
    expect(parseRubyNotation('<ruby>現金<rt>げんきん</rt></ruby>のみ<ruby>利用<rp>(</rp><rt>りよう</rt><rp>)</rp></ruby>できます')).toEqual([
      { base: '現金', rt: 'げんきん' },
      { base: 'のみ' },
      { base: '利用', rt: 'りよう' },
      { base: 'できます' },
    ]);
    expect(parseRubyNotation('<RUBY> 東京 <RT> とうきょう </RT></RUBY>へ')).toEqual([{ base: '東京', rt: 'とうきょう' }, { base: 'へ' }]);
  });

  it('parses {漢字|かな} brace notation and mixes with 漢字(かな)', () => {
    expect(parseRubyNotation('{今日|きょう}は良(よ)い')).toEqual([{ base: '今日', rt: 'きょう' }, { base: 'は' }, { base: '良', rt: 'よ' }, { base: 'い' }]);
  });

  it('never leaks stray ruby tags and strips to plain text', () => {
    const parts = parseRubyNotation('<ruby>駅</ruby>まで');
    expect(parts.map((p) => p.base).join('')).toBe('駅まで');
    expect(parts.some((p) => /<|>/.test(p.base))).toBe(false);
    expect(stripRubyNotation('<ruby>現金<rt>げんきん</rt></ruby>で')).toBe('現金で');
  });

  it('resolveRubyParts uses an HTML ruby spec against plain ja text', () => {
    const parts = resolveRubyParts({ ja: '現金のみ', ruby: '<ruby>現金<rt>げんきん</rt></ruby>のみ' });
    expect(parts).toEqual([{ base: '現金', rt: 'げんきん' }, { base: 'のみ' }]);
    expect(fromRubySpec('東京へ', '{東京|とうきょう}へ')).toEqual([{ base: '東京', rt: 'とうきょう' }, { base: 'へ' }]);
  });
});

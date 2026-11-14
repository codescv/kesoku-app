import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, cleanup, act } from '@testing-library/react';
import { afterEach } from 'vitest';
import { alignRuby, fromRubySpec, parseRubyNotation, partsToPlain, resolveRubyParts, stripRubyNotation } from '../src/ruby';
import { RubyText } from '../src/RubyText';
import { VoicePill } from '../src/VoicePill';
import { Segmented } from '../src/primitives';

afterEach(() => cleanup());

describe('ruby notation parser', () => {
  it('parses 漢字(かな) with half- and full-width parens', () => {
    expect(parseRubyNotation('今日(きょう)は良（よ）い天気(てんき)')).toEqual([
      { base: '今日', rt: 'きょう' },
      { base: 'は' },
      { base: '良', rt: 'よ' },
      { base: 'い' },
      { base: '天気', rt: 'てんき' },
    ]);
  });
  it('keeps non-kana parentheses as text', () => {
    expect(parseRubyNotation('東京(Tokyo)へ')).toEqual([{ base: '東京(Tokyo)へ' }]);
    expect(parseRubyNotation('价格(500円)')).toEqual([{ base: '价格(500円)' }]);
  });
  it('supports aozora ｜base《rt》', () => {
    expect(parseRubyNotation('｜飛鳥《あすか》です')).toEqual([{ base: '飛鳥', rt: 'あすか' }, { base: 'です' }]);
  });
  it('strips notation to plain text', () => {
    expect(stripRubyNotation('今日(きょう)は')).toBe('今日は');
    expect(partsToPlain(parseRubyNotation(''))).toBe('');
  });
});

describe('explicit ruby specs', () => {
  it('aligns [{base, rt}] sequentially', () => {
    expect(alignRuby('今日は今日', [{ base: '今日', rt: 'きょう' }, { base: '今日', rt: 'こんにち' }])).toEqual([
      { base: '今日', rt: 'きょう' },
      { base: 'は' },
      { base: '今日', rt: 'こんにち' },
    ]);
  });
  it('accepts tuples and maps', () => {
    expect(fromRubySpec('天気がいい', [['天気', 'てんき']])).toEqual([{ base: '天気', rt: 'てんき' }, { base: 'がいい' }]);
    expect(fromRubySpec('天気と天気', { 天気: 'てんき' })).toEqual([
      { base: '天気', rt: 'てんき' },
      { base: 'と' },
      { base: '天気', rt: 'てんき' },
    ]);
  });
  it('prefers engine ruby_parts, then ruby, then ja notation', () => {
    expect(resolveRubyParts({ ja_plain: '今日', ruby_parts: [{ base: '今日', rt: 'きょう' }] })).toEqual([{ base: '今日', rt: 'きょう' }]);
    expect(resolveRubyParts({ ja_plain: '今日', ruby: [{ base: '今日', rt: 'きょう' }] })).toEqual([{ base: '今日', rt: 'きょう' }]);
    expect(resolveRubyParts({ ja_plain: '今日', ja: '今日(きょう)' })).toEqual([{ base: '今日', rt: 'きょう' }]);
    expect(resolveRubyParts({ ja: '今日(きょう)は' })).toEqual([{ base: '今日', rt: 'きょう' }, { base: 'は' }]);
  });
});

describe('<RubyText>', () => {
  it('renders real <ruby>/<rt> elements and escapes markup', () => {
    const { container } = render(<RubyText parts={[{ base: '<b>今日</b>', rt: 'きょう' }, { base: '<img src=x onerror=1>' }]} />);
    expect(container.querySelector('ruby')).not.toBeNull();
    expect(container.querySelector('rt')?.textContent).toBe('きょう');
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=1>');
    expect(container.firstElementChild?.getAttribute('lang')).toBe('ja');
  });
  it('makes parts tappable when onPartClick is set', () => {
    const onPart = vi.fn();
    render(<RubyText parts={[{ base: '今日', rt: 'きょう' }, { base: 'は' }]} onPartClick={onPart} />);
    fireEvent.click(screen.getAllByRole('button')[1]);
    expect(onPart).toHaveBeenCalledWith({ base: 'は' }, 1);
  });
});

describe('<VoicePill> tap-to-play', () => {
  it('never resolves the URL or creates audio before the tap', async () => {
    const resolveUrl = vi.fn(async () => 'https://example.test/a.m4a');
    const play = vi.fn(async () => {});
    const createAudio = vi.fn(() => ({ play, pause: vi.fn(), preload: '', currentTime: 0 }) as unknown as HTMLAudioElement);
    render(<VoicePill resolveUrl={resolveUrl} durationMs={4000} createAudio={createAudio} />);
    expect(screen.getByRole('button').textContent).toContain('▶');
    expect(screen.getByRole('button').textContent).toContain('0:04');
    expect(resolveUrl).not.toHaveBeenCalled();
    expect(createAudio).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(resolveUrl).toHaveBeenCalledTimes(1);
    expect(createAudio).toHaveBeenCalledWith('https://example.test/a.m4a');
    expect(play).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button').getAttribute('data-state')).toBe('playing');
  });
  it('a second pill stops the first (only one plays)', async () => {
    const pauseA = vi.fn();
    const mk = (pause: () => void) => () => ({ play: vi.fn(async () => {}), pause, preload: '', currentTime: 0 }) as unknown as HTMLAudioElement;
    render(
      <>
        <VoicePill resolveUrl={async () => 'a'} createAudio={mk(pauseA)} label="A" />
        <VoicePill resolveUrl={async () => 'b'} createAudio={mk(vi.fn())} label="B" />
      </>,
    );
    const [a, b] = screen.getAllByRole('button');
    await act(async () => fireEvent.click(a));
    await act(async () => fireEvent.click(b));
    expect(pauseA).toHaveBeenCalled();
    expect(a.getAttribute('data-state')).toBe('idle');
  });
});

describe('<Segmented>', () => {
  it('marks the selected option and calls onChange', () => {
    const onChange = vi.fn();
    render(
      <Segmented
        value="confirm_only"
        onChange={onChange}
        options={[
          { value: 'full', label: '自动' },
          { value: 'confirm_only', label: '确认' },
          { value: 'isolated', label: '忽略' },
        ]}
      />,
    );
    expect(screen.getByRole('radio', { name: '确认' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: '忽略' }));
    expect(onChange).toHaveBeenCalledWith('isolated');
  });
});

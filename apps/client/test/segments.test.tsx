import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { BilingualSegment, Segment } from '@kesoku/protocol';
import { BilingualCard, findToken, toWordUnits, tokenSpans } from '../src/features/segments/BilingualCard';
import { Markdown, parseBlocks } from '../src/features/segments/Markdown';
import { SegmentList, type SegmentEnv } from '../src/features/segments/SegmentRenderer';
import type { CardContext } from '../src/features/cards/types';

function ctx(overrides: Partial<CardContext> = {}): CardContext {
  return {
    sessionId: 's1',
    messageId: 'm1',
    modeId: 'chat',
    sendText: vi.fn(),
    resolveMedia: vi.fn(async () => 'https://media.test/x'),
    openPeek: vi.fn(),
    openFullscreen: vi.fn(),
    insertComposer: vi.fn(),
    setModePrefs: vi.fn(),
    speak: vi.fn(),
    copy: vi.fn(),
    toast: vi.fn(),
    ...overrides,
  };
}

const seg: BilingualSegment = {
  type: 'bilingual',
  ja_plain: '今日は暑いね',
  ja: '今日(きょう)は暑(あつ)いね',
  zh: '今天好热啊',
  voice: { placeholder_id: 'pv1', duration_ms: 4000 },
  tokens: [
    { surface: '今日', reading: 'きょう', pos: '名词', gloss_zh: '今天' },
    { surface: 'は', pos: '助词' },
    { surface: '暑い', reading: 'あつい', pos: '形容词', gloss_zh: '热', textbook: '暑いですね', colloquial: 'あっちぃ' },
    { surface: 'ね', pos: '终助词' },
  ],
};

describe('word units', () => {
  it('splits by token boundaries but never inside an annotated base', () => {
    const units = toWordUnits(
      [{ base: '今日', rt: 'きょう' }, { base: 'は' }, { base: '暑', rt: 'あつ' }, { base: 'いね' }],
      seg.tokens,
    );
    expect(units.map((u) => u.base)).toEqual(['今日', 'は', '暑', 'い', 'ね']);
    expect(findToken(units[3], '今日は暑いね', seg.tokens)?.surface).toBe('暑い');
  });
  it('falls back to script-change heuristics without tokens', () => {
    expect(toWordUnits([{ base: 'これはテスト、です' }]).map((u) => u.base)).toEqual(['これは', 'テスト', '、', 'です']);
  });
  it('token spans honour explicit offsets', () => {
    expect(tokenSpans('abc', [{ surface: 'x', start: 1, end: 2 }])).toEqual([{ start: 1, end: 2, token: { surface: 'x', start: 1, end: 2 } }]);
  });
});

describe('<BilingualCard>', () => {
  it('renders ruby, never fetches voice before the tap, and plays on tap', async () => {
    const resolveVoice = vi.fn(async () => 'https://media.test/v.m4a');
    const play = vi.fn(async () => {});
    const AudioSpy = vi.fn(function (this: Record<string, unknown>) {
      this.play = play;
      this.pause = vi.fn();
    });
    vi.stubGlobal('Audio', AudioSpy);
    const { container } = render(<BilingualCard seg={seg} resolveVoice={resolveVoice} explain={vi.fn()} />);
    expect(container.querySelectorAll('ruby').length).toBe(2);
    expect(container.querySelector('rt')?.textContent).toBe('きょう');
    expect(container.querySelector('audio')).toBeNull();
    expect(resolveVoice).not.toHaveBeenCalled();
    expect(AudioSpy).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '播放语音' })));
    expect(resolveVoice).toHaveBeenCalledTimes(1);
    expect(AudioSpy).toHaveBeenCalledWith('https://media.test/v.m4a');
    expect(play).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('toggles the Chinese translation on tap', () => {
    render(<BilingualCard seg={seg} resolveVoice={vi.fn()} explain={vi.fn()} />);
    const zh = screen.getByText('今天好热啊');
    expect(zh.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(zh);
    expect(zh.getAttribute('aria-expanded')).toBe('true');
  });

  it('tapping a word shows the bundled breakdown without a request', async () => {
    const explain = vi.fn();
    const onWord = vi.fn();
    render(<BilingualCard seg={seg} resolveVoice={vi.fn()} explain={explain} onWord={onWord} />);
    const words = screen.getAllByRole('button').filter((b) => b.classList.contains('k-word'));
    await act(async () => fireEvent.click(words[2]));
    expect(screen.getByText('热')).toBeTruthy();
    expect(screen.getByText('🔥 口语约音')).toBeTruthy();
    expect(screen.getByText('あっちぃ')).toBeTruthy();
    expect(explain).not.toHaveBeenCalled();
    expect(onWord).toHaveBeenCalled();
  });

  it('falls back to lexical.explain when tokens are missing', async () => {
    const explain = vi.fn(async () => ({ surface: '天気', reading: 'てんき', gloss_zh: '天气' }));
    render(<BilingualCard seg={{ type: 'bilingual', ja_plain: '天気', ja: '天気(てんき)', zh: '天气' }} resolveVoice={vi.fn()} explain={explain} />);
    const word = screen.getAllByRole('button').find((b) => b.classList.contains('k-word'))!;
    await act(async () => fireEvent.click(word));
    expect(explain).toHaveBeenCalledWith('天気', '天気');
  });

  it('renders no voice pill when there is no voice', () => {
    render(<BilingualCard seg={{ type: 'bilingual', ja_plain: 'はい', zh: '是' }} resolveVoice={vi.fn()} explain={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '播放语音' })).toBeNull();
  });

  it('never renders ja_html as HTML', () => {
    const { container } = render(
      <BilingualCard seg={{ type: 'bilingual', ja_plain: 'テスト', ja_html: '<img src=x onerror=alert(1)><b>x</b>', zh: '' }} resolveVoice={vi.fn()} explain={vi.fn()} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
  });
});

describe('<Markdown> safe renderer', () => {
  it('escapes HTML and only links safe URLs', () => {
    const { container } = render(<Markdown text={'<script>x</script> **粗** [ok](https://a.test) [bad](javascript:alert(1))'} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>x</script>');
    expect(container.querySelector('strong')?.textContent).toBe('粗');
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('https://a.test');
    expect(links[0].getAttribute('rel')).toContain('noopener');
  });
  it('renders inline ruby notation and lists', () => {
    const { container } = render(<Markdown text={'- 今日(きょう)\n- b'} />);
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('rt')?.textContent).toBe('きょう');
  });
  it('parses blocks', () => {
    expect(parseBlocks('# T\n\npara\n\n```js\nx\n```').map((b) => b.t)).toEqual(['h', 'p', 'code']);
  });
});

describe('<SegmentList>', () => {
  function env(over: Partial<SegmentEnv> = {}): SegmentEnv {
    return { ctx: ctx(), onPick: vi.fn(), explain: vi.fn(async () => null), ...over };
  }
  it('renders question pills and sends ui.pick', () => {
    const onPick = vi.fn();
    const segs: Segment[] = [{ type: 'question', prompt: '去哪？', choices: ['海边', '神社'], multi: false, question_message_id: 'q1' }];
    render(<SegmentList segments={segs} env={env({ onPick })} />);
    fireEvent.click(screen.getByText('神社'));
    expect(onPick).toHaveBeenCalledWith('q1', ['神社']);
  });
  it('disables pills once picked', () => {
    const segs: Segment[] = [{ type: 'question', prompt: '', choices: ['A', 'B'], multi: false }];
    render(<SegmentList segments={segs} env={env({ picked: ['A'] })} />);
    expect((screen.getByText('B') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('A').className).toContain('is-on');
  });
  it('multi-select confirms the chosen set', () => {
    const onPick = vi.fn();
    const segs: Segment[] = [{ type: 'question', prompt: '', choices: ['A', 'B', 'C'], multi: true, max: 2 }];
    render(<SegmentList segments={segs} env={env({ onPick })} />);
    fireEvent.click(screen.getByText('A'));
    fireEvent.click(screen.getByText('C'));
    fireEvent.click(screen.getByText(/确认选择/));
    expect(onPick).toHaveBeenCalledWith('m1', ['A', 'C']);
  });
  it('renders details collapsed and history refs as tap-to-load', () => {
    const resolveMedia = vi.fn(async () => 'https://media.test/img');
    const segs: Segment[] = [
      { type: 'details', title: '⚔️ 回合战报', body_markdown: '掷骰 18' },
      { type: 'file', ref: 'sessions/x/cg.webp' },
    ];
    const { container } = render(<SegmentList segments={segs} env={env({ ctx: ctx({ resolveMedia }) })} />);
    expect(container.querySelector('details')?.hasAttribute('open')).toBe(false);
    expect(resolveMedia).not.toHaveBeenCalled();
    expect(screen.getByText('🖼 点开查看图片')).toBeTruthy();
  });
  it('voice segments do not fetch until tapped', () => {
    const resolveMedia = vi.fn(async () => 'u');
    render(<SegmentList segments={[{ type: 'voice', object: 'media/aaaaaaaa/x.m4a' }]} env={env({ ctx: ctx({ resolveMedia }) })} />);
    expect(resolveMedia).not.toHaveBeenCalled();
  });
  it('unknown card kinds fall back to a generic card', () => {
    render(<SegmentList segments={[{ type: 'card', kind: 'mystery_kind', data: { title: '神秘卡片', note: 'hello' } }]} env={env()} />);
    expect(screen.getByText('神秘卡片')).toBeTruthy();
  });
});

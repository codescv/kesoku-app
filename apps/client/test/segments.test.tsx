import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { BilingualSegment, Segment } from '@kesoku/protocol';
import { BilingualCard, clearLexCacheForTest, findToken, toWordUnits, tokenSpans } from '../src/features/segments/BilingualCard';
import { Markdown, parseBlocks } from '../src/features/segments/Markdown';
import { SegmentList, isStickerMedia, type SegmentEnv } from '../src/features/segments/SegmentRenderer';
import { formatMessageTime, MessageList } from '../src/features/session/MessageList';
import { db, purgeSessionFromDb, reconcileSessionsInDb } from '../src/lib/db';
import type { CardContext } from '../src/features/cards/types';
import { useStore } from '../src/lib/store';

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
  it('renders ruby, shows 合成中 while TTS is pending, buffers when ready, plays only on tap', async () => {
    const resolveVoice = vi.fn(async () => 'https://media.test/v.m4a');
    const play = vi.fn(async () => {});
    const load = vi.fn();
    const AudioSpy = vi.fn(function (this: Record<string, unknown>) {
      this.play = play;
      this.pause = vi.fn();
      this.load = load;
    });
    vi.stubGlobal('Audio', AudioSpy);
    try {
      const { container } = render(<BilingualCard seg={seg} resolveVoice={resolveVoice} explain={vi.fn()} />);
      expect(container.querySelectorAll('ruby').length).toBe(2);
      expect(container.querySelector('rt')?.textContent).toBe('きょう');
      expect(container.querySelector('audio')).toBeNull();
      // placeholder not ready yet → pending pill, nothing fetched
      const pill = container.querySelector('.k-voice') as HTMLButtonElement;
      expect(pill.getAttribute('data-state')).toBe('pending');
      expect(pill.textContent).toContain('合成中…');
      expect(resolveVoice).not.toHaveBeenCalled();
      // synthesis finished → buffered eagerly in the background, never played
      await act(async () => useStore.setState((s) => ({ media: { ...s.media, pv1: { status: 'ready', url: 'https://media.test/v.m4a' } } })));
      expect(resolveVoice).toHaveBeenCalledTimes(1);
      expect(AudioSpy).toHaveBeenCalledWith('https://media.test/v.m4a');
      expect(load).toHaveBeenCalled();
      expect(play).not.toHaveBeenCalled();
      await act(async () => fireEvent.click(screen.getByRole('button', { name: '播放语音' })));
      expect(resolveVoice).toHaveBeenCalledTimes(1);
      expect(play).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      useStore.setState({ media: {} });
    }
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

  it('falls back to lexical.explain when tokens are missing and caches results across word switches', async () => {
    clearLexCacheForTest();
    const explain = vi.fn(async (_txt: string, tok: string) => ({ surface: tok, reading: tok, gloss_zh: `${tok}-释义` }));
    render(<BilingualCard seg={{ type: 'bilingual', ja_plain: '天気はいい', ja: '天気(てんき)はいい', zh: '天气真好' }} resolveVoice={vi.fn()} explain={explain} />);
    const words = screen.getAllByRole('button').filter((b) => b.classList.contains('k-word'));
    await act(async () => fireEvent.click(words[0]));
    expect(explain).toHaveBeenCalledTimes(1);
    expect(explain).toHaveBeenCalledWith('天気はいい', '天気');
    expect(screen.getByText('天気-释义')).toBeTruthy();

    await act(async () => fireEvent.click(words[1]));
    expect(explain).toHaveBeenCalledTimes(2);
    expect(screen.getByText('はいい-释义')).toBeTruthy();

    // Switching back to the first word uses the cache without calling explain again
    await act(async () => fireEvent.click(words[0]));
    expect(explain).toHaveBeenCalledTimes(2);
    expect(screen.getByText('天気-释义')).toBeTruthy();
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

  describe('multi-line ja / zh', () => {
    const multiSeg = {
      type: 'bilingual',
      ja: '森(もり)さんは見(み)る。\n甲(こう)：行(い)かない？',
      ja_plain: '森さんは見る。\n甲：行かない？',
      ruby_parts: [
        { base: '森', rt: 'もり' },
        { base: 'さんは' },
        { base: '見', rt: 'み' },
        { base: 'る。\n' },
        { base: '甲', rt: 'こう' },
        { base: '：' },
        { base: '行', rt: 'い' },
        { base: 'かない？' },
      ],
      zh: '森先生看。\n甲：去不去？',
    };

    it('word units isolate the line break', () => {
      const units = toWordUnits(multiSeg.ruby_parts);
      expect(units.some((u) => u.base === '\n')).toBe(true);
      expect(units.every((u) => u.base === '\n' || !u.base.includes('\n'))).toBe(true);
    });

    it('renders <br /> between Japanese lines and inside the Chinese translation', () => {
      const { container } = render(<BilingualCard seg={multiSeg as never} resolveVoice={async () => null} explain={async () => null} />);
      expect(container.querySelectorAll('.k-bi-ja br')).toHaveLength(1);
      expect(container.querySelectorAll('.k-bi-ja ruby')).toHaveLength(4);
      const zh = container.querySelector('.k-bi-zh')!;
      expect(zh.querySelectorAll('br')).toHaveLength(1);
      expect(zh.textContent).toBe('森先生看。甲：去不去？');
    });
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
  it('keeps sequential ordered list numbering across nested bullet sublists and blank lines', () => {
    const md = [
      '1. **Event Inbox (事件收件箱)**',
      '- 不让 webhook 直接硬调 Agent',
      '- 最小实现：按用户建事件表',
      '',
      '1. **Timers (定时器)**',
      '- 让 Agent 能主动起来的关键',
      '- **Follow-ups**: Agent 给自己设的死线',
      '',
      '1. **Memory (记忆)**',
      '- 跨会话连续性的核心',
    ].join('\n');
    const blocks = parseBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].t).toBe('ol');
    if (blocks[0].t === 'ol') {
      expect(blocks[0].items).toHaveLength(3);
      expect(blocks[0].subLists?.[0]).toHaveLength(2);
      expect(blocks[0].subLists?.[1]).toHaveLength(2);
      expect(blocks[0].subLists?.[2]).toHaveLength(1);
    }
    const { container } = render(<Markdown text={md} />);
    const ols = container.querySelectorAll('ol');
    expect(ols).toHaveLength(1);
    const topLis = ols[0].querySelectorAll(':scope > li');
    expect(topLis).toHaveLength(3);
    expect(topLis[0].querySelectorAll('ul > li')).toHaveLength(2);
    expect(topLis[1].querySelectorAll('ul > li')).toHaveLength(2);
    expect(topLis[2].querySelectorAll('ul > li')).toHaveLength(1);
  });
});

describe('formatMessageTime & <MessageList> timestamps', () => {
  it('formats same-day, yesterday, same-year, and cross-year timestamps cleanly', () => {
    const now = new Date(2026, 10, 15, 16, 30, 0).getTime();
    const todayTs = new Date(2026, 10, 15, 9, 5, 0).getTime();
    const yesterdayTs = new Date(2026, 10, 14, 21, 15, 0).getTime();
    const sameYearTs = new Date(2026, 9, 8, 14, 20, 0).getTime();
    const prevYearTs = new Date(2025, 11, 31, 23, 59, 0).getTime();
    expect(formatMessageTime(todayTs, now)).toBe('09:05');
    expect(formatMessageTime(yesterdayTs, now)).toBe('昨天 21:15');
    expect(formatMessageTime(sameYearTs, now)).toBe('10-08 14:20');
    expect(formatMessageTime(prevYearTs, now)).toBe('2025-12-31 23:59');
  });

  it('renders message send time on both user and assistant messages', () => {
    const ts1 = new Date(2026, 10, 15, 10, 12, 0).getTime();
    const ts2 = new Date(2026, 10, 15, 10, 13, 0).getTime();
    useStore.setState({
      sessions: {
        's-time': { session_id: 's-time', chatbot_id: 'app', role: 'asuka', mode_id: 'chat', title: 'T', updated_at: ts2 },
      },
      items: {
        's-time': [
          { key: 'u1', message_id: 'u1', kind: 'user', ts: ts1, text: '你好' },
          { key: 'a1', message_id: 'a1', kind: 'assistant', ts: ts2, segments: [{ type: 'text', markdown: '早安！' }] },
        ],
      },
    });
    render(<MessageList sessionId="s-time" modeId="chat" />);
    const times = screen.getAllByTestId('msg-time');
    expect(times).toHaveLength(2);
    expect(times[0].textContent).toContain('10:12');
    expect(times[1].textContent).toContain('10:13');
  });
});

describe('IndexedDB session reconciliation', () => {
  it('purgeSessionFromDb and reconcileSessionsInDb remove stale deleted sessions so web reload does not flash old sessions', async () => {
    const sKeep = { session_id: 's-keep-1', chatbot_id: 'app', role: 'asuka', mode_id: 'chat', title: 'Keep 1', updated_at: 100 };
    const sOld2 = { session_id: 's-old-2', chatbot_id: 'app', role: 'asuka', mode_id: 'chat', title: 'Old 2', updated_at: 90 };
    const sOld3 = { session_id: 's-old-3', chatbot_id: 'app', role: 'coder', mode_id: 'chat', title: 'Old 3', updated_at: 80 };
    await db.sessions.bulkPut([
      { session_id: 's-keep-1', data: sKeep, updated_at: 100 },
      { session_id: 's-old-2', data: sOld2, updated_at: 90 },
      { session_id: 's-old-3', data: sOld3, updated_at: 80 },
    ]);
    await db.messages.put({
      id: 's-old-2|m1',
      session_id: 's-old-2',
      ts: 90,
      data: { key: 'm1', message_id: 'm1', kind: 'user', ts: 90, text: 'hi' },
    });
    await db.cursors.put({ session_id: 's-old-2', last_seq: 5 });

    await reconcileSessionsInDb({ 's-keep-1': sKeep });

    const remaining = await db.sessions.toArray();
    expect(remaining.map((s) => s.session_id)).toEqual(['s-keep-1']);
    expect(await db.messages.where('session_id').equals('s-old-2').count()).toBe(0);
    expect(await db.cursors.get('s-old-2')).toBeUndefined();

    await purgeSessionFromDb('s-keep-1');
    expect(await db.sessions.count()).toBe(0);
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
  it('hides the choice pills once picked (the pick is shown once, as the user bubble)', () => {
    const segs: Segment[] = [{ type: 'question', prompt: '', choices: ['A', 'B'], multi: false }];
    const { container, unmount } = render(<SegmentList segments={segs} env={env({ picked: ['A'] })} />);
    expect(container.querySelector('.k-q-choices')).toBeNull();
    expect(container.querySelector('.k-choice')).toBeNull();
    expect(screen.queryByText('A')).toBeNull();
    expect(container.querySelector('.k-q')).toBeNull();
    unmount();
    const withPrompt: Segment[] = [{ type: 'question', prompt: '去哪？', choices: ['海边', '神社'], multi: false }];
    const r = render(<SegmentList segments={withPrompt} env={env({ picked: ['神社'] })} />);
    expect(r.container.querySelector('.k-q.is-answered .k-q-prompt')?.textContent).toBe('去哪？');
    expect(r.container.querySelector('.k-q-choices')).toBeNull();
    expect(screen.queryByText('神社')).toBeNull();
  });
  it('multi-select confirms the chosen set', () => {
    const onPick = vi.fn();
    const segs: Segment[] = [{ type: 'question', prompt: '', choices: ['A', 'B', 'C'], multi: true, max: 2 }];
    render(<SegmentList segments={segs} env={env({ onPick })} />);
    fireEvent.click(screen.getByText('A'));
    fireEvent.click(screen.getByText('C'));
    expect(screen.getByRole('button', { name: '确认选择 (2/2)' })).toBeTruthy();
    fireEvent.click(screen.getByText(/确认选择/));
    expect(onPick).toHaveBeenCalledWith('m1', ['A', 'C']);
  });
  it('supports mutually exclusive option groups, subtitles, and ungrouped sections in multi-select QuestionPills', () => {
    const onPick = vi.fn();
    const segs: Segment[] = [
      {
        type: 'question',
        prompt: '升级换招',
        question_message_id: 'q-lvl',
        multi: true,
        choices: ['asuka-a', 'asuka-b', 'rei-a', 'rei-b', 'bonus'],
        choice_items: [
          { value: 'asuka-a', name: '烈焰风暴', subtitle: '威力 2d8 · 替换火球术', group: '明日香' },
          { value: 'asuka-b', name: '保留现有 4 招', group: '明日香' },
          { value: 'rei-a', name: '极寒新星', subtitle: '威力 2d6 · 替换冰箭术', group: '绫波丽' },
          { value: 'rei-b', name: '零度护盾', subtitle: '护盾 +6 · 替换护罩', group: '绫波丽' },
          { value: 'bonus', name: '额外：补充药水', subtitle: '消耗 20 金币' },
        ],
      },
    ];
    const { container } = render(<SegmentList segments={segs} env={env({ onPick })} />);

    // Renders group headers in order of first appearance, plus an ungrouped section without a header.
    const labels = Array.from(container.querySelectorAll('.k-q-group-label')).map((el) => el.textContent);
    expect(labels).toEqual(['明日香', '绫波丽']);
    expect(container.querySelectorAll('.k-q-group')).toHaveLength(3);

    // Renders primary name and muted subtitle text.
    expect(screen.getByText('烈焰风暴').className).toContain('k-choice-title');
    expect(screen.getByText('威力 2d8 · 替换火球术').className).toContain('k-choice-sub');

    const confirmBtn = screen.getByRole('button', { name: '确认选择 (0)' }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);

    // Auto-switches within the same group.
    fireEvent.click(screen.getByText('烈焰风暴'));
    expect(screen.getByText('烈焰风暴').closest('button')?.classList.contains('is-on')).toBe(true);
    expect(screen.getByRole('button', { name: '确认选择 (1)' })).toBeTruthy();

    fireEvent.click(screen.getByText('保留现有 4 招'));
    expect(screen.getByText('烈焰风暴').closest('button')?.classList.contains('is-on')).toBe(false);
    expect(screen.getByText('保留现有 4 招').closest('button')?.classList.contains('is-on')).toBe(true);
    expect(screen.getByRole('button', { name: '确认选择 (1)' })).toBeTruthy();

    // Allows simultaneous selection across different groups and ungrouped choices.
    fireEvent.click(screen.getByText('极寒新星'));
    fireEvent.click(screen.getByText('额外：补充药水'));
    expect(screen.getByRole('button', { name: '确认选择 (3)' })).toBeTruthy();

    // Clicking an already-selected choice deselects it.
    fireEvent.click(screen.getByText('额外：补充药水'));
    expect(screen.getByText('额外：补充药水').closest('button')?.classList.contains('is-on')).toBe(false);
    expect(screen.getByRole('button', { name: '确认选择 (2)' })).toBeTruthy();

    // Switching within the second group keeps the first group intact.
    fireEvent.click(screen.getByText('零度护盾'));
    expect(screen.getByText('极寒新星').closest('button')?.classList.contains('is-on')).toBe(false);
    expect(screen.getByText('零度护盾').closest('button')?.classList.contains('is-on')).toBe(true);
    expect(screen.getByText('保留现有 4 招').closest('button')?.classList.contains('is-on')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '确认选择 (2)' }));
    expect(onPick).toHaveBeenCalledWith('q-lvl', ['asuka-b', 'rei-b']);
  });
  it('still respects explicit max for ungrouped choices while allowing in-group switching', () => {
    const onPick = vi.fn();
    const segs: Segment[] = [
      {
        type: 'question',
        prompt: '',
        multi: true,
        max: 2,
        choices: ['g1-a', 'g1-b', 'u1', 'u2'],
        choice_items: [
          { value: 'g1-a', name: 'G1-A', group: '组1' },
          { value: 'g1-b', name: 'G1-B', group: '组1' },
          { value: 'u1', name: 'U1' },
          { value: 'u2', name: 'U2' },
        ],
      },
    ];
    render(<SegmentList segments={segs} env={env({ onPick })} />);
    fireEvent.click(screen.getByText('G1-A'));
    fireEvent.click(screen.getByText('U1'));
    // At max (2), another ungrouped choice is ignored.
    fireEvent.click(screen.getByText('U2'));
    expect(screen.getByText('U2').closest('button')?.classList.contains('is-on')).toBe(false);
    // Switching within the already-selected group still works.
    fireEvent.click(screen.getByText('G1-B'));
    expect(screen.getByText('G1-A').closest('button')?.classList.contains('is-on')).toBe(false);
    expect(screen.getByText('G1-B').closest('button')?.classList.contains('is-on')).toBe(true);
    // Explicit max is displayed on confirm button, and picks are emitted in choice-index order.
    fireEvent.click(screen.getByRole('button', { name: '确认选择 (2/2)' }));
    expect(onPick).toHaveBeenCalledWith('m1', ['g1-b', 'u1']);
  });
  it('resolves duplicate choice values across groups by position without cross-group highlight or key collision', () => {
    const onPick = vi.fn();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const segs: Segment[] = [
        {
          type: 'question',
          prompt: '升级换招',
          multi: true,
          choices: ['烈焰风暴', '保留', '极寒新星', '保留'],
          choice_items: [
            { value: '烈焰风暴', name: '烈焰风暴', group: '明日香' },
            { value: '保留', name: '保留', group: '明日香' },
            { value: '极寒新星', name: '极寒新星', group: '绫波丽' },
            { value: '保留', name: '保留', group: '绫波丽' },
          ],
        },
      ];
      render(<SegmentList segments={segs} env={env({ onPick })} />);
      const asukaGroup = screen.getByRole('group', { name: '明日香' });
      const reiGroup = screen.getByRole('group', { name: '绫波丽' });
      const asukaKeep = asukaGroup.querySelectorAll('button')[1];
      const reiKeep = reiGroup.querySelectorAll('button')[1];
      expect(asukaKeep.textContent).toBe('保留');
      expect(reiKeep.textContent).toBe('保留');

      // Clicking 明日香's 保留 highlights only 明日香's button, not 绫波丽's.
      fireEvent.click(asukaKeep);
      expect(asukaKeep.classList.contains('is-on')).toBe(true);
      expect(reiKeep.classList.contains('is-on')).toBe(false);

      // Selecting 绫波丽's 极寒新星 then switching to 绫波丽's 保留 keeps 明日香's 保留 selected.
      fireEvent.click(reiGroup.querySelectorAll('button')[0]);
      fireEvent.click(reiKeep);
      expect(asukaKeep.classList.contains('is-on')).toBe(true);
      expect(reiKeep.classList.contains('is-on')).toBe(true);

      fireEvent.click(screen.getByRole('button', { name: '确认选择 (2)' }));
      expect(onPick).toHaveBeenCalledWith('m1', ['保留', '保留']);
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
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
    expect(screen.getByText('点开查看图片')).toBeTruthy();
  });
  it('voice segments buffer in the background but never play before the tap', async () => {
    const resolveMedia = vi.fn(async () => 'u');
    const play = vi.fn(async () => {});
    vi.stubGlobal(
      'Audio',
      vi.fn(function (this: Record<string, unknown>) {
        this.play = play;
        this.pause = vi.fn();
      }),
    );
    try {
      render(<SegmentList segments={[{ type: 'voice', object: 'media/aaaaaaaa/x.m4a' }]} env={env({ ctx: ctx({ resolveMedia }) })} />);
      await act(async () => {});
      expect(resolveMedia).toHaveBeenCalledTimes(1);
      expect(play).not.toHaveBeenCalled();
      await act(async () => fireEvent.click(screen.getByRole('button', { name: '播放语音' })));
      expect(resolveMedia).toHaveBeenCalledTimes(1);
      expect(play).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('history-only voice refs are not fetched unless the row is among the latest (preloadVoice)', async () => {
    const resolveMedia = vi.fn(async () => 'u');
    const segs: Segment[] = [{ type: 'voice', ref: 'sessions/x/v.wav' }];
    const { unmount } = render(<SegmentList segments={segs} env={env({ ctx: ctx({ resolveMedia }) })} />);
    await act(async () => {});
    expect(resolveMedia).not.toHaveBeenCalled();
    unmount();
    render(<SegmentList segments={segs} env={env({ ctx: ctx({ resolveMedia }), preloadVoice: true })} />);
    await act(async () => {});
    expect(resolveMedia).toHaveBeenCalledTimes(1);
  });
  it('pending voice placeholders show 合成中 and failed ones 语音失败', async () => {
    useStore.setState((s) => ({ media: { ...s.media, pa: { status: 'pending' }, pb: { status: 'failed' } } }));
    try {
      const { container } = render(
        <SegmentList
          segments={[
            { type: 'voice', placeholder_id: 'pa' },
            { type: 'voice', placeholder_id: 'pb' },
          ]}
          env={env()}
        />,
      );
      const pills = container.querySelectorAll('.k-voice');
      expect(pills[0].getAttribute('data-state')).toBe('pending');
      expect(pills[0].textContent).toContain('合成中…');
      expect(pills[1].getAttribute('data-state')).toBe('failed');
      expect(pills[1].textContent).toContain('语音失败');
    } finally {
      useStore.setState({ media: {} });
    }
  });
  it('stickers render small (.is-sticker), regular images as full cards', async () => {
    const resolveMedia = vi.fn(async (r: { object?: string }) => `https://media.test/${r.object}`);
    const { container } = render(
      <SegmentList
        segments={[
          { type: 'file', object: 'roles/asuka/stickers/21_啄你哦.gif', mime: 'image/gif' },
          { type: 'file', object: 'sessions/s1/cg.webp', mime: 'image/webp' },
        ]}
        env={env({ ctx: ctx({ resolveMedia }) })}
      />,
    );
    await act(async () => {});
    const imgs = container.querySelectorAll('.k-media-img');
    expect(imgs).toHaveLength(2);
    expect(imgs[0].classList.contains('is-sticker')).toBe(true);
    expect(imgs[1].classList.contains('is-sticker')).toBe(false);
  });
  it('isStickerMedia matches gif mime, stickers/ dirs and .gif paths (ignoring ?query)', () => {
    expect(isStickerMedia({ mime: 'IMAGE/GIF' })).toBe(true);
    expect(isStickerMedia({ ref: 'roles/asuka/stickers/21_啄你哦.png' })).toBe(true);
    expect(isStickerMedia({ name: '[file: x]', url: 'https://cdn.test/a/b.gif?sig=1' })).toBe(true);
    expect(isStickerMedia({ object: 'stickers/a.webp' })).toBe(true);
    expect(isStickerMedia({ object: 'sessions/s/cg.webp', mime: 'image/webp' })).toBe(false);
    expect(isStickerMedia({ url: 'https://cdn.test/gif/cg.png?x=.gif' })).toBe(false);
  });
  it('unknown card kinds fall back to a generic card', () => {
    render(<SegmentList segments={[{ type: 'card', kind: 'mystery_kind', data: { title: '神秘卡片', note: 'hello' } }]} env={env()} />);
    expect(screen.getByText('神秘卡片')).toBeTruthy();
  });
  it('renders <spoiler>, ||spoiler||, GFM tables, and ruby inside question choices', () => {
    const { container } = render(
      <SegmentList
        segments={[
          {
            type: 'text',
            markdown: '答案：<spoiler>秘密内容</spoiler> 或 ||隐藏词||\n\n| 假名 | 含义 |\n|---|---|\n| 明日(あした) | 明天 |',
          },
          {
            type: 'question',
            prompt: '明日（あした）どこへ行く？',
            choices: ['海（うみ）へ行く', '山(やま)へ行く'],
            multi: false,
          },
        ]}
        env={env()}
      />,
    );
    const spoilers = container.querySelectorAll('.k-spoiler');
    expect(spoilers.length).toBe(2);
    expect(spoilers[0].classList.contains('is-open')).toBe(false);
    fireEvent.click(spoilers[0]);
    expect(spoilers[0].classList.contains('is-open')).toBe(true);
    expect(container.querySelector('table.k-table')).toBeTruthy();
    const rts = Array.from(container.querySelectorAll('rt')).map((el) => el.textContent);
    expect(rts).toContain('うみ');
    expect(rts).toContain('やま');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Segment } from '@kesoku/protocol';
import { GalgameStage, ModePanel, PeekSheet, latestCg, latestTurn, previewLine } from '../../src/features/modes';
import type { ChatItem } from '../../src/lib/types';
import { useStore } from '../../src/lib/store';
import { bondInfo, equipRows, formInfo, growthInfo, skillRows } from '../../src/features/modes/panels/ModePanel';
import { makeCtx } from '../cards/ctx';

function assistant(key: string, segments: Segment[], extra: Partial<ChatItem> = {}): ChatItem {
  return { key, kind: 'assistant', message_id: key, ts: 1, segments, sender: { display_name: '飞鸟' }, ...extra };
}

const ITEMS: ChatItem[] = [
  assistant('m1', [{ type: 'file', placeholder_id: 'cg-old', mime: 'image/webp' } as Segment]),
  { key: 'u1', kind: 'user', ts: 2, text: '你好' },
  assistant('m2', [
    { type: 'file', placeholder_id: 'cg-new', mime: 'image/webp' } as Segment,
    { type: 'bilingual', ja_plain: '海風、ちょっと冷たいね', ja: '海風(うみかぜ)、ちょっと冷(つめ)たいね', zh: '海风有点凉呢', voice: { object: 'voice/1.ogg', duration_ms: 5000 } } as Segment,
    { type: 'question', prompt: '', choices: ['帮她拢好刘海', '凑近尝一口汽水'], multi: false } as Segment,
  ]),
];

const STATE = {
  'game/scene.json': { location: '江之岛海边', clock: '17:42', marks: [{ id: 'k1', text: '猫耳发箍', until_type: 'time', expires_at: Date.now() / 1000 + 720 }] },
};

function stage(over: Partial<Parameters<typeof GalgameStage>[0]> = {}) {
  const ctx = makeCtx({ modeId: 'galgame' });
  const props = {
    items: ITEMS,
    preview: null,
    stateFiles: STATE,
    ctx,
    policy: 'confirm_only' as const,
    onPolicyChange: vi.fn(),
    onPick: vi.fn(),
    onExit: vi.fn(),
    ...over,
  };
  return { ...render(<GalgameStage {...props} />), props, ctx };
}

describe('GalgameStage', () => {
  it('renders the latest CG, line with ruby, scene pills and choices → onPick', async () => {
    const { props, ctx, container } = stage();
    await act(async () => {});
    expect(ctx.resolveMedia).toHaveBeenCalledWith({ placeholder_id: 'cg-new' });
    expect(ctx.resolveMedia).not.toHaveBeenCalledWith({ placeholder_id: 'cg-old' });
    const cg = screen.getAllByTestId('gg-cg');
    expect((cg[cg.length - 1] as HTMLImageElement).src).toBe('https://media.test/cg-new');
    expect(container.querySelector('.gg-line rt')?.textContent).toBe('うみかぜ');
    expect(screen.getByText('海风有点凉呢')).toBeTruthy();
    expect(screen.getByText(/江之岛海边 · 17:42/)).toBeTruthy();
    expect(screen.getByText('猫耳发箍')).toBeTruthy();
    expect(screen.getByText(/记忆：确认/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /凑近尝一口汽水/ }));
    expect(props.onPick).toHaveBeenCalledWith('m2', ['凑近尝一口汽水']);
  });

  it('buffers the ready voice in the background but never plays it before the tap', async () => {
    const play = vi.fn(async () => {});
    const AudioSpy = vi.fn(function (this: Record<string, unknown>) {
      this.play = play;
      this.pause = vi.fn();
      this.load = vi.fn();
    });
    vi.stubGlobal('Audio', AudioSpy);
    try {
      const { ctx } = stage();
      await act(async () => {});
      expect(document.querySelector('audio')).toBeNull();
      expect(ctx.resolveMedia).toHaveBeenCalledWith(expect.objectContaining({ object: 'voice/1.ogg' }));
      expect(AudioSpy).toHaveBeenCalledTimes(1);
      expect(play).not.toHaveBeenCalled();
      await act(async () => fireEvent.click(screen.getByRole('button', { name: '播放语音' })));
      expect(play).toHaveBeenCalledTimes(1);
      expect(AudioSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('renders the whole scene in order: narration, 斋藤飞鸟 dialogue (never "Kesoku"), closing narration, inline sticker', async () => {
    const turn = assistant(
      'm9',
      [
        { type: 'text', markdown: '夕阳把海面染成了橘色，飞鸟踮着脚走在防波堤上。' } as Segment,
        { type: 'bilingual', ja_plain: 'ねえ、見て！', ja: 'ねえ、見(み)て！', zh: '喂，你看！', voice: { object: 'voice/9.ogg' } } as Segment,
        { type: 'text', markdown: '她回头冲你眨了眨眼，把汽水递了过来。' } as Segment,
        { type: 'file', object: 'roles/asuka/stickers/21_啄你哦.gif', name: '21_啄你哦.gif' } as Segment,
      ],
      { sender: { name: 'Kesoku' } },
    );
    const { container } = stage({ items: [turn], personaName: '斋藤飞鸟' });
    await act(async () => {});
    const body = screen.getByTestId('gg-box-body');
    const kids = Array.from(body.children).map((el) => el.className);
    expect(kids).toEqual(['gg-narration', 'gg-speech', 'gg-narration', 'gg-sticker']);
    expect(body.textContent).toContain('夕阳把海面染成了橘色');
    expect(body.textContent).toContain('把汽水递了过来');
    expect(screen.getByText('喂，你看！')).toBeTruthy();
    expect(container.querySelector('.gg-nameplate')?.textContent).toBe('斋藤飞鸟');
    expect(container.textContent).not.toContain('Kesoku');
    // single dialogue line → its voice pill sits in the box header
    expect(container.querySelector('.gg-box-head .k-voice')).toBeTruthy();
    // the sticker stays inline and small, never the CG
    expect(container.querySelector('.gg-sticker .k-media.is-sticker')).toBeTruthy();
    expect(screen.getByTestId('gg-fallback')).toBeTruthy();
  });

  it('multi-line turns get a voice pill per speech; tapping the box toggles expansion but buttons do not', async () => {
    const turn = assistant('m10', [
      { type: 'bilingual', ja_plain: 'おはよう', zh: '早上好', voice: { object: 'v/a.ogg' } } as Segment,
      { type: 'bilingual', ja_plain: 'またね', zh: '回头见', voice: { object: 'v/b.ogg' } } as Segment,
    ]);
    const { container } = stage({ items: [turn] });
    await act(async () => {});
    expect(container.querySelector('.gg-box-head .k-voice')).toBeNull();
    expect(container.querySelectorAll('.gg-speech-head .k-voice')).toHaveLength(2);
    const box = screen.getByTestId('gg-box');
    fireEvent.click(screen.getByText('早上好'));
    expect(box.classList.contains('is-expanded')).toBe(false);
    fireEvent.click(container.querySelector('.gg-narration, .gg-line') as HTMLElement);
    expect(box.classList.contains('is-expanded')).toBe(true);
  });

  it('latestCg never picks stickers and skips pending/failed placeholders (keeps the previous CG)', () => {
    const items: ChatItem[] = [
      assistant('a', [{ type: 'file', placeholder_id: 'cg-1', mime: 'image/webp' } as Segment]),
      assistant('b', [
        { type: 'file', placeholder_id: 'cg-2', mime: 'image/webp' } as Segment,
        { type: 'file', object: 'roles/asuka/stickers/21_啄你哦.gif' } as Segment,
        { type: 'file', ref: 'x/y/z.gif' } as Segment,
      ]),
    ];
    expect(latestCg(items)).toEqual({ placeholder_id: 'cg-2' });
    expect(latestCg(items, { 'cg-2': { status: 'pending' } })).toEqual({ placeholder_id: 'cg-1' });
    expect(latestCg(items, { 'cg-2': { status: 'failed' } })).toEqual({ placeholder_id: 'cg-1' });
    expect(latestCg(items, { 'cg-2': { status: 'ready' } })).toEqual({ placeholder_id: 'cg-2' });
    expect(latestCg([assistant('s', [{ type: 'file', object: 'roles/asuka/stickers/1.gif', mime: 'image/gif' } as Segment])])).toBeNull();
    expect(latestTurn(items)?.item.key).toBe('b');
  });

  it('shows 插画生成中 while the new CG is pending and keeps the previous CG', async () => {
    useStore.setState((s) => ({ media: { ...s.media, 'cg-new': { status: 'pending' } } }));
    try {
      const { ctx } = stage();
      await act(async () => {});
      expect(screen.getByTestId('gg-cg-status').textContent).toContain('🎨 插画生成中…');
      expect(ctx.resolveMedia).toHaveBeenCalledWith({ placeholder_id: 'cg-old' });
      expect(ctx.resolveMedia).not.toHaveBeenCalledWith({ placeholder_id: 'cg-new' });
      await act(async () => useStore.setState((s) => ({ media: { ...s.media, 'cg-new': { status: 'failed' } } })));
      expect(screen.getByTestId('gg-cg-status').textContent).toContain('⚠️ 插画未就绪');
      await act(async () => useStore.setState((s) => ({ media: { ...s.media, 'cg-new': { status: 'ready' } } })));
      expect(screen.queryByTestId('gg-cg-status')).toBeNull();
      expect(ctx.resolveMedia).toHaveBeenCalledWith({ placeholder_id: 'cg-new' });
    } finally {
      useStore.setState({ media: {} });
    }
  });

  it('streaming shows earlier narration paragraphs together with the dialogue being typed', async () => {
    stage({ preview: { turn_id: 't', round_id: 0, text: '海风吹起她的刘海。\n\n```bilingual\nja: 「寒いね」\nzh: 好冷\n```\n\n她往你身边靠了靠', thought: '', startedAt: 0 } });
    await act(async () => {});
    const body = screen.getByTestId('gg-box-body');
    expect(body.textContent).toContain('海风吹起她的刘海。');
    expect(body.querySelector('.gg-speech')).toBeTruthy();
    expect(body.textContent).not.toContain('ja:');
  });

  it('falls back to a gradient without CG; ← exits; zh line toggles; policy badge changes policy', () => {
    const { props } = stage({ items: [assistant('x', [{ type: 'bilingual', ja_plain: 'こんにちは', zh: '你好' } as Segment])] });
    expect(screen.getByTestId('gg-fallback')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '返回气泡流' }));
    expect(props.onExit).toHaveBeenCalled();
    fireEvent.click(screen.getByText('你好'));
    expect(screen.getByText('译文 ▸')).toBeTruthy();
    fireEvent.click(screen.getByText(/记忆：确认/));
    fireEvent.click(screen.getByRole('radio', { name: '忽略' }));
    expect(props.onPolicyChange).toHaveBeenCalledWith('isolated');
  });

  it('hides choices once the player replied or picked', () => {
    stage({ items: [...ITEMS.slice(0, 2), { ...ITEMS[2], picked: ['帮她拢好刘海'] }] });
    expect(screen.queryByRole('button', { name: /凑近尝一口汽水/ })).toBeNull();
  });

  it('streams the preview with a typewriter', async () => {
    vi.useFakeTimers();
    try {
      stage({ preview: { turn_id: 't', round_id: 0, text: '```bilingual\nja: 夕日がきれいだね\n', thought: '', startedAt: 0 } });
      await act(async () => {
        vi.advanceTimersByTime(30);
      });
      expect(document.querySelector('.gg-line.is-typing')?.textContent?.length).toBeLessThan(8);
      for (let i = 0; i < 20; i++) {
        await act(async () => {
          vi.advanceTimersByTime(100);
        });
      }
      expect(document.querySelector('.gg-line.is-typing')?.textContent).toBe('夕日がきれいだね');
    } finally {
      vi.useRealTimers();
    }
  });

  it('previewLine extracts prose / open bilingual values', () => {
    expect(previewLine('前文\n\n```card\nkind: x\n```\n\n后文[file:a.png]')).toBe('后文');
    expect(previewLine('```bilingual\nja: 「やあ」\nzh: 嗨')).toBe('やあ');
  });
});

describe('PeekSheet', () => {
  const glossary = {
    multiscale: { id: 'multiscale', title: '多重鳞片', category: '特性', effect_pills: ['满 HP 时受伤减半', '失控状态无效', '第三条'], details_md: '**满血**时生效。\n\n- 被打断后失效', related: ['roguemega'] },
    roguemega: { id: 'roguemega', title: '失控超级进化', effect_pills: ['全能力提升'], details_md: '' },
  };
  it('shows 2 pills, folds details, navigates related in place with back, and asks', () => {
    const ctx = makeCtx();
    const onClose = vi.fn();
    render(<PeekSheet entry={glossary.multiscale} glossary={glossary} onClose={onClose} ctx={ctx} personaName="Mio" />);
    expect(screen.getByText('满 HP 时受伤减半')).toBeTruthy();
    expect(screen.queryByText('第三条')).toBeNull();
    expect(screen.queryByText(/满血时生效/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /实战细节/ }));
    expect(screen.getByText('满血时生效。')).toBeTruthy();
    expect(screen.getByText('• 被打断后失效')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /失控超级进化/ }));
    expect(screen.getByText('全能力提升')).toBeTruthy();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(screen.getByText('满 HP 时受伤减半')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /问Mio/ }));
    expect(ctx.insertComposer).toHaveBeenCalledWith('多重鳞片');
    expect(onClose).toHaveBeenCalled();
  });
  it('renders nothing without an entry', () => {
    const { container } = render(<PeekSheet entry={null} onClose={() => {}} ctx={makeCtx()} />);
    expect(container.childElementCount).toBe(0);
  });
});

describe('ModePanel', () => {
  it('mistakes → 立即消灭 sends the drill request', () => {
    const ctx = makeCtx();
    render(<ModePanel panel="mistakes" stateFiles={{ 'game/mistakes.json': { due: [{ id: 3, point: '〜てはいけません', lesson: 15, user_answer: '食べてはダメ', correct: '食べちゃダメ' }] } }} modePrefs={{}} ctx={ctx} />);
    expect(screen.getByText('第15课')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '立即消灭' }));
    expect(ctx.sendText).toHaveBeenCalledWith('立即消灭错题 #3：〜てはいけません');
  });

  it('roster resolves actor refs; party shows members & enemies; travel shows order + dietary', async () => {
    const ctx = makeCtx();
    const sf = {
      'game/roster.json': { members: { 天命人: { name: '天命人', role: '第一主角', outfit: '乌金行者甲、如意金箍棒', base_appearance: { ref: 'cast/xiaozhang' } } } },
      'game/party.json': { members: { 小张: { hp: 28, max_hp: 28, role: 'player', level: 3, skills: [{ name: '突刺', dmg: '1d8' }], inventory: ['药水'] } }, enemies: { 机甲: { hp: 45, max_hp: 80, status: ['蓄力AOE'] } } },
      'game/travel.json': { city: '涩谷', dietary: ['乳糖不耐', { label: '不辣' }], order: [{ name_zh: '烤鸡串', name_local: '焼き鳥', qty: 2 }] },
    };
    const { rerender } = render(<ModePanel panel="roster" stateFiles={sf} modePrefs={{}} ctx={ctx} />);
    await act(async () => {});
    expect(ctx.resolveMedia).toHaveBeenCalledWith({ ref: 'cast/xiaozhang' });
    expect(screen.getByText('乌金行者甲')).toBeTruthy();
    rerender(<ModePanel panel="party" stateFiles={sf} modePrefs={{}} ctx={ctx} />);
    expect(screen.getByText('HP 28/28')).toBeTruthy();
    expect(screen.getByText('蓄力AOE')).toBeTruthy();
    expect(screen.getByText(/突刺/)).toBeTruthy();
    rerender(<ModePanel panel="travel" stateFiles={sf} modePrefs={{}} ctx={ctx} />);
    expect(screen.getByText('不辣')).toBeTruthy();
    expect(screen.getByText('×2')).toBeTruthy();
  });

  it('party panel shows structured equipment (object & legacy slots) and heal / guard / buff skills', () => {
    const ctx = makeCtx();
    const sf = {
      'game/party.json': {
        members: {
          小张: {
            hp: 20,
            max_hp: 24,
            role: 'player',
            class: '调查员',
            equip: {
              weapon: { name: '强光手电', hit: 1, ac: 0, dmg: '1d6+2', fx: '照破黑暗与幻觉', visual: '银色金属外壳' },
              armor: { name: '校服外套', hit: 0, ac: 2, dmg: '', fx: '', visual: '深蓝制服' },
              accessory: { name: '护身符', hit: -1, ac: 0, dmg: '', fx: '' },
            },
            skills: [
              { name: '闪光震慑', type: 'control', dmg: '1d4', status: 'stunned', guard: '', heal: '', buff: '', desc: '' },
              { name: '急救包扎', type: 'heal', heal: '2d4+2' },
              { name: '挺身掩护', type: 'guard', guard: true },
              { name: '鼓舞士气', type: 'buff', buff: '全队命中+1', desc: '持续两回合' },
            ],
            inventory: ['绷带'],
          },
          斋藤飞鸟: { hp: 18, max_hp: 18, role: 'active', equip: { weapon: '竹刀', armor: '', accessory: { name: '', ac: 3 } } },
        },
      },
    };
    render(<ModePanel panel="party" stateFiles={sf} modePrefs={{}} ctx={ctx} />);
    const equipLists = screen.getAllByRole('list', { name: '装备' });
    expect(equipLists).toHaveLength(2);
    const zhang = within(equipLists[0]!);
    expect(zhang.getByText('强光手电')).toBeTruthy();
    expect(zhang.getByText('命中+1 · 伤害1d6+2 · 照破黑暗与幻觉')).toBeTruthy();
    expect(zhang.getByText('校服外套')).toBeTruthy();
    expect(zhang.getByText('AC+2')).toBeTruthy();
    expect(zhang.getByText('护身符')).toBeTruthy();
    expect(zhang.getByText('命中-1')).toBeTruthy();
    expect(zhang.getAllByText(/^(武器|护甲|饰品)$/).map((n) => n.textContent)).toEqual(['武器', '护甲', '饰品']);
    // Pure visual text is never shown as a bonus.
    expect(screen.queryByText(/银色金属外壳|深蓝制服/)).toBeNull();
    // Legacy string slot still renders; empty / nameless slots are skipped.
    const asuka = within(equipLists[1]!);
    expect(asuka.getByText('竹刀')).toBeTruthy();
    expect(asuka.getAllByRole('listitem')).toHaveLength(1);
    // Skills: heal / guard / buff are included alongside dmg / status / desc.
    const skills = within(screen.getByRole('list', { name: '配招' }));
    expect(skills.getByText(/1d4 · 状态:stunned/)).toBeTruthy();
    expect(skills.getByText(/治疗:2d4\+2/)).toBeTruthy();
    expect(skills.getByText(/壁垒掩护/)).toBeTruthy();
    expect(skills.getByText(/战意鼓舞 · 持续两回合/)).toBeTruthy();
    expect(skills.getByText('治疗')).toBeTruthy(); // type badge
    expect(skills.getByText('控制')).toBeTruthy();
    // Inventory no longer mixes in equipped items.
    expect(screen.getByText('绷带')).toBeTruthy();
  });

  it('dex shows pinned matchup + version and reopens history cards; lesson shows outline', () => {
    const ctx = makeCtx();
    const sf = {
      'game/pokemon.json': {
        game_version: 'za',
        pinned_context: '超级快龙',
        history: [{ version: 'za', name: { zh: '超级快龙' }, types: ['龙', '飞行'], matchup: { x4: ['冰'], x2: ['龙'], x05: ['火'], x0: ['地面'] } }],
      },
      'game/lesson.json': { book: '初级', lesson: 21, title: 'て形', segment_index: 1, segments: [{ id: 's1', kind: 'vocab' }, { id: 's2', scene: '居酒屋' }, { id: 's3' }] },
    };
    const { rerender } = render(<ModePanel panel="dex" stateFiles={sf} modePrefs={{}} ctx={ctx} />);
    expect(screen.getByText('传说 Z-A')).toBeTruthy();
    expect(screen.getByText(/4× 致命弱点：冰/)).toBeTruthy();
    expect(screen.getByText(/0×/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /超级快龙/ }));
    expect(ctx.openFullscreen).toHaveBeenCalledTimes(1);
    rerender(<ModePanel panel="dex" stateFiles={sf} modePrefs={{ game_version: 'sv' }} ctx={ctx} />);
    expect(screen.getByText('朱／紫 SV')).toBeTruthy();
    rerender(<ModePanel panel="lesson" stateFiles={sf} modePrefs={{}} ctx={ctx} />);
    expect(screen.getByText('📘 初级 第21课')).toBeTruthy();
    expect(screen.getByText('2/3')).toBeTruthy();
    expect(screen.getByText('居酒屋')).toBeTruthy();
  });

  it('equipRows: exclusive flag and trigger tags (object & legacy string triggers)', () => {
    const rows = equipRows({
      weapon: { name: '武器甲', hit: 1, dmg: '1d10+2', fx: '特效', on_miss: { text: '打空词条', status: 'weakened', hp: 0 }, on_crit: { text: '暴击词条', status: 'staggered' }, combo_gain: 'crit', exclusive: true },
      armor: { name: '护甲乙', ac: 2, on_miss: '旧版打空', on_crit: '旧版暴击', combo_gain: 'hit' },
      accessory: { name: '饰品丙', on_miss: { status: 'exposed' }, combo_gain: 'nope', exclusive: 'yes' },
    });
    expect(rows[0]).toEqual({
      slot: '武器',
      name: '武器甲',
      bonuses: ['命中+1', '伤害1d10+2', '特效'],
      exclusive: true,
      tags: [
        { kind: 'miss', text: '打空词条' },
        { kind: 'crit', text: '暴击词条' },
        { kind: 'combo', text: '暴击+1格' },
      ],
    });
    expect(rows[1]).toMatchObject({ exclusive: false, tags: [{ kind: 'miss', text: '旧版打空' }, { kind: 'crit', text: '旧版暴击' }, { kind: 'combo', text: '命中+1格' }] });
    expect(rows[2]).toMatchObject({ exclusive: false, tags: [] });
    // Legacy plain-string slot.
    expect(equipRows({ weapon: '木刀' })).toEqual([{ slot: '武器', name: '木刀', bonuses: [], exclusive: false, tags: [] }]);
  });

  it('growthInfo / bondInfo: defensive defaults', () => {
    expect(growthInfo(undefined)).toBeNull();
    expect(growthInfo('x')).toBeNull();
    expect(growthInfo({ max_hp: 0, traits: [] })).toBeNull();
    expect(growthInfo({ max_hp: 4, hit: 1, ac: 0, dmg: 2, traits: ['特性甲'] })).toEqual({ traits: ['特性甲'], stats: ['HP+4', '命中+1', '伤害+2'] });
    expect(bondInfo(undefined)).toBeNull();
    expect(bondInfo([])).toBeNull();
    expect(bondInfo({ title: '系列甲', stages: 3, stage: 2, goal: '目标甲', done: false, pending: ['gear', 'combo'] })).toEqual({
      title: '系列甲',
      goal: '目标甲',
      done: false,
      progress: '2/3',
      bar: { value: 1, max: 3 },
      pending: ['专属装备', '新合体技'],
    });
    expect(bondInfo({ title: '系列乙', stages: 3, stage: 3, goal: '', done: true })).toMatchObject({ progress: '完结', bar: { value: 3, max: 3 } });
    // Non-numeric counters → no progress bar and no fraction.
    expect(bondInfo({ title: '系列丙', stages: '3', stage: 'two', goal: '目标丙' })).toMatchObject({ progress: '', bar: null });
  });

  it('party panel: 专属 badge, trigger tags, 觉醒 row, personal quest with progress + 待领, and the 合体技 section', () => {
    const ctx = makeCtx();
    const sf = {
      'game/party.json': {
        combo: 2,
        combo_max: 3,
        members: {
          甲: {
            hp: 20,
            max_hp: 24,
            role: 'player',
            equip: { weapon: { name: '武器甲', hit: 1, dmg: '1d10+2', on_miss: { text: '打空词条' }, on_crit: '暴击词条', combo_gain: 'crit', exclusive: true } },
            growth: { max_hp: 4, hit: 1, ac: 0, dmg: 2, traits: ['特性甲'] },
            bond: { title: '系列甲', stages: 3, stage: 2, goal: '目标甲', done: false, pending: ['gear'] },
            skills: [{ name: '招式甲', type: 'attack', dmg: '1d8' }],
          },
          乙: { hp: 18, max_hp: 18, role: 'active', bond: { title: '系列乙', stages: 'x', stage: 1, goal: '目标乙' }, growth: 'bad' },
          丙: { hp: 0, max_hp: 16, role: 'active' },
        },
        combos: [
          { name: '合技一', members: ['甲', '乙'], type: 'attack', cost: 2, dmg: '2d8+4', status: 'staggered', fx: '双刃交错' },
          { name: '合技二', members: ['甲', '乙'], type: 'heal', cost: 3, heal: '2d6+2' },
          { name: '合技三', members: ['乙', '丙'], type: 'control', cost: 1 },
        ],
        enemies: { 敌一: { hp: 30, max_hp: 30 } },
      },
    };
    const { container } = render(<ModePanel panel="party" stateFiles={sf} modePrefs={{}} ctx={ctx} />);
    const equip = within(screen.getAllByRole('list', { name: '装备' })[0]!);
    expect(equip.getByText('★武器甲')).toBeTruthy();
    expect(equip.getByText('专属').className).toBe('kc-badge kc-badge-primary');
    const miss = equip.getByText('打空 打空词条');
    expect(miss.className).toBe('kc-badge kc-badge-warn km-equip-tag');
    expect(miss.getAttribute('title')).toBe('打空：打空词条');
    expect(equip.getByText('暴击 暴击词条').className).toContain('kc-badge-primary');
    expect(equip.getByText('连携 暴击+1格').className).toContain('kc-badge-mode');
    // 觉醒 row: only the member with a growth object.
    const growth = screen.getAllByLabelText('觉醒');
    expect(growth).toHaveLength(1);
    expect(within(growth[0]!).getByText('特性甲').className).toBe('kc-badge kc-badge-mode');
    expect(growth[0]!.textContent).toBe('觉醒特性甲HP+4命中+1伤害+2');
    // Personal quests: progress bar only when counters are numbers.
    const bonds = screen.getAllByLabelText('个人任务');
    expect(bonds).toHaveLength(2);
    expect(within(bonds[0]!).getByText('《系列甲》')).toBeTruthy();
    expect(within(bonds[0]!).getByText('2/3')).toBeTruthy();
    expect(within(bonds[0]!).getByText('目标甲')).toBeTruthy();
    expect(within(bonds[0]!).getByText('待领 专属装备').className).toBe('kc-badge kc-badge-warn');
    const bar = within(bonds[0]!).getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('1');
    expect(bar.getAttribute('aria-valuemax')).toBe('3');
    expect(within(bonds[1]!).queryByRole('progressbar')).toBeNull();
    expect(within(bonds[1]!).getByText('目标乙')).toBeTruthy();
    // Combat order: 上场队友 -> 敌方 -> 合体技.
    const combos = screen.getByRole('list', { name: '合体技' });
    const subs = [...container.querySelectorAll('.km-sub')].map((n) => n.textContent);
    expect(subs).toEqual(['敌方', '合体技 ▰▰▱ 2/3']);
    const rows = within(combos).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.className).toBe('km-combo-row');
    expect(rows[0]!.getAttribute('title')).toBe('双刃交错');
    expect(rows[0]!.textContent).toBe('合技一· 甲×乙· 2格攻击· 2d8+4 · 失衡可发动');
    expect(within(rows[0]!).getByText('可发动').className).toBe('kc-badge kc-badge-primary');
    expect(within(rows[1]!).getByText('需3格').className).toBe('kc-badge kc-badge-tag');
    expect(within(rows[1]!).getByText('· 治疗 2d6+2')).toBeTruthy();
    expect(within(rows[2]!).getByText('缺员:丙').className).toBe('kc-badge kc-badge-warn');
  });

  it('party panel: with none of the new fields the output is unchanged', () => {
    const ctx = makeCtx();
    const base = {
      members: {
        甲: { hp: 20, max_hp: 24, role: 'player', level: 2, equip: { weapon: { name: '武器甲', hit: 1, dmg: '1d6' }, armor: '护甲乙' }, skills: [{ name: '招式甲', dmg: '1d8' }], inventory: ['药水'] },
      },
      enemies: { 敌一: { hp: 30, max_hp: 30 } },
    };
    const { container } = render(<ModePanel panel="party" stateFiles={{ 'game/party.json': base }} modePrefs={{}} ctx={ctx} />);
    expect(container.querySelector('.km-combo-row, .km-bond, .km-growth, .km-equip-tags, .km-form-badge, .km-form-strip, .km-form-avail, .km-skill-derived')).toBeNull();
    expect(screen.queryByText(/专属|★|合体技|觉醒|待领|变身中|可整活变身|派生自/)).toBeNull();
    expect([...container.querySelectorAll('.km-sub')].map((n) => n.textContent)).toEqual(['敌方']);
    const html = container.innerHTML;
    cleanup();
    // Malformed new fields render exactly like missing ones.
    const malformed = {
      ...base,
      combo: 'x',
      combos: 'nope',
      members: { 甲: { ...base.members.甲, growth: [1], bond: 'x', form_state: 'bad', form_kit: 'nope', form_skills: [], transformed_appearance: null } },
    };
    const again = render(<ModePanel panel="party" stateFiles={{ 'game/party.json': malformed }} modePrefs={{}} ctx={ctx} />);
    expect(again.container.innerHTML).toBe(html);
    cleanup();
    // An empty combos list renders no section either.
    const empty = render(<ModePanel panel="party" stateFiles={{ 'game/party.json': { ...base, combo: 2, combos: [] } }} modePrefs={{}} ctx={ctx} />);
    expect(empty.container.innerHTML).toBe(html);
  });

  it('formInfo / skillRows: defensive defaults, kit fields, and derived_from parsing', () => {
    expect(formInfo(undefined)).toBeNull();
    expect(formInfo('x')).toBeNull();
    expect(formInfo({ hp: 20 })).toBeNull();
    expect(formInfo({ form_state: 'base', form_skills: {} })).toBeNull();
    expect(formInfo({ form_state: 'base', form_skills: ['bad'] })).toBeNull();

    // Transformed with full form_kit + transformed_appearance object.
    expect(
      formInfo({
        form_state: 'transformed',
        transformed_appearance: { prompt: '戴着护目镜的巨大绒毛偶', form_key: '形态甲' },
        form_kit: { key: '形态甲', range: 'ranged', passive: '悬浮规避地面效果', theme: '滑稽远程', skill_mode: 'derive_from_base' },
      }),
    ).toEqual({
      transformed: true,
      badge: '形态甲',
      tooltip: '戴着护目镜的巨大绒毛偶',
      range: '远程',
      passive: '悬浮规避地面效果',
      appearance: '戴着护目镜的巨大绒毛偶',
      appearanceSnippet: '戴着护目镜的巨大绒毛偶',
      availableForms: [],
    });

    // Transformed free-text (no form_kit): falls back to 变身中 and clips long appearance snippet.
    const longPrompt = '甲'.repeat(70);
    const freeForm = formInfo({
      form_state: 'transformed',
      transformed_appearance: { prompt: longPrompt },
    });
    expect(freeForm).toMatchObject({
      transformed: true,
      badge: '变身中',
      tooltip: longPrompt,
      range: '',
      passive: '',
      appearance: longPrompt,
    });
    expect(Array.from(freeForm!.appearanceSnippet)).toHaveLength(60);
    expect(freeForm!.appearanceSnippet.endsWith('…')).toBe(true);

    // Transformed without appearance prompt falls back to form_kit.passive for tooltip.
    expect(
      formInfo({
        form_state: 'transformed',
        form_kit: { key: '形态乙', range: 'melee', passive: '近身护盾+1' },
      }),
    ).toMatchObject({ badge: '形态乙', tooltip: '近身护盾+1', range: '近战', passive: '近身护盾+1' });

    // Untransformed with saved form_skills lists non-empty form keys.
    expect(
      formInfo({
        form_state: 'base',
        form_skills: { 形态甲: [], '  ': [], 形态乙: [{ name: '招式' }] },
      }),
    ).toMatchObject({ transformed: false, availableForms: ['形态甲', '形态乙'] });

    // skillRows extracts derived_from cleanly alongside regular skills.
    expect(
      skillRows([
        { name: '变身重击', type: 'attack', dmg: '1d8+2', derived_from: '★基础重击' },
        { name: '普通斩', type: 'attack', dmg: '1d6' },
        '纯文本技能',
      ]),
    ).toEqual([
      { name: '变身重击', type: '攻击', tail: '1d8+2', derivedFrom: '基础重击' },
      { name: '普通斩', type: '攻击', tail: '1d6', derivedFrom: '' },
      { name: '纯文本技能', type: '', tail: '', derivedFrom: '' },
    ]);
  });

  it('party panel: displays transformed mascot form, passive/fallback strip, derived_from skills, and untransformed available forms', () => {
    const ctx = makeCtx();
    const party = {
      members: {
        甲: {
          hp: 24,
          max_hp: 24,
          role: 'player',
          form_state: 'transformed',
          transformed_appearance: { prompt: '圆滚滚的绒毛玩偶造型', form_key: '绒毛偶' },
          form_kit: { key: '绒毛偶', range: 'ranged', passive: '远程弹射不吃反击', theme: '弹跳', skill_mode: 'derive_from_base' },
          form_skills: { 备用形态: [{ name: '备用招' }] },
          skills: [
            { name: '绒毛连弹', type: 'attack', dmg: '1d8+2', derived_from: '主招一' },
            { name: '临时闪避', type: 'guard', guard: true },
          ],
        },
        乙: {
          hp: 18,
          max_hp: 20,
          role: 'active',
          form_state: 'transformed',
          transformed_appearance: { prompt: '套着发光纸箱的神秘身影' },
          form_kit: { range: 'melee' },
          skills: [{ name: '纸箱冲撞', type: 'attack', dmg: '1d6' }],
        },
        丙: {
          hp: 20,
          max_hp: 20,
          role: 'active',
          form_state: 'base',
          form_skills: { 形态甲: [{ name: '招甲' }], 形态乙: [{ name: '招乙' }] },
          skills: [{ name: '基础斩', type: 'attack', dmg: '1d8' }],
        },
        丁: {
          hp: 16,
          max_hp: 16,
          role: 'support',
          skills: [{ name: '后勤支援', type: 'buff', buff: true }],
        },
      },
    };
    const { container } = render(<ModePanel panel="party" stateFiles={{ 'game/party.json': party }} modePrefs={{}} ctx={ctx} />);
    const fighters = [...container.querySelectorAll('.km-fighter')];
    expect(fighters).toHaveLength(4);

    // 1. 甲: transformed with full form_kit + derived_from skill.
    const f1 = within(fighters[0] as HTMLElement);
    expect(fighters[0]!.classList.contains('is-transformed')).toBe(true);
    const badge1 = f1.getByText('🔮 绒毛偶');
    expect(badge1.className).toContain('km-form-badge');
    expect(badge1.getAttribute('title')).toBe('圆滚滚的绒毛玩偶造型');
    const strip1 = f1.getByLabelText('变身形态');
    expect(within(strip1).getByText('远程')).toBeTruthy();
    expect(within(strip1).getByText('远程弹射不吃反击')).toBeTruthy();
    // Does not show untransformed 可整活变身 pill while transformed.
    expect(f1.queryByLabelText('可整活变身')).toBeNull();
    // Derived skill shows indicator + tooltip; regular skill does not.
    const derivedBadge = f1.getByText('派生自 主招一');
    expect(derivedBadge.getAttribute('title')).toBe('由主招式「主招一」派生');
    expect(derivedBadge.closest('li')?.getAttribute('title')).toBe('由主招式「主招一」派生');
    expect(f1.getByText('临时闪避').closest('li')?.getAttribute('title')).toBeNull();

    // 2. 乙: transformed without form_kit.key or passive → fallback badge 变身中 + range & appearance snippet strip.
    const f2 = within(fighters[1] as HTMLElement);
    expect(fighters[1]!.classList.contains('is-transformed')).toBe(true);
    const badge2 = f2.getByText('🔮 变身中');
    expect(badge2.getAttribute('title')).toBe('套着发光纸箱的神秘身影');
    const strip2 = f2.getByLabelText('变身形态');
    expect(within(strip2).getByText('近战')).toBeTruthy();
    expect(within(strip2).getByText('套着发光纸箱的神秘身影')).toBeTruthy();

    // 3. 丙: untransformed with saved form_skills → subtle compact pill.
    const f3 = within(fighters[2] as HTMLElement);
    expect(fighters[2]!.classList.contains('is-transformed')).toBe(false);
    expect(f3.queryByLabelText('变身形态')).toBeNull();
    const avail3 = f3.getByLabelText('可整活变身');
    expect(within(avail3).getByText('可整活变身：形态甲、形态乙')).toBeTruthy();

    // 4. 丁: legacy member without any form fields → no form UI at all.
    expect(fighters[3]!.classList.contains('is-transformed')).toBe(false);
    expect(fighters[3]!.querySelector('.km-form-badge, .km-form-strip, .km-form-avail, .km-skill-derived')).toBeNull();
  });

  it('party panel: phase-aware roster ordering (normal: active only; combat: active -> enemies; camp: active -> reserve)', () => {
    const ctx = makeCtx();
    const party = {
      combo: 2,
      combo_max: 3,
      members: {
        乙: { hp: 18, max_hp: 18, role: 'active' },
        丙: { hp: 20, max_hp: 20, role: 'reserve' },
        甲: { hp: 24, max_hp: 24, role: 'player' },
        丁: { hp: 15, max_hp: 15, role: 'support' },
        旁白: { role: 'narrator' },
      },
      combos: [{ name: '合技一', members: ['甲', '乙'], type: 'attack', cost: 2, dmg: '2d8' }],
      enemies: { 敌一: { hp: 30, max_hp: 30 } },
    };
    const games = (phase: string) => ({ instances: [{ game: 'trpg', active: true, slots: { phase: { value: phase } } }] });

    // 1. 平时 (expedition, no enemies): only 上场队友 (player -> active -> support), no reserve, no narrator, no enemies.
    const { container, rerender } = render(
      <ModePanel panel="party" stateFiles={{ 'game/games.json': games('expedition'), 'game/party.json': { ...party, enemies: {} } }} modePrefs={{}} ctx={ctx} />,
    );
    const activeNames = () => [...screen.getByRole('list', { name: '上场队友' }).querySelectorAll('.km-fighter-head b')].map((n) => n.textContent);
    expect(activeNames()).toEqual(['甲', '乙', '丁']);
    expect(screen.queryByText('丙')).toBeNull();
    expect(screen.queryByText('旁白')).toBeNull();
    expect(screen.queryByRole('list', { name: '敌方' })).toBeNull();
    expect(screen.queryByRole('list', { name: '场下队友（待命）' })).toBeNull();

    // 2. 战斗状态中 (combat): 上场队友 -> 敌方 (before 合体技), reserve hidden.
    rerender(<ModePanel panel="party" stateFiles={{ 'game/games.json': games('combat'), 'game/party.json': party }} modePrefs={{}} ctx={ctx} />);
    expect(activeNames()).toEqual(['甲', '乙', '丁']);
    expect(screen.queryByText('丙')).toBeNull();
    expect(screen.queryByRole('list', { name: '场下队友（待命）' })).toBeNull();
    const combatLists = [...container.querySelectorAll('ul.km-list')].map((el) => el.getAttribute('aria-label'));
    expect(combatLists).toEqual(['上场队友', '敌方', '合体技']);
    expect([...container.querySelectorAll('.km-sub')].map((n) => n.textContent)).toEqual(['敌方', '合体技 ▰▰▱ 2/3']);

    // 3. 休整阶段 (camp): 上场队友 -> 场下队友（待命） (before 合体技), enemies hidden even if stale entries remain.
    rerender(<ModePanel panel="party" stateFiles={{ 'game/games.json': games('camp'), 'game/party.json': party }} modePrefs={{}} ctx={ctx} />);
    expect(activeNames()).toEqual(['甲', '乙', '丁']);
    expect([...screen.getByRole('list', { name: '场下队友（待命）' }).querySelectorAll('.km-fighter-head b')].map((n) => n.textContent)).toEqual(['丙']);
    expect(screen.queryByRole('list', { name: '敌方' })).toBeNull();
    expect(screen.queryByText('敌一')).toBeNull();
    const campLists = [...container.querySelectorAll('ul.km-list')].map((el) => el.getAttribute('aria-label'));
    expect(campLists).toEqual(['上场队友', '场下队友（待命）', '合体技']);
    expect([...container.querySelectorAll('.km-sub')].map((n) => n.textContent)).toEqual(['场下队友（待命）', '合体技 ▰▰▱ 2/3']);

    // 4. 休整阶段 with named base in game/base.json: uses base.name in reserve heading & aria-label.
    rerender(
      <ModePanel
        panel="party"
        stateFiles={{ 'game/games.json': games('camp'), 'game/party.json': party, 'game/base.json': { name: '老茶馆' } }}
        modePrefs={{}}
        ctx={ctx}
      />,
    );
    expect([...screen.getByRole('list', { name: '场下队友（老茶馆）' }).querySelectorAll('.km-fighter-head b')].map((n) => n.textContent)).toEqual(['丙']);
    expect([...container.querySelectorAll('.km-sub')].map((n) => n.textContent)).toEqual(['场下队友（老茶馆）', '合体技 ▰▰▱ 2/3']);

    // Blank / malformed base.name falls back to 待命.
    rerender(
      <ModePanel
        panel="party"
        stateFiles={{ 'game/games.json': games('camp'), 'game/party.json': party, 'game/base.json': { name: '   ' } }}
        modePrefs={{}}
        ctx={ctx}
      />,
    );
    expect(screen.getByRole('list', { name: '场下队友（待命）' })).toBeTruthy();
  });

  it('party panel: uses genre-neutral 资金 label for fighter gold attribute', () => {
    const ctx = makeCtx();
    const party = { members: { 甲: { hp: 20, max_hp: 20, role: 'player', gold: 150 } } };
    const { container } = render(<ModePanel panel="party" stateFiles={{ 'game/party.json': party }} modePrefs={{}} ctx={ctx} />);
    const attrs = [...container.querySelectorAll('.km-attr')].map((el) => el.textContent?.trim());
    expect(attrs).toContain('资金 150');
    expect(container.textContent).not.toContain('金币');
  });

  it('roster renders prompt descriptions, fusion/transformed badges, and edits ref/prompt/fusion via sheet & character picker', async () => {
    const listCharacters = vi.fn(async () => [
      { name: '林霜', ref: 'lin_shuang', aliases: ['霜儿', '雪狐'], group: '奇幻组', avatar: 'characters/fantasy/lin.png' },
      { name: '陈默', ref: 'chen_mo', aliases: ['阿默'], group: '都市组', avatar: 'characters/city/chen.png' },
    ]);
    const updateRoster = vi.fn(async () => ({ session_id: 's1', key: '角色甲', member: {} }));
    const ctx = makeCtx({ listCharacters, updateRoster });
    const sf = {
      'game/roster.json': {
        members: {
          角色甲: {
            name: '角色甲',
            role: '主角',
            fusion: true,
            base_appearance: { ref: 'chen_mo', prompt: '保留狐耳与九尾形态，借用清冷五官与银白长发' },
            tags: ['银发', '斗篷'],
          },
          角色乙: {
            name: '角色乙',
            form_state: 'transformed',
            base_appearance: { ref: 'lin_shuang', prompt: '青色布衣游侠' },
            transformed_appearance: { ref: 'lin_shuang', prompt: '身披羽衣的云端白鹤形态' },
          },
        },
      },
    };

    render(<ModePanel panel="roster" stateFiles={sf} modePrefs={{}} ctx={ctx} />);
    await act(async () => {});

    // Fusion badge + base prompt for 角色甲; transformed badge + transformed prompt + base note for 角色乙.
    expect(screen.getByText('🔀 融合')).toBeTruthy();
    expect(screen.getByText('保留狐耳与九尾形态，借用清冷五官与银白长发')).toBeTruthy();
    expect(screen.getByText('🔮 已变身')).toBeTruthy();
    expect(screen.getByText('身披羽衣的云端白鹤形态')).toBeTruthy();
    expect(screen.getByText('原形态：青色布衣游侠')).toBeTruthy();

    // Open edit sheet for 角色甲: lazy-loads character picker with data-sheet-no-drag.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '编辑 角色甲' }));
    });
    expect(listCharacters).toHaveBeenCalledTimes(1);
    const picker = screen.getByTestId('roster-char-picker');
    expect(picker.hasAttribute('data-sheet-no-drag')).toBe(true);

    // Filter character picker by alias and pick 林霜.
    const searchInput = screen.getByLabelText('搜索已登记参考角色…');
    fireEvent.change(searchInput, { target: { value: '雪狐' } });
    expect(within(picker).getByText('林霜')).toBeTruthy();
    expect(within(picker).queryByText('陈默')).toBeNull();
    fireEvent.click(within(picker).getByRole('button', { name: /林霜/ }));
    expect((screen.getByLabelText('参考图绑定') as HTMLInputElement).value).toBe('lin_shuang');

    // Clear ref then type custom ref, uncheck fusion, update prompt, and save.
    fireEvent.click(screen.getByRole('button', { name: '清空' }));
    expect((screen.getByLabelText('参考图绑定') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('参考图绑定'), { target: { value: '  lin_shuang  ' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /融合形象/ }));
    fireEvent.change(screen.getByLabelText('形象与设定'), { target: { value: '换上深蓝礼服与银饰' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
    });
    expect(updateRoster).toHaveBeenCalledWith({
      key: '角色甲',
      ref: 'lin_shuang',
      prompt: '换上深蓝礼服与银饰',
      fusion: false,
    });
    // Sheet closes on success.
    expect(screen.queryByTestId('roster-edit-form')).toBeNull();

    // Open edit sheet for transformed member 角色乙: also includes transform_prompt textarea and shows inline error on failure.
    updateRoster.mockRejectedValueOnce(new Error('network fail'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '编辑 角色乙' }));
    });
    const tfInput = screen.getByLabelText('当前变身形态设定') as HTMLTextAreaElement;
    expect(tfInput.value).toBe('身披羽衣的云端白鹤形态');
    fireEvent.change(tfInput, { target: { value: '金翼神鸟形态' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
    });
    expect(updateRoster).toHaveBeenLastCalledWith({
      key: '角色乙',
      ref: 'lin_shuang',
      prompt: '青色布衣游侠',
      fusion: false,
      transform_prompt: '金翼神鸟形态',
    });
    // Stays open with inline error on failure.
    expect(screen.getByRole('alert').textContent).toContain('保存角色设定失败');
    expect(screen.getByTestId('roster-edit-form')).toBeTruthy();
  });

  it('roster casting policy shows effective precedence and supports preset/custom save as default vs session-only', async () => {
    const setModeDefaults = vi.fn(async () => ({ casting_policy: 'ask_all' }));
    const setModePrefs = vi.fn(async () => {});
    const ctx = makeCtx({ setModeDefaults, setModePrefs });
    const sf = { 'game/roster.json': { members: {} } };

    // Falls back to modeDefaults.story_theater.casting_policy when modePrefs omits it.
    const { rerender } = render(
      <ModePanel
        panel="roster"
        stateFiles={sf}
        modePrefs={{}}
        modeDefaults={{ story_theater: { casting_policy: 'auto_random' } }}
        ctx={ctx}
      />,
    );
    const card = screen.getByTestId('casting-policy-card');
    expect(within(card).getByText('自由随机分配')).toBeTruthy();

    // Open editor, choose ask_all, and click "保存并设为默认" -> calls BOTH setModeDefaults and setModePrefs.
    fireEvent.click(within(card).getByRole('button', { name: '编辑策略' }));
    fireEvent.click(within(card).getByRole('button', { name: '全员新角钦定' }));
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: '保存并设为默认' }));
    });
    expect(setModeDefaults).toHaveBeenCalledWith('story_theater', { casting_policy: 'ask_all' });
    expect(setModePrefs).toHaveBeenCalledWith({ casting_policy: 'ask_all' });
    expect(within(card).getByRole('status').textContent).toContain('已设为默认并应用于本局');

    // Rerender with custom session override -> displays custom badge & snippet.
    rerender(
      <ModePanel
        panel="roster"
        stateFiles={sf}
        modePrefs={{ casting_policy: '主角团由我钦定，其余随机分配' }}
        modeDefaults={{ story_theater: { casting_policy: 'ask_all' } }}
        ctx={ctx}
      />,
    );
    expect(within(card).getByText('自定义')).toBeTruthy();
    expect(within(card).getByText('主角团由我钦定，其余随机分配')).toBeTruthy();

    // Edit custom policy and click "仅应用于本局" -> calls ONLY setModePrefs (NOT setModeDefaults).
    setModeDefaults.mockClear();
    setModePrefs.mockClear();
    fireEvent.click(within(card).getByRole('button', { name: '编辑策略' }));
    const ta = within(card).getByLabelText('自定义选角策略') as HTMLTextAreaElement;
    expect(ta.value).toBe('主角团由我钦定，其余随机分配');
    fireEvent.change(ta, { target: { value: '仅核心反派与主角弹候选卡' } });
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: '仅应用于本局' }));
    });
    expect(setModeDefaults).not.toHaveBeenCalled();
    expect(setModePrefs).toHaveBeenCalledWith({ casting_policy: '仅核心反派与主角弹候选卡' });
    expect(within(card).getByRole('status').textContent).toContain('已应用于本局');

    // Error handling shows inline alert instead of throwing.
    setModePrefs.mockRejectedValueOnce(new Error('rpc error'));
    fireEvent.click(within(card).getByRole('button', { name: '编辑策略' }));
    fireEvent.click(within(card).getByRole('button', { name: '仅手动触发' }));
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: '仅应用于本局' }));
    });
    expect(within(card).getByRole('alert').textContent).toContain('选角策略保存失败');
  });

  it('malformed state never crashes; memory → null', () => {
    const ctx = makeCtx();
    for (const panel of ['mistakes', 'roster', 'party', 'dex', 'lesson', 'travel', 'memory', 'bogus']) {
      for (const sf of [{}, { 'game/roster.json': 5, 'game/party.json': { members: [1, 2] }, 'game/pokemon.json': 'x', 'game/lesson.json': { segments: 'no' }, 'game/travel.json': { order: {} } }]) {
        const { unmount } = render(<ModePanel panel={panel} stateFiles={sf as Record<string, unknown>} modePrefs={{}} ctx={ctx} />);
        unmount();
      }
    }
  });
});

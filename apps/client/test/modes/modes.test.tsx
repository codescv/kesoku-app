import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { Segment } from '@kesoku/protocol';
import { GalgameStage, ModePanel, PeekSheet, latestCg, latestTurn, previewLine } from '../../src/features/modes';
import type { ChatItem } from '../../src/lib/types';
import { useStore } from '../../src/lib/store';
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
    expect(screen.getByText('中文 ▸')).toBeTruthy();
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

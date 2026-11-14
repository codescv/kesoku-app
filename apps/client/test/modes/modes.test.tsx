import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Segment } from '@kesoku/protocol';
import { GalgameStage, ModePanel, PeekSheet, previewLine } from '../../src/features/modes';
import type { ChatItem } from '../../src/lib/types';
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

  it('creates no audio and resolves no voice before the tap', async () => {
    const audioSpy = vi.spyOn(window, 'Audio');
    const { ctx } = stage();
    await act(async () => {});
    expect(document.querySelector('audio')).toBeNull();
    expect(audioSpy).not.toHaveBeenCalled();
    expect(ctx.resolveMedia).not.toHaveBeenCalledWith(expect.objectContaining({ object: 'voice/1.ogg' }));
    expect(screen.getByRole('button', { name: '播放语音' })).toBeTruthy();
    audioSpy.mockRestore();
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
    render(<PeekSheet entry={glossary.multiscale} glossary={glossary} onClose={onClose} ctx={ctx} />);
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
    fireEvent.click(screen.getByRole('button', { name: /问飞鸟/ }));
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

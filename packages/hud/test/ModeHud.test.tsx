import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { MemoryPolicy, ModeId } from '@kesoku/protocol';
import { HUD_PANELS, ModeHud, PolicyBadge, formatRemaining, type ModeHudProps } from '../src';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup(modeId: ModeId, stateFiles: Record<string, unknown> = {}, extra: Partial<ModeHudProps> = {}) {
  const onPolicyChange = vi.fn<(p: MemoryPolicy) => void>();
  const onPrefsChange = vi.fn<(p: Record<string, unknown>) => void>();
  const onOpenPanel = vi.fn<ModeHudProps['onOpenPanel']>();
  const utils = render(
    <ModeHud
      modeId={modeId}
      stateFiles={stateFiles}
      modePrefs={{}}
      policy="confirm_only"
      onPolicyChange={onPolicyChange}
      onPrefsChange={onPrefsChange}
      onOpenPanel={onOpenPanel}
      {...extra}
    />,
  );
  return { ...utils, onPolicyChange, onPrefsChange, onOpenPanel };
}

describe('ModeHud', () => {
  it('renders nothing in chat mode', () => {
    const { container } = setup('chat');
    expect(container.innerHTML).toBe('');
  });

  it('exposes a default panel per mode', () => {
    expect(HUD_PANELS.trpg).toBe('party');
    expect(HUD_PANELS.pokemon_assistant).toBe('dex');
    expect(HUD_PANELS.story_theater).toBe('roster');
    expect(HUD_PANELS.jp_classroom).toBe('lesson');
    expect(HUD_PANELS.travel_companion).toBe('travel');
  });

  it('memory policy badge toggles an inline segmented control', () => {
    const { onPolicyChange } = setup('translator');
    const badge = screen.getByRole('button', { name: /记忆：确认/ });
    expect(badge.querySelector('[data-ui-icon="policy-confirm"]')).toBeTruthy();
    expect(badge.textContent).not.toMatch(/[💡✅🔕]/u);
    expect(screen.queryByRole('radiogroup')).toBeNull();
    fireEvent.click(badge);
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['自动', '确认', '忽略']);
    fireEvent.click(screen.getByRole('radio', { name: '忽略' }));
    expect(onPolicyChange).toHaveBeenCalledWith('isolated');
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('badge label follows the policy', () => {
    const fn = vi.fn();
    const { rerender } = render(<PolicyBadge policy="full" onPolicyChange={fn} />);
    expect(screen.getByRole('button').textContent).toContain('记忆：自动');
    expect(screen.getByRole('button').querySelector('[data-ui-icon="policy-full"]')).toBeTruthy();
    rerender(<PolicyBadge policy="isolated" onPolicyChange={fn} />);
    expect(screen.getByRole('button').textContent).toContain('记忆：忽略');
    expect(screen.getByRole('button').querySelector('[data-ui-icon="policy-isolated"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByRole('radio', { name: '忽略' }));
    expect(fn).not.toHaveBeenCalled(); // re-picking the current policy is a no-op
  });

  it('galgame: location · clock and timed marks expire client-side', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-14T08:00:00Z'));
    const now = Date.now() / 1000;
    setup('galgame', {
      'game/scene.json': {
        location: '江之岛海边',
        clock: '2026-11-14 17:42',
        marks: [
          { id: 'm1', text: '猫耳发箍', until_type: 'time', expires_at: now + 12 * 60 },
          { id: 'm2', text: '冰淇淋', until_type: 'time', expires_at: now + 5 },
          { id: 'm3', text: '牵手', until_type: 'turns', remaining_turns: 2 },
          { id: 'm4', text: '常驻标记' },
        ],
      },
    });
    expect(screen.getByText('江之岛海边 · 17:42')).toBeTruthy();
    expect(screen.getByText('猫耳发箍')).toBeTruthy();
    expect(screen.getByText('12m')).toBeTruthy();
    expect(screen.getByText('冰淇淋')).toBeTruthy();
    expect(screen.getByText('剩余2轮')).toBeTruthy();
    expect(screen.queryByText('常驻标记')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.queryByText('冰淇淋')).toBeNull();
    expect(screen.getByText('猫耳发箍')).toBeTruthy();
  });

  it('jp_classroom: lesson progress and mistakes button', () => {
    const { onOpenPanel } = setup('jp_classroom', {
      'game/lesson.json': { book: '初级', lesson: 21, segment_index: 4, segments: new Array(9).fill({}), due_mistakes: 2 },
    });
    expect(screen.getByText('初级 第21课 · 5/9')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /错题 2/ }));
    expect(onOpenPanel).toHaveBeenCalledWith('mistakes');
    fireEvent.click(screen.getByText('初级 第21课 · 5/9'));
    expect(onOpenPanel).toHaveBeenCalledWith('lesson');
  });

  it('travel_companion: dietary chip opens memory', () => {
    const { onOpenPanel } = setup('travel_companion', {
      'game/travel.json': { city: '涩谷', dietary: ['乳糖不耐', { label: '微蛋过敏' }, '不辣'], order: [{ name_local: '焼き鳥', qty: 2 }] },
    });
    fireEvent.click(screen.getByRole('button', { name: /已启用忌口：乳糖不耐 · 微蛋过敏 · 不辣/ }));
    expect(onOpenPanel).toHaveBeenCalledWith('memory');
    fireEvent.click(screen.getByRole('button', { name: /点单 1/ }));
    expect(onOpenPanel).toHaveBeenCalledWith('travel');
  });

  it('translator: swap and quick pills write mode prefs', () => {
    const { onPrefsChange } = setup('translator', {}, { modePrefs: { src_lang: 'ja', dst_lang: 'zh' } });
    const pair = screen.getByRole('group', { name: '语言对' });
    expect(pair.textContent).toBe('日语简中');
    expect(pair.querySelector('[data-ui-icon="swap"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '互换语言' }));
    expect(onPrefsChange).toHaveBeenLastCalledWith({ src_lang: 'zh', dst_lang: 'ja' });
    fireEvent.click(screen.getByRole('button', { name: '英语' }));
    expect(onPrefsChange).toHaveBeenLastCalledWith({ src_lang: 'en', dst_lang: 'zh' });
    expect(screen.getByRole('button', { name: '日语' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('trpg: world slot, squad & boss HP strip, collapsible', () => {
    const { onOpenPanel } = setup('trpg', {
      'game/games.json': [{ id: 'trpg#1', game: 'trpg', active: true, slots: { world: '夜之城 · 荒坂塔潜入' } }],
      'game/party.json': {
        members: {
          小张: { hp: 28, max_hp: 28, role: 'player', status: [] },
          飞鸟: { hp: 22, max_hp: 24, role: 'active', status: ['🎯锁定'] },
          贺喜: { hp: 26, max_hp: 26, role: 'active' },
          旁白: { role: 'narrator' },
        },
        enemies: { boss: { name: 'Boss 重装机甲', hp: 45, max_hp: 80, status: [{ name: '🌋蓄力AOE' }] } },
      },
    });
    expect(screen.getByText('夜之城 · 荒坂塔潜入')).toBeTruthy();
    expect(screen.getAllByRole('meter')).toHaveLength(4);
    expect(screen.getByText('🌋蓄力AOE')).toBeTruthy();
    expect(screen.queryByText('旁白')).toBeNull();
    fireEvent.click(screen.getByText('飞鸟'));
    expect(onOpenPanel).toHaveBeenCalledWith('party');
    fireEvent.click(screen.getByRole('button', { name: '收起小队' }));
    expect(screen.queryAllByRole('meter')).toHaveLength(0);
    expect(screen.getByRole('button', { name: '展开小队' })).toBeTruthy();
  });

  it('pokemon_assistant: version switch and pinned chip', () => {
    const { onPrefsChange, onOpenPanel } = setup('pokemon_assistant', {
      'game/pokemon.json': { game_version: 'za', pinned_context: '快龙' },
    });
    const ver = screen.getByRole('button', { name: /作品版本：传说 Z-A/ });
    fireEvent.click(ver);
    fireEvent.click(screen.getByRole('button', { name: '朱／紫 SV' }));
    expect(onPrefsChange).toHaveBeenCalledWith({ game_version: 'sv' });
    fireEvent.click(screen.getByTitle('展开图鉴'));
    expect(onOpenPanel).toHaveBeenCalledWith('dex');
    fireEvent.click(screen.getByRole('button', { name: '解除锁定 快龙' }));
    expect(onPrefsChange).toHaveBeenCalledWith({ pinned_context: null });
  });

  it('pokemon_assistant: mode prefs win over pokemon.json; default is SV', () => {
    setup('pokemon_assistant', { 'game/pokemon.json': { game_version: 'za', pinned_context: '快龙' } }, { modePrefs: { game_version: 'sv', pinned_context: null } });
    expect(screen.getByRole('button', { name: /作品版本：朱／紫 SV/ })).toBeTruthy();
    expect(screen.queryByText(/快龙/)).toBeNull();
    cleanup();
    setup('pokemon_assistant');
    expect(screen.getByRole('button', { name: /作品版本：朱／紫 SV/ })).toBeTruthy();
  });

  it('story_theater: chapter progress and roster button', () => {
    const { onOpenPanel } = setup('story_theater', {
      'game/source.json': { book_title: '黑神话：悟空', chapter_idx: 3, chapter_title: '第三回', chunks: ['a', 'b', 'c', 'd'], chunk_index: 1 },
      'game/roster.json': { members: { a: {}, b: {}, c: {}, d: {} } },
    });
    expect(screen.getByText(/黑神话：悟空 · 第三回/)).toBeTruthy();
    expect(screen.getByText(/片段 2\/4/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /定妆表 \(4\)/ }));
    expect(onOpenPanel).toHaveBeenCalledWith('roster');
  });

  it('malformed state never crashes and keeps the policy badge', () => {
    const garbage: Record<string, unknown> = {
      'game/games.json': 'nope',
      'game/scene.json': { location: { nested: true }, clock: 5, marks: 'bad' },
      'game/lesson.json': { book: 7, lesson: 'x', segments: {}, segment_index: 'z', mistakes: 'n' },
      'game/travel.json': { dietary: 'all', order: 3 },
      'game/translator.json': [],
      'game/party.json': { members: 5, enemies: [null, 3, { hp: 'a' }] },
      'game/pokemon.json': { game_version: 42, pinned_context: {} },
      'game/source.json': { chunks: 'x', chunk_index: {} },
      'game/roster.json': 'y',
    };
    const modes: ModeId[] = ['galgame', 'jp_classroom', 'travel_companion', 'translator', 'trpg', 'pokemon_assistant', 'story_theater'];
    for (const m of modes) {
      setup(m, garbage);
      expect(screen.getByRole('button', { name: /记忆：确认/ })).toBeTruthy();
      cleanup();
      setup(m, null as unknown as Record<string, unknown>, { modePrefs: null as unknown as Record<string, unknown> });
      expect(screen.getByRole('button', { name: /记忆：确认/ })).toBeTruthy();
      cleanup();
    }
  });

  it('formats remaining time compactly', () => {
    expect(formatRemaining(45_000)).toBe('45s');
    expect(formatRemaining(12 * 60_000)).toBe('12m');
    expect(formatRemaining(65 * 60_000)).toBe('1h05m');
  });
});

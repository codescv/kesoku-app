import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { MemoryPolicy, ModeId } from '@kesoku/protocol';
import { HUD_PANELS, ModeHud, PolicyBadge, comboGauge, formatRemaining, partyCombos, type ModeHudProps } from '../src';
import { setUiLanguage } from '@kesoku/ui';
import { beforeAll as __beforeAll, afterAll as __afterAll } from 'vitest';

__beforeAll(() => setUiLanguage('zh-CN'));
__afterAll(() => setUiLanguage('system'));

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
    const mistakesBtn = screen.getByRole('button', { name: /错题 2/ });
    expect(mistakesBtn.className).toContain('has-count');
    expect(mistakesBtn.querySelector('.k-hud-mistakes-label')?.textContent).toBe('错题');
    fireEvent.click(mistakesBtn);
    expect(onOpenPanel).toHaveBeenCalledWith('mistakes');
    fireEvent.click(screen.getByText('初级 第21课 · 5/9'));
    expect(onOpenPanel).toHaveBeenCalledWith('lesson');
  });

  it('compact mobile spans: PolicyBadge has .k-hud-policy-prefix and LessonHud without count omits .has-count', () => {
    setup('jp_classroom', {
      'game/lesson.json': { book: '初级', lesson: 5 },
    });
    const policyBtn = screen.getByRole('button', { name: /记忆：确认/ });
    expect(policyBtn.querySelector('.k-hud-policy-prefix')?.textContent).toBe('记忆：确认');
    expect(policyBtn.querySelector('.k-hud-policy-short')?.textContent).toBe('确认');
    const mistakesBtn = screen.getByRole('button', { name: '错题' });
    expect(mistakesBtn.className).not.toContain('has-count');
    expect(mistakesBtn.querySelector('.k-hud-mistakes-label')?.textContent).toBe('错题');
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

  const TRPG_FILES: Record<string, unknown> = {
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
  };

  it('trpg (mobile / tablet): single compact row — world chip + 小队 button + badge, zero live HP bars', () => {
    const { container, onOpenPanel } = setup('trpg', TRPG_FILES);
    const hud = container.querySelector('.k-hud[data-mode="trpg"]')!;
    // Strictly one row: no squad strip, no collapse toggle, no inline meters.
    expect(hud.querySelectorAll('.k-hud-row')).toHaveLength(1);
    expect(hud.querySelector('.k-hud-squad, .k-hud-squad-mini, .k-hud-collapse, .k-hud-member, .k-hud-boss')).toBeNull();
    expect(screen.queryAllByRole('meter')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /收起小队|展开小队/ })).toBeNull();
    // World chip truncates on one line and carries the full text as a tooltip.
    const world = screen.getByText('夜之城 · 荒坂塔潜入');
    expect(world.classList.contains('k-hud-ellipsis')).toBe(true);
    expect(world.closest('.k-hud-world')?.getAttribute('title')).toBe('夜之城 · 荒坂塔潜入');
    // HP values are not shown inline any more.
    expect(screen.queryByText(/HP\s*\d/)).toBeNull();
    expect(screen.queryByText('飞鸟')).toBeNull();
    // 小队 button: combat member count (narrator excluded) + enemy indicator, opens the party panel.
    const btn = screen.getByTestId('trpg-party-btn');
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.textContent).toContain('小队 (3)');
    expect(btn.querySelector('[data-ui-icon="shield"]')).toBeTruthy();
    expect(screen.getByTestId('trpg-party-enemies').textContent).toBe('1');
    expect(btn.textContent).not.toMatch(/[⚔🛡]/u);
    fireEvent.click(btn);
    expect(onOpenPanel).toHaveBeenCalledWith('party');
    // Policy badge stays on the same row.
    expect(hud.querySelector('.k-hud-row')!.contains(screen.getByRole('button', { name: /记忆：确认/ }))).toBe(true);
  });

  it('trpg: 小队·装备 label without party data; button still opens the party panel', () => {
    const { onOpenPanel } = setup('trpg', { 'game/games.json': [{ id: 'trpg#1', game: 'trpg', active: true, slots: { scenario: '放学后·校园怪谈调查部' } }] });
    expect(screen.getByText('放学后·校园怪谈调查部')).toBeTruthy();
    const btn = screen.getByTestId('trpg-party-btn');
    expect(btn.textContent).toContain('小队·装备');
    expect(screen.queryByTestId('trpg-party-enemies')).toBeNull();
    fireEvent.click(btn);
    expect(onOpenPanel).toHaveBeenCalledWith('party');
  });

  it('trpg (desktop, right sidebar visible): only world chip + policy badge', () => {
    const { container } = setup('trpg', TRPG_FILES, { inspectorVisible: true });
    expect(screen.getByText('夜之城 · 荒坂塔潜入')).toBeTruthy();
    expect(screen.getByRole('button', { name: /记忆：确认/ })).toBeTruthy();
    expect(screen.queryByTestId('trpg-party-btn')).toBeNull();
    expect(screen.queryAllByRole('meter')).toHaveLength(0);
    expect(container.querySelector('.k-hud-squad, .k-hud-collapse, .k-hud-squad-mini')).toBeNull();
    expect(container.querySelectorAll('.k-hud-row')).toHaveLength(1);
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

  const COMBO_PARTY = {
    combo: 2,
    combo_max: 3,
    members: {
      甲: { hp: 20, max_hp: 20, role: 'player' },
      乙: { hp: 15, max_hp: 18, role: 'active' },
      丙: { hp: 0, max_hp: 16, role: 'active' },
    },
    combos: [
      { name: '合技一', members: ['甲', '乙'], type: 'attack', cost: 2, dmg: '2d8+4', aoe: false, status: 'staggered', heal: '', fx: '双刃交错' },
      { name: '合技二', members: ['甲', '乙'], type: 'heal', cost: 3, heal: '2d6+2' },
      { name: '合技三', members: ['乙', '丙', '丁'], type: 'control', cost: 1, dmg: '1d6', aoe: true, status: 'exposed' },
    ],
  };

  it('partyCombos: ready / need / missing (absent, off-field role, hp ≤ 0) and effect tails', () => {
    expect(comboGauge(COMBO_PARTY)).toEqual({ value: 2, max: 3 });
    const [a, b, c] = partyCombos(COMBO_PARTY);
    expect(a).toMatchObject({ name: '合技一', members: ['甲', '乙'], cost: 2, type: 'attack', tail: '2d8+4 · 失衡', fx: '双刃交错', state: 'ready', missing: [] });
    expect(b).toMatchObject({ name: '合技二', cost: 3, type: 'heal', tail: '治疗 2d6+2', state: 'need', missing: [] });
    expect(c).toMatchObject({ name: '合技三', tail: '1d6 · 群体 · 破绽', state: 'missing', missing: ['丙', '丁'] });
    // Roles outside player / active / support count as missing; support is on the field.
    const roles = { ...COMBO_PARTY, members: { 甲: { role: 'narrator' }, 乙: { role: 'support' } } };
    expect(partyCombos(roles)[0]).toMatchObject({ state: 'missing', missing: ['甲'] });
    const sup = { ...COMBO_PARTY, members: { 甲: { role: 'player' }, 乙: { role: 'support', hp: 'x' } } };
    expect(partyCombos(sup)[0]!.state).toBe('ready');
  });

  it('comboGauge / partyCombos tolerate malformed input', () => {
    expect(comboGauge(undefined)).toEqual({ value: 0, max: 3 });
    expect(comboGauge({ combo: 9, combo_max: 3 })).toEqual({ value: 3, max: 3 });
    expect(comboGauge({ combo: -2, combo_max: 'x' })).toEqual({ value: 0, max: 3 });
    expect(comboGauge({ combo: '1', combo_max: 0 })).toEqual({ value: 1, max: 3 });
    expect(partyCombos(undefined)).toEqual([]);
    expect(partyCombos({ combos: 'nope' })).toEqual([]);
    expect(partyCombos({ combos: { name: 'x' } })).toEqual([]);
    const list = partyCombos({
      combo: 3,
      members: { 甲: { role: 'player' }, 乙: { role: 'active' } },
      combos: [null, 5, { name: '无成员' }, { name: '坏成员', members: 'x' }, { name: '混入数字', members: ['甲', 7] }, { members: ['甲', '乙'] }, { name: '默认消耗', members: ['甲', '乙'], cost: 'big' }],
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: '默认消耗', cost: 2, type: '', tail: '', state: 'ready', missing: [] });
    expect(list[0]!.fx).toBeUndefined();
  });

  it('trpg: combo pill sits inside the 小队 button (still one row); is-ready when a combo can fire', () => {
    const files = { 'game/games.json': TRPG_FILES['game/games.json'], 'game/party.json': COMBO_PARTY };
    const { container } = setup('trpg', files);
    expect(container.querySelectorAll('.k-hud-row')).toHaveLength(1);
    const pill = screen.getByTestId('trpg-party-combo');
    expect(screen.getByTestId('trpg-party-btn').contains(pill)).toBe(true);
    expect(pill.textContent).toBe('2/3');
    expect(pill.classList.contains('is-ready')).toBe(true);
    expect(pill.getAttribute('aria-label')).toBe('连携槽 2/3，1 个合体技可发动');
    expect(screen.queryAllByRole('meter')).toHaveLength(0);
    cleanup();
    // Gauge > 0 but nothing can fire → plain pill.
    setup('trpg', { 'game/party.json': { ...COMBO_PARTY, combo: 1 } });
    const plain = screen.getByTestId('trpg-party-combo');
    expect(plain.classList.contains('is-ready')).toBe(false);
    expect(plain.getAttribute('aria-label')).toBe('连携槽 1/3');
    cleanup();
    // Empty gauge with enemies on the field still shows 0/max (existing fixture has no combo fields).
    setup('trpg', TRPG_FILES);
    expect(screen.getByTestId('trpg-party-combo').textContent).toBe('0/3');
    cleanup();
    // Empty gauge, no enemies → no pill.
    setup('trpg', { 'game/party.json': { members: COMBO_PARTY.members } });
    expect(screen.queryByTestId('trpg-party-combo')).toBeNull();
    cleanup();
    // Inherits !inspectorVisible: the desktop sidebar hides the whole button, pill included.
    const desk = setup('trpg', files, { inspectorVisible: true });
    expect(screen.queryByTestId('trpg-party-combo')).toBeNull();
    expect(desk.container.querySelectorAll('.k-hud-row')).toHaveLength(1);
  });

  it('trpg: camp phase hides enemy indicator even if stale enemies exist', () => {
    const campFiles = {
      'game/games.json': { instances: [{ game: 'trpg', active: true, slots: { world: '遗迹', phase: { value: 'camp' } } }] },
      'game/party.json': TRPG_FILES['game/party.json'],
    };
    setup('trpg', campFiles);
    expect(screen.queryByTestId('trpg-party-enemies')).toBeNull();
    expect(screen.queryByTestId('trpg-party-combo')).toBeNull();
  });

  it('formats remaining time compactly', () => {
    expect(formatRemaining(45_000)).toBe('45s');
    expect(formatRemaining(12 * 60_000)).toBe('12m');
    expect(formatRemaining(65 * 60_000)).toBe('1h05m');
  });
});

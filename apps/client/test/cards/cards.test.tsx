import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { CARD_KINDS, GenericCardSafe, getCard } from '../../src/features/cards';
import { makeCtx } from './ctx';

function renderKind(kind: string, data: Record<string, unknown>, ctx = makeCtx()) {
  const Card = getCard(kind) ?? GenericCardSafe;
  const r = render(<Card data={data} ctx={ctx} />);
  return { ...r, ctx };
}

const ORDER = {
  banner_local: '乳製品・卵・辛いものを抜いていただけますか',
  banner_zh: '请去除乳制品、鸡蛋及辛辣调料',
  items: [
    { name_local: '焼き鳥 塩盛り合わせ', qty: 1, photo_index: 1, bbox: [0.6, 0.05, 0.3, 0.2], name_zh: '炭火烤鸡串拼盘' },
    { name_local: '厚切り牛タン塩焼き', qty: 2, photo_index: 2, bbox: [0.05, 0.4, 0.3, 0.2] },
  ],
  photos: ['https://img.test/menu1.jpg', 'https://img.test/menu2.jpg'],
};

describe('card registry', () => {
  it('registers every kind and returns undefined for unknown', () => {
    for (const k of ['order_card', 'direction_card', 'menu_review', 'translation', 'breakdown', 'lesson_card', 'grading', 'pokemon_dex', 'pkmn_move_wiki', 'pkmn_matchup']) {
      expect(CARD_KINDS).toContain(k);
      expect(getCard(k)).toBeTypeOf('function');
    }
    expect(getCard('nope')).toBeUndefined();
    expect(getCard('constructor')).toBeUndefined();
  });

  it('GenericCard renders title + key/value bullets', () => {
    renderKind('weird_kind', { title: '自定义', city: '东京', tags: ['a', 'b'] });
    expect(screen.getByText('自定义')).toBeTruthy();
    expect(screen.getByText('东京')).toBeTruthy();
    expect(screen.getByText('a、b')).toBeTruthy();
  });

  it('malformed data never crashes any card', () => {
    const junk = [{}, { items: 'x', stats: 5, matchup: [1], name: 3, glossary: 'g', picks: {}, pills: [null] }, { items: [null, 1, 'a', { bbox: 'bad' }] }];
    for (const k of CARD_KINDS) {
      for (const d of junk) {
        const { unmount } = renderKind(k, d as Record<string, unknown>);
        unmount();
      }
    }
  });
});

describe('order_card', () => {
  it('has NO voice / TTS control and no avatar', () => {
    const { container, ctx } = renderKind('order_card', ORDER);
    expect(container.querySelector('.k-voice, .k-avatar, audio, img')).toBeNull();
    expect(screen.queryByText(/▶/)).toBeNull();
    expect(screen.queryByText(/朗读/)).toBeNull();
    expect(screen.queryAllByRole('button').some((b) => /播放|语音|▶/.test(b.textContent + (b.getAttribute('aria-label') ?? '')))).toBe(false);
    expect(screen.getByText('焼き鳥 塩盛り合わせ')).toBeTruthy();
    expect(screen.getByText('×2')).toBeTruthy();
    expect(screen.getByText(/乳製品・卵/)).toBeTruthy();
    expect(ctx.speak).not.toHaveBeenCalled();
  });

  it('photo tag opens the menu photo with a bbox highlight; ⛶ opens fullscreen', async () => {
    const { ctx } = renderKind('order_card', ORDER);
    fireEvent.click(screen.getByRole('button', { name: /第1张图 · 右上/ }));
    const box = await screen.findByTestId('photo-bbox');
    expect(box.style.left).toBe('60%');
    expect(box.style.width).toBe('30%');
    expect((document.querySelector('.kc-locator-frame img') as HTMLImageElement).src).toBe('https://img.test/menu1.jpg');
    fireEvent.click(screen.getByRole('button', { name: /全屏出示/ }));
    expect(ctx.openFullscreen).toHaveBeenCalledTimes(1);
  });

  it('direction_card has no TTS either', () => {
    const { container } = renderKind('direction_card', { text_local: '浅草寺へ行きたいです', note_zh: '我想去浅草寺' });
    expect(screen.getByText('浅草寺へ行きたいです')).toBeTruthy();
    expect(container.querySelector('.k-voice, audio')).toBeNull();
    expect(screen.queryByText(/朗读/)).toBeNull();
  });
});

describe('translation', () => {
  const data = { source: '当店は現金のみご利用いただけます。', source_ruby: [{ base: '当店', rt: 'とうてん' }], target: '本店仅支持现金付款。' };

  it('▶ 朗读 calls ctx.speak only on click', () => {
    const { ctx } = renderKind('translation', data);
    expect(ctx.speak).not.toHaveBeenCalled();
    expect(document.querySelector('audio')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /朗读/ }));
    expect(ctx.speak).toHaveBeenCalledTimes(1);
    expect(ctx.speak).toHaveBeenCalledWith('本店仅支持现金付款。', 'zh-CN');
  });

  it('renders ruby on the source and copy / breakdown actions', () => {
    const { ctx, container } = renderKind('translation', data);
    expect(container.querySelector('rt')?.textContent).toBe('とうてん');
    fireEvent.click(screen.getByRole('button', { name: /复制/ }));
    expect(ctx.copy).toHaveBeenCalledWith('本店仅支持现金付款。');
    fireEvent.click(screen.getByRole('button', { name: /语法拆解/ }));
    expect(ctx.sendText).toHaveBeenCalledWith('语法拆解：当店は現金のみご利用いただけます。');
  });

  it('inline breakdown expands without a request when data.breakdown is present', () => {
    const { ctx } = renderKind('translation', { ...data, breakdown: { tokens: [{ surface: 'のみ', meaning: '仅限' }] } });
    fireEvent.click(screen.getByRole('button', { name: /语法拆解/ }));
    expect(ctx.sendText).not.toHaveBeenCalled();
    expect(screen.getByText('仅限')).toBeTruthy();
  });
});

describe('menu_review', () => {
  const data = {
    items: [
      { name_local: '焼き鳥', name_zh: '烤鸡串', verdict: 'pick', tags: ['无奶不辣'], photo_index: 1, bbox: [0.6, 0, 0.3, 0.2] },
      { name_local: '牛タン', name_zh: '牛舌', verdict: 'pick', tags: ['纯肉'] },
      { name_local: 'クリーム煮', name_zh: '奶油炖菜', verdict: 'hazard', tags: ['含鲜奶'] },
      { name_local: '烏龍茶', name_zh: '乌龙茶', verdict: 'ok' },
    ],
  };

  it('CTA counts picks and sends the order request text', () => {
    const { ctx } = renderKind('menu_review', data);
    const cta = screen.getByRole('button', { name: /生成店员点单卡 \(2道\)/ });
    const hazard = screen.getByRole('checkbox', { name: /排雷，不可选 クリーム煮/ }) as HTMLInputElement;
    expect(hazard.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /选择 烏龍茶/ }));
    expect(screen.getByRole('button', { name: /生成店员点单卡 \(3道\)/ })).toBe(cta);
    const tea = screen.getByRole('checkbox', { name: /选择 烏龍茶/ }).closest('li')!;
    fireEvent.click(within(tea).getByRole('button', { name: '增加' }));
    fireEvent.click(cta);
    expect(ctx.sendText).toHaveBeenCalledWith('生成店员点单卡：焼き鳥×1、牛タン×1、烏龍茶×2');
  });

  it('shows photo location badges', () => {
    renderKind('menu_review', data);
    expect(screen.getByRole('button', { name: /第1张图 · 右上/ })).toBeTruthy();
  });
});

const DEX_BASE = {
  species_id: '0149',
  form: 'mega',
  name: { zh: '超级快龙', ja: 'メガカイリュー', en: 'Mega Dragonite' },
  types: ['龙', '飞行'],
  bst: 700,
  stats: { hp: 91, atk: 124, def: 115, spa: 145, spd: 125, spe: 100 },
  stat_delta: { atk: -10, spa: 45 },
  matchup: { x4: ['冰'], x2: ['岩石', '龙', '妖精'], x05: ['火', '水'], x025: [], x0: ['地面'] },
  abilities: [{ zh: '多重鳞片', en: 'Multiscale', id: 'multiscale' }],
  mega_stone: '快龙进化石',
  mega_stone_id: 'dragoninite',
  glossary: {
    multiscale: { title: '多重鳞片', category: '特性', summary: '满 HP 时受伤减半', effect_pills: ['满 HP 受伤减半'], details_md: '**细节**' },
    dragoninite: { title: '快龙进化石', category: '道具', summary: '超级进化', effect_pills: ['超级进化'], details_md: '' },
  },
};

describe('pokemon_dex', () => {
  it('SV shows abilities and hides Mega stone / stat deltas', () => {
    const { container } = renderKind('pokemon_dex', { ...DEX_BASE, version: 'sv' });
    expect(screen.getByText(/4× 致命弱点：冰/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /多重鳞片/ })).toBeTruthy();
    expect(screen.queryByText(/超级进化石/)).toBeNull();
    expect(container.querySelector('.kc-delta.is-up')).toBeNull();
    expect(screen.getByText('朱／紫 SV')).toBeTruthy();
  });

  it('Z-A shows Mega stone + deltas and hides abilities', () => {
    const { container } = renderKind('pokemon_dex', { ...DEX_BASE, version: 'za' });
    expect(screen.getByRole('button', { name: /超级进化石：快龙进化石/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /多重鳞片/ })).toBeNull();
    expect(container.querySelector('.kc-delta.is-up')?.textContent).toBe('+45');
    expect(screen.getByText(/BST 700 \(物攻 −10 · 特攻 \+45\)/)).toBeTruthy();
  });

  it('resistances are folded; glossary pill opens peek', () => {
    const { ctx } = renderKind('pokemon_dex', { ...DEX_BASE, version: 'sv' });
    expect(screen.queryByText(/0×/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /抵抗/ }));
    expect(screen.getByText('地面')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /多重鳞片/ }));
    expect(ctx.openPeek).toHaveBeenCalledTimes(1);
    const [entry, gloss] = (ctx.openPeek as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(entry).toMatchObject({ id: 'multiscale', title: '多重鳞片', effect_pills: ['满 HP 受伤减半'] });
    expect(Object.keys(gloss)).toEqual(['multiscale', 'dragoninite']);
  });

  it('resolves artwork through ctx.resolveMedia', async () => {
    const ctx = makeCtx({ media: { artwork: 'ph-art' } });
    renderKind('pokemon_dex', { ...DEX_BASE, artwork: '[file:pkmn/0149-mega.webp]' }, ctx);
    await act(async () => {});
    expect(ctx.resolveMedia).toHaveBeenCalledWith({ placeholder_id: 'ph-art' });
    expect((screen.getByAltText('超级快龙') as HTMLImageElement).src).toBe('https://media.test/ph-art');
  });
});

describe('pkmn_move_wiki', () => {
  const base = {
    name: { zh: '神速', ja: 'しんそく', en: 'Extreme Speed' },
    type: '一般',
    category: 'physical',
    power: 80,
    accuracy: 100,
    pp: 5,
    priority: 2,
    cd_s: 6,
    range: '近距突进',
    plus_effect: '威力提升',
    effect_short: '必定先手攻击',
    pills: [{ kind: 'ability', id: 'multiscale', label: '多重鳞片' }],
    glossary: { multiscale: { title: '多重鳞片', effect_pills: ['满 HP 受伤减半'] } },
  };
  it('SV shows PP / 先制 and hides CD', () => {
    renderKind('pkmn_move_wiki', { ...base, version: 'sv' });
    expect(screen.getByText('PP 5')).toBeTruthy();
    expect(screen.getByText('先制 +2')).toBeTruthy();
    expect(screen.queryByText(/冷却/)).toBeNull();
    expect(screen.queryByText(/招式＋/)).toBeNull();
    expect(screen.getByText(/一般 · 物理 · 威力 80 · 命中 100/)).toBeTruthy();
  });
  it('Z-A shows CD / 射程 / 招式＋ and hides PP', () => {
    const { ctx } = renderKind('pkmn_move_wiki', { ...base, version: 'za' });
    expect(screen.getByText(/冷却 CD 6s/)).toBeTruthy();
    expect(screen.getByText(/近距突进/)).toBeTruthy();
    expect(screen.getByText(/招式＋ 威力提升/)).toBeTruthy();
    expect(screen.queryByText(/^PP/)).toBeNull();
    expect(screen.queryByText(/先制/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /多重鳞片/ }));
    expect(ctx.openPeek).toHaveBeenCalledWith(expect.objectContaining({ id: 'multiscale' }), expect.any(Object));
  });
});

describe('pkmn_matchup / lesson / grading', () => {
  it('matchup groups tiers and expands the reason', () => {
    renderKind('pkmn_matchup', {
      version: 'za',
      target_name: '超级快龙',
      picks: [
        { name: '玛狃拉', tier: 'ok', reason: '2× 克制' },
        { name: '甲贺忍蛙', tier: 'best', types: ['水', '恶'], reason: '冰系 4× 直击' },
      ],
    });
    const rows = screen.getAllByRole('button');
    expect(rows[0].textContent).toContain('首选');
    expect(rows[0].textContent).toContain('甲贺忍蛙');
    expect(screen.queryByText('冰系 4× 直击')).toBeNull();
    fireEvent.click(rows[0]);
    expect(screen.getByText('冰系 4× 直击')).toBeTruthy();
  });

  it('lesson_card renders 4 steps and a voice pill only when a voice ref exists', () => {
    const { container } = renderKind('lesson_card', {
      title: '普通形 + と思います',
      examples: [{ ja: '明日(あした)は雨(あめ)が降(ふ)ると思います。', zh: '我想明天会下雨。' }],
      grammar: { point: '普通形 + と思います', explain: '表达推测' },
      textbook: [{ ja: '明日は雨が降ると思います。', voice: { object: 'v/1.ogg', duration_ms: 4000 } }],
      native: [{ ja: '明日、雨降りそうじゃない？' }],
      pitfalls: [{ wrong: '降るだと思います', right: '降ると思います', note: '动词后不加だ' }],
    });
    for (const t of ['例句', '语法点', '📘 课本标准', '常见误区']) expect(screen.getAllByText(new RegExp(t)).length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.k-voice')).toHaveLength(1);
    expect(container.querySelector('audio')).toBeNull();
    expect(container.querySelector('rt')?.textContent).toBe('あした');
  });

  it('grading shows the verdict badge and diff highlight', () => {
    const { container } = renderKind('grading', { verdict: 'retry', label: '助词误用', original: '雨が降るだと思います', corrected: '雨が降ると思います', upgrade: { ja: '雨降りそう' } });
    expect(screen.getByText('✗ 再试')).toBeTruthy();
    expect(container.querySelector('.kc-diff-del')?.textContent).toBe('だ');
    expect(screen.getByText('🔥 母语者升级表达')).toBeTruthy();
    renderKind('grading', { pass: true, original: 'ok' });
    expect(screen.getByText('✓ PASS')).toBeTruthy();
  });
});

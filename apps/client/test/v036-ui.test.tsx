import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LexToken } from '@kesoku/protocol';
import { useState } from 'react';

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  upload: vi.fn(),
  resolveMedia: vi.fn(async () => null as string | null),
  resolveProposal: vi.fn(),
}));
vi.mock('../src/lib/client', () => ({ kesoku: m }));

import { BilingualCard, cacheSentenceLex, clearLexCacheForTest, explainLexCached, getCachedSentenceLex } from '../src/features/segments/BilingualCard';
import { MarkdownEditable } from '../src/features/persona/MarkdownEditable';
import { MemoryPanel, stripFrontmatterForPreview } from '../src/features/memory/MemoryPanel';
import { fallbackRoleId, roleFallbackName, voicePresetOptions, VOICE_PRESETS } from '../src/features/persona/model';
import { GenericCardSafe, getCard } from '../src/features/cards';
import { cardMedia, useImageUrl } from '../src/features/cards/util';
import type { MediaRef } from '../src/features/cards/types';
import { initialState, useStore } from '../src/lib/store';
import { makeCtx } from './cards/ctx';

beforeEach(() => {
  useStore.setState(initialState(), true);
  m.rpc.mockReset();
  clearLexCacheForTest();
});
afterEach(() => cleanup());

describe('generic role fallbacks (no persona hardcoding)', () => {
  it('falls back to the first role in display order, else the generic default role', () => {
    expect(fallbackRoleId([])).toBe('default');
    expect(fallbackRoleId([{ role_id: 'zed', display_name: 'Zed', tagline: '', builtin: false, avatar_rev: 0 }])).toBe('zed');
    expect(roleFallbackName('coder')).toBe('Coder');
    expect(roleFallbackName('mio')).toBe('mio');
    expect(roleFallbackName(undefined)).toBe('AI 助手');
  });
});

describe('voicePresetOptions', () => {
  it('prepends a role-specific saved preset and a role-dedicated voice for any role', () => {
    const opts = voicePresetOptions({ role_id: 'asuka', display_name: '斋藤飞鸟', voice_preset: 'asuka' });
    expect(opts[0]).toEqual({ id: 'asuka', label: '斋藤飞鸟 原声 (asuka)' });
    expect(opts.filter((o) => o.id === 'asuka')).toHaveLength(1);
    expect(opts.slice(1).map((o) => o.id)).toEqual(VOICE_PRESETS.map((v) => v.id));

    const mio = voicePresetOptions({ role_id: 'mio', display_name: '旅伴 Mio', voice_preset: 'cherry' });
    expect(mio[0]).toEqual({ id: 'mio', label: '旅伴 Mio 专属语音 (mio)' });
    expect(mio.filter((o) => o.id === 'cherry')).toHaveLength(1);

    expect(voicePresetOptions({ role_id: 'default', voice_preset: null }).map((o) => o.id)).toEqual(VOICE_PRESETS.map((v) => v.id));
    expect(voicePresetOptions(null)).toHaveLength(VOICE_PRESETS.length);
  });
});

describe('pkmn_move_wiki description + effect', () => {
  const base = { name: { zh: '大声咆哮' }, type: '恶', category: 'special', power: 55, accuracy: 95, version: 'sv' };
  function renderMove(data: Record<string, unknown>) {
    const Card = getCard('pkmn_move_wiki') ?? GenericCardSafe;
    return render(<Card data={data} ctx={makeCtx()} />);
  }
  it('renders 招式说明 and 招式效果 separately', () => {
    const { container } = renderMove({ ...base, description: '大声地咆哮，攻击对手。', effect_short: '100%降低目标特攻1级' });
    expect(container.querySelector('.kc-mv-desc')?.textContent).toBe('大声地咆哮，攻击对手。');
    const eff = container.querySelector('.kc-mv-effect');
    expect(eff?.textContent).toBe('招式效果：100%降低目标特攻1级');
    expect(eff?.querySelector('b')?.textContent).toBe('招式效果：');
  });
  it('shows the effect alone when there is no description, and dedupes identical text', () => {
    const only = renderMove({ ...base, effect: '降低特攻' });
    expect(only.container.querySelector('.kc-mv-desc')).toBeNull();
    expect(only.container.querySelector('.kc-mv-effect')?.textContent).toBe('招式效果：降低特攻');
    only.unmount();
    const same = renderMove({ ...base, description: '同一句', effect_short: '同一句' });
    expect(same.container.querySelector('.kc-mv-desc')?.textContent).toBe('同一句');
    expect(same.container.querySelector('.kc-mv-effect')).toBeNull();
  });
  it('accepts localized description objects', () => {
    const { container } = renderMove({ ...base, description: { zh: '中文说明', en: 'English' } });
    expect(container.querySelector('.kc-mv-desc')?.textContent).toBe('中文说明');
  });
});

describe('card media', () => {
  it('cardMedia keeps the data ref next to the live placeholder', () => {
    expect(cardMedia({ media: { artwork: 'ph_1' } }, ['artwork'], '[file:pkmn/0987.webp]')).toEqual({ ref: 'pkmn/0987.webp', placeholder_id: 'ph_1' });
    expect(cardMedia({ media: { artwork: 'ph_1' } }, ['artwork'])).toEqual({ placeholder_id: 'ph_1' });
    expect(cardMedia({}, ['artwork'], 'pkmn/0001.webp')).toEqual({ ref: 'pkmn/0001.webp' });
  });

  it('useImageUrl does not cancel / re-resolve when only the resolver identity changes', async () => {
    let release!: (u: string) => void;
    const calls: MediaRef[] = [];
    const makeResolver = () =>
      vi.fn((r: MediaRef) => {
        calls.push(r);
        return new Promise<string | null>((res) => {
          release = res;
        });
      });
    const ref: MediaRef = { ref: 'pkmn/0987.webp' };
    function Probe({ n }: { n: number }) {
      // A brand-new resolver on every render, like makeCardContext() inside the message list.
      const url = useImageUrl(makeResolver(), ref);
      return <span data-testid="u" data-n={n}>{url === undefined ? 'loading' : String(url)}</span>;
    }
    const { rerender } = render(<Probe n={0} />);
    rerender(<Probe n={1} />);
    rerender(<Probe n={2} />);
    expect(calls).toHaveLength(1);
    await act(async () => release('https://media.test/0987.webp'));
    expect(screen.getByTestId('u').textContent).toBe('https://media.test/0987.webp');
  });
});

describe('BilingualCard whole-sentence lexical analysis', () => {
  const plain = '天気はいいね';
  const seg = { type: 'bilingual' as const, ja_plain: plain, zh: '天气真好呢' };
  const SENTENCE: LexToken[] = [
    { surface: '天気', reading: 'てんき', gloss_zh: '天气-整句' },
    { surface: 'は', gloss_zh: '提示助词-整句' },
    { surface: 'いい', gloss_zh: '好-整句' },
    { surface: 'ね', gloss_zh: '语气-整句' },
  ];

  it('caches every 意群 and serves other words with zero extra requests and no spinner', async () => {
    const explain = vi.fn(async (text: string, tok: string) => {
      cacheSentenceLex(text, SENTENCE); // what MessageList does with lexical.explain.result.tokens
      return SENTENCE.find((t) => t.surface === tok) ?? { surface: tok };
    });
    const onWord = vi.fn();
    const { container } = render(<BilingualCard seg={seg} resolveVoice={vi.fn()} explain={explain} onWord={onWord} />);
    const words = () => Array.from(container.querySelectorAll('.k-word')) as HTMLElement[];
    await act(async () => fireEvent.click(words()[0]));
    expect(explain).toHaveBeenCalledTimes(1);
    expect(screen.getByText('天气-整句')).toBeTruthy();
    expect(getCachedSentenceLex(plain)).toHaveLength(4);

    // Units are now re-split along the sentence analysis: 天気 / は / いい / ね.
    expect(words().map((w) => w.textContent)).toEqual(['天気', 'は', 'いい', 'ね']);
    const iiBtn = words().find((w) => w.textContent === 'いい')!;
    act(() => {
      fireEvent.click(iiBtn); // synchronous: no awaiting needed
    });
    expect(explain).toHaveBeenCalledTimes(1);
    expect(screen.getByText('好-整句')).toBeTruthy();
    expect(container.querySelector('.k-lex-loading')).toBeNull();
    expect(onWord).toHaveBeenLastCalledWith(SENTENCE[2], plain);
  });

  it('a fresh card for an already-analysed sentence needs no request at all', () => {
    cacheSentenceLex(plain, SENTENCE);
    const explain = vi.fn();
    const { container } = render(<BilingualCard seg={seg} resolveVoice={vi.fn()} explain={explain} />);
    const ne = (Array.from(container.querySelectorAll('.k-word')) as HTMLElement[]).find((w) => w.textContent === 'ね')!;
    act(() => {
      fireEvent.click(ne);
    });
    expect(explain).not.toHaveBeenCalled();
    expect(screen.getByText('语气-整句')).toBeTruthy();
  });

  it('taps on other words while the sentence is loading share the single request', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fetcher = vi.fn(async (text: string, tok: string) => {
      await gate;
      cacheSentenceLex(text, SENTENCE);
      return SENTENCE.find((t) => t.surface === tok) ?? null;
    });
    const a = explainLexCached(plain, '天気', fetcher);
    const b = explainLexCached(plain, 'いい', fetcher);
    release();
    expect((await a)?.gloss_zh).toBe('天气-整句');
    expect((await b)?.gloss_zh).toBe('好-整句');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('MarkdownEditable', () => {
  function Harness({ initial, defaultEditing }: { initial: string; defaultEditing?: boolean }) {
    const [v, setV] = useState(initial);
    return <MarkdownEditable label="个人介绍与背景" ariaLabel="个人介绍与背景" value={v} onChange={setV} defaultEditing={defaultEditing} placeholder="写点什么" />;
  }
  it('renders Markdown by default and switches to a textarea on 编辑', () => {
    const { container } = render(<Harness initial={'- Male\n- Hobbie: **跑步**'} />);
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelectorAll('.ps-md-preview li')).toHaveLength(2);
    expect(container.querySelector('.ps-md-preview strong')?.textContent).toBe('跑步');
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const ta = screen.getByLabelText('个人介绍与背景') as HTMLTextAreaElement;
    expect(ta.tagName).toBe('TEXTAREA');
    fireEvent.change(ta, { target: { value: '# 新标题' } });
    fireEvent.click(screen.getByRole('button', { name: /完成预览/ }));
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('.ps-md-preview')?.textContent).toContain('新标题');
  });
  it('clicking the preview edits; empty values show a tappable placeholder', () => {
    const a = render(<Harness initial="正文" />);
    fireEvent.click(a.container.querySelector('.ps-md-preview')!);
    expect(a.container.querySelector('textarea')).toBeTruthy();
    a.unmount();
    const b = render(<Harness initial="" />);
    fireEvent.click(screen.getByRole('button', { name: '写点什么' }));
    expect(b.container.querySelector('textarea')).toBeTruthy();
  });
});

describe('MemoryPanel Markdown preview', () => {
  const FILE = '---\ndescription: 用户饮食偏好\ntags: [food, health]\n---\n# 饮食\n\n- 乳糖不耐受\n- 不吃香菜\n';
  beforeEach(() => {
    useStore.setState({ personas: [{ role_id: 'mio', display_name: '旅伴 Mio', tagline: '', builtin: false, avatar_rev: 0 }] });
    m.rpc.mockImplementation((type: string) => {
      if (type === 'memory.list') return Promise.resolve({ files: [{ rel_path: 'user/food.md', pinned: false, tags: [] }] });
      if (type === 'memory.get') return Promise.resolve({ content: FILE, pinned: false });
      return Promise.resolve({ ok: true });
    });
  });

  it('splits YAML frontmatter from the body', () => {
    const r = stripFrontmatterForPreview(FILE);
    expect(r.meta).toEqual([
      { key: 'description', value: '用户饮食偏好' },
      { key: 'tags', value: 'food, health' },
    ]);
    expect(r.body.startsWith('# 饮食')).toBe(true);
    expect(stripFrontmatterForPreview('plain').body).toBe('plain');
  });

  it('uses the first loaded role (no hardcoded persona) and previews files before editing', async () => {
    const { container } = render(<MemoryPanel />);
    await waitFor(() => expect(m.rpc).toHaveBeenCalledWith('memory.list', { role: 'mio' }));
    fireEvent.click(await screen.findByText('user/food.md'));
    await waitFor(() => expect(container.querySelector('.k-memory-md-preview')).toBeTruthy());
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelectorAll('.k-memory-md-preview li')).toHaveLength(2);
    expect(container.querySelector('.k-memory-meta')?.textContent).toContain('用户饮食偏好');
    fireEvent.click(screen.getByRole('button', { name: /编辑/ }));
    expect((screen.getByLabelText('记忆内容') as HTMLTextAreaElement).value).toBe(FILE);
    fireEvent.click(screen.getByRole('button', { name: /预览/ }));
    expect(container.querySelector('textarea')).toBeNull();
  });
});

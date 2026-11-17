import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { QuestionSegment, Segment } from '@kesoku/protocol';
import { CharacterPickerCard, hasCharacterPortraits } from './CharacterPickerCard';
import { SegmentList, type SegmentEnv } from './SegmentRenderer';
import { GalgameStage, openQuestion } from '../modes/galgame/GalgameStage';
import { useOverlays } from '../session/overlays';
import type { CardContext } from '../cards/types';
import type { ChatItem } from '../../lib/types';
import { APP_VERSION } from '../../lib/client';
import { useStore } from '../../lib/store';

function makeCtx(over: Partial<CardContext> = {}): CardContext {
  return {
    sessionId: 's1',
    messageId: 'm1',
    modeId: 'chat',
    sendText: vi.fn(),
    resolveMedia: vi.fn(async (r) => (r.ref ? `https://media.test/${r.ref}` : null)),
    openPeek: vi.fn(),
    openFullscreen: vi.fn(),
    insertComposer: vi.fn(),
    setModePrefs: vi.fn(),
    speak: vi.fn(),
    copy: vi.fn(),
    toast: vi.fn(),
    ...over,
  };
}

const REROLL = '🎲 再帮我想 8 个不同的候选';

function question(over: Partial<QuestionSegment> = {}): QuestionSegment {
  return {
    type: 'question',
    prompt: '选一位今天陪你的角色',
    choices: ['asuka', 'rei', 'misato', REROLL],
    multi: false,
    question_message_id: 'q1',
    layout: 'character_grid',
    choice_items: [
      { value: 'asuka', name: '明日香', subtitle: '傲娇 · 王牌机师', avatar: 'cand/asuka.webp' },
      { value: 'rei', name: '绫波丽', subtitle: '安静 · 神秘', avatar: 'cand/rei.webp' },
      { value: 'misato', avatar: 'cand/misato.webp' },
      { value: REROLL },
    ],
    ...over,
  };
}

function env(over: Partial<SegmentEnv> = {}): SegmentEnv {
  return { ctx: makeCtx(), onPick: vi.fn(), explain: vi.fn(async () => null), ...over };
}

function card(value: string): HTMLElement {
  const el = document.querySelector(`[data-testid="cpick-card"][data-value="${value}"]`);
  if (!el) throw new Error('no card ' + value);
  return el as HTMLElement;
}

function hit(value: string): HTMLButtonElement {
  return card(value).querySelector('.k-cpick-hit') as HTMLButtonElement;
}

beforeEach(() => {
  useStore.setState({ media: {} });
  useOverlays.setState({ fullscreen: null, peek: null, image: null });
});

describe('hasCharacterPortraits', () => {
  it('is true only when some choice item carries an avatar', () => {
    expect(hasCharacterPortraits(question())).toBe(true);
    expect(hasCharacterPortraits(question({ choice_items: [{ value: 'a' }] }))).toBe(false);
    expect(hasCharacterPortraits(question({ choice_items: undefined }))).toBe(false);
    expect(hasCharacterPortraits(null)).toBe(false);
  });
});

describe('<CharacterPickerCard> · single-select', () => {
  it('hydrates avatars via ctx.resolveMedia, caches them under ref:, and picks in one tap', async () => {
    const e = env();
    render(<SegmentList segments={[question() as Segment]} env={e} />);
    expect(screen.getByTestId('character-picker')).toBeTruthy();
    expect(screen.getByTestId('cpick-status').textContent).toBe('单选');
    expect(screen.getAllByTestId('cpick-card')).toHaveLength(3);
    // Names fall back to the value; subtitles render when present.
    expect(screen.getByText('明日香')).toBeTruthy();
    expect(screen.getByText('傲娇 · 王牌机师')).toBeTruthy();
    expect(screen.getByText('misato')).toBeTruthy();

    await waitFor(() => expect(card('asuka').querySelector('img')?.getAttribute('src')).toBe('https://media.test/cand/asuka.webp'));
    expect(e.ctx.resolveMedia).toHaveBeenCalledWith({ ref: 'cand/asuka.webp' });
    expect(e.ctx.resolveMedia).toHaveBeenCalledWith({ ref: 'cand/rei.webp' });
    expect(useStore.getState().media['ref:cand/asuka.webp']?.url).toBe('https://media.test/cand/asuka.webp');
    // Shimmer until the <img> reports loaded.
    expect(card('asuka').querySelector('.k-cpick-portrait')?.classList.contains('is-loading')).toBe(true);
    fireEvent.load(card('asuka').querySelector('img')!);
    expect(card('asuka').querySelector('.k-cpick-portrait')?.classList.contains('is-loading')).toBe(false);

    fireEvent.click(hit('rei'));
    expect(e.onPick).toHaveBeenCalledTimes(1);
    expect(e.onPick).toHaveBeenCalledWith('q1', ['rei']);
    // No multi-select bar in single-select mode.
    expect(screen.queryByRole('button', { name: /确认选择/ })).toBeNull();
  });

  it('reuses cached ref: URLs without calling resolveMedia again', async () => {
    useStore.setState({
      media: {
        'ref:cand/asuka.webp': { status: 'ready', url: 'https://cdn.test/a.webp' },
        'ref:cand/rei.webp': { status: 'ready', url: 'https://cdn.test/r.webp' },
        'ref:cand/misato.webp': { status: 'ready', url: 'https://cdn.test/m.webp' },
      },
    });
    const e = env();
    render(<SegmentList segments={[question() as Segment]} env={e} />);
    expect(card('asuka').querySelector('img')?.getAttribute('src')).toBe('https://cdn.test/a.webp');
    await act(async () => {});
    expect(e.ctx.resolveMedia).not.toHaveBeenCalled();
  });

  it('falls back to an initial badge when the avatar cannot be resolved', async () => {
    const e = env({ ctx: makeCtx({ resolveMedia: vi.fn(async () => null) }) });
    render(<SegmentList segments={[question()]} env={e} />);
    await waitFor(() => expect(card('asuka').querySelector('[data-testid="cpick-initial"]')?.textContent).toBe('明'));
    expect(card('misato').querySelector('[data-testid="cpick-initial"]')?.textContent).toBe('M');
    // No zoom button without a loaded URL.
    expect(card('asuka').querySelector('.k-cpick-zoom')).toBeNull();
  });

  it('retries once on <img> error, then shows the initial badge', async () => {
    const resolveMedia = vi.fn(async (r: { ref?: string }) => `https://media.test/${r.ref}`);
    render(<SegmentList segments={[question()]} env={env({ ctx: makeCtx({ resolveMedia }) })} />);
    await waitFor(() => expect(card('rei').querySelector('img')).toBeTruthy());
    fireEvent.error(card('rei').querySelector('img')!);
    await waitFor(() => expect(resolveMedia.mock.calls.filter((c) => c[0].ref === 'cand/rei.webp')).toHaveLength(2));
    await waitFor(() => expect(card('rei').querySelector('img')).toBeTruthy());
    fireEvent.error(card('rei').querySelector('img')!);
    await waitFor(() => expect(card('rei').querySelector('[data-testid="cpick-initial"]')).toBeTruthy());
  });

  it('uses direct http(s) avatar URLs as-is', () => {
    const e = env();
    render(<SegmentList segments={[question({ choice_items: [{ value: 'x', name: '小X', avatar: 'https://img.test/x.png' }] })]} env={e} />);
    expect(card('x').querySelector('img')?.getAttribute('src')).toBe('https://img.test/x.png');
    expect(e.ctx.resolveMedia).not.toHaveBeenCalled();
  });

  it('readOnly disables every card and action', async () => {
    const e = env({ readOnly: true });
    render(<SegmentList segments={[question()]} env={e} />);
    expect(hit('asuka').disabled).toBe(true);
    expect((screen.getByRole('button', { name: REROLL }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(hit('asuka'));
    expect(e.onPick).not.toHaveBeenCalled();
    await act(async () => {});
  });
});

describe('<CharacterPickerCard> · multi-select', () => {
  it('toggles, enforces max, dims the rest, clears and confirms', async () => {
    const e = env();
    render(<SegmentList segments={[question({ multi: true, max: 2 })]} env={e} />);
    const status = screen.getByTestId('cpick-status');
    expect(status.textContent).toBe('已选 0/2');
    const confirm = screen.getByRole('button', { name: '确认选择 (0/2)' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: '清空' })).toBeNull();

    fireEvent.click(hit('asuka'));
    expect(e.onPick).not.toHaveBeenCalled();
    expect(card('asuka').classList.contains('is-selected')).toBe(true);
    expect(card('asuka').querySelector('.k-cpick-check')?.textContent).toBe('✓');
    expect(hit('asuka').getAttribute('aria-pressed')).toBe('true');
    expect(status.textContent).toBe('已选 1/2');

    fireEvent.click(hit('rei'));
    expect(status.textContent).toBe('已选 2/2');
    expect(card('misato').classList.contains('is-dim')).toBe(true);
    expect(card('asuka').classList.contains('is-dim')).toBe(false);

    // Cap reached: a third pick is ignored.
    fireEvent.click(hit('misato'));
    expect(card('misato').classList.contains('is-selected')).toBe(false);
    expect(status.textContent).toBe('已选 2/2');

    // Toggle off, then clear.
    fireEvent.click(hit('rei'));
    expect(status.textContent).toBe('已选 1/2');
    fireEvent.click(screen.getByRole('button', { name: '清空' }));
    expect(status.textContent).toBe('已选 0/2');

    fireEvent.click(hit('misato'));
    fireEvent.click(hit('asuka'));
    fireEvent.click(screen.getByRole('button', { name: '确认选择 (2/2)' }));
    expect(e.onPick).toHaveBeenCalledWith('q1', ['misato', 'asuka']);
    await act(async () => {});
  });

  it('without max shows a bare count and never caps', async () => {
    const e = env();
    render(<SegmentList segments={[question({ multi: true })]} env={e} />);
    for (const v of ['asuka', 'rei', 'misato']) fireEvent.click(hit(v));
    expect(screen.getByTestId('cpick-status').textContent).toBe('已选 3');
    expect(document.querySelectorAll('.k-cpick-card.is-dim')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '确认选择 (3)' }));
    expect(e.onPick).toHaveBeenCalledWith('q1', ['asuka', 'rei', 'misato']);
    await act(async () => {});
  });

  it('rerolls in one tap via the secondary action while nothing is selected', async () => {
    const e = env();
    render(<SegmentList segments={[question({ multi: true, max: 3 })]} env={e} />);
    const reroll = screen.getByRole('button', { name: REROLL });
    expect(reroll.closest('.k-cpick-actions')).toBeTruthy();
    fireEvent.click(reroll);
    expect(e.onPick).toHaveBeenCalledTimes(1);
    expect(e.onPick).toHaveBeenCalledWith('q1', [REROLL]);
    await act(async () => {});
  });

  it('with a selection, an action item joins the selection instead of submitting', async () => {
    const e = env();
    render(<SegmentList segments={[question({ multi: true, max: 3 })]} env={e} />);
    fireEvent.click(hit('asuka'));
    fireEvent.click(screen.getByRole('button', { name: REROLL }));
    expect(e.onPick).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: REROLL }).classList.contains('is-on')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '确认选择 (2/3)' }));
    expect(e.onPick).toHaveBeenCalledWith('q1', ['asuka', REROLL]);
    await act(async () => {});
  });

  it('single-select action items also submit in one tap', async () => {
    const e = env();
    render(<SegmentList segments={[question()]} env={e} />);
    fireEvent.click(screen.getByRole('button', { name: REROLL }));
    expect(e.onPick).toHaveBeenCalledWith('q1', [REROLL]);
    await act(async () => {});
  });
});

describe('<CharacterPickerCard> · corner zoom', () => {
  it('opens the full portrait via overlays.image without picking', async () => {
    const e = env();
    render(<SegmentList segments={[question()]} env={e} />);
    const zoom = await screen.findByRole('button', { name: '查看 明日香 大图' });
    fireEvent.click(zoom);
    expect(useOverlays.getState().image?.url).toBe('https://media.test/cand/asuka.webp');
    expect(e.onPick).not.toHaveBeenCalled();
    // Value fallback in the label when no name is given.
    expect(await screen.findByRole('button', { name: '查看 misato 大图' })).toBeTruthy();
  });

  it('does not toggle a multi-select card either', async () => {
    const e = env();
    render(<SegmentList segments={[question({ multi: true, max: 2 })]} env={e} />);
    fireEvent.click(await screen.findByRole('button', { name: '查看 绫波丽 大图' }));
    expect(card('rei').classList.contains('is-selected')).toBe(false);
    expect(screen.getByTestId('cpick-status').textContent).toBe('已选 0/2');
  });
});

describe('<CharacterPickerCard> · answered state', () => {
  it('collapses to the prompt header only (no portrait grid) once picked', () => {
    const e = env({ picked: ['rei'] });
    const { container } = render(<SegmentList segments={[question()]} env={e} />);
    expect(screen.queryByTestId('character-picker')).toBeNull();
    expect(container.querySelectorAll('[data-testid="cpick-card"]')).toHaveLength(0);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.k-q.is-answered .k-q-prompt')?.textContent).toBe('选一位今天陪你的角色');
    expect(e.ctx.resolveMedia).not.toHaveBeenCalled();
  });

  it('questions without avatars keep the classic pills', () => {
    const e = env();
    render(<SegmentList segments={[question({ choice_items: [{ value: 'asuka' }, { value: 'rei' }], choices: ['asuka', 'rei'] })]} env={e} />);
    expect(screen.queryByTestId('character-picker')).toBeNull();
    expect(document.querySelectorAll('.k-choice')).toHaveLength(2);
  });

  it('resets the selection when the question id changes', async () => {
    const onPick = vi.fn();
    const ctx = makeCtx();
    const { rerender } = render(<CharacterPickerCard seg={question({ multi: true, max: 2 })} qid="q1" ctx={ctx} onPick={onPick} />);
    fireEvent.click(hit('asuka'));
    expect(screen.getByTestId('cpick-status').textContent).toBe('已选 1/2');
    rerender(<CharacterPickerCard seg={question({ multi: true, max: 2 })} qid="q2" ctx={ctx} onPick={onPick} />);
    expect(screen.getByTestId('cpick-status').textContent).toBe('已选 0/2');
    await act(async () => {});
  });
});

function assistant(key: string, segments: Segment[], extra: Partial<ChatItem> = {}): ChatItem {
  return { key, kind: 'assistant', message_id: key, ts: 1, segments, sender: { display_name: '飞鸟' }, ...extra };
}

function stage(items: ChatItem[]) {
  const ctx = makeCtx({ modeId: 'galgame' });
  const props = {
    items,
    preview: null,
    stateFiles: {},
    ctx,
    policy: 'confirm_only' as const,
    onPolicyChange: vi.fn(),
    onPick: vi.fn(),
    onExit: vi.fn(),
  };
  return { ...render(<GalgameStage {...props} />), props, ctx };
}

describe('GalgameStage · character picker', () => {
  const line = { type: 'bilingual', ja_plain: '誰にする？', zh: '选谁呢？' } as Segment;

  it('renders the frosted picker card above the dialogue box instead of plain choice pills', async () => {
    const { props, ctx } = stage([assistant('m9', [line, question({ question_message_id: undefined })])]);
    const wrap = screen.getByTestId('gg-cpick');
    const picker = within(wrap).getByTestId('character-picker');
    expect(picker.classList.contains('is-stage')).toBe(true);
    expect(document.querySelector('.gg-choices')).toBeNull();
    // Picker sits before the dialogue box in the bottom stack.
    const box = screen.getByTestId('gg-box');
    expect(wrap.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(ctx.resolveMedia).toHaveBeenCalledWith({ ref: 'cand/asuka.webp' }));
    fireEvent.click(hit('asuka'));
    expect(props.onPick).toHaveBeenCalledWith('m9', ['asuka']);
  });

  it('multi-select on the stage confirms with the selected values', async () => {
    const { props } = stage([assistant('m9', [line, question({ multi: true, max: 2 })])]);
    fireEvent.click(hit('rei'));
    fireEvent.click(hit('misato'));
    fireEvent.click(screen.getByRole('button', { name: '确认选择 (2/2)' }));
    expect(props.onPick).toHaveBeenCalledWith('q1', ['rei', 'misato']);
    await act(async () => {});
  });

  it('hides the picker once the player answered', () => {
    stage([assistant('m9', [line, question()], { picked: ['asuka'] })]);
    expect(screen.queryByTestId('gg-cpick')).toBeNull();
  });

  it('openQuestion accepts avatar-only questions with no plain choices', () => {
    const q = question({ choices: [] });
    expect(openQuestion([assistant('m1', [q])])?.seg).toBe(q);
    expect(openQuestion([assistant('m1', [question({ choices: [], choice_items: [{ value: 'a' }] })])])).toBeNull();
  });
});

describe('character picker styles & version', () => {
  const root = resolve(__dirname, '../../..');
  it('ships responsive portrait grid + frosted stage styles', () => {
    const globalCss = readFileSync(resolve(root, 'src/app/global.css'), 'utf8');
    const modesCss = readFileSync(resolve(root, 'src/features/modes/modes.css'), 'utf8');
    expect(globalCss).toContain('.k-cpick-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));');
    expect(globalCss).toMatch(/@container \(min-width: 520px\) \{ \.k-cpick-grid \{ grid-template-columns: repeat\(3/);
    expect(globalCss).toMatch(/@container \(min-width: 680px\) \{ \.k-cpick-grid \{ grid-template-columns: repeat\(4/);
    expect(globalCss).toContain('aspect-ratio: 1 / 1');
    expect(globalCss).toContain('object-fit: cover');
    expect(modesCss).toContain('max-height: min(56vh, 440px); overflow-y: auto;');
  });

  it('bumps to 0.1.28 (versionCode / CFBundleVersion 29)', () => {
    expect(APP_VERSION).toBe('0.1.28');
    const gradle = readFileSync(resolve(root, 'android/app/build.gradle'), 'utf8');
    expect(gradle).toMatch(/versionCode 29\b/);
    expect(gradle).toContain('versionName "0.1.28"');
    const pbx = readFileSync(resolve(root, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8');
    expect(pbx).toContain('MARKETING_VERSION = 0.1.28;');
    expect(pbx).toContain('CURRENT_PROJECT_VERSION = 29;');
    expect(pbx).not.toContain('CURRENT_PROJECT_VERSION = 28;');
  });
});

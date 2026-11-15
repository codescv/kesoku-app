import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { MODE_IDS } from '@kesoku/protocol';
import {
  ICON_STYLE_KEY,
  ICON_STYLE_OPTIONS,
  MODE_ICON_IDS,
  ModeIcon,
  UI_ICON_NAMES,
  UiIcon,
  fileIconName,
  getIconStyle,
  mixColor,
  setIconStyle,
  useIconStyle,
} from '../src/icons';
import { MODES, POLICY_BADGE } from '../src/modes';

const EMOJI = /\p{Extended_Pictographic}/u;

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

describe('<ModeIcon>', () => {
  it('has a bespoke glyph and signature accent for all 8 modes', () => {
    expect([...MODE_ICON_IDS].sort()).toEqual([...MODE_IDS].sort());
    const accents = {
      chat: '#4A6FA5',
      galgame: '#D45B7A',
      travel_companion: '#2E8B6E',
      translator: '#3B82C4',
      jp_classroom: '#8E5A9E',
      trpg: '#C87A28',
      pokemon_assistant: '#D14836',
      story_theater: '#6B5B95',
    } as const;
    const markup = new Set<string>();
    for (const id of MODE_IDS) {
      expect(MODES[id].accent).toBe(accents[id]);
      const { container, unmount } = render(<ModeIcon mode={id} size={26} styleVariant="line" />);
      const svg = container.querySelector('svg')!;
      expect(svg.getAttribute('data-mode-icon')).toBe(id);
      expect(svg.getAttribute('width')).toBe('26');
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.style.color.replace(/\s/g, '')).toBe(rgb(accents[id]));
      expect(container.textContent).not.toMatch(EMOJI);
      markup.add(svg.innerHTML);
      unmount();
    }
    expect(markup.size).toBe(8); // every mode is visually distinct
  });

  it('renders three distinct styles: duotone (tint + 1.9 stroke), line (1.75 stroke), badge (squircle)', () => {
    const { container: duo } = render(<ModeIcon mode="trpg" styleVariant="duotone" />);
    expect(duo.querySelector('g[opacity="0.18"]')).toBeTruthy();
    expect(duo.querySelector('g[stroke-width="1.9"]')).toBeTruthy();
    expect(duo.querySelector('svg')!.getAttribute('data-icon-style')).toBe('duotone');

    const { container: line } = render(<ModeIcon mode="trpg" styleVariant="line" />);
    expect(line.querySelector('g[opacity]')).toBeNull();
    expect(line.querySelector('g[stroke-width="1.75"]')).toBeTruthy();

    const { container: badge } = render(<ModeIcon mode="trpg" styleVariant="badge" />);
    const bg = badge.querySelector('rect.k-icon-badge-bg')!;
    expect(bg.getAttribute('rx')).toBe('7');
    expect(bg.getAttribute('fill')).toMatch(/^url\(#/);
    expect(badge.querySelector('linearGradient')).toBeTruthy();
    expect(badge.querySelector('g[color="#ffffff"]')).toBeTruthy();
  });

  it('falls back to the chat glyph for unknown modes and supports an accessible title', () => {
    const { container } = render(<ModeIcon mode="nope" title="未知" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('data-mode-icon')).toBe('chat');
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('未知');
  });

  it('uses unique gradient ids per badge instance', () => {
    const { container } = render(
      <>
        <ModeIcon mode="chat" styleVariant="badge" />
        <ModeIcon mode="chat" styleVariant="badge" />
      </>,
    );
    const ids = [...container.querySelectorAll('linearGradient')].map((g) => g.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('<UiIcon>', () => {
  it('covers every required UI glyph without emoji', () => {
    const required = [
      'menu', 'search', 'plus', 'close', 'check', 'chevron-right', 'chevron-down', 'arrow-left', 'refresh', 'external', 'sliders', 'spark', 'pin',
      'camera', 'image', 'mic', 'send', 'play', 'pause', 'volume', 'sticker',
      'brain', 'persona', 'folder', 'folder-open', 'file-text', 'file-code', 'file-image', 'file-audio', 'file-pdf', 'file', 'upload', 'download', 'edit', 'trash', 'folder-plus', 'file-plus', 'save',
      'qr', 'globe', 'smartphone', 'laptop', 'link', 'shield',
      'policy-full', 'policy-confirm', 'policy-isolated',
    ];
    for (const name of required) expect(UI_ICON_NAMES).toContain(name);
    for (const name of UI_ICON_NAMES) {
      const { container, unmount } = render(<UiIcon name={name} />);
      const svg = container.querySelector('svg')!;
      expect(svg.getAttribute('data-ui-icon')).toBe(name);
      expect(svg.querySelectorAll('path,circle,rect').length).toBeGreaterThan(0);
      expect(container.textContent).not.toMatch(EMOJI);
      unmount();
    }
  });

  it('inherits currentColor by default and never draws a badge plate', () => {
    const { container } = render(<UiIcon name="send" size={22} styleVariant="badge" />);
    const svg = container.querySelector('svg')!;
    expect(svg.style.color).toBe('');
    expect(svg.getAttribute('data-icon-style')).toBe('duotone');
    expect(container.querySelector('rect.k-icon-badge-bg')).toBeNull();
  });

  it('maps policy badges to policy glyphs', () => {
    expect(POLICY_BADGE.full.iconName).toBe('policy-full');
    expect(POLICY_BADGE.confirm_only.iconName).toBe('policy-confirm');
    expect(POLICY_BADGE.isolated.iconName).toBe('policy-isolated');
    expect(POLICY_BADGE.isolated.explain).not.toMatch(/token/i);
  });

  it('picks file glyphs from names', () => {
    expect(fileIconName('notes', 'dir')).toBe('folder');
    expect(fileIconName('notes', 'dir', true)).toBe('folder-open');
    expect(fileIconName('a.md')).toBe('file-text');
    expect(fileIconName('a.tsx')).toBe('file-code');
    expect(fileIconName('a.webp')).toBe('file-image');
    expect(fileIconName('a.wav')).toBe('file-audio');
    expect(fileIconName('a.pdf')).toBe('file-pdf');
    expect(fileIconName('a.bin')).toBe('file');
  });
});

describe('icon style preference', () => {
  function Probe() {
    const s = useIconStyle();
    return (
      <span data-testid="probe" data-style={s}>
        <ModeIcon mode="galgame" />
      </span>
    );
  }

  it('defaults to duotone, persists to localStorage and re-renders all icons live', () => {
    expect(ICON_STYLE_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ['duotone', '柔和双色'],
      ['line', '极简线性'],
      ['badge', '立体徽章'],
    ]);
    const { getByTestId, container } = render(<Probe />);
    expect(getIconStyle()).toBe('duotone');
    expect(getByTestId('probe').dataset.style).toBe('duotone');
    act(() => setIconStyle('badge'));
    expect(localStorage.getItem(ICON_STYLE_KEY)).toBe('badge');
    expect(getByTestId('probe').dataset.style).toBe('badge');
    expect(container.querySelector('svg')!.getAttribute('data-icon-style')).toBe('badge');
    act(() => setIconStyle('line'));
    expect(container.querySelector('svg')!.getAttribute('data-icon-style')).toBe('line');
  });

  it('ignores invalid stored values', () => {
    localStorage.setItem(ICON_STYLE_KEY, 'neon');
    expect(getIconStyle()).toBe('duotone');
    setIconStyle('neon' as never);
    expect(localStorage.getItem(ICON_STYLE_KEY)).toBe('neon');
  });

  it('mixes colours for the badge gradient', () => {
    expect(mixColor('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixColor('#D14836', '#D14836', 0.3)).toBe('#d14836');
    expect(mixColor('currentColor', '#fff', 0.2)).toBe('currentColor');
  });
});

function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;
}

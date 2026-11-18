import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Segment } from '@kesoku/protocol';
import { SegmentList, type SegmentEnv } from '../src/features/segments/SegmentRenderer';
import type { CardContext } from '../src/features/cards/types';

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

function env(overrides: Partial<SegmentEnv> = {}): SegmentEnv {
  return { ctx: ctx(), onPick: vi.fn(), explain: vi.fn(async () => null), ...overrides };
}

const isOn = (text: string) => screen.getByText(text).closest('button')?.classList.contains('is-on');

describe('QuestionPills option groups — edge cases', () => {
  it('treats empty / whitespace-only group as ungrouped (flat layout, n/max confirm label)', () => {
    const onPick = vi.fn();
    const segs: Segment[] = [
      {
        type: 'question',
        prompt: 'p',
        multi: true,
        choices: ['a', 'b', 'c'],
        choice_items: [
          { value: 'a', group: '' },
          { value: 'b', group: '   ' },
          { value: 'c' },
        ],
      },
    ];
    const { container } = render(<SegmentList segments={segs} env={env({ onPick })} />);
    expect(container.querySelector('.k-q-groups')).toBeNull();
    expect(container.querySelector('.k-q.is-grouped')).toBeNull();
    fireEvent.click(screen.getByText('a'));
    fireEvent.click(screen.getByText('b'));
    // Not mutually exclusive: both stay selected.
    expect(isOn('a')).toBe(true);
    expect(isOn('b')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '确认选择 (2/3)' }));
    expect(onPick).toHaveBeenCalledWith('m1', ['a', 'b']);
  });

  it('merges groups that differ only by surrounding whitespace and renders the trimmed label', () => {
    const segs: Segment[] = [
      {
        type: 'question',
        prompt: '',
        multi: true,
        choices: ['a', 'b'],
        choice_items: [
          { value: 'a', group: ' G ' },
          { value: 'b', group: 'G' },
        ],
      },
    ];
    const { container } = render(<SegmentList segments={segs} env={env()} />);
    const labels = Array.from(container.querySelectorAll('.k-q-group-label')).map((el) => el.textContent);
    expect(labels).toEqual(['G']);
    fireEvent.click(screen.getByText('a'));
    fireEvent.click(screen.getByText('b'));
    expect(isOn('a')).toBe(false);
    expect(isOn('b')).toBe(true);
  });

  it('single-select with groups + subtitles: shows headers, picks immediately, no confirm, no aria-pressed', () => {
    const onPick = vi.fn();
    const segs: Segment[] = [
      {
        type: 'question',
        prompt: 'pick one',
        multi: false,
        choices: ['x1', 'y1'],
        choice_items: [
          { value: 'x1', name: 'X-One', subtitle: 'sub x', group: 'X' },
          { value: 'y1', name: 'Y-One', group: 'Y' },
        ],
      },
    ];
    const { container } = render(<SegmentList segments={segs} env={env({ onPick })} />);
    expect(Array.from(container.querySelectorAll('.k-q-group-label')).map((el) => el.textContent)).toEqual(['X', 'Y']);
    expect(container.querySelector('.k-choice-confirm')).toBeNull();
    const btn = screen.getByText('X-One').closest('button')!;
    expect(btn.hasAttribute('aria-pressed')).toBe(false);
    expect(btn.classList.contains('has-sub')).toBe(true);
    expect(screen.getByText('sub x').className).toBe('k-choice-sub');
    fireEvent.click(btn);
    // Emits the value, not the display name.
    expect(onPick).toHaveBeenCalledWith('m1', ['x1']);
  });

  it('choice_items shorter than choices: missing entries fall back to the raw value and are ungrouped', () => {
    const onPick = vi.fn();
    const segs: Segment[] = [
      {
        type: 'question',
        prompt: '',
        multi: true,
        choices: ['g-a', 'g-b', 'plain'],
        choice_items: [
          { value: 'g-a', name: 'GA', group: 'G' },
          { value: 'g-b', name: 'GB', group: 'G' },
        ],
      },
    ];
    const { container } = render(<SegmentList segments={segs} env={env({ onPick })} />);
    expect(container.querySelectorAll('.k-q-group')).toHaveLength(2);
    expect(screen.getByText('plain').closest('button')).not.toBeNull();
    fireEvent.click(screen.getByText('GA'));
    fireEvent.click(screen.getByText('plain'));
    fireEvent.click(screen.getByText('GB'));
    fireEvent.click(screen.getByRole('button', { name: '确认选择 (2)' }));
    expect(onPick).toHaveBeenCalledWith('m1', ['g-b', 'plain']);
  });

  it('duplicate choice_items values: the first item wins for name / group', () => {
    const segs: Segment[] = [
      {
        type: 'question',
        prompt: '',
        multi: true,
        choices: ['v'],
        choice_items: [
          { value: 'v', name: 'First', group: 'G1' },
          { value: 'v', name: 'Second', group: 'G2' },
        ],
      },
    ];
    const { container } = render(<SegmentList segments={segs} env={env()} />);
    expect(screen.getByText('First')).toBeTruthy();
    expect(screen.queryByText('Second')).toBeNull();
    expect(Array.from(container.querySelectorAll('.k-q-group-label')).map((el) => el.textContent)).toEqual(['G1']);
  });

  it('clicking the selected option in a group deselects it (group can be left empty)', () => {
    const segs: Segment[] = [
      {
        type: 'question',
        prompt: '',
        multi: true,
        choices: ['a', 'b'],
        choice_items: [
          { value: 'a', group: 'G' },
          { value: 'b', group: 'G' },
        ],
      },
    ];
    render(<SegmentList segments={segs} env={env()} />);
    fireEvent.click(screen.getByText('a'));
    fireEvent.click(screen.getByText('a'));
    expect(isOn('a')).toBe(false);
    expect(screen.getByRole('button', { name: '确认选择 (0)' }).hasAttribute('disabled')).toBe(true);
  });

  it('max=1 across groups: blocks a second group but still allows swapping inside the selected group', () => {
    const onPick = vi.fn();
    const segs: Segment[] = [
      {
        type: 'question',
        prompt: '',
        multi: true,
        max: 1,
        choices: ['a1', 'a2', 'b1'],
        choice_items: [
          { value: 'a1', group: 'A' },
          { value: 'a2', group: 'A' },
          { value: 'b1', group: 'B' },
        ],
      },
    ];
    render(<SegmentList segments={segs} env={env({ onPick })} />);
    fireEvent.click(screen.getByText('a1'));
    fireEvent.click(screen.getByText('b1'));
    expect(isOn('b1')).toBe(false);
    fireEvent.click(screen.getByText('a2'));
    expect(isOn('a1')).toBe(false);
    expect(isOn('a2')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '确认选择 (1/1)' }));
    expect(onPick).toHaveBeenCalledWith('m1', ['a2']);
  });

  it('resets the in-progress selection when the question id changes', () => {
    const mk = (id: string): Segment[] => [
      {
        type: 'question',
        prompt: '',
        multi: true,
        question_message_id: id,
        choices: ['a', 'b'],
        choice_items: [
          { value: 'a', group: 'G' },
          { value: 'b', group: 'H' },
        ],
      },
    ];
    const e = env();
    const { rerender } = render(<SegmentList segments={mk('q1')} env={e} />);
    fireEvent.click(screen.getByText('a'));
    expect(isOn('a')).toBe(true);
    rerender(<SegmentList segments={mk('q2')} env={e} />);
    expect(isOn('a')).toBe(false);
    expect(screen.getByRole('button', { name: '确认选择 (0)' })).toBeTruthy();
  });

  it('named group sections expose role=group with accessible label while ungrouped sections omit role=group', () => {
    const segs: Segment[] = [
      {
        type: 'question',
        prompt: '',
        multi: true,
        choices: ['a', 'u'],
        choice_items: [{ value: 'a', group: '明日香' }, { value: 'u' }],
      },
    ];
    render(<SegmentList segments={segs} env={env()} />);
    expect(screen.getByRole('group', { name: '明日香' })).toBeTruthy();
    expect(screen.getAllByRole('group')).toHaveLength(1);
  });

  it('CharacterPickerCard multi-select enforces per-group exclusion and still honours max across groups', () => {
    const onPick = vi.fn();
    const segs: Segment[] = [
      {
        type: 'question',
        prompt: '',
        multi: true,
        max: 2,
        choices: ['a1', 'a2', 'b1', 'c1'],
        choice_items: [
          { value: 'a1', avatar: 'ref:a1', group: 'A' },
          { value: 'a2', avatar: 'ref:a2', group: 'A' },
          { value: 'b1', avatar: 'ref:b1', group: 'B' },
          { value: 'c1', avatar: 'ref:c1' },
        ],
      },
    ];
    const { container } = render(<SegmentList segments={segs} env={env({ onPick })} />);
    const hit = (v: string) => container.querySelector(`[data-testid="cpick-card"][data-value="${v}"] .k-cpick-hit`) as HTMLElement;
    const pressed = (v: string) => hit(v).getAttribute('aria-pressed');
    fireEvent.click(hit('a1'));
    fireEvent.click(hit('a2'));
    expect(pressed('a1')).toBe('false');
    expect(pressed('a2')).toBe('true');
    fireEvent.click(hit('b1'));
    // At max=2: an ungrouped card is blocked, an in-group swap is still allowed.
    fireEvent.click(hit('c1'));
    expect(pressed('c1')).toBe('false');
    fireEvent.click(hit('a1'));
    expect(pressed('a1')).toBe('true');
    expect(pressed('a2')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: '确认选择 (2/2)' }));
    expect(onPick).toHaveBeenCalledWith('m1', ['b1', 'a1']);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { cardMedia, useImageUrl } from '../../src/features/cards/util';
import type { MediaRef } from '../../src/features/cards/types';

afterEach(() => cleanup());

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

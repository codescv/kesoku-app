import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kesoku } from '../src/lib/client';
import { actions, initialState, useStore } from '../src/lib/store';

beforeEach(() => {
  useStore.setState(initialState(), true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('kesoku.resolveMedia placeholder fallback', () => {
  it('an unknown placeholder with a durable ref hydrates the ref immediately (no long wait)', async () => {
    const rpc = vi.spyOn(kesoku, 'rpc').mockResolvedValue({ kind: 'image', url: 'https://media.test/0987.webp' } as never);
    const url = await kesoku.resolveMedia({ placeholder_id: 'ph_lost', ref: 'pkmn/0987.webp' }, { sessionId: 's1' });
    expect(url).toBe('https://media.test/0987.webp');
    expect(rpc).toHaveBeenCalledWith('media.hydrate', expect.objectContaining({ ref: 'pkmn/0987.webp', session_id: 's1' }), expect.anything());
  });

  it('a failed placeholder still falls back to the ref', async () => {
    actions.setMedia('ph_bad', { status: 'failed' });
    vi.spyOn(kesoku, 'rpc').mockResolvedValue({ kind: 'image', url: 'https://media.test/r.webp' } as never);
    expect(await kesoku.resolveMedia({ placeholder_id: 'ph_bad', ref: 'pkmn/r.webp' })).toBe('https://media.test/r.webp');
  });

  it('a pending placeholder waits only briefly before using the ref', async () => {
    vi.useFakeTimers();
    actions.setMedia('ph_slow', { status: 'pending' });
    const rpc = vi.spyOn(kesoku, 'rpc').mockResolvedValue({ kind: 'image', url: 'https://media.test/s.webp' } as never);
    const p = kesoku.resolveMedia({ placeholder_id: 'ph_slow', ref: 'pkmn/s.webp' });
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await p).toBe('https://media.test/s.webp');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('a placeholder that becomes ready wins over the ref', async () => {
    actions.setMedia('ph_ok', { status: 'pending' });
    const rpc = vi.spyOn(kesoku, 'rpc');
    const p = kesoku.resolveMedia({ placeholder_id: 'ph_ok', ref: 'pkmn/o.webp' });
    actions.setMedia('ph_ok', { status: 'ready', url: 'https://media.test/live.webp' });
    expect(await p).toBe('https://media.test/live.webp');
    expect(rpc).not.toHaveBeenCalled();
  });
});

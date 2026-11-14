import { describe, expect, it } from 'vitest';
import { detectActiveMode, normalizeModeId } from '../src';

const games = (list: unknown) => ({ 'game/games.json': list });

describe('detectActiveMode', () => {
  it('falls back to chat when nothing is active', () => {
    expect(detectActiveMode(undefined).modeId).toBe('chat');
    expect(detectActiveMode({}).modeId).toBe('chat');
    expect(detectActiveMode(games([])).modeId).toBe('chat');
    expect(detectActiveMode(games([{ id: 'gal#1', game: 'galgame', active: false }])).modeId).toBe('chat');
    expect(detectActiveMode(games([{ id: 'pk#1', game: 'pokemon_duel', archived: true }])).modeId).toBe('chat');
  });

  it('maps legacy package names', () => {
    expect(normalizeModeId('companion')).toBe('galgame');
    expect(normalizeModeId('frontier_trpg')).toBe('trpg');
    expect(normalizeModeId('pkmn')).toBe('pokemon_assistant');
    expect(detectActiveMode(games([{ id: 'c#1', game: 'companion', active: true }])).modeId).toBe('galgame');
    expect(detectActiveMode(games([{ id: 't#1', game: 'frontier_trpg', active: true }])).modeId).toBe('trpg');
    expect(detectActiveMode(games({ instances: [{ id: 'j#1', short: 'jp', active: true }] })).modeId).toBe('jp_classroom');
  });

  it('returns the outermost parent and the nested child', () => {
    const r = detectActiveMode(
      games([
        { id: 'trpg#1', game: 'trpg', active: true, slots: { world: '夜之城' } },
        { id: 'jp#2', game: 'jp_classroom', active: true, parent: 'trpg#1' },
      ]),
    );
    expect(r.modeId).toBe('trpg');
    expect(r.instance?.id).toBe('trpg#1');
    expect(r.nested?.id).toBe('jp#2');
  });

  it('maps unknown packages to chat with unknownGame', () => {
    const r = detectActiveMode(games([{ id: 's#1', game: 'stage_contest', active: true }]));
    expect(r.modeId).toBe('chat');
    expect(r.unknownGame).toBe('stage_contest');
  });

  it('tolerates malformed games.json', () => {
    for (const bad of ['oops', 42, null, { instances: 'x' }, [null, 1, 'a']]) {
      expect(detectActiveMode(games(bad)).modeId).toBe('chat');
    }
  });
});

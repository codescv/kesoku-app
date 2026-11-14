import { MODE_IDS, type ModeId } from '@kesoku/protocol';

export interface GameInstance {
  id?: string;
  game?: string;
  short?: string;
  title?: string;
  active?: boolean;
  parent?: string;
  slots?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  archived?: boolean;
  [k: string]: unknown;
}

export interface ActiveMode {
  /** One of the 8 known modes (`chat` when nothing is active). Unknown packages map to `chat` with `unknownGame` set. */
  modeId: ModeId;
  instance: GameInstance | null;
  /** Active nested child (when games.json has several active entries). */
  nested: GameInstance | null;
  unknownGame?: string;
}

const LEGACY: Record<string, ModeId> = {
  companion: 'galgame',
  gal: 'galgame',
  frontier_trpg: 'trpg',
  travel: 'travel_companion',
  tr: 'translator',
  jp: 'jp_classroom',
  pkmn: 'pokemon_assistant',
  theater: 'story_theater',
};

export function normalizeModeId(game: string | undefined | null): ModeId | null {
  if (!game) return null;
  if ((MODE_IDS as readonly string[]).includes(game)) return game as ModeId;
  return LEGACY[game] ?? null;
}

function instances(raw: unknown): GameInstance[] {
  if (Array.isArray(raw)) return raw.filter((x): x is GameInstance => !!x && typeof x === 'object');
  if (raw && typeof raw === 'object' && Array.isArray((raw as { instances?: unknown }).instances)) {
    return instances((raw as { instances: unknown }).instances);
  }
  return [];
}

/**
 * Client never stores mode truth: current mode = outermost active top-level entry of
 * `game/games.json` (UI doc §3.1 note, Blueprint §6.5 step 1).
 */
export function detectActiveMode(stateFiles: Record<string, unknown> | undefined | null): ActiveMode {
  const list = instances(stateFiles?.['game/games.json']);
  const active = list.filter((i) => i.active !== false && !i.archived);
  if (!active.length) return { modeId: 'chat', instance: null, nested: null };
  const ids = new Set(active.map((i) => String(i.id ?? '')));
  // Outermost parent = an active entry whose parent is not itself active; prefer the last one.
  const tops = active.filter((i) => !i.parent || !ids.has(String(i.parent)));
  const top = tops[tops.length - 1] ?? active[active.length - 1];
  const nested = active.length > 1 ? active[active.length - 1] : null;
  const modeId = normalizeModeId(top.game ?? top.short);
  if (!modeId) return { modeId: 'chat', instance: top, nested: nested !== top ? nested : null, unknownGame: String(top.game ?? '') };
  return { modeId, instance: top, nested: nested !== top ? nested : null };
}

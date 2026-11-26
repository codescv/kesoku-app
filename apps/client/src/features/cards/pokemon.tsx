import type { CSSProperties } from 'react';
import { useLocale, useT } from '@kesoku/ui';
import { Fold } from './parts';
import type { CardContext, GlossaryEntry } from './types';
import { arr, strList, typeColor, VERSION_LABEL, type Dict, type GameVersion } from './util';

export function TypeBadge({ t }: { t: string }) {
  return (
    <span className="kc-type" style={{ '--type': typeColor(t) } as CSSProperties}>
      {t}
    </span>
  );
}

export function VersionBadge({ v }: { v: GameVersion }) {
  useLocale();
  return <span className={`kc-badge kc-ver kc-ver-${v}`}>{VERSION_LABEL[v]}</span>;
}

export interface Matchup {
  x4: string[];
  x2: string[];
  x05: string[];
  x025: string[];
  x0: string[];
}

export function matchupOf(v: unknown): Matchup {
  const m = (v && typeof v === 'object' ? v : {}) as Dict;
  return {
    x4: strList(m.x4),
    x2: strList(m.x2),
    x05: strList(m.x05 ?? m['x0.5']),
    x025: strList(m.x025 ?? m['x0.25']),
    x0: strList(m.x0),
  };
}

const ICE_ICON: Record<string, string> = { 冰: '❄️', ice: '❄️', 火: '🔥', fire: '🔥', 水: '💧', water: '💧', 电: '⚡', electric: '⚡', 岩石: '🪨', rock: '🪨', 草: '🌿', grass: '🌿', 地面: '⛰️', ground: '⛰️', 格斗: '🥊', fighting: '🥊', 妖精: '✨', fairy: '✨', 龙: '🐉', dragon: '🐉' };

/** Weakness capsules: full-width 4× capsule, 2× row, then (optionally folded) resistances. */
export function MatchupRows({ m, foldResist }: { m: Matchup; foldResist: boolean }) {
  const t = useT();
  const resist = (
    <div className="kc-resist">
      {m.x05.length > 0 && (
        <span className="kc-mu-row">
          <b>½×</b> {m.x05.join(' · ')}
        </span>
      )}
      {m.x025.length > 0 && (
        <span className="kc-mu-row">
          <b>¼×</b> {m.x025.join(' · ')}
        </span>
      )}
      {m.x0.length > 0 && (
        <span className="kc-mu-row">
          <b>0×</b> {m.x0.join(' · ')}
        </span>
      )}
    </div>
  );
  const hasResist = m.x05.length + m.x025.length + m.x0.length > 0;
  return (
    <div className="kc-mu">
      {m.x4.length > 0 && (
        <div className="kc-mu-x4" role="note">
          <span aria-hidden>{ICE_ICON[m.x4[0]] ?? '⚠️'}</span> {t('card.weak4x', { list: m.x4.join(' · ') })}
        </div>
      )}
      {m.x2.length > 0 && (
        <div className="kc-mu-x2">
          <b>2×</b> {t('card.weak2x', { list: m.x2.join(' · ') })}
        </div>
      )}
      {hasResist && (foldResist ? <Fold title={t('card.resist')}>{resist}</Fold> : resist)}
    </div>
  );
}

/** Clickable glossary pill (`多重鳞片 ▸`) → Wiki Peek Sheet; plain badge when the entry is missing. */
export function GlossPill({
  id,
  label,
  glossary,
  ctx,
  prefix,
}: {
  id?: string;
  label: string;
  glossary: Record<string, GlossaryEntry>;
  ctx: CardContext;
  prefix?: string;
}) {
  const entry = id ? glossary[id] : Object.values(glossary).find((g) => g.title === label);
  const text = `${prefix ?? ''}${label}`;
  if (!entry) return <span className="kc-gloss is-static">{text}</span>;
  return (
    <button type="button" className="kc-gloss" onClick={() => ctx.openPeek(entry, glossary)}>
      {text} <span aria-hidden>▸</span>
    </button>
  );
}

/** Ability / pill objects `{zh|label, id?}` or strings. */
export function labelled(v: unknown): Array<{ id?: string; label: string }> {
  return arr(v)
    .map((x) => {
      if (typeof x === 'string') return { label: x };
      if (x && typeof x === 'object') {
        const o = x as Dict;
        const label = String(o.label ?? o.zh ?? o.name ?? o.title ?? '').trim();
        const id = typeof o.id === 'string' ? o.id : typeof o.glossary_id === 'string' ? o.glossary_id : undefined;
        return { id, label };
      }
      return { label: '' };
    })
    .filter((x) => x.label);
}

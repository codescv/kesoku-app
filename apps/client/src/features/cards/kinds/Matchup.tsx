import { useState } from 'react';
import type { CardProps } from '../types';
import { CardShell } from '../parts';
import { TypeBadge, VersionBadge } from '../pokemon';
import { arr, isObj, obj, pick, strList, versionOf, type Dict } from '../util';

const TIERS: Array<{ id: string; label: string; tone: string }> = [
  { id: 'best', label: '首选', tone: 'danger' },
  { id: 'ok', label: '可用', tone: 'primary' },
  { id: 'risky', label: '慎上', tone: 'warn' },
];

function tierOf(v: unknown): string {
  const s = String(v ?? '').toLowerCase();
  if (s === 'best' || s === '首选') return 'best';
  if (s === 'risky' || s === '慎上') return 'risky';
  return 'ok';
}

/** `pkmn_matchup` counter-picks: 首选 / 可用 / 慎上 tiers, reason expands in one line. */
export function Matchup({ data }: CardProps<Dict>) {
  const d = obj(data);
  const v = versionOf(d);
  const target = pick(d, 'target_name', 'target');
  const picks = (arr(d.picks).filter(isObj) as Dict[]).map((p, i) => ({
    key: i,
    name: pick(p, 'name', 'name_zh', 'species_id'),
    types: strList(p.types),
    tier: tierOf(p.tier),
    reason: pick(p, 'reason', 'why'),
  }));
  const [open, setOpen] = useState<number | null>(null);
  return (
    <CardShell
      kind="pkmn_matchup"
      className={`kc-pkmn kc-pkmn-${v}`}
      head={
        <>
          <span className="kc-title">⚔️ 反制对位{target ? ` · ${target}` : ''}</span>
          <VersionBadge v={v} />
        </>
      }
    >
      <ul className="kc-mu-list">
        {TIERS.flatMap((t) =>
          picks
            .filter((p) => p.tier === t.id && p.name)
            .map((p) => (
              <li key={p.key} className={'kc-mu-pick' + (open === p.key ? ' is-open' : '')}>
                <button type="button" className="kc-mu-pick-btn" aria-expanded={open === p.key} onClick={() => setOpen((o) => (o === p.key ? null : p.key))}>
                  <span className={`kc-badge kc-badge-${t.tone}`}>{t.label}</span>
                  <b className="kc-mu-name">{p.name}</b>
                  {p.types.map((ty) => (
                    <TypeBadge key={ty} t={ty} />
                  ))}
                  {p.reason && (
                    <span className="kc-fold-caret" aria-hidden>
                      {open === p.key ? '▾' : '▸'}
                    </span>
                  )}
                </button>
                {open === p.key && p.reason && <div className="kc-mu-reason">{p.reason}</div>}
              </li>
            )),
        )}
      </ul>
    </CardShell>
  );
}

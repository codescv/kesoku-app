import { useState } from 'react';
import type { CardProps } from '../types';
import { CardShell, Fold } from '../parts';
import { GlossPill, MatchupRows, TypeBadge, VersionBadge, labelled, matchupOf } from '../pokemon';
import { arr, glossaryMap, isObj, obj, pick, strList, versionOf, type Dict } from '../util';

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

const CAT_LABEL: Record<string, string> = { ability: '特性', item: '道具', mechanic: '机制', weather: '天气' };

/** `pkmn_glossary` standalone wiki card for an ability, item, mechanic, or weather entry. */
export function PkmnGlossary({ data, ctx }: CardProps<Dict>) {
  const d = obj(data);
  const v = versionOf(d);
  const glossary = glossaryMap(d.glossary);
  const title = pick(d, 'title', 'name', 'entry_id');
  const cat = pick(d, 'category');
  const summary = pick(d, 'summary');
  const detail = pick(d, 'detail_markdown', 'details_md', 'detail', 'details');
  const pills = strList(d.pills ?? d.effect_pills);
  const related = labelled(d.related);
  return (
    <CardShell
      kind="pkmn_glossary"
      className={`kc-pkmn kc-pkmn-${v}`}
      head={
        <>
          <span className="kc-title">📖 {title}</span>
          {cat && <span className="kc-badge kc-badge-tag">{CAT_LABEL[cat] ?? cat}</span>}
          <VersionBadge v={v} />
        </>
      }
    >
      {pills.length > 0 && (
        <div className="kc-chips">
          {pills.map((p) => (
            <span key={p} className="kc-badge kc-badge-primary">
              {p}
            </span>
          ))}
        </div>
      )}
      {summary && <p className="kc-summary">{summary}</p>}
      {detail && (
        <Fold title="机制详解">
          <p className="kc-detail">{detail}</p>
        </Fold>
      )}
      {related.length > 0 && (
        <div className="kc-chips">
          <span className="kc-chip-k">关联</span>
          {related.map((r) => (
            <GlossPill key={r.id ?? r.label} id={r.id} label={r.label} glossary={glossary} ctx={ctx} />
          ))}
        </div>
      )}
    </CardShell>
  );
}

/** `pkmn_type_chart` offensive & defensive effectiveness card for a single Pokémon type. */
export function PkmnTypeChart({ data }: CardProps<Dict>) {
  const d = obj(data);
  const v = versionOf(d);
  const typeName = pick(d, 'type', 'name');
  const off = obj(d.offense);
  const offX2 = strList(off.x2);
  const offX05 = strList(off.x05 ?? off['x0.5']);
  const offX0 = strList(off.x0);
  const def = matchupOf(d.defense);
  return (
    <CardShell
      kind="pkmn_type_chart"
      className={`kc-pkmn kc-pkmn-${v}`}
      head={
        <>
          <span className="kc-title">🧭 属性相克</span>
          {typeName && <TypeBadge t={typeName} />}
          <VersionBadge v={v} />
        </>
      }
    >
      <div className="kc-mu">
        {offX2.length > 0 && (
          <div className="kc-mu-x2">
            <b>⚔️ 2× 克制</b>：{offX2.join(' · ')}
          </div>
        )}
        {(offX05.length > 0 || offX0.length > 0) && (
          <div className="kc-resist">
            {offX05.length > 0 && (
              <span className="kc-mu-row">
                <b>⚔️ ½×</b> {offX05.join(' · ')}
              </span>
            )}
            {offX0.length > 0 && (
              <span className="kc-mu-row">
                <b>⚔️ 0×</b> {offX0.join(' · ')}
              </span>
            )}
          </div>
        )}
      </div>
      <MatchupRows m={def} foldResist={false} />
    </CardShell>
  );
}

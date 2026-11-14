import type { CardProps } from '../types';
import { CardShell } from '../parts';
import { GlossPill, TypeBadge, VersionBadge, labelled } from '../pokemon';
import { arr, glossaryMap, isObj, num, obj, pick, versionOf, type Dict } from '../util';

const CATEGORY: Record<string, string> = { physical: '物理', special: '特殊', status: '变化' };

/** `pkmn_move_wiki` card: SV shows `PP · 先制`; Z-A shows `冷却 CD · 射程 · 招式＋` — never mixed. */
export function MoveWiki({ data, ctx }: CardProps<Dict>) {
  const d = obj(data);
  const v = versionOf(d);
  const name = obj(d.name);
  const zh = pick(name, 'zh') || pick(d, 'name_zh', 'name');
  const alt = [pick(name, 'ja'), pick(name, 'en')].filter(Boolean).join(' · ');
  const type = pick(d, 'type');
  const cat = pick(d, 'category_zh') || CATEGORY[pick(d, 'category').toLowerCase()] || pick(d, 'category');
  const power = num(d.power);
  const acc = num(d.accuracy);
  const glossary = glossaryMap(d.glossary);
  const pills = (arr(d.pills).filter(isObj) as Dict[]).map((p) => ({ id: pick(p, 'id') || undefined, label: pick(p, 'label', 'title', 'zh') })).filter((p) => p.label);
  const extraPills = pills.length ? [] : labelled(Object.values(glossary).map((g) => ({ id: g.id, label: g.title })));

  const pp = v === 'sv' ? num(d.pp) : null;
  const prio = v === 'sv' ? num(d.priority) : null;
  const cd = v === 'za' ? num(d.cd_s ?? d.cd_sec) : null;
  const range = v === 'za' ? pick(d, 'range') : '';
  const plus = v === 'za' ? pick(d, 'plus_effect') : '';

  const spec = [type, cat, power !== null ? `威力 ${power}` : '', acc !== null ? `命中 ${acc}` : ''].filter(Boolean).join(' · ');

  return (
    <CardShell kind="pkmn_move_wiki" className={`kc-pkmn kc-pkmn-${v}`}>
      <div className="kc-mv-head">
        <b className="kc-mv-name">⚡ {zh || '招式'}</b>
        {type && <TypeBadge t={type} />}
        {spec && <span className="kc-mv-spec">{spec}</span>}
        <VersionBadge v={v} />
      </div>
      {alt && <div className="kc-dex-alt">{alt}</div>}
      <div className="kc-chips">
        {pp !== null && <span className="kc-badge kc-badge-primary">PP {pp}</span>}
        {prio !== null && prio !== 0 && <span className="kc-badge kc-badge-primary">先制 {prio > 0 ? `+${prio}` : prio}</span>}
        {cd !== null && <span className="kc-badge kc-badge-danger">⏱ 冷却 CD {cd}s</span>}
        {range && <span className="kc-badge kc-badge-accent">🎯 {range}</span>}
        {plus && <span className="kc-badge kc-badge-warn">✦ 招式＋ {plus}</span>}
      </div>
      {pick(d, 'effect_short', 'effect') && <p className="kc-mv-effect">{pick(d, 'effect_short', 'effect')}</p>}
      {(pills.length > 0 || extraPills.length > 0) && (
        <div className="kc-chips">
          <span className="kc-chip-k">内联百科</span>
          {[...pills, ...extraPills].map((p) => (
            <GlossPill key={p.label} id={p.id} label={p.label} glossary={glossary} ctx={ctx} />
          ))}
        </div>
      )}
    </CardShell>
  );
}

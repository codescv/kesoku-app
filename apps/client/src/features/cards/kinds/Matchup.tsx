import { useState } from 'react';
import { useT, type MessageKey } from '@kesoku/ui';
import type { CardProps } from '../types';
import { CardShell, Fold } from '../parts';
import { GlossPill, MatchupRows, TypeBadge, VersionBadge, labelled, matchupOf } from '../pokemon';
import { arr, glossaryMap, isObj, obj, pick, strList, versionOf, type Dict } from '../util';

const TIERS: Array<{ id: string; labelKey: MessageKey; tone: string }> = [
  { id: 'best', labelKey: 'card.tier.best', tone: 'danger' },
  { id: 'ok', labelKey: 'card.tier.ok', tone: 'primary' },
  { id: 'risky', labelKey: 'card.tier.risky', tone: 'warn' },
];

function tierOf(v: unknown): string {
  const s = String(v ?? '').toLowerCase();
  if (s === 'best' || s === '首选') return 'best';
  if (s === 'risky' || s === '慎上') return 'risky';
  return 'ok';
}

/** `pkmn_matchup` counter-picks: Best / Viable / Risky tiers, reason expands in one line. */
export function Matchup({ data }: CardProps<Dict>) {
  const t = useT();
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
          <span className="kc-title">{t('card.matchupTitle')}{target ? ` · ${target}` : ''}</span>
          <VersionBadge v={v} />
        </>
      }
    >
      <ul className="kc-mu-list">
        {TIERS.flatMap((tier) =>
          picks
            .filter((p) => p.tier === tier.id && p.name)
            .map((p) => (
              <li key={p.key} className={'kc-mu-pick' + (open === p.key ? ' is-open' : '')}>
                <button type="button" className="kc-mu-pick-btn" aria-expanded={open === p.key} onClick={() => setOpen((o) => (o === p.key ? null : p.key))}>
                  <span className={`kc-badge kc-badge-${tier.tone}`}>{t(tier.labelKey)}</span>
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

const CAT_KEYS: Record<string, MessageKey> = {
  ability: 'card.cat.ability',
  item: 'card.cat.item',
  mechanic: 'card.cat.mechanic',
  weather: 'card.cat.weather',
};

/** `pkmn_glossary` standalone wiki card for an ability, item, mechanic, or weather entry. */
export function PkmnGlossary({ data, ctx }: CardProps<Dict>) {
  const t = useT();
  const d = obj(data);
  const v = versionOf(d);
  const glossary = glossaryMap(d.glossary);
  const title = pick(d, 'title', 'name', 'entry_id');
  const cat = pick(d, 'category');
  const catLabel = CAT_KEYS[cat] ? t(CAT_KEYS[cat]) : cat;
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
          {cat && <span className="kc-badge kc-badge-tag">{catLabel}</span>}
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
        <Fold title={t('card.detailFold')}>
          <p className="kc-detail">{detail}</p>
        </Fold>
      )}
      {related.length > 0 && (
        <div className="kc-chips">
          <span className="kc-chip-k">{t('card.related')}</span>
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
  const t = useT();
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
          <span className="kc-title">{t('card.typeChartTitle')}</span>
          {typeName && <TypeBadge t={typeName} />}
          <VersionBadge v={v} />
        </>
      }
    >
      <div className="kc-mu">
        {offX2.length > 0 && (
          <div className="kc-mu-x2">
            <b>{t('card.offense2x')}</b>: {offX2.join(' · ')}
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

import { useT, type MessageKey } from '@kesoku/ui';
import type { CardProps } from '../types';
import { CardShell } from '../parts';
import { GlossPill, MatchupRows, TypeBadge, VersionBadge, labelled, matchupOf } from '../pokemon';
import { cardMedia, glossaryMap, num, obj, pick, strList, useImageUrl, versionOf, type Dict } from '../util';

const STAT_KEYS: Array<[string, MessageKey]> = [
  ['hp', 'card.stat.hp'],
  ['atk', 'card.stat.atk'],
  ['def', 'card.stat.def'],
  ['spa', 'card.stat.spa'],
  ['spd', 'card.stat.spd'],
  ['spe', 'card.stat.spe'],
];

function signed(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '±0';
}

/**
 * `pokemon_dex` card (Screen 11). Strictly version-gated: SV shows abilities, Z-A shows the Mega stone and
 * Mega stat deltas — fields of the other game are never rendered even if present.
 */
export function PokemonDex({ data, ctx }: CardProps<Dict>) {
  const t = useT();
  const d = obj(data);
  const v = versionOf(d);
  const name = obj(d.name);
  const zh = pick(name, 'zh') || pick(d, 'name_zh', 'name');
  const ja = pick(name, 'ja');
  const en = pick(name, 'en');
  const sid = pick(d, 'species_id', 'id');
  const form = pick(d, 'form');
  const types = strList(d.types);
  const bst = num(d.bst);
  const stats = obj(d.stats);
  const delta = v === 'za' ? obj(d.stat_delta) : {};
  const glossary = glossaryMap(d.glossary);
  const m = matchupOf(d.matchup);
  const artRef = cardMedia(ctx, ['artwork', 'art', 'image', 'sprite'], d.artwork ?? d.art ?? d.image ?? d.sprite ?? d.image_url);
  const artUrl = useImageUrl(ctx.resolveMedia, artRef);
  const abilities = v === 'sv' ? labelled(d.abilities) : [];
  const megaStone = v === 'za' ? pick(d, 'mega_stone') : '';
  const megaStoneId = v === 'za' ? pick(d, 'mega_stone_id') || undefined : undefined;

  const deltaText = STAT_KEYS.map(([k, labelKey]) => {
    const n = num(delta[k]);
    return n ? `${t(labelKey)} ${signed(n)}` : '';
  })
    .filter(Boolean)
    .join(' · ');

  // Entries already shown as pills — or belonging to the other game's gated fields — never appear as extras.
  const allAbilities = labelled(d.abilities);
  const allStone = pick(d, 'mega_stone');
  const hidden = new Set<string>([...allAbilities.map((a) => a.id ?? ''), ...allAbilities.map((a) => a.label), pick(d, 'mega_stone_id'), allStone].filter(Boolean));
  const extra = Object.values(glossary).filter((g) => {
    if (hidden.has(g.id) || hidden.has(g.title)) return false;
    const cat = (g.category ?? '').toLowerCase();
    if (v === 'za' && (cat === '特性' || cat === 'ability')) return false;
    if (v === 'sv' && /mega|超级进化/.test(cat + g.title)) return false;
    return true;
  });
  const maxStat = Math.max(160, ...STAT_KEYS.map(([k]) => num(stats[k]) ?? 0));

  return (
    <CardShell kind="pokemon_dex" className={`kc-pkmn kc-pkmn-${v}`}>
      <div className="kc-dex-top">
        <button
          type="button"
          className="kc-dex-art"
          aria-label={t('card.pkmnArtAria', { name: zh || en || '' })}
          onClick={() => artUrl && ctx.openFullscreen(<img className="kc-full-img" src={artUrl} alt={zh} />)}
        >
          {artUrl ? <img src={artUrl} alt={zh} draggable={false} /> : <span aria-hidden>{artRef && artUrl === undefined ? '…' : '◓'}</span>}
          {form && /mega/i.test(form) && <span className="kc-dex-mega">MEGA</span>}
        </button>
        <div className="kc-dex-id">
          <div className="kc-dex-name">
            <b>{zh || en || t('card.pkmnUnknown')}</b>
            {sid && <span className="kc-dex-no">#{/^\d+$/.test(sid) ? sid.padStart(4, '0') : sid}</span>}
            <VersionBadge v={v} />
          </div>
          {(ja || en) && <div className="kc-dex-alt">{[ja, en].filter(Boolean).join(' · ')}</div>}
          <div className="kc-dex-types">
            {types.map((tp) => (
              <TypeBadge key={tp} t={tp} />
            ))}
            {bst !== null && (
              <span className="kc-badge kc-badge-bst">
                BST {bst}
                {deltaText && ` (${deltaText})`}
              </span>
            )}
          </div>
        </div>
      </div>

      <MatchupRows m={m} foldResist />

      {STAT_KEYS.some(([k]) => num(stats[k]) !== null) && (
        <div className="kc-stats">
          {STAT_KEYS.map(([k, labelKey]) => {
            const val = num(stats[k]);
            if (val === null) return null;
            const dv = num(delta[k]);
            return (
              <div key={k} className="kc-stat">
                <span className="kc-stat-k">{t(labelKey)}</span>
                <span className="kc-stat-v">{val}</span>
                <span className="kc-stat-bar">
                  <span style={{ width: `${Math.min(100, (val / maxStat) * 100)}%` }} className={val >= 120 ? 'is-hi' : val >= 80 ? 'is-mid' : 'is-lo'} />
                </span>
                {dv ? <span className={'kc-delta ' + (dv > 0 ? 'is-up' : 'is-down')}>{signed(dv)}</span> : <span className="kc-delta is-none" />}
              </div>
            );
          })}
        </div>
      )}

      {abilities.length > 0 && (
        <div className="kc-chips">
          <span className="kc-chip-k">{t('card.pkmnAbilities')}</span>
          {abilities.map((a) => (
            <GlossPill key={a.label} id={a.id} label={a.label} glossary={glossary} ctx={ctx} />
          ))}
        </div>
      )}
      {megaStone && (
        <div className="kc-chips">
          <GlossPill id={megaStoneId} label={megaStone} prefix={t('card.pkmnMegaStonePrefix')} glossary={glossary} ctx={ctx} />
        </div>
      )}
      {extra.length > 0 && (
        <div className="kc-chips">
          <span className="kc-chip-k">{t('card.pkmnGlossary')}</span>
          {extra.map((g) => (
            <GlossPill key={g.id} id={g.id} label={g.title} glossary={glossary} ctx={ctx} />
          ))}
        </div>
      )}
    </CardShell>
  );
}

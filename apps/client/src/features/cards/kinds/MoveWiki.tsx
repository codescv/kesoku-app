import { useT, type MessageKey } from '@kesoku/ui';
import type { CardProps } from '../types';
import { CardShell } from '../parts';
import { GlossPill, TypeBadge, VersionBadge, labelled } from '../pokemon';
import { arr, glossaryMap, isObj, num, obj, pick, versionOf, type Dict } from '../util';

/** First non-empty text among fields that may be a plain string or a localized `{zh, ja, en}` object. */
function textOf(d: Dict, ...keys: string[]): string {
  for (const k of keys) {
    const v = d[k];
    const s = isObj(v) ? pick(v, 'zh', 'text', 'ja', 'en') : pick(d, k);
    if (s) return s;
  }
  return '';
}

const CATEGORY_KEYS: Record<string, MessageKey> = {
  physical: 'card.moveCat.physical',
  special: 'card.moveCat.special',
  status: 'card.moveCat.status',
};

/** `pkmn_move_wiki` card: SV shows `PP · Priority`; Z-A shows `CD · Range · Move+` — never mixed. */
export function MoveWiki({ data, ctx }: CardProps<Dict>) {
  const t = useT();
  const d = obj(data);
  const v = versionOf(d);
  const name = obj(d.name);
  const zh = pick(name, 'zh') || pick(d, 'name_zh', 'name');
  const alt = [pick(name, 'ja'), pick(name, 'en')].filter(Boolean).join(' · ');
  const type = pick(d, 'type');
  const catRaw = pick(d, 'category').toLowerCase();
  const cat = pick(d, 'category_zh') || (CATEGORY_KEYS[catRaw] ? t(CATEGORY_KEYS[catRaw]) : pick(d, 'category'));
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

  const description = textOf(d, 'description', 'desc', 'flavor_text', 'description_zh');
  const effect = textOf(d, 'effect_short', 'effect', 'effect_zh');
  const showEffect = !!effect && effect !== description;

  const spec = [type, cat, power !== null ? t('card.movePower', { n: power }) : '', acc !== null ? t('card.moveAcc', { n: acc }) : ''].filter(Boolean).join(' · ');

  return (
    <CardShell kind="pkmn_move_wiki" className={`kc-pkmn kc-pkmn-${v}`}>
      <div className="kc-mv-head">
        <b className="kc-mv-name">⚡ {zh || t('card.moveFallback')}</b>
        {type && <TypeBadge t={type} />}
        {spec && <span className="kc-mv-spec">{spec}</span>}
        <VersionBadge v={v} />
      </div>
      {alt && <div className="kc-dex-alt">{alt}</div>}
      <div className="kc-chips">
        {pp !== null && <span className="kc-badge kc-badge-primary">PP {pp}</span>}
        {prio !== null && prio !== 0 && <span className="kc-badge kc-badge-primary">{t('card.movePriority', { n: prio > 0 ? `+${prio}` : prio })}</span>}
        {cd !== null && <span className="kc-badge kc-badge-danger">{t('card.moveCooldown', { s: cd })}</span>}
        {range && <span className="kc-badge kc-badge-accent">🎯 {range}</span>}
        {plus && <span className="kc-badge kc-badge-warn">{t('card.movePlus', { text: plus })}</span>}
      </div>
      {description && <p className="kc-mv-desc">{description}</p>}
      {showEffect && (
        <div className="kc-mv-effect">
          <b>{t('card.moveEffect')}</b>
          {effect}
        </div>
      )}
      {(pills.length > 0 || extraPills.length > 0) && (
        <div className="kc-chips">
          <span className="kc-chip-k">{t('card.inlineWiki')}</span>
          {[...pills, ...extraPills].map((p) => (
            <GlossPill key={p.label} id={p.id} label={p.label} glossary={glossary} ctx={ctx} />
          ))}
        </div>
      )}
    </CardShell>
  );
}

import { Component, useState, type ReactNode } from 'react';
import { HpBar, ProgressBar, t as tGlobal, useLocale, useT, type MessageKey } from '@kesoku/ui';
import { VERSION_LABELS, comboGauge, partyCombos, resolveGameVersion, trpgPhase, type HudPanel } from '@kesoku/hud';
import type { CardContext } from '../../cards/types';
import { MatchupRows, TypeBadge, matchupOf } from '../../cards/pokemon';
import { PokemonDex } from '../../cards/kinds/PokemonDex';
import { arr, isObj, num, obj, pick, str, strList, toMediaRef, useImageUrl, type Dict } from '../../cards/util';

export type ModePanelKind = HudPanel;

export interface ModePanelProps {
  panel: ModePanelKind | string;
  stateFiles: Record<string, unknown>;
  modePrefs: Record<string, unknown>;
  ctx: CardContext;
}

function file(stateFiles: Record<string, unknown> | undefined, name: string): Dict {
  return obj(stateFiles?.[name]);
}

function Panel({ title, badge, children, className }: { title: ReactNode; badge?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={['km-panel', className].filter(Boolean).join(' ')}>
      <header className="km-panel-head">
        <span className="km-panel-title">{title}</span>
        {badge}
      </header>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="km-empty">{children}</div>;
}

/* ------------------------------ mistakes ------------------------------ */

export function mistakeItems(stateFiles: Record<string, unknown>): Dict[] {
  const m = stateFiles?.['game/mistakes.json'];
  const lesson = file(stateFiles, 'game/lesson.json');
  let list: unknown[] = [];
  if (Array.isArray(m)) list = m;
  else if (isObj(m)) list = arr(m.due ?? m.items ?? m.active);
  if (!list.length) list = arr(lesson.mistakes ?? lesson.due_items ?? lesson.due_mistakes_items);
  return list.filter(isObj) as Dict[];
}

function MistakesPanel({ stateFiles, ctx }: { stateFiles: Record<string, unknown>; ctx: CardContext }) {
  const t = useT();
  const items = mistakeItems(stateFiles);
  return (
    <Panel title={t('panel.mistakesTitle')} badge={items.length ? <span className="kc-badge kc-badge-danger-soft">{t('panel.dueCount', { count: items.length })}</span> : undefined} className="km-mistakes">
      {!items.length && <Empty>{t('panel.noDueMistakes')}</Empty>}
      <ul className="km-list">
        {items.map((it, i) => {
          const point = pick(it, 'point', 'title', 'grammar', 'note');
          const lessonNo = pick(it, 'lesson');
          const wrong = pick(it, 'user_answer', 'wrong', 'answer');
          const right = pick(it, 'correct', 'right');
          const id = pick(it, 'id');
          return (
            <li key={id || i} className="km-mistake">
              <div className="km-mistake-main">
                <div className="km-mistake-point">
                  <b lang="ja">{point || t('panel.mistakeFallback')}</b>
                  {lessonNo && <span className="kc-badge kc-badge-tag">{/^\d+$/.test(lessonNo) ? t('hud.lessonNo', { no: lessonNo }) : lessonNo}</span>}
                </div>
                {(wrong || right) && (
                  <div className="km-mistake-fix" lang="ja">
                    {wrong && <span className="km-wrong">{t('panel.wrongPrefix')}{wrong}</span>}
                    {wrong && right && ' → '}
                    {right && <span className="km-right">{t('panel.rightPrefix')}{right}</span>}
                  </div>
                )}
              </div>
              <button type="button" className="km-kill" onClick={() => ctx.sendText(t('panel.killMistakePrompt', { id: id ? ` #${id}` : '', point }))} disabled={!point}>
                {t('panel.drillNow')}
              </button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/* ------------------------------ roster ------------------------------ */

function RosterAvatar({ refStr, name, ctx }: { refStr: string; name: string; ctx: CardContext }) {
  const t = useT();
  const ref = refStr ? toMediaRef({ ref: refStr }) : null;
  const url = useImageUrl(ctx.resolveMedia, ref);
  return (
    <button
      type="button"
      className="km-roster-av"
      aria-label={t('panel.rosterAvatarAria', { name })}
      onClick={() => url && ctx.openFullscreen(<img className="kc-full-img" src={url} alt={name} />)}
    >
      {url ? <img src={url} alt={name} draggable={false} /> : <span aria-hidden>{name.slice(0, 1)}</span>}
    </button>
  );
}

function RosterPanel({ stateFiles, ctx }: { stateFiles: Record<string, unknown>; ctx: CardContext }) {
  const t = useT();
  const roster = file(stateFiles, 'game/roster.json');
  const members = Object.entries(obj(roster.members ?? roster.cast ?? roster.characters)).filter(([, v]) => isObj(v)) as Array<[string, Dict]>;
  return (
    <Panel title={t('panel.rosterTitle')} badge={<span className="kc-badge kc-badge-mode">{members.length}</span>} className="km-roster">
      {!members.length && <Empty>{t('panel.noRoster')}</Empty>}
      <ul className="km-list">
        {members.map(([key, m]) => {
          const name = pick(m, 'name') || key;
          const base = obj(m.base_appearance);
          const ref = pick(m, 'ref') || pick(base, 'ref') || pick(m, 'visual_ref');
          const actor = pick(m, 'actor', 'cast', 'performer', 'display_name') || (ref ? ref.split('/').filter(Boolean).pop()?.replace(/[_-]+/g, ' ') ?? '' : '');
          const tags = [...strList(m.tags), ...strList(m.traits), ...strList(m.costume), ...strList(pick(m, 'outfit'))].slice(0, 6);
          const role = pick(m, 'role');
          return (
            <li key={key} className="km-roster-row">
              <RosterAvatar refStr={ref} name={name} ctx={ctx} />
              <div className="km-roster-main">
                <div className="km-roster-name">
                  <b>{name}</b>
                  {actor && <span className="km-roster-actor">· {actor}</span>}
                  {role && <span className="kc-badge kc-badge-warn">{role}</span>}
                </div>
                {tags.length > 0 && (
                  <div className="kc-chips">
                    {tags.map((t) => (
                      <span key={t} className="kc-badge kc-badge-tag">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/* ------------------------------ party ------------------------------ */

const ROLE_KEYS: Record<string, MessageKey> = {
  player: 'trpg.role.player',
  active: 'trpg.role.active',
  support: 'trpg.role.support',
  narrator: 'trpg.role.narrator',
  reserve: 'trpg.role.reserve',
};
const ATTR_KEYS: ReadonlyArray<readonly [string, MessageKey]> = [
  ['ac', 'trpg.attr.ac'],
  ['hit', 'trpg.attr.hit'],
  ['dmg', 'trpg.attr.dmg'],
  ['atk', 'trpg.attr.atk'],
  ['def', 'trpg.attr.def'],
  ['mp', 'trpg.attr.mp'],
  ['max_mp', 'trpg.attr.max_mp'],
  ['spd', 'trpg.attr.spd'],
  ['str', 'trpg.attr.str'],
  ['dex', 'trpg.attr.dex'],
  ['int', 'trpg.attr.int'],
  ['level', 'trpg.attr.level'],
  ['xp', 'trpg.attr.xp'],
  ['gold', 'trpg.attr.gold'],
];

function itemsList(v: unknown): string[] {
  return arr(v)
    .map((x) => {
      if (isObj(x)) {
        const n = pick(x, 'name', 'label', 'item');
        const q = num(x.qty ?? x.count);
        return n ? (q && q !== 1 ? `${n}×${q}` : n) : '';
      }
      return str(x);
    })
    .filter(Boolean);
}

const EQUIP_SLOTS: ReadonlyArray<readonly [string, MessageKey]> = [
  ['weapon', 'trpg.slot.weapon'],
  ['armor', 'trpg.slot.armor'],
  ['accessory', 'trpg.slot.accessory'],
];
const SKILL_TYPE_KEYS: Record<string, MessageKey> = {
  attack: 'trpg.skill.attack',
  control: 'trpg.skill.control',
  heal: 'trpg.skill.heal',
  guard: 'trpg.skill.guard',
  buff: 'trpg.skill.buff',
  transform: 'trpg.skill.transform',
  narrative: 'trpg.skill.narrative',
};

/** True for a set flag/text field (`true`, non-empty string other than "false"/"0", non-zero number). */
function flag(v: unknown): boolean {
  if (typeof v === 'string') return v.trim() !== '' && !/^(false|0|no)$/i.test(v.trim());
  if (typeof v === 'number') return v !== 0;
  return v === true;
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : String(n);
}

export interface EquipTag {
  kind: 'miss' | 'crit' | 'combo';
  text: string;
}

export interface EquipRow {
  slot: string;
  name: string;
  bonuses: string[];
  /** Exclusive gear granted by a personal quest. */
  exclusive: boolean;
  /** Trigger affixes: on-miss / on-crit text and combo-gauge gain. */
  tags: EquipTag[];
}

const COMBO_GAIN_KEYS: Record<string, MessageKey> = { hit: 'trpg.comboGain.hit', crit: 'trpg.comboGain.crit' };

/** Trigger text from the current `{ text, status, hp }` object or a legacy plain string. */
function triggerText(v: unknown): string {
  return isObj(v) ? pick(v, 'text') : str(v);
}

function equipTags(it: Dict): EquipTag[] {
  const tags: EquipTag[] = [];
  const miss = triggerText(it.on_miss);
  const crit = triggerText(it.on_crit);
  const gainKey = COMBO_GAIN_KEYS[str(it.combo_gain).toLowerCase()];
  const gain = gainKey ? tGlobal(gainKey) : '';
  if (miss) tags.push({ kind: 'miss', text: miss });
  if (crit) tags.push({ kind: 'crit', text: crit });
  if (gain) tags.push({ kind: 'combo', text: gain });
  return tags;
}

/**
 * Equipped items per slot. Supports the structured engine shape
 * (`{ weapon: { name, hit, ac, dmg, fx, visual } }`) and legacy plain-string slots.
 */
export function equipRows(equip: unknown): EquipRow[] {
  const e = obj(equip);
  const rows: EquipRow[] = [];
  for (const [slot, labelKey] of EQUIP_SLOTS) {
    const label = tGlobal(labelKey);
    const it = e[slot];
    if (isObj(it)) {
      const name = pick(it, 'name', 'label', 'item');
      if (!name) continue;
      const hit = num(it.hit);
      const ac = num(it.ac);
      const dmg = pick(it, 'dmg');
      const fx = pick(it, 'fx');
      const bonuses = [
        hit ? `${tGlobal('trpg.attr.hit')}${signed(hit)}` : '',
        ac ? `AC${signed(ac)}` : '',
        dmg ? `${tGlobal('trpg.attr.dmg')}${dmg}` : '',
        fx,
      ].filter(Boolean);
      rows.push({ slot: label, name, bonuses, exclusive: it.exclusive === true, tags: equipTags(it) });
    } else {
      const name = str(it);
      if (name) rows.push({ slot: label, name, bonuses: [], exclusive: false, tags: [] });
    }
  }
  return rows;
}

export interface SkillRow {
  name: string;
  type: string;
  tail: string;
  derivedFrom: string;
}

/** Structured skills (`{ name, type, dmg, status, guard, heal, buff, desc, derived_from }`) or plain strings. */
export function skillRows(skills: unknown): SkillRow[] {
  return arr(skills)
    .map((s) => {
      if (!isObj(s)) return { name: str(s), type: '', tail: '', derivedFrom: '' };
      const heal = pick(s, 'heal');
      const status = pick(s, 'status');
      const tail = [
        pick(s, 'dmg'),
        status ? tGlobal('trpg.statusPrefix', { val: status }) : '',
        flag(s.guard) ? tGlobal('trpg.guardText') : '',
        heal ? tGlobal('trpg.healPrefix', { val: heal }) : '',
        flag(s.buff) ? tGlobal('trpg.buffText') : '',
        pick(s, 'desc'),
      ]
        .filter(Boolean)
        .join(' · ');
      const type = pick(s, 'type').toLowerCase();
      const typeKey = SKILL_TYPE_KEYS[type];
      const derivedFrom = pick(s, 'derived_from').replace(/^★+/, '').trim();
      return { name: pick(s, 'name'), type: typeKey ? tGlobal(typeKey) : '', tail, derivedFrom };
    })
    .filter((s) => s.name);
}

const FORM_RANGE_KEYS: Record<string, MessageKey> = { melee: 'trpg.range.melee', ranged: 'trpg.range.ranged' };

function clipText(s: string, max = 60): string {
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s;
}

export interface FormInfo {
  /** True when `form_state === 'transformed'`. */
  transformed: boolean;
  /** Active form badge label (`form_kit.key`, else `transformed_appearance.form_key`, else localized fallback). */
  badge: string;
  /** Tooltip on the active form badge (`transformed_appearance` prompt, else `form_kit.passive`). */
  tooltip: string;
  /** Combat range label from `form_kit.range`, or `''`. */
  range: string;
  /** Active form passive from `form_kit.passive`, or `''`. */
  passive: string;
  /** Full transformed appearance text (used for tooltip / fallback snippet when `passive` is absent). */
  appearance: string;
  /** Clipped appearance snippet for compact display when `passive` is absent. */
  appearanceSnippet: string;
  /** Registered form keys saved in `form_skills` (shown when untransformed). */
  availableForms: string[];
}

/** Polymorph / mascot form state (`form_state`, `transformed_appearance`, `form_kit`, `form_skills`); null when absent. */
export function formInfo(rec: unknown): FormInfo | null {
  if (!isObj(rec)) return null;
  const transformed = str(rec.form_state).toLowerCase() === 'transformed';
  if (transformed) {
    const kit = obj(rec.form_kit);
    const tf = rec.transformed_appearance;
    const appearance = isObj(tf) ? pick(tf, 'prompt') : str(tf);
    const tfKey = isObj(tf) ? pick(tf, 'form_key') : '';
    const kitKey = pick(kit, 'key');
    const passive = pick(kit, 'passive');
    const rawRange = pick(kit, 'range');
    const rangeKey = FORM_RANGE_KEYS[rawRange.toLowerCase()];
    const range = rangeKey ? tGlobal(rangeKey) : rawRange;
    return {
      transformed: true,
      badge: kitKey || tfKey || tGlobal('panel.transformed'),
      tooltip: appearance || passive,
      range,
      passive,
      appearance,
      appearanceSnippet: appearance ? clipText(appearance) : '',
      availableForms: [],
    };
  }
  const availableForms = isObj(rec.form_skills)
    ? Object.keys(rec.form_skills)
        .map((k) => k.trim())
        .filter(Boolean)
    : [];
  if (!availableForms.length) return null;
  return {
    transformed: false,
    badge: '',
    tooltip: '',
    range: '',
    passive: '',
    appearance: '',
    appearanceSnippet: '',
    availableForms,
  };
}

export interface GrowthInfo {
  traits: string[];
  stats: string[];
}

/** Permanent personal-quest growth (`{ max_hp, hit, ac, dmg, traits }`); null when absent / empty. */
export function growthInfo(growth: unknown): GrowthInfo | null {
  if (!isObj(growth)) return null;
  const stats = (
    [
      ['max_hp', 'HP'],
      ['hit', tGlobal('trpg.attr.hit')],
      ['ac', 'AC'],
      ['dmg', tGlobal('trpg.attr.dmg')],
    ] as const
  )
    .map(([k, l]) => {
      const n = num(growth[k]);
      return n ? `${l}${signed(n)}` : '';
    })
    .filter(Boolean);
  const traits = strList(growth.traits);
  return traits.length || stats.length ? { traits, stats } : null;
}

const PENDING_KEYS: Record<string, MessageKey> = { gear: 'trpg.pending.gear', combo: 'trpg.pending.combo' };

export interface BondInfo {
  title: string;
  goal: string;
  done: boolean;
  /** `stage/stages`, completed label, or '' when the counters are missing. */
  progress: string;
  /** Completed acts for the progress bar; null when `stage` / `stages` are not numbers. */
  bar: { value: number; max: number } | null;
  pending: string[];
}

/** Multi-act personal quest (`{ title, stages, stage, goal, done, pending }`); null when absent. */
export function bondInfo(bond: unknown): BondInfo | null {
  if (!isObj(bond)) return null;
  const title = pick(bond, 'title');
  const done = bond.done === true;
  const goal = done ? '' : pick(bond, 'goal');
  const pending = strList(bond.pending).map((p) => (PENDING_KEYS[p] ? tGlobal(PENDING_KEYS[p]) : p));
  if (!title && !goal && !pending.length) return null;
  const stages = typeof bond.stages === 'number' && Number.isFinite(bond.stages) && bond.stages > 0 ? Math.floor(bond.stages) : null;
  const stage = typeof bond.stage === 'number' && Number.isFinite(bond.stage) ? Math.floor(bond.stage) : null;
  const bar = stages !== null && stage !== null ? { value: done ? stages : Math.max(0, Math.min(stages, stage - 1)), max: stages } : null;
  const progress = done ? tGlobal('panel.bondDone') : bar ? `${Math.max(1, Math.min(stages!, stage!))}/${stages}` : '';
  return { title, goal, done, progress, bar, pending };
}

const EQUIP_TAG_STYLE: Record<EquipTag['kind'], readonly [string, MessageKey]> = {
  miss: ['kc-badge-warn', 'trpg.equipTag.miss'],
  crit: ['kc-badge-primary', 'trpg.equipTag.crit'],
  combo: ['kc-badge-mode', 'trpg.equipTag.combo'],
};

function Fighter({ name, rec, enemy }: { name: string; rec: Dict; enemy?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const listSep = locale === 'en' ? ', ' : '、';
  const colon = locale === 'en' ? ': ' : '：';
  const hp = num(rec.hp);
  const max = num(rec.max_hp ?? rec.hp_max) ?? hp;
  const role = pick(rec, 'role');
  const cls = pick(rec, 'class', 'job');
  const level = num(rec.level);
  const status = strList(rec.status ?? rec.statuses);
  const attrs = { ...obj(rec.base), ...rec };
  const attrRows = ATTR_KEYS
    .filter(([k]) => k !== 'level' && (typeof attrs[k] === 'number' || (typeof attrs[k] === 'string' && attrs[k] !== '')))
    .map(([k, lKey]) => [t(lKey), String(attrs[k])] as const);
  const skills = skillRows(rec.skills);
  const equip = equipRows(rec.equip);
  const inv = itemsList(rec.inventory ?? rec.items ?? rec.bag);
  const growth = growthInfo(rec.growth);
  const bond = bondInfo(rec.bond);
  const form = formInfo(rec);
  const formStripText = form?.transformed ? form.passive || form.appearanceSnippet : '';
  const formStripTitle = form?.transformed ? form.passive || form.appearance : '';
  const roleKey = role ? ROLE_KEYS[role] : undefined;
  return (
    <li className={'km-fighter' + (enemy ? ' is-enemy' : '') + (form?.transformed ? ' is-transformed' : '')}>
      <div className="km-fighter-head">
        <b>{enemy ? '👹 ' : ''}{pick(rec, 'display_name', 'name') || name}</b>
        {roleKey && <span className="kc-badge kc-badge-tag">{t(roleKey)}</span>}
        {cls && <span className="kc-badge kc-badge-tag">{cls}</span>}
        {level !== null && <span className="kc-badge kc-badge-primary">Lv {level}</span>}
        {form?.transformed && (
          <span className="kc-badge kc-badge-accent km-form-badge" title={form.tooltip || undefined}>
            🔮 {form.badge}
          </span>
        )}
        {status.map((s) => (
          <span key={s} className="kc-badge kc-badge-warn">
            {s}
          </span>
        ))}
        {hp !== null && (
          <span className="km-hp-num">
            HP {hp}
            {max !== null ? `/${max}` : ''}
          </span>
        )}
      </div>
      {hp !== null && max ? <HpBar hp={hp} max={max} /> : null}
      {form?.transformed && (form.range || formStripText) && (
        <div className="km-form-strip" aria-label={t('panel.formStripAria')}>
          {form.range && <span className="kc-badge kc-badge-tag km-form-range">{form.range}</span>}
          {formStripText && (
            <span className="km-form-text" title={formStripTitle || undefined}>
              {formStripText}
            </span>
          )}
        </div>
      )}
      {form && !form.transformed && form.availableForms.length > 0 && (
        <div className="km-form-avail" aria-label={t('panel.availFormsAria')}>
          <span className="kc-badge kc-badge-tag km-form-pill">{t('panel.availFormsLabel', { forms: form.availableForms.join(listSep) })}</span>
        </div>
      )}
      {attrRows.length > 0 && (
        <div className="km-attrs">
          {attrRows.map(([l, v]) => (
            <span key={l} className="km-attr">
              <i>{l}</i> {v}
            </span>
          ))}
        </div>
      )}
      {growth && (
        <div className="kc-chips km-growth" aria-label={t('panel.growth')}>
          <span className="kc-chip-k">{t('panel.growth')}</span>
          {growth.traits.map((tr) => (
            <span key={tr} className="kc-badge kc-badge-mode">
              {tr}
            </span>
          ))}
          {growth.stats.map((s) => (
            <span key={s} className="km-attr">
              {s}
            </span>
          ))}
        </div>
      )}
      {bond && (
        <div className="km-bond" aria-label={t('panel.bondAria')}>
          <div className="kc-chips">
            {bond.title && <b>《{bond.title}》</b>}
            {bond.progress && <span className={'kc-badge ' + (bond.done ? 'kc-badge-primary' : 'kc-badge-tag')}>{bond.progress}</span>}
            {bond.goal && <span className="km-bond-goal">{bond.goal}</span>}
            {bond.pending.length > 0 && <span className="kc-badge kc-badge-warn">{t('panel.bondPending', { items: bond.pending.join(' / ') })}</span>}
          </div>
          {bond.bar && <ProgressBar value={bond.bar.value} max={bond.bar.max} />}
        </div>
      )}
      {skills.length > 0 && (
        <ul className="km-skills" aria-label={t('panel.skillsAria')}>
          {skills.map((s, i) => (
            <li key={i} title={s.derivedFrom ? t('panel.derivedFromTitle', { name: s.derivedFrom }) : undefined}>
              <b>{s.name}</b>
              {s.type && <span className="kc-badge kc-badge-tag km-skill-type">{s.type}</span>}
              {s.derivedFrom && (
                <span className="kc-badge kc-badge-accent km-skill-derived" title={t('panel.derivedFromTitle', { name: s.derivedFrom })}>
                  {t('panel.derivedFrom', { name: s.derivedFrom })}
                </span>
              )}
              {s.tail && <span> · {s.tail}</span>}
            </li>
          ))}
        </ul>
      )}
      {equip.length > 0 && (
        <ul className="km-equip" aria-label={t('panel.equipAria')}>
          {equip.map((e) => (
            <li key={e.slot} className="km-equip-row">
              <span className="km-equip-slot">{e.slot}</span>
              <b className="km-equip-name">
                {e.exclusive && '★'}
                {e.name}
              </b>
              {e.exclusive && <span className="kc-badge kc-badge-primary">{t('panel.exclusive')}</span>}
              {e.bonuses.length > 0 && <span className="km-equip-bonus">{e.bonuses.join(' · ')}</span>}
              {e.tags.length > 0 && (
                <span className="km-equip-tags">
                  {e.tags.map((tag) => {
                    const [tone, prefixKey] = EQUIP_TAG_STYLE[tag.kind];
                    const prefix = t(prefixKey);
                    return (
                      <span key={tag.kind} className={`kc-badge ${tone} km-equip-tag`} title={`${prefix}${colon}${tag.text}`}>
                        {prefix} {tag.text}
                      </span>
                    );
                  })}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {inv.length > 0 && (
        <div className="kc-chips">
          <span className="kc-chip-k">🎒</span>
          {inv.map((x) => (
            <span key={x} className="kc-badge kc-badge-tag">
              {x}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

const FIELD_ROLE_ORDER: Record<string, number> = { player: 0, active: 1, support: 2 };

function PartyPanel({ stateFiles }: { stateFiles: Record<string, unknown> }) {
  const t = useT();
  const party = file(stateFiles, 'game/party.json');
  const ledger = file(stateFiles, 'game/ledger.json');
  const base = file(stateFiles, 'game/base.json');
  const baseName = typeof base.name === 'string' ? base.name.trim() : '';
  const reserveLabel = t('panel.reserveLabel', { base: baseName || t('panel.standby') });
  const allMembers = Object.entries(obj(party.members)).filter(([, v]) => isObj(v)) as Array<[string, Dict]>;
  const activeMembers: Array<[string, Dict]> = [];
  const reserveMembers: Array<[string, Dict]> = [];
  for (const entry of allMembers) {
    const role = str(entry[1].role).toLowerCase();
    if (role === 'narrator') continue;
    if (role === 'reserve') reserveMembers.push(entry);
    else activeMembers.push(entry);
  }
  activeMembers.sort((a, b) => {
    const ra = FIELD_ROLE_ORDER[str(a[1].role).toLowerCase()] ?? 1;
    const rb = FIELD_ROLE_ORDER[str(b[1].role).toLowerCase()] ?? 1;
    return ra - rb;
  });
  const enemies = Object.entries(obj(party.enemies)).filter(([, v]) => isObj(v)) as Array<[string, Dict]>;
  const phase = trpgPhase(stateFiles);
  const inCamp = phase === 'camp';
  const inCombat = !inCamp && (phase === 'combat' || enemies.length > 0);
  const showEnemies = inCombat && enemies.length > 0;
  const showReserve = inCamp && reserveMembers.length > 0;
  const shared = itemsList(party.inventory ?? party.bag ?? party.loot);
  const gold = num(obj(ledger.global).gold ?? party.gold);
  const combos = partyCombos(party);
  const gauge = comboGauge(party);
  return (
    <Panel title={t('panel.partyTitle')} className="km-party">
      {!activeMembers.length && !showEnemies && !showReserve && <Empty>{t('panel.noParty')}</Empty>}
      {activeMembers.length > 0 && (
        <ul className="km-list" aria-label={t('panel.activeMembersAria')}>
          {activeMembers.map(([k, m]) => (
            <Fighter key={k} name={k} rec={m} />
          ))}
        </ul>
      )}
      {showEnemies && (
        <>
          <div className="km-sub">{t('panel.enemies')}</div>
          <ul className="km-list" aria-label={t('panel.enemies')}>
            {enemies.map(([k, e]) => (
              <Fighter key={k} name={k} rec={e} enemy />
            ))}
          </ul>
        </>
      )}
      {showReserve && (
        <>
          <div className="km-sub">{reserveLabel}</div>
          <ul className="km-list" aria-label={reserveLabel}>
            {reserveMembers.map(([k, m]) => (
              <Fighter key={k} name={k} rec={m} />
            ))}
          </ul>
        </>
      )}
      {combos.length > 0 && (
        <>
          <div className="km-sub">
            {t('panel.combos')}{' '}
            <span className="km-combo-gauge" aria-label={t('hud.comboGaugeAria', { value: gauge.value, max: gauge.max })}>
              {'▰'.repeat(gauge.value) + '▱'.repeat(gauge.max - gauge.value)} {gauge.value}/{gauge.max}
            </span>
          </div>
          <ul className="km-list" aria-label={t('panel.combos')}>
            {combos.map((c, i) => {
              const typeLabel = SKILL_TYPE_KEYS[c.type] ? t(SKILL_TYPE_KEYS[c.type]) : c.type;
              return (
                <li key={`${c.name}#${i}`} className="km-combo-row" title={c.fx}>
                  <b>{c.name}</b>
                  <span>· {c.members.join('×')}</span>
                  <span>· {t('panel.comboCost', { cost: c.cost })}</span>
                  {typeLabel && <span className="kc-badge kc-badge-tag">{typeLabel}</span>}
                  {c.tail && <span>· {c.tail}</span>}
                  {c.state === 'ready' && <span className="kc-badge kc-badge-primary">{t('panel.comboReady')}</span>}
                  {c.state === 'need' && <span className="kc-badge kc-badge-tag">{t('panel.comboNeed', { cost: c.cost })}</span>}
                  {c.state === 'missing' && <span className="kc-badge kc-badge-warn">{t('panel.comboMissing', { names: c.missing.join(' · ') })}</span>}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {(shared.length > 0 || gold !== null) && (
        <div className="kc-chips">
          <span className="kc-chip-k">{t('panel.sharedBag')}</span>
          {gold !== null && <span className="kc-badge kc-badge-warn">💰 {gold}</span>}
          {shared.map((x) => (
            <span key={x} className="kc-badge kc-badge-tag">
              {x}
            </span>
          ))}
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------ dex ------------------------------ */

function DexPanel({ stateFiles, modePrefs, ctx }: { stateFiles: Record<string, unknown>; modePrefs: Record<string, unknown>; ctx: CardContext }) {
  const t = useT();
  const pk = file(stateFiles, 'game/pokemon.json');
  const version = resolveGameVersion(modePrefs, stateFiles);
  const pinned = modePrefs && Object.prototype.hasOwnProperty.call(modePrefs, 'pinned_context') ? str(modePrefs.pinned_context) : pick(pk, 'pinned_context', 'pinned');
  const pinnedId = pick(pk, 'pinned_species_id');
  const history = (arr(pk.history).filter(isObj) as Dict[]).filter((h) => !h.version || String(h.version).toLowerCase() === version);
  const nameOf = (h: Dict) => pick(obj(h.name), 'zh') || pick(h, 'name_zh', 'name');
  const pinnedCard = pinned || pinnedId ? [...history].reverse().find((h) => (pinnedId && pick(h, 'species_id') === pinnedId) || (pinned && nameOf(h) === pinned)) : undefined;
  const recentQueries = strList(pk.recent_queries).slice(-6).reverse();
  return (
    <Panel title={t('panel.dexTitle')} badge={<span className={`kc-badge kc-ver kc-ver-${version}`}>{VERSION_LABELS[version]}</span>} className={`km-dex kc-pkmn kc-pkmn-${version}`}>
      {pinned || pinnedCard ? (
        <div className="km-dex-pinned">
          <div className="km-dex-name">
            <span className="km-k">{t('panel.pinned')}</span>
            <b>{pinnedCard ? nameOf(pinnedCard) : pinned}</b>
            {pinnedCard && strList(pinnedCard.types).map((tp) => <TypeBadge key={tp} t={tp} />)}
          </div>
          {pinnedCard ? <MatchupRows m={matchupOf(pinnedCard.matchup)} foldResist={false} /> : <Empty>{t('panel.queryOnceMatchup')}</Empty>}
        </div>
      ) : (
        <Empty>{t('panel.noPinnedPkmn')}</Empty>
      )}
      {history.length > 0 && (
        <>
          <div className="km-sub">{t('panel.recentQueries')}</div>
          <ul className="km-list km-dex-hist">
            {[...history]
              .reverse()
              .slice(0, 8)
              .map((h, i) => (
                <li key={i}>
                  <button type="button" className="km-dex-hist-btn" onClick={() => ctx.openFullscreen(<PokemonDex data={h} ctx={ctx} />)}>
                    <b>{nameOf(h)}</b>
                    {strList(h.types).map((tp) => (
                      <TypeBadge key={tp} t={tp} />
                    ))}
                    <span aria-hidden>›</span>
                  </button>
                </li>
              ))}
          </ul>
        </>
      )}
      {!history.length && recentQueries.length > 0 && (
        <div className="kc-chips">
          <span className="kc-chip-k">{t('panel.recentQueries')}</span>
          {recentQueries.map((q) => (
            <button key={q} type="button" className="kc-gloss" onClick={() => ctx.insertComposer(q)}>
              {q}
            </button>
          ))}
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------ lesson ------------------------------ */

function LessonPanel({ stateFiles, ctx }: { stateFiles: Record<string, unknown>; ctx: CardContext }) {
  const t = useT();
  const l = file(stateFiles, 'game/lesson.json');
  const segs = arr(l.segments);
  const idx = Math.max(0, Math.floor(num(l.segment_index) ?? 0));
  const book = pick(l, 'book');
  const no = pick(l, 'lesson');
  const title = pick(l, 'title');
  const head = [book, no ? (/^\d+$/.test(no) ? t('hud.lessonNo', { no }) : no) : ''].filter(Boolean).join(' ');
  return (
    <>
      <Panel title={`📘 ${head || t('panel.lessonOutlineFallback')}`} badge={segs.length ? <span className="kc-badge kc-badge-mode">{Math.min(idx + 1, segs.length)}/{segs.length}</span> : undefined} className="km-lesson">
        {title && <div className="km-lesson-title">《{title}》</div>}
        {segs.length > 0 && <ProgressBar value={Math.min(idx + 1, segs.length)} max={segs.length} />}
        {!segs.length && <Empty>{t('panel.noLessonLoaded')}</Empty>}
        <ol className="km-outline">
          {segs.map((s, i) => {
            const so = obj(s);
            const label = pick(so, 'title', 'scene', 'name') || (pick(so, 'kind') === 'vocab' ? t('panel.vocab') : pick(so, 'id')) || t('panel.segmentN', { n: i + 1 });
            const state = i < idx ? 'is-done' : i === idx ? 'is-cur' : '';
            return (
              <li key={i} className={state}>
                <span className="km-outline-dot" aria-hidden>
                  {i < idx ? '✓' : i + 1}
                </span>
                <span>{label}</span>
              </li>
            );
          })}
        </ol>
      </Panel>
      {mistakeItems(stateFiles).length > 0 && <MistakesPanel stateFiles={stateFiles} ctx={ctx} />}
    </>
  );
}

/* ------------------------------ travel ------------------------------ */

function TravelPanel({ stateFiles }: { stateFiles: Record<string, unknown> }) {
  const t = useT();
  const tr = file(stateFiles, 'game/travel.json');
  const dietary = strList(tr.dietary);
  const order = arr(tr.order ?? tr.orders ?? tr.items)
    .map((o) => (isObj(o) ? { name: pick(o, 'name_zh', 'name_local', 'name'), local: pick(o, 'name_local'), qty: num(o.qty) ?? 1, done: o.done === true || o.checked === true } : { name: str(o), local: '', qty: 1, done: false }))
    .filter((o) => o.name);
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  return (
    <Panel title={`🧭 ${pick(tr, 'city') || t('panel.travelFallback')}`} className="km-travel">
      {dietary.length > 0 && (
        <div className="kc-chips">
          <span className="kc-chip-k">{t('panel.dietary')}</span>
          {dietary.map((d) => (
            <span key={d} className="kc-badge kc-badge-warn">
              {d}
            </span>
          ))}
        </div>
      )}
      <div className="km-sub">{t('panel.currentOrder')}</div>
      {!order.length && <Empty>{t('panel.noDishes')}</Empty>}
      <ul className="km-list km-order">
        {order.map((o, i) => {
          const on = checked[i] ?? o.done;
          return (
            <li key={i}>
              <label className={'km-order-row' + (on ? ' is-on' : '')}>
                <input type="checkbox" checked={on} onChange={() => setChecked((c) => ({ ...c, [i]: !on }))} />
                <b>{o.name}</b>
                {o.local && o.local !== o.name && (
                  <span className="km-order-local" lang="ja">
                    {o.local}
                  </span>
                )}
                <span className="km-order-qty">×{o.qty}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

class PanelBoundary extends Component<{ children?: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed ? <Empty>{tGlobal('panel.boundaryFallback')}</Empty> : this.props.children;
  }
}

/** Mode inspector panels (desktop right column / mobile half-sheet body). Unknown or `memory` → null. */
export function ModePanel(props: ModePanelProps) {
  return (
    <PanelBoundary key={props.panel}>
      <ModePanelInner {...props} />
    </PanelBoundary>
  );
}

function ModePanelInner({ panel, stateFiles, modePrefs, ctx }: ModePanelProps) {
  const sf = stateFiles ?? {};
  const prefs = modePrefs ?? {};
  switch (panel) {
    case 'mistakes':
      return <MistakesPanel stateFiles={sf} ctx={ctx} />;
    case 'roster':
      return <RosterPanel stateFiles={sf} ctx={ctx} />;
    case 'party':
      return <PartyPanel stateFiles={sf} />;
    case 'dex':
      return <DexPanel stateFiles={sf} modePrefs={prefs} ctx={ctx} />;
    case 'lesson':
      return <LessonPanel stateFiles={sf} ctx={ctx} />;
    case 'travel':
      return <TravelPanel stateFiles={sf} />;
    default:
      return null;
  }
}

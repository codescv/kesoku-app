import { Component, useState, type ReactNode } from 'react';
import { HpBar, ProgressBar } from '@kesoku/ui';
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
  const items = mistakeItems(stateFiles);
  return (
    <Panel title="📕 待复习错题本" badge={items.length ? <span className="kc-badge kc-badge-danger-soft">{items.length} 项到期</span> : undefined} className="km-mistakes">
      {!items.length && <Empty>暂无到期错题 🎉</Empty>}
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
                  <b lang="ja">{point || '错题'}</b>
                  {lessonNo && <span className="kc-badge kc-badge-tag">{/^\d+$/.test(lessonNo) ? `第${lessonNo}课` : lessonNo}</span>}
                </div>
                {(wrong || right) && (
                  <div className="km-mistake-fix" lang="ja">
                    {wrong && <span className="km-wrong">误：{wrong}</span>}
                    {wrong && right && ' → '}
                    {right && <span className="km-right">正：{right}</span>}
                  </div>
                )}
              </div>
              <button type="button" className="km-kill" onClick={() => ctx.sendText(`立即消灭错题${id ? ` #${id}` : ''}：${point}`)} disabled={!point}>
                立即消灭
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
  const ref = refStr ? toMediaRef({ ref: refStr }) : null;
  const url = useImageUrl(ctx.resolveMedia, ref);
  return (
    <button
      type="button"
      className="km-roster-av"
      aria-label={`${name} 定妆参考`}
      onClick={() => url && ctx.openFullscreen(<img className="kc-full-img" src={url} alt={name} />)}
    >
      {url ? <img src={url} alt={name} draggable={false} /> : <span aria-hidden>{name.slice(0, 1)}</span>}
    </button>
  );
}

function RosterPanel({ stateFiles, ctx }: { stateFiles: Record<string, unknown>; ctx: CardContext }) {
  const roster = file(stateFiles, 'game/roster.json');
  const members = Object.entries(obj(roster.members ?? roster.cast ?? roster.characters)).filter(([, v]) => isObj(v)) as Array<[string, Dict]>;
  return (
    <Panel title="🎭 演员定妆表" badge={<span className="kc-badge kc-badge-mode">{members.length}</span>} className="km-roster">
      {!members.length && <Empty>还没有登记角色</Empty>}
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

const ROLE_LABEL: Record<string, string> = { player: '主角', active: '队友', support: '支援', narrator: '旁白', reserve: '后备' };
const ATTR_LABEL: Record<string, string> = { ac: '护甲', hit: '命中', dmg: '伤害', atk: '攻击', def: '防御', mp: 'MP', max_mp: 'MP上限', spd: '速度', str: '力量', dex: '敏捷', int: '智力', level: '等级', xp: '经验', gold: '金币' };

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

const EQUIP_SLOTS: ReadonlyArray<readonly [string, string]> = [
  ['weapon', '武器'],
  ['armor', '护甲'],
  ['accessory', '饰品'],
];
const SKILL_TYPE_LABEL: Record<string, string> = { attack: '攻击', control: '控制', heal: '治疗', guard: '守护', buff: '增益', transform: '变身', narrative: '叙事' };

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
  /** Exclusive (专属) gear granted by a personal quest. */
  exclusive: boolean;
  /** Trigger affixes: on-miss / on-crit text and combo-gauge gain. */
  tags: EquipTag[];
}

const COMBO_GAIN_TEXT: Record<string, string> = { hit: '命中+1格', crit: '暴击+1格' };

/** Trigger text from the current `{ text, status, hp }` object or a legacy plain string. */
function triggerText(v: unknown): string {
  return isObj(v) ? pick(v, 'text') : str(v);
}

function equipTags(it: Dict): EquipTag[] {
  const tags: EquipTag[] = [];
  const miss = triggerText(it.on_miss);
  const crit = triggerText(it.on_crit);
  const gain = COMBO_GAIN_TEXT[str(it.combo_gain).toLowerCase()];
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
  for (const [slot, label] of EQUIP_SLOTS) {
    const it = e[slot];
    if (isObj(it)) {
      const name = pick(it, 'name', 'label', 'item');
      if (!name) continue;
      const hit = num(it.hit);
      const ac = num(it.ac);
      const dmg = pick(it, 'dmg');
      const fx = pick(it, 'fx');
      const bonuses = [hit ? `命中${signed(hit)}` : '', ac ? `AC${signed(ac)}` : '', dmg ? `伤害${dmg}` : '', fx].filter(Boolean);
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
}

/** Structured skills (`{ name, type, dmg, status, guard, heal, buff, desc }`) or plain strings. */
export function skillRows(skills: unknown): SkillRow[] {
  return arr(skills)
    .map((s) => {
      if (!isObj(s)) return { name: str(s), type: '', tail: '' };
      const heal = pick(s, 'heal');
      const status = pick(s, 'status');
      const tail = [pick(s, 'dmg'), status ? `状态:${status}` : '', flag(s.guard) ? '壁垒掩护' : '', heal ? `治疗:${heal}` : '', flag(s.buff) ? '战意鼓舞' : '', pick(s, 'desc')]
        .filter(Boolean)
        .join(' · ');
      const type = pick(s, 'type').toLowerCase();
      return { name: pick(s, 'name'), type: SKILL_TYPE_LABEL[type] ?? '', tail };
    })
    .filter((s) => s.name);
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
      ['hit', '命中'],
      ['ac', 'AC'],
      ['dmg', '伤害'],
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

const PENDING_LABEL: Record<string, string> = { gear: '专属装备', combo: '新合体技' };

export interface BondInfo {
  title: string;
  goal: string;
  done: boolean;
  /** `stage/stages`, `完结`, or '' when the counters are missing. */
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
  const pending = strList(bond.pending).map((p) => PENDING_LABEL[p] ?? p);
  if (!title && !goal && !pending.length) return null;
  const stages = typeof bond.stages === 'number' && Number.isFinite(bond.stages) && bond.stages > 0 ? Math.floor(bond.stages) : null;
  const stage = typeof bond.stage === 'number' && Number.isFinite(bond.stage) ? Math.floor(bond.stage) : null;
  const bar = stages !== null && stage !== null ? { value: done ? stages : Math.max(0, Math.min(stages, stage - 1)), max: stages } : null;
  const progress = done ? '完结' : bar ? `${Math.max(1, Math.min(stages!, stage!))}/${stages}` : '';
  return { title, goal, done, progress, bar, pending };
}

const EQUIP_TAG_STYLE: Record<EquipTag['kind'], readonly [string, string]> = {
  miss: ['kc-badge-warn', '打空'],
  crit: ['kc-badge-primary', '暴击'],
  combo: ['kc-badge-mode', '连携'],
};

function Fighter({ name, rec, enemy }: { name: string; rec: Dict; enemy?: boolean }) {
  const hp = num(rec.hp);
  const max = num(rec.max_hp ?? rec.hp_max) ?? hp;
  const role = pick(rec, 'role');
  const cls = pick(rec, 'class', 'job');
  const level = num(rec.level);
  const status = strList(rec.status ?? rec.statuses);
  const attrs = { ...obj(rec.base), ...rec };
  const attrRows = Object.entries(ATTR_LABEL)
    .filter(([k]) => k !== 'level' && (typeof attrs[k] === 'number' || (typeof attrs[k] === 'string' && attrs[k] !== '')))
    .map(([k, l]) => [l, String(attrs[k])] as const);
  const skills = skillRows(rec.skills);
  const equip = equipRows(rec.equip);
  const inv = itemsList(rec.inventory ?? rec.items ?? rec.bag);
  const growth = growthInfo(rec.growth);
  const bond = bondInfo(rec.bond);
  return (
    <li className={'km-fighter' + (enemy ? ' is-enemy' : '')}>
      <div className="km-fighter-head">
        <b>{enemy ? '👹 ' : ''}{pick(rec, 'display_name', 'name') || name}</b>
        {role && ROLE_LABEL[role] && <span className="kc-badge kc-badge-tag">{ROLE_LABEL[role]}</span>}
        {cls && <span className="kc-badge kc-badge-tag">{cls}</span>}
        {level !== null && <span className="kc-badge kc-badge-primary">Lv {level}</span>}
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
        <div className="kc-chips km-growth" aria-label="觉醒">
          <span className="kc-chip-k">觉醒</span>
          {growth.traits.map((t) => (
            <span key={t} className="kc-badge kc-badge-mode">
              {t}
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
        <div className="km-bond" aria-label="个人任务">
          <div className="kc-chips">
            {bond.title && <b>《{bond.title}》</b>}
            {bond.progress && <span className={'kc-badge ' + (bond.done ? 'kc-badge-primary' : 'kc-badge-tag')}>{bond.progress}</span>}
            {bond.goal && <span className="km-bond-goal">{bond.goal}</span>}
            {bond.pending.length > 0 && <span className="kc-badge kc-badge-warn">待领 {bond.pending.join(' / ')}</span>}
          </div>
          {bond.bar && <ProgressBar value={bond.bar.value} max={bond.bar.max} />}
        </div>
      )}
      {skills.length > 0 && (
        <ul className="km-skills" aria-label="配招">
          {skills.map((s, i) => (
            <li key={i}>
              <b>{s.name}</b>
              {s.type && <span className="kc-badge kc-badge-tag km-skill-type">{s.type}</span>}
              {s.tail && <span> · {s.tail}</span>}
            </li>
          ))}
        </ul>
      )}
      {equip.length > 0 && (
        <ul className="km-equip" aria-label="装备">
          {equip.map((e) => (
            <li key={e.slot} className="km-equip-row">
              <span className="km-equip-slot">{e.slot}</span>
              <b className="km-equip-name">
                {e.exclusive && '★'}
                {e.name}
              </b>
              {e.exclusive && <span className="kc-badge kc-badge-primary">专属</span>}
              {e.bonuses.length > 0 && <span className="km-equip-bonus">{e.bonuses.join(' · ')}</span>}
              {e.tags.length > 0 && (
                <span className="km-equip-tags">
                  {e.tags.map((t) => {
                    const [tone, prefix] = EQUIP_TAG_STYLE[t.kind];
                    return (
                      <span key={t.kind} className={`kc-badge ${tone} km-equip-tag`} title={`${prefix}：${t.text}`}>
                        {prefix} {t.text}
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
  const party = file(stateFiles, 'game/party.json');
  const ledger = file(stateFiles, 'game/ledger.json');
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
    <Panel title="⚔️ 小队" className="km-party">
      {!activeMembers.length && !showEnemies && !showReserve && <Empty>暂无队伍数据</Empty>}
      {activeMembers.length > 0 && (
        <ul className="km-list" aria-label="上场队友">
          {activeMembers.map(([k, m]) => (
            <Fighter key={k} name={k} rec={m} />
          ))}
        </ul>
      )}
      {showEnemies && (
        <>
          <div className="km-sub">敌方</div>
          <ul className="km-list" aria-label="敌方">
            {enemies.map(([k, e]) => (
              <Fighter key={k} name={k} rec={e} enemy />
            ))}
          </ul>
        </>
      )}
      {showReserve && (
        <>
          <div className="km-sub">场下队友（营地）</div>
          <ul className="km-list" aria-label="场下队友（营地）">
            {reserveMembers.map(([k, m]) => (
              <Fighter key={k} name={k} rec={m} />
            ))}
          </ul>
        </>
      )}
      {combos.length > 0 && (
        <>
          <div className="km-sub">
            合体技{' '}
            <span className="km-combo-gauge" aria-label={`连携槽 ${gauge.value}/${gauge.max}`}>
              {'▰'.repeat(gauge.value) + '▱'.repeat(gauge.max - gauge.value)} {gauge.value}/{gauge.max}
            </span>
          </div>
          <ul className="km-list" aria-label="合体技">
            {combos.map((c, i) => (
              <li key={`${c.name}#${i}`} className="km-combo-row" title={c.fx}>
                <b>{c.name}</b>
                <span>· {c.members.join('×')}</span>
                <span>· {c.cost}格</span>
                {(SKILL_TYPE_LABEL[c.type] ?? c.type) && <span className="kc-badge kc-badge-tag">{SKILL_TYPE_LABEL[c.type] ?? c.type}</span>}
                {c.tail && <span>· {c.tail}</span>}
                {c.state === 'ready' && <span className="kc-badge kc-badge-primary">可发动</span>}
                {c.state === 'need' && <span className="kc-badge kc-badge-tag">需{c.cost}格</span>}
                {c.state === 'missing' && <span className="kc-badge kc-badge-warn">缺员:{c.missing.join('、')}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {(shared.length > 0 || gold !== null) && (
        <div className="kc-chips">
          <span className="kc-chip-k">共享背包</span>
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
  const pk = file(stateFiles, 'game/pokemon.json');
  const version = resolveGameVersion(modePrefs, stateFiles);
  const pinned = modePrefs && Object.prototype.hasOwnProperty.call(modePrefs, 'pinned_context') ? str(modePrefs.pinned_context) : pick(pk, 'pinned_context', 'pinned');
  const pinnedId = pick(pk, 'pinned_species_id');
  const history = (arr(pk.history).filter(isObj) as Dict[]).filter((h) => !h.version || String(h.version).toLowerCase() === version);
  const nameOf = (h: Dict) => pick(obj(h.name), 'zh') || pick(h, 'name_zh', 'name');
  const pinnedCard = pinned || pinnedId ? [...history].reverse().find((h) => (pinnedId && pick(h, 'species_id') === pinnedId) || (pinned && nameOf(h) === pinned)) : undefined;
  const recentQueries = strList(pk.recent_queries).slice(-6).reverse();
  return (
    <Panel title="🔴 Dex" badge={<span className={`kc-badge kc-ver kc-ver-${version}`}>{VERSION_LABELS[version]}</span>} className={`km-dex kc-pkmn kc-pkmn-${version}`}>
      {pinned || pinnedCard ? (
        <div className="km-dex-pinned">
          <div className="km-dex-name">
            <span className="km-k">📌 锁定</span>
            <b>{pinnedCard ? nameOf(pinnedCard) : pinned}</b>
            {pinnedCard && strList(pinnedCard.types).map((t) => <TypeBadge key={t} t={t} />)}
          </div>
          {pinnedCard ? <MatchupRows m={matchupOf(pinnedCard.matchup)} foldResist={false} /> : <Empty>查询一次即可显示克制四组</Empty>}
        </div>
      ) : (
        <Empty>未锁定宝可梦</Empty>
      )}
      {history.length > 0 && (
        <>
          <div className="km-sub">最近查询</div>
          <ul className="km-list km-dex-hist">
            {[...history]
              .reverse()
              .slice(0, 8)
              .map((h, i) => (
                <li key={i}>
                  <button type="button" className="km-dex-hist-btn" onClick={() => ctx.openFullscreen(<PokemonDex data={h} ctx={ctx} />)}>
                    <b>{nameOf(h)}</b>
                    {strList(h.types).map((t) => (
                      <TypeBadge key={t} t={t} />
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
          <span className="kc-chip-k">最近查询</span>
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
  const l = file(stateFiles, 'game/lesson.json');
  const segs = arr(l.segments);
  const idx = Math.max(0, Math.floor(num(l.segment_index) ?? 0));
  const book = pick(l, 'book');
  const no = pick(l, 'lesson');
  const title = pick(l, 'title');
  const head = [book, no ? (/^\d+$/.test(no) ? `第${no}课` : no) : ''].filter(Boolean).join(' ');
  return (
    <>
      <Panel title={`📘 ${head || '课程大纲'}`} badge={segs.length ? <span className="kc-badge kc-badge-mode">{Math.min(idx + 1, segs.length)}/{segs.length}</span> : undefined} className="km-lesson">
        {title && <div className="km-lesson-title">《{title}》</div>}
        {segs.length > 0 && <ProgressBar value={Math.min(idx + 1, segs.length)} max={segs.length} />}
        {!segs.length && <Empty>尚未加载课程</Empty>}
        <ol className="km-outline">
          {segs.map((s, i) => {
            const so = obj(s);
            const label = pick(so, 'title', 'scene', 'name') || (pick(so, 'kind') === 'vocab' ? '词表' : pick(so, 'id')) || `片段 ${i + 1}`;
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
  const t = file(stateFiles, 'game/travel.json');
  const dietary = strList(t.dietary);
  const order = arr(t.order ?? t.orders ?? t.items)
    .map((o) => (isObj(o) ? { name: pick(o, 'name_zh', 'name_local', 'name'), local: pick(o, 'name_local'), qty: num(o.qty) ?? 1, done: o.done === true || o.checked === true } : { name: str(o), local: '', qty: 1, done: false }))
    .filter((o) => o.name);
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  return (
    <Panel title={`🧭 ${pick(t, 'city') || '旅途'}`} className="km-travel">
      {dietary.length > 0 && (
        <div className="kc-chips">
          <span className="kc-chip-k">🛡️ 忌口</span>
          {dietary.map((d) => (
            <span key={d} className="kc-badge kc-badge-warn">
              {d}
            </span>
          ))}
        </div>
      )}
      <div className="km-sub">当前点单</div>
      {!order.length && <Empty>还没有勾选菜品</Empty>}
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
    return this.state.failed ? <Empty>面板数据暂不可用</Empty> : this.props.children;
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

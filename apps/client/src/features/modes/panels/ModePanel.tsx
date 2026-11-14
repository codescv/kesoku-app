import { Component, useState, type ReactNode } from 'react';
import { HpBar, ProgressBar } from '@kesoku/ui';
import { VERSION_LABELS, resolveGameVersion, type HudPanel } from '@kesoku/hud';
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
  const members = Object.entries(obj(file(stateFiles, 'game/roster.json').members)).filter(([, v]) => isObj(v)) as Array<[string, Dict]>;
  return (
    <Panel title="🎭 演员定妆表" badge={<span className="kc-badge kc-badge-mode">{members.length}</span>} className="km-roster">
      {!members.length && <Empty>还没有登记角色</Empty>}
      <ul className="km-list">
        {members.map(([key, m]) => {
          const name = pick(m, 'name') || key;
          const base = obj(m.base_appearance);
          const ref = pick(m, 'ref') || pick(base, 'ref') || pick(m, 'visual_ref');
          const actor = pick(m, 'actor', 'cast', 'performer', 'display_name') || (ref ? ref.split('/').filter(Boolean).pop()?.replace(/[_-]+/g, ' ') ?? '' : '');
          const tags = [...strList(m.tags), ...strList(m.costume), ...strList(pick(m, 'outfit'))].slice(0, 6);
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

function Fighter({ name, rec, enemy }: { name: string; rec: Dict; enemy?: boolean }) {
  const hp = num(rec.hp);
  const max = num(rec.max_hp ?? rec.hp_max) ?? hp;
  const role = pick(rec, 'role');
  const level = num(rec.level);
  const status = strList(rec.status ?? rec.statuses);
  const attrs = { ...obj(rec.base), ...rec };
  const attrRows = Object.entries(ATTR_LABEL)
    .filter(([k]) => k !== 'level' && (typeof attrs[k] === 'number' || (typeof attrs[k] === 'string' && attrs[k] !== '')))
    .map(([k, l]) => [l, String(attrs[k])] as const);
  const skills = arr(rec.skills)
    .map((s) => (isObj(s) ? { name: pick(s, 'name'), tail: [pick(s, 'dmg'), pick(s, 'status'), pick(s, 'desc')].filter(Boolean).join(' · ') } : { name: str(s), tail: '' }))
    .filter((s) => s.name);
  const inv = itemsList(rec.inventory ?? rec.items ?? rec.bag);
  return (
    <li className={'km-fighter' + (enemy ? ' is-enemy' : '')}>
      <div className="km-fighter-head">
        <b>{enemy ? '👹 ' : ''}{pick(rec, 'display_name', 'name') || name}</b>
        {role && ROLE_LABEL[role] && <span className="kc-badge kc-badge-tag">{ROLE_LABEL[role]}</span>}
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
      {skills.length > 0 && (
        <ul className="km-skills">
          {skills.map((s, i) => (
            <li key={i}>
              <b>{s.name}</b>
              {s.tail && <span> · {s.tail}</span>}
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

function PartyPanel({ stateFiles }: { stateFiles: Record<string, unknown> }) {
  const party = file(stateFiles, 'game/party.json');
  const members = Object.entries(obj(party.members)).filter(([, v]) => isObj(v)) as Array<[string, Dict]>;
  const enemies = Object.entries(obj(party.enemies)).filter(([, v]) => isObj(v)) as Array<[string, Dict]>;
  members.sort((a, b) => Number(b[1].role === 'player') - Number(a[1].role === 'player'));
  const shared = itemsList(party.inventory ?? party.bag ?? party.loot);
  const gold = num(party.gold);
  return (
    <Panel title="⚔️ 小队" className="km-party">
      {!members.length && !enemies.length && <Empty>暂无队伍数据</Empty>}
      {members.length > 0 && (
        <ul className="km-list">
          {members.map(([k, m]) => (
            <Fighter key={k} name={k} rec={m} />
          ))}
        </ul>
      )}
      {enemies.length > 0 && (
        <>
          <div className="km-sub">敌方</div>
          <ul className="km-list">
            {enemies.map(([k, e]) => (
              <Fighter key={k} name={k} rec={e} enemy />
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

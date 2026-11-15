import { Component, useEffect, useState, type CSSProperties, type ErrorInfo, type ReactNode } from 'react';
import type { MemoryPolicy, ModeId } from '@kesoku/protocol';
import { HpBar, ModeIcon, ProgressBar, UiIcon } from '@kesoku/ui';
import { detectActiveMode, normalizeModeId, type GameInstance } from './activeMode';
import { PolicyBadge } from './PolicyBadge';
import { arr, entries, file, label, labels, num, obj, str, type Obj } from './safe';

export type HudPanel = 'mistakes' | 'roster' | 'party' | 'dex' | 'lesson' | 'travel' | 'memory';

/** Default right-column / half-sheet inspector panel per mode (UI doc Screen 13 table). */
export const HUD_PANELS: Readonly<Record<ModeId, HudPanel>> = Object.freeze({
  chat: 'memory',
  galgame: 'memory',
  travel_companion: 'travel',
  translator: 'memory',
  jp_classroom: 'lesson',
  trpg: 'party',
  pokemon_assistant: 'dex',
  story_theater: 'roster',
});

export interface ModeHudProps {
  modeId: ModeId;
  stateFiles: Record<string, unknown>;
  modePrefs: Record<string, unknown>;
  policy: MemoryPolicy;
  onPolicyChange(p: MemoryPolicy): void;
  onPrefsChange(prefs: Record<string, unknown>): void;
  onOpenPanel(panel: HudPanel): void;
}

interface HudCtx extends ModeHudProps {
  badge: ReactNode;
  instance: GameInstance | null;
}

// ---------------------------------------------------------------------------------------------
// Shared bits

/** Re-render every `intervalMs` (null = no ticking). */
function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs == null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function Row({ children, badge }: { children?: ReactNode; badge: ReactNode }) {
  return (
    <div className="k-hud-row">
      <div className="k-hud-main">{children}</div>
      {badge}
    </div>
  );
}

function Chip({
  children,
  onClick,
  tone = 'neutral',
  title,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: 'neutral' | 'mode' | 'warn' | 'danger' | 'ok' | 'primary';
  title?: string;
  className?: string;
}) {
  const cls = ['k-hud-chip', `is-${tone}`, className].filter(Boolean).join(' ');
  if (onClick)
    return (
      <button type="button" className={cls} onClick={onClick} title={title}>
        {children}
      </button>
    );
  return (
    <span className={cls} title={title}>
      {children}
    </span>
  );
}

function findInstance(stateFiles: Record<string, unknown>, modeId: ModeId): GameInstance | null {
  const raw = stateFiles?.['game/games.json'];
  const list = Array.isArray(raw) ? raw : arr(obj(raw)?.instances);
  const active = list
    .map(obj)
    .filter((i): i is Obj => !!i && i.active !== false && !i.archived) as GameInstance[];
  const own = active.filter((i) => normalizeModeId(str(i.game) ?? str(i.short)) === modeId);
  if (own.length) return own[own.length - 1];
  try {
    return detectActiveMode(stateFiles).instance;
  } catch {
    return null;
  }
}

function slot(instance: GameInstance | null, key: string): unknown {
  const slots = obj(instance?.slots);
  const v = slots?.[key];
  // games.json slots may be `{value, ...}` descriptors or plain values.
  const o = obj(v);
  return o && 'value' in o ? o.value : v;
}

// ---------------------------------------------------------------------------------------------
// galgame · 📍 location · clock + timed marks

interface TimedMark {
  key: string;
  text: string;
  icon?: string;
  expiresAt?: number;
  turns?: number;
  until?: string;
}

export function timedMarks(scene: Obj | undefined): TimedMark[] {
  const out: TimedMark[] = [];
  arr(scene?.marks).forEach((m, i) => {
    const mk = obj(m);
    if (!mk || mk.done === true || mk.expired === true || mk.status === 'done') return;
    const text = str(mk.text) ?? str(mk.label) ?? str(mk.name);
    if (!text) return;
    const type = str(mk.until_type);
    let exp = num(mk.expires_at);
    if (exp !== undefined && exp < 1e12) exp *= 1000; // epoch seconds → ms
    const turns = num(mk.remaining_turns);
    if (exp === undefined && turns === undefined && type !== 'time') return; // untimed marks stay in the scene panel
    out.push({
      key: str(mk.id) ?? `${i}:${text}`,
      text,
      icon: str(mk.icon),
      expiresAt: exp,
      turns: type === 'turns' || exp === undefined ? turns : undefined,
      until: str(mk.until_clock) ?? str(mk.until),
    });
  });
  return out;
}

export function formatRemaining(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h${String(mm).padStart(2, '0')}m` : `${h}h`;
}

function clockText(v: unknown): string | undefined {
  const s = label(v);
  if (!s) return undefined;
  const hits = s.match(/\d{1,2}:\d{2}/g);
  return hits ? hits[hits.length - 1] : s;
}

/** Galgame scene pills, also reused by the Galgame stage's top glass row. */
export function SceneChips({ scene, glass }: { scene: unknown; glass?: boolean }) {
  const sc = obj(scene);
  const marks = timedMarks(sc);
  const soonest = marks.reduce<number | null>((acc, m) => (m.expiresAt === undefined ? acc : acc === null ? m.expiresAt : Math.min(acc, m.expiresAt)), null);
  const now = useNow(soonest === null ? null : soonest - Date.now() < 120_000 ? 1000 : 15_000);
  const location = label(sc?.location);
  const clock = clockText(sc?.clock);
  const tone = glass ? 'is-glass' : '';
  return (
    <>
      {(location || clock) && (
        <Chip className={tone}>
          <UiIcon name="location" size={15} />
          <span className="k-hud-ellipsis">{[location, clock].filter(Boolean).join(' · ')}</span>
        </Chip>
      )}
      {marks.map((m) => {
        let tail: string | undefined;
        if (m.expiresAt !== undefined) {
          const left = m.expiresAt - now;
          if (left <= 0) return null;
          tail = formatRemaining(left);
        } else if (m.turns !== undefined) {
          if (m.turns <= 0) return null;
          tail = `剩余${m.turns}轮`;
        } else if (m.until) {
          tail = `至 ${clockText(m.until) ?? m.until}`;
        }
        return (
          <Chip key={m.key} tone="danger" className={['k-hud-mark', tone].filter(Boolean).join(' ')}>
            {m.icon && !/\p{Extended_Pictographic}/u.test(m.icon) ? <span aria-hidden>{m.icon}</span> : <UiIcon name="clock" size={15} />}
            <span className="k-hud-ellipsis">{m.text}</span>
            {tail && <b className="k-hud-num">{tail}</b>}
          </Chip>
        );
      })}
    </>
  );
}

function GalgameHud({ stateFiles, badge }: HudCtx) {
  return (
    <Row badge={badge}>
      <SceneChips scene={file(stateFiles, 'game/scene.json')} />
    </Row>
  );
}

// ---------------------------------------------------------------------------------------------
// jp_classroom · lesson progress + 📕 错题 N

export function mistakesCount(stateFiles: Record<string, unknown>): number | undefined {
  const lesson = file(stateFiles, 'game/lesson.json');
  for (const k of ['due_mistakes', 'mistakes_due', 'due_count', 'mistakes_count']) {
    const n = num(lesson?.[k]);
    if (n !== undefined) return Math.max(0, Math.floor(n));
  }
  if (Array.isArray(lesson?.mistakes)) return lesson.mistakes.length;
  const m = stateFiles?.['game/mistakes.json'];
  if (Array.isArray(m)) return m.length;
  const mo = obj(m);
  if (mo) {
    const n = num(mo.due_count);
    if (n !== undefined) return Math.max(0, Math.floor(n));
    for (const k of ['due', 'items', 'active']) if (Array.isArray(mo[k])) return (mo[k] as unknown[]).length;
  }
  return undefined;
}

function LessonHud({ stateFiles, badge, onOpenPanel }: HudCtx) {
  const lesson = file(stateFiles, 'game/lesson.json');
  const book = str(lesson?.book);
  const no = num(lesson?.lesson);
  const total = arr(lesson?.segments).length || num(lesson?.total_segments) || 0;
  const idx = num(lesson?.segment_index) ?? 0;
  const pos = total ? Math.max(1, Math.min(total, Math.floor(idx) + 1)) : 0;
  const head = [book, no ? `第${no}课` : str(lesson?.title)].filter(Boolean).join(' ');
  const count = mistakesCount(stateFiles);
  return (
    <Row badge={badge}>
      {head && (
        <button type="button" className="k-hud-lesson" onClick={() => onOpenPanel('lesson')}>
          <ProgressBar value={pos} max={total || 1} label={total ? `${head} · ${pos}/${total}` : head} />
        </button>
      )}
      <Chip tone="danger" onClick={() => onOpenPanel('mistakes')} className="k-hud-mistakes">
        <UiIcon name="book" size={15} />
        <span>错题{count !== undefined ? ` ${count}` : ''}</span>
      </Chip>
    </Row>
  );
}

// ---------------------------------------------------------------------------------------------
// travel_companion · 🛡️ 已启用忌口

function TravelHud({ stateFiles, badge, onOpenPanel, instance }: HudCtx) {
  const travel = file(stateFiles, 'game/travel.json');
  const dietary = labels(travel?.dietary ?? slot(instance, 'dietary'));
  const city = label(travel?.city ?? slot(instance, 'city'));
  const order = arr(travel?.order ?? obj(travel?.order)?.items);
  return (
    <Row badge={badge}>
      {dietary.length > 0 && (
        <Chip tone="primary" onClick={() => onOpenPanel('memory')} className="k-hud-dietary" title="记忆库 · 个人档案">
          <UiIcon name="shield" size={15} />
          <span className="k-hud-ellipsis">已启用忌口：{dietary.join(' · ')}</span>
        </Chip>
      )}
      {city && (
        <Chip>
          <UiIcon name="location" size={15} />
          <span className="k-hud-ellipsis">{city}</span>
        </Chip>
      )}
      {order.length > 0 && (
        <Chip tone="mode" onClick={() => onOpenPanel('travel')}>
          <UiIcon name="receipt" size={15} />
          <span>点单 {order.length}</span>
        </Chip>
      )}
    </Row>
  );
}

// ---------------------------------------------------------------------------------------------
// translator · 日语 ⇄ 简中 + quick pills

const LANG_LABELS: Record<string, string> = {
  ja: '日语',
  zh: '简中',
  'zh-hans': '简中',
  'zh-cn': '简中',
  'zh-hant': '繁中',
  'zh-tw': '繁中',
  en: '英语',
  ko: '韩语',
  fr: '法语',
  de: '德语',
  es: '西语',
  ru: '俄语',
  th: '泰语',
  vi: '越南语',
};
const QUICK_LANGS = ['ja', 'en', 'ko'] as const;

function langLabel(code: string): string {
  return LANG_LABELS[code.toLowerCase()] ?? code;
}

function isZh(code: string): boolean {
  const c = code.toLowerCase();
  return c === 'zh' || c.startsWith('zh-') || c === '简中' || c === '中文';
}

function TranslatorHud({ stateFiles, modePrefs, badge, onPrefsChange, instance }: HudCtx) {
  const tj = file(stateFiles, 'game/translator.json');
  const src = str(modePrefs?.src_lang) ?? str(tj?.src_lang) ?? str(slot(instance, 'src_lang')) ?? 'ja';
  const dst = str(modePrefs?.dst_lang) ?? str(tj?.dst_lang) ?? str(slot(instance, 'dst_lang')) ?? 'zh';
  const foreign = isZh(dst) ? src : isZh(src) ? dst : src;
  const pick = (code: string) => {
    if (isZh(dst)) onPrefsChange({ src_lang: code, dst_lang: dst });
    else if (isZh(src)) onPrefsChange({ src_lang: src, dst_lang: code });
    else onPrefsChange({ src_lang: code, dst_lang: 'zh' });
  };
  return (
    <Row badge={badge}>
      <span className="k-hud-pair" role="group" aria-label="语言对">
        <span className="k-hud-pair-lang">{langLabel(src)}</span>
        <button
          type="button"
          className="k-hud-swap"
          aria-label="互换语言"
          onClick={() => onPrefsChange({ src_lang: dst, dst_lang: src })}
        >
          <UiIcon name="swap" size={16} />
        </button>
        <span className="k-hud-pair-lang">{langLabel(dst)}</span>
      </span>
      {QUICK_LANGS.map((code) => (
        <button
          key={code}
          type="button"
          className={'k-hud-quick' + (foreign.toLowerCase() === code ? ' is-on' : '')}
          aria-pressed={foreign.toLowerCase() === code}
          onClick={() => pick(code)}
        >
          {langLabel(code)}
        </button>
      ))}
    </Row>
  );
}

// ---------------------------------------------------------------------------------------------
// trpg · world slot + 1+3 squad & boss HP strip

const NON_COMBAT = new Set(['narrator', 'support', 'reserve']);

interface Fighter {
  key: string;
  name: string;
  hp?: number;
  max?: number;
  status: string[];
  role?: string;
  tag?: string;
}

function fighter(key: string, rec: Obj): Fighter {
  const hp = num(rec.hp);
  const max = num(rec.max_hp) ?? num(rec.hp_max) ?? num(rec.maxHp);
  return {
    key,
    name: str(rec.display_name) ?? str(rec.name) ?? key,
    hp,
    max: max ?? hp,
    status: labels(rec.status ?? rec.statuses).slice(0, 3),
    role: str(rec.role),
    tag: label(rec.form) ?? label(rec.tag),
  };
}

export function squad(party: Obj | undefined): { members: Fighter[]; enemies: Fighter[] } {
  const members = entries(party?.members)
    .map(([k, r]) => fighter(k, r))
    .filter((m) => !m.role || !NON_COMBAT.has(m.role))
    .sort((a, b) => Number(b.role === 'player') - Number(a.role === 'player'));
  const enemies = entries(party?.enemies)
    .map(([k, r]) => fighter(k, r))
    .filter((e) => e.hp === undefined || e.hp > 0)
    .sort((a, b) => (b.max ?? 0) - (a.max ?? 0));
  return { members, enemies };
}

function HpText({ f }: { f: Fighter }) {
  if (f.hp === undefined) return null;
  return (
    <span className="k-hud-num">
      HP {f.hp}
      {f.max !== undefined ? `/${f.max}` : ''}
    </span>
  );
}

function TrpgHud({ stateFiles, badge, onOpenPanel, instance }: HudCtx) {
  const [collapsed, setCollapsed] = useState(false);
  const world = label(slot(instance, 'world'));
  const scenario = label(slot(instance, 'scenario')) ?? label(slot(instance, 'chapter'));
  const { members, enemies } = squad(file(stateFiles, 'game/party.json'));
  const hasSquad = members.length > 0 || enemies.length > 0;
  const shownEnemies = enemies.slice(0, 2);
  return (
    <>
      <Row badge={badge}>
        {(world || scenario) && (
          <Chip tone="mode" className="k-hud-world">
            <ModeIcon mode="trpg" size={16} styleVariant="line" color="currentColor" />
            <span className="k-hud-ellipsis">{[world, scenario].filter(Boolean).join(' · ')}</span>
          </Chip>
        )}
        {hasSquad && collapsed && (
          <button type="button" className="k-hud-squad-mini" onClick={() => onOpenPanel('party')}>
            {[...members, ...shownEnemies].map((f) => (
              <span key={f.key} className="k-hud-num">
                {f.name} {f.hp ?? '–'}
                {f.max !== undefined ? `/${f.max}` : ''}
              </span>
            ))}
          </button>
        )}
        {hasSquad && (
          <button
            type="button"
            className="k-hud-collapse"
            aria-expanded={!collapsed}
            aria-label={collapsed ? '展开小队' : '收起小队'}
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? '▸' : '▾'}
          </button>
        )}
      </Row>
      {hasSquad && !collapsed && (
        <div className="k-hud-squad">
          {shownEnemies.map((e) => (
            <button type="button" key={`e:${e.key}`} className="k-hud-boss" onClick={() => onOpenPanel('party')}>
              <span className="k-hud-fname">
                <UiIcon name="target" size={14} /> {e.name}
              </span>
              {e.status.map((s) => (
                <span key={s} className="k-hud-status is-danger">
                  {s}
                </span>
              ))}
              <HpText f={e} />
              {e.hp !== undefined && <HpBar hp={e.hp} max={e.max ?? e.hp} />}
            </button>
          ))}
          {enemies.length > shownEnemies.length && <span className="k-hud-more">+{enemies.length - shownEnemies.length}</span>}
          {members.length > 0 && (
            <div className="k-hud-members" style={{ '--cols': Math.min(4, members.length) } as CSSProperties}>
              {members.map((m) => (
                <button
                  type="button"
                  key={`m:${m.key}`}
                  className={'k-hud-member' + (m.role === 'player' ? ' is-player' : '')}
                  onClick={() => onOpenPanel('party')}
                >
                  <span className="k-hud-fname">{m.name}</span>
                  {(m.tag || m.status.length > 0) && (
                    <span className="k-hud-statuses">
                      {m.tag && <span className="k-hud-status is-accent">{m.tag}</span>}
                      {m.status.map((s) => (
                        <span key={s} className="k-hud-status">
                          {s}
                        </span>
                      ))}
                    </span>
                  )}
                  <HpText f={m} />
                  {m.hp !== undefined && <HpBar hp={m.hp} max={m.max ?? m.hp} />}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// pokemon_assistant · version switcher + pinned chip

export type GameVersion = 'sv' | 'za';
export const VERSION_LABELS: Readonly<Record<GameVersion, string>> = Object.freeze({ sv: '朱／紫 SV', za: '传说 Z-A' });

export function resolveGameVersion(modePrefs: Record<string, unknown> | undefined, stateFiles: Record<string, unknown>): GameVersion {
  const raw = (str(modePrefs?.game_version) ?? str(file(stateFiles, 'game/pokemon.json')?.game_version) ?? 'sv').toLowerCase();
  return raw === 'za' ? 'za' : 'sv';
}

function pinnedName(modePrefs: Record<string, unknown> | undefined, stateFiles: Record<string, unknown>): string | undefined {
  if (modePrefs && 'pinned_context' in modePrefs) return label(modePrefs.pinned_context);
  const pj = file(stateFiles, 'game/pokemon.json');
  return label(pj?.pinned_context) ?? label(pj?.pinned);
}

function PokemonHud({ stateFiles, modePrefs, badge, onPrefsChange, onOpenPanel }: HudCtx) {
  const [open, setOpen] = useState(false);
  const version = resolveGameVersion(modePrefs, stateFiles);
  const pinned = pinnedName(modePrefs, stateFiles);
  return (
    <Row badge={badge}>
      <span className="k-hud-ver-wrap">
        <button
          type="button"
          className={`k-hud-ver is-${version}`}
          aria-haspopup="true"
          aria-expanded={open}
          aria-label={`作品版本：${VERSION_LABELS[version]}`}
          onClick={() => setOpen((o) => !o)}
        >
          {VERSION_LABELS[version]}
          <span className="k-caret" aria-hidden>
            ▾
          </span>
        </button>
        {open && (
          <span className="k-hud-ver-pop" role="group" aria-label="切换作品版本">
            {(Object.keys(VERSION_LABELS) as GameVersion[]).map((v) => (
              <button
                key={v}
                type="button"
                className={`k-hud-ver-opt is-${v}` + (v === version ? ' is-on' : '')}
                aria-pressed={v === version}
                onClick={() => {
                  setOpen(false);
                  if (v !== version) onPrefsChange({ game_version: v });
                }}
              >
                {VERSION_LABELS[v]}
              </button>
            ))}
          </span>
        )}
      </span>
      {pinned && (
        <span className="k-hud-pin">
          <button type="button" className="k-hud-pin-body" onClick={() => onOpenPanel('dex')} title="展开图鉴">
            <UiIcon name="pin" size={14} /> {pinned}
          </button>
          <button type="button" className="k-hud-pin-x" aria-label={`解除锁定 ${pinned}`} onClick={() => onPrefsChange({ pinned_context: null })}>
            <UiIcon name="close" size={13} />
          </button>
        </span>
      )}
    </Row>
  );
}

// ---------------------------------------------------------------------------------------------
// story_theater · 📖 chapter (片段 i/n) + 🎭 定妆表 (N)

function StoryHud({ stateFiles, badge, onOpenPanel, instance }: HudCtx) {
  const src = file(stateFiles, 'game/source.json');
  const book = str(src?.book_title) ?? label(slot(instance, 'book')) ?? str(instance?.title);
  const chapterNo = num(src?.chapter_idx) ?? num(slot(instance, 'chapter'));
  const chapter = str(src?.chapter_title) ?? (chapterNo ? `第${chapterNo}回` : undefined);
  const chunks = arr(src?.chunks).length || num(src?.total_chunks) || 0;
  const ci = num(src?.chunk_index) ?? 0;
  const pos = chunks ? Math.max(1, Math.min(chunks, Math.floor(ci) + 1)) : 0;
  const head = [book, chapter].filter(Boolean).join(' · ');
  const roster = file(stateFiles, 'game/roster.json');
  const rosterRaw = roster?.members ?? stateFiles?.['game/roster.json'];
  const rosterN = Array.isArray(rosterRaw) ? rosterRaw.length : obj(rosterRaw) ? Object.keys(obj(rosterRaw)!).length : undefined;
  return (
    <Row badge={badge}>
      {head && (
        <span className="k-hud-chapter">
          <span className="k-hud-ellipsis">
            <UiIcon name="book" size={14} /> {head}
            {chunks ? <b className="k-hud-num"> (片段 {pos}/{chunks})</b> : null}
          </span>
          {chunks > 0 && (
            <span className="k-hud-chapter-bar">
              <ProgressBar value={pos} max={chunks} />
            </span>
          )}
        </span>
      )}
      <Chip tone="mode" onClick={() => onOpenPanel('roster')} className="k-hud-roster">
        <ModeIcon mode="story_theater" size={15} styleVariant="line" color="currentColor" />
        <span>定妆表{rosterN !== undefined ? ` (${rosterN})` : ''}</span>
      </Chip>
    </Row>
  );
}

// ---------------------------------------------------------------------------------------------

const HUDS: Partial<Record<ModeId, (c: HudCtx) => ReactNode>> = {
  galgame: GalgameHud,
  jp_classroom: LessonHud,
  travel_companion: TravelHud,
  translator: TranslatorHud,
  trpg: TrpgHud,
  pokemon_assistant: PokemonHud,
  story_theater: StoryHud,
};

class HudBoundary extends Component<{ fallback: ReactNode; resetKey: unknown; children: ReactNode }, { failed: boolean; key: unknown }> {
  override state = { failed: false, key: this.props.resetKey };
  static getDerivedStateFromError(): Partial<{ failed: boolean }> {
    return { failed: true };
  }
  static getDerivedStateFromProps(props: { resetKey: unknown }, state: { failed: boolean; key: unknown }) {
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null;
  }
  override componentDidCatch(_e: unknown, _info: ErrorInfo): void {
    /* malformed state file: render the fallback strip, never crash the stage */
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Mode HUD slot under the top bar (non-chat modes only). Always carries the memory-policy badge;
 * the rest is driven purely by `$STAGING_DIR/game/*.json` state files and per-session mode prefs.
 */
export function ModeHud(props: ModeHudProps) {
  const { modeId, stateFiles, policy, onPolicyChange } = props;
  if (!modeId || modeId === 'chat') return null;
  const files = stateFiles && typeof stateFiles === 'object' ? stateFiles : {};
  const badge = <PolicyBadge modeId={modeId} policy={policy} onPolicyChange={onPolicyChange} />;
  const Hud = HUDS[modeId];
  let instance: GameInstance | null = null;
  try {
    instance = findInstance(files, modeId);
  } catch {
    instance = null;
  }
  const fallback = <Row badge={badge} />;
  return (
    <section
      className="k-hud"
      data-mode={modeId}
      aria-label="模式状态"
      style={{ '--mode': `var(--m-${modeId})` } as CSSProperties}
    >
      <HudBoundary fallback={fallback} resetKey={files}>
        {Hud ? <Hud {...props} stateFiles={files} modePrefs={props.modePrefs ?? {}} badge={badge} instance={instance} /> : fallback}
      </HudBoundary>
    </section>
  );
}

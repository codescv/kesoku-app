import { Component, useEffect, useState, type CSSProperties, type ErrorInfo, type ReactNode } from 'react';
import type { MemoryPolicy, ModeId } from '@kesoku/protocol';
import { ModeIcon, ProgressBar, UiIcon, t, useT, type MessageKey } from '@kesoku/ui';
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
  /**
   * True when the desktop right sidebar (context inspector) is visible and already shows the full
   * mode panel (e.g. TRPG party HP / equipment) — the HUD then omits redundant entry points.
   */
  inspectorVisible?: boolean;
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
  testId,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: 'neutral' | 'mode' | 'warn' | 'danger' | 'ok' | 'primary';
  title?: string;
  className?: string;
  testId?: string;
}) {
  const cls = ['k-hud-chip', `is-${tone}`, className].filter(Boolean).join(' ');
  if (onClick)
    return (
      <button type="button" className={cls} onClick={onClick} title={title} data-testid={testId}>
        {children}
      </button>
    );
  return (
    <span className={cls} title={title} data-testid={testId}>
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
  const tr = useT();
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
          tail = tr('hud.remainingTurns', { n: m.turns });
        } else if (m.until) {
          tail = tr('hud.untilTime', { time: clockText(m.until) ?? m.until });
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
  const tr = useT();
  const lesson = file(stateFiles, 'game/lesson.json');
  const book = str(lesson?.book);
  const no = num(lesson?.lesson);
  const total = arr(lesson?.segments).length || num(lesson?.total_segments) || 0;
  const idx = num(lesson?.segment_index) ?? 0;
  const pos = total ? Math.max(1, Math.min(total, Math.floor(idx) + 1)) : 0;
  const head = [book, no ? tr('hud.lessonNo', { no }) : str(lesson?.title)].filter(Boolean).join(' ');
  const count = mistakesCount(stateFiles);
  return (
    <Row badge={badge}>
      {head && (
        <button type="button" className="k-hud-lesson" onClick={() => onOpenPanel('lesson')}>
          <ProgressBar value={pos} max={total || 1} label={total ? `${head} · ${pos}/${total}` : head} />
        </button>
      )}
      <Chip tone="danger" onClick={() => onOpenPanel('mistakes')} className={'k-hud-mistakes' + (count !== undefined ? ' has-count' : '')}>
        <UiIcon name="book" size={15} />
        <span>
          <span className="k-hud-mistakes-label">{tr('hud.mistakes')}</span>
          {count !== undefined ? ` ${count}` : ''}
        </span>
      </Chip>
    </Row>
  );
}

// ---------------------------------------------------------------------------------------------
// travel_companion · 🛡️ dietary enabled

function TravelHud({ stateFiles, badge, onOpenPanel, instance }: HudCtx) {
  const tr = useT();
  const travel = file(stateFiles, 'game/travel.json');
  const dietary = labels(travel?.dietary ?? slot(instance, 'dietary'));
  const city = label(travel?.city ?? slot(instance, 'city'));
  const order = arr(travel?.order ?? obj(travel?.order)?.items);
  return (
    <Row badge={badge}>
      {dietary.length > 0 && (
        <Chip tone="primary" onClick={() => onOpenPanel('memory')} className="k-hud-dietary" title={tr('hud.dietaryTitle')}>
          <UiIcon name="shield" size={15} />
          <span className="k-hud-ellipsis">{tr('hud.dietaryEnabled', { list: dietary.join(' · ') })}</span>
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
          <span>{tr('hud.orderCount', { n: order.length })}</span>
        </Chip>
      )}
    </Row>
  );
}

// ---------------------------------------------------------------------------------------------
// translator · 日语 ⇄ 简中 + quick pills

export interface TranslatorLang {
  /** BCP-47-ish code sent to the engine (`native_lang`, `src_lang`, ...). */
  code: string;
  /** Short Chinese label used on pills (`简中`, `日语`, ...). */
  label: string;
  /** Endonym shown in pickers (`简体中文`, `日本語`, ...). */
  name: string;
}

function liveLang(code: string, name: string): TranslatorLang {
  const key = `tlang.${code}` as MessageKey;
  return Object.freeze({
    code,
    get label() {
      return t(key);
    },
    name,
  });
}

/** Translator language catalog (native / foreign language pickers, HUD pills). */
export const TRANSLATOR_LANGS: ReadonlyArray<TranslatorLang> = Object.freeze([
  liveLang('zh-CN', '简体中文'),
  liveLang('zh-TW', '繁體中文'),
  liveLang('ja', '日本語'),
  liveLang('en', 'English'),
  liveLang('ko', '한국어'),
  liveLang('fr', 'Français'),
  liveLang('de', 'Deutsch'),
  liveLang('es', 'Español'),
  liveLang('ru', 'Русский'),
  liveLang('th', 'ไทย'),
  liveLang('vi', 'Tiếng Việt'),
  liveLang('it', 'Italiano'),
  liveLang('pt', 'Português'),
]);
export const DEFAULT_NATIVE_LANG = 'zh-CN';
export const DEFAULT_FOREIGN_LANGS: readonly string[] = Object.freeze(['ja', 'en', 'ko']);
export const MAX_FOREIGN_LANGS = 8;

const LANG_ALIASES: Record<string, string> = {
  zh: 'zh-cn',
  'zh-hans': 'zh-cn',
  'zh-sg': 'zh-cn',
  简中: 'zh-cn',
  中文: 'zh-cn',
  简体中文: 'zh-cn',
  'zh-hant': 'zh-tw',
  'zh-hk': 'zh-tw',
  'zh-mo': 'zh-tw',
  繁中: 'zh-tw',
  繁體中文: 'zh-tw',
  'ja-jp': 'ja',
  'en-us': 'en',
  'en-gb': 'en',
  'ko-kr': 'ko',
  'pt-br': 'pt',
  'pt-pt': 'pt',
};

/** Canonical comparison key for a language code (`zh` / `zh-Hans` / `简中` → `zh-cn`). */
export function langKey(code: string): string {
  const c = code.trim().toLowerCase().replace(/_/g, '-');
  return LANG_ALIASES[c] ?? c;
}

/** Whether `code` is the user's native language (alias-aware: `zh` matches `zh-CN`). */
export function isNativeLang(code: string, nativeLang: string): boolean {
  return langKey(code) === langKey(nativeLang);
}

/** Short pill label (`日语`) for any code; unknown codes are shown verbatim. */
export function translatorLangLabel(code: string): string {
  const k = langKey(code);
  return TRANSLATOR_LANGS.find((l) => l.code.toLowerCase() === k)?.label ?? code;
}

function langLabel(code: string): string {
  return translatorLangLabel(code);
}

/** Normalise a configured foreign-language list: known strings, deduped, never the native language. */
export function normalizeForeignLangs(v: unknown, nativeLang: string): string[] {
  const raw = Array.isArray(v) ? labels(v) : typeof v === 'string' ? v.split(/[,，\s]+/) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    const c = r.trim();
    if (!c || isNativeLang(c, nativeLang) || seen.has(langKey(c))) continue;
    seen.add(langKey(c));
    out.push(c);
  }
  return out.slice(0, MAX_FOREIGN_LANGS);
}

export interface TranslatorPair {
  nativeLang: string;
  foreignLangs: string[];
  src: string;
  dst: string;
  /** The non-native side of the active pair (the one quick pills switch). */
  foreign: string;
  formality?: string;
}

/** Resolve the translator configuration from session prefs → `game/translator.json` → game slots → defaults. */
export function resolveTranslatorPair(
  modePrefs: Record<string, unknown> | undefined,
  stateFiles: Record<string, unknown>,
  instance: GameInstance | null = null,
): TranslatorPair {
  const tj = file(stateFiles, 'game/translator.json');
  const nativeLang = str(modePrefs?.native_lang) ?? str(tj?.native_lang) ?? str(slot(instance, 'native_lang')) ?? DEFAULT_NATIVE_LANG;
  let foreignLangs = normalizeForeignLangs(modePrefs?.foreign_langs ?? tj?.foreign_langs ?? slot(instance, 'foreign_langs'), nativeLang);
  if (!foreignLangs.length) foreignLangs = DEFAULT_FOREIGN_LANGS.filter((c) => !isNativeLang(c, nativeLang));
  // `auto` (the game slot default) means "not chosen": fall back to 常用外语[0] ⇄ 母语.
  const lang = (v: unknown) => {
    const x = str(v);
    return x && x.toLowerCase() !== 'auto' ? x : undefined;
  };
  const src = lang(modePrefs?.src_lang) ?? lang(tj?.src_lang) ?? lang(slot(instance, 'src_lang')) ?? (foreignLangs[0] || 'ja');
  const dst = lang(modePrefs?.dst_lang) ?? lang(tj?.dst_lang) ?? lang(slot(instance, 'dst_lang')) ?? nativeLang;
  const foreign = isNativeLang(dst, nativeLang) ? src : isNativeLang(src, nativeLang) ? dst : src;
  const formality = str(modePrefs?.formality) ?? str(tj?.formality) ?? str(slot(instance, 'formality'));
  return { nativeLang, foreignLangs, src, dst, foreign, formality };
}

const FORMALITIES: ReadonlyArray<{ id: 'polite' | 'casual'; key: MessageKey }> = [
  { id: 'polite', key: 'hud.formalityPolite' },
  { id: 'casual', key: 'hud.formalityCasual' },
];

/** Inline native / foreign / formality configurator (opened from the translator HUD's language button). */
function TranslatorLangSettings({ pair, onPrefsChange }: { pair: TranslatorPair; onPrefsChange(p: Record<string, unknown>): void }) {
  const tr = useT();
  const { nativeLang, foreignLangs, foreign } = pair;
  const setNative = (code: string) => {
    if (isNativeLang(code, nativeLang)) return;
    let fl = foreignLangs.filter((c) => !isNativeLang(c, code));
    // The old native language becomes a foreign one, so the user can still translate to/from it.
    if (!fl.some((c) => isNativeLang(c, nativeLang))) fl = [...fl, nativeLang].slice(0, MAX_FOREIGN_LANGS);
    const nextForeign = !isNativeLang(foreign, code) ? foreign : fl[0] || 'ja';
    onPrefsChange({ native_lang: code, foreign_langs: fl, src_lang: nextForeign, dst_lang: code });
  };
  const toggleForeign = (code: string) => {
    const on = foreignLangs.some((c) => langKey(c) === langKey(code));
    if (on && foreignLangs.length <= 1) return; // keep at least one
    const fl = on ? foreignLangs.filter((c) => langKey(c) !== langKey(code)) : [...foreignLangs, code].slice(0, MAX_FOREIGN_LANGS);
    const patch: Record<string, unknown> = { foreign_langs: fl };
    // Removing the active foreign language moves the pair to the first remaining one.
    if (on && langKey(code) === langKey(foreign)) Object.assign(patch, { src_lang: fl[0], dst_lang: nativeLang });
    onPrefsChange(patch);
  };
  return (
    <div className="k-hud-langcfg" role="region" aria-label={tr('hud.translatorSettingsAria')}>
      <label className="k-hud-langcfg-row">
        <span className="k-hud-langcfg-k">{tr('hud.nativeLang')}</span>
        <select aria-label={tr('hud.nativeLang')} value={TRANSLATOR_LANGS.find((l) => isNativeLang(l.code, nativeLang))?.code ?? nativeLang} onChange={(e) => setNative(e.target.value)}>
          {TRANSLATOR_LANGS.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label} · {l.name}
            </option>
          ))}
        </select>
      </label>
      <div className="k-hud-langcfg-row" role="group" aria-label={tr('hud.foreignLangs')}>
        <span className="k-hud-langcfg-k">{tr('hud.foreignLangs')}</span>
        <span className="k-hud-langcfg-chips">
          {TRANSLATOR_LANGS.filter((l) => !isNativeLang(l.code, nativeLang)).map((l) => {
            const on = foreignLangs.some((c) => langKey(c) === langKey(l.code));
            return (
              <button
                key={l.code}
                type="button"
                className={'k-hud-quick is-sm' + (on ? ' is-on' : '')}
                aria-pressed={on}
                aria-label={tr('hud.foreignLangAria', { label: l.label })}
                title={l.name}
                onClick={() => toggleForeign(l.code)}
              >
                {l.label}
              </button>
            );
          })}
        </span>
      </div>
      <div className="k-hud-langcfg-row" role="group" aria-label={tr('hud.formality')}>
        <span className="k-hud-langcfg-k">{tr('hud.formality')}</span>
        <span className="k-hud-langcfg-chips">
          {FORMALITIES.map((f) => (
            <button
              key={f.id}
              type="button"
              className={'k-hud-quick is-sm' + (pair.formality === f.id ? ' is-on' : '')}
              aria-pressed={pair.formality === f.id}
              onClick={() => onPrefsChange({ formality: f.id })}
            >
              {tr(f.key)}
            </button>
          ))}
        </span>
      </div>
    </div>
  );
}

function TranslatorHud({ stateFiles, modePrefs, badge, onPrefsChange, instance }: HudCtx) {
  const tr = useT();
  const [cfgOpen, setCfgOpen] = useState(false);
  const pair = resolveTranslatorPair(modePrefs, stateFiles, instance);
  const { nativeLang, foreignLangs, src, dst, foreign } = pair;
  const pick = (code: string) => {
    if (isNativeLang(dst, nativeLang)) onPrefsChange({ src_lang: code, dst_lang: dst });
    else if (isNativeLang(src, nativeLang)) onPrefsChange({ src_lang: src, dst_lang: code });
    else onPrefsChange({ src_lang: code, dst_lang: nativeLang });
  };
  // The active foreign language always has a pill, even when it is not one of the user's foreign languages.
  const pills = foreignLangs.some((c) => langKey(c) === langKey(foreign)) || isNativeLang(foreign, nativeLang) ? foreignLangs : [...foreignLangs, foreign];
  return (
    <>
      <Row badge={badge}>
        <span className="k-hud-pair" role="group" aria-label={tr('hud.langPairAria')}>
          <span className="k-hud-pair-lang">{langLabel(src)}</span>
          <button
            type="button"
            className="k-hud-swap"
            aria-label={tr('hud.swapLangAria')}
            onClick={() => onPrefsChange({ src_lang: dst, dst_lang: src })}
          >
            <UiIcon name="swap" size={16} />
          </button>
          <span className="k-hud-pair-lang">{langLabel(dst)}</span>
        </span>
        {pills.map((code) => (
          <button
            key={code}
            type="button"
            className={'k-hud-quick' + (langKey(foreign) === langKey(code) ? ' is-on' : '')}
            aria-pressed={langKey(foreign) === langKey(code)}
            onClick={() => pick(code)}
          >
            {langLabel(code)}
          </button>
        ))}
        <button
          type="button"
          className={'k-hud-quick k-hud-langbtn' + (cfgOpen ? ' is-on' : '')}
          aria-label={tr('hud.langSettingsAria')}
          aria-expanded={cfgOpen}
          title={tr('hud.langSettingsTitle', { native: langLabel(nativeLang) })}
          onClick={() => setCfgOpen((v) => !v)}
        >
          <UiIcon name="globe" size={15} /> {tr('hud.langSettingsBtn')}
        </button>
      </Row>
      {cfgOpen && <TranslatorLangSettings pair={pair} onPrefsChange={onPrefsChange} />}
    </>
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

// Named combo techniques (合体技). Same availability rule as the engine's `combo_missing`.
const COMBO_FIELD_ROLES = new Set(['player', 'active', 'support']);
const COMBO_DEFAULT_COST = 2;
const COMBO_DEFAULT_MAX = 3;
const COMBO_STATUS_KEYS: Record<string, MessageKey> = {
  exposed: 'hud.comboStatus.exposed',
  staggered: 'hud.comboStatus.staggered',
  weakened: 'hud.comboStatus.weakened',
};

export interface ComboInfo {
  name: string;
  members: string[];
  cost: number;
  type: string;
  /** Effect summary, e.g. `2d8+4 · Staggered` / `Heal 2d6+2`. */
  tail: string;
  fx?: string;
  state: 'ready' | 'need' | 'missing';
  /** Participants that are absent, off the field (role) or down (hp ≤ 0). */
  missing: string[];
}

/** Party combo gauge: `combo` / `combo_max` (defaults 0 / 3), clamped to `0..max`. */
export function comboGauge(party: Obj | undefined): { value: number; max: number } {
  const rawMax = num(party?.combo_max);
  const max = rawMax !== undefined && rawMax > 0 ? Math.floor(rawMax) : COMBO_DEFAULT_MAX;
  const value = Math.max(0, Math.min(max, Math.floor(num(party?.combo) ?? 0)));
  return { value, max };
}

function comboTail(c: Obj): string {
  const status = str(c.status);
  const heal = str(c.heal);
  const statusKey = status ? COMBO_STATUS_KEYS[status.toLowerCase()] : undefined;
  return [str(c.dmg), c.aoe === true ? t('hud.comboAoe') : '', status ? (statusKey ? t(statusKey) : status) : '', heal ? t('hud.comboHeal', { val: heal }) : '']
    .filter(Boolean)
    .join(' · ');
}

/** Named combos from `game/party.json` with their availability against the current gauge and roster. */
export function partyCombos(party: Obj | undefined): ComboInfo[] {
  const list = party?.combos;
  if (!Array.isArray(list)) return [];
  const roster = new Map(entries(party?.members));
  const { value } = comboGauge(party);
  const out: ComboInfo[] = [];
  for (const raw of list) {
    const c = obj(raw);
    if (!c) continue;
    const name = str(c.name);
    const ms = c.members;
    if (!name || !Array.isArray(ms) || !ms.length || ms.some((m) => typeof m !== 'string' || !m.trim())) continue;
    const members = (ms as string[]).map((m) => m.trim());
    const cost = typeof c.cost === 'number' && Number.isFinite(c.cost) ? c.cost : COMBO_DEFAULT_COST;
    const missing = members.filter((m) => {
      const rec = roster.get(m);
      if (!rec) return true;
      const role = str(rec.role);
      if (!role || !COMBO_FIELD_ROLES.has(role)) return true;
      const hp = num(rec.hp);
      return hp !== undefined && hp <= 0;
    });
    out.push({
      name,
      members,
      cost,
      type: (str(c.type) ?? '').toLowerCase(),
      tail: comboTail(c),
      fx: str(c.fx),
      state: missing.length ? 'missing' : value >= cost ? 'ready' : 'need',
      missing,
    });
  }
  return out;
}

/** Active TRPG phase slot (`setup` | `camp` | `expedition` | `combat` | `''`), lowercased. */
export function trpgPhase(stateFiles: Record<string, unknown> | undefined): string {
  const inst = findInstance(stateFiles ?? {}, 'trpg');
  return (label(slot(inst, 'phase')) ?? '').trim().toLowerCase();
}

function TrpgHud({ stateFiles, badge, onOpenPanel, instance, inspectorVisible }: HudCtx) {
  const tr = useT();
  const world = label(slot(instance, 'world'));
  const scenario = label(slot(instance, 'scenario')) ?? label(slot(instance, 'chapter'));
  const phase = (label(slot(instance, 'phase')) ?? '').trim().toLowerCase();
  const inCamp = phase === 'camp';
  const party = file(stateFiles, 'game/party.json');
  const { members, enemies } = squad(party);
  const showEnemies = !inCamp && enemies.length > 0;
  const gauge = comboGauge(party);
  const readyCount = partyCombos(party).filter((c) => c.state === 'ready').length;
  // Always one compact row: no live HP strip. Full HP / stats / equipment live in the party panel —
  // the desktop right sidebar shows it permanently; elsewhere a small Party button opens it on demand.
  return (
    <Row badge={badge}>
      {(world || scenario) && (
        <Chip tone="mode" className="k-hud-world" title={[world, scenario].filter(Boolean).join(' · ')}>
          <ModeIcon mode="trpg" size={16} styleVariant="line" color="currentColor" />
          <span className="k-hud-ellipsis">{[world, scenario].filter(Boolean).join(' · ')}</span>
        </Chip>
      )}
      {!inspectorVisible && (
        <Chip tone="primary" className="k-hud-party-btn" onClick={() => onOpenPanel('party')} title={tr('hud.partyBtnTitle')} testId="trpg-party-btn">
          <UiIcon name="shield" size={14} />
          <span className="k-hud-party-label">{members.length > 0 ? tr('hud.partyCount', { n: members.length }) : tr('hud.partyEquip')}</span>
          {showEnemies && (
            <span className="k-hud-party-enemy" aria-label={tr('hud.enemyCountAria', { n: enemies.length })} data-testid="trpg-party-enemies">
              <UiIcon name="target" size={12} />
              <span className="k-hud-num">{enemies.length}</span>
            </span>
          )}
          {(gauge.value > 0 || showEnemies) && (
            <span
              className={'k-hud-party-combo' + (readyCount > 0 ? ' is-ready' : '')}
              aria-label={
                readyCount > 0
                  ? tr('hud.comboGaugeReadyAria', { value: gauge.value, max: gauge.max, ready: readyCount })
                  : tr('hud.comboGaugeAria', { value: gauge.value, max: gauge.max })
              }
              data-testid="trpg-party-combo"
            >
              <span className="k-hud-num">
                {gauge.value}/{gauge.max}
              </span>
            </span>
          )}
        </Chip>
      )}
    </Row>
  );
}

// ---------------------------------------------------------------------------------------------
// pokemon_assistant · version switcher + pinned chip

export type GameVersion = 'sv' | 'za';
export const VERSION_LABELS: Readonly<Record<GameVersion, string>> = Object.freeze({
  get sv() {
    return t('pkmn.ver.sv');
  },
  get za() {
    return t('pkmn.ver.za');
  },
});

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
  const tr = useT();
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
          aria-label={tr('hud.gameVersionAria', { label: VERSION_LABELS[version] })}
          onClick={() => setOpen((o) => !o)}
        >
          {VERSION_LABELS[version]}
          <span className="k-caret" aria-hidden>
            ▾
          </span>
        </button>
        {open && (
          <span className="k-hud-ver-pop" role="group" aria-label={tr('hud.switchGameVersionAria')}>
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
          <button type="button" className="k-hud-pin-body" onClick={() => onOpenPanel('dex')} title={tr('hud.openDexTitle')}>
            <UiIcon name="pin" size={14} /> {pinned}
          </button>
          <button type="button" className="k-hud-pin-x" aria-label={tr('hud.unpinAria', { name: pinned })} onClick={() => onPrefsChange({ pinned_context: null })}>
            <UiIcon name="close" size={13} />
          </button>
        </span>
      )}
    </Row>
  );
}

// ---------------------------------------------------------------------------------------------
// story_theater · 📖 chapter + 🎭 cast sheet

function StoryHud({ stateFiles, badge, onOpenPanel, instance }: HudCtx) {
  const tr = useT();
  const src = file(stateFiles, 'game/source.json');
  const book = str(src?.book_title) ?? label(slot(instance, 'book')) ?? str(instance?.title);
  const chapterNo = num(src?.chapter_idx) ?? num(slot(instance, 'chapter'));
  const chapter = str(src?.chapter_title) ?? (chapterNo ? tr('hud.chapterNo', { no: chapterNo }) : undefined);
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
            {chunks ? <b className="k-hud-num">{tr('hud.chunkProgress', { pos, total: chunks })}</b> : null}
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
        <span>
          {tr('hud.roster')}
          {rosterN !== undefined ? ` (${rosterN})` : ''}
        </span>
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
  const tr = useT();
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
      aria-label={tr('hud.ariaLabel')}
      style={{ '--mode': `var(--m-${modeId})` } as CSSProperties}
    >
      <HudBoundary fallback={fallback} resetKey={files}>
        {Hud ? <Hud {...props} stateFiles={files} modePrefs={props.modePrefs ?? {}} badge={badge} instance={instance} /> : fallback}
      </HudBoundary>
    </section>
  );
}

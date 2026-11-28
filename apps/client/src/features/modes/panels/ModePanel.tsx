import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import type { RegisteredCharacter } from '@kesoku/protocol';
import { HpBar, ProgressBar, Sheet, t as tGlobal, useLocale, useT, type MessageKey } from '@kesoku/ui';
import { VERSION_LABELS, comboGauge, partyCombos, resolveGameVersion, trpgPhase, type HudPanel } from '@kesoku/hud';
import type { CardContext, RosterUpdatePatch } from '../../cards/types';
import { MatchupRows, TypeBadge, matchupOf } from '../../cards/pokemon';
import { PokemonDex } from '../../cards/kinds/PokemonDex';
import { arr, isObj, num, obj, pick, str, strList, toMediaRef, useImageUrl, type Dict } from '../../cards/util';

export type ModePanelKind = HudPanel;

export interface ModePanelProps {
  panel: ModePanelKind | string;
  stateFiles: Record<string, unknown>;
  modePrefs: Record<string, unknown>;
  modeDefaults?: Record<string, Record<string, unknown>>;
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

const CASTING_PRESETS = ['ask_main', 'ask_all', 'auto_random', 'manual_only'] as const;
type CastingPreset = (typeof CASTING_PRESETS)[number];

const CASTING_PRESET_KEYS: Record<CastingPreset, MessageKey> = {
  ask_main: 'panel.castingPreset.ask_main',
  ask_all: 'panel.castingPreset.ask_all',
  auto_random: 'panel.castingPreset.auto_random',
  manual_only: 'panel.castingPreset.manual_only',
};

function isCastingPreset(v: string): v is CastingPreset {
  return (CASTING_PRESETS as readonly string[]).includes(v);
}

interface RosterMemberDraft {
  key: string;
  name: string;
  ref: string;
  prompt: string;
  fusion: boolean;
  isTransformed: boolean;
  transformPrompt: string;
}

function RosterAvatar({
  refStr,
  name,
  ctx,
  interactive = true,
  compact = false,
}: {
  refStr: string;
  name: string;
  ctx: CardContext;
  interactive?: boolean;
  compact?: boolean;
}) {
  const t = useT();
  const ref = refStr ? toMediaRef({ ref: refStr }) : null;
  const url = useImageUrl(ctx.resolveMedia, ref);
  const cls = 'km-roster-av' + (compact ? ' is-sm' : '');
  const inner = url ? <img src={url} alt={name} draggable={false} /> : <span aria-hidden>{name.slice(0, 1)}</span>;
  if (!interactive) {
    return <span className={cls}>{inner}</span>;
  }
  return (
    <button
      type="button"
      className={cls}
      aria-label={t('panel.rosterAvatarAria', { name })}
      onClick={() => url && ctx.openFullscreen(<img className="kc-full-img" src={url} alt={name} />)}
    >
      {inner}
    </button>
  );
}

function CastingPolicySection({
  modePrefs,
  modeDefaults,
  ctx,
}: {
  modePrefs: Record<string, unknown>;
  modeDefaults?: Record<string, Record<string, unknown>>;
  ctx: CardContext;
}) {
  const t = useT();
  const effectivePolicy =
    str(modePrefs.casting_policy) ||
    str(obj(modeDefaults?.story_theater).casting_policy) ||
    'ask_main';
  const effectiveIsPreset = isCastingPreset(effectivePolicy);

  const [editing, setEditing] = useState(false);
  const [selectedMode, setSelectedMode] = useState<CastingPreset | 'custom'>(effectiveIsPreset ? effectivePolicy : 'custom');
  const [customText, setCustomText] = useState(effectiveIsPreset ? '' : effectivePolicy);
  const [saving, setSaving] = useState<'default' | 'session' | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const customTaRef = useRef<HTMLTextAreaElement | null>(null);

  const toggleEditor = () => {
    if (!editing) {
      setSelectedMode(effectiveIsPreset ? effectivePolicy : 'custom');
      setCustomText(effectiveIsPreset ? '' : effectivePolicy);
      setFeedback(null);
      setEditing(true);
    } else {
      setEditing(false);
    }
  };

  useEffect(() => {
    if (editing && selectedMode === 'custom') {
      customTaRef.current?.focus();
    }
  }, [editing, selectedMode]);

  const candidate = selectedMode === 'custom' ? customText.trim() : selectedMode;

  const save = async (scope: 'default' | 'session') => {
    if (saving) return;
    if (!candidate) {
      setFeedback({ kind: 'err', text: t('panel.castingCustomRequired') });
      return;
    }
    setSaving(scope);
    setFeedback(null);
    try {
      if (scope === 'default') {
        if (ctx.setModeDefaults) {
          await ctx.setModeDefaults('story_theater', { casting_policy: candidate });
        }
        await ctx.setModePrefs({ casting_policy: candidate });
        setFeedback({ kind: 'ok', text: t('panel.castingSavedDefault') });
      } else {
        await ctx.setModePrefs({ casting_policy: candidate });
        setFeedback({ kind: 'ok', text: t('panel.castingSavedSession') });
      }
      setEditing(false);
    } catch {
      setFeedback({ kind: 'err', text: t('panel.castingSaveFailed') });
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="km-policy-card" data-testid="casting-policy-card">
      <div className="km-policy-bar">
        <div className="km-policy-summary">
          <span className="km-policy-label">{t('panel.castingPolicyTitle')}</span>
          {effectiveIsPreset ? (
            <span className="kc-badge kc-badge-mode">{t(CASTING_PRESET_KEYS[effectivePolicy])}</span>
          ) : (
            <>
              <span className="kc-badge kc-badge-accent">{t('panel.castingPreset.custom')}</span>
              <span className="km-policy-snippet" title={effectivePolicy}>
                {effectivePolicy}
              </span>
            </>
          )}
        </div>
        <button type="button" className="km-btn km-btn-sm km-btn-ghost" onClick={toggleEditor}>
          {editing ? t('panel.castingClose') : t('panel.castingEdit')}
        </button>
      </div>
      {feedback && (
        <div className={'km-inline-msg' + (feedback.kind === 'err' ? ' is-err' : ' is-ok')} role={feedback.kind === 'err' ? 'alert' : 'status'}>
          {feedback.text}
        </div>
      )}
      {editing && (
        <div className="km-policy-editor" data-testid="casting-policy-editor">
          <div className="km-policy-chips" role="group" aria-label={t('panel.castingPolicyTitle')}>
            {CASTING_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={'km-chip-btn' + (selectedMode === preset ? ' is-on' : '')}
                aria-pressed={selectedMode === preset}
                onClick={() => {
                  setSelectedMode(preset);
                  setFeedback(null);
                }}
              >
                {t(CASTING_PRESET_KEYS[preset])}
              </button>
            ))}
            <button
              type="button"
              className={'km-chip-btn' + (selectedMode === 'custom' ? ' is-on' : '')}
              aria-pressed={selectedMode === 'custom'}
              onClick={() => {
                setSelectedMode('custom');
                setFeedback(null);
              }}
            >
              {t('panel.castingPreset.custom')}
            </button>
          </div>
          {selectedMode === 'custom' && (
            <div className="km-field">
              <textarea
                ref={customTaRef}
                className="km-textarea"
                maxLength={600}
                rows={3}
                value={customText}
                onChange={(e) => {
                  setCustomText(e.target.value);
                  if (feedback?.kind === 'err') setFeedback(null);
                }}
                placeholder={t('panel.castingCustomPlaceholder')}
                aria-label={t('panel.castingCustomAria')}
              />
              <span className="km-char-count">{customText.length}/600</span>
            </div>
          )}
          <div className="km-policy-actions">
            <button
              type="button"
              className="km-btn km-btn-sm km-btn-primary"
              disabled={!!saving || !candidate}
              onClick={() => void save('default')}
            >
              {saving === 'default' ? t('common.saving') : t('panel.castingSaveDefault')}
            </button>
            <button
              type="button"
              className="km-btn km-btn-sm km-btn-ghost"
              disabled={!!saving || !candidate}
              onClick={() => void save('session')}
            >
              {saving === 'session' ? t('common.saving') : t('panel.castingApplySession')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RosterEditSheet({
  member,
  ctx,
  onClose,
}: {
  member: RosterMemberDraft | null;
  ctx: CardContext;
  onClose: () => void;
}) {
  const t = useT();
  const [refVal, setRefVal] = useState('');
  const [promptVal, setPromptVal] = useState('');
  const [fusionVal, setFusionVal] = useState(false);
  const [transformPromptVal, setTransformPromptVal] = useState('');
  const [search, setSearch] = useState('');
  const [characters, setCharacters] = useState<RegisteredCharacter[]>([]);
  const [charsLoading, setCharsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const charsLoadedRef = useRef(false);
  const listCharactersRef = useRef(ctx.listCharacters);
  listCharactersRef.current = ctx.listCharacters;

  useEffect(() => {
    if (!member) return;
    setRefVal(member.ref);
    setPromptVal(member.prompt);
    setFusionVal(member.fusion);
    setTransformPromptVal(member.transformPrompt);
    setSearch('');
    setError(null);
  }, [member]);

  useEffect(() => {
    if (!member || charsLoadedRef.current || !listCharactersRef.current) return;
    let alive = true;
    setCharsLoading(true);
    listCharactersRef.current()
      .then((list) => {
        if (!alive) return;
        charsLoadedRef.current = true;
        setCharacters(Array.isArray(list) ? list : []);
        setCharsLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        charsLoadedRef.current = true;
        setCharacters([]);
        setCharsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [member]);

  const q = search.trim().toLowerCase();
  const filteredChars = q
    ? characters.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.ref.toLowerCase().includes(q) ||
          (c.group ?? '').toLowerCase().includes(q) ||
          (c.aliases ?? []).some((a) => a.toLowerCase().includes(q)),
      )
    : characters;

  const onSave = async () => {
    if (!member || saving) return;
    if (!ctx.updateRoster) {
      setError(t('panel.rosterSaveFailed'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const patch: RosterUpdatePatch = {
        key: member.key,
        ref: refVal.trim(),
        prompt: promptVal,
        fusion: fusionVal,
        ...(member.isTransformed ? { transform_prompt: transformPromptVal } : {}),
      };
      await ctx.updateRoster(patch);
      onClose();
    } catch {
      setError(t('panel.rosterSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      open={!!member}
      onClose={onClose}
      className="km-roster-sheet"
      title={member ? t('panel.rosterEditTitle', { name: member.name }) : undefined}
    >
      {member && (
        <div className="km-roster-form" data-testid="roster-edit-form">
          <div className="km-field">
            <label htmlFor="km-roster-ref">{t('panel.rosterRefLabel')}</label>
            <div className="km-ref-row">
              <input
                id="km-roster-ref"
                type="text"
                className="km-input"
                maxLength={160}
                value={refVal}
                onChange={(e) => setRefVal(e.target.value)}
                placeholder={t('panel.rosterRefPlaceholder')}
              />
              <button
                type="button"
                className="km-btn km-btn-sm km-btn-ghost"
                disabled={!refVal}
                onClick={() => setRefVal('')}
              >
                {t('panel.rosterRefClear')}
              </button>
            </div>
            {ctx.listCharacters && (
              <div className="km-char-picker-wrap">
                <input
                  type="search"
                  className="km-input km-input-sm"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('panel.rosterCharSearch')}
                  aria-label={t('panel.rosterCharSearch')}
                />
                <div className="km-char-picker" data-sheet-no-drag data-testid="roster-char-picker">
                  {charsLoading && <div className="km-char-empty">{t('panel.rosterCharLoading')}</div>}
                  {!charsLoading && filteredChars.length === 0 && <div className="km-char-empty">{t('panel.rosterCharEmpty')}</div>}
                  {!charsLoading &&
                    filteredChars.map((c) => {
                      const selected = refVal.trim().toLowerCase() === c.ref.toLowerCase();
                      return (
                        <button
                          key={`${c.group ?? ''}:${c.ref}:${c.name}`}
                          type="button"
                          className={'km-char-item' + (selected ? ' is-selected' : '')}
                          aria-pressed={selected}
                          onClick={() => setRefVal(c.ref)}
                        >
                          <RosterAvatar refStr={c.avatar || c.ref} name={c.name} ctx={ctx} interactive={false} compact />
                          <span className="km-char-meta">
                            <span className="km-char-name">
                              <b>{c.name}</b>
                              {c.group && <span className="kc-badge kc-badge-tag">{c.group}</span>}
                            </span>
                            <span className="km-char-sub">
                              <code>{c.ref}</code>
                              {c.aliases && c.aliases.length > 0 && <span> · {c.aliases.slice(0, 3).join(' / ')}</span>}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                </div>
              </div>
            )}
          </div>

          <label className="km-roster-check">
            <input
              type="checkbox"
              checked={fusionVal}
              onChange={(e) => setFusionVal(e.target.checked)}
            />
            <span className="km-roster-check-copy">
              <b>{t('panel.rosterFusionLabel')}</b>
              <span>{t('panel.rosterFusionHint')}</span>
            </span>
          </label>

          <div className="km-field">
            <div className="km-field-head">
              <label htmlFor="km-roster-prompt">{t('panel.rosterPromptLabel')}</label>
              <span className="km-char-count">{promptVal.length}/2000</span>
            </div>
            <textarea
              id="km-roster-prompt"
              className="km-textarea"
              maxLength={2000}
              rows={4}
              value={promptVal}
              onChange={(e) => setPromptVal(e.target.value)}
              placeholder={t('panel.rosterPromptPlaceholder')}
            />
          </div>

          {member.isTransformed && (
            <div className="km-field">
              <div className="km-field-head">
                <label htmlFor="km-roster-tf-prompt">{t('panel.rosterTransformPromptLabel')}</label>
                <span className="km-char-count">{transformPromptVal.length}/2000</span>
              </div>
              <textarea
                id="km-roster-tf-prompt"
                className="km-textarea"
                maxLength={2000}
                rows={3}
                value={transformPromptVal}
                onChange={(e) => setTransformPromptVal(e.target.value)}
                placeholder={t('panel.rosterTransformPromptPlaceholder')}
              />
            </div>
          )}

          {error && (
            <div className="km-inline-msg is-err" role="alert">
              {error}
            </div>
          )}

          <div className="km-roster-sheet-actions">
            <button type="button" className="km-btn km-btn-ghost" disabled={saving} onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="button" className="km-btn km-btn-primary" disabled={saving} onClick={() => void onSave()}>
              {saving ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

function RosterPanel({
  stateFiles,
  modePrefs,
  modeDefaults,
  ctx,
}: {
  stateFiles: Record<string, unknown>;
  modePrefs: Record<string, unknown>;
  modeDefaults?: Record<string, Record<string, unknown>>;
  ctx: CardContext;
}) {
  const t = useT();
  const [editing, setEditing] = useState<RosterMemberDraft | null>(null);
  const roster = file(stateFiles, 'game/roster.json');
  const members = Object.entries(obj(roster.members ?? roster.cast ?? roster.characters)).filter(([, v]) => isObj(v)) as Array<[string, Dict]>;
  const resolvedDefaults = modeDefaults ?? ctx.modeDefaults;

  return (
    <Panel title={t('panel.rosterTitle')} badge={<span className="kc-badge kc-badge-mode">{members.length}</span>} className="km-roster">
      <CastingPolicySection modePrefs={modePrefs} modeDefaults={resolvedDefaults} ctx={ctx} />
      {!members.length && <Empty>{t('panel.noRoster')}</Empty>}
      <ul className="km-list">
        {members.map(([key, m]) => {
          const name = pick(m, 'name') || key;
          const base = obj(m.base_appearance);
          const transformedObj = obj(m.transformed_appearance);
          const isTransformed = str(m.form_state).toLowerCase() === 'transformed';
          const isFusion = m.fusion === true;
          const ref = pick(m, 'ref') || pick(base, 'ref') || pick(m, 'visual_ref');
          const actor = pick(m, 'actor', 'cast', 'performer', 'display_name') || (ref ? ref.split('/').filter(Boolean).pop()?.replace(/[_-]+/g, ' ') ?? '' : '');
          const basePrompt = pick(base, 'prompt') || (!isTransformed ? pick(m, 'prompt') : '');
          const transformPrompt = isTransformed ? pick(transformedObj, 'prompt') || pick(m, 'prompt') : '';
          const tags = [...strList(m.tags), ...strList(m.traits), ...strList(m.costume), ...strList(pick(m, 'outfit'))].slice(0, 6);
          const role = pick(m, 'role');
          return (
            <li key={key} className="km-roster-row">
              <RosterAvatar refStr={ref} name={name} ctx={ctx} />
              <div className="km-roster-main">
                <div className="km-roster-head">
                  <div className="km-roster-name">
                    <b>{name}</b>
                    {actor && <span className="km-roster-actor">· {actor}</span>}
                    {isFusion && <span className="kc-badge kc-badge-accent">{t('panel.rosterFusionBadge')}</span>}
                    {isTransformed && <span className="kc-badge kc-badge-accent">{t('panel.rosterTransformedBadge')}</span>}
                    {role && <span className="kc-badge kc-badge-warn">{role}</span>}
                  </div>
                  <button
                    type="button"
                    className="km-roster-edit-btn"
                    aria-label={`${t('panel.rosterEditBtn')} ${name}`}
                    onClick={() =>
                      setEditing({
                        key,
                        name,
                        ref,
                        prompt: basePrompt,
                        fusion: isFusion,
                        isTransformed,
                        transformPrompt,
                      })
                    }
                  >
                    {t('panel.rosterEditBtn')}
                  </button>
                </div>
                {isTransformed ? (
                  <>
                    {transformPrompt && (
                      <p className="km-roster-prompt" title={transformPrompt}>
                        {transformPrompt}
                      </p>
                    )}
                    {basePrompt && (
                      <p className="km-roster-base-note" title={basePrompt}>
                        {t('panel.rosterBaseNote', { prompt: basePrompt })}
                      </p>
                    )}
                  </>
                ) : (
                  basePrompt && (
                    <p className="km-roster-prompt" title={basePrompt}>
                      {basePrompt}
                    </p>
                  )
                )}
                {tags.length > 0 && (
                  <div className="kc-chips">
                    {tags.map((tag) => (
                      <span key={tag} className="kc-badge kc-badge-tag">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <RosterEditSheet member={editing} ctx={ctx} onClose={() => setEditing(null)} />
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

function ModePanelInner({ panel, stateFiles, modePrefs, modeDefaults, ctx }: ModePanelProps) {
  const sf = stateFiles ?? {};
  const prefs = modePrefs ?? {};
  switch (panel) {
    case 'mistakes':
      return <MistakesPanel stateFiles={sf} ctx={ctx} />;
    case 'roster':
      return <RosterPanel stateFiles={sf} modePrefs={prefs} modeDefaults={modeDefaults} ctx={ctx} />;
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

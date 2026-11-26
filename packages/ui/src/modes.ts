import { DEFAULT_MEMORY_POLICIES, MODE_IDS, type MemoryPolicy, type ModeId } from '@kesoku/protocol';
import { t, type ResolvedLocale } from './i18n';

export interface ModeMeta {
  id: ModeId;
  title: string;
  short: string;
  icon: string;
  color: string;
  /** Signature accent of the bespoke vector icon (ModeIcon). */
  accent: string;
  /** Launchpad subtitle (compact chips, no long prose). */
  subtitle: string;
  badge?: string;
  placeholder: string;
  defaultModel?: string;
  dark?: boolean;
}

interface ModeBase {
  id: ModeId;
  icon: string;
  color: string;
  accent: string;
  hasBadge?: boolean;
  defaultModel?: string;
  dark?: boolean;
}

const MODE_BASES: Readonly<Record<ModeId, ModeBase>> = Object.freeze({
  chat: { id: 'chat', icon: '💬', color: '#3B82F6', accent: '#4A6FA5' },
  galgame: { id: 'galgame', icon: '🌸', color: '#EC6B8F', accent: '#D45B7A', dark: true },
  travel_companion: { id: 'travel_companion', icon: '🧭', color: '#1D4ED8', accent: '#2E8B6E' },
  translator: { id: 'translator', icon: '⇄', color: '#0F766E', accent: '#3B82C4', defaultModel: 'gemini-4-neon', dark: true },
  jp_classroom: { id: 'jp_classroom', icon: '📘', color: '#15803D', accent: '#8E5A9E' },
  trpg: { id: 'trpg', icon: '🎲', color: '#D97706', accent: '#C87A28', dark: true },
  pokemon_assistant: { id: 'pokemon_assistant', icon: '🔴', color: '#F43F5E', accent: '#D14836', hasBadge: true, dark: true },
  story_theater: { id: 'story_theater', icon: '🎭', color: '#7E22CE', accent: '#6B5B95' },
});

function buildModeMeta(id: ModeId, locale?: ResolvedLocale): ModeMeta {
  const b = MODE_BASES[id];
  const meta: ModeMeta = {
    id: b.id,
    icon: b.icon,
    color: b.color,
    accent: b.accent,
    title: t(`mode.${id}.title`, undefined, locale),
    short: t(`mode.${id}.short`, undefined, locale),
    subtitle: t(`mode.${id}.subtitle`, undefined, locale),
    placeholder: t(`mode.${id}.placeholder`, undefined, locale),
  };
  if (b.hasBadge) meta.badge = t('mode.pokemon_assistant.badge', undefined, locale);
  if (b.defaultModel) meta.defaultModel = b.defaultModel;
  if (b.dark) meta.dark = true;
  return meta;
}

function liveModeMeta(id: ModeId): ModeMeta {
  const b = MODE_BASES[id];
  const obj: ModeMeta = {
    id: b.id,
    icon: b.icon,
    color: b.color,
    accent: b.accent,
    get title() {
      return t(`mode.${id}.title`);
    },
    get short() {
      return t(`mode.${id}.short`);
    },
    get subtitle() {
      return t(`mode.${id}.subtitle`);
    },
    get placeholder() {
      return t(`mode.${id}.placeholder`);
    },
    ...(b.hasBadge
      ? {
          get badge() {
            return t('mode.pokemon_assistant.badge');
          },
        }
      : {}),
    ...(b.defaultModel ? { defaultModel: b.defaultModel } : {}),
    ...(b.dark ? { dark: true } : {}),
  };
  return Object.freeze(obj);
}

/** UI doc §2.2 per-mode capsule accents & launchpad metadata (locale-reactive via getters). */
export const MODES: Readonly<Record<ModeId, ModeMeta>> = Object.freeze({
  chat: liveModeMeta('chat'),
  galgame: liveModeMeta('galgame'),
  travel_companion: liveModeMeta('travel_companion'),
  translator: liveModeMeta('translator'),
  jp_classroom: liveModeMeta('jp_classroom'),
  trpg: liveModeMeta('trpg'),
  pokemon_assistant: liveModeMeta('pokemon_assistant'),
  story_theater: liveModeMeta('story_theater'),
});

export const MODE_LIST: readonly ModeMeta[] = Object.freeze(MODE_IDS.map((id) => MODES[id]));

export function getModeList(locale?: ResolvedLocale): ModeMeta[] {
  return MODE_IDS.map((id) => buildModeMeta(id, locale));
}

export function modeMeta(id: string | null | undefined, locale?: ResolvedLocale): ModeMeta {
  const modeId: ModeId = id && Object.prototype.hasOwnProperty.call(MODE_BASES, id) ? (id as ModeId) : 'chat';
  return locale ? buildModeMeta(modeId, locale) : MODES[modeId];
}

export type PolicyIconName = 'policy-full' | 'policy-confirm' | 'policy-isolated';

export interface PolicyBadgeMeta {
  icon: string;
  iconName: PolicyIconName;
  label: string;
  explain: string;
}

function livePolicyBadge(policy: MemoryPolicy, icon: string, iconName: PolicyIconName): PolicyBadgeMeta {
  return Object.freeze({
    icon,
    iconName,
    get label() {
      return t(`policy.${policy}`);
    },
    get explain() {
      return t(`policy.${policy}.explain`);
    },
  });
}

export const POLICY_BADGE: Readonly<Record<MemoryPolicy, PolicyBadgeMeta>> = Object.freeze({
  full: livePolicyBadge('full', '✅', 'policy-full'),
  confirm_only: livePolicyBadge('confirm_only', '💡', 'policy-confirm'),
  isolated: livePolicyBadge('isolated', '🔕', 'policy-isolated'),
});

export function getPolicyBadge(policy: MemoryPolicy, locale?: ResolvedLocale): PolicyBadgeMeta {
  const base = POLICY_BADGE[policy] ?? POLICY_BADGE.confirm_only;
  return {
    icon: base.icon,
    iconName: base.iconName,
    label: t(`policy.${policy}`, undefined, locale),
    explain: t(`policy.${policy}.explain`, undefined, locale),
  };
}

export { DEFAULT_MEMORY_POLICIES };

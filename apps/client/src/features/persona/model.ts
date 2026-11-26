import {
  AVATAR_STYLE_PRESETS,
  DEFAULT_MEMORY_POLICIES,
  LIMITS,
  MODE_IDS,
  ROLE_ID_RE,
  type AvatarStylePreset,
  type MemoryPolicy,
  type ModeId,
  type PersonaSummary,
} from '@kesoku/protocol';
import { t } from '@kesoku/ui';

/** Built-in roles render first, in this order. */
export const BUILTIN_ORDER = ['asuka', 'default'] as const;

/** Soft UI hint for the tagline (the hard protocol limit is LIMITS.TAGLINE_MAX). */
export const TAGLINE_HINT = 40;

export const AVATAR_SOURCE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] as const;

/** Source objects are accepted by `avatar.generate` for 10 min after upload; reuse with a margin. */
export const SOURCE_REUSE_MS = 9 * 60 * 1000;

export const STYLE_PRESET_LABELS: Readonly<Record<AvatarStylePreset, string>> = Object.freeze({
  get anime_clean() {
    return t('persona.style.anime_clean');
  },
  get cyber_flat() {
    return t('persona.style.cyber_flat');
  },
  get watercolor() {
    return t('persona.style.watercolor');
  },
  get pixel() {
    return t('persona.style.pixel');
  },
});
export const STYLE_PRESETS: readonly AvatarStylePreset[] = AVATAR_STYLE_PRESETS;

/** Voice timbres offered for binding (`voice_preset`); unknown saved values are kept and shown as-is. */
export const VOICE_PRESETS: ReadonlyArray<{ id: string; label: string }> = Object.freeze([
  { id: 'cherry', label: '甜美少女 Cherry' },
  { id: 'serena', label: '温柔知性 Serena' },
  { id: 'chelsie', label: '元气二次元 Chelsie' },
  { id: 'ethan', label: '阳光少年 Ethan' },
  { id: 'dylan', label: '沉稳青年 Dylan' },
]);

/**
 * Voice options for a role's `<select>`: the generic presets, plus — generically for ANY role — its own saved
 * timbre (`voice_preset` not among the presets, e.g. a cloned voice) and a role-dedicated voice named after the
 * role id, so a saved value is always selectable and shown with a readable label.
 */
export function voicePresetOptions(
  role: { role_id: string; display_name?: string | null; voice_preset?: string | null } | null,
): Array<{ id: string; label: string }> {
  const opts: Array<{ id: string; label: string }> = [...VOICE_PRESETS];
  if (!role) return opts;
  const name = (role.display_name || '').trim() || role.role_id;
  const has = (id: string) => opts.some((o) => o.id === id);
  const extra: Array<{ id: string; label: string }> = [];
  const preset = role.voice_preset?.trim();
  if (preset && !has(preset)) extra.push({ id: preset, label: t('persona.voiceOriginal', { name, id: preset }) });
  const rid = role.role_id?.trim();
  if (rid && rid !== 'default' && !has(rid) && preset !== rid) extra.push({ id: rid, label: t('persona.voiceDedicated', { name, id: rid }) });
  return [...extra, ...opts];
}

export const INTRO_TEMPLATES: ReadonlyArray<{ id: string; label: string; text: string }> = Object.freeze([
  Object.freeze({
    id: 'guide',
    get label() {
      return t('persona.tpl.guide');
    },
    get text() {
      return t('persona.tpl.guideText');
    },
  }),
  Object.freeze({
    id: 'tutor',
    get label() {
      return t('persona.tpl.tutor');
    },
    get text() {
      return t('persona.tpl.tutorText');
    },
  }),
  Object.freeze({
    id: 'engineer',
    get label() {
      return t('persona.tpl.engineer');
    },
    get text() {
      return t('persona.tpl.engineerText');
    },
  }),
  Object.freeze({
    id: 'blank',
    get label() {
      return t('persona.tpl.blank');
    },
    text: '',
  }),
]);

export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function fmtBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`;
}

export interface PersonaDraft {
  role_id: string;
  display_name: string;
  tagline: string;
  intro_md: string;
  preferences_md: string;
  voice_preset: string | null;
}

export type DraftErrors = Partial<Record<keyof PersonaDraft, string>>;

export function emptyDraft(): PersonaDraft {
  return { role_id: '', display_name: '', tagline: '', intro_md: '', preferences_md: '', voice_preset: null };
}

export function validatePersona(d: PersonaDraft, opts: { isNew: boolean; existingIds: readonly string[] }): DraftErrors {
  const e: DraftErrors = {};
  const name = d.display_name.trim();
  if (!name) e.display_name = t('persona.errNameRequired');
  else if (d.display_name.length > LIMITS.DISPLAY_NAME_MAX) e.display_name = t('persona.maxChars', { max: LIMITS.DISPLAY_NAME_MAX });
  if (d.tagline.length > LIMITS.TAGLINE_MAX) e.tagline = t('persona.maxChars', { max: LIMITS.TAGLINE_MAX });
  if (utf8Bytes(d.intro_md) > LIMITS.PERSONA_FILE_MAX_BYTES) e.intro_md = t('persona.exceeds64KiB');
  if (utf8Bytes(d.preferences_md) > LIMITS.PERSONA_FILE_MAX_BYTES) e.preferences_md = t('persona.exceeds64KiB');
  if (opts.isNew && d.role_id) {
    if (!ROLE_ID_RE.test(d.role_id)) e.role_id = t('persona.errRoleIdFormat');
    else if (opts.existingIds.includes(d.role_id)) e.role_id = t('persona.errRoleIdExists');
  }
  return e;
}

export function sameDraft(a: PersonaDraft, b: PersonaDraft): boolean {
  return (
    a.role_id === b.role_id &&
    a.display_name === b.display_name &&
    a.tagline === b.tagline &&
    a.intro_md === b.intro_md &&
    a.preferences_md === b.preferences_md &&
    (a.voice_preset ?? null) === (b.voice_preset ?? null)
  );
}

/**
 * Clean an avatar `prompt_hint`: no newlines / control characters, no `--flag` style prefixes,
 * at most LIMITS.PROMPT_HINT_MAX characters.
 */
export function sanitizePromptHint(raw: string, opts: { trim?: boolean } = {}): string {
  let s = raw.replace(/[\r\n\t\u2028\u2029]+/g, ' ');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  s = s.replace(/(^|\s)-{2,}/g, '$1');
  s = s.replace(/^\s+/, '');
  if (opts.trim) s = s.trim();
  return Array.from(s).slice(0, LIMITS.PROMPT_HINT_MAX).join('');
}

/** Roles in display order: built-ins first (fixed order), then custom roles. */
export function sortRoles(list: readonly PersonaSummary[]): PersonaSummary[] {
  const rank = (r: PersonaSummary) => {
    const i = (BUILTIN_ORDER as readonly string[]).indexOf(r.role_id);
    return i >= 0 ? i : r.builtin ? 10 : 100;
  };
  return [...list].sort((a, b) => rank(a) - rank(b));
}

/**
 * Role to fall back to when a session has no role yet: the first role in display order (built-ins first), else
 * the always-present generic `default` role. Never a hardcoded persona.
 */
export function fallbackRoleId(list: readonly PersonaSummary[]): string {
  return sortRoles(list)[0]?.role_id ?? 'default';
}

/** Readable name for a role id when its persona summary is not loaded (generic, no persona-specific names). */
export function roleFallbackName(roleId: string | null | undefined): string {
  return roleId || t('common.aiAssistant');
}

/** Modes whose memory policy deviates from the defaults. */
export function policyDeviations(
  policies: Readonly<Record<string, MemoryPolicy>>,
  defaults: Readonly<Record<string, MemoryPolicy>>,
): Array<{ mode: ModeId; policy: MemoryPolicy }> {
  const out: Array<{ mode: ModeId; policy: MemoryPolicy }> = [];
  for (const mode of MODE_IDS) {
    const p = policies[mode];
    const d = defaults[mode] ?? DEFAULT_MEMORY_POLICIES[mode];
    if (p && p !== d) out.push({ mode, policy: p });
  }
  return out;
}

/** Media ref for a role avatar (null → letter avatar, no request). */
export function roleAvatarRef(r: { role_id: string; avatar_ref?: string | null; avatar_rev?: number }): string | null {
  if (r.avatar_ref) return r.avatar_ref;
  if (r.avatar_ref === null && !r.avatar_rev) return null;
  return `roles/${r.role_id}/avatar.webp`;
}

/** Media ref for a role's original character reference photo (before AI avatar deformation). */
export function roleSourceAvatarRef(r: { role_id: string; avatar_ref?: string | null; avatar_rev?: number }): string | null {
  if (r.avatar_ref === null && !r.avatar_rev) return null;
  return `roles/${r.role_id}/source.webp`;
}

export function userAvatarRef(p: { avatar_ref?: string | null; avatar_rev?: number } | null): string | null {
  if (!p) return null;
  if (p.avatar_ref) return p.avatar_ref;
  if (p.avatar_ref === null && !p.avatar_rev) return null;
  return 'user/avatar.webp';
}

export function userSourceAvatarRef(p: { avatar_ref?: string | null; avatar_rev?: number } | null): string | null {
  if (!p) return null;
  if (p.avatar_ref === null && !p.avatar_rev) return null;
  return 'user/source.webp';
}

export function errorCode(e: unknown): string {
  return e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string' ? (e as { code: string }).code : '';
}

export function checkAvatarFile(file: Blob): string | null {
  if (file.type && !(AVATAR_SOURCE_MIMES as readonly string[]).includes(file.type)) return t('persona.errFileType');
  if (file.size > LIMITS.AVATAR_SOURCE_MAX_BYTES) return t('persona.errFileSize');
  return null;
}

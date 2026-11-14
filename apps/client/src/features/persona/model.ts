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

/** Built-in roles render first, in this order. */
export const BUILTIN_ORDER = ['asuka', 'coder', 'default'] as const;

/** Soft UI hint for the tagline (the hard protocol limit is LIMITS.TAGLINE_MAX). */
export const TAGLINE_HINT = 40;

export const AVATAR_SOURCE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] as const;

/** Source objects are accepted by `avatar.generate` for 10 min after upload; reuse with a margin. */
export const SOURCE_REUSE_MS = 9 * 60 * 1000;

export const STYLE_PRESET_LABELS: Readonly<Record<AvatarStylePreset, string>> = Object.freeze({
  anime_clean: '✦ 日系清透立绘',
  cyber_flat: '赛博霓虹平涂',
  watercolor: '温润水彩手绘',
  pixel: '复古像素',
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

export const INTRO_TEMPLATES: ReadonlyArray<{ id: string; label: string; text: string }> = Object.freeze([
  {
    id: 'guide',
    label: '伴游',
    text: [
      '# 角色设定',
      '- 身份：随身伴游，熟悉当地交通、美食与礼仪。',
      '- 性格：开朗细心，会主动提醒忌口与行程风险。',
      '- 说话风格：口语化、简短；关键日语句子给出原文 + 振假名 + 译文。',
      '- 禁区：不编造营业时间与价格，不确定时直说。',
      '',
    ].join('\n'),
  },
  {
    id: 'tutor',
    label: '私教',
    text: [
      '# 角色设定',
      '- 身份：日语私教，按教材进度循序渐进。',
      '- 性格：耐心但严格，纠错直截了当。',
      '- 说话风格：先给例句，再拆解语法；每轮最多一个新知识点。',
      '- 禁区：不一次性灌输大量生词。',
      '',
    ].join('\n'),
  },
  {
    id: 'engineer',
    label: '工程助手',
    text: [
      '# 角色设定',
      '- 身份：工程助手，擅长阅读代码、定位问题与给出最小改动方案。',
      '- 性格：冷静、务实。',
      '- 说话风格：先结论后细节；代码块注明语言与文件路径。',
      '- 禁区：不臆测未提供的代码，不执行破坏性操作。',
      '',
    ].join('\n'),
  },
  { id: 'blank', label: '空白', text: '' },
]);

export const CODER_NOTE = '将编码任务委派给引擎主机上的本地 CLI 编码代理';

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
  if (!name) e.display_name = '请填写角色名称';
  else if (d.display_name.length > LIMITS.DISPLAY_NAME_MAX) e.display_name = `最多 ${LIMITS.DISPLAY_NAME_MAX} 个字符`;
  if (d.tagline.length > LIMITS.TAGLINE_MAX) e.tagline = `最多 ${LIMITS.TAGLINE_MAX} 个字符`;
  if (utf8Bytes(d.intro_md) > LIMITS.PERSONA_FILE_MAX_BYTES) e.intro_md = '超过 64 KiB 上限';
  if (utf8Bytes(d.preferences_md) > LIMITS.PERSONA_FILE_MAX_BYTES) e.preferences_md = '超过 64 KiB 上限';
  if (opts.isNew && d.role_id) {
    if (!ROLE_ID_RE.test(d.role_id)) e.role_id = '仅限小写字母 / 数字 / 下划线，2–32 位';
    else if (opts.existingIds.includes(d.role_id)) e.role_id = '该 role_id 已存在';
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
  if (file.type && !(AVATAR_SOURCE_MIMES as readonly string[]).includes(file.type)) return '仅支持 JPG / PNG / WebP / HEIC 图片';
  if (file.size > LIMITS.AVATAR_SOURCE_MAX_BYTES) return '图片超过 12 MiB';
  return null;
}

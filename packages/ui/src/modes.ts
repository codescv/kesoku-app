import { DEFAULT_MEMORY_POLICIES, MEMORY_POLICY_LABELS, MODE_IDS, type MemoryPolicy, type ModeId } from '@kesoku/protocol';

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

/** UI doc §2.2 per-mode capsule accents & launchpad metadata. */
export const MODES: Readonly<Record<ModeId, ModeMeta>> = Object.freeze({
  chat: { id: 'chat', title: '日常聊天', short: '聊天', icon: '💬', color: '#3B82F6', accent: '#4A6FA5', subtitle: '双语卡 · 点词精讲', placeholder: '发消息...' },
  galgame: { id: 'galgame', title: '约会 Galgame', short: '约会', icon: '🌸', color: '#EC6B8F', accent: '#D45B7A', subtitle: 'CG 舞台 · 选项分支', placeholder: '说点什么，或点选上方选项...', dark: true },
  travel_companion: { id: 'travel_companion', title: '旅游助手', short: '旅游', icon: '🧭', color: '#1D4ED8', accent: '#2E8B6E', subtitle: '菜单排雷 · 点单卡', placeholder: '输入文字或粘贴...' },
  translator: { id: 'translator', title: '通用翻译', short: '翻译', icon: '⇄', color: '#0F766E', accent: '#3B82C4', subtitle: '日⇄中 · 零寒暄', placeholder: '输入文字翻译，不便说话时直接打字...', defaultModel: 'gemini-3.8-flash', dark: true },
  jp_classroom: { id: 'jp_classroom', title: '日语小课堂', short: '课堂', icon: '📘', color: '#15803D', accent: '#8E5A9E', subtitle: '标日双轨 · 错题本', placeholder: '用日语造句...' },
  trpg: { id: 'trpg', title: 'TRPG 跑团', short: '跑团', icon: '🎲', color: '#D97706', accent: '#C87A28', subtitle: '全题材 · 小队血条', placeholder: '描述你的行动...', dark: true },
  pokemon_assistant: { id: 'pokemon_assistant', title: '宝可梦助手', short: '宝可梦', icon: '🔴', color: '#F43F5E', accent: '#D14836', subtitle: '图鉴弱点 · 招式百科 · 拍照识怪', badge: '朱紫 / Z-A', placeholder: '查宝可梦、招式、特性或机制...', dark: true },
  story_theater: { id: 'story_theater', title: '剧情小剧场', short: '剧场', icon: '🎭', color: '#7E22CE', accent: '#6B5B95', subtitle: '章节演出 · 定妆表', placeholder: '继续剧情，或给出指令...' },
});

export const MODE_LIST: readonly ModeMeta[] = MODE_IDS.map((id) => MODES[id]);

export function modeMeta(id: string | null | undefined): ModeMeta {
  return (id && (MODES as Record<string, ModeMeta>)[id]) || MODES.chat;
}

export type PolicyIconName = 'policy-full' | 'policy-confirm' | 'policy-isolated';

export const POLICY_BADGE: Readonly<Record<MemoryPolicy, { icon: string; iconName: PolicyIconName; label: string; explain: string }>> = Object.freeze({
  full: { icon: '✅', iconName: 'policy-full', label: MEMORY_POLICY_LABELS.full, explain: '后台自动写入' },
  confirm_only: { icon: '💡', iconName: 'policy-confirm', label: MEMORY_POLICY_LABELS.confirm_only, explain: '弹卡你点才写' },
  isolated: { icon: '🔕', iconName: 'policy-isolated', label: MEMORY_POLICY_LABELS.isolated, explain: '不记录本模式对话' },
});

export { DEFAULT_MEMORY_POLICIES };

import type { Attachment, EngineToClientPayload, MemoryPolicy, Segment } from '@kesoku/protocol';

export type TurnEvent = EngineToClientPayload<'turn.event'> & { ts?: number };

/** Render model for one row in the message stage. */
export interface ChatItem {
  /** Stable React key: message_id, `c:<client_msg_id>` while sending, or `t:<turn_id>` for previews. */
  key: string;
  kind: 'user' | 'assistant' | 'system' | 'error';
  message_id?: string;
  turn_id?: string;
  client_msg_id?: string;
  text?: string;
  segments?: Segment[];
  raw_markdown?: string;
  ts: number;
  seq?: number;
  attachments?: Attachment[];
  /** user rows */
  status?: 'sending' | 'sent' | 'failed';
  sender?: { name?: string; role_id?: string; display_name?: string; chatbot_id?: string };
  /** `▸ 思考与工具` timeline attached to the assistant turn. */
  events?: TurnEvent[];
  /** Local picks already made on question segments (ui.pick). */
  picked?: string[];
}

/** Live streaming preview keyed by (turn_id, round_id). */
export interface StreamPreview {
  turn_id: string;
  round_id: number;
  text: string;
  thought: string;
  startedAt: number;
  interrupted?: boolean;
}

export type InspectorPanel =
  | { kind: 'memory' }
  | { kind: 'notes' }
  | { kind: 'word'; token: import('@kesoku/protocol').LexToken; sentence?: string }
  | { kind: 'dex' }
  | { kind: 'party' }
  | { kind: 'roster' }
  | { kind: 'lesson' }
  | { kind: 'mistakes' }
  | { kind: 'travel' }
  | { kind: 'persona' };

export interface PolicyState {
  policies: Record<string, MemoryPolicy>;
  defaults: Record<string, MemoryPolicy>;
  updated_at: number;
}

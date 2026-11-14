import type { ReactNode } from 'react';

/** Reference to a media item inside a segment / card (resolved lazily, never prefetched for audio). */
export interface MediaRef {
  placeholder_id?: string;
  object?: string;
  ref?: string;
  url?: string;
}

export interface GlossaryEntry {
  id: string;
  title: string;
  category?: string;
  summary?: string;
  effect_pills?: string[];
  details_md?: string;
  related?: string[];
}

/** Everything a card / mode stage may do — provided by the client core. */
export interface CardContext {
  sessionId: string;
  messageId: string;
  modeId: string;
  /** Send a plain user message in the current session (e.g. a choice). */
  sendText: (text: string) => void;
  /** Resolve an image URL (placeholder → media.ready, ref → media.hydrate, object → media.refresh). */
  resolveMedia: (ref: MediaRef) => Promise<string | null>;
  /** Media placeholders declared by the segment (`card.media{key: placeholder_id}`). */
  media?: Record<string, string>;
  /** Open the inline Wiki Peek Sheet with a glossary entry (and sibling glossary for in-place navigation). */
  openPeek: (entry: GlossaryEntry, glossary?: Record<string, GlossaryEntry>) => void;
  /** Present content full-screen (order card / direction card / translation show card). */
  openFullscreen: (node: ReactNode) => void;
  /** Lock a chip into the composer (e.g. `[问飞鸟 ›]`). */
  insertComposer: (text: string) => void;
  /** Lightweight per-session mode prefs (`mode.prefs.set`, zero LLM turn). */
  setModePrefs: (prefs: Record<string, unknown>) => void;
  /** Native / browser TTS — only call from a user tap. */
  speak: (text: string, lang: string) => void;
  copy: (text: string) => void;
  toast: (msg: string) => void;
}

export interface CardProps<D = Record<string, unknown>> {
  data: D;
  ctx: CardContext;
}

export type CardComponent = (props: CardProps<any>) => ReactNode;

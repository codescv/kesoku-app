import { vi } from 'vitest';
import type { CardContext } from '../../src/features/cards/types';

export function makeCtx(over: Partial<CardContext> = {}): CardContext & { [K in keyof CardContext]: CardContext[K] } {
  return {
    sessionId: 's1',
    messageId: 'm1',
    modeId: 'chat',
    sendText: vi.fn(),
    resolveMedia: vi.fn(async (r) => (r.url ? r.url : `https://media.test/${r.placeholder_id ?? r.ref ?? r.object ?? 'x'}`)),
    openPeek: vi.fn(),
    openFullscreen: vi.fn(),
    insertComposer: vi.fn(),
    setModePrefs: vi.fn(),
    speak: vi.fn(),
    copy: vi.fn(),
    toast: vi.fn(),
    ...over,
  };
}

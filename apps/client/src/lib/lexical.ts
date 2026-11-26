import type { EngineToClientPayload, LexToken } from '@kesoku/protocol';
import { t } from '@kesoku/ui';
import { kesoku } from './client';
import { actions } from './store';
import { cacheSentenceLex } from '../features/segments/BilingualCard';

/**
 * `lexical.explain` for one word of `text`. The engine analyses the whole sentence; every 意群 is cached via
 * `cacheSentenceLex` so the next tap on the same sentence resolves locally. Returns null (and toasts) on failure.
 */
export async function explainLexical(sessionId: string, text: string, token: string): Promise<LexToken | null> {
  try {
    const r = await kesoku.rpc<EngineToClientPayload<'lexical.explain.result'> & { explanation_markdown?: string }>(
      'lexical.explain',
      { session_id: sessionId, text, token },
      { timeoutMs: 30_000 },
    );
    const rawTok = (r as { token?: unknown }).token;
    if (Array.isArray(r.tokens) && r.tokens.length > 0) cacheSentenceLex(text, r.tokens);
    if (rawTok && typeof rawTok === 'object') return rawTok as LexToken;
    const md = typeof r.explanation_markdown === 'string' ? r.explanation_markdown : typeof rawTok === 'string' ? rawTok : '';
    return { surface: token, note: md };
  } catch {
    actions.toast(t('lexical.unavailable'), 'error');
    return null;
  }
}

/** Mirror a tapped word into the desktop right-hand inspector (no-op on phones / tablets). */
export function showWordInInspector(token: LexToken, sentence: string): void {
  const desktop = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1024px)').matches;
  if (desktop) actions.setUi({ inspector: { kind: 'word', token, sentence } });
}

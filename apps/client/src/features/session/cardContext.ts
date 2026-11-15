import { useMemo } from 'react';
import type { CardContext } from '../cards/types';
import { kesoku } from '../../lib/client';
import { actions, useStore } from '../../lib/store';
import { speak } from '../../native/tts';
import { overlays } from './overlays';
import { explainLexical, showWordInInspector } from '../../lib/lexical';

export function makeCardContext(sessionId: string, messageId: string, modeId: string, media?: Record<string, string>): CardContext {
  return {
    sessionId,
    messageId,
    modeId,
    media,
    sendText: (text) => void kesoku.sendMessage(sessionId, text),
    resolveMedia: (ref) => kesoku.resolveMedia(ref, { sessionId, messageId }),
    openPeek: (entry, glossary) => overlays.peek(entry, glossary),
    openFullscreen: (node) => overlays.fullscreen(node),
    insertComposer: (text) => actions.setUi({ composerInsert: { text, n: Date.now() } }),
    setModePrefs: (prefs) => void kesoku.setModePrefs(sessionId, prefs),
    speak: (text, lang) => {
      // Only ever invoked from a user tap (▶ 朗读).
      if (useStore.getState().settings.ttsEngine === 'server') {
        kesoku
          .rpc<{ url?: string }>('voice.preview', { voice_preset: 'default', text: text.slice(0, 80) }, { timeoutMs: 30_000 })
          .then((r) => (r.url ? new Audio(r.url).play() : undefined))
          .catch(() => actions.toast('朗读失败', 'error'));
        return;
      }
      speak({ text, lang }).catch(() => actions.toast('此设备不支持朗读', 'error'));
    },
    copy: (text) => {
      void navigator.clipboard?.writeText(text).then(
        () => actions.toast('已复制'),
        () => actions.toast('复制失败', 'error'),
      );
    },
    toast: (msg) => actions.toast(msg),
    explain: (text, token) => explainLexical(sessionId, text, token),
    onWord: (token, sentence) => showWordInInspector(token, sentence),
  };
}

export function useCardContext(sessionId: string, messageId: string, modeId: string, media?: Record<string, string>): CardContext {
  const _ttsEngine = useStore((s) => s.settings.ttsEngine);
  return useMemo(() => makeCardContext(sessionId, messageId, modeId, media), [sessionId, messageId, modeId, media, _ttsEngine]);
}

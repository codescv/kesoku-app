import { useEffect, useRef, useState } from 'react';

export interface VoicePillProps {
  /** Resolves the (signed) audio URL. Called ONLY after the user taps ▶ — never on mount. */
  resolveUrl: () => Promise<string | null>;
  durationMs?: number;
  label?: string;
  className?: string;
  /** Test seam: audio element factory. */
  createAudio?: (url: string) => HTMLAudioElement;
}

let current: { stop: () => void } | null = null;

function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Strictly tap-to-play voice pill (▶ 0:04). Iron rule: no prefetch, no autoplay — the audio URL is
 * resolved and the media GET happens only inside the click handler. Only one pill plays at a time.
 */
export function VoicePill({ resolveUrl, durationMs, label, className, createAudio }: VoicePillProps) {
  const [state, setState] = useState<'idle' | 'loading' | 'playing' | 'error'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const selfRef = useRef<{ stop: () => void }>({ stop: () => {} });

  useEffect(() => {
    selfRef.current.stop = () => {
      audioRef.current?.pause();
      setState('idle');
      setElapsed(0);
    };
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
      if (current === selfRef.current) current = null;
    };
  }, []);

  async function onClick() {
    if (state === 'playing') {
      selfRef.current.stop();
      if (current === selfRef.current) current = null;
      return;
    }
    if (state === 'loading') return;
    if (current && current !== selfRef.current) current.stop();
    current = selfRef.current;
    setState('loading');
    try {
      let audio = audioRef.current;
      if (!audio) {
        const url = await resolveUrl();
        if (!url) throw new Error('no url');
        audio = createAudio ? createAudio(url) : new Audio(url);
        audio.preload = 'none';
        audio.ontimeupdate = () => setElapsed((audio!.currentTime || 0) * 1000);
        audio.onended = () => {
          setState('idle');
          setElapsed(0);
          if (current === selfRef.current) current = null;
        };
        audioRef.current = audio;
      }
      await audio.play();
      setState('playing');
    } catch {
      setState('error');
    }
  }

  const total = durationMs ?? 0;
  const text = state === 'playing' ? fmt(elapsed) : total ? fmt(total) : label ?? '';
  return (
    <button
      type="button"
      className={['k-voice', `is-${state}`, className].filter(Boolean).join(' ')}
      aria-label={state === 'playing' ? '暂停语音' : '播放语音'}
      data-state={state}
      onClick={(e) => {
        e.stopPropagation();
        void onClick();
      }}
    >
      <span className="k-voice-icon" aria-hidden>
        {state === 'playing' ? '❚❚' : state === 'loading' ? '…' : state === 'error' ? '↻' : '▶'}
      </span>
      <span className="k-wave" aria-hidden>
        <i />
        <i />
        <i />
        <i />
      </span>
      {text && <span className="k-voice-time">{text}</span>}
    </button>
  );
}

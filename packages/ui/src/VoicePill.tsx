import { useEffect, useRef, useState } from 'react';

export interface VoicePillProps {
  /** Resolves the (signed) audio URL. Called on tap, or eagerly in the background when `preload` is set. */
  resolveUrl: () => Promise<string | null>;
  durationMs?: number;
  label?: string;
  className?: string;
  /** Test seam: audio element factory. */
  createAudio?: (url: string) => HTMLAudioElement;
  /** Backend TTS is still synthesizing: shows `⏳ 合成中…`; a tap queues playback for when it is ready. */
  pending?: boolean;
  /** Backend TTS failed: disabled `⚠️ 语音失败`. */
  failed?: boolean;
  /**
   * Eagerly resolve the URL and buffer the audio bytes in memory (never plays). Default `false` so
   * surfaces such as role previews do not fetch anything on mount.
   */
  preload?: boolean;
  /** Changing this re-triggers the background preload (e.g. a placeholder became a ready URL). */
  preloadKey?: string;
}

type PillState = 'idle' | 'loading' | 'playing' | 'error';

let current: { stop: () => void } | null = null;

function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Tap-to-play voice pill (▶ 0:04). Iron rule: playback starts ONLY from a user tap — never autoplay.
 * With `preload`, the URL is resolved and the clip buffered in the background so the tap plays instantly.
 * Only one pill plays at a time.
 */
export function VoicePill({ resolveUrl, durationMs, label, className, createAudio, pending, failed, preload = false, preloadKey }: VoicePillProps) {
  const [state, setState] = useState<PillState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [queuedPlay, setQueuedPlay] = useState(false);
  const [detectedMs, setDetectedMs] = useState<number | undefined>(undefined);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const prepPromiseRef = useRef<Promise<HTMLAudioElement> | null>(null);
  const selfRef = useRef<{ stop: () => void }>({ stop: () => {} });
  const resolveRef = useRef(resolveUrl);
  resolveRef.current = resolveUrl;
  const createRef = useRef(createAudio);
  createRef.current = createAudio;
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    selfRef.current.stop = () => {
      audioRef.current?.pause();
      setState('idle');
      setElapsed(0);
      setQueuedPlay(false);
    };
    return () => {
      aliveRef.current = false;
      audioRef.current?.pause();
      audioRef.current = null;
      prepPromiseRef.current = null;
      if (current === selfRef.current) current = null;
    };
  }, []);

  /** Resolve + build the audio element once; concurrent callers share the in-flight promise. */
  function prepare(): Promise<HTMLAudioElement> {
    if (audioRef.current) return Promise.resolve(audioRef.current);
    if (prepPromiseRef.current) return prepPromiseRef.current;
    const p = (async () => {
      const url = await resolveRef.current();
      if (!url) throw new Error('no url');
      if (audioRef.current) return audioRef.current;
      const make = createRef.current;
      const audio = make ? make(url) : new Audio(url);
      audio.preload = 'auto';
      audio.onloadedmetadata = () => {
        if (aliveRef.current && Number.isFinite(audio.duration) && audio.duration > 0) setDetectedMs(Math.round(audio.duration * 1000));
      };
      audio.ontimeupdate = () => aliveRef.current && setElapsed((audio.currentTime || 0) * 1000);
      audio.onended = () => {
        if (!aliveRef.current) return;
        setState('idle');
        setElapsed(0);
        if (current === selfRef.current) current = null;
      };
      audioRef.current = audio;
      try {
        audio.load?.();
      } catch {
        /* buffering is best-effort */
      }
      return audio;
    })();
    prepPromiseRef.current = p;
    p.then(
      () => {
        if (prepPromiseRef.current === p) prepPromiseRef.current = null;
      },
      () => {
        if (prepPromiseRef.current === p) prepPromiseRef.current = null;
      },
    );
    return p;
  }

  // Background preload: resolve + buffer, never play.
  useEffect(() => {
    if (!preload || pending || failed || audioRef.current) return;
    prepare().catch(() => {
      /* a tap will retry */
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preload, pending, failed, preloadKey]);

  async function play() {
    if (current && current !== selfRef.current) current.stop();
    current = selfRef.current;
    setState(audioRef.current ? 'playing' : 'loading');
    try {
      const audio = await prepare();
      if (!aliveRef.current) return;
      if (current !== selfRef.current) return setState('idle'); // another pill took over meanwhile
      await audio.play();
      if (aliveRef.current) setState('playing');
    } catch {
      if (aliveRef.current) setState('error');
    }
  }

  // Queued tap while synthesizing → play as soon as the clip is ready (this is the user's tap, deferred).
  const wasPending = useRef(pending);
  useEffect(() => {
    const was = wasPending.current;
    wasPending.current = pending;
    if (was && !pending && queuedPlay) {
      setQueuedPlay(false);
      if (!failed) void play();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, failed, queuedPlay]);

  function onClick() {
    if (failed) return;
    if (pending) {
      if (queuedPlay) {
        setQueuedPlay(false);
        if (current === selfRef.current) current = null;
        return;
      }
      if (current && current !== selfRef.current) current.stop();
      current = selfRef.current;
      setQueuedPlay(true);
      return;
    }
    if (state === 'playing') {
      selfRef.current.stop();
      if (current === selfRef.current) current = null;
      return;
    }
    if (state === 'loading') return;
    void play();
  }

  const view: 'failed' | 'queued' | 'pending' | PillState = failed ? 'failed' : pending ? (queuedPlay ? 'queued' : 'pending') : state;
  const total = durationMs ?? detectedMs ?? 0;
  const text =
    view === 'failed'
      ? '语音失败'
      : view === 'queued'
        ? '合成完即播'
        : view === 'pending'
          ? '合成中…'
          : view === 'playing'
            ? fmt(elapsed)
            : total
              ? fmt(total)
              : (label ?? '');
  const icon = view === 'failed' ? '⚠️' : view === 'queued' || view === 'pending' ? '⏳' : view === 'playing' ? '❚❚' : view === 'loading' ? '…' : view === 'error' ? '↻' : '▶';
  const aria =
    view === 'failed' ? '语音失败' : view === 'pending' ? '语音合成中，点击合成后播放' : view === 'queued' ? '合成完成后播放，点击取消' : view === 'playing' ? '暂停语音' : '播放语音';
  return (
    <button
      type="button"
      className={['k-voice', `is-${view}`, className].filter(Boolean).join(' ')}
      aria-label={aria}
      data-state={view}
      disabled={view === 'failed'}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <span className="k-voice-icon" aria-hidden>
        {icon}
      </span>
      {view !== 'failed' && view !== 'pending' && view !== 'queued' && (
        <span className="k-wave" aria-hidden>
          <i />
          <i />
          <i />
          <i />
        </span>
      )}
      {text && <span className="k-voice-time">{text}</span>}
    </button>
  );
}

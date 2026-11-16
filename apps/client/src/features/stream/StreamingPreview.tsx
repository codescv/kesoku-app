import { useEffect, useMemo, useState } from 'react';
import { RubyText, parseRubyNotation } from '@kesoku/ui';
import type { StreamPreview, TurnEvent } from '../../lib/types';
import { parseStreaming } from './streamParser';
import { Markdown } from '../segments/Markdown';
import { CardSkeleton } from '../segments/SegmentRenderer';

/** Discord-style `● ● ●  Name 正在输入…` (or `正在执行 <tool>…` while a tool runs). */
export function TypingIndicator({ name, toolTitle, className, hideName }: { name?: string; toolTitle?: string; className?: string; hideName?: boolean }) {
  const status = toolTitle ? `正在执行 ${toolTitle}…` : '正在输入…';
  if (hideName) {
    // Inline under the assistant header, which already shows avatar + name: `● ● ● 正在输入…`.
    return (
      <div className={'k-typing' + (className ? ` ${className}` : '')} data-testid="typing-indicator" role="status" aria-live="polite" aria-label={`${name || 'AI'} ${status}`}>
        <span className="k-typing-dots" aria-hidden>
          <span />
          <span />
          <span />
        </span>
        <span className="k-typing-label" aria-hidden>{status}</span>
      </div>
    );
  }
  return (
    <div className={'k-typing' + (className ? ` ${className}` : '')} data-testid="typing-indicator" role="status" aria-live="polite">
      <span className="k-typing-dots" aria-hidden>
        <span />
        <span />
        <span />
      </span>
      <span className="k-typing-label">
        <b>{name || 'AI'}</b> {status}
      </span>
    </div>
  );
}

/** Progressive preview: text as Markdown, open fences as skeletons (never raw YAML). */
export function StreamingPreview({ preview, name, toolTitle }: { preview: StreamPreview; name?: string; toolTitle?: string }) {
  const blocks = useMemo(() => parseStreaming(preview.text), [preview.text]);
  if (!preview.text.trim() && !preview.interrupted) {
    return (
      <div className="k-preview is-typing">
        <TypingIndicator name={name} toolTitle={toolTitle} hideName />
      </div>
    );
  }
  return (
    <div className={'k-preview' + (preview.interrupted ? ' is-interrupted' : '')} aria-live="polite">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'text':
            return <Markdown key={i} text={b.text} />;
          case 'code':
            return (
              <pre key={i} className="k-code">
                <code>{b.text}</code>
              </pre>
            );
          case 'bilingual':
            return (
              <div key={i} className="k-bi is-skeleton">
                {b.speaker && <div className="k-bi-head"><span className="k-bi-speaker">{b.speaker}</span></div>}
                {b.ja ? <div className="k-bi-ja"><RubyText parts={parseRubyNotation(b.ja)} /></div> : <CardSkeleton title="日语台词生成中…" />}
                {b.zh && <div className="k-bi-zh is-open">{b.zh}</div>}
              </div>
            );
          case 'card':
            return <CardSkeleton key={i} kind={b.cardKind} title={b.title} />;
          case 'ui':
            return null;
          case 'media':
            return (
              <div key={i} className="k-media k-media-pending">
                ⏳ {b.media === 'voice' ? '语音生成中…' : '附件生成中…'}
              </div>
            );
        }
      })}
      {!preview.interrupted && <span className="k-caret-blink" aria-hidden />}
      {preview.interrupted && <span className="k-pill k-pill-neutral k-pill-sm">已打断</span>}
    </div>
  );
}

function fmtSec(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** `▸ 思考与工具 · 1.1s` — collapsed by default; live timer + current tool while running. */
export function ThinkingPill({ events, running, startedAt, thought }: { events: TurnEvent[]; running: boolean; startedAt?: number; thought?: string }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [running]);
  if (!events.length && !thought && !running) return null;
  const first = events[0]?.ts ?? startedAt ?? now;
  const totalMs = running ? now - (startedAt ?? first) : events.reduce((a, e) => a + (e.elapsed_ms ?? 0), 0) || Math.max(0, (events[events.length - 1]?.ts ?? first) - first);
  const current = running ? [...events].reverse().find((e) => e.kind === 'tool_call') : undefined;
  return (
    <div className={'k-think' + (open ? ' is-open' : '')}>
      <button type="button" className="k-think-pill" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span aria-hidden>{open ? '▾' : '▸'}</span>{' '}
        <span className="k-think-label-full">思考与工具</span>
        <span className="k-think-label-short" aria-hidden="true">
          思考
        </span>{' '}
        · {fmtSec(totalMs)}
        {current && <span className="k-think-tool"> · {current.title}</span>}
      </button>
      {open && (
        <ol className="k-think-timeline">
          {thought && (
            <li className="is-thought">
              <b>💭 思考</b>
              <span>{thought}</span>
            </li>
          )}
          {events.map((e, i) => (
            <li key={i} className={`is-${e.kind}`}>
              <b>
                {e.kind === 'thought' ? '💭' : e.kind === 'tool_call' ? '🛠' : e.kind === 'tool_result' ? '✓' : 'ℹ'} {e.title}
              </b>
              {e.elapsed_ms !== undefined && <span className="k-think-ms">{fmtSec(e.elapsed_ms)}</span>}
              {e.body && <span className="k-think-body">{e.body}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

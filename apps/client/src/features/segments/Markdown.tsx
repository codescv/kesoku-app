import { Fragment, type ReactNode } from 'react';
import { parseRubyNotation, RubyText } from '@kesoku/ui';

/**
 * Minimal SAFE Markdown → React elements renderer. Never produces HTML strings: every text run is a
 * JSX child (auto-escaped). Supports headings, paragraphs, lists, block quotes, fenced code, inline code,
 * **bold**, *italic*, ~~strike~~, links (http/https/kesoku only) and inline ruby `漢字(かな)`.
 */

const SAFE_URL = /^(https?:\/\/|kesoku:\/\/)/i;

function renderRuby(text: string, key: string): ReactNode {
  const parts = parseRubyNotation(text);
  if (!parts.some((p) => p.rt)) return text;
  return <RubyText key={key} parts={parts} />;
}

const INLINE_SRC = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;

export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  let n = 0;
  // Fresh regex per call: renderInline recurses, so a shared global lastIndex would loop forever.
  const re = new RegExp(INLINE_SRC.source, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > cursor) out.push(renderRuby(text.slice(cursor, m.index), `${keyPrefix}-t${n++}`));
    const tok = m[0];
    const k = `${keyPrefix}-m${n++}`;
    if (m[1]) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (m[2] || m[3]) out.push(<strong key={k}>{renderInline(tok.slice(2, -2), k)}</strong>);
    else if (m[4]) out.push(<s key={k}>{renderInline(tok.slice(2, -2), k)}</s>);
    else if (m[5]) out.push(<em key={k}>{renderInline(tok.slice(1, -1), k)}</em>);
    else if (m[6]) {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
      const label = lm?.[1] ?? tok;
      const href = lm?.[2] ?? '';
      if (SAFE_URL.test(href)) {
        out.push(
          <a key={k} href={href} target="_blank" rel="noopener noreferrer nofollow">
            {label}
          </a>,
        );
      } else out.push(<Fragment key={k}>{label}</Fragment>);
    }
    cursor = m.index + tok.length;
  }
  if (cursor < text.length) out.push(renderRuby(text.slice(cursor), `${keyPrefix}-t${n++}`));
  return out;
}

type Block =
  | { t: 'p'; lines: string[] }
  | { t: 'h'; level: number; text: string }
  | { t: 'ul' | 'ol'; items: string[] }
  | { t: 'quote'; lines: string[] }
  | { t: 'code'; lang: string; text: string }
  | { t: 'hr' };

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    const fence = /^\s*```\s*([\w-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push({ t: 'code', lang: fence[1], text: body.join('\n') });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ t: 'h', level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }
    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*•]\s+/, ''));
      blocks.push({ t: 'ul', items });
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
      blocks.push({ t: 'ol', items });
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push({ t: 'quote', lines: q });
      continue;
    }
    const p: string[] = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\s*```/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) && !/^\s*[-*•]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i]) && !/^\s*>/.test(lines[i])) {
      p.push(lines[i++]);
    }
    if (!p.length) p.push(lines[i++]); // never stall on an unclassified line
    blocks.push({ t: 'p', lines: p });
  }
  return blocks;
}

function linesWithBreaks(lines: string[], key: string): ReactNode[] {
  const out: ReactNode[] = [];
  lines.forEach((l, idx) => {
    if (idx) out.push(<br key={`${key}-br${idx}`} />);
    out.push(...renderInline(l, `${key}-${idx}`));
  });
  return out;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className={['k-md', className].filter(Boolean).join(' ')}>
      {blocks.map((b, i) => {
        const k = `b${i}`;
        switch (b.t) {
          case 'p':
            return <p key={k}>{linesWithBreaks(b.lines, k)}</p>;
          case 'h': {
            const Tag = (`h${Math.min(4, b.level + 1)}` as 'h2' | 'h3' | 'h4');
            return <Tag key={k}>{renderInline(b.text, k)}</Tag>;
          }
          case 'ul':
            return (
              <ul key={k}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, `${k}-${j}`)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={k}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, `${k}-${j}`)}</li>
                ))}
              </ol>
            );
          case 'quote':
            return <blockquote key={k}>{linesWithBreaks(b.lines, k)}</blockquote>;
          case 'code':
            return (
              <pre key={k} className="k-code" data-lang={b.lang || undefined}>
                <code>{b.text}</code>
              </pre>
            );
          case 'hr':
            return <hr key={k} />;
        }
      })}
    </div>
  );
}

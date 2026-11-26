import { Fragment, useState, type ReactNode } from 'react';
import { parseRubyNotation, RubyText, useT } from '@kesoku/ui';

/**
 * Minimal SAFE Markdown → React elements renderer. Never produces HTML strings: every text run is a
 * JSX child (auto-escaped). Supports headings, paragraphs, lists, block quotes, fenced code, inline code,
 * **bold**, *italic*, ~~strike~~, <spoiler>/||spoiler||, GFM tables, links (http/https/kesoku only) and
 * inline ruby `漢字(かな)` / `漢字（かな）`.
 */

const SAFE_URL = /^(https?:\/\/|kesoku:\/\/)/i;

function renderRubyLine(text: string, key: string): ReactNode {
  const parts = parseRubyNotation(text);
  if (!parts.some((p) => p.rt)) return text;
  return <RubyText key={key} parts={parts} />;
}

/** Plain text run → ruby-aware nodes; embedded `\n` become `<br />` (multi-line paragraphs / spoilers). */
function renderRuby(text: string, key: string): ReactNode {
  if (!text.includes('\n')) return renderRubyLine(text, key);
  const out: ReactNode[] = [];
  text.split('\n').forEach((line, idx) => {
    if (idx) out.push(<br key={`${key}-br${idx}`} />);
    if (line) out.push(<Fragment key={`${key}-l${idx}`}>{renderRubyLine(line, `${key}-r${idx}`)}</Fragment>);
  });
  return <Fragment key={key}>{out}</Fragment>;
}

function Spoiler({ children, block }: { children: ReactNode; block?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <span
      role="button"
      tabIndex={0}
      aria-expanded={open}
      className={['k-spoiler', block && 'is-block', open && 'is-open'].filter(Boolean).join(' ')}
      onClick={(e) => {
        e.stopPropagation();
        setOpen((x) => !x);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setOpen((x) => !x);
        }
      }}
      title={open ? t('common.clickToHide') : t('common.clickToReveal')}
    >
      <span className="k-spoiler-inner">{children}</span>
    </span>
  );
}

const INLINE_SRC =
  /(`[^`\n]+`)|(<spoiler>[\s\S]*?<\/spoiler>)|(\|\|[^|]+?\|\|)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/gi;

export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  let n = 0;
  // Fresh regex per call: renderInline recurses, so a shared global lastIndex would loop forever.
  const re = new RegExp(INLINE_SRC.source, 'gi');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > cursor) out.push(renderRuby(text.slice(cursor, m.index), `${keyPrefix}-t${n++}`));
    const tok = m[0];
    const k = `${keyPrefix}-m${n++}`;
    if (m[1]) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (m[2]) {
      const inner = tok.replace(/^<spoiler>/i, '').replace(/<\/spoiler>$/i, '');
      out.push(<Spoiler key={k}>{renderInline(inner.trim(), k)}</Spoiler>);
    } else if (m[3]) {
      out.push(<Spoiler key={k}>{renderInline(tok.slice(2, -2).trim(), k)}</Spoiler>);
    } else if (m[4] || m[5]) out.push(<strong key={k}>{renderInline(tok.slice(2, -2), k)}</strong>);
    else if (m[6]) out.push(<s key={k}>{renderInline(tok.slice(2, -2), k)}</s>);
    else if (m[7]) out.push(<em key={k}>{renderInline(tok.slice(1, -1), k)}</em>);
    else if (m[8]) {
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
  | { t: 'ul'; items: string[] }
  | { t: 'ol'; items: string[]; start?: number; subLists?: Record<number, string[]> }
  | { t: 'quote'; lines: string[] }
  | { t: 'code'; lang: string; text: string }
  | { t: 'table'; headers: string[]; rows: string[][] }
  | { t: 'spoiler'; lines: string[]; body: string }
  | { t: 'hr' };

const TABLE_SEP_RE = /^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*(?::?-{2,}:?\s*)?$/;

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((c) => c.trim());
}

function isTableStart(lines: string[], idx: number): boolean {
  if (idx + 1 >= lines.length) return false;
  const head = lines[idx].trim();
  if (!head.includes('|')) return false;
  return TABLE_SEP_RE.test(lines[idx + 1]);
}

const SPOILER_OPEN_ALONE_RE = /^\s*<spoiler>\s*$/i;
const SPOILER_OPEN_RE = /^\s*<spoiler>/i;
const SPOILER_CLOSE_RE = /<\/spoiler>\s*$/i;

/**
 * Block-level spoiler starting at `lines[idx]`:
 *  - `<spoiler>` alone on a line … `</spoiler>` alone on a later line (legacy form), or
 *  - `<spoiler>text…` opening a line that does not close on the same line, closed by `…</spoiler>` at the end
 *    of a later line (text may hug either tag; blank lines in between are kept).
 * Returns the inner lines (outer tags stripped) and the index after the closing line, or null.
 */
function spoilerBlockAt(lines: string[], idx: number): { body: string[]; next: number } | null {
  const first = lines[idx];
  if (!SPOILER_OPEN_RE.test(first)) return null;
  const alone = SPOILER_OPEN_ALONE_RE.test(first);
  if (!alone && /<\/spoiler>/i.test(first)) return null; // single-line inline spoiler → paragraph
  for (let j = idx + 1; j < lines.length; j++) {
    if (/^\s*```/.test(lines[j])) return null; // never swallow a code fence
    if (!SPOILER_CLOSE_RE.test(lines[j])) continue;
    if (/<\/spoiler>/i.test(lines[j].replace(SPOILER_CLOSE_RE, ''))) return null; // ambiguous nesting
    const body = lines.slice(idx, j + 1);
    body[0] = body[0].replace(SPOILER_OPEN_RE, '');
    body[body.length - 1] = body[body.length - 1].replace(SPOILER_CLOSE_RE, '');
    if (alone) body.shift();
    if (body.length && /^\s*$/.test(body[body.length - 1])) body.pop();
    return { body, next: j + 1 };
  }
  // Unclosed: keep legacy behaviour for a lone `<spoiler>` (swallow to EOF), otherwise not a block.
  return alone ? { body: lines.slice(idx + 1), next: lines.length } : null;
}

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  let nextOlNum = 1;
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
    const sp = spoilerBlockAt(lines, i);
    if (sp) {
      i = sp.next;
      blocks.push({ t: 'spoiler', lines: sp.body, body: sp.body.join('\n') });
      continue;
    }
    if (isTableStart(lines, i)) {
      const headers = splitTableRow(lines[i]);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().includes('|') && !/^\s*$/.test(lines[i])) {
        if (!TABLE_SEP_RE.test(lines[i])) rows.push(splitTableRow(lines[i]));
        i++;
      }
      blocks.push({ t: 'table', headers, rows });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      nextOlNum = 1;
      blocks.push({ t: 'h', level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      nextOlNum = 1;
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
    const olFirst = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (olFirst) {
      const firstParsed = parseInt(olFirst[1], 10) || 1;
      const start = firstParsed > 1 ? firstParsed : nextOlNum;
      const items: string[] = [];
      const subLists: Record<number, string[]> = {};
      while (i < lines.length) {
        const m = /^\s*\d+[.)]\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        const idx = items.length;
        items.push(m[1]);
        i++;
        // Skip blank lines immediately after an ordered list item if bullet sub-items or the next ordered item follow
        let look = i;
        while (look < lines.length && /^\s*$/.test(lines[look])) look++;
        if (look < lines.length && /^\s*[-*•]\s+/.test(lines[look])) {
          i = look;
          const bullets: string[] = [];
          while (i < lines.length) {
            if (/^\s*[-*•]\s+/.test(lines[i])) {
              bullets.push(lines[i++].replace(/^\s*[-*•]\s+/, ''));
            } else if (/^\s*$/.test(lines[i])) {
              let k = i;
              while (k < lines.length && /^\s*$/.test(lines[k])) k++;
              if (k < lines.length && /^\s*[-*•]\s+/.test(lines[k])) {
                i = k;
              } else {
                break;
              }
            } else {
              break;
            }
          }
          if (bullets.length) subLists[idx] = bullets;
        }
        let nextLook = i;
        while (nextLook < lines.length && /^\s*$/.test(lines[nextLook])) nextLook++;
        if (nextLook < lines.length && /^\s*\d+[.)]\s+/.test(lines[nextLook])) {
          i = nextLook;
        }
      }
      nextOlNum = start + items.length;
      const block: Extract<Block, { t: 'ol' }> = { t: 'ol', items };
      if (start > 1) block.start = start;
      if (Object.keys(subLists).length > 0) block.subLists = subLists;
      blocks.push(block);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push({ t: 'quote', lines: q });
      continue;
    }
    const p: string[] = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^\s*```/.test(lines[i]) &&
      !spoilerBlockAt(lines, i) &&
      !isTableStart(lines, i) &&
      !/^#{1,4}\s/.test(lines[i]) &&
      !/^\s*[-*•]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^\s*>/.test(lines[i])
    ) {
      p.push(lines[i++]);
    }
    if (!p.length) p.push(lines[i++]); // never stall on an unclassified line
    nextOlNum = 1;
    blocks.push({ t: 'p', lines: p });
  }
  return blocks;
}

/** Render a multi-line block as ONE inline run so `<spoiler>`/`||` spanning lines still match; `\n` → `<br />`. */
function linesWithBreaks(lines: string[], key: string): ReactNode[] {
  return renderInline(lines.join('\n'), key);
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
              <ol key={k} start={b.start && b.start > 1 ? b.start : undefined}>
                {b.items.map((it, j) => (
                  <li key={j}>
                    {renderInline(it, `${k}-${j}`)}
                    {b.subLists?.[j]?.length ? (
                      <ul>
                        {b.subLists[j].map((sub, sj) => (
                          <li key={sj}>{renderInline(sub, `${k}-${j}-s${sj}`)}</li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
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
          case 'spoiler':
            return (
              <div key={k} className="k-spoiler-block">
                <Spoiler block>{linesWithBreaks(b.lines, k)}</Spoiler>
              </div>
            );
          case 'table':
            return (
              <div key={k} className="k-table-wrap">
                <table className="k-table">
                  <thead>
                    <tr>
                      {b.headers.map((h, cIdx) => (
                        <th key={cIdx}>{renderInline(h, `${k}-th${cIdx}`)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, rIdx) => (
                      <tr key={rIdx}>
                        {b.headers.map((_, cIdx) => (
                          <td key={cIdx}>{renderInline(row[cIdx] ?? '', `${k}-td${rIdx}-${cIdx}`)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'hr':
            return <hr key={k} />;
        }
      })}
    </div>
  );
}

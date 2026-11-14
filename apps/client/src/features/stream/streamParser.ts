/**
 * Fence-aware streaming parser (Blueprint §3.2 / §3.4): while a ```bilingual / ```card / ```ui fence is
 * still open (or closed but not yet replaced by `message.final`) the raw YAML is never shown — callers render
 * progressive skeletons instead. Also hides half-typed fence openers and raw `[file:]` / `[voice:]` markers.
 */

export type StreamBlock =
  | { kind: 'text'; text: string }
  | { kind: 'bilingual'; closed: boolean; ja?: string; zh?: string; speaker?: string }
  | { kind: 'card'; closed: boolean; cardKind?: string; title?: string }
  | { kind: 'ui'; closed: boolean }
  | { kind: 'code'; closed: boolean; lang: string; text: string }
  | { kind: 'media'; media: 'file' | 'voice'; ref: string };

const SPECIAL = new Set(['bilingual', 'card', 'ui']);
const MEDIA_RE = /\[(file|voice):([^\]\n]+)\]/g;

function unquote(v: string): string {
  let s = v.trim();
  if (s.startsWith('"')) {
    s = s.slice(1);
    const end = s.lastIndexOf('"');
    if (end >= 0) s = s.slice(0, end);
    return s.replace(/\\"/g, '"').replace(/\\n/g, '\n');
  }
  if (s.startsWith("'")) {
    s = s.slice(1);
    const end = s.lastIndexOf("'");
    if (end >= 0) s = s.slice(0, end);
    return s.replace(/''/g, "'");
  }
  return s;
}

/** Minimal tolerant YAML scalar reader for top-level `key: value` (+ `|` / `>` blocks). */
export function readYamlScalars(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const [, key, rest] = m;
    if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
      const buf: string[] = [];
      for (let j = i + 1; j < lines.length && (/^\s+/.test(lines[j]) || lines[j] === ''); j++) buf.push(lines[j].trim());
      out[key] = buf.join(rest.startsWith('>') ? ' ' : '\n').trim();
    } else if (rest !== '') {
      out[key] = unquote(rest);
    }
  }
  return out;
}

function pushText(blocks: StreamBlock[], text: string) {
  if (!text) return;
  let cursor = 0;
  MEDIA_RE.lastIndex = 0;
  for (let m = MEDIA_RE.exec(text); m; m = MEDIA_RE.exec(text)) {
    const before = text.slice(cursor, m.index);
    if (before) appendText(blocks, before);
    blocks.push({ kind: 'media', media: m[1] as 'file' | 'voice', ref: m[2].trim() });
    cursor = m.index + m[0].length;
  }
  const rest = text.slice(cursor);
  // Hide a half-typed media marker at the very end (`[fi`, `[file:abc`).
  const partial = /\[(?:f(?:i(?:l(?:e(?::[^\]\n]*)?)?)?)?|v(?:o(?:i(?:c(?:e(?::[^\]\n]*)?)?)?)?)?)?$/.exec(rest);
  appendText(blocks, partial ? rest.slice(0, partial.index) : rest);
}

function appendText(blocks: StreamBlock[], text: string) {
  if (!text) return;
  const last = blocks[blocks.length - 1];
  if (last && last.kind === 'text') last.text += text;
  else blocks.push({ kind: 'text', text });
}

export function parseStreaming(src: string): StreamBlock[] {
  const blocks: StreamBlock[] = [];
  const lines = src.split('\n');
  let i = 0;
  let textBuf: string[] = [];
  const flushText = () => {
    if (textBuf.length) {
      pushText(blocks, textBuf.join('\n'));
      textBuf = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    const open = /^\s*```\s*([A-Za-z0-9_-]*)\s*$/.exec(line);
    if (open && !isLast) {
      flushText();
      const lang = open[1].toLowerCase();
      const body: string[] = [];
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j++) {
        if (/^\s*```\s*$/.test(lines[j])) {
          closed = true;
          break;
        }
        body.push(lines[j]);
      }
      // A trailing partial closing fence ("`" / "``") is not part of the body.
      if (!closed && body.length && /^\s*`{1,2}\s*$/.test(body[body.length - 1])) body.pop();
      const text = body.join('\n');
      if (SPECIAL.has(lang)) {
        if (lang === 'bilingual') {
          const y = readYamlScalars(text);
          blocks.push({ kind: 'bilingual', closed, ja: y.ja ?? y.ja_plain, zh: y.zh, speaker: y.speaker });
        } else if (lang === 'card') {
          const y = readYamlScalars(text);
          blocks.push({ kind: 'card', closed, cardKind: y.kind, title: y.title });
        } else blocks.push({ kind: 'ui', closed });
      } else {
        blocks.push({ kind: 'code', closed, lang, text });
      }
      i = closed ? j + 1 : lines.length;
      continue;
    }
    // Half-typed fence opener on the last line (e.g. "``" or "```bil") → hide.
    if (isLast && /^\s*`{1,3}[A-Za-z0-9_-]*$/.test(line)) {
      i++;
      continue;
    }
    textBuf.push(line);
    i++;
  }
  flushText();
  return blocks;
}

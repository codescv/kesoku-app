/**
 * Safe ruby (furigana) parsing → plain data → React <ruby>/<rt> elements.
 * NEVER produces HTML strings; output is plain data rendered as React elements.
 */

export interface RubyPart {
  base: string;
  rt?: string;
}

const KANJI = '[\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF々〆ヶヵ〇]';
const HIRA = '[\\u3041-\\u3096]';
const KANA = '[\\u3041-\\u309F\\u30A0-\\u30FFー・\\uFF66-\\uFF9F]';
// 漢字(かな) / 漢字（かな） (including okurigana compounds like 勘違い（かんちがい） or 木漏れ日（こもれび）) and Aozora-style ｜base《rt》 / base《rt》
const NOTATION_RE = new RegExp(
  `[｜|]([^｜|《》()（）]+?)《(${KANA}+)》|(${KANJI}+)《(${KANA}+)》|(${KANJI}+(${HIRA}{1,3}))[(（](${KANA}+?\\6)[)）]|(${KANJI}+(?:${HIRA}{1,2}${KANJI}+)*)[(（](${KANA}+)[)）]`,
  'gu',
);

function pushText(parts: RubyPart[], text: string): void {
  if (!text) return;
  const last = parts[parts.length - 1];
  if (last && last.rt === undefined) last.base += text;
  else parts.push({ base: text });
}

/** Parse inline notation: `今日(きょう)は良(よ)い天気(てんき)` → parts. Non-kana parentheses are kept as text. */
export function parseRubyNotation(text: string): RubyPart[] {
  const parts: RubyPart[] = [];
  if (!text) return parts;
  let cursor = 0;
  const re = new RegExp(NOTATION_RE.source, NOTATION_RE.flags);
  for (let m = re.exec(text); m; m = re.exec(text)) {
    pushText(parts, text.slice(cursor, m.index));
    const base = m[1] ?? m[3] ?? m[5] ?? m[8];
    const rt = m[2] ?? m[4] ?? m[7] ?? m[9];
    parts.push({ base, rt });
    cursor = m.index + m[0].length;
  }
  pushText(parts, text.slice(cursor));
  return parts;
}

export type RubySpecInput =
  | string
  | Array<{ base: string; rt?: string } | [string, string]>
  | Record<string, string>
  | null
  | undefined;

/** Align explicit annotations against plain text (sequential, first-match from cursor). */
export function alignRuby(plain: string, pairs: Array<{ base: string; rt?: string }>): RubyPart[] {
  const parts: RubyPart[] = [];
  let cursor = 0;
  for (const p of pairs) {
    if (!p.base) continue;
    const idx = plain.indexOf(p.base, cursor);
    if (idx < 0) continue;
    pushText(parts, plain.slice(cursor, idx));
    if (p.rt) parts.push({ base: p.base, rt: p.rt });
    else pushText(parts, p.base);
    cursor = idx + p.base.length;
  }
  pushText(parts, plain.slice(cursor));
  return parts;
}

/** Map form `{今日: きょう}` → annotate every occurrence (longest bases first). */
function annotateMap(plain: string, map: Record<string, string>): RubyPart[] {
  const bases = Object.keys(map)
    .filter((b) => b && map[b])
    .sort((a, b) => b.length - a.length);
  if (!bases.length) return plain ? [{ base: plain }] : [];
  const parts: RubyPart[] = [];
  let i = 0;
  outer: while (i < plain.length) {
    for (const b of bases) {
      if (plain.startsWith(b, i)) {
        parts.push({ base: b, rt: map[b] });
        i += b.length;
        continue outer;
      }
    }
    pushText(parts, plain[i]);
    i += 1;
  }
  return parts;
}

export function fromRubySpec(plain: string, spec: RubySpecInput): RubyPart[] {
  if (spec == null) return parseRubyNotation(plain);
  if (typeof spec === 'string') {
    const parsed = parseRubyNotation(spec);
    return parsed.some((p) => p.rt) ? parsed : parseRubyNotation(plain);
  }
  if (Array.isArray(spec)) {
    const pairs = spec.map((p) => (Array.isArray(p) ? { base: p[0], rt: p[1] } : { base: String(p.base ?? ''), rt: p.rt ? String(p.rt) : undefined }));
    return alignRuby(plain, pairs);
  }
  if (typeof spec === 'object') return annotateMap(plain, spec);
  return parseRubyNotation(plain);
}

export interface BilingualRubySource {
  ja_plain?: string;
  ja?: string;
  ruby?: RubySpecInput;
  ruby_parts?: Array<{ base: string; rt?: string }>;
}

/** Preference: engine `ruby_parts` → explicit `ruby` spec → `漢字(かな)` in `ja` → notation in `ja_plain`. */
export function resolveRubyParts(seg: BilingualRubySource): RubyPart[] {
  if (Array.isArray(seg.ruby_parts) && seg.ruby_parts.length) {
    return seg.ruby_parts
      .filter((p) => p && typeof p.base === 'string')
      .map((p) => (p.rt ? { base: p.base, rt: String(p.rt) } : { base: p.base }));
  }
  const plain = seg.ja_plain ?? stripRubyNotation(seg.ja ?? '');
  if (seg.ruby != null) return fromRubySpec(plain, seg.ruby);
  if (seg.ja) {
    const parts = parseRubyNotation(seg.ja);
    if (parts.some((p) => p.rt)) return parts;
  }
  return parseRubyNotation(plain);
}

export function partsToPlain(parts: RubyPart[]): string {
  return parts.map((p) => p.base).join('');
}

/** `今日(きょう)は` → `今日は` */
export function stripRubyNotation(text: string): string {
  return partsToPlain(parseRubyNotation(text));
}

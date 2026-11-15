import { useMemo, type CSSProperties, type ReactNode } from 'react';

/**
 * Lightweight, dependency-free syntax highlighter for the file browser.
 *
 * A deterministic sticky-regex tokenizer: at each position the language's rules are tried in
 * order and the first match wins; anything unmatched is plain text. Multi-line constructs
 * (block comments, triple-quoted strings, fenced code) are matched against the whole source,
 * then tokens are split into lines for rendering. Output is plain React elements — never HTML.
 */

export type HighlightLang = 'toml' | 'json' | 'yaml' | 'python' | 'ts' | 'sh' | 'css' | 'html' | 'sql' | 'markdown';
export type TokenClass = 'comment' | 'sec' | 'key' | 'str' | 'num' | 'bool' | 'kw' | 'punct';
export interface Token {
  cls: TokenClass | null;
  text: string;
}

/** Above this many characters the viewer falls back to a plain (unhighlighted) `<pre>`. */
export const HIGHLIGHT_MAX_CHARS = 200 * 1024;

const EXT_LANG: Record<string, HighlightLang> = {
  toml: 'toml', ini: 'toml', cfg: 'toml', conf: 'toml', properties: 'toml', editorconfig: 'toml', gitconfig: 'toml', npmrc: 'toml',
  json: 'json', jsonc: 'json', jsonl: 'json', ndjson: 'json', json5: 'json', geojson: 'json', webmanifest: 'json',
  yaml: 'yaml', yml: 'yaml',
  py: 'python', pyi: 'python', pyw: 'python',
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts', js: 'ts', jsx: 'ts', mjs: 'ts', cjs: 'ts',
  sh: 'sh', bash: 'sh', zsh: 'sh', bashrc: 'sh', zshrc: 'sh', profile: 'sh', bash_profile: 'sh', env: 'sh',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html', xhtml: 'html', xml: 'html', svg: 'html', vue: 'html',
  sql: 'sql',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
};

/** Map a file name to a highlighter language (by extension, or by dotfile name like `.bashrc`). */
export function detectLang(filename: string): HighlightLang | null {
  const base = (filename.split(/[\\/]/).pop() ?? '').toLowerCase();
  if (!base) return null;
  if (/^\.env(\..+)?$/.test(base)) return 'sh';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  return EXT_LANG[base.slice(dot + 1)] ?? null;
}

// ───────────── tokenizer core ─────────────

type ClassifyFn = (text: string, src: string, end: number) => TokenClass | null;
interface Rule {
  re: RegExp;
  cls?: TokenClass | ClassifyFn;
  /** Re-tokenize the match into several tokens (e.g. an HTML tag into name/attr/value). */
  emit?: (text: string) => Token[];
  when?: (src: string, pos: number) => boolean;
}

const isWs = (ch: string | undefined) => ch === ' ' || ch === '\t' || ch === '\r';
/** Only spaces/tabs between the line start and `pos`. */
function atLineStart(src: string, pos: number): boolean {
  for (let i = pos - 1; i >= 0; i--) {
    const ch = src[i];
    if (ch === '\n') return true;
    if (!isWs(ch)) return false;
  }
  return true;
}
const atColumn0 = (src: string, pos: number) => pos === 0 || src[pos - 1] === '\n';
/** Previous char is whitespace / a line break / start of input. */
/** Not glued to a preceding identifier char or dot (so `v1.2.3` / `a.5` don't light up partially). */
const WORDISH = /[\p{L}\p{N}_.$]/u;
const notAfterWord = (src: string, pos: number) => pos === 0 || !WORDISH.test(src[pos - 1]!);
const afterSpace = (src: string, pos: number) => pos === 0 || isWs(src[pos - 1]) || src[pos - 1] === '\n';
/** Nearest previous non-blank char, optionally crossing line breaks (bounded look-back). */
function prevNonWs(src: string, pos: number, crossLines = false): string {
  for (let i = pos - 1, n = 0; i >= 0 && n < 4096; i--, n++) {
    const ch = src[i]!;
    if (isWs(ch) || (crossLines && ch === '\n')) continue;
    return ch === '\n' ? '' : ch;
  }
  return '';
}
/** Leading part of the current line before `pos` consists only of blanks and list dashes. */
function yamlKeyPos(src: string, pos: number): boolean {
  for (let i = pos - 1; i >= 0; i--) {
    const ch = src[i];
    if (ch === '\n') return true;
    if (!isWs(ch) && ch !== '-') {
      return ch === '{' || ch === ',' ? true : false;
    }
  }
  return true;
}
/** CSS: are we after a `:` inside a declaration (rather than in a selector)? */
function cssInValue(src: string, pos: number): boolean {
  for (let i = pos - 1, n = 0; i >= 0 && n < 2048; i--, n++) {
    const ch = src[i];
    if (ch === ':') return true;
    if (ch === '{' || ch === ';' || ch === '}' || ch === '\n') return false;
  }
  return false;
}

function tokenize(src: string, rules: Rule[]): Token[] {
  const out: Token[] = [];
  let plain = '';
  const flush = () => {
    if (plain) {
      out.push({ cls: null, text: plain });
      plain = '';
    }
  };
  let pos = 0;
  const len = src.length;
  outer: while (pos < len) {
    const ch = src[pos]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      plain += ch;
      pos++;
      continue;
    }
    for (const rule of rules) {
      if (rule.when && !rule.when(src, pos)) continue;
      rule.re.lastIndex = pos;
      const m = rule.re.exec(src);
      if (!m || !m[0]) continue;
      const text = m[0];
      const end = pos + text.length;
      if (rule.emit) {
        flush();
        for (const t of rule.emit(text)) out.push(t);
      } else {
        const cls = typeof rule.cls === 'function' ? rule.cls(text, src, end) : (rule.cls ?? null);
        if (cls) {
          flush();
          out.push({ cls, text });
        } else plain += text;
      }
      pos = end;
      continue outer;
    }
    plain += ch;
    pos++;
  }
  flush();
  return out;
}

// ───────────── shared building blocks ─────────────

const EOF = '(?![\\s\\S])';
const DQ = '"(?:\\\\.|[^"\\\\\\n])*(?:"|$)';
const SQ = "'(?:\\\\.|[^'\\\\\\n])*(?:'|$)";
const BLOCK_COMMENT: Rule = { re: new RegExp(`/\\*[\\s\\S]*?(?:\\*/|${EOF})`, 'y'), cls: 'comment' };
const LINE_COMMENT_SLASH: Rule = { re: /\/\/.*/y, cls: 'comment' };
const HASH_COMMENT: Rule = { re: /#.*/y, cls: 'comment' };
const DQ_STR: Rule = { re: new RegExp(DQ, 'my'), cls: 'str' };
const SQ_STR: Rule = { re: new RegExp(SQ, 'my'), cls: 'str' };
const C_NUM = '(?:0[xX][\\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?|\\.\\d[\\d_]*(?:[eE][+-]?\\d+)?)';
/** Scalar terminator for TOML/YAML values: end of line, comment, or a flow delimiter. */
const VALUE_END = '(?=[ \\t]*(?:$|[,\\]}#]))';

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));
function wordRule(re: RegExp, kw: Set<string>, bool: Set<string>, ci = false): Rule {
  return {
    re,
    cls: (text) => {
      const w = ci ? text.toLowerCase() : text;
      if (bool.has(w)) return 'bool';
      if (kw.has(w)) return 'kw';
      return null;
    },
  };
}
const UNICODE_WORD = /[\p{L}_$][\p{L}\p{N}_$]*/uy;

// ───────────── languages ─────────────

const TOML_KEYPART = `(?:[A-Za-z0-9_-]+|${DQ.replace('|$', '')}|'[^'\\n]*')`;
const TOML: Rule[] = [
  HASH_COMMENT,
  { re: /;.*/y, cls: 'comment', when: atLineStart },
  { re: /\[\[?[^\]\n]*\]\]?(?=[ \t]*(?:[#;].*)?$)/my, cls: 'sec', when: atLineStart },
  {
    re: new RegExp(`${TOML_KEYPART}(?:[ \\t]*\\.[ \\t]*${TOML_KEYPART})*(?=[ \\t]*=)`, 'y'),
    cls: 'key',
    when: (s, p) => atLineStart(s, p) || '{,'.includes(prevNonWs(s, p) || '\n'),
  },
  { re: new RegExp(`"""[\\s\\S]*?(?:"""|${EOF})`, 'y'), cls: 'str' },
  { re: new RegExp(`'''[\\s\\S]*?(?:'''|${EOF})`, 'y'), cls: 'str' },
  DQ_STR,
  { re: /'[^'\n]*(?:'|$)/my, cls: 'str' },
  { re: /\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:[Zz]|[+-]\d{2}:\d{2})?|\d{2}:\d{2}:\d{2}(?:\.\d+)?/y, cls: 'num' },
  { re: new RegExp(`[+-]?(?:${C_NUM}|inf|nan)(?![\\w.])`, 'y'), cls: 'num', when: notAfterWord },
  wordRule(/[A-Za-z_][\w-]*/y, new Set(), words('true false')),
  { re: /[[\]{}=,.]/y, cls: 'punct' },
];

const JSON_RULES: Rule[] = [
  LINE_COMMENT_SLASH,
  BLOCK_COMMENT,
  { re: /"(?:\\.|[^"\\\n])*"(?=\s*:)/y, cls: 'key' },
  DQ_STR,
  { re: /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y, cls: 'num' },
  wordRule(/[A-Za-z_]\w*/y, words('NaN Infinity'), words('true false null')),
  { re: /[{}[\]:,]/y, cls: 'punct' },
];

const YAML_BOOL = words('true false null yes no on off ~');
const YAML: Rule[] = [
  { re: /#.*/y, cls: 'comment', when: afterSpace },
  { re: /(?:---|\.\.\.)(?=[ \t]|$)/my, cls: 'sec', when: atColumn0 },
  {
    re: /(?:"(?:\\.|[^"\\\n])*"|'(?:''|[^'\n])*'|[^\s#'"[\]{},:&*!|>%@`-][^\n]*?|-[^\s][^\n]*?)(?=[ \t]*:(?:[ \t]|$))/my,
    cls: 'key',
    when: yamlKeyPos,
  },
  { re: /"(?:\\.|[^"\\\n])*(?:"|$)/my, cls: 'str' },
  { re: /'(?:''|[^'\n])*(?:'|$)/my, cls: 'str' },
  { re: /(?:[&*][\w-]+|!!?[\w/-]*)/y, cls: 'kw', when: afterSpace },
  { re: /[|>][-+]?\d*(?=[ \t]*(?:#.*)?$)/my, cls: 'punct' },
  {
    re: new RegExp(
      `(?:\\d{4}-\\d{2}-\\d{2}(?:[Tt ]\\d{1,2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:[ \\t]*(?:Z|[+-]\\d{1,2}(?::\\d{2})?))?)?|[-+]?(?:${C_NUM}|\\.inf|\\.nan))${VALUE_END}`,
      'my',
    ),
    cls: 'num',
    when: notAfterWord,
  },
  { re: new RegExp(`~${VALUE_END}`, 'my'), cls: 'bool' },
  {
    re: /[\p{L}_][\p{L}\p{N}_.-]*/uy,
    cls: (text, src, end) => {
      if (!YAML_BOOL.has(text.toLowerCase())) return null;
      const rest = /[ \t]*(.?)/y;
      rest.lastIndex = end;
      const next = rest.exec(src)?.[1] ?? '';
      return next === '' || next === '\n' || next === '\r' || ',]}#'.includes(next) ? 'bool' : null;
    },
  },
  { re: /-(?=[ \t]|$)|[:?](?=[ \t]|$)|[{}[\],]/my, cls: 'punct' },
];

const PY_KW = words(
  'and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return try while with yield print self cls',
);
const PYTHON: Rule[] = [
  HASH_COMMENT,
  { re: /@[\w.]+/y, cls: 'sec', when: atLineStart },
  { re: new RegExp(`(?:[rRbBuUfF]{1,2})?(?:"""[\\s\\S]*?(?:"""|${EOF})|'''[\\s\\S]*?(?:'''|${EOF}))`, 'y'), cls: 'str' },
  { re: new RegExp(`(?:[rRbBuUfF]{1,2})?(?:${DQ}|${SQ})`, 'my'), cls: 'str' },
  { re: new RegExp(`${C_NUM}[jJ]?`, 'y'), cls: 'num', when: notAfterWord },
  wordRule(/[\p{L}_][\p{L}\p{N}_]*/uy, PY_KW, words('True False None')),
];

const TS_KW = words(
  'abstract as async await break case catch class const constructor continue debugger declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface keyof let namespace new of private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield',
);
const TS: Rule[] = [
  LINE_COMMENT_SLASH,
  BLOCK_COMMENT,
  DQ_STR,
  SQ_STR,
  { re: new RegExp(`\`(?:\\\\[\\s\\S]|[^\`\\\\])*(?:\`|${EOF})`, 'y'), cls: 'str' },
  { re: /@[\w.]+/y, cls: 'sec' },
  { re: new RegExp(`${C_NUM}n?`, 'y'), cls: 'num', when: notAfterWord },
  wordRule(UNICODE_WORD, TS_KW, words('true false null undefined')),
];

const SH_KW = words(
  'if then else elif fi for while until do done case esac in function return export local readonly declare unset source alias break continue exit set shift trap eval exec select time',
);
const SH: Rule[] = [
  { re: /#.*/y, cls: 'comment', when: afterSpace },
  { re: new RegExp(`"(?:\\\\[\\s\\S]|[^"\\\\])*(?:"|${EOF})`, 'y'), cls: 'str' },
  { re: new RegExp(`'[^']*(?:'|${EOF})`, 'y'), cls: 'str' },
  { re: /\$(?:\{[^}\n]*\}|[A-Za-z_]\w*|[0-9@*#?$!-])/y, cls: 'key' },
  { re: /[A-Za-z_]\w*(?==)/y, cls: 'key', when: (s, p) => afterSpace(s, p) || prevNonWs(s, p) === ';' },
  { re: /\d+(?:\.\d+)?(?![\w.])/y, cls: 'num' },
  wordRule(/[A-Za-z_][\w-]*/y, SH_KW, words('true false')),
];

const CSS: Rule[] = [
  BLOCK_COMMENT,
  LINE_COMMENT_SLASH,
  DQ_STR,
  SQ_STR,
  { re: /@[\w-]+|!important/y, cls: 'kw' },
  {
    re: /(?:--?)?[A-Za-z_][\w-]*(?=\s*:(?![^;{}\n]*\{))/y,
    cls: 'key',
    when: (s, p) => '{;'.includes(prevNonWs(s, p, true) || '{'),
  },
  { re: /#[\da-fA-F]{3,8}(?![\w-])/y, cls: 'num', when: cssInValue },
  { re: /-?(?:\d+\.?\d*|\.\d+)(?:%|[a-zA-Z]+)?/y, cls: 'num', when: notAfterWord },
  { re: /-?[A-Za-z_][\w-]*/y },
  { re: /[{}]/y, cls: 'punct' },
];

const HTML_TAG_INNER: Rule[] = [
  { re: /<\/?[A-Za-z][\w:.-]*/y, cls: 'kw' },
  { re: /\/?>/y, cls: 'kw' },
  { re: /"[^"]*"?|'[^']*'?/y, cls: 'str' },
  { re: /=/y, cls: 'punct' },
  { re: /[^\s"'<>/=]+/y, cls: 'key' },
];
const HTML: Rule[] = [
  { re: new RegExp(`<!--[\\s\\S]*?(?:-->|${EOF})`, 'y'), cls: 'comment' },
  { re: new RegExp(`<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>|${EOF})`, 'y'), cls: 'str' },
  { re: /<[!?][^>]*>?/y, cls: 'kw' },
  { re: /<\/?[A-Za-z][\w:.-]*(?:"[^"]*"|'[^']*'|[^'"<>])*>?/y, emit: (text) => tokenize(text, HTML_TAG_INNER) },
  { re: /&(?:#\d+|#x[\da-fA-F]+|\w+);/y, cls: 'num' },
  { re: /[^<&\s]+/y },
];

const SQL_KW = words(
  'select from where and or not insert into values update set delete create table view index drop alter add column primary key foreign references join left right inner outer full cross on as group by order having limit offset union all distinct case when then else end is in exists between like ilike asc desc with returning default unique constraint if begin commit rollback transaction pragma replace cast count sum avg min max over partition',
);
const SQL: Rule[] = [
  { re: /--.*/y, cls: 'comment' },
  BLOCK_COMMENT,
  { re: new RegExp(`'(?:''|[^'])*(?:'|${EOF})`, 'y'), cls: 'str' },
  { re: /"(?:""|[^"\n])*"?|`[^`\n]*`?/y, cls: 'key' },
  { re: /[@:$][A-Za-z_\d]\w*/y, cls: 'key', when: (s, p) => !/[\w:]/.test(s[p - 1] ?? '') },
  { re: /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, cls: 'num' },
  wordRule(/[A-Za-z_]\w*/y, SQL_KW, words('true false null'), true),
];

const MARKDOWN: Rule[] = [
  { re: /(`{3,}|~{3,})[^\n]*(?:\n(?:[^\n]*\n)*?[ \t]*\1[ \t]*$|[\s\S]*)/my, cls: 'str', when: atLineStart },
  { re: new RegExp(`<!--[\\s\\S]*?(?:-->|${EOF})`, 'y'), cls: 'comment' },
  { re: /(?:---|\*\*\*|___)[ \t]*$/my, cls: 'punct', when: atLineStart },
  { re: /#{1,6}(?:[ \t].*)?$/my, cls: 'sec', when: atLineStart },
  { re: />.*/y, cls: 'comment', when: atLineStart },
  { re: /(?:[-*+]|\d+[.)])(?=[ \t])/y, cls: 'punct', when: atLineStart },
  { re: /`[^`\n]+`/y, cls: 'str' },
  { re: /!?\[[^\]\n]*\]\([^)\n]*\)/y, cls: 'key' },
  { re: /\*\*[^*\n]+\*\*|__[^_\n]+__/y, cls: 'kw' },
  { re: /[\p{L}\p{N}_]+/uy },
];

const LANG_RULES: Record<HighlightLang, Rule[]> = {
  toml: TOML,
  json: JSON_RULES,
  yaml: YAML,
  python: PYTHON,
  ts: TS,
  sh: SH,
  css: CSS,
  html: HTML,
  sql: SQL,
  markdown: MARKDOWN,
};

/** Tokenize `code` as `lang` (unknown language → one plain token). */
export function tokenizeCode(code: string, lang: HighlightLang | null): Token[] {
  if (!lang || !code) return code ? [{ cls: null, text: code }] : [];
  return tokenize(code, LANG_RULES[lang]);
}

/** Tokenize and split into lines (tokens spanning line breaks are split). A single trailing newline adds no empty line. */
export function highlightLines(code: string, lang: HighlightLang | null): Token[][] {
  const lines: Token[][] = [[]];
  for (const tok of tokenizeCode(code.replace(/\r\n?/g, '\n'), lang)) {
    const parts = tok.text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1]!.push({ cls: tok.cls, text: part });
    });
  }
  if (lines.length > 1 && lines[lines.length - 1]!.length === 0) lines.pop();
  return lines;
}

export function CodeHighlight({ code, filename }: { code: string; filename: string }): ReactNode {
  const lang = detectLang(filename);
  const tooBig = code.length > HIGHLIGHT_MAX_CHARS;
  const lines = useMemo(() => (tooBig ? null : highlightLines(code, lang)), [code, lang, tooBig]);
  const dataLang = lang ?? 'text';

  if (!lines) {
    return (
      <pre className="k-fb-pre k-fb-code is-plain" data-lang={dataLang} data-testid="fb-code">
        {code}
      </pre>
    );
  }

  const gutter = { '--hl-gutter': `${Math.max(2, String(lines.length).length)}ch` } as CSSProperties;
  return (
    <pre className="k-fb-pre k-fb-code" data-lang={dataLang} data-testid="fb-code" style={gutter}>
      {lines.map((toks, i) => (
        <span className="hl-row" key={i}>
          <span className="hl-ln" data-ln={i + 1} aria-hidden="true" />
          {toks.map((t, j) =>
            t.cls ? (
              <span key={j} className={`hl-${t.cls}`}>
                {t.text}
              </span>
            ) : (
              t.text
            ),
          )}
        </span>
      ))}
    </pre>
  );
}

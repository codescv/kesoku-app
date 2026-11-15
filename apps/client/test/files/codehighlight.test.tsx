import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import {
  CodeHighlight,
  HIGHLIGHT_MAX_CHARS,
  detectLang,
  highlightLines,
  tokenizeCode,
  type HighlightLang,
  type TokenClass,
} from '../../src/features/files/CodeHighlight';

/** Texts of every token of a class, in order. */
function texts(code: string, lang: HighlightLang, cls: TokenClass): string[] {
  return tokenizeCode(code, lang)
    .filter((t) => t.cls === cls)
    .map((t) => t.text);
}

function renderCode(code: string, filename: string) {
  const { container } = render(<CodeHighlight code={code} filename={filename} />);
  const pre = container.querySelector('pre') as HTMLPreElement;
  const spans = (cls: string) => Array.from(pre.querySelectorAll(`.hl-${cls}`)).map((n) => n.textContent);
  return { pre, spans };
}

describe('detectLang', () => {
  it.each([
    ['config.toml', 'toml'],
    ['setup.cfg', 'toml'],
    ['php.ini', 'toml'],
    ['nginx.conf', 'toml'],
    ['package.json', 'json'],
    ['tsconfig.jsonc', 'json'],
    ['events.jsonl', 'json'],
    ['compose.yaml', 'yaml'],
    ['ci.YML', 'yaml'],
    ['main.py', 'python'],
    ['App.tsx', 'ts'],
    ['x.mjs', 'ts'],
    ['run.sh', 'sh'],
    ['.zshrc', 'sh'],
    ['.env.local', 'sh'],
    ['style.css', 'css'],
    ['index.html', 'html'],
    ['icon.svg', 'html'],
    ['q.sql', 'sql'],
    ['notes/README.md', 'markdown'],
  ])('%s → %s', (name, lang) => {
    expect(detectLang(name)).toBe(lang);
  });

  it('returns null for unknown or extension-less names', () => {
    expect(detectLang('Makefile')).toBeNull();
    expect(detectLang('a.bin')).toBeNull();
    expect(detectLang('')).toBeNull();
  });
});

describe('tokenizer', () => {
  it('toml: comments, [section]/[[array]] headers, keys, strings, numbers, dates, booleans', () => {
    const src = [
      '# top comment',
      '[server]',
      'host = "127.0.0.1" # inline',
      "path = 'C:\\tmp'",
      'port = 8080',
      'ratio = -1.5e3',
      'enabled = true',
      'since = 2024-05-01T10:00:00Z',
      'site."my.key" = 1',
      'inline = { a = 1, b = false }',
      '[[peers]]',
      'bio = """',
      'multi # not a comment',
      '"""',
    ].join('\n');
    expect(texts(src, 'toml', 'comment')).toEqual(['# top comment', '# inline']);
    expect(texts(src, 'toml', 'sec')).toEqual(['[server]', '[[peers]]']);
    expect(texts(src, 'toml', 'key')).toEqual(['host', 'path', 'port', 'ratio', 'enabled', 'since', 'site."my.key"', 'inline', 'a', 'b', 'bio']);
    expect(texts(src, 'toml', 'str')).toEqual(['"127.0.0.1"', "'C:\\tmp'", '"""\nmulti # not a comment\n"""']);
    expect(texts(src, 'toml', 'num')).toEqual(['8080', '-1.5e3', '2024-05-01T10:00:00Z', '1', '1']);
    expect(texts(src, 'toml', 'bool')).toEqual(['true', 'false']);
  });

  it('toml: a multi-line array row is not mistaken for a section header', () => {
    expect(texts('x = [\n  [1, 2],\n]', 'toml', 'sec')).toEqual([]);
  });

  it('json: keys vs string values, numbers, literals and punctuation', () => {
    const src = '{"name": "kesoku", "n": -1.25e2, "ok": true, "none": null, "list": [1, "a:b"]}';
    expect(texts(src, 'json', 'key')).toEqual(['"name"', '"n"', '"ok"', '"none"', '"list"']);
    expect(texts(src, 'json', 'str')).toEqual(['"kesoku"', '"a:b"']);
    expect(texts(src, 'json', 'num')).toEqual(['-1.25e2', '1']);
    expect(texts(src, 'json', 'bool')).toEqual(['true', 'null']);
    expect(texts(src, 'json', 'punct').join('')).toBe('{:,:,:,:,:[,]}');
  });

  it('yaml: comments, --- markers, keys (incl. list items), strings, booleans, numbers', () => {
    const src = [
      '---',
      '# settings',
      'name: Asuka Saito',
      'url: http://x.dev/a#frag',
      'age: 26',
      'version: 1.2.3',
      'active: yes',
      'nickname: "あしゅ" # quoted',
      'tags:',
      '  - id: 1',
      '    label: \'it\'\'s\'',
      'empty: ~',
      'note: not true at all',
    ].join('\n');
    expect(texts(src, 'yaml', 'sec')).toEqual(['---']);
    expect(texts(src, 'yaml', 'comment')).toEqual(['# settings', '# quoted']);
    expect(texts(src, 'yaml', 'key')).toEqual(['name', 'url', 'age', 'version', 'active', 'nickname', 'tags', 'id', 'label', 'empty', 'note']);
    expect(texts(src, 'yaml', 'str')).toEqual(['"あしゅ"', "'it''s'"]);
    expect(texts(src, 'yaml', 'num')).toEqual(['26', '1']);
    expect(texts(src, 'yaml', 'bool')).toEqual(['yes', '~']);
  });

  it('python: comments, decorators, keywords, strings (incl. triple/prefixed), numbers', () => {
    const src = [
      '# util',
      'import os',
      '@cache',
      'async def f(x=0x1F, y=1.5):',
      '    """doc',
      '    # still doc"""',
      '    return f"{x}" if x else None  # tail',
    ].join('\n');
    expect(texts(src, 'python', 'comment')).toEqual(['# util', '# tail']);
    expect(texts(src, 'python', 'sec')).toEqual(['@cache']);
    expect(texts(src, 'python', 'kw')).toEqual(expect.arrayContaining(['import', 'async', 'def', 'return', 'if', 'else']));
    expect(texts(src, 'python', 'str')).toEqual(['"""doc\n    # still doc"""', 'f"{x}"']);
    expect(texts(src, 'python', 'num')).toEqual(['0x1F', '1.5']);
    expect(texts(src, 'python', 'bool')).toEqual(['None']);
  });

  it('ts / sh / sql / css / html / markdown produce sensible tokens', () => {
    const ts = texts('// c\nexport const a = `t ${1}` /* b */ + 2n;', 'ts', 'comment');
    expect(ts).toEqual(['// c', '/* b */']);
    expect(texts('export const v1 = 3', 'ts', 'kw')).toEqual(['export', 'const']);
    expect(texts('export const v1 = 3', 'ts', 'num')).toEqual(['3']);

    expect(texts('#!/bin/bash\nNAME=x # set\necho "$NAME" ${HOME} $1', 'sh', 'comment')).toEqual(['#!/bin/bash', '# set']);
    expect(texts('NAME=x\necho $NAME ${HOME}', 'sh', 'key')).toEqual(['NAME', '$NAME', '${HOME}']);
    expect(texts('if [ -f a ]; then echo hi; fi', 'sh', 'kw')).toEqual(['if', 'then', 'fi']);

    expect(texts("SELECT id FROM t WHERE n = 'x' -- c", 'sql', 'kw')).toEqual(['SELECT', 'FROM', 'WHERE']);
    expect(texts("SELECT id FROM t WHERE n = 'x' -- c", 'sql', 'comment')).toEqual(['-- c']);

    const css = 'a:hover { color: #fff; margin: 0 -1px; }\n@media (x) {}';
    expect(texts(css, 'css', 'key')).toEqual(['color', 'margin']);
    expect(texts(css, 'css', 'num')).toEqual(['#fff', '0', '-1px']);
    expect(texts(css, 'css', 'kw')).toEqual(['@media']);

    const html = '<!-- c --><a href="/x" data-k=\'v\'>hi &amp;</a>';
    expect(texts(html, 'html', 'comment')).toEqual(['<!-- c -->']);
    expect(texts(html, 'html', 'kw')).toEqual(['<a', '>', '</a', '>']);
    expect(texts(html, 'html', 'key')).toEqual(['href', 'data-k']);
    expect(texts(html, 'html', 'str')).toEqual(['"/x"', "'v'"]);

    const md = '# Title\n\n- item `code`\n\n```py\nx = 1\n```\n> quote';
    expect(texts(md, 'markdown', 'sec')).toEqual(['# Title']);
    expect(texts(md, 'markdown', 'str')).toEqual(['`code`', '```py\nx = 1\n```']);
    expect(texts(md, 'markdown', 'comment')).toEqual(['> quote']);
  });

  it('is lossless: concatenated tokens always reproduce the source', () => {
    const samples: Array<[string, HighlightLang]> = [
      ['a = "unterminated\n[b]\nc = 1', 'toml'],
      ['{"a": [1, 2', 'json'],
      ["k: 'open\n- x", 'yaml'],
      ['s = """never closed\nx', 'python'],
      ['/* open\nconst x', 'ts'],
      ['<div class="a', 'html'],
      ['```\nunclosed', 'markdown'],
    ];
    for (const [src, lang] of samples) {
      expect(tokenizeCode(src, lang).map((t) => t.text).join('')).toBe(src);
    }
  });

  it('splits multi-line tokens into lines and ignores a single trailing newline', () => {
    const lines = highlightLines('a = """x\ny"""\n', 'toml');
    expect(lines).toHaveLength(2);
    expect(lines[0]!.at(-1)).toEqual({ cls: 'str', text: '"""x' });
    expect(lines[1]).toEqual([{ cls: 'str', text: 'y"""' }]);
    expect(highlightLines('', 'json')).toEqual([[]]);
  });
});

describe('<CodeHighlight>', () => {
  it('renders a .toml file as React spans with line numbers', () => {
    const { pre, spans } = renderCode('# c\n[tool.app]\nname = "k"\n<b>x</b> = 1\n', 'pyproject.toml');
    expect(pre.className).toContain('k-fb-pre');
    expect(pre.className).toContain('k-fb-code');
    expect(pre.dataset.lang).toBe('toml');
    expect(pre.querySelectorAll('.hl-ln')).toHaveLength(4);
    expect(pre.querySelector('.hl-ln')!.getAttribute('data-ln')).toBe('1');
    expect(spans('comment')).toEqual(['# c']);
    expect(spans('sec')).toEqual(['[tool.app]']);
    expect(spans('key')).toEqual(['name']);
    expect(spans('str')).toEqual(['"k"']);
    // markup in the file is shown as text, never parsed as HTML
    expect(pre.querySelector('b')).toBeNull();
    expect(pre.textContent).toContain('<b>x</b>');
  });

  it.each([
    ['data.json', '{"k": "v"}', ['key', 'str']],
    ['ci.yaml', '# c\nk: "v"', ['comment', 'key', 'str']],
    ['main.py', '# c\nx = "v"', ['comment', 'str']],
  ])('highlights %s', (filename, code, classes) => {
    const { spans } = renderCode(code, filename);
    for (const cls of classes) expect(spans(cls).length).toBeGreaterThan(0);
  });

  it('unknown extensions render plain text with line numbers', () => {
    const { pre } = renderCode('hello\nworld', 'notes.txt');
    expect(pre.dataset.lang).toBe('text');
    expect(pre.querySelectorAll('.hl-ln')).toHaveLength(2);
    expect(pre.querySelector('[class^="hl-"]:not(.hl-row):not(.hl-ln)')).toBeNull();
  });

  it('falls back to a plain <pre> for very large files', () => {
    const big = 'k = 1\n'.repeat(Math.ceil(HIGHLIGHT_MAX_CHARS / 6) + 10);
    const { pre } = renderCode(big, 'huge.toml');
    expect(pre.classList.contains('is-plain')).toBe(true);
    expect(pre.querySelector('.hl-key')).toBeNull();
    expect(pre.querySelector('.hl-ln')).toBeNull();
    expect(pre.textContent).toBe(big);
  });
});

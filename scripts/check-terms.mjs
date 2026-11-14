#!/usr/bin/env node
// Vendor-neutral vocabulary guard: fails if tracked source files contain internal-infrastructure terms.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
// Terms are assembled from fragments so this file itself does not match.
const TERMS = [['cloud', 'top'], ['goo', 'gle3'], ['bla', 'ze'], ['dog', 'foody'], ['bo', 'rg', 'cfg'], ['pi', 'per'], ['crit', 'ique'], ['go', '/'], ['mo', 'ma'], ['bu', 'ganizer']].map((p) => p.join(''));
const re = new RegExp(`\\b(${TERMS.map((t) => t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})`, 'i');

let files;
try {
  files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
} catch {
  console.error('git not available');
  process.exit(1);
}
const hits = [];
for (const f of files) {
  if (/\.(png|jpg|jpeg|webp|ico|jar|jks|keystore|apk|ttf|woff2?)$/i.test(f) || f.includes('pnpm-lock.yaml')) continue;
  let text;
  try {
    text = readFileSync(join(root, f), 'utf8');
  } catch {
    continue;
  }
  text.split('\n').forEach((line, i) => {
    if (re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
  });
}
if (hits.length) {
  console.error(`✗ ${hits.length} forbidden term(s):\n` + hits.join('\n'));
  process.exit(1);
}
console.log(`✓ vocabulary clean (${files.length} files)`);

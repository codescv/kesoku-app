#!/usr/bin/env node
// Vendor-neutral vocabulary guard: fails if tracked source files contain internal-infrastructure terms.
// Server-leak guard: fails if the repo OR any compiled client bundle (apps/client/dist, native web
// assets) contains a real deployment identifier (project id/number, Cloud Run instance hostname).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
// Terms are assembled from fragments so this file itself does not match.
const TERMS = [['cloud', 'top'], ['goo', 'gle3'], ['bla', 'ze'], ['dog', 'foody'], ['bo', 'rg', 'cfg'], ['pi', 'per'], ['crit', 'ique'], ['go', '/'], ['mo', 'ma'], ['bu', 'ganizer']].map((p) => p.join(''));
const re = new RegExp(`\\b(${TERMS.map(esc).join('|')})`, 'i');

// Deployment identifiers that must never be baked into source or bundles (no word boundaries:
// minified bundles glue tokens together).
const LEAKS = [['3045', '6091', '2778'], ['chii-', 'deep', 'learning'], ['zjdt', 'hbtyoa']].map((p) => p.join(''));
const leakRe = new RegExp(
  [
    ...LEAKS.map(esc),
    // Any concrete Cloud Run hostname (templated forms such as `${REGION}.run.app` do not match).
    `[a-z0-9][a-z0-9-]*\\.(?:a\\.)?${['run', 'app'].join('\\.')}\\b`,
    // A relay service hostname/URL (the `kesoku-relay-engine-token` secret *name* is allowed).
    `kesoku-relay-(?!engine-token\\b)[a-z0-9]+-[a-z0-9-]+\\.`,
  ].join('|'),
  'i',
);

let files;
try {
  files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
} catch {
  console.error('git not available');
  process.exit(1);
}

const BINARY = /\.(png|jpg|jpeg|webp|ico|jar|jks|keystore|apk|aab|ipa|ttf|woff2?|gz|br|zip)$/i;
const hits = [];
const leaks = [];

function scanText(label, text, vocab) {
  text.split('\n').forEach((line, i) => {
    if (vocab && re.test(line)) hits.push(`${label}:${i + 1}: ${line.trim().slice(0, 120)}`);
    const m = leakRe.exec(line);
    if (m) leaks.push(`${label}:${i + 1}: …${line.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).trim()}…`);
  });
}

for (const f of files) {
  if (BINARY.test(f) || f.includes('pnpm-lock.yaml')) continue;
  let text;
  try {
    text = readFileSync(join(root, f), 'utf8');
  } catch {
    continue;
  }
  scanText(f, text, true);
}

// Compiled output is git-ignored, so walk it explicitly when present.
const BUILD_DIRS = ['apps/client/dist', 'apps/relay/dist', 'apps/client/android/app/src/main/assets/public', 'apps/client/ios/App/App/public'];
let built = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (st.isFile() && !BINARY.test(name) && st.size < 20 * 1024 * 1024) {
      built += 1;
      scanText(relative(root, p), readFileSync(p, 'utf8'), false);
    }
  }
}
for (const d of BUILD_DIRS) if (existsSync(join(root, d))) walk(join(root, d));

if (hits.length) console.error(`✗ ${hits.length} forbidden term(s):\n` + hits.join('\n'));
if (leaks.length) console.error(`✗ ${leaks.length} server URL / project identifier leak(s):\n` + leaks.join('\n'));
if (hits.length || leaks.length) process.exit(1);
console.log(`✓ vocabulary clean, no server identifiers (${files.length} files, ${built} built files)`);

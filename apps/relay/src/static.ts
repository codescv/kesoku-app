import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Context } from 'hono';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const NO_CACHE_FILES = new Set(['index.html', 'sw.js', 'manifest.webmanifest', 'manifest.json', 'registerSW.js']);

function cacheControl(rel: string): string {
  const base = path.posix.basename(rel);
  if (NO_CACHE_FILES.has(base) || rel.endsWith('.html') || /^workbox-.*\.js$/.test(base)) return 'no-cache';
  if (rel.startsWith('assets/')) return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
}

/**
 * Static PWA host with SPA fallback: unknown extension-less routes (`/mode/*`, `/s/<id>` …) get index.html;
 * missing files with an extension are 404. Paths are jailed inside `root` (realpath).
 */
export function staticHandler(rootDir: string | undefined) {
  let realRoot: Promise<string | null> | null = null;
  const getRoot = () => {
    realRoot ??= rootDir ? fsp.realpath(rootDir).catch(() => null) : Promise.resolve(null);
    return realRoot;
  };

  async function fileIn(root: string, rel: string): Promise<{ file: string; size: number; mtimeMs: number } | null> {
    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) return null;
    try {
      const real = await fsp.realpath(target);
      if (!real.startsWith(root + path.sep)) return null;
      const st = await fsp.stat(real);
      if (!st.isFile()) return null;
      return { file: real, size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return null;
    }
  }

  async function serve(c: Context, root: string, rel: string, f: { file: string; size: number; mtimeMs: number }): Promise<Response> {
    const etag = `W/"${f.size.toString(16)}-${Math.floor(f.mtimeMs).toString(16)}"`;
    const headers: Record<string, string> = {
      'Content-Type': MIME[path.extname(f.file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': cacheControl(path.relative(root, f.file).split(path.sep).join('/') || rel),
      ETag: etag,
    };
    if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers });
    const body = c.req.method === 'HEAD' ? null : await fsp.readFile(f.file);
    headers['Content-Length'] = String(f.size);
    return new Response(body, { status: 200, headers });
  }

  return async (c: Context): Promise<Response> => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.text('Method Not Allowed', 405);
    const root = await getRoot();
    if (!root) return c.text('Not Found', 404);
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.text('Bad Request', 400);
    }
    if (pathname.includes('\0')) return c.text('Bad Request', 400);
    let rel = pathname.replace(/^\/+/, '');
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const f = await fileIn(root, rel);
    if (f) return serve(c, root, rel, f);
    // SPA fallback for route-like paths only.
    const last = rel.split('/').pop() ?? '';
    if (!path.extname(last) || last.endsWith('.html')) {
      const idx = await fileIn(root, 'index.html');
      if (idx) return serve(c, root, 'index.html', idx);
    }
    return c.text('Not Found', 404);
  };
}

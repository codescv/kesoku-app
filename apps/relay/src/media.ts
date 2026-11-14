import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Context } from 'hono';

export interface SignedUrl {
  url: string;
  /** Unix seconds. */
  expires_at: number;
  /** Headers the uploader MUST send with the PUT. */
  headers?: Record<string, string>;
}

export interface MediaBackend {
  readonly kind: 'gcs' | 'local';
  signPut(object: string, mime: string, maxBytes: number): Promise<SignedUrl>;
  signGet(object: string): Promise<SignedUrl>;
  /** Direct write (engine binary `media.put` frames). */
  put(object: string, data: Buffer, mime: string): Promise<void>;
}

export interface MediaTtl {
  putTtlS: number;
  getTtlS: number;
}

// ───────────────────────────── object naming ─────────────────────────────

/** Any relay-issued object: `media/<sid|asset|avatar>/<uuid>[-cand<i>].<ext>`. */
export const OBJECT_RE = /^media\/[A-Za-z0-9_-]{1,64}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-cand[0-3])?\.[a-z0-9]{1,5}$/;
const SID_SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MIME_RE = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/;

export const AVATAR_SOURCE_MIMES: Readonly<Record<string, string>> = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
});

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'weba',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'application/pdf': 'pdf',
  'application/json': 'json',
  'application/zip': 'zip',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
};

const EXT_MIME: Record<string, string> = Object.fromEntries(Object.entries(MIME_EXT).map(([m, e]) => [e, m]));

export function extFor(mime: string, filename?: string): string {
  const m = MIME_EXT[mime.toLowerCase()];
  if (m) return m;
  const fromName = filename ? path.extname(filename).slice(1).toLowerCase() : '';
  return /^[a-z0-9]{1,5}$/.test(fromName) ? fromName : 'bin';
}

export function mimeForObject(object: string): string {
  return EXT_MIME[path.extname(object).slice(1)] ?? 'application/octet-stream';
}

export type Purpose = 'message' | 'asset' | 'avatar_source' | 'avatar_candidate';

export class MediaError extends Error {
  constructor(
    readonly code: 'BAD_REQUEST' | 'AVATAR_SOURCE_INVALID' | 'INTERNAL',
    message: string,
  ) {
    super(message);
  }
}

export function objectName(purpose: Purpose, opts: { session_id?: string; mime: string; filename?: string; index?: number }): string {
  const uuid = randomUUID();
  switch (purpose) {
    case 'message': {
      if (!opts.session_id || !SID_SEGMENT_RE.test(opts.session_id)) throw new MediaError('BAD_REQUEST', 'session_id required');
      return `media/${opts.session_id}/${uuid}.${extFor(opts.mime, opts.filename)}`;
    }
    case 'asset':
      return `media/asset/${uuid}.${extFor(opts.mime, opts.filename)}`;
    case 'avatar_source': {
      const ext = AVATAR_SOURCE_MIMES[opts.mime.toLowerCase()];
      if (!ext) throw new MediaError('AVATAR_SOURCE_INVALID', 'avatar source must be image/jpeg|png|webp|heic');
      return `media/avatar/${uuid}.${ext}`;
    }
    case 'avatar_candidate': {
      const i = opts.index ?? 0;
      if (!Number.isInteger(i) || i < 0 || i > 3) throw new MediaError('BAD_REQUEST', 'index must be 0..3');
      return `media/avatar/${uuid}-cand${i}.webp`;
    }
  }
}

// ───────────────────────────── service (limits + ownership) ─────────────────────────────

export interface MediaLimits {
  messageMaxBytes: number;
  avatarSourceMaxBytes: number;
  mediaPutMaxBytes: number;
}

interface Issued {
  device_id: string;
  issued_at: number;
}

export class MediaService {
  private readonly issued = new Map<string, Issued>();

  constructor(
    readonly backend: MediaBackend,
    private readonly limits: MediaLimits,
    private readonly maxIssued = 10_000,
  ) {}

  private maxFor(purpose: Purpose): number {
    return purpose === 'avatar_source' || purpose === 'avatar_candidate' ? this.limits.avatarSourceMaxBytes : this.limits.messageMaxBytes;
  }

  private checkCommon(mime: unknown, bytes: unknown, max: number): string {
    if (typeof mime !== 'string' || !MIME_RE.test(mime.toLowerCase())) throw new MediaError('BAD_REQUEST', 'invalid mime');
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes <= 0) throw new MediaError('BAD_REQUEST', 'invalid bytes');
    if (bytes > max) throw new MediaError('BAD_REQUEST', `file too large (max ${max} bytes)`);
    return mime.toLowerCase();
  }

  /** Client `media.ticket` (purpose message | avatar_source). */
  async clientTicket(
    deviceId: string,
    p: { purpose?: unknown; session_id?: unknown; mime?: unknown; bytes?: unknown; filename?: unknown },
  ): Promise<{ object: string; put_url: string; expires_at: number; max_bytes: number; headers?: Record<string, string> }> {
    const purpose = p.purpose === 'avatar_source' ? 'avatar_source' : p.purpose === 'message' ? 'message' : null;
    if (!purpose) throw new MediaError('BAD_REQUEST', 'purpose must be message|avatar_source');
    const max = this.maxFor(purpose);
    if (purpose === 'avatar_source') {
      if (typeof p.mime !== 'string' || !AVATAR_SOURCE_MIMES[p.mime.toLowerCase()]) {
        throw new MediaError('AVATAR_SOURCE_INVALID', 'avatar source must be image/jpeg|png|webp|heic');
      }
      if (typeof p.bytes === 'number' && p.bytes > max) throw new MediaError('AVATAR_SOURCE_INVALID', `avatar source too large (max ${max} bytes)`);
    }
    const mime = this.checkCommon(p.mime, p.bytes, max);
    const object = objectName(purpose, {
      session_id: typeof p.session_id === 'string' ? p.session_id : undefined,
      mime,
      filename: typeof p.filename === 'string' ? p.filename : undefined,
    });
    const put = await this.backend.signPut(object, mime, max);
    this.remember(object, deviceId);
    return { object, put_url: put.url, expires_at: put.expires_at, max_bytes: max, ...(put.headers ? { headers: put.headers } : {}) };
  }

  /** Engine `media.upload.ticket` (purpose message | asset | avatar_candidate). */
  async engineTicket(p: { purpose?: unknown; session_id?: unknown; mime?: unknown; bytes?: unknown; filename?: unknown; index?: unknown }) {
    const purpose: Purpose | null =
      p.purpose === undefined || p.purpose === 'message' ? 'message' : p.purpose === 'asset' ? 'asset' : p.purpose === 'avatar_candidate' ? 'avatar_candidate' : null;
    if (!purpose) throw new MediaError('BAD_REQUEST', 'purpose must be message|asset|avatar_candidate');
    const max = this.maxFor(purpose);
    const mime = this.checkCommon(p.mime, p.bytes, max);
    const object = objectName(purpose, {
      session_id: typeof p.session_id === 'string' ? p.session_id : undefined,
      mime,
      filename: typeof p.filename === 'string' ? p.filename : undefined,
      index: typeof p.index === 'number' ? p.index : undefined,
    });
    const [put, get] = await Promise.all([this.backend.signPut(object, mime, max), this.backend.signGet(object)]);
    return {
      object,
      put_url: put.url,
      expires_at: put.expires_at,
      max_bytes: max,
      get_url: get.url,
      get_expires_at: get.expires_at,
      ...(put.headers ? { headers: put.headers } : {}),
    };
  }

  /** Engine binary `media.put`. */
  async enginePut(h: { purpose?: string; session_id?: string; mime: string; filename?: string; index?: number }, data: Buffer) {
    if (data.length > this.limits.mediaPutMaxBytes) throw new MediaError('BAD_REQUEST', 'media.put too large');
    const purpose: Purpose = h.purpose === 'asset' ? 'asset' : h.purpose === 'avatar_candidate' ? 'avatar_candidate' : 'message';
    const mime = this.checkCommon(h.mime, Math.max(1, data.length), this.maxFor(purpose));
    const object = objectName(purpose, { session_id: h.session_id, mime, filename: h.filename, index: h.index });
    await this.backend.put(object, data, mime);
    const get = await this.backend.signGet(object);
    return { object, url: get.url, expires_at: get.expires_at, mime, bytes: data.length };
  }

  /** Signed GET for an existing object (`media.refresh`, `media.sign`, `media.ready` fill-in). */
  async sign(object: unknown): Promise<{ object: string; url: string; expires_at: number; issued_device_id?: string; issued_at?: number }> {
    if (typeof object !== 'string' || !OBJECT_RE.test(object)) throw new MediaError('BAD_REQUEST', 'invalid object');
    const get = await this.backend.signGet(object);
    const iss = this.issued.get(object);
    return { object, url: get.url, expires_at: get.expires_at, ...(iss ? { issued_device_id: iss.device_id, issued_at: iss.issued_at } : {}) };
  }

  private remember(object: string, deviceId: string): void {
    if (this.issued.size >= this.maxIssued) {
      const oldest = this.issued.keys().next().value;
      if (oldest !== undefined) this.issued.delete(oldest);
    }
    this.issued.set(object, { device_id: deviceId, issued_at: Date.now() / 1000 });
  }
}

// ───────────────────────────── GCS backend ─────────────────────────────

interface GcsFileLike {
  getSignedUrl(cfg: Record<string, unknown>): Promise<[string]>;
  save(data: Buffer, opts: Record<string, unknown>): Promise<void>;
}
interface GcsBucketLike {
  file(name: string): GcsFileLike;
}

/** V4 signed URLs via @google-cloud/storage (lazily imported). */
export class GcsMedia implements MediaBackend {
  readonly kind = 'gcs' as const;
  private bucketPromise: Promise<GcsBucketLike> | null = null;

  constructor(
    private readonly bucketName: string,
    private readonly ttl: MediaTtl,
    bucket?: GcsBucketLike,
  ) {
    if (bucket) this.bucketPromise = Promise.resolve(bucket);
  }

  private bucket(): Promise<GcsBucketLike> {
    this.bucketPromise ??= import('@google-cloud/storage').then((m) => new m.Storage().bucket(this.bucketName) as unknown as GcsBucketLike);
    this.bucketPromise.catch(() => {
      this.bucketPromise = null;
    });
    return this.bucketPromise;
  }

  async signPut(object: string, mime: string, maxBytes: number): Promise<SignedUrl> {
    const expiresMs = Date.now() + this.ttl.putTtlS * 1000;
    const range = `0,${maxBytes}`;
    const [url] = await (await this.bucket()).file(object).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: expiresMs,
      contentType: mime,
      extensionHeaders: { 'x-goog-content-length-range': range },
    });
    return { url, expires_at: Math.floor(expiresMs / 1000), headers: { 'Content-Type': mime, 'x-goog-content-length-range': range } };
  }

  async signGet(object: string): Promise<SignedUrl> {
    const expiresMs = Date.now() + this.ttl.getTtlS * 1000;
    const [url] = await (await this.bucket()).file(object).getSignedUrl({ version: 'v4', action: 'read', expires: expiresMs });
    return { url, expires_at: Math.floor(expiresMs / 1000) };
  }

  async put(object: string, data: Buffer, mime: string): Promise<void> {
    await (await this.bucket()).file(object).save(data, { contentType: mime, resumable: false });
  }
}

// ───────────────────────────── local disk backend (offline E2E) ─────────────────────────────

/**
 * Stores objects under LOCAL_MEDIA_DIR and serves them from `/local-media/<object>?exp=&max=&sig=`
 * with short-lived HMAC signatures. Paths are jailed (regex + realpath).
 */
export class LocalDiskMedia implements MediaBackend {
  readonly kind = 'local' as const;
  private readonly key: Buffer;

  constructor(
    readonly dir: string,
    secret: string,
    private readonly origin: () => string,
    private readonly ttl: MediaTtl,
  ) {
    this.key = createHmac('sha256', secret).update('kesoku-local-media-v1').digest();
  }

  private sig(method: 'PUT' | 'GET', object: string, exp: number, max: number, mime: string): string {
    return createHmac('sha256', this.key).update(`${method}\n${object}\n${exp}\n${max}\n${mime}`).digest('hex');
  }

  private url(method: 'PUT' | 'GET', object: string, ttlS: number, max = 0, mime = ''): SignedUrl {
    const exp = Math.floor(Date.now() / 1000) + ttlS;
    const q = new URLSearchParams({ exp: String(exp) });
    if (method === 'PUT') {
      q.set('max', String(max));
      q.set('mime', mime);
    }
    q.set('sig', this.sig(method, object, exp, max, mime));
    return { url: `${this.origin()}/local-media/${object}?${q.toString()}`, expires_at: exp };
  }

  async signPut(object: string, mime: string, maxBytes: number): Promise<SignedUrl> {
    return { ...this.url('PUT', object, this.ttl.putTtlS, maxBytes, mime), headers: { 'Content-Type': mime } };
  }

  async signGet(object: string): Promise<SignedUrl> {
    return this.url('GET', object, this.ttl.getTtlS);
  }

  verify(method: 'PUT' | 'GET', object: string, q: URLSearchParams): { ok: true; max: number; mime: string } | { ok: false } {
    const exp = Number(q.get('exp'));
    const sig = q.get('sig') ?? '';
    const max = method === 'PUT' ? Number(q.get('max')) : 0;
    const mime = method === 'PUT' ? (q.get('mime') ?? '') : '';
    if (!Number.isInteger(exp) || exp < Math.floor(Date.now() / 1000)) return { ok: false };
    if (method === 'PUT' && (!Number.isInteger(max) || max <= 0)) return { ok: false };
    if (!/^[0-9a-f]{64}$/.test(sig)) return { ok: false };
    const expected = Buffer.from(this.sig(method, object, exp, max, mime), 'hex');
    if (!timingSafeEqual(Buffer.from(sig, 'hex'), expected)) return { ok: false };
    return { ok: true, max, mime };
  }

  /** Absolute path inside the jail, or null. */
  async resolve(object: string, forWrite: boolean): Promise<string | null> {
    if (!OBJECT_RE.test(object)) return null;
    const root = await fsp.realpath(this.dir);
    const target = path.resolve(root, object);
    if (!target.startsWith(root + path.sep)) return null;
    const parent = path.dirname(target);
    if (forWrite) await fsp.mkdir(parent, { recursive: true });
    let realParent: string;
    try {
      realParent = await fsp.realpath(parent);
    } catch {
      return null;
    }
    if (realParent !== root && !realParent.startsWith(root + path.sep)) return null;
    if (!forWrite) {
      try {
        const real = await fsp.realpath(target);
        if (!real.startsWith(root + path.sep)) return null;
        return real;
      } catch {
        return null;
      }
    }
    return path.join(realParent, path.basename(target));
  }

  async put(object: string, data: Buffer, mime: string): Promise<void> {
    const file = await this.resolve(object, true);
    if (!file) throw new MediaError('BAD_REQUEST', 'invalid object');
    await writeAtomic(file, data);
    await fsp.writeFile(`${file}.mime`, mime);
  }
}

async function writeAtomic(file: string, data: Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

function objectFromPath(pathname: string): string | null {
  const prefix = '/local-media/';
  if (!pathname.startsWith(prefix)) return null;
  let raw: string;
  try {
    raw = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return null;
  }
  if (raw.includes('\0') || raw.includes('\\') || raw.split('/').some((s) => s === '..' || s === '.')) return null;
  return OBJECT_RE.test(raw) ? raw : null;
}

/** Hono handler for `PUT|GET|HEAD /local-media/*`. */
export function localMediaHandler(media: LocalDiskMedia) {
  return async (c: Context): Promise<Response> => {
    const url = new URL(c.req.url);
    // Use the raw (undecoded) path so encoded traversal is caught.
    const rawPath = c.req.raw.url.replace(/^[a-z]+:\/\/[^/]+/i, '').split('?')[0];
    const object = objectFromPath(rawPath);
    if (!object) return c.json({ error: 'BAD_OBJECT' }, 400);
    const method = c.req.method === 'PUT' ? 'PUT' : 'GET';
    if (c.req.method !== 'PUT' && c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.json({ error: 'METHOD' }, 405);
    const v = media.verify(method, object, url.searchParams);
    if (!v.ok) return c.json({ error: 'FORBIDDEN' }, 403);
    const file = await media.resolve(object, method === 'PUT');
    if (!file) return c.json({ error: method === 'PUT' ? 'BAD_OBJECT' : 'NOT_FOUND' }, method === 'PUT' ? 400 : 404);

    if (method === 'PUT') {
      const declared = Number(c.req.header('content-length') ?? NaN);
      if (Number.isFinite(declared) && declared > v.max) return c.json({ error: 'TOO_LARGE' }, 413);
      const body = c.req.raw.body;
      const chunks: Buffer[] = [];
      let total = 0;
      if (body) {
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > v.max) {
            await reader.cancel().catch(() => undefined);
            return c.json({ error: 'TOO_LARGE' }, 413);
          }
          chunks.push(Buffer.from(value));
        }
      }
      await writeAtomic(file, Buffer.concat(chunks));
      await fsp.writeFile(`${file}.mime`, v.mime || c.req.header('content-type') || mimeForObject(object));
      return c.body(null, 200);
    }

    let mime = mimeForObject(object);
    try {
      mime = (await fsp.readFile(`${file}.mime`, 'utf8')).trim() || mime;
    } catch {
      /* no sidecar */
    }
    if (!MIME_RE.test(mime)) mime = 'application/octet-stream';
    const data = await fsp.readFile(file);
    return new Response(c.req.method === 'HEAD' ? null : data, {
      status: 200,
      headers: { 'Content-Type': mime, 'Content-Length': String(data.length), 'Cache-Control': 'private, max-age=900' },
    });
  };
}

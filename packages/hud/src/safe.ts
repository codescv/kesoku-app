/**
 * Defensive readers for `$STAGING_DIR/game/*.json` state files. State files are written by the
 * mode packages and evolve independently of the client, so every accessor tolerates missing,
 * malformed or unexpected values and returns `undefined` / empty instead of throwing.
 */

export type Obj = Record<string, unknown>;

export function obj(v: unknown): Obj | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined;
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function str(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t ? t : undefined;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

export function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** A label from a string or an object carrying one of the usual label keys. */
export function label(v: unknown): string | undefined {
  const s = str(v);
  if (s) return s;
  const o = obj(v);
  if (!o) return undefined;
  return str(o.label) ?? str(o.name) ?? str(o.text) ?? str(o.zh) ?? str(o.title) ?? str(o.id);
}

export function labels(v: unknown): string[] {
  return arr(v)
    .map(label)
    .filter((x): x is string => !!x);
}

/** Entries of a `{key: {...}}` map or a `[{name, ...}]` list as `[name, record]` pairs. */
export function entries(v: unknown): Array<[string, Obj]> {
  const out: Array<[string, Obj]> = [];
  if (Array.isArray(v)) {
    v.forEach((item, i) => {
      const o = obj(item);
      if (o) out.push([str(o.name) ?? str(o.id) ?? String(i + 1), o]);
    });
    return out;
  }
  const o = obj(v);
  if (!o) return out;
  for (const [k, item] of Object.entries(o)) {
    const rec = obj(item);
    if (rec) out.push([k, rec]);
  }
  return out;
}

export function file(stateFiles: Record<string, unknown> | null | undefined, name: string): Obj | undefined {
  if (!stateFiles || typeof stateFiles !== 'object') return undefined;
  return obj((stateFiles as Obj)[name]);
}

import type { CardProps } from '../types';
import { CardShell } from '../parts';
import { isObj, obj, pick, type Dict } from '../util';

const SKIP = new Set(['kind', 'title', 'name', 'glossary', 'media', 'type']);

function brief(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map((x) => (isObj(x) ? pick(x, 'label', 'name', 'title', 'zh', 'text') || '…' : brief(x))).filter(Boolean).join('、');
  if (isObj(v)) {
    const p = pick(v, 'zh', 'label', 'name', 'title', 'text');
    if (p) return p;
    return Object.entries(v)
      .slice(0, 4)
      .map(([k, x]) => `${k}: ${typeof x === 'object' ? '…' : String(x)}`)
      .join(' · ');
  }
  return '';
}

/** Fallback for unknown kinds: title + compact key/value bullets (plain text only). */
export function GenericCard({ data }: CardProps<Dict>) {
  const d = obj(data);
  const nameField = d.name;
  const title = pick(d, 'title') || (isObj(nameField) ? pick(nameField, 'zh', 'en') : pick(d, 'name')) || pick(d, 'kind') || '卡片';
  const rows = Object.entries(d)
    .filter(([k]) => !SKIP.has(k))
    .map(([k, v]) => [k, brief(v)] as const)
    .filter(([, v]) => v)
    .slice(0, 12);
  return (
    <CardShell kind="generic" head={<span className="kc-title">{title}</span>}>
      {rows.length > 0 && (
        <ul className="kc-kv">
          {rows.map(([k, v]) => (
            <li key={k}>
              <span className="kc-kv-k">{k}</span>
              <span className="kc-kv-v">{v.length > 240 ? v.slice(0, 240) + '…' : v}</span>
            </li>
          ))}
        </ul>
      )}
    </CardShell>
  );
}

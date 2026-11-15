import { useId, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { modeMeta } from './modes';

/**
 * Kesoku vector icon system.
 *
 * Every glyph is hand-drawn on a 24×24 grid as two layers:
 *  - `tint`: soft silhouette shapes (the accent wash in the duotone style),
 *  - `ink`:  the rounded strokes (plus a few solid accents such as dots).
 *
 * Three user-selectable renderings share the same geometry:
 *  - `duotone` 柔和双色 — 18% accent wash + 1.9px rounded stroke (default),
 *  - `line`    极简线性 — 1.75px architectural monoline,
 *  - `badge`   立体徽章 — rounded squircle badge with gradient and a high-contrast glyph.
 */

export type IconStyle = 'duotone' | 'line' | 'badge';

export const ICON_STYLE_KEY = 'kesoku.icon_style';
export const ICON_STYLE_EVENT = 'kesoku:icon-style';
export const DEFAULT_ICON_STYLE: IconStyle = 'duotone';

export interface IconStyleOption {
  value: IconStyle;
  label: string;
  desc: string;
}

export const ICON_STYLE_OPTIONS: readonly IconStyleOption[] = Object.freeze([
  { value: 'duotone', label: '柔和双色', desc: '柔和底色 · 圆润描边' },
  { value: 'line', label: '极简线性', desc: '文具感 · 细线几何' },
  { value: 'badge', label: '立体徽章', desc: '圆角徽章 · 高对比' },
]);

function isIconStyle(v: unknown): v is IconStyle {
  return v === 'duotone' || v === 'line' || v === 'badge';
}

export function getIconStyle(): IconStyle {
  try {
    const v = globalThis.localStorage?.getItem(ICON_STYLE_KEY);
    return isIconStyle(v) ? v : DEFAULT_ICON_STYLE;
  } catch {
    return DEFAULT_ICON_STYLE;
  }
}

/** Persist the icon style and re-render every icon in the app. */
export function setIconStyle(style: IconStyle): void {
  if (!isIconStyle(style)) return;
  try {
    globalThis.localStorage?.setItem(ICON_STYLE_KEY, style);
  } catch {
    /* storage unavailable: still broadcast for this session */
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(ICON_STYLE_EVENT, { detail: style }));
}

function subscribe(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === ICON_STYLE_KEY) cb();
  };
  window.addEventListener(ICON_STYLE_EVENT, cb);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(ICON_STYLE_EVENT, cb);
    window.removeEventListener('storage', onStorage);
  };
}

/** Reactive current icon style (shared across the whole app). */
export function useIconStyle(): IconStyle {
  return useSyncExternalStore(subscribe, getIconStyle, () => DEFAULT_ICON_STYLE);
}

// ───────────────────────────── geometry helpers ─────────────────────────────

interface Glyph {
  tint?: ReactNode;
  ink: ReactNode;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function starPath(cx: number, cy: number, outer: number, inner: number, points = 5): string {
  const parts: string[] = [];
  for (let i = 0; i < points * 2; i += 1) {
    const rad = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    parts.push(`${i === 0 ? 'M' : 'L'}${r2(cx + rad * Math.cos(a))} ${r2(cy + rad * Math.sin(a))}`);
  }
  return parts.join(' ') + 'Z';
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Mix two #hex colours (t = share of `b`). Falls back to `a` for non-hex inputs. */
export function mixColor(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  if (!x || !y) return a;
  const c = x.map((v, i) => Math.round(v + (y[i]! - v) * t));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

const Dot = ({ cx, cy, r = 1 }: { cx: number; cy: number; r?: number }) => <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />;

// ───────────────────────────── mode glyphs ─────────────────────────────

const SAKURA_PETAL = 'M12 12.2C9.3 10.5 8.6 7 10.2 4.3L12 5.7l1.8-1.4C15.4 7 14.7 10.5 12 12.2Z';
const THEATER_STAR = starPath(12, 14.6, 3.3, 1.45);

const MODE_GLYPHS: Record<string, Glyph> = {
  // Overlapping rounded chat bubbles (the back bubble is knocked out behind the front one).
  chat: {
    tint: (
      <>
        <path d="M6 3.5h7.5A2.5 2.5 0 0 1 16 6v4a2.5 2.5 0 0 1-2.5 2.5H8.2L5 15v-2.7A2.5 2.5 0 0 1 3.5 10V6A2.5 2.5 0 0 1 6 3.5Z" />
        <path d="M11 9.5h7.5A2.5 2.5 0 0 1 21 12v3.5a2.5 2.5 0 0 1-2.5 2.5H18v2.5L14.8 18H11a2.5 2.5 0 0 1-2.5-2.5V12A2.5 2.5 0 0 1 11 9.5Z" />
      </>
    ),
    ink: (
      <>
        <path d="M16 7.6V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v4A2.5 2.5 0 0 0 5 12.3V15l2.6-2" />
        <path d="M11 9.5h7.5A2.5 2.5 0 0 1 21 12v3.5a2.5 2.5 0 0 1-2.5 2.5H18v2.5L14.8 18H11a2.5 2.5 0 0 1-2.5-2.5V12A2.5 2.5 0 0 1 11 9.5Z" />
        <Dot cx={12.2} cy={13.8} r={0.95} />
        <Dot cx={14.75} cy={13.8} r={0.95} />
        <Dot cx={17.3} cy={13.8} r={0.95} />
      </>
    ),
  },
  // Five-petal sakura blossom with notched petal tips.
  galgame: {
    tint: (
      <>
        {[0, 1, 2, 3, 4].map((i) => (
          <path key={i} d={SAKURA_PETAL} transform={`rotate(${i * 72} 12 12)`} />
        ))}
      </>
    ),
    ink: (
      <>
        {[0, 1, 2, 3, 4].map((i) => (
          <path key={i} d={SAKURA_PETAL} transform={`rotate(${i * 72} 12 12)`} />
        ))}
        <Dot cx={12} cy={12} r={1.5} />
      </>
    ),
  },
  // Precision compass rose with a two-tone needle.
  travel_companion: {
    tint: <circle cx="12" cy="12" r="9" />,
    ink: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 4.6v1.3M19.4 12h-1.3M12 19.4v-1.3M4.6 12h1.3" />
        <g transform="rotate(40 12 12)">
          <path d="M12 5.6l2.5 6.4H9.5Z" fill="currentColor" />
          <path d="M9.5 12L12 18.4l2.5-6.4" />
        </g>
        <circle cx="12" cy="12" r="0.9" fill="currentColor" stroke="none" />
      </>
    ),
  },
  // 文 ↔ A bridge: two language tiles linked by turning arrows.
  translator: {
    tint: (
      <>
        <rect x="2.75" y="2.75" width="9.5" height="9.5" rx="2.4" />
        <rect x="11.75" y="11.75" width="9.5" height="9.5" rx="2.4" />
      </>
    ),
    ink: (
      <>
        <rect x="2.75" y="2.75" width="9.5" height="9.5" rx="2.4" />
        <path d="M7.5 4.7v1.1M5.1 6.6h4.8M8.9 6.6c-.5 1.9-1.8 3.3-3.6 4M6.1 6.6c.5 1.9 1.8 3.3 3.6 4" />
        <rect x="11.75" y="11.75" width="9.5" height="9.5" rx="2.4" />
        <path d="M14.3 19.2l2.2-5.4 2.2 5.4M15.1 17.4h2.8" />
        <path d="M14.6 4.6h2.4a2.5 2.5 0 0 1 2.5 2.5v2M17.9 7.7l1.6 1.6 1.6-1.6" />
        <path d="M9.4 19.4H7a2.5 2.5 0 0 1-2.5-2.5v-2M2.9 16.3l1.6-1.6 1.6 1.6" />
      </>
    ),
  },
  // Open textbook with a bookmark ribbon.
  jp_classroom: {
    tint: <path d="M12 6.8C10.2 5.4 7.6 4.8 3.5 5v12.5c4.1-.2 6.7.4 8.5 1.8 1.8-1.4 4.4-2 8.5-1.8V5c-4.1-.2-6.7.4-8.5 1.8Z" />,
    ink: (
      <>
        <path d="M12 6.8C10.2 5.4 7.6 4.8 3.5 5v12.5c4.1-.2 6.7.4 8.5 1.8 1.8-1.4 4.4-2 8.5-1.8V5c-4.1-.2-6.7.4-8.5 1.8Z" />
        <path d="M12 6.8v12.5" />
        <path d="M6 9.1c1.3 0 2.5.2 3.6.6M6 12.3c1.3 0 2.5.2 3.6.6" />
        <path d="M15.6 5.5v6.1l1.6-1.2 1.6 1.2V5.2" fill="currentColor" />
      </>
    ),
  },
  // Faceted icosahedron (d20) with a highlighted front face.
  trpg: {
    tint: <path d="M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5Z" />,
    ink: (
      <>
        <path d="M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5Z" />
        <path d="M12 7.2l4.6 8H7.4Z" fill="currentColor" fillOpacity="0.3" />
        <path d="M12 2.5v4.7M3.8 7.25L12 7.2l8.2.05M3.8 7.25l3.6 7.95M20.2 7.25l-3.6 7.95M3.8 16.75l3.6-1.55M20.2 16.75l-3.6-1.55M7.4 15.2L12 21.5l4.6-6.3" />
      </>
    ),
  },
  // Capture sphere with the centre ring button.
  pokemon_assistant: {
    tint: <path d="M3 12a9 9 0 0 1 18 0Z" />,
    ink: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h6M15 12h6" />
        <circle cx="12" cy="12" r="3" />
        <Dot cx={12} cy={12} r={1.1} />
      </>
    ),
  },
  // Stage curtains with a scalloped valance and a star.
  story_theater: {
    tint: (
      <>
        <path d="M3 4h18v2.2c-1.5 1.4-3 1.4-4.5 0-1.5 1.4-3 1.4-4.5 0-1.5 1.4-3 1.4-4.5 0-1.5 1.4-3 1.4-4.5 0Z" />
        <path d="M3.5 7.4V20h4.6C6 16.9 4.9 12.9 4.8 7.9Z" />
        <path d="M20.5 7.4V20h-4.6c2.1-3.1 3.2-7.1 3.3-12.1Z" />
      </>
    ),
    ink: (
      <>
        <path d="M3 4h18M3 4v2.2c1.5 1.4 3 1.4 4.5 0 1.5 1.4 3 1.4 4.5 0 1.5 1.4 3 1.4 4.5 0 1.5 1.4 3 1.4 4.5 0V4" />
        <path d="M3.5 7.4V20h4.6C6 16.9 4.9 12.9 4.8 7.9M3.6 14.8l2.3-.7" />
        <path d="M20.5 7.4V20h-4.6c2.1-3.1 3.2-7.1 3.3-12.1M20.4 14.8l-2.3-.7" />
        <path d={THEATER_STAR} fill="currentColor" strokeWidth="1" />
      </>
    ),
  },
};

// ───────────────────────────── UI glyphs ─────────────────────────────

const FILE_BODY = 'M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8Z';
const FILE_FOLD = 'M14 3.5V8h4.5';
const FOLDER = 'M3.5 7A1.5 1.5 0 0 1 5 5.5h4.2l2 2.2H19a1.5 1.5 0 0 1 1.5 1.5v8.3A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5Z';
const SHIELD = 'M12 3l7 2.8v5.4c0 4.5-3 8.2-7 9.8-4-1.6-7-5.3-7-9.8V5.8Z';
const TRAY = 'M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3';
const SPARK4 = 'M11 4c.7 4.6 2.4 6.3 7 7-4.6.7-6.3 2.4-7 7-.7-4.6-2.4-6.3-7-7 4.6-.7 6.3-2.4 7-7Z';

const file = (extra: ReactNode): Glyph => ({
  tint: <path d={FILE_BODY} />,
  ink: (
    <>
      <path d={FILE_BODY} />
      <path d={FILE_FOLD} />
      {extra}
    </>
  ),
});

const UI_GLYPHS = {
  // navigation & shell
  menu: { ink: <path d="M4 7h16M4 12h16M4 17h10" /> },
  search: {
    tint: <circle cx="11" cy="11" r="6.5" />,
    ink: (
      <>
        <circle cx="11" cy="11" r="6.5" />
        <path d="M16 16l4.5 4.5" />
      </>
    ),
  },
  plus: { ink: <path d="M12 5v14M5 12h14" /> },
  close: { ink: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" /> },
  check: { ink: <path d="M5 12.5l4.5 4.5L19 7.5" /> },
  'chevron-right': { ink: <path d="M9.5 5.5L16 12l-6.5 6.5" /> },
  'chevron-down': { ink: <path d="M5.5 9.5L12 16l6.5-6.5" /> },
  'chevron-left': { ink: <path d="M14.5 5.5L8 12l6.5 6.5" /> },
  'arrow-left': { ink: <path d="M19 12H5M11 6l-6 6 6 6" /> },
  refresh: { ink: <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.8 4v4.6h-4.6" /> },
  external: { ink: <path d="M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" /> },
  sliders: {
    tint: (
      <>
        <circle cx="15" cy="7" r="2.2" />
        <circle cx="9" cy="17" r="2.2" />
      </>
    ),
    ink: (
      <>
        <path d="M4 7h8.8M17.2 7H20M4 17h2.8M11.2 17H20" />
        <circle cx="15" cy="7" r="2.2" />
        <circle cx="9" cy="17" r="2.2" />
      </>
    ),
  },
  spark: {
    tint: <path d={SPARK4} />,
    ink: (
      <>
        <path d={SPARK4} />
        <path d="M18.5 2.8v3.4M16.8 4.5h3.4" />
      </>
    ),
  },
  pin: {
    tint: <path d="M10 3.5v5.2L7 12.5h10l-3-3.8V3.5Z" />,
    ink: <path d="M8.5 3.5h7M10 3.5v5.2L7 12.5h10l-3-3.8V3.5M12 12.5v8" />,
  },
  palette: {
    tint: <path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.7-1.6 1.6-1.6h2a4.1 4.1 0 0 0 4.1-4.1c0-4-3.8-7.2-8.5-7.2Z" />,
    ink: (
      <>
        <path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.7-1.6 1.6-1.6h2a4.1 4.1 0 0 0 4.1-4.1c0-4-3.8-7.2-8.5-7.2Z" />
        <Dot cx={7.6} cy={11.2} />
        <Dot cx={9.6} cy={7.6} />
        <Dot cx={14} cy={7} />
        <Dot cx={17} cy={9.8} />
      </>
    ),
  },
  location: {
    tint: <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" />,
    ink: (
      <>
        <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" />
        <circle cx="12" cy="10" r="2.3" />
      </>
    ),
  },
  clock: {
    tint: <circle cx="12" cy="12" r="8.5" />,
    ink: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" />
      </>
    ),
  },
  swap: { ink: <path d="M4.5 8.5h14M15 5l3.5 3.5L15 12M19.5 15.5h-14M9 12l-3.5 3.5L9 19" /> },
  receipt: {
    tint: <path d="M6 3.5h12v17l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3-2 1.3Z" />,
    ink: <path d="M6 3.5h12v17l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3-2 1.3ZM9 8h6M9 11.5h6M9 15h3.5" />,
  },
  book: {
    tint: <path d="M6 4.5A1.5 1.5 0 0 1 7.5 3H19v15H7.5A1.5 1.5 0 0 0 6 19.5Z" />,
    ink: <path d="M6 19.5v-15A1.5 1.5 0 0 1 7.5 3H19v15H7.5A1.5 1.5 0 0 0 6 19.5 1.5 1.5 0 0 0 7.5 21H19v-3M10 7.5h5" />,
  },
  target: {
    tint: <circle cx="12" cy="12" r="8" />,
    ink: (
      <>
        <circle cx="12" cy="12" r="8" />
        <circle cx="12" cy="12" r="4" />
        <Dot cx={12} cy={12} r={1.2} />
      </>
    ),
  },
  // media & composer
  camera: {
    tint: <path d="M4.5 7.5h3l1.6-2.5h5.8l1.6 2.5h3A1.5 1.5 0 0 1 21 9v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18V9a1.5 1.5 0 0 1 1.5-1.5Z" />,
    ink: (
      <>
        <path d="M4.5 7.5h3l1.6-2.5h5.8l1.6 2.5h3A1.5 1.5 0 0 1 21 9v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18V9a1.5 1.5 0 0 1 1.5-1.5Z" />
        <circle cx="12" cy="13.2" r="3.4" />
      </>
    ),
  },
  image: {
    tint: <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />,
    ink: (
      <>
        <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
        <circle cx="9" cy="9.5" r="1.6" />
        <path d="M3.8 17l5-5 4 4 2.5-2.5 5 5" />
      </>
    ),
  },
  mic: {
    tint: <rect x="9" y="3" width="6" height="11" rx="3" />,
    ink: (
      <>
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
      </>
    ),
  },
  send: {
    tint: <path d="M20.5 3.5L3.5 10l7 3.5 3.5 7Z" />,
    ink: <path d="M20.5 3.5L3.5 10l7 3.5 3.5 7ZM20.5 3.5l-10 10" />,
  },
  play: { tint: <path d="M8 5.5v13l10.5-6.5Z" />, ink: <path d="M8 5.5v13l10.5-6.5Z" /> },
  pause: {
    tint: (
      <>
        <rect x="7" y="5.5" width="3.2" height="13" rx="1" />
        <rect x="13.8" y="5.5" width="3.2" height="13" rx="1" />
      </>
    ),
    ink: (
      <>
        <rect x="7" y="5.5" width="3.2" height="13" rx="1" />
        <rect x="13.8" y="5.5" width="3.2" height="13" rx="1" />
      </>
    ),
  },
  volume: {
    tint: <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4Z" />,
    ink: <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4ZM15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11" />,
  },
  sticker: {
    tint: <path d="M14.5 20.5H7A3.5 3.5 0 0 1 3.5 17V7A3.5 3.5 0 0 1 7 3.5h10A3.5 3.5 0 0 1 20.5 7v7.5Z" />,
    ink: (
      <>
        <path d="M14.5 20.5H7A3.5 3.5 0 0 1 3.5 17V7A3.5 3.5 0 0 1 7 3.5h10A3.5 3.5 0 0 1 20.5 7v7.5ZM14.5 20.5v-3a3 3 0 0 1 3-3h3" />
        <path d="M8.6 13.4c1.5 1.3 3.7 1.4 5.2.3" />
        <Dot cx={9} cy={9.4} r={0.95} />
        <Dot cx={15} cy={9.4} r={0.95} />
      </>
    ),
  },
  // feature domains
  brain: {
    tint: (
      <>
        <path d="M12 5a3 3 0 0 0-5.2 1.6 3.2 3.2 0 0 0-2.2 4.8 3.2 3.2 0 0 0 1.4 4.8A3 3 0 0 0 12 18.5Z" />
        <path d="M12 5a3 3 0 0 1 5.2 1.6 3.2 3.2 0 0 1 2.2 4.8 3.2 3.2 0 0 1-1.4 4.8A3 3 0 0 1 12 18.5Z" />
      </>
    ),
    ink: (
      <>
        <path d="M12 5a3 3 0 0 0-5.2 1.6 3.2 3.2 0 0 0-2.2 4.8 3.2 3.2 0 0 0 1.4 4.8A3 3 0 0 0 12 18.5" />
        <path d="M12 5a3 3 0 0 1 5.2 1.6 3.2 3.2 0 0 1 2.2 4.8 3.2 3.2 0 0 1-1.4 4.8A3 3 0 0 1 12 18.5" />
        <path d="M12 5v13.5M8.4 10c1 .2 1.9.9 2.3 1.9M15.6 10c-1 .2-1.9.9-2.3 1.9M8 14.6c.9-.3 1.9-.1 2.7.6M16 14.6c-.9-.3-1.9-.1-2.7.6" />
      </>
    ),
  },
  persona: {
    tint: (
      <>
        <circle cx="11" cy="8.5" r="3.5" />
        <path d="M4 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6Z" />
      </>
    ),
    ink: (
      <>
        <circle cx="11" cy="8.5" r="3.5" />
        <path d="M4 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6" />
        <path d="M18.8 3v3.4M17.1 4.7h3.4" />
      </>
    ),
  },
  folder: { tint: <path d={FOLDER} />, ink: <path d={FOLDER} /> },
  'folder-open': {
    tint: <path d="M3.5 17.5l2.4-6a1.5 1.5 0 0 1 1.4-1h13a1 1 0 0 1 .95 1.3L19 18a1.5 1.5 0 0 1-1.4 1H5a1.5 1.5 0 0 1-1.5-1.5Z" />,
    ink: (
      <path d="M3.5 17.5V7A1.5 1.5 0 0 1 5 5.5h4.2l2 2.2H18a1.5 1.5 0 0 1 1.5 1.5v1.3M3.5 17.5l2.4-6a1.5 1.5 0 0 1 1.4-1h13a1 1 0 0 1 .95 1.3L19 18a1.5 1.5 0 0 1-1.4 1H5a1.5 1.5 0 0 1-1.5-1.5Z" />
    ),
  },
  'folder-plus': {
    tint: <path d={FOLDER} />,
    ink: (
      <>
        <path d={FOLDER} />
        <path d="M12 10.5V16M9.25 13.25h5.5" />
      </>
    ),
  },
  file: file(null),
  'file-text': file(<path d="M8.5 8.5h3M8.5 12h7M8.5 15.5h7" />),
  'file-code': file(<path d="M10 11.5l-2 2 2 2M14 11.5l2 2-2 2" />),
  'file-image': file(
    <>
      <circle cx="10" cy="11" r="1.3" />
      <path d="M7.5 17.5l3-3 2 2 1.5-1.5 2.5 2.5" />
    </>,
  ),
  'file-audio': file(
    <>
      <path d="M10.8 16.3V11l4.2-1v5.2" />
      <circle cx="9.6" cy="16.4" r="1.2" />
      <circle cx="13.8" cy="15.3" r="1.2" />
    </>,
  ),
  'file-pdf': file(<path d="M8.4 17v-4.2h1.3a1.2 1.2 0 0 1 0 2.4H8.4M12.2 17v-4.2h.7a2.1 2.1 0 0 1 0 4.2ZM15.8 17v-4.2h1.8M15.8 15h1.4" />),
  'file-plus': file(<path d="M12 11v6M9 14h6" />),
  upload: { ink: <path d={`M12 15.5V4M7.5 8.5L12 4l4.5 4.5${TRAY}`} /> },
  download: { ink: <path d={`M12 4v11.5M7.5 11l4.5 4.5 4.5-4.5${TRAY}`} /> },
  edit: {
    tint: <path d="M15.5 5L19 8.5 9 18.5l-4.5 1 1-4.5Z" />,
    ink: <path d="M15.5 5L19 8.5 9 18.5l-4.5 1 1-4.5ZM13.5 7l3.5 3.5" />,
  },
  trash: {
    tint: <path d="M6.5 7l.8 11.6A1.5 1.5 0 0 0 8.8 20h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7Z" />,
    ink: <path d="M4.5 7h15M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M6.5 7l.8 11.6A1.5 1.5 0 0 0 8.8 20h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7M10.2 11v5M13.8 11v5" />,
  },
  save: {
    tint: <path d="M6 3.5h10l3.5 3.5v12a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5Z" />,
    ink: <path d="M6 3.5h10l3.5 3.5v12a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5ZM8 3.5v4h7v-4M7.5 20.5v-6h9v6" />,
  },
  note: {
    tint: <path d="M14.5 20.5H6.5A2.5 2.5 0 0 1 4 18V6a2.5 2.5 0 0 1 2.5-2.5h11A2.5 2.5 0 0 1 20 6v8.5Z" />,
    ink: (
      <>
        <path d="M14.5 20.5H6.5A2.5 2.5 0 0 1 4 18V6a2.5 2.5 0 0 1 2.5-2.5h11A2.5 2.5 0 0 1 20 6v8.5Z" />
        <path d="M14.5 20.5V16a1.5 1.5 0 0 1 1.5-1.5h4" />
        <path d="M8 8.5h8M8 12h6.5M8 15.5h3.5" />
      </>
    ),
  },
  copy: {
    tint: <rect x="8.5" y="7.5" width="11" height="13" rx="2" />,
    ink: (
      <>
        <rect x="8.5" y="7.5" width="11" height="13" rx="2" />
        <path d="M15.5 7.5V5.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2" />
      </>
    ),
  },
  // auth & devices
  qr: {
    tint: (
      <>
        <rect x="4" y="4" width="6" height="6" rx="1.2" />
        <rect x="14" y="4" width="6" height="6" rx="1.2" />
        <rect x="4" y="14" width="6" height="6" rx="1.2" />
      </>
    ),
    ink: (
      <>
        <rect x="4" y="4" width="6" height="6" rx="1.2" />
        <rect x="14" y="4" width="6" height="6" rx="1.2" />
        <rect x="4" y="14" width="6" height="6" rx="1.2" />
        <rect x="6.2" y="6.2" width="1.6" height="1.6" fill="currentColor" stroke="none" />
        <rect x="16.2" y="6.2" width="1.6" height="1.6" fill="currentColor" stroke="none" />
        <rect x="6.2" y="16.2" width="1.6" height="1.6" fill="currentColor" stroke="none" />
        <path d="M14 14h2.5v2.5M20 14v.2M14 19.5v.5M17.5 17.5H20V20h-2.5Z" />
      </>
    ),
  },
  globe: {
    tint: <circle cx="12" cy="12" r="8.5" />,
    ink: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M3.5 12h17M12 3.5c2.4 2.4 3.6 5.2 3.6 8.5s-1.2 6.1-3.6 8.5c-2.4-2.4-3.6-5.2-3.6-8.5s1.2-6.1 3.6-8.5Z" />
      </>
    ),
  },
  smartphone: {
    tint: <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />,
    ink: (
      <>
        <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
        <path d="M10.5 18.5h3" />
      </>
    ),
  },
  laptop: {
    tint: <rect x="4.5" y="5" width="15" height="10" rx="1.5" />,
    ink: (
      <>
        <rect x="4.5" y="5" width="15" height="10" rx="1.5" />
        <path d="M2.5 18.5h19" />
      </>
    ),
  },
  link: { ink: <path d="M10 14a4 4 0 0 0 5.66 0l3-3A4 4 0 0 0 13 5.34l-1.2 1.2M14 10a4 4 0 0 0-5.66 0l-3 3A4 4 0 0 0 11 18.66l1.2-1.2" /> },
  shield: { tint: <path d={SHIELD} />, ink: <path d={SHIELD} /> },
  // memory policy states
  'policy-full': {
    tint: <circle cx="12" cy="12" r="8.5" />,
    ink: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5c.4 2.6 1.4 3.6 4 4-2.6.4-3.6 1.4-4 4-.4-2.6-1.4-3.6-4-4 2.6-.4 3.6-1.4 4-4Z" fill="currentColor" strokeWidth="1" />
      </>
    ),
  },
  'policy-confirm': {
    tint: <path d={SHIELD} />,
    ink: (
      <>
        <path d={SHIELD} />
        <path d="M9 12l2.2 2.2 4-4.2" />
      </>
    ),
  },
  'policy-isolated': {
    tint: <path d="M3.5 12S6.5 6.5 12 6.5 20.5 12 20.5 12 17.5 17.5 12 17.5 3.5 12 3.5 12Z" />,
    ink: <path d="M3.5 12S6.5 6.5 12 6.5c1.4 0 2.7.4 3.8.9M20.5 12s-3 5.5-8.5 5.5c-1.4 0-2.6-.3-3.7-.9M10.2 13.8a2.5 2.5 0 0 1 3.6-3.6M4.5 4.5l15 15" />,
  },
} satisfies Record<string, Glyph>;

export type UiIconName = keyof typeof UI_GLYPHS;
export const UI_ICON_NAMES = Object.freeze(Object.keys(UI_GLYPHS) as UiIconName[]);
export const MODE_ICON_IDS = Object.freeze(Object.keys(MODE_GLYPHS));

// ───────────────────────────── renderer ─────────────────────────────

interface RenderOpts {
  glyph: Glyph;
  variant: IconStyle;
  size: number;
  color?: string;
  className: string;
  title?: string;
  data: Record<string, string>;
  gradId: string;
  style?: CSSProperties;
}

function a11y(title?: string) {
  return title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true as const, focusable: 'false' as const };
}

function GlyphLayers({ glyph, line, stroke, tintOpacity }: { glyph: Glyph; line: boolean; stroke: number; tintOpacity: number }) {
  return (
    <>
      {!line && glyph.tint && (
        <g fill="currentColor" stroke="none" opacity={tintOpacity}>
          {glyph.tint}
        </g>
      )}
      <g fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
        {glyph.ink}
      </g>
    </>
  );
}

function renderIcon({ glyph, variant, size, color, className, title, data, gradId, style }: RenderOpts) {
  const common = {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    className: `k-icon k-icon-${variant}${className ? ' ' + className : ''}`,
    style: color ? { color, ...style } : style,
    'data-icon-style': variant,
    ...data,
    ...a11y(title),
  };
  if (variant === 'badge' && color) {
    const top = mixColor(color, '#ffffff', 0.16);
    const bottom = mixColor(color, '#000000', 0.14);
    return (
      <svg {...common}>
        {title && <title>{title}</title>}
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={top} />
            <stop offset="1" stopColor={bottom} />
          </linearGradient>
        </defs>
        <rect className="k-icon-badge-bg" x="0.5" y="0.5" width="23" height="23" rx="7" fill={`url(#${gradId})`} />
        <path d="M7.5 1.25h9A6.25 6.25 0 0 1 22.75 7.5" fill="none" stroke="#ffffff" strokeOpacity="0.35" strokeWidth="1" strokeLinecap="round" />
        <g color="#ffffff" transform="translate(12 12) scale(0.64) translate(-12 -12)">
          <GlyphLayers glyph={glyph} line={false} stroke={2.4} tintOpacity={0.28} />
        </g>
      </svg>
    );
  }
  const line = variant === 'line';
  return (
    <svg {...common}>
      {title && <title>{title}</title>}
      <GlyphLayers glyph={glyph} line={line} stroke={line ? 1.75 : 1.9} tintOpacity={0.18} />
    </svg>
  );
}

export interface ModeIconProps {
  mode: string;
  size?: number;
  /** Force a rendering; defaults to the user's persisted icon style. */
  styleVariant?: IconStyle;
  /** Override the signature accent colour. */
  color?: string;
  className?: string;
  title?: string;
  style?: CSSProperties;
}

/** Bespoke per-mode icon in the mode's signature accent colour. */
export function ModeIcon({ mode, size = 24, styleVariant, color, className = '', title, style }: ModeIconProps) {
  const userStyle = useIconStyle();
  const gradId = 'kmi' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const variant = styleVariant ?? userStyle;
  const known = Object.prototype.hasOwnProperty.call(MODE_GLYPHS, mode);
  const meta = modeMeta(mode);
  const glyph = MODE_GLYPHS[known ? mode : 'chat']!;
  return renderIcon({
    glyph,
    variant,
    size,
    color: color ?? meta.accent,
    className: `k-mode-glyph ${className}`.trim(),
    title,
    data: { 'data-mode-icon': known ? mode : 'chat' },
    gradId,
    style,
  });
}

export interface UiIconProps {
  name: UiIconName;
  size?: number;
  /** Force a rendering; defaults to the user's persisted icon style (badge renders as duotone glyphs). */
  styleVariant?: IconStyle;
  /** Defaults to `currentColor` so icons inherit the button/text colour. */
  color?: string;
  className?: string;
  title?: string;
  style?: CSSProperties;
}

/** Monochrome interface glyph (inherits `currentColor`). */
export function UiIcon({ name, size = 18, styleVariant, color, className = '', title, style }: UiIconProps) {
  const userStyle = useIconStyle();
  const variant = styleVariant ?? userStyle;
  const glyph: Glyph = (UI_GLYPHS as Record<string, Glyph>)[name] ?? UI_GLYPHS.file;
  return renderIcon({
    glyph,
    // Toolbar glyphs never get a badge plate: badge style uses the duotone glyph.
    variant: variant === 'badge' ? 'duotone' : variant,
    size,
    color,
    className: `k-ui-icon ${className}`.trim(),
    title,
    data: { 'data-ui-icon': name },
    gradId: '',
    style,
  });
}

/** Pick a file glyph for a filename / mime. */
export function fileIconName(name: string, kind?: 'dir' | 'file', open = false): UiIconName {
  if (kind === 'dir') return open ? 'folder-open' : 'folder';
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic'].includes(ext)) return 'file-image';
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus'].includes(ext)) return 'file-audio';
  if (ext === 'pdf') return 'file-pdf';
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'json', 'yaml', 'yml', 'toml', 'sh', 'css', 'html', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'sql', 'xml'].includes(ext)) return 'file-code';
  if (['md', 'txt', 'log', 'csv', 'tsv', 'ini', 'cfg', 'conf', 'rst'].includes(ext)) return 'file-text';
  return 'file';
}

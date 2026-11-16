import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  TouchEvent as ReactTouchEvent,
} from 'react';
import type { MemoryPolicy, ModeId } from '@kesoku/protocol';
import { ModeHud, detectActiveMode, normalizeModeId } from '@kesoku/hud';
import { ModeIcon, Sheet, UiIcon, modeMeta } from '@kesoku/ui';
import { kesoku } from '../lib/client';
import { actions, useStore } from '../lib/store';
import type { InspectorPanel } from '../lib/types';
import { TopBar } from './TopBar';
import { useIsDesktop, useIsTablet } from './useMedia';
import { SessionPanel } from '../features/session/SessionPanel';
import { MessageList } from '../features/session/MessageList';
import { Composer } from '../features/session/Composer';
import { Launchpad } from '../features/session/Launchpad';
import { makeCardContext } from '../features/session/cardContext';
import { overlays, useOverlays } from '../features/session/overlays';
import { MemoryPanel } from '../features/memory/MemoryPanel';
import { NotesPanel } from '../features/notes/NotesPanel';
import { SettingsScreen } from '../features/settings/SettingsScreen';
import { LexCard } from '../features/segments/BilingualCard';
import { GalgameStage, ModePanel, PeekSheet } from '../features/modes';
import { PersonaStudio } from '../features/persona';
import { fallbackRoleId, roleFallbackName } from '../features/persona/model';
import { FileBrowser } from '../features/files/FileBrowser';
import { kvSet } from '../lib/db';
import { mergeTranslatorModePrefs, translatorSettingsPatch } from '../lib/translatorPrefs';

const EMPTY: Record<string, unknown> = {};
const CHANNEL: Record<string, string> = { discord: 'Discord', discord_asuka: 'Discord', wechat: '微信' };

function defaultInspector(mode: ModeId): InspectorPanel {
  switch (mode) {
    case 'jp_classroom':
      return { kind: 'lesson' };
    case 'trpg':
      return { kind: 'party' };
    case 'pokemon_assistant':
      return { kind: 'dex' };
    case 'story_theater':
      return { kind: 'roster' };
    case 'travel_companion':
      return { kind: 'travel' };
    default:
      return { kind: 'memory' };
  }
}

function Inspector({ panel, sessionId, modeId }: { panel: InspectorPanel; sessionId: string | null; modeId: ModeId }) {
  const stateFiles = useStore((s) => (sessionId ? s.stateFiles[sessionId] : undefined)) ?? EMPTY;
  const prefs = useStore((s) => (sessionId ? s.modePrefs[sessionId] : undefined)) ?? EMPTY;
  if (panel.kind === 'notes') return <NotesPanel embedded />;
  if (panel.kind === 'memory' || panel.kind === 'persona') return <MemoryPanel embedded />;
  if (panel.kind === 'word')
    return (
      <div className="k-inspector-word">
        <h2>词汇与语法解析</h2>
        {panel.sentence && (
          <p className="k-inspector-sentence" lang="ja">
            {panel.sentence}
          </p>
        )}
        <LexCard token={panel.token} />
        <button type="button" className="k-btn k-btn-ghost" onClick={() => actions.setUi({ inspector: null })}>
          返回记忆库
        </button>
      </div>
    );
  if (!sessionId) return <MemoryPanel embedded />;
  return <ModePanel panel={panel.kind} stateFiles={stateFiles} modePrefs={prefs} ctx={makeCardContext(sessionId, '', modeId)} />;
}

const MIN_LIGHTBOX_SCALE = 1;
const MAX_LIGHTBOX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MAX_MS = 300;
const DOUBLE_TAP_MAX_DIST = 36;
const PAN_SLOP_PX = 6;

function clampScale(v: number): number {
  return Math.min(MAX_LIGHTBOX_SCALE, Math.max(MIN_LIGHTBOX_SCALE, v));
}

export function ImageLightbox({
  image,
  onClose,
}: {
  image: { url: string; bbox?: number[] };
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<{ scale: number; tx: number; ty: number }>({ scale: 1, tx: 0, ty: 0 });
  const [animating, setAnimating] = useState(false);
  const zoomRef = useRef(zoom);
  const lastTouchTimeRef = useRef(0);
  const suppressClickUntilRef = useRef(0);
  const lastTapRef = useRef<{ time: number; x: number; y: number }>({ time: 0, x: 0, y: 0 });
  const singleTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const touchGestureRef = useRef<{
    mode: 'none' | 'single' | 'pinch';
    moved: boolean;
    hadPinch: boolean;
    startedOnControl: boolean;
    startScale: number;
    startX: number;
    startY: number;
    baseTx: number;
    baseTy: number;
    pinchDist: number;
    pinchMidX: number;
    pinchMidY: number;
    pinchScale: number;
    pinchTx: number;
    pinchTy: number;
  }>({
    mode: 'none',
    moved: false,
    hadPinch: false,
    startedOnControl: false,
    startScale: 1,
    startX: 0,
    startY: 0,
    baseTx: 0,
    baseTy: 0,
    pinchDist: 1,
    pinchMidX: 0,
    pinchMidY: 0,
    pinchScale: 1,
    pinchTx: 0,
    pinchTy: 0,
  });

  const dragRef = useRef<{
    active: boolean;
    source: 'pointer' | 'mouse' | null;
    pointerId: number | null;
    moved: boolean;
    startX: number;
    startY: number;
    baseTx: number;
    baseTy: number;
  }>({
    active: false,
    source: null,
    pointerId: null,
    moved: false,
    startX: 0,
    startY: 0,
    baseTx: 0,
    baseTy: 0,
  });

  const clearSingleTapTimer = useCallback(() => {
    if (singleTapTimerRef.current) {
      clearTimeout(singleTapTimerRef.current);
      singleTapTimerRef.current = null;
    }
  }, []);

  const applyZoom = useCallback((next: { scale: number; tx: number; ty: number }, animate: boolean) => {
    zoomRef.current = next;
    setAnimating(animate);
    setZoom(next);
  }, []);

  useEffect(() => {
    applyZoom({ scale: 1, tx: 0, ty: 0 }, false);
  }, [image.url, applyZoom]);

  useEffect(() => () => clearSingleTapTimer(), [clearSingleTapTimer]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const getViewport = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    const vw = rect && rect.width > 0 ? rect.width : typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : 400;
    const vh = rect && rect.height > 0 ? rect.height : typeof window !== 'undefined' && window.innerHeight > 0 ? window.innerHeight : 800;
    const cx = rect && rect.width > 0 ? rect.left + rect.width / 2 : vw / 2;
    const cy = rect && rect.height > 0 ? rect.top + rect.height / 2 : vh / 2;
    return { vw, vh, cx, cy };
  }, []);

  const clampPan = useCallback(
    (tx: number, ty: number, scale: number) => {
      if (scale <= 1.01) return { tx: 0, ty: 0 };
      const { vw, vh } = getViewport();
      const maxX = Math.max((vw * (scale - 1)) / 2 + 48, 120);
      const maxY = Math.max((vh * (scale - 1)) / 2 + 48, 120);
      return {
        tx: Math.min(maxX, Math.max(-maxX, tx)),
        ty: Math.min(maxY, Math.max(-maxY, ty)),
      };
    },
    [getViewport],
  );

  const zoomAtPoint = useCallback(
    (targetScale: number, clientX: number, clientY: number, animate: boolean) => {
      const nextScale = clampScale(targetScale);
      if (nextScale <= 1.01) {
        applyZoom({ scale: 1, tx: 0, ty: 0 }, animate);
        return;
      }
      const { cx, cy } = getViewport();
      const cur = zoomRef.current;
      const ox = clientX - cx;
      const oy = clientY - cy;
      const ratio = nextScale / cur.scale;
      const rawTx = ox - (ox - cur.tx) * ratio;
      const rawTy = oy - (oy - cur.ty) * ratio;
      const { tx, ty } = clampPan(rawTx, rawTy, nextScale);
      applyZoom({ scale: nextScale, tx, ty }, animate);
    },
    [applyZoom, clampPan, getViewport],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      clearSingleTapTimer();
      const cur = zoomRef.current;
      const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
      const nextScale = clampScale(cur.scale * factor);
      zoomAtPoint(nextScale, e.clientX, e.clientY, false);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [clearSingleTapTimer, zoomAtPoint]);

  const seedPinch = (t0: { clientX: number; clientY: number }, t1: { clientX: number; clientY: number }) => {
    const g = touchGestureRef.current;
    g.mode = 'pinch';
    g.hadPinch = true;
    g.moved = true;
    g.pinchDist = Math.max(1, Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY));
    g.pinchMidX = (t0.clientX + t1.clientX) / 2;
    g.pinchMidY = (t0.clientY + t1.clientY) / 2;
    g.pinchScale = zoomRef.current.scale;
    g.pinchTx = zoomRef.current.tx;
    g.pinchTy = zoomRef.current.ty;
  };

  const onTouchStart = (e: ReactTouchEvent<HTMLDivElement>) => {
    lastTouchTimeRef.current = Date.now();
    const g = touchGestureRef.current;
    const target = e.target as HTMLElement | null;
    if (target?.closest?.('button')) {
      g.startedOnControl = true;
      return;
    }
    g.startedOnControl = false;

    if (e.touches.length >= 2) {
      clearSingleTapTimer();
      seedPinch(e.touches[0]!, e.touches[1]!);
    } else if (e.touches.length === 1) {
      const t0 = e.touches[0]!;
      g.mode = 'single';
      g.moved = false;
      g.hadPinch = false;
      g.startScale = zoomRef.current.scale;
      g.startX = t0.clientX;
      g.startY = t0.clientY;
      g.baseTx = zoomRef.current.tx;
      g.baseTy = zoomRef.current.ty;
    }
  };

  const onTouchMove = (e: ReactTouchEvent<HTMLDivElement>) => {
    lastTouchTimeRef.current = Date.now();
    const g = touchGestureRef.current;
    if (g.startedOnControl) return;

    if (e.touches.length >= 2) {
      clearSingleTapTimer();
      const t0 = e.touches[0]!;
      const t1 = e.touches[1]!;
      if (g.mode !== 'pinch') {
        seedPinch(t0, t1);
        return;
      }
      g.moved = true;
      g.hadPinch = true;
      const dist = Math.max(1, Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY));
      const midX = (t0.clientX + t1.clientX) / 2;
      const midY = (t0.clientY + t1.clientY) / 2;
      const nextScale = clampScale(g.pinchScale * (dist / g.pinchDist));
      if (nextScale <= 1.01) {
        applyZoom({ scale: 1, tx: 0, ty: 0 }, false);
        return;
      }
      const { cx, cy } = getViewport();
      const ox0 = g.pinchMidX - cx;
      const oy0 = g.pinchMidY - cy;
      const ox1 = midX - cx;
      const oy1 = midY - cy;
      const ratio = nextScale / g.pinchScale;
      const rawTx = ox1 - (ox0 - g.pinchTx) * ratio;
      const rawTy = oy1 - (oy0 - g.pinchTy) * ratio;
      const { tx, ty } = clampPan(rawTx, rawTy, nextScale);
      applyZoom({ scale: nextScale, tx, ty }, false);
    } else if (e.touches.length === 1 && g.mode === 'single') {
      const t0 = e.touches[0]!;
      const dx = t0.clientX - g.startX;
      const dy = t0.clientY - g.startY;
      if (Math.hypot(dx, dy) > PAN_SLOP_PX) {
        g.moved = true;
        clearSingleTapTimer();
      }
      if (zoomRef.current.scale > 1.02) {
        const { tx, ty } = clampPan(g.baseTx + dx, g.baseTy + dy, zoomRef.current.scale);
        applyZoom({ scale: zoomRef.current.scale, tx, ty }, false);
      }
    }
  };

  const onTouchEnd = (e: ReactTouchEvent<HTMLDivElement>) => {
    const now = Date.now();
    lastTouchTimeRef.current = now;
    const g = touchGestureRef.current;
    if (g.startedOnControl) {
      if (e.touches.length === 0) g.startedOnControl = false;
      return;
    }

    if (e.touches.length >= 2) {
      seedPinch(e.touches[0]!, e.touches[1]!);
      return;
    }
    if (e.touches.length === 1) {
      const rem = e.touches[0]!;
      g.mode = 'single';
      g.hadPinch = true;
      g.moved = true;
      g.startX = rem.clientX;
      g.startY = rem.clientY;
      g.baseTx = zoomRef.current.tx;
      g.baseTy = zoomRef.current.ty;
      return;
    }

    g.mode = 'none';
    if (g.hadPinch || g.moved) {
      suppressClickUntilRef.current = now + 450;
      if (zoomRef.current.scale <= 1.02) {
        applyZoom({ scale: 1, tx: 0, ty: 0 }, true);
      }
      return;
    }

    const p = e.changedTouches[0];
    const x = p?.clientX ?? g.startX;
    const y = p?.clientY ?? g.startY;
    suppressClickUntilRef.current = now + 450;
    if (e.cancelable) e.preventDefault();

    const dt = now - lastTapRef.current.time;
    const tapDist = Math.hypot(x - lastTapRef.current.x, y - lastTapRef.current.y);
    if (lastTapRef.current.time > 0 && dt >= 0 && dt <= DOUBLE_TAP_MAX_MS && tapDist < DOUBLE_TAP_MAX_DIST) {
      clearSingleTapTimer();
      lastTapRef.current = { time: 0, x: 0, y: 0 };
      if (zoomRef.current.scale > 1.05) {
        applyZoom({ scale: 1, tx: 0, ty: 0 }, true);
      } else {
        zoomAtPoint(DOUBLE_TAP_SCALE, x, y, true);
      }
      return;
    }

    lastTapRef.current = { time: now, x, y };
    if (zoomRef.current.scale <= 1.02 && g.startScale <= 1.02) {
      clearSingleTapTimer();
      singleTapTimerRef.current = setTimeout(() => {
        singleTapTimerRef.current = null;
        if (zoomRef.current.scale <= 1.02) onClose();
      }, DOUBLE_TAP_MAX_MS);
    }
  };

  const onTouchCancel = () => {
    const g = touchGestureRef.current;
    g.mode = 'none';
    g.startedOnControl = false;
    suppressClickUntilRef.current = Date.now() + 350;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') return;
    if ((e.target as HTMLElement | null)?.closest?.('button')) return;
    if (zoomRef.current.scale <= 1.02) return;
    dragRef.current = {
      active: true,
      source: 'pointer',
      pointerId: e.pointerId,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
      baseTx: zoomRef.current.tx,
      baseTy: zoomRef.current.ty,
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d.active || d.source !== 'pointer' || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (Math.hypot(dx, dy) > PAN_SLOP_PX) d.moved = true;
    if (zoomRef.current.scale > 1.02) {
      const { tx, ty } = clampPan(d.baseTx + dx, d.baseTy + dy, zoomRef.current.scale);
      applyZoom({ scale: zoomRef.current.scale, tx, ty }, false);
    }
  };

  const onPointerUpOrCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d.active || d.source !== 'pointer' || d.pointerId !== e.pointerId) return;
    if (d.moved) suppressClickUntilRef.current = Date.now() + 350;
    dragRef.current.active = false;
    dragRef.current.source = null;
    dragRef.current.pointerId = null;
  };

  const onMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (Date.now() - lastTouchTimeRef.current < 500) return;
    if (dragRef.current.active) return;
    if ((e.target as HTMLElement | null)?.closest?.('button')) return;
    if (zoomRef.current.scale <= 1.02) return;
    dragRef.current = {
      active: true,
      source: 'mouse',
      pointerId: null,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
      baseTx: zoomRef.current.tx,
      baseTy: zoomRef.current.ty,
    };
  };

  const onMouseMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d.active || d.source !== 'mouse') return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (Math.hypot(dx, dy) > PAN_SLOP_PX) d.moved = true;
    if (zoomRef.current.scale > 1.02) {
      const { tx, ty } = clampPan(d.baseTx + dx, d.baseTy + dy, zoomRef.current.scale);
      applyZoom({ scale: zoomRef.current.scale, tx, ty }, false);
    }
  };

  const onMouseUp = () => {
    const d = dragRef.current;
    if (!d.active || d.source !== 'mouse') return;
    if (d.moved) suppressClickUntilRef.current = Date.now() + 350;
    dragRef.current.active = false;
    dragRef.current.source = null;
  };

  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement | null)?.closest?.('button')) return;
    if (Date.now() - lastTouchTimeRef.current < 500) return;
    clearSingleTapTimer();
    if (zoomRef.current.scale > 1.05) {
      applyZoom({ scale: 1, tx: 0, ty: 0 }, true);
    } else {
      zoomAtPoint(DOUBLE_TAP_SCALE, e.clientX, e.clientY, true);
    }
  };

  const onBackdropOrImageClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement | null)?.closest?.('button')) return;
    if (Date.now() < suppressClickUntilRef.current) return;
    if (zoomRef.current.scale > 1.02) return;

    if (e.target === e.currentTarget) {
      clearSingleTapTimer();
      onClose();
      return;
    }

    if (e.detail >= 2) {
      clearSingleTapTimer();
      return;
    }

    clearSingleTapTimer();
    singleTapTimerRef.current = setTimeout(() => {
      singleTapTimerRef.current = null;
      if (zoomRef.current.scale <= 1.02) onClose();
    }, 240);
  };

  const isZoomed = zoom.scale > 1.05;

  return (
    <div
      ref={containerRef}
      className="k-imgview"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      onClick={onBackdropOrImageClick}
      onDoubleClick={onDoubleClick}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUpOrCancel}
      onPointerCancel={onPointerUpOrCancel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      <button
        type="button"
        className="k-imgview-close"
        data-testid="imgview-close-btn"
        aria-label="关闭大图"
        onClick={(e) => {
          e.stopPropagation();
          clearSingleTapTimer();
          onClose();
        }}
      >
        <UiIcon name="close" size={20} />
      </button>
      {isZoomed && (
        <button
          type="button"
          className="k-imgview-reset"
          data-testid="imgview-reset-zoom"
          onClick={(e) => {
            e.stopPropagation();
            clearSingleTapTimer();
            suppressClickUntilRef.current = 0;
            applyZoom({ scale: 1, tx: 0, ty: 0 }, true);
          }}
        >
          {Math.round(zoom.scale * 100)}% · 重置
        </button>
      )}
      <div
        className={'k-imgview-frame' + (animating ? ' is-animating' : '')}
        data-testid="imgview-frame"
        data-scale={zoom.scale.toFixed(2)}
        style={{
          transform: `translate3d(${Math.round(zoom.tx * 100) / 100}px, ${Math.round(zoom.ty * 100) / 100}px, 0) scale(${Math.round(zoom.scale * 1000) / 1000})`,
        }}
      >
        <img src={image.url} alt="大图" draggable={false} />
        {image.bbox && image.bbox.length === 4 && (
          <span
            className="k-imgview-box"
            style={{
              left: `${image.bbox[0]! * 100}%`,
              top: `${image.bbox[1]! * 100}%`,
              width: `${image.bbox[2]! * 100}%`,
              height: `${image.bbox[3]! * 100}%`,
            }}
          />
        )}
      </div>
    </div>
  );
}

function Overlays({ sessionId, modeId }: { sessionId: string | null; modeId: ModeId }) {
  const { fullscreen, peek, image } = useOverlays();
  return (
    <>
      {fullscreen && (
        <div className="k-fullscreen" role="dialog" aria-modal="true">
          <button type="button" className="k-fullscreen-close" onClick={() => overlays.fullscreen(null)}>
            <UiIcon name="close" size={18} /> 返回对话
          </button>
          <div className="k-fullscreen-body">{fullscreen}</div>
        </div>
      )}
      {image && <ImageLightbox image={image} onClose={() => overlays.image(null)} />}
      {peek && sessionId && <PeekSheet entry={peek.entry} glossary={peek.glossary} ctx={makeCardContext(sessionId, '', modeId)} onClose={() => overlays.peek(null)} />}
    </>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="k-toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={'k-toast' + (t.tone === 'error' ? ' is-error' : '')}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function Shell() {
  const desktop = useIsDesktop();
  const tablet = useIsTablet();
  const sid = useStore((s) => s.currentSessionId);
  const ui = useStore((s) => s.ui);
  const conn = useStore((s) => s.conn);
  const stateFiles = useStore((s) => (sid ? s.stateFiles[sid] : undefined)) ?? EMPTY;
  const modePrefs = useStore((s) => (sid ? s.modePrefs[sid] : undefined)) ?? EMPTY;
  const settings = useStore((s) => s.settings);
  const origin = useStore((s) => (sid ? s.origin[sid] : undefined));
  const takenOver = useStore((s) => (sid ? s.takenOver[sid] : false));
  const session = useStore((s) => (sid ? s.sessions[sid] : undefined));
  const items = useStore((s) => (sid ? s.items[sid] : undefined));
  const preview = useStore((s) => (sid ? s.previews[sid] : undefined));
  const policies = useStore((s) => s.policies.policies);
  const personas = useStore((s) => s.personas);
  const [panelSheet, setPanelSheet] = useState<InspectorPanel['kind'] | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [hudCollapsed, setHudCollapsed] = useState(false);

  const foreign = !!origin && origin !== 'app' && (session?.chatbot_id ?? 'app') !== 'app';
  const active = useMemo(() => detectActiveMode(stateFiles), [stateFiles]);
  // games.json is the mode truth once loaded; until then (restored session, snapshot in flight) fall back
  // to the session's mode_id so a classroom never shows 日常聊天.
  const hasGamesFile = 'game/games.json' in stateFiles;
  const fallbackMode = normalizeModeId(session?.mode_id) ?? 'chat';
  const modeId: ModeId = foreign ? 'chat' : active.modeId !== 'chat' || hasGamesFile ? active.modeId : fallbackMode;
  const meta = modeMeta(modeId);
  const policy = (policies[modeId] ?? 'confirm_only') as MemoryPolicy;
  // Generic role naming: never hardcode a specific persona; derive from the live role list.
  const roleId = session?.role ?? ui.draftRole ?? ui.roleFilter ?? fallbackRoleId(personas);
  const rolePersona = personas.find((p) => p.role_id === roleId);
  const fullRoleName = rolePersona?.display_name || roleFallbackName(roleId);
  const roleName = fullRoleName.split(' ')[0] || fullRoleName;
  const showLaunchpad = ui.screen === 'chat' && (ui.launchpad || !sid);
  const hasTurnActivity = Boolean((items && items.length > 0) || preview);
  const galStage = modeId === 'galgame' && ui.stageView === 'stage' && !showLaunchpad && !!sid && hasTurnActivity;
  const previewTurnId = preview?.turn_id;

  // Right column follows the mode: reset any pinned panel when the mode changes.
  useEffect(() => {
    actions.setUi({ inspector: null });
  }, [modeId, sid]);

  // Expand the mobile ModeHud whenever session, mode, or a new streaming turn starts.
  useEffect(() => {
    setHudCollapsed(false);
  }, [sid, modeId, previewTurnId]);

  // Keyboard shortcuts (desktop workbench).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (!desktop) actions.setUi({ drawerOpen: true });
        window.dispatchEvent(new CustomEvent('kesoku:open-all-sessions'));
        setTimeout(() => document.getElementById('k-search')?.focus(), 50);
      } else if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        const s = useStore.getState();
        const draftRole = s.ui.roleFilter ?? (s.currentSessionId ? s.sessions[s.currentSessionId]?.role : null) ?? s.ui.draftRole ?? null;
        useStore.setState({ currentSessionId: null });
        actions.setUi({ launchpad: true, screen: 'chat', draftRole });
      } else if (e.key === 'Escape') {
        if (useStore.getState().ui.inspector?.kind === 'word') actions.setUi({ inspector: null });
        if (useStore.getState().ui.drawerOpen) actions.setUi({ drawerOpen: false });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [desktop]);

  const openPanel = (p: InspectorPanel['kind']) => {
    if (desktop) actions.setUi({ inspector: { kind: p } as InspectorPanel });
    else setPanelSheet(p);
  };

  const center = (() => {
    if (ui.screen === 'settings') return <SettingsScreen onClose={() => actions.setUi({ screen: 'chat' })} />;
    if (ui.screen === 'files') return <FileBrowser onClose={() => actions.setUi({ screen: 'chat' })} />;
    if (ui.screen === 'notes') return <NotesPanel onClose={() => actions.setUi({ screen: 'chat' })} />;
    if (ui.screen === 'memory')
      return (
        <div className="k-screen">
          <header className="k-screen-head">
            <button type="button" className="k-icon-btn" aria-label="返回" onClick={() => actions.setUi({ screen: 'chat' })}>
              <UiIcon name="arrow-left" size={22} />
            </button>
            <h1>记忆库</h1>
          </header>
          <div className="k-screen-body">
            <MemoryPanel />
          </div>
        </div>
      );
    if (ui.screen === 'studio')
      return (
        <PersonaStudio
          onClose={() => actions.setUi({ screen: 'chat' })}
          onOpenPolicies={() => {
            actions.setUi({ screen: 'settings' });
            setTimeout(() => document.getElementById('memory-policies')?.scrollIntoView({ behavior: 'smooth' }), 80);
          }}
        />
      );
    return (
      <>
        <TopBar sessionId={sid} modeId={modeId} nestedTitle={active.nested?.title} showMenu={!desktop && (!tablet || leftCollapsed)} onMenu={() => (tablet ? setLeftCollapsed(false) : actions.setUi({ drawerOpen: true }))} />
        {conn.status !== 'online' && conn.status !== 'idle' && (
          <div className="k-connbar" role="status">
            {conn.status === 'reconnecting' || conn.status === 'connecting' || conn.status === 'authenticating' ? '重连中…' : conn.status === 'suspended' ? '已暂停（回到前台自动恢复）' : '未连接'}
          </div>
        )}
        {conn.status === 'online' && !conn.engineOnline && <div className="k-connbar is-offline">引擎离线 · 消息将在引擎恢复后送达</div>}
        {foreign && (
          <div className={'k-banner' + (takenOver ? ' is-taken' : '')}>
            {takenOver ? '已由 App 接管 (普通聊天)' : `此会话来自 ${CHANNEL[origin!] ?? origin} · 发送消息将以普通聊天模式继续`}
          </div>
        )}
        {!foreign && !showLaunchpad && sid && modeId !== 'chat' && !galStage && (
          <div className={'k-hud-collapse-wrap' + (hudCollapsed ? ' is-collapsed' : '')} data-testid="mode-hud-wrap">
            <ModeHud
              modeId={modeId}
              stateFiles={stateFiles}
              modePrefs={modeId === 'translator' ? mergeTranslatorModePrefs(modePrefs, settings) : modePrefs}
              policy={policy}
              onPolicyChange={(p) => void kesoku.setPolicy(modeId, p)}
              onPrefsChange={(prefs) => {
                const patch = translatorSettingsPatch(prefs);
                if (patch) {
                  actions.setSettings(patch);
                  void kvSet('settings', useStore.getState().settings);
                }
                void kesoku.setModePrefs(sid, prefs);
              }}
              onOpenPanel={openPanel}
            />
          </div>
        )}
        <main className="k-stage" style={{ ['--mode' as string]: meta.color }}>
          {showLaunchpad ? (
            <Launchpad />
          ) : galStage ? (
            <GalgameStage
              items={items ?? []}
              preview={preview ?? null}
              stateFiles={stateFiles}
              ctx={makeCardContext(sid!, '', modeId)}
              policy={policy}
              onPolicyChange={(p: MemoryPolicy) => void kesoku.setPolicy('galgame', p)}
              onPick={(qid: string, choices: string[]) => void kesoku.pick(sid!, qid, choices)}
              onExit={() => actions.setUi({ stageView: 'bubbles' })}
              personaName={fullRoleName}
            />
          ) : (
            sid && <MessageList sessionId={sid} modeId={modeId} onScrollDirection={(dir) => setHudCollapsed(dir === 'down')} />
          )}
          {modeId === 'galgame' && !galStage && !showLaunchpad && sid && (
            <button type="button" className="k-stage-toggle" onClick={() => actions.setUi({ stageView: 'stage' })}>
              <ModeIcon mode="galgame" size={18} /> 回到 CG 舞台
            </button>
          )}
        </main>
        {!galStage && <Composer sessionId={sid} modeId={showLaunchpad ? 'chat' : modeId} roleName={roleName} />}
        {galStage && <Composer sessionId={sid} modeId={modeId} roleName={roleName} />}
      </>
    );
  })();

  const inspectorPanel = ui.inspector ?? defaultInspector(modeId);

  return (
    <div className={'k-shell' + (desktop ? ' is-desktop' : tablet ? ' is-tablet' : ' is-mobile') + (meta.dark && modeId !== 'chat' ? ' is-mode-dark' : '')} data-mode={modeId}>
      {(desktop || (tablet && !leftCollapsed)) && (
        <aside className="k-col-left">
          {tablet && !desktop && (
            <button type="button" className="k-collapse" aria-label="收起会话栏" onClick={() => setLeftCollapsed(true)}>
              <UiIcon name="chevron-left" size={18} />
            </button>
          )}
          <SessionPanel />
        </aside>
      )}
      <section className="k-col-center">{center}</section>
      {desktop && (
        <aside className="k-col-right" aria-label="上下文检视器">
          <Inspector panel={inspectorPanel} sessionId={sid} modeId={modeId} />
        </aside>
      )}
      {!desktop && !tablet && ui.drawerOpen && (
        <div className="k-drawer-root">
          <div className="k-scrim" onClick={() => actions.setUi({ drawerOpen: false })} />
          <div className="k-drawer">
            <SessionPanel onNavigate={() => actions.setUi({ drawerOpen: false })} />
          </div>
        </div>
      )}
      <Sheet
        open={!!panelSheet}
        onClose={() => setPanelSheet(null)}
        height="half"
        title={
          panelSheet === 'notes'
            ? '简易便签'
            : panelSheet === 'mistakes'
              ? '待复习错题本'
              : panelSheet === 'roster'
                ? '演员定妆表'
                : panelSheet === 'memory'
                  ? '记忆库'
                  : undefined
        }
      >
        {panelSheet && <Inspector panel={{ kind: panelSheet } as InspectorPanel} sessionId={sid} modeId={modeId} />}
      </Sheet>
      <Overlays sessionId={sid} modeId={modeId} />
      <Toasts />
    </div>
  );
}

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { UiIcon } from './icons';

type Tone = 'neutral' | 'primary' | 'accent' | 'ok' | 'warn' | 'danger' | 'mode';

export function Pill({
  children,
  tone = 'neutral',
  size = 'md',
  onClick,
  className,
  title,
  style,
  active,
  disabled,
}: {
  children: ReactNode;
  tone?: Tone;
  size?: 'sm' | 'md' | 'lg';
  onClick?: () => void;
  className?: string;
  title?: string;
  style?: CSSProperties;
  active?: boolean;
  disabled?: boolean;
}) {
  const cls = ['k-pill', `k-pill-${tone}`, `k-pill-${size}`, active ? 'is-active' : '', className].filter(Boolean).join(' ');
  if (onClick)
    return (
      <button type="button" className={cls} onClick={onClick} title={title} style={style} disabled={disabled} aria-pressed={active}>
        {children}
      </button>
    );
  return (
    <span className={cls} title={title} style={style}>
      {children}
    </span>
  );
}

export function Capsule({ children, onClick, className, label }: { children: ReactNode; onClick?: () => void; className?: string; label?: string }) {
  return (
    <button type="button" className={['k-capsule', className].filter(Boolean).join(' ')} onClick={onClick} aria-label={label} aria-haspopup="dialog">
      {children}
      <span className="k-caret" aria-hidden>
        ▾
      </span>
    </button>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
}

/** 3-segment control (e.g. memory policy [自动 | 确认 | 忽略]); each segment ≥ 44px hit area. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  color,
  size = 'md',
}: {
  options: SegmentOption<T>[];
  value: T | undefined;
  onChange: (v: T) => void;
  ariaLabel?: string;
  color?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div className={`k-seg k-seg-${size}`} role="radiogroup" aria-label={ariaLabel} style={color ? ({ '--seg-color': color } as CSSProperties) : undefined}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={'k-seg-item' + (value === o.value ? ' is-on' : '')}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const SHEET_CLOSE_CLEANUP_MS = 240;

/**
 * Keeps the sheet body's `scrollTop` within `[0, maxScroll]`. iOS WKWebView can
 * strand `scrollTop` above the real max after layout/content changes, which
 * disables both native scroll and pull-down-at-top dismissal.
 */
function clampSheetBodyScroll(bodyEl: HTMLElement | null, resetToZero = false): number {
  if (!bodyEl) return 0;
  const maxScroll = Math.max(0, bodyEl.scrollHeight - bodyEl.clientHeight);
  if (resetToZero || maxScroll <= 1) {
    if (bodyEl.scrollTop !== 0) bodyEl.scrollTop = 0;
    return 0;
  }
  if (bodyEl.scrollTop > maxScroll) {
    bodyEl.scrollTop = maxScroll;
    return maxScroll;
  }
  return bodyEl.scrollTop;
}

/** True when a nested scrollable element inside `.k-sheet-body` (e.g. textarea) is scrolled down. */
function hasScrolledInnerAncestor(target: EventTarget | null, bodyEl: HTMLElement): boolean {
  let cur = target instanceof Element ? target : null;
  while (cur && cur !== bodyEl) {
    if (cur instanceof HTMLElement && cur.scrollHeight > cur.clientHeight + 1 && cur.scrollTop > 1) {
      return true;
    }
    cur = cur.parentElement;
  }
  return false;
}

function isSheetHeaderActionTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('button, a, input, select, textarea, [role="slider"]'));
}

/**
 * Bottom sheet (mobile bottom drawer, centered panel on desktop).
 * Pull down on the grip handle, header, or body once scrolled to top (`scrollTop <= 1`)
 * to dismiss smoothly; scrim tap or Escape also closes.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  className,
  onBack,
  height = 'auto',
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  onBack?: () => void;
  height?: 'auto' | 'half' | 'full';
}) {
  const [rendered, setRendered] = useState(open);
  const [entering, setEntering] = useState(open);
  const [prevOpen, setPrevOpen] = useState(open);
  const [dragY, setDragY] = useState(0);
  const [exitDragY, setExitDragY] = useState(0);

  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setRendered(true);
      setEntering(true);
      setDragY(0);
      setExitDragY(0);
    } else {
      setEntering(false);
      setDragY(0);
    }
  }

  const isVisible = open || rendered;
  const isClosing = !open && rendered;

  const handleStartRef = useRef<{ y: number; lastY: number; t: number } | null>(null);
  const headerPullRef = useRef<{
    startX: number;
    startY: number;
    lastY: number;
    startTime: number;
    pointerId?: number;
    active: boolean;
  } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyPullRef = useRef<{
    startX: number;
    startY: number;
    lastY: number;
    anchorX: number;
    anchorY: number | null;
    anchorTime: number;
    pointerId?: number;
    active: boolean;
    fromInteractive: boolean;
    target: EventTarget | null;
  } | null>(null);
  const suppressBodyClickRef = useRef(false);
  const suppressHeaderClickRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const updateDragY = (next: number): void => {
    if (next > 0) setEntering(false);
    setDragY(next);
  };

  useEffect(() => {
    if (!open) return;
    setDragY(0);
    setExitDragY(0);
    handleStartRef.current = null;
    headerPullRef.current = null;
    bodyPullRef.current = null;
    suppressBodyClickRef.current = false;
    suppressHeaderClickRef.current = false;
  }, [open]);

  useEffect(() => {
    if (!isClosing) return;
    const timer = setTimeout(() => {
      setExitDragY(0);
      setRendered(false);
    }, SHEET_CLOSE_CLEANUP_MS);
    return () => clearTimeout(timer);
  }, [isClosing]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setExitDragY(0);
        onCloseRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const beginBodyPull = (clientX: number, clientY: number, target: EventTarget | null, pointerId?: number): void => {
    const bodyEl = bodyRef.current;
    if (!bodyEl) return;
    if (target instanceof Element && target.closest('input[type="range"], [data-sheet-no-drag]')) return;
    const fromInteractive =
      target instanceof Element && Boolean(target.closest('button, a, input, textarea, select, [role="slider"]'));
    suppressBodyClickRef.current = false;
    const startScrollTop = clampSheetBodyScroll(bodyEl);
    const innerScrolled = hasScrolledInnerAncestor(target, bodyEl);
    bodyPullRef.current = {
      startX: clientX,
      startY: clientY,
      lastY: clientY,
      anchorX: clientX,
      anchorY: startScrollTop <= 1 && !innerScrolled ? clientY : null,
      anchorTime: performance.now(),
      pointerId,
      active: false,
      fromInteractive,
      target,
    };
  };

  const moveBodyPull = (clientX: number, clientY: number, cancelEvent?: () => void): void => {
    const state = bodyPullRef.current;
    const bodyEl = bodyRef.current;
    if (!state || !bodyEl) return;
    const dy = clientY - state.startY;
    state.lastY = clientY;

    if (!state.active) {
      const currentScrollTop = clampSheetBodyScroll(bodyEl);
      if (currentScrollTop > 1 || hasScrolledInnerAncestor(state.target, bodyEl)) {
        state.anchorY = null;
        return;
      }
      if (state.anchorY === null) {
        state.anchorX = clientX;
        state.anchorY = clientY;
        state.anchorTime = performance.now();
      }
      const pullDx = clientX - state.anchorX;
      const pullDy = clientY - state.anchorY;
      const minPull = state.fromInteractive ? 8 : 6;
      if (pullDy > minPull && pullDy > Math.abs(pullDx) * 1.1 && (!state.fromInteractive || Math.abs(dy) > 8)) {
        state.active = true;
        if (state.pointerId !== undefined) {
          try {
            bodyEl.setPointerCapture?.(state.pointerId);
          } catch {
            // Ignore synthetic events without an active browser pointer.
          }
        }
      }
    }

    if (state.active && state.anchorY !== null) {
      const pullDy = clientY - state.anchorY;
      if (pullDy > 0) {
        cancelEvent?.();
        updateDragY(pullDy);
      } else {
        updateDragY(0);
        state.active = false;
        state.anchorY = null;
      }
    }
  };

  const endBodyPull = (): void => {
    const state = bodyPullRef.current;
    bodyPullRef.current = null;
    if (!state) return;
    if (state.active && state.anchorY !== null) {
      const pullDy = Math.max(0, state.lastY - state.anchorY);
      const velocity = pullDy / Math.max(1, performance.now() - state.anchorTime);
      suppressBodyClickRef.current = true;
      setTimeout(() => {
        suppressBodyClickRef.current = false;
      }, 80);
      if (pullDy >= 56 || (pullDy >= 24 && velocity > 0.5)) {
        setExitDragY(pullDy);
        setDragY(0);
        onCloseRef.current();
      } else {
        setExitDragY(0);
        setDragY(0);
      }
    }
  };

  const cancelBodyPull = (): void => {
    if (bodyPullRef.current?.active) setDragY(0);
    bodyPullRef.current = null;
  };

  useLayoutEffect(() => {
    if (!open) return;
    clampSheetBodyScroll(bodyRef.current);
  }, [open, height]);

  useEffect(() => {
    if (!open || typeof ResizeObserver !== 'function') return;
    const bodyEl = bodyRef.current;
    if (!bodyEl) return;
    const ro = new ResizeObserver(() => {
      clampSheetBodyScroll(bodyRef.current);
    });
    ro.observe(bodyEl);
    if (bodyEl.firstElementChild) ro.observe(bodyEl.firstElementChild);
    return () => ro.disconnect();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const bodyEl = bodyRef.current;
    if (!bodyEl) return;
    const onTouchStart = (e: TouchEvent): void => {
      if (e.touches.length !== 1) {
        cancelBodyPull();
        return;
      }
      const t = e.touches[0]!;
      beginBodyPull(t.clientX, t.clientY, e.target, undefined);
    };
    const onTouchMove = (e: TouchEvent): void => {
      if (e.touches.length !== 1) {
        cancelBodyPull();
        return;
      }
      const t = e.touches[0]!;
      moveBodyPull(t.clientX, t.clientY, () => {
        if (e.cancelable) e.preventDefault();
      });
    };
    const onTouchEnd = (e: TouchEvent): void => {
      if (e.touches.length > 0) return;
      if (bodyPullRef.current && e.changedTouches[0]) {
        bodyPullRef.current.lastY = e.changedTouches[0].clientY;
      }
      endBodyPull();
    };
    const onTouchCancel = (): void => {
      cancelBodyPull();
    };
    bodyEl.addEventListener('touchstart', onTouchStart, { passive: true });
    bodyEl.addEventListener('touchmove', onTouchMove, { passive: false });
    bodyEl.addEventListener('touchend', onTouchEnd);
    bodyEl.addEventListener('touchcancel', onTouchCancel);
    return () => {
      bodyEl.removeEventListener('touchstart', onTouchStart);
      bodyEl.removeEventListener('touchmove', onTouchMove);
      bodyEl.removeEventListener('touchend', onTouchEnd);
      bodyEl.removeEventListener('touchcancel', onTouchCancel);
    };
  }, [open]);

  if (!isVisible) return null;

  const finishHandleDrag = (endY: number): void => {
    const s = handleStartRef.current;
    handleStartRef.current = null;
    if (!s) return;
    const dy = endY - s.y;
    const velocity = dy / Math.max(1, performance.now() - s.t);
    if (dy >= 56 || (dy >= 24 && velocity > 0.55)) {
      const pullDy = Math.max(0, dy);
      setExitDragY(pullDy);
      setDragY(0);
      onCloseRef.current();
    } else {
      setExitDragY(0);
      setDragY(0);
    }
  };

  const moveHeaderPull = (clientX: number, clientY: number, headerEl?: HTMLElement): void => {
    const s = headerPullRef.current;
    if (!s) return;
    const dx = clientX - s.startX;
    const dy = clientY - s.startY;
    s.lastY = clientY;
    if (!s.active && Math.abs(dy) > 6 && Math.abs(dy) > Math.abs(dx) * 1.1) {
      s.active = true;
      if (s.pointerId !== undefined && headerEl) {
        try {
          headerEl.setPointerCapture?.(s.pointerId);
        } catch {
          // Ignore synthetic events without an active browser pointer.
        }
      }
    }
    if (s.active) {
      updateDragY(Math.max(0, dy));
    }
  };

  const finishHeaderPull = (): void => {
    const s = headerPullRef.current;
    headerPullRef.current = null;
    if (!s) return;
    const dy = s.lastY - s.startY;
    const velocity = dy / Math.max(1, performance.now() - s.startTime);
    if (!s.active) {
      setExitDragY(0);
      setDragY(0);
      return;
    }
    suppressHeaderClickRef.current = true;
    setTimeout(() => {
      suppressHeaderClickRef.current = false;
    }, 80);
    if (dy >= 56 || (dy >= 24 && velocity > 0.5)) {
      const pullDy = Math.max(0, dy);
      setExitDragY(pullDy);
      setDragY(0);
      onCloseRef.current();
    } else {
      setExitDragY(0);
      setDragY(0);
    }
  };

  const closeStartY = Math.round(exitDragY);

  return (
    <div
      className={['k-sheet-root', isClosing ? 'is-closing' : ''].filter(Boolean).join(' ')}
      role="presentation"
      aria-hidden={isClosing ? 'true' : undefined}
    >
      <div
        className="k-scrim"
        onClick={() => {
          if (isClosing) return;
          setExitDragY(0);
          onClose();
        }}
      />
      <div
        className={[
          'k-sheet',
          `k-sheet-${height}`,
          entering && !isClosing && dragY === 0 ? 'is-entering' : '',
          !isClosing && dragY > 0 ? 'is-dragging' : '',
          isClosing ? 'is-closing' : '',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        role="dialog"
        aria-modal="true"
        data-closing={isClosing ? 'true' : undefined}
        style={
          isClosing
            ? ({ '--k-sheet-drag-y': `${closeStartY}px` } as CSSProperties)
            : dragY > 0
              ? { transform: `translateY(${dragY}px)`, transition: 'none', animation: 'none' }
              : undefined
        }
        onAnimationEnd={(e) => {
          if (e.target !== e.currentTarget) return;
          if (isClosing) {
            setExitDragY(0);
            setRendered(false);
          } else {
            setEntering(false);
          }
        }}
      >
        <div
          className="k-sheet-grip-area"
          data-testid="sheet-handle"
          onTouchStart={(e) => {
            if (e.touches.length !== 1) return;
            const y = e.touches[0]!.clientY;
            handleStartRef.current = { y, lastY: y, t: performance.now() };
          }}
          onTouchMove={(e) => {
            if (!handleStartRef.current || e.touches.length !== 1) return;
            const y = e.touches[0]!.clientY;
            handleStartRef.current.lastY = y;
            updateDragY(Math.max(0, y - handleStartRef.current.y));
          }}
          onTouchEnd={(e) => {
            if (!handleStartRef.current || e.touches.length > 0) return;
            const endY = e.changedTouches[0]?.clientY ?? handleStartRef.current.lastY;
            finishHandleDrag(endY);
          }}
          onTouchCancel={() => {
            handleStartRef.current = null;
            setDragY(0);
          }}
          onPointerDown={(e) => {
            if (e.pointerType === 'touch') return;
            handleStartRef.current = { y: e.clientY, lastY: e.clientY, t: performance.now() };
            try {
              e.currentTarget.setPointerCapture?.(e.pointerId);
            } catch {
              // Ignore synthetic events without an active browser pointer.
            }
          }}
          onPointerMove={(e) => {
            if (e.pointerType === 'touch' || !handleStartRef.current) return;
            handleStartRef.current.lastY = e.clientY;
            updateDragY(Math.max(0, e.clientY - handleStartRef.current.y));
          }}
          onPointerUp={(e) => {
            if (e.pointerType === 'touch' || !handleStartRef.current) return;
            finishHandleDrag(e.clientY);
          }}
          onPointerCancel={(e) => {
            if (e.pointerType === 'touch') return;
            handleStartRef.current = null;
            setDragY(0);
          }}
        >
          <div className="k-sheet-grip" aria-hidden />
        </div>
        {(title || onBack) && (
          <div
            className="k-sheet-head"
            onTouchStart={(e) => {
              if (e.touches.length !== 1 || isSheetHeaderActionTarget(e.target)) return;
              const t = e.touches[0]!;
              suppressHeaderClickRef.current = false;
              headerPullRef.current = {
                startX: t.clientX,
                startY: t.clientY,
                lastY: t.clientY,
                startTime: performance.now(),
                active: false,
              };
            }}
            onTouchMove={(e) => {
              if (!headerPullRef.current || e.touches.length !== 1) return;
              const t = e.touches[0]!;
              moveHeaderPull(t.clientX, t.clientY);
            }}
            onTouchEnd={(e) => {
              if (!headerPullRef.current || e.touches.length > 0) return;
              if (e.changedTouches[0]) headerPullRef.current.lastY = e.changedTouches[0].clientY;
              finishHeaderPull();
            }}
            onTouchCancel={() => {
              headerPullRef.current = null;
              setDragY(0);
            }}
            onPointerDown={(e) => {
              if (e.pointerType === 'touch' || e.button !== 0 || isSheetHeaderActionTarget(e.target)) return;
              suppressHeaderClickRef.current = false;
              headerPullRef.current = {
                startX: e.clientX,
                startY: e.clientY,
                lastY: e.clientY,
                startTime: performance.now(),
                pointerId: e.pointerId,
                active: false,
              };
            }}
            onPointerMove={(e) => {
              if (e.pointerType === 'touch' || headerPullRef.current?.pointerId !== e.pointerId) return;
              moveHeaderPull(e.clientX, e.clientY, e.currentTarget);
            }}
            onPointerUp={(e) => {
              if (e.pointerType === 'touch' || headerPullRef.current?.pointerId !== e.pointerId) return;
              if (e.clientY !== 0 || headerPullRef.current.startY === 0) headerPullRef.current.lastY = e.clientY;
              finishHeaderPull();
            }}
            onPointerCancel={(e) => {
              if (e.pointerType === 'touch' || headerPullRef.current?.pointerId !== e.pointerId) return;
              headerPullRef.current = null;
              setDragY(0);
            }}
            onClickCapture={(e) => {
              if (suppressHeaderClickRef.current) {
                suppressHeaderClickRef.current = false;
                if (!isSheetHeaderActionTarget(e.target)) {
                  e.stopPropagation();
                  e.preventDefault();
                }
              }
            }}
          >
            {onBack && (
              <button type="button" className="k-icon-btn" aria-label="返回" onClick={onBack}>
                <UiIcon name="arrow-left" size={20} />
              </button>
            )}
            <div className="k-sheet-title">{title}</div>
            <button
              type="button"
              className="k-icon-btn"
              aria-label="关闭"
              onClick={() => {
                setExitDragY(0);
                onClose();
              }}
            >
              <UiIcon name="close" size={20} />
            </button>
          </div>
        )}
        <div
          ref={bodyRef}
          className="k-sheet-body"
          onPointerDown={(e) => {
            if (e.pointerType === 'touch' || e.button !== 0) return;
            beginBodyPull(e.clientX, e.clientY, e.target, e.pointerId);
          }}
          onPointerMove={(e) => {
            if (e.pointerType === 'touch' || bodyPullRef.current?.pointerId !== e.pointerId) return;
            moveBodyPull(e.clientX, e.clientY, () => {
              if (e.cancelable) e.preventDefault();
            });
          }}
          onPointerUp={(e) => {
            if (e.pointerType === 'touch' || bodyPullRef.current?.pointerId !== e.pointerId) return;
            if (e.clientY !== 0 || bodyPullRef.current.startY === 0) {
              bodyPullRef.current.lastY = e.clientY;
            }
            endBodyPull();
          }}
          onPointerCancel={(e) => {
            if (e.pointerType === 'touch' || bodyPullRef.current?.pointerId !== e.pointerId) return;
            cancelBodyPull();
          }}
          onClickCapture={(e) => {
            if (suppressBodyClickRef.current) {
              suppressBodyClickRef.current = false;
              e.stopPropagation();
              e.preventDefault();
            }
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export function Avatar({ src, name, size = 34, ai, className }: { src?: string | null; name: string; size?: number; ai?: boolean; className?: string }) {
  const letter = (name || '?').trim().slice(0, 1).toUpperCase();
  return (
    <span className={['k-avatar', className].filter(Boolean).join(' ')} style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}>
      {src ? <img src={src} alt={name} draggable={false} /> : <span aria-hidden>{letter}</span>}
      {ai && (
        <span className="k-avatar-ai" title="AI 风格化生成">
          <UiIcon name="spark" size={Math.max(10, Math.round(size * 0.36))} styleVariant="duotone" />
        </span>
      )}
    </span>
  );
}

export function ProgressBar({ value, max, color, label }: { value: number; max: number; color?: string; label?: ReactNode }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="k-progress" role="progressbar" aria-valuenow={value} aria-valuemax={max} aria-valuemin={0}>
      {label && <span className="k-progress-label">{label}</span>}
      <span className="k-progress-track">
        <span className="k-progress-fill" style={{ width: `${pct}%`, background: color }} />
      </span>
    </div>
  );
}

/** HP bar coloured green → amber → red by ratio. */
export function HpBar({ hp, max }: { hp: number; max: number }) {
  const ratio = max > 0 ? hp / max : 0;
  const color = ratio > 0.5 ? 'var(--ok)' : ratio > 0.25 ? 'var(--warn)' : 'var(--danger)';
  return (
    <span className="k-hp" role="meter" aria-valuenow={hp} aria-valuemax={max} aria-valuemin={0} aria-label="HP">
      <span className="k-hp-fill" style={{ width: `${Math.max(0, Math.min(1, ratio)) * 100}%`, background: color }} />
    </span>
  );
}

export function Skeleton({ lines = 2, className }: { lines?: number; className?: string }) {
  return (
    <div className={['k-skel', className].filter(Boolean).join(' ')} aria-busy="true">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="k-skel-line" style={{ width: `${92 - i * 17}%` }} />
      ))}
    </div>
  );
}

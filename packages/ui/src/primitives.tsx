import { useEffect, type CSSProperties, type ReactNode } from 'react';

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

/** Bottom sheet (half-sheet on mobile, centered panel on desktop). Swipe-down / scrim / Esc to close. */
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
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  let startY: number | null = null;
  return (
    <div className="k-sheet-root" role="presentation">
      <div className="k-scrim" onClick={onClose} />
      <div
        className={['k-sheet', `k-sheet-${height}`, className].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        onTouchStart={(e) => (startY = e.touches[0]?.clientY ?? null)}
        onTouchEnd={(e) => {
          const y = e.changedTouches[0]?.clientY ?? 0;
          if (startY !== null && y - startY > 80) onClose();
          startY = null;
        }}
      >
        <div className="k-sheet-grip" aria-hidden />
        {(title || onBack) && (
          <div className="k-sheet-head">
            {onBack && (
              <button type="button" className="k-icon-btn" aria-label="返回" onClick={onBack}>
                ←
              </button>
            )}
            <div className="k-sheet-title">{title}</div>
            <button type="button" className="k-icon-btn" aria-label="关闭" onClick={onClose}>
              ✕
            </button>
          </div>
        )}
        <div className="k-sheet-body">{children}</div>
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
          ✨
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

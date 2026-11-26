import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { MEMORY_POLICIES, type MemoryPolicy, type ModeId } from '@kesoku/protocol';
import { getPolicyBadge, Segmented, UiIcon, useLocale, useT } from '@kesoku/ui';

export interface PolicyBadgeProps {
  /** Used only for the segmented control's accent colour (`--m-<mode_id>`). */
  modeId?: ModeId | string;
  policy: MemoryPolicy;
  onPolicyChange: (p: MemoryPolicy) => void;
  /** Frosted-glass look for overlays on top of imagery (Galgame stage). */
  glass?: boolean;
  className?: string;
}

function isPolicy(v: unknown): v is MemoryPolicy {
  return typeof v === 'string' && (MEMORY_POLICIES as readonly string[]).includes(v);
}

/**
 * Memory-policy badge `[icon] Memory: Confirm ▾`. Tapping it reveals an inline `[Auto | Confirm | Ignore]`
 * segmented control; picking a segment calls `onPolicyChange` (zero LLM turn) and collapses it.
 */
export function PolicyBadge({ modeId, policy, onPolicyChange, glass, className }: PolicyBadgeProps) {
  const locale = useLocale();
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const current: MemoryPolicy = isPolicy(policy) ? policy : 'confirm_only';
  const meta = getPolicyBadge(current, locale);
  const options = MEMORY_POLICIES.map((value) => ({ value, label: getPolicyBadge(value, locale).label }));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent | MouseEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const color = modeId ? `var(--m-${modeId}, var(--mode))` : 'var(--mode)';
  return (
    <span
      ref={rootRef}
      className={['k-hud-policy', glass ? 'is-glass' : '', `is-${current}`, className].filter(Boolean).join(' ')}
      style={{ '--policy-color': color } as CSSProperties}
    >
      <button
        type="button"
        className="k-hud-policy-badge"
        aria-expanded={open}
        aria-haspopup="true"
        title={meta.explain}
        onClick={() => setOpen((o) => !o)}
      >
        <UiIcon name={meta.iconName} size={15} className="k-hud-policy-icon" />
        <span className="k-hud-policy-prefix">{t('policy.badgePrefix', { label: meta.label })}</span>
        <span className="k-hud-policy-short" aria-hidden="true">
          {meta.label}
        </span>
        <UiIcon name="chevron-down" size={13} className="k-caret" />
      </button>
      {open && (
        <span className="k-hud-policy-pop" role="group" aria-label={t('policy.modeMemory')}>
          <Segmented
            size="sm"
            ariaLabel={t('policy.modeMemory')}
            color={color}
            options={options}
            value={current}
            onChange={(v) => {
              setOpen(false);
              if (v !== current) onPolicyChange(v);
            }}
          />
        </span>
      )}
    </span>
  );
}

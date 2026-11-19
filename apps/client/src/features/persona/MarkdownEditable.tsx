import { useEffect, useRef, useState, type ReactNode } from 'react';
import { UiIcon } from '@kesoku/ui';
import { Markdown } from '../segments/Markdown';

export interface MarkdownEditableProps {
  label: ReactNode;
  hint?: ReactNode;
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  placeholder?: string;
  ariaLabel?: string;
  defaultEditing?: boolean;
  /** Extra controls rendered in the header, left of the edit toggle (e.g. byte counter, template menu). */
  actions?: ReactNode;
  /** Validation error → red textarea border; forces the editor open so the user can fix it. */
  invalid?: boolean;
  /** Changing this (e.g. switching to another role) returns to the default view. */
  resetKey?: string;
  className?: string;
}

/**
 * Markdown field that reads as rendered Markdown by default and only shows the raw text while editing.
 * Click the preview (or 编辑) to edit; 完成预览 switches back. Empty values show a tappable placeholder.
 */
export function MarkdownEditable({
  label,
  hint,
  value,
  onChange,
  rows = 6,
  placeholder,
  ariaLabel,
  defaultEditing,
  actions,
  invalid,
  resetKey,
  className,
}: MarkdownEditableProps) {
  const [editing, setEditing] = useState(Boolean(defaultEditing));
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const focusNext = useRef(false);
  const prevResetKey = useRef(resetKey);
  const show = editing || !!invalid;

  useEffect(() => {
    if (prevResetKey.current !== resetKey) {
      prevResetKey.current = resetKey;
      setEditing(Boolean(defaultEditing));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  useEffect(() => {
    if (show && focusNext.current) {
      focusNext.current = false;
      taRef.current?.focus();
    }
  }, [show]);

  const startEdit = () => {
    focusNext.current = true;
    setEditing(true);
  };

  return (
    <div className={['ps-md', show ? 'is-editing' : 'is-preview', className].filter(Boolean).join(' ')}>
      <div className="ps-md-head ps-label">
        <span className="ps-md-label">{label}</span>
        <span className="ps-row ps-md-actions">
          {actions}
          {show ? (
            <button type="button" className="k-btn k-btn-sm k-btn-ghost ps-md-toggle" onClick={() => setEditing(false)} disabled={!!invalid}>
              <UiIcon name="check" size={14} /> 完成预览
            </button>
          ) : (
            <button type="button" className="k-btn k-btn-sm k-btn-ghost ps-md-toggle" onClick={startEdit}>
              <UiIcon name="edit" size={14} /> 编辑
            </button>
          )}
        </span>
      </div>
      {hint && <div className="ps-sub ps-md-hint">{hint}</div>}
      {show ? (
        <textarea
          ref={taRef}
          className={'ps-textarea' + (invalid ? ' is-err' : '')}
          rows={rows}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-invalid={invalid || undefined}
        />
      ) : value.trim() ? (
        <div
          className="ps-md-preview"
          role="button"
          tabIndex={0}
          aria-label={ariaLabel ? `${ariaLabel}（点击编辑）` : '点击编辑'}
          title="点击编辑"
          onClick={(e) => {
            // Let links inside the rendered Markdown work without entering edit mode.
            if ((e.target as HTMLElement).closest('a')) return;
            startEdit();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.target === e.currentTarget) {
              e.preventDefault();
              startEdit();
            }
          }}
        >
          <Markdown text={value} />
        </div>
      ) : (
        <button type="button" className="ps-md-empty" onClick={startEdit}>
          {placeholder || '点击输入内容…'}
        </button>
      )}
    </div>
  );
}

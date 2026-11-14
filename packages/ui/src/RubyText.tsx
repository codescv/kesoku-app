import { Fragment, type CSSProperties, type ReactNode } from 'react';
import type { RubyPart } from './ruby';

export interface RubyTextProps {
  parts: RubyPart[];
  className?: string;
  style?: CSSProperties;
  /** When set, every part becomes a tappable word (inline lexical breakdown). */
  onPartClick?: (part: RubyPart, index: number) => void;
  activeIndex?: number | null;
}

const WORD_CHAR_RE = /[\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3005-\u3007A-Za-z0-9]/;

/** Renders parts as real <ruby>/<rt> React elements (JSX-escaped; never raw HTML injection). */
export function RubyText({ parts, className, style, onPartClick, activeIndex }: RubyTextProps) {
  return (
    <span lang="ja" className={['k-ruby', className].filter(Boolean).join(' ')} style={style}>
      {parts.map((p, i) => {
        const inner: ReactNode = p.rt ? (
          <ruby>
            {p.base}
            <rt>{p.rt}</rt>
          </ruby>
        ) : (
          p.base
        );
        if (!onPartClick || (!p.rt && !WORD_CHAR_RE.test(p.base))) return <Fragment key={i}>{inner}</Fragment>;
        return (
          <span
            key={i}
            role="button"
            tabIndex={0}
            className={'k-word' + (activeIndex === i ? ' is-active' : '')}
            onClick={(e) => {
              e.stopPropagation();
              onPartClick(p, i);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onPartClick(p, i);
              }
            }}
          >
            {inner}
          </span>
        );
      })}
    </span>
  );
}

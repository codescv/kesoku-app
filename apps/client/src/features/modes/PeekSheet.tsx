import { useState } from 'react';
import { Sheet } from '@kesoku/ui';
import type { CardContext, GlossaryEntry } from '../cards/types';
import { mdParagraphs } from '../cards/util';

export interface PeekSheetProps {
  /** Entry to show; `null` = closed. */
  entry: GlossaryEntry | null;
  /** Sibling glossary of the card (enables in-place related-entry navigation). */
  glossary?: Record<string, GlossaryEntry>;
  onClose: () => void;
  ctx: Pick<CardContext, 'insertComposer'>;
  /** Display name of the current persona for `[问<name> ›]` (generic fallback when unknown). */
  personaName?: string;
}

function findRelated(id: string, glossary: Record<string, GlossaryEntry> | undefined): GlossaryEntry | undefined {
  if (!glossary) return undefined;
  if (glossary[id]) return { ...glossary[id], id: glossary[id].id || id };
  return Object.values(glossary).find((g) => g.title === id);
}

/**
 * Wiki Peek Sheet: title + 2 large effect pills + `▸ 实战细节` + related entries replaced in place (with a
 * back arrow, never stacking dialogs) + `[问<角色名> ›]`. Zero network: everything comes from the card glossary.
 */
export function PeekSheet({ entry, glossary, onClose, ctx, personaName }: PeekSheetProps) {
  if (!entry) return null;
  return <PeekInner key={entry.id || entry.title} root={entry} glossary={glossary} onClose={onClose} ctx={ctx} personaName={personaName || 'AI 助手'} />;
}

function PeekInner({ root, glossary, onClose, ctx, personaName }: { root: GlossaryEntry; glossary?: Record<string, GlossaryEntry>; onClose: () => void; ctx: Pick<CardContext, 'insertComposer'>; personaName: string }) {
  const [stack, setStack] = useState<GlossaryEntry[]>([root]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const cur = stack[stack.length - 1];
  const pills = (cur.effect_pills ?? []).filter(Boolean).slice(0, 2);
  const paras = mdParagraphs(cur.details_md ?? '');
  const related = (cur.related ?? []).map((id) => findRelated(id, glossary)).filter((g): g is GlossaryEntry => !!g && g.title !== cur.title);

  const go = (g: GlossaryEntry) => {
    setStack((s) => [...s, g]);
    setDetailsOpen(false);
  };
  const back = () => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
    setDetailsOpen(false);
  };

  return (
    <Sheet
      open
      onClose={onClose}
      onBack={stack.length > 1 ? back : undefined}
      height="half"
      className="km-peek"
      title={
        <span className="km-peek-title">
          {cur.title}
          {cur.category && <span className="km-peek-cat">{cur.category}</span>}
        </span>
      }
    >
      <div className="km-peek-body">
        {pills.length > 0 && (
          <div className="km-peek-pills">
            {pills.map((p) => (
              <span key={p} className="km-peek-pill">
                {p}
              </span>
            ))}
          </div>
        )}
        {cur.summary && <p className="km-peek-summary">{cur.summary}</p>}
        {paras.length > 0 && (
          <div className="km-peek-details">
            <button type="button" className="km-fold-btn" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((o) => !o)}>
              {detailsOpen ? '▾' : '▸'} 实战细节
            </button>
            {detailsOpen &&
              paras.map((p, i) => (
                <p key={i} className="km-peek-para">
                  {p}
                </p>
              ))}
          </div>
        )}
        {related.length > 0 && (
          <div className="km-peek-related">
            <span className="km-k">关联词条</span>
            {related.map((g) => (
              <button key={g.id || g.title} type="button" className="km-peek-rel" onClick={() => go(g)}>
                {g.title} ▸
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className="km-peek-ask"
          onClick={() => {
            ctx.insertComposer(cur.title);
            onClose();
          }}
        >
          问{personaName} ›
        </button>
      </div>
    </Sheet>
  );
}

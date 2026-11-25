import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { actions } from '../../lib/store';

export const MAX_QUOTE_CHARS = 2000;

const QUOTE_CONTAINER_SELECTOR = '.k-row-assistant, .k-row-user, .k-row-system, .gg-box-body';
const SKIP_SELECTOR = 'rt, rp, script, style, [aria-hidden="true"], [data-quote-ignore], .k-msg-time, .k-think-pill, .k-voice, .k-sending, .k-retry';
const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE', 'TR', 'SECTION', 'ARTICLE']);

function elementFromNode(node: Node | null): HTMLElement | null {
  if (!node) return null;
  if (node.nodeType === 1) return node as HTMLElement;
  return node.parentElement;
}

/** Return the chat message container if `node` is inside selectable message content (and not an input/editor). */
export function findQuoteContainer(node: Node | null): HTMLElement | null {
  const el = elementFromNode(node);
  if (!el) return null;
  if (el.closest('input, textarea, [contenteditable="true"], .k-composer, .k-sel-quote')) return null;
  return el.closest<HTMLElement>(QUOTE_CONTAINER_SELECTOR);
}

/** Detect a short speaker label for the message container (used in the composer quote header). */
export function detectSpeaker(container: HTMLElement): string | undefined {
  if (container.classList.contains('k-row-user')) return '我';
  const nameEl =
    container.querySelector<HTMLElement>('.k-assistant-name') ??
    container.closest<HTMLElement>('.gg-box')?.querySelector<HTMLElement>('.gg-speaker');
  const label = nameEl?.textContent?.trim();
  return label || undefined;
}

function collectText(node: Node, out: string[]): void {
  if (node.nodeType === 3) {
    out.push(node.textContent ?? '');
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node as HTMLElement;
  if (el.matches(SKIP_SELECTOR)) return;
  if (el.tagName === 'BR') {
    out.push('\n');
    return;
  }
  const isBlock = BLOCK_TAGS.has(el.tagName);
  if (isBlock && out.length > 0 && !out[out.length - 1]!.endsWith('\n')) {
    out.push('\n');
  }
  for (let child = el.firstChild; child; child = child.nextSibling) {
    collectText(child, out);
  }
  if (isBlock && out.length > 0 && !out[out.length - 1]!.endsWith('\n')) {
    out.push('\n');
  }
}

/** Extract clean text from a DOM Range, stripping `<ruby>` furigana (`<rt>`/`<rp>`) and decorative chrome. */
export function extractRangeText(range: Range): string {
  const frag = range.cloneContents();
  const parts: string[] = [];
  for (let child = frag.firstChild; child; child = child.nextSibling) {
    collectText(child, parts);
  }
  const cleaned = parts
    .join('')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (cleaned.length <= MAX_QUOTE_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_QUOTE_CHARS).trimEnd()}…`;
}

/** Format a quoted excerpt + user reply into a Markdown blockquote message understood natively by the engine. */
export function formatQuotedMessage(quote: string, reply: string): string {
  const q = quote.replace(/\r\n?/g, '\n').trim();
  const r = reply.replace(/\r\n?/g, '\n').trim();
  if (!q) return r;
  const quoted = q
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n');
  return r ? `${quoted}\n\n${r}` : quoted;
}

/** Split a leading Markdown quote block (`> ...\n\nreply`) off a sent user message for visual rendering. */
export function splitUserQuote(text: string | undefined): { quote?: string; reply: string } {
  if (!text) return { reply: '' };
  const normalized = text.replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('>')) return { reply: text };
  const lines = normalized.split('\n');
  let i = 0;
  while (i < lines.length && /^>(?:\s|$)/.test(lines[i]!)) i++;
  if (i === 0) return { reply: text };
  // Require either a blank-line separator followed by reply text, or an all-quote message.
  let j = i;
  while (j < lines.length && lines[j]!.trim() === '') j++;
  if (j === i && j < lines.length) return { reply: text };
  const quoteLines = lines.slice(0, i).map((l) => l.replace(/^> ?/, ''));
  const quote = quoteLines.join('\n').trim();
  const reply = lines.slice(j).join('\n').trim();
  if (!quote) return { reply: text };
  return { quote, reply };
}

export interface PopoverPosition {
  left: number;
  top: number;
  placement: 'above' | 'below';
}

/** Compute viewport-clamped coordinates for the floating quote button around a selection bounding box. */
export function computePopoverPosition(
  rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>,
  viewport: { width: number; height: number },
  preferBelow: boolean,
): PopoverPosition {
  const padX = 76;
  const centerX = rect.left + rect.width / 2;
  const left = Math.round(Math.max(padX, Math.min(viewport.width - padX, centerX)));
  const gap = preferBelow ? 12 : 10;

  if (preferBelow) {
    if (rect.bottom + gap + 44 <= viewport.height - 80) {
      return { left, top: Math.round(rect.bottom + gap), placement: 'below' };
    }
    return { left, top: Math.round(Math.max(56, rect.top - gap)), placement: 'above' };
  }
  if (rect.top - gap - 40 >= 48) {
    return { left, top: Math.round(rect.top - gap), placement: 'above' };
  }
  return { left, top: Math.round(Math.min(viewport.height - 96, rect.bottom + gap)), placement: 'below' };
}

interface ActiveSelection {
  text: string;
  speaker?: string;
  pos: PopoverPosition;
}

function isCoarsePointer(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

/**
 * Floating "引用回复" popover triggered when the user selects text inside chat messages.
 * Works on desktop (mouse drag) and touch devices (iOS/Android long-press text selection).
 */
export function SelectionQuote({ sessionId, disabled }: { sessionId: string | null; disabled?: boolean }) {
  const [sel, setSel] = useState<ActiveSelection | null>(null);

  const readSelection = useCallback(() => {
    if (disabled || typeof window === 'undefined') {
      setSel(null);
      return;
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setSel(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const startBox = findQuoteContainer(range.startContainer);
    const endBox = findQuoteContainer(range.endContainer);
    if (!startBox || !endBox) {
      setSel(null);
      return;
    }
    const text = extractRangeText(range);
    if (!text) {
      setSel(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      setSel(null);
      return;
    }
    const speaker = startBox === endBox ? detectSpeaker(startBox) : undefined;
    const pos = computePopoverPosition(
      rect,
      { width: window.innerWidth, height: window.innerHeight },
      isCoarsePointer(),
    );
    setSel({ text, speaker, pos });
  }, [disabled]);

  useEffect(() => {
    if (disabled) {
      setSel(null);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (delayMs: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        readSelection();
      }, delayMs);
    };
    const onSelectionChange = () => schedule(70);
    const onPointerEnd = () => schedule(20);
    const onScroll = () => setSel(null);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSel(null);
    };

    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('mouseup', onPointerEnd);
    document.addEventListener('touchend', onPointerEnd);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('mouseup', onPointerEnd);
      document.removeEventListener('touchend', onPointerEnd);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [disabled, readSelection]);

  useEffect(() => {
    setSel(null);
  }, [sessionId]);

  if (!sel || typeof document === 'undefined') return null;

  const applyQuote = () => {
    actions.setUi({
      composerQuote: {
        text: sel.text,
        speaker: sel.speaker,
        sessionId,
        n: Date.now(),
      },
    });
    window.getSelection()?.removeAllRanges();
    setSel(null);
  };

  return createPortal(
    <div
      className={`k-sel-quote is-${sel.pos.placement}`}
      style={{ left: `${sel.pos.left}px`, top: `${sel.pos.top}px` }}
      role="toolbar"
      aria-label="选中文本操作"
      data-testid="selection-quote-popover"
    >
      <button
        type="button"
        className="k-sel-quote-btn"
        onMouseDown={(e) => e.preventDefault()}
        onClick={applyQuote}
      >
        <svg className="k-sel-quote-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v6a4 4 0 0 1-4 4" />
          <path d="M21 17h-4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v6a4 4 0 0 1-4 4" />
        </svg>
        <span>引用回复</span>
      </button>
    </div>,
    document.body,
  );
}

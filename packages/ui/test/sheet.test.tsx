import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Sheet } from '../src/primitives';

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function setScrollMetrics(el: HTMLElement, { scrollTop, scrollHeight, clientHeight }: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  el.scrollTop = scrollTop;
}

function touchMove(el: Element, clientX: number, clientY: number) {
  fireEvent.touchMove(el, {
    touches: [{ clientX, clientY }],
    changedTouches: [{ clientX, clientY }],
  });
}

function touchStart(el: Element, clientX: number, clientY: number) {
  fireEvent.touchStart(el, {
    touches: [{ clientX, clientY }],
    changedTouches: [{ clientX, clientY }],
  });
}

function touchEnd(el: Element, clientX: number, clientY: number) {
  fireEvent.touchEnd(el, {
    touches: [],
    changedTouches: [{ clientX, clientY }],
  });
}

describe('<Sheet> pull-down-at-top dismiss & smooth close', () => {
  it('does NOT dismiss when pulling down in body while scrolled down (scrollTop > 1)', () => {
    const onClose = vi.fn();
    const { container } = render(
      <Sheet open onClose={onClose} title="小队血量与装备" height="full">
        <div>Party content</div>
      </Sheet>,
    );
    const body = container.querySelector('.k-sheet-body') as HTMLElement;
    const sheet = container.querySelector('.k-sheet') as HTMLElement;
    setScrollMetrics(body, { scrollTop: 120, scrollHeight: 800, clientHeight: 400 });

    touchStart(body, 100, 100);
    touchMove(body, 100, 220);
    expect(sheet.className).not.toContain('is-dragging');
    touchEnd(body, 100, 220);

    expect(onClose).not.toHaveBeenCalled();
  });

  it('drags and dismisses when pulling down in body at scrollTop === 0', () => {
    const onClose = vi.fn();
    const { container } = render(
      <Sheet open onClose={onClose} title="小队血量与装备" height="full">
        <div>Party content</div>
      </Sheet>,
    );
    const body = container.querySelector('.k-sheet-body') as HTMLElement;
    const sheet = container.querySelector('.k-sheet') as HTMLElement;
    setScrollMetrics(body, { scrollTop: 0, scrollHeight: 800, clientHeight: 400 });

    touchStart(body, 100, 100);
    touchMove(body, 100, 180);
    expect(sheet.className).toContain('is-dragging');
    expect(sheet.style.transform).toBe('translateY(80px)');
    touchEnd(body, 100, 180);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('starts dragging only after body reaches scrollTop <= 1 mid-gesture', () => {
    const onClose = vi.fn();
    const { container } = render(
      <Sheet open onClose={onClose} title="小队血量与装备" height="full">
        <div>Party content</div>
      </Sheet>,
    );
    const body = container.querySelector('.k-sheet-body') as HTMLElement;
    const sheet = container.querySelector('.k-sheet') as HTMLElement;
    setScrollMetrics(body, { scrollTop: 80, scrollHeight: 800, clientHeight: 400 });

    touchStart(body, 100, 100);
    // Still scrolled down -> no drag
    touchMove(body, 100, 160);
    expect(sheet.className).not.toContain('is-dragging');

    // Scroll reaches top at y=160; anchor is set at y=160
    body.scrollTop = 0;
    touchMove(body, 100, 160);
    expect(sheet.className).not.toContain('is-dragging');

    // Only 30px past anchor -> does not dismiss on slow release
    touchMove(body, 100, 230);
    expect(sheet.className).toContain('is-dragging');
    expect(sheet.style.transform).toBe('translateY(70px)');
    touchEnd(body, 100, 230);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('snaps back without dismissing on small slow pull (< 56px)', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { container } = render(
      <Sheet open onClose={onClose} title="角色与模式">
        <div>Roles</div>
      </Sheet>,
    );
    const body = container.querySelector('.k-sheet-body') as HTMLElement;
    const sheet = container.querySelector('.k-sheet') as HTMLElement;
    setScrollMetrics(body, { scrollTop: 0, scrollHeight: 400, clientHeight: 400 });

    touchStart(body, 100, 100);
    vi.advanceTimersByTime(300);
    touchMove(body, 100, 130);
    expect(sheet.className).toContain('is-dragging');
    expect(sheet.className).not.toContain('is-entering');
    vi.advanceTimersByTime(300);
    touchEnd(body, 100, 130);

    expect(onClose).not.toHaveBeenCalled();
    expect(sheet.className).not.toContain('is-dragging');
    expect(sheet.className).not.toContain('is-entering');
  });

  it('clamps stranded scrollTop when content fits (prevents iOS WKWebView deadlock)', () => {
    const onClose = vi.fn();
    const { container } = render(
      <Sheet open onClose={onClose} title="小队血量与装备" height="full">
        <div>Short content</div>
      </Sheet>,
    );
    const body = container.querySelector('.k-sheet-body') as HTMLElement;
    setScrollMetrics(body, { scrollTop: 60, scrollHeight: 300, clientHeight: 400 });

    touchStart(body, 100, 100);
    expect(body.scrollTop).toBe(0);
    touchMove(body, 100, 180);
    touchEnd(body, 100, 180);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('allows dismissing via grip handle and header even while body is scrolled', () => {
    const onClose = vi.fn();
    const { container } = render(
      <Sheet open onClose={onClose} title="小队血量与装备" height="full">
        <div>Party</div>
      </Sheet>,
    );
    const body = container.querySelector('.k-sheet-body') as HTMLElement;
    setScrollMetrics(body, { scrollTop: 200, scrollHeight: 800, clientHeight: 400 });

    const handle = screen.getByTestId('sheet-handle');
    touchStart(handle, 100, 40);
    touchMove(handle, 100, 120);
    touchEnd(handle, 100, 120);
    expect(onClose).toHaveBeenCalledTimes(1);

    const head = container.querySelector('.k-sheet-head') as HTMLElement;
    touchStart(head, 100, 60);
    touchMove(head, 100, 140);
    touchEnd(head, 100, 140);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('ignores drag inside data-sheet-no-drag and scrolled inner textarea', () => {
    const onClose = vi.fn();
    const { container } = render(
      <Sheet open onClose={onClose} title="便签与裁切">
        <div data-sheet-no-drag data-testid="crop-area">
          Crop
        </div>
        <textarea data-testid="inner-ta" defaultValue="long notes" />
      </Sheet>,
    );
    const body = container.querySelector('.k-sheet-body') as HTMLElement;
    setScrollMetrics(body, { scrollTop: 0, scrollHeight: 300, clientHeight: 400 });

    const crop = screen.getByTestId('crop-area');
    touchStart(crop, 100, 100);
    touchMove(crop, 100, 220);
    touchEnd(crop, 100, 220);
    expect(onClose).not.toHaveBeenCalled();

    const ta = screen.getByTestId('inner-ta');
    setScrollMetrics(ta, { scrollTop: 50, scrollHeight: 300, clientHeight: 100 });
    touchStart(ta, 100, 100);
    touchMove(ta, 100, 220);
    touchEnd(ta, 100, 220);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('plays smooth closing animation with aria-hidden and unmounts after cleanup', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { container, rerender } = render(
      <Sheet open onClose={onClose} title="小队血量与装备">
        <div>Party</div>
      </Sheet>,
    );
    expect(screen.getByRole('dialog')).toBeTruthy();

    rerender(
      <Sheet open={false} onClose={onClose} title="小队血量与装备">
        <div>Party</div>
      </Sheet>,
    );

    // Immediately hidden from accessibility tree (queryByRole returns null),
    // while DOM stays mounted in .is-closing for the 220ms slide-down animation.
    expect(screen.queryByRole('dialog')).toBeNull();
    const sheet = container.querySelector('.k-sheet') as HTMLElement;
    expect(sheet).toBeTruthy();
    expect(sheet.dataset.closing).toBe('true');
    expect(sheet.className).toContain('is-closing');

    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(container.querySelector('.k-sheet')).toBeNull();
  });
});

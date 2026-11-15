import 'fake-indexeddb/auto';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

// jsdom lacks these.
if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }),
  });
}
// jsdom's media element methods only log "Not implemented"; voice pills buffer clips in the background.
if (typeof window.HTMLMediaElement !== 'undefined') {
  Object.defineProperty(window.HTMLMediaElement.prototype, 'load', { configurable: true, value() {} });
  Object.defineProperty(window.HTMLMediaElement.prototype, 'pause', { configurable: true, value() {} });
  Object.defineProperty(window.HTMLMediaElement.prototype, 'play', { configurable: true, value: () => Promise.resolve() });
}
if (!('scrollTo' in Element.prototype)) {
  Object.defineProperty(Element.prototype, 'scrollTo', { value() {} });
}
if (!(Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView) {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { value() {} });
}

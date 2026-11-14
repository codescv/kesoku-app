import 'fake-indexeddb/auto';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

// jsdom lacks these.
if (!('matchMedia' in window)) {
  Object.defineProperty(window, 'matchMedia', {
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
if (!('scrollTo' in Element.prototype)) {
  Object.defineProperty(Element.prototype, 'scrollTo', { value() {} });
}
if (!(Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView) {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { value() {} });
}

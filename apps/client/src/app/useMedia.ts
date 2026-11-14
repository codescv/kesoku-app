import { useSyncExternalStore } from 'react';

function subscribe(query: string) {
  return (cb: () => void) => {
    const mq = window.matchMedia(query);
    mq.addEventListener?.('change', cb);
    return () => mq.removeEventListener?.('change', cb);
  };
}

export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    subscribe(query),
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** ≥ 1024px → 3-column workbench. */
export const useIsDesktop = () => useMedia('(min-width: 1024px)');
/** 768–1023px → two columns. */
export const useIsTablet = () => useMedia('(min-width: 768px)');

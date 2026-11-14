import { create } from 'zustand';
import type { ReactNode } from 'react';
import type { GlossaryEntry } from '../cards/types';

interface OverlayState {
  fullscreen: ReactNode | null;
  peek: { entry: GlossaryEntry; glossary?: Record<string, GlossaryEntry> } | null;
  image: { url: string; bbox?: number[] } | null;
}

export const useOverlays = create<OverlayState>(() => ({ fullscreen: null, peek: null, image: null }));

export const overlays = {
  fullscreen(node: ReactNode | null) {
    useOverlays.setState({ fullscreen: node });
  },
  peek(entry: GlossaryEntry | null, glossary?: Record<string, GlossaryEntry>) {
    useOverlays.setState({ peek: entry ? { entry, glossary } : null });
  },
  image(url: string | null, bbox?: number[]) {
    useOverlays.setState({ image: url ? { url, bbox } : null });
  },
};

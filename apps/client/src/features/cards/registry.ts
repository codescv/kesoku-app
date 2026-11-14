import { Component, createElement, type ErrorInfo, type ReactNode } from 'react';
import type { CardComponent, CardProps } from './types';
import { GenericCard } from './kinds/GenericCard';
import { OrderCard } from './kinds/OrderCard';
import { DirectionCard } from './kinds/DirectionCard';
import { MenuReview } from './kinds/MenuReview';
import { Translation } from './kinds/Translation';
import { Breakdown } from './kinds/Breakdown';
import { LessonCard } from './kinds/LessonCard';
import { Grading } from './kinds/Grading';
import { PokemonDex } from './kinds/PokemonDex';
import { MoveWiki } from './kinds/MoveWiki';
import { Matchup, PkmnGlossary, PkmnTypeChart } from './kinds/Matchup';

/** Card boundary: a malformed card never takes down the message stage — falls back to GenericCard. */
class CardBoundary extends Component<{ kind: string; props: CardProps<any>; children?: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(err: unknown, info: ErrorInfo): void {
    if (typeof console !== 'undefined') console.warn(`[cards] ${this.props.kind} failed to render`, err, info.componentStack);
  }
  override render(): ReactNode {
    if (this.state.failed) return createElement(GenericCard, { data: this.props.props.data, ctx: this.props.props.ctx });
    return this.props.children;
  }
}

function guarded(kind: string, Inner: CardComponent): CardComponent {
  const Guarded = (props: CardProps<any>) => createElement(CardBoundary, { kind, props }, createElement(Inner, props));
  Guarded.displayName = `Card(${kind})`;
  return Guarded;
}

const RAW: Record<string, CardComponent> = {
  order_card: OrderCard,
  direction_card: DirectionCard,
  menu_review: MenuReview,
  translation: Translation,
  breakdown: Breakdown,
  lesson_card: LessonCard,
  grading: Grading,
  pokemon_dex: PokemonDex,
  pkmn_dex: PokemonDex,
  pkmn_move_wiki: MoveWiki,
  pkmn_matchup: Matchup,
  pkmn_glossary: PkmnGlossary,
  pkmn_type_chart: PkmnTypeChart,
};

const REGISTRY: Record<string, CardComponent> = Object.fromEntries(Object.entries(RAW).map(([k, c]) => [k, guarded(k, c)]));

export const CARD_KINDS: readonly string[] = Object.freeze(Object.keys(RAW));

/** Registered card for a `card.kind` (undefined for unknown kinds — render `GenericCardSafe`). */
export function getCard(kind: string): CardComponent | undefined {
  return Object.prototype.hasOwnProperty.call(REGISTRY, kind) ? REGISTRY[kind] : undefined;
}

/** Guarded fallback for unknown kinds. */
export const GenericCardSafe: CardComponent = guarded('generic', GenericCard);

export { GenericCard };

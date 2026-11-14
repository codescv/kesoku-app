import { App } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { isNative } from './platform';

/**
 * Deep links.
 *
 * Native (custom scheme, from Android launcher shortcuts / iOS App Shortcuts / QR codes):
 *   kesoku://mode/translator   -> { kind: 'mode', mode_id: 'translator' }
 *   kesoku://mode/travel       -> { kind: 'mode', mode_id: 'travel_companion' }
 *   kesoku://mode/pokemon      -> { kind: 'mode', mode_id: 'pokemon_assistant' }
 *   kesoku://pair?code=483920  -> { kind: 'pair', code: '483920' }
 * Web (PWA routes, same slugs): /mode/translator, /mode/travel, /mode/pokemon, /pair?code=...
 *
 * Any other URL parses to null and is ignored.
 */
export type DeepLinkModeId = 'translator' | 'travel_companion' | 'pokemon_assistant';

export type DeepLink = { kind: 'mode'; mode_id: DeepLinkModeId } | { kind: 'pair'; code: string };

export const DEEP_LINK_SCHEME = 'kesoku';

const MODE_SLUGS: Readonly<Record<string, DeepLinkModeId>> = {
  translator: 'translator',
  travel: 'travel_companion',
  travel_companion: 'travel_companion',
  pokemon: 'pokemon_assistant',
  pokemon_assistant: 'pokemon_assistant',
};

const PAIR_CODE_RE = /^\d{6}$/;

function modeFromSlug(slug: string | undefined): DeepLink | null {
  if (!slug) return null;
  const id = Object.prototype.hasOwnProperty.call(MODE_SLUGS, slug.toLowerCase())
    ? MODE_SLUGS[slug.toLowerCase()]
    : undefined;
  return id ? { kind: 'mode', mode_id: id } : null;
}

function pairFromParams(params: URLSearchParams): DeepLink | null {
  // Accept "483 920" / "483-920" as typed or displayed by the CLI.
  const code = (params.get('code') ?? '').replace(/[\s-]/g, '');
  return PAIR_CODE_RE.test(code) ? { kind: 'pair', code } : null;
}

/** "a/b/" -> ["a", "b"], percent-decoded; null on malformed escapes. */
function segments(path: string): string[] | null {
  try {
    return path
      .split('/')
      .filter((s) => s.length > 0)
      .map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
}

function fromRoute(route: string[], params: URLSearchParams): DeepLink | null {
  if (route.length === 2 && route[0] === 'mode') return modeFromSlug(route[1]);
  if (route.length === 1 && route[0] === 'pair') return pairFromParams(params);
  return null;
}

/**
 * Parses a `kesoku://` URL, an http(s) URL of the PWA, or a root-relative path (`/mode/travel`).
 */
export function parseDeepLink(input: string): DeepLink | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw || raw.length > 2048) return null;

  let url: URL;
  try {
    url = raw.startsWith('/') ? new URL(raw, 'https://app.invalid') : new URL(raw);
  } catch {
    return null;
  }

  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (scheme === DEEP_LINK_SCHEME) {
    // kesoku://mode/travel -> host "mode", path "/travel"; also tolerate kesoku:/mode/travel.
    const route = segments(`${url.host}/${url.pathname}`);
    return route ? fromRoute(route, url.searchParams) : null;
  }
  if (scheme === 'http' || scheme === 'https' || scheme === 'capacitor') {
    const route = segments(url.pathname);
    return route ? fromRoute(route, url.searchParams) : null;
  }
  return null;
}

export type DeepLinkHandler = (link: DeepLink) => void;

let launchLinkConsumed = false;

/**
 * Subscribes to deep links. The link that launched the app (native cold start, or the initial
 * web location) is delivered once, asynchronously, to the first subscriber still subscribed
 * at that point (safe under React StrictMode double effects). Returns an unsubscribe function.
 */
export function onDeepLink(cb: DeepLinkHandler): () => void {
  let active = true;
  const deliver = (link: DeepLink | null): void => {
    if (active && link) cb(link);
  };
  const deliverLaunch = (url: string | undefined): void => {
    if (!active || launchLinkConsumed || !url) return;
    const link = parseDeepLink(url);
    if (!link) return;
    launchLinkConsumed = true;
    cb(link);
  };

  if (isNative()) {
    let handle: PluginListenerHandle | undefined;
    void App.addListener('appUrlOpen', (event) => deliver(parseDeepLink(event.url)))
      .then((h) => {
        if (active) handle = h;
        else void h.remove();
      })
      .catch(() => undefined);
    void App.getLaunchUrl()
      .then((res) => deliverLaunch(res?.url))
      .catch(() => undefined);
    return () => {
      active = false;
      if (handle) void handle.remove();
    };
  }

  if (typeof window === 'undefined') {
    return () => {
      active = false;
    };
  }
  // Web: only the location the PWA was opened with counts as a deep link. In-app history
  // navigation (popstate) is the router's business and must not re-trigger mode starts.
  void Promise.resolve().then(() => deliverLaunch(window.location.href));
  return () => {
    active = false;
  };
}

/** Test hook: forget that the launch link was delivered. */
export function resetDeepLinkStateForTests(): void {
  launchLinkConsumed = false;
}

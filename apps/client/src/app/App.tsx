import { useEffect, useState } from 'react';
import { kesoku } from '../lib/client';
import { actions, DEFAULT_SETTINGS, useStore, type Settings } from '../lib/store';
import { getAuthInfo, hasCredentials } from '../lib/auth';
import { db, kvGet, loadMessages, purgeSessionFromDb, reconcileSessionsInDb } from '../lib/db';
import { AuthScreen } from '../features/auth/AuthScreen';
import { onDeepLink } from '../native/deeplinks';
import { isNative } from '../native/platform';
import { Shell } from './Shell';

export const THEME_COLORS = { light: '#FAF8F5', dark: '#15171C' } as const;

export function resolveTheme(theme: Settings['theme']): 'light' | 'dark' {
  if (theme === 'light' || theme === 'dark') return theme;
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** Keep the browser / PWA / native status bar in step with the resolved chat theme. */
export function applyThemeChrome(theme: Settings['theme']): 'light' | 'dark' {
  const resolved = resolveTheme(theme);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.resolvedTheme = resolved;
  root.style.colorScheme = resolved;
  const metas = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
  if (!metas.length) {
    const m = document.createElement('meta');
    m.name = 'theme-color';
    document.head.appendChild(m);
    metas.push(m);
  }
  for (const m of metas) {
    // A user-chosen theme overrides any media-scoped tags from index.html.
    m.removeAttribute('media');
    m.content = THEME_COLORS[resolved];
  }
  return resolved;
}

function useTheme() {
  const theme = useStore((s) => s.settings.theme);
  const fontSize = useStore((s) => s.settings.fontSize);
  useEffect(() => {
    document.documentElement.dataset.fontsize = fontSize;
  }, [fontSize]);
  useEffect(() => {
    applyThemeChrome(theme);
    if (theme !== 'system' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyThemeChrome('system');
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [theme]);
}

async function restoreLocal() {
  const settings = await kvGet<Settings>('settings', DEFAULT_SETTINGS);
  actions.setSettings({ ...DEFAULT_SETTINGS, ...settings });
  const rows = await db.sessions.toArray().catch(() => []);
  if (rows.length) actions.setSessions(rows.map((r) => r.data));
  const last = await kvGet<string | null>('last_session', null);
  if (last) {
    const items = await loadMessages(last).catch(() => []);
    useStore.setState((s) => ({ currentSessionId: last, items: { ...s.items, [last]: items } }));
    actions.setUi({ launchpad: false });
  }
  const info = await getAuthInfo();
  if (info) useStore.setState({ authKind: info.kind, email: info.email ?? null });
}

export function App() {
  useTheme();
  const auth = useStore((s) => s.auth);
  const [pairCode, setPairCode] = useState<string | undefined>();
  const [pairRelay, setPairRelay] = useState<string | undefined>();
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      await restoreLocal().catch(() => {});
      const ok = await hasCredentials().catch(() => false);
      if (!alive) return;
      setBooted(true);
      if (ok) {
        useStore.setState({ auth: 'ok' });
        void kesoku.start();
      } else if (!isNative()) {
        // Web: the HttpOnly session cookie may still be valid even without the local marker — probe it.
        void kesoku.start();
        setTimeout(() => {
          if (useStore.getState().auth === 'unknown') {
            kesoku.stop();
            useStore.setState({ auth: 'needed' });
          }
        }, 5000);
      } else useStore.setState({ auth: 'needed' });
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Persist session list snapshot for offline start and purge removed sessions.
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (s.sessions !== prev.sessions) {
          for (const id of Object.keys(prev.sessions)) {
            if (!(id in s.sessions) && !s.ui.roleFilter) {
              void purgeSessionFromDb(id).catch(() => {});
            }
          }
          void reconcileSessionsInDb(s.sessions, s.ui.roleFilter).catch(() => {});
        }
      }),
    [],
  );

  // Deep links: kesoku://mode/* and kesoku://pair?code=...&relay=...
  useEffect(
    () =>
      onDeepLink((link) => {
        if (link.kind === 'pair') {
          setPairCode(link.code);
          if (link.relay) setPairRelay(link.relay);
          if (useStore.getState().auth !== 'ok') useStore.setState({ auth: 'needed' });
        } else if (link.kind === 'mode') {
          useStore.setState({ currentSessionId: null });
          if (useStore.getState().auth === 'ok') void kesoku.createSession({ mode: link.mode_id as never }).catch(() => actions.toast('无法创建会话', 'error'));
        }
      }),
    [],
  );

  // Background: disconnect 30 s after hide (native), resume + sync.resume on foreground.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        if (isNative()) t = setTimeout(() => kesoku.suspend(), 30_000);
      } else {
        if (t) clearTimeout(t);
        t = null;
        kesoku.resume();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  if (!booted || auth === 'unknown') return <div className="k-boot" aria-busy="true" />;
  if (auth === 'needed')
    return (
      <AuthScreen
        key={`${pairCode ?? ''}|${pairRelay ?? ''}`}
        initialCode={pairCode}
        initialRelay={pairRelay}
        onDone={() => {
          useStore.setState({ auth: 'ok' });
          void getAuthInfo().then((i) => i && useStore.setState({ authKind: i.kind, email: i.email ?? null }));
          kesoku.stop();
          void kesoku.start();
        }}
      />
    );
  return <Shell />;
}

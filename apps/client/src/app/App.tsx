import { useEffect, useState } from 'react';
import { kesoku } from '../lib/client';
import { actions, DEFAULT_SETTINGS, useStore, type Settings } from '../lib/store';
import { getAuthInfo, hasCredentials } from '../lib/auth';
import { db, kvGet, loadMessages } from '../lib/db';
import { AuthScreen } from '../features/auth/AuthScreen';
import { onDeepLink } from '../native/deeplinks';
import { isNative } from '../native/platform';
import { Shell } from './Shell';

function useTheme() {
  const theme = useStore((s) => s.settings.theme);
  const fontSize = useStore((s) => s.settings.fontSize);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.fontsize = fontSize;
  }, [theme, fontSize]);
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

  // Persist session list snapshot for offline start.
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (s.sessions !== prev.sessions) {
          const rows = Object.values(s.sessions).map((d) => ({ session_id: d.session_id, data: d, updated_at: d.updated_at }));
          void db.sessions.bulkPut(rows).catch(() => {});
        }
      }),
    [],
  );

  // Deep links: kesoku://mode/* and kesoku://pair?code=
  useEffect(
    () =>
      onDeepLink((link) => {
        if (link.kind === 'pair') {
          setPairCode(link.code);
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
        initialCode={pairCode}
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

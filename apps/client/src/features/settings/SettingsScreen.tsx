import { useEffect, useState } from 'react';
import { MODEL_CATALOG, MODE_IDS, type Device, type EngineToClientPayload } from '@kesoku/protocol';
import {
  ModeIcon,
  Segmented,
  UiIcon,
  formatLocaleDate,
  formatLocaleDateTime,
  getIconStyleOptions,
  getPolicyBadge,
  modeMeta,
  setIconStyle,
  useIconStyle,
  useLocale,
  useT,
  type LanguageSetting,
  type UiIconName,
} from '@kesoku/ui';
import { APP_VERSION, kesoku } from '../../lib/client';
import { getPlatform } from '../../native/platform';
import {
  downloadAndInstallApk,
  installApkFile,
  onApkDownloadProgress,
  onApkInstallResumed,
} from '../../native/updater';
import { actions, useStore, type Settings } from '../../lib/store';
import { kvSet } from '../../lib/db';
import { logout } from '../../lib/auth';
import { PolicySegmented } from '../memory/PolicySegmented';
import { MAX_FOREIGN_LANGS, TRANSLATOR_LANGS, isNativeLang, langKey } from '@kesoku/hud';
import { translatorLangs } from '../../lib/translatorPrefs';
import { workoutActions } from '../workout/store';
import { downloadJsonFile, workoutSync } from '../workout/sync';

function save(patch: Partial<Settings>) {
  actions.setSettings(patch);
  void kvSet('settings', useStore.getState().settings);
}

/** Translator mode native select + foreign multi-select chips (at least one foreign language is always kept). */
export function TranslatorLangFields() {
  const tr = useT();
  const settings = useStore((s) => s.settings);
  const { native_lang: native, foreign_langs: foreign } = translatorLangs(settings);
  const setNative = (code: string) => {
    if (isNativeLang(code, native)) return;
    let fl = foreign.filter((c) => !isNativeLang(c, code));
    if (!fl.length) fl = [native];
    save({ translatorNativeLang: code, translatorForeignLangs: fl });
  };
  const toggle = (code: string) => {
    const on = foreign.some((c) => langKey(c) === langKey(code));
    if (on && foreign.length <= 1) return;
    save({ translatorForeignLangs: on ? foreign.filter((c) => langKey(c) !== langKey(code)) : [...foreign, code].slice(0, MAX_FOREIGN_LANGS) });
  };
  return (
    <>
      <label className="k-kv">
        <span>{tr('settings.translatorNativeLang')}</span>
        <select aria-label={tr('settings.translatorNativeLang')} value={TRANSLATOR_LANGS.find((l) => isNativeLang(l.code, native))?.code ?? native} onChange={(e) => setNative(e.target.value)}>
          {TRANSLATOR_LANGS.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label} · {l.name}
            </option>
          ))}
        </select>
      </label>
      <div className="k-kv k-kv-stack">
        <span>{tr('settings.translatorForeignLangs')}</span>
        <div className="k-lang-chips" role="group" aria-label={tr('settings.translatorForeignLangs')}>
          {TRANSLATOR_LANGS.filter((l) => !isNativeLang(l.code, native)).map((l) => {
            const on = foreign.some((c) => langKey(c) === langKey(l.code));
            return (
              <button
                key={l.code}
                type="button"
                className={'k-pill k-pill-sm k-lang-chip' + (on ? ' is-on' : '')}
                aria-pressed={on}
                title={l.name}
                disabled={on && foreign.length <= 1}
                onClick={() => toggle(l.code)}
              >
                {on && <UiIcon name="check" size={12} styleVariant="line" />} {l.label}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

const PREVIEW_MODES = ['chat', 'galgame', 'trpg', 'pokemon_assistant'] as const;

/** Icon style picker with a live preview of each rendering. */
export function IconStyleCard() {
  const locale = useLocale();
  const tr = useT();
  const current = useIconStyle();
  const options = getIconStyleOptions(locale);
  return (
    <section className="k-set-card" aria-labelledby="k-iconstyle-title">
      <h2 id="k-iconstyle-title">
        <UiIcon name="spark" size={20} /> {tr('iconStyle.title')}
      </h2>
      <div className="k-iconstyle-grid" role="radiogroup" aria-label={tr('iconStyle.title')}>
        {options.map((o) => {
          const on = current === o.value;
          return (
            <button key={o.value} type="button" role="radio" aria-checked={on} className={'k-iconstyle' + (on ? ' is-on' : '')} data-style={o.value} onClick={() => setIconStyle(o.value)}>
              <span className="k-iconstyle-preview" aria-hidden>
                {PREVIEW_MODES.map((m) => (
                  <ModeIcon key={m} mode={m} size={26} styleVariant={o.value} />
                ))}
              </span>
              <span className="k-iconstyle-text">
                <span className="k-iconstyle-label">
                  {o.label}
                  {on && <UiIcon name="check" size={16} styleVariant="line" />}
                </span>
                <small>{o.desc}</small>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function deviceIcon(d: Device): UiIconName {
  if (d.kind === 'google') return 'globe';
  return /web|mac|win|linux|desktop|chrome|safari|firefox/i.test(d.platform ?? '') ? 'laptop' : 'smartphone';
}

export function MemoryPolicyCard() {
  const locale = useLocale();
  const tr = useT();
  const policies = useStore((s) => s.policies);
  const differs = MODE_IDS.some((m) => policies.policies[m] !== policies.defaults[m]);
  return (
    <section className="k-set-card" id="memory-policies">
      <div className="k-set-card-head">
        <h2>
          <UiIcon name="brain" size={20} /> {tr('settings.memoryPolicy')}
        </h2>
        <button type="button" className="k-btn k-btn-sm k-btn-ghost" disabled={!differs} onClick={() => void kesoku.resetPolicies()}>
          {tr('settings.resetDefaults')}
        </button>
      </div>
      <div className="k-policy-rows">
        {MODE_IDS.map((id) => {
          const m = modeMeta(id, locale);
          return (
            <div key={id} className="k-policy-row" data-mode={id}>
              <span className="k-policy-mode">
                <ModeIcon mode={id} size={22} /> {m.title}
              </span>
              <PolicySegmented modeId={id} size="sm" />
            </div>
          );
        })}
      </div>
      <div className="k-policy-legend">
        {(['full', 'confirm_only', 'isolated'] as const).map((p) => {
          const b = getPolicyBadge(p, locale);
          return (
            <span key={p} className="k-pill k-pill-sm k-pill-neutral">
              <UiIcon name={b.iconName} size={13} /> {b.label} = {b.explain}
            </span>
          );
        })}
      </div>
    </section>
  );
}

function Devices() {
  const locale = useLocale();
  const tr = useT();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const me = useStore((s) => s.conn.deviceId);
  const load = () =>
    kesoku
      .rpc<EngineToClientPayload<'device.list.result'>>('device.list', {})
      .then((r) => setDevices(r.devices))
      .catch(() => setDevices([]));
  useEffect(() => {
    void load();
  }, []);
  return (
    <div className="k-devices">
      {devices === null && <div className="k-empty">{tr('settings.loadingDevices')}</div>}
      {devices?.map((d) => (
        <div key={d.device_id} className={'k-device' + (d.revoked_at ? ' is-revoked' : '')}>
          <span className="k-device-main">
            <b>
              <UiIcon name={deviceIcon(d)} size={18} /> {d.name}
              {(d.current || d.device_id === me) && <span className="k-pill k-pill-sm k-pill-primary">{tr('settings.thisDevice')}</span>}
            </b>
            <small>
              {d.platform ?? ''} · {tr('settings.boundOn', { date: formatLocaleDate(d.created_at * 1000, undefined, locale) })}
              {d.revoked_at ? tr('settings.revokedTag') : ''}
            </small>
          </span>
          {!d.revoked_at &&
            (confirm === d.device_id ? (
              <button
                type="button"
                className="k-btn k-btn-sm k-btn-danger"
                onClick={() =>
                  void kesoku
                    .rpc('device.revoke', { device_id: d.device_id })
                    .then(() => (actions.toast(tr('settings.revokedToast')), setConfirm(null), load()))
                    .catch(() => actions.toast(tr('settings.revokeFailedToast'), 'error'))
                }
              >
                {tr('settings.confirmRevoke')}
              </button>
            ) : (
              <button type="button" className="k-btn k-btn-sm k-btn-danger-ghost" onClick={() => setConfirm(d.device_id)}>
                {tr('settings.revoke')}
              </button>
            ))}
        </div>
      ))}
    </div>
  );
}

const GITHUB_LATEST_RELEASE_URL = 'https://api.github.com/repos/codescv/kesoku-app/releases/latest';
const GITHUB_RELEASES_PAGE_URL = 'https://github.com/codescv/kesoku-app/releases/latest';

export function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').trim().split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/i, '').trim().split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
}

export async function checkAndroidUpdate(currentVersion = APP_VERSION): Promise<{
  hasUpdate: boolean;
  latestVersion: string;
  downloadUrl: string;
}> {
  const res = await fetch(GITHUB_LATEST_RELEASE_URL, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as {
    tag_name?: string;
    html_url?: string;
    assets?: Array<{ name?: string; browser_download_url?: string }>;
  };
  const latestVersion = String(data.tag_name ?? '').replace(/^v/i, '').trim() || currentVersion;
  const apkAsset = Array.isArray(data.assets)
    ? data.assets.find((a) => typeof a?.name === 'string' && a.name.endsWith('.apk') && a.browser_download_url)
    : undefined;
  const downloadUrl = apkAsset?.browser_download_url || data.html_url || GITHUB_RELEASES_PAGE_URL;
  return {
    hasUpdate: compareSemver(latestVersion, currentVersion) > 0,
    latestVersion,
    downloadUrl,
  };
}

/** Screen 14 · Security pairing & settings */
export function SettingsScreen({ onClose }: { onClose: () => void }) {
  const locale = useLocale();
  const tr = useT();
  const conn = useStore((s) => s.conn);
  const settings = useStore((s) => s.settings);
  const authKind = useStore((s) => s.authKind);
  const email = useStore((s) => s.email);
  const head = useStore((s) => (s.currentSessionId ? s.lastSeq[s.currentSessionId] : undefined));
  const [showConn, setShowConn] = useState(false);
  const [pairHelp, setPairHelp] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [dirtyWorkoutCount, setDirtyWorkoutCount] = useState(0);
  const [syncingBeforeLogout, setSyncingBeforeLogout] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [downloadingUpdate, setDownloadingUpdate] = useState(false);
  const [downloadPercent, setDownloadPercent] = useState<number | null>(null);
  const [downloadedApk, setDownloadedApk] = useState<{
    version: string;
    filePath: string;
    needsPermission: boolean;
  } | null>(null);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);
  const isAndroid = getPlatform() === 'android';

  useEffect(() => {
    if (!isAndroid) return;
    let disposed = false;
    let removeFn: (() => Promise<void>) | undefined;
    void onApkInstallResumed((ev) => {
      if (disposed || !ev.installerLaunched) return;
      setDownloadedApk((prev) => {
        const version = prev?.version ?? '';
        setUpdateStatus(version ? tr('settings.downloadedLaunching', { version }) : tr('settings.launchingInstaller'));
        return prev ? { ...prev, filePath: ev.filePath || prev.filePath, needsPermission: false } : prev;
      });
    }).then((h) => {
      if (disposed) void h.remove();
      else removeFn = () => h.remove();
    });
    return () => {
      disposed = true;
      if (removeFn) void removeFn();
    };
  }, [isAndroid, tr]);

  const onCheckUpdate = async () => {
    if (checkingUpdate || downloadingUpdate) return;
    setCheckingUpdate(true);
    setUpdateStatus(null);
    let res: Awaited<ReturnType<typeof checkAndroidUpdate>>;
    try {
      res = await checkAndroidUpdate(APP_VERSION);
    } catch {
      setCheckingUpdate(false);
      const msg = tr('settings.checkUpdateFailed');
      setUpdateStatus(msg);
      actions.toast(msg, 'error');
      return;
    }
    setCheckingUpdate(false);

    if (!res.hasUpdate) {
      setDownloadedApk(null);
      setDownloadPercent(null);
      const msg = tr('settings.alreadyLatest', { version: APP_VERSION });
      setUpdateStatus(msg);
      actions.toast(msg);
      return;
    }

    setDownloadingUpdate(true);
    setDownloadPercent(0);
    setDownloadedApk(null);
    setUpdateStatus(tr('settings.downloadingVersion', { version: res.latestVersion }));
    actions.toast(tr('settings.foundNewVersion', { version: res.latestVersion }));

    const progressHandle = await onApkDownloadProgress((ev) => {
      const pct = typeof ev.percent === 'number' && ev.percent >= 0 ? Math.min(100, Math.round(ev.percent)) : -1;
      setDownloadPercent(pct >= 0 ? pct : null);
      setUpdateStatus(
        pct >= 0
          ? tr('settings.downloadingVersionPercent', { version: res.latestVersion, pct })
          : tr('settings.downloadingVersion', { version: res.latestVersion }),
      );
    });

    try {
      const installRes = await downloadAndInstallApk({
        url: res.downloadUrl,
        version: res.latestVersion,
      });
      const needsPermission = Boolean(installRes.needsPermission);
      setDownloadPercent(100);
      setDownloadedApk({
        version: res.latestVersion,
        filePath: installRes.filePath,
        needsPermission,
      });
      if (needsPermission) {
        const msg = tr('settings.installPermissionNeeded');
        setUpdateStatus(msg);
        actions.toast(msg);
      } else {
        const msg = tr('settings.downloadedLaunching', { version: res.latestVersion });
        setUpdateStatus(msg);
        actions.toast(msg);
      }
    } catch {
      setDownloadPercent(null);
      setUpdateStatus(tr('settings.downloadFailedRetry', { version: res.latestVersion }));
      actions.toast(tr('settings.downloadFailedToast', { version: res.latestVersion }), 'error');
    } finally {
      await progressHandle.remove().catch(() => {});
      setDownloadingUpdate(false);
    }
  };

  const onInstallCachedApk = async () => {
    if (!downloadedApk || downloadingUpdate) return;
    try {
      const res = await installApkFile({ filePath: downloadedApk.filePath });
      const needsPermission = Boolean(res.needsPermission);
      setDownloadedApk((prev) => (prev ? { ...prev, needsPermission } : prev));
      if (needsPermission) {
        const msg = tr('settings.installPermissionNeeded');
        setUpdateStatus(msg);
        actions.toast(msg);
      } else {
        setUpdateStatus(tr('settings.downloadedLaunching', { version: downloadedApk.version }));
      }
    } catch {
      const msg = tr('settings.launchInstallFailed');
      setUpdateStatus(msg);
      actions.toast(msg, 'error');
    }
  };

  const tone = conn.status === 'online' ? (conn.engineOnline ? 'is-ok' : 'is-bad') : conn.status === 'reconnecting' ? 'is-warn' : 'is-bad';
  const status =
    conn.status === 'online'
      ? conn.engineOnline
        ? conn.latencyMs != null
          ? tr('settings.connectedLatency', { ms: conn.latencyMs })
          : tr('settings.connected')
        : tr('settings.offline')
      : conn.status === 'reconnecting'
        ? tr('settings.reconnectingSec', { sec: Math.round((conn.retryInMs ?? 0) / 1000) })
        : tr('settings.offline');

  return (
    <div className="k-screen k-settings">
      <header className="k-screen-head">
        <button type="button" className="k-icon-btn" aria-label={tr('common.back')} onClick={onClose}>
          <UiIcon name="arrow-left" size={22} />
        </button>
        <h1>{tr('settings.title')}</h1>
      </header>
      <div className="k-screen-body">
        <section className="k-set-card k-conn-card" onClick={() => setShowConn((v) => !v)} role="button" tabIndex={0}>
          <div className="k-conn-status">
            <span className={'k-conn-dot ' + tone} aria-hidden />
            {status}
          </div>
          {showConn && (
            <div className="k-conn-detail">
              <span>{tr('settings.deviceLabel', { id: conn.deviceId ?? '—' })}</span>
              <span>{tr('settings.sessionSeqLabel', { seq: head ?? '—' })}</span>
              <span>
                {tr('settings.engineSinceLabel', {
                  time: conn.engineSince ? formatLocaleDateTime(conn.engineSince * 1000, undefined, locale) : '—',
                })}
              </span>
            </div>
          )}
        </section>

        <section className="k-set-card">
          <h2>
            <UiIcon name="shield" size={20} /> {tr('settings.identityDevices')}
          </h2>
          {authKind === 'google' && email && (
            <div className="k-kv">
              <span>{tr('settings.googleAllowlist')}</span>
              <span className="k-pill k-pill-ok k-pill-sm">{email}</span>
            </div>
          )}
          <Devices />
          <button type="button" className="k-btn k-btn-ghost k-btn-block" onClick={() => setPairHelp((v) => !v)}>
            <UiIcon name="qr" size={18} /> {tr('settings.pairNewDevice')}
          </button>
          {pairHelp && (
            <ol className="k-pair-help">
              <li>
                {tr('settings.pairStep1Before')}
                <code>kesoku app pair --name &quot;My Device&quot;</code>
                {tr('settings.pairStep1After')}
              </li>
              <li>{tr('settings.pairStep2')}</li>
              <li>{tr('settings.pairStep3')}</li>
            </ol>
          )}
          {confirmLogout ? (
            dirtyWorkoutCount > 0 ? (
              <div className="k-settings-dirty-warn" role="alert" data-testid="logout-dirty-workout-warn">
                <b>{tr('settings.logoutDirtyWorkoutTitle')}</b>
                <p>{tr('settings.logoutDirtyWorkoutBody', { count: dirtyWorkoutCount })}</p>
                <div className="k-settings-dirty-actions">
                  {conn.status === 'online' && conn.engineOnline && (
                    <button
                      type="button"
                      className="k-btn k-btn-primary k-btn-sm"
                      disabled={syncingBeforeLogout}
                      data-testid="logout-sync-now-btn"
                      onClick={async () => {
                        setSyncingBeforeLogout(true);
                        try {
                          await workoutSync.probeAndSync();
                          const rem = await workoutSync.countAllDirtyDocs();
                          setDirtyWorkoutCount(rem);
                        } finally {
                          setSyncingBeforeLogout(false);
                        }
                      }}
                    >
                      {tr('settings.logoutSyncNow')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="k-btn k-btn-ghost k-btn-sm"
                    data-testid="logout-export-backup-btn"
                    onClick={async () => {
                      const json = await workoutSync.exportBackupJson();
                      downloadJsonFile(json, `kesoku-workouts-backup-${new Date().toISOString().slice(0, 10)}.json`);
                    }}
                  >
                    {tr('settings.logoutExportBackup')}
                  </button>
                  <button
                    type="button"
                    className="k-btn k-btn-danger k-btn-sm"
                    data-testid="logout-proceed-anyway-btn"
                    onClick={async () => {
                      await logout();
                      kesoku.stop();
                      workoutActions.reset();
                      actions.reset();
                      useStore.setState({ auth: 'needed' });
                    }}
                  >
                    {tr('settings.logoutProceedAnyway')}
                  </button>
                  <button
                    type="button"
                    className="k-btn k-btn-ghost k-btn-sm"
                    onClick={() => {
                      setConfirmLogout(false);
                      setDirtyWorkoutCount(0);
                    }}
                  >
                    {tr('common.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="k-btn k-btn-danger k-btn-block"
                onClick={async () => {
                  await logout();
                  kesoku.stop();
                  workoutActions.reset();
                  actions.reset();
                  useStore.setState({ auth: 'needed' });
                }}
              >
                {tr('settings.confirmLogout')}
              </button>
            )
          ) : (
            <button
              type="button"
              className="k-btn k-btn-danger-ghost k-btn-block"
              data-testid="settings-logout-btn"
              onClick={async () => {
                const dirty = await workoutSync.countAllDirtyDocs().catch(() => 0);
                setDirtyWorkoutCount(dirty);
                setConfirmLogout(true);
              }}
            >
              {tr('settings.logout')}
            </button>
          )}
        </section>

        <section className="k-set-card">
          <h2>
            <UiIcon name="spark" size={20} /> {tr('settings.modelSection')}
          </h2>
          <label className="k-kv">
            <span>{tr('settings.defaultModel')}</span>
            <select
              value={settings.defaultModel.model_name}
              onChange={(e) => {
                const m = MODEL_CATALOG.find((x) => x.model_name === e.target.value)!;
                save({ defaultModel: { ...settings.defaultModel, llm: m.llm, model_name: m.model_name } });
              }}
            >
              {MODEL_CATALOG.map((m) => (
                <option key={m.model_name} value={m.model_name}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="k-kv">
            <span>{tr('settings.translatorModel')}</span>
            <select value={settings.translatorModel} onChange={(e) => save({ translatorModel: e.target.value })}>
              {MODEL_CATALOG.map((m) => (
                <option key={m.model_name} value={m.model_name}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className="k-set-card">
          <h2>
            <UiIcon name="palette" size={20} /> {tr('settings.appearance')}
          </h2>
          <div className="k-kv k-kv-stack" data-testid="settings-language-row">
            <span>{tr('settings.language')}</span>
            <Segmented<LanguageSetting>
              ariaLabel={tr('settings.language')}
              size="sm"
              value={settings.language}
              onChange={(v) => save({ language: v })}
              options={[
                { value: 'system', label: tr('settings.followSystem') },
                { value: 'zh-CN', label: '中文' },
                { value: 'en', label: 'English' },
                { value: 'ja', label: '日本語' },
              ]}
            />
          </div>
          <div className="k-kv">
            <span>{tr('settings.theme')}</span>
            <Segmented
              ariaLabel={tr('settings.theme')}
              size="sm"
              value={settings.theme}
              onChange={(v) => save({ theme: v })}
              options={[
                { value: 'system', label: tr('settings.followSystem') },
                { value: 'light', label: tr('settings.themeLight') },
                { value: 'dark', label: tr('settings.themeDark') },
              ]}
            />
          </div>
          <div className="k-kv">
            <span>{tr('settings.fontSize')}</span>
            <Segmented
              ariaLabel={tr('settings.fontSize')}
              size="sm"
              value={settings.fontSize}
              onChange={(v) => save({ fontSize: v })}
              options={[
                { value: 'standard', label: tr('settings.fontStandard') },
                { value: 'large', label: tr('settings.fontLarge') },
              ]}
            />
          </div>
        </section>

        <MemoryPolicyCard />

        <section className="k-set-card">
          <div className="k-kv is-disabled">
            <span>{tr('settings.version')}</span>
            <b>Kesoku v{APP_VERSION}</b>
          </div>
          {isAndroid && (
            <div className="k-update-box" data-testid="android-update-section">
              <button
                type="button"
                className="k-btn k-btn-ghost k-check-update-btn"
                data-testid="check-update-btn"
                disabled={checkingUpdate || downloadingUpdate}
                onClick={() => void onCheckUpdate()}
              >
                <UiIcon name="refresh" size={18} />
                {checkingUpdate
                  ? tr('settings.checkingUpdate')
                  : downloadingUpdate
                    ? downloadPercent != null
                      ? tr('settings.downloadingPercent', { pct: downloadPercent })
                      : tr('settings.downloadingUpdate')
                    : tr('settings.checkUpdate')}
              </button>
              {downloadingUpdate && downloadPercent != null && (
                <div className="k-update-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={downloadPercent}>
                  <div className="k-update-progress-bar" style={{ width: `${downloadPercent}%` }} />
                </div>
              )}
              {updateStatus && (
                <p className="k-set-note" data-testid="update-status-text">
                  {updateStatus}
                </p>
              )}
              {downloadedApk && !downloadingUpdate && (
                <button
                  type="button"
                  className="k-btn k-btn-primary k-check-update-btn"
                  data-testid="install-update-btn"
                  onClick={() => void onInstallCachedApk()}
                >
                  {downloadedApk.needsPermission
                    ? tr('settings.continueInstall', { version: downloadedApk.version })
                    : tr('settings.installVersion', { version: downloadedApk.version })}
                </button>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

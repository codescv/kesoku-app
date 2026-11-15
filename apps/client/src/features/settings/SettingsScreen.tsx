import { useEffect, useState } from 'react';
import { MODEL_CATALOG, MODE_IDS, type Device, type EngineToClientPayload } from '@kesoku/protocol';
import { ICON_STYLE_OPTIONS, ModeIcon, POLICY_BADGE, Segmented, UiIcon, modeMeta, setIconStyle, useIconStyle, type UiIconName } from '@kesoku/ui';
import { APP_VERSION, kesoku } from '../../lib/client';
import { getPlatform } from '../../native/platform';
import { actions, useStore, type Settings } from '../../lib/store';
import { kvSet } from '../../lib/db';
import { logout } from '../../lib/auth';
import { PolicySegmented } from '../memory/PolicySegmented';
import { MAX_FOREIGN_LANGS, TRANSLATOR_LANGS, isNativeLang, langKey } from '@kesoku/hud';
import { translatorLangs } from '../../lib/translatorPrefs';

function save(patch: Partial<Settings>) {
  actions.setSettings(patch);
  void kvSet('settings', useStore.getState().settings);
}

/** 翻译模式 · 母语 select + 常用外语 multi-select chips (at least one foreign language is always kept). */
export function TranslatorLangFields() {
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
        <span>翻译母语</span>
        <select aria-label="翻译母语" value={TRANSLATOR_LANGS.find((l) => isNativeLang(l.code, native))?.code ?? native} onChange={(e) => setNative(e.target.value)}>
          {TRANSLATOR_LANGS.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label} · {l.name}
            </option>
          ))}
        </select>
      </label>
      <div className="k-kv k-kv-stack">
        <span>常用外语</span>
        <div className="k-lang-chips" role="group" aria-label="常用外语">
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

/** 图标风格 picker with a live preview of each rendering. */
export function IconStyleCard() {
  const current = useIconStyle();
  return (
    <section className="k-set-card" aria-labelledby="k-iconstyle-title">
      <h2 id="k-iconstyle-title">
        <UiIcon name="spark" size={20} /> 图标风格
      </h2>
      <div className="k-iconstyle-grid" role="radiogroup" aria-label="图标风格">
        {ICON_STYLE_OPTIONS.map((o) => {
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
  const policies = useStore((s) => s.policies);
  const differs = MODE_IDS.some((m) => policies.policies[m] !== policies.defaults[m]);
  return (
    <section className="k-set-card" id="memory-policies">
      <div className="k-set-card-head">
        <h2>
          <UiIcon name="brain" size={20} /> 记忆策略
        </h2>
        <button type="button" className="k-btn k-btn-sm k-btn-ghost" disabled={!differs} onClick={() => void kesoku.resetPolicies()}>
          恢复默认
        </button>
      </div>
      <div className="k-policy-rows">
        {MODE_IDS.map((id) => {
          const m = modeMeta(id);
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
        {(['full', 'confirm_only', 'isolated'] as const).map((p) => (
          <span key={p} className="k-pill k-pill-sm k-pill-neutral">
            <UiIcon name={POLICY_BADGE[p].iconName} size={13} /> {POLICY_BADGE[p].label} = {POLICY_BADGE[p].explain}
          </span>
        ))}
      </div>
    </section>
  );
}

function Devices() {
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
      {devices === null && <div className="k-empty">载入设备列表…</div>}
      {devices?.map((d) => (
        <div key={d.device_id} className={'k-device' + (d.revoked_at ? ' is-revoked' : '')}>
          <span className="k-device-main">
            <b>
              <UiIcon name={deviceIcon(d)} size={18} /> {d.name}
              {(d.current || d.device_id === me) && <span className="k-pill k-pill-sm k-pill-primary">本机</span>}
            </b>
            <small>
              {d.platform ?? ''} · 绑定于 {new Date(d.created_at * 1000).toLocaleDateString('zh-CN')}
              {d.revoked_at ? ' · 已撤销' : ''}
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
                    .then(() => (actions.toast('已撤销'), setConfirm(null), load()))
                    .catch(() => actions.toast('撤销失败', 'error'))
                }
              >
                确认撤销
              </button>
            ) : (
              <button type="button" className="k-btn k-btn-sm k-btn-danger-ghost" onClick={() => setConfirm(d.device_id)}>
                撤销
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

/** Screen 14 · 安全配对与模型设置 */
export function SettingsScreen({ onClose }: { onClose: () => void }) {
  const conn = useStore((s) => s.conn);
  const settings = useStore((s) => s.settings);
  const authKind = useStore((s) => s.authKind);
  const email = useStore((s) => s.email);
  const head = useStore((s) => (s.currentSessionId ? s.lastSeq[s.currentSessionId] : undefined));
  const [showConn, setShowConn] = useState(false);
  const [pairHelp, setPairHelp] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{ version: string; url: string } | null>(null);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);
  const isAndroid = getPlatform() === 'android';

  const onCheckUpdate = async () => {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    setUpdateStatus(null);
    try {
      const res = await checkAndroidUpdate(APP_VERSION);
      if (res.hasUpdate) {
        setUpdateInfo({ version: res.latestVersion, url: res.downloadUrl });
        setUpdateStatus(`发现新版本 v${res.latestVersion}`);
        actions.toast(`发现新版本 v${res.latestVersion}，正在打开下载…`);
        if (typeof window !== 'undefined' && typeof window.open === 'function') {
          window.open(res.downloadUrl, '_blank', 'noopener,noreferrer');
        }
      } else {
        setUpdateInfo(null);
        setUpdateStatus(`当前已是最新版本 (v${APP_VERSION})`);
        actions.toast(`当前已是最新版本 (v${APP_VERSION})`);
      }
    } catch {
      setUpdateStatus('检查更新失败，请检查网络连接');
      actions.toast('检查更新失败，请检查网络连接', 'error');
    } finally {
      setCheckingUpdate(false);
    }
  };

  const tone = conn.status === 'online' ? (conn.engineOnline ? 'is-ok' : 'is-bad') : conn.status === 'reconnecting' ? 'is-warn' : 'is-bad';
  const status =
    conn.status === 'online'
      ? conn.engineOnline
        ? `已连接${conn.latencyMs != null ? ` · ${conn.latencyMs}ms` : ''}`
        : '离线'
      : conn.status === 'reconnecting'
        ? `重连中 (${Math.round((conn.retryInMs ?? 0) / 1000)}s)`
        : '离线';

  return (
    <div className="k-screen k-settings">
      <header className="k-screen-head">
        <button type="button" className="k-icon-btn" aria-label="返回" onClick={onClose}>
          <UiIcon name="arrow-left" size={22} />
        </button>
        <h1>设置</h1>
      </header>
      <div className="k-screen-body">
        <section className="k-set-card k-conn-card" onClick={() => setShowConn((v) => !v)} role="button" tabIndex={0}>
          <div className="k-conn-status">
            <span className={'k-conn-dot ' + tone} aria-hidden />
            {status}
          </div>
          {showConn && (
            <div className="k-conn-detail">
              <span>设备：{conn.deviceId ?? '—'}</span>
              <span>当前会话 seq：{head ?? '—'}</span>
              <span>引擎在线自：{conn.engineSince ? new Date(conn.engineSince * 1000).toLocaleString('zh-CN') : '—'}</span>
            </div>
          )}
        </section>

        <section className="k-set-card">
          <h2>
            <UiIcon name="shield" size={20} /> 身份与设备
          </h2>
          {authKind === 'google' && email && (
            <div className="k-kv">
              <span>Google 白名单</span>
              <span className="k-pill k-pill-ok k-pill-sm">{email}</span>
            </div>
          )}
          <Devices />
          <button type="button" className="k-btn k-btn-ghost k-btn-block" onClick={() => setPairHelp((v) => !v)}>
            <UiIcon name="qr" size={18} /> 配对新设备
          </button>
          {pairHelp && (
            <ol className="k-pair-help">
              <li>
                在引擎主机终端运行 <code>kesoku app pair --name "我的设备"</code>
              </li>
              <li>2 分钟内在新设备上输入显示的 6 位码</li>
              <li>连续 5 次输错该码即作废，需重新生成</li>
            </ol>
          )}
          {confirmLogout ? (
            <button
              type="button"
              className="k-btn k-btn-danger k-btn-block"
              onClick={async () => {
                await logout();
                kesoku.stop();
                actions.reset();
                useStore.setState({ auth: 'needed' });
              }}
            >
              确认退出登录（本机需重新配对）
            </button>
          ) : (
            <button type="button" className="k-btn k-btn-danger-ghost k-btn-block" onClick={() => setConfirmLogout(true)}>
              退出登录
            </button>
          )}
        </section>

        <section className="k-set-card">
          <h2>
            <UiIcon name="spark" size={20} /> 模型与思考深度
          </h2>
          <label className="k-kv">
            <span>默认模型</span>
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
            <span>通用翻译极速模型</span>
            <select value={settings.translatorModel} onChange={(e) => save({ translatorModel: e.target.value })}>
              {MODEL_CATALOG.map((m) => (
                <option key={m.model_name} value={m.model_name}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <TranslatorLangFields />
        </section>

        <section className="k-set-card">
          <h2>
            <UiIcon name="link" size={20} /> 渠道同步
          </h2>
          <label className="k-kv">
            <span>默认显示全部渠道</span>
            <input type="checkbox" role="switch" checked={settings.allChannels} onChange={(e) => save({ allChannels: e.target.checked })} />
          </label>
        </section>

        <section className="k-set-card">
          <h2>
            <UiIcon name="palette" size={20} /> 外观
          </h2>
          <div className="k-kv">
            <span>主题</span>
            <Segmented
              ariaLabel="主题"
              size="sm"
              value={settings.theme}
              onChange={(v) => save({ theme: v })}
              options={[
                { value: 'system', label: '跟随系统' },
                { value: 'light', label: '浅色' },
                { value: 'dark', label: '深色' },
              ]}
            />
          </div>
          <div className="k-kv">
            <span>字号</span>
            <Segmented
              ariaLabel="字号"
              size="sm"
              value={settings.fontSize}
              onChange={(v) => save({ fontSize: v })}
              options={[
                { value: 'standard', label: '标准' },
                { value: 'large', label: '大' },
              ]}
            />
          </div>
        </section>

        <IconStyleCard />

        <MemoryPolicyCard />

        <section className="k-set-card">
          <button type="button" className="k-link-row" onClick={() => actions.setUi({ screen: 'studio' })}>
            <span>
              <UiIcon name="persona" size={18} /> 角色与形象工坊
            </span>
            <UiIcon name="chevron-right" size={18} />
          </button>
          <button type="button" className="k-link-row" onClick={() => actions.setUi({ screen: 'files' })}>
            <span>
              <UiIcon name="folder" size={18} /> 文件管理
            </span>
            <UiIcon name="chevron-right" size={18} />
          </button>
          <div className="k-kv is-disabled">
            <span>版本</span>
            <b>Kesoku v{APP_VERSION}</b>
          </div>
          {isAndroid && (
            <div className="k-update-box" data-testid="android-update-section">
              <button
                type="button"
                className="k-btn k-btn-ghost k-check-update-btn"
                data-testid="check-update-btn"
                disabled={checkingUpdate}
                onClick={() => void onCheckUpdate()}
              >
                <UiIcon name="refresh" size={18} />
                {checkingUpdate ? '检查更新中…' : '检查更新'}
              </button>
              {updateStatus && (
                <p className="k-set-note" data-testid="update-status-text">
                  {updateStatus}
                </p>
              )}
              {updateInfo && (
                <a
                  className="k-btn k-btn-primary k-check-update-btn"
                  href={updateInfo.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="download-update-link"
                >
                  下载并安装 v{updateInfo.version} APK
                </a>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

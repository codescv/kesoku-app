import { useEffect, useState } from 'react';
import { MODEL_CATALOG, MODE_IDS, type Device, type EngineToClientPayload } from '@kesoku/protocol';
import { POLICY_BADGE, Segmented, modeMeta } from '@kesoku/ui';
import { kesoku } from '../../lib/client';
import { actions, useStore, type Settings } from '../../lib/store';
import { kvSet } from '../../lib/db';
import { logout } from '../../lib/auth';
import { getPlatform } from '../../native/platform';
import { PolicySegmented } from '../memory/PolicySegmented';

function save(patch: Partial<Settings>) {
  actions.setSettings(patch);
  void kvSet('settings', useStore.getState().settings);
}

const PLATFORM_LABEL = {
  ios: 'iOS WKWebView 原生桥 · Keychain 安全存储',
  android: 'Android · EncryptedSharedPreferences',
  web: 'Web · IndexedDB',
};

export function MemoryPolicyCard() {
  const policies = useStore((s) => s.policies);
  const differs = MODE_IDS.some((m) => policies.policies[m] !== policies.defaults[m]);
  return (
    <section className="k-set-card" id="memory-policies">
      <div className="k-set-card-head">
        <h2>🧠 各模式记忆策略 (支持单独配置)</h2>
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
                <span aria-hidden>{m.icon}</span> {m.title}
              </span>
              <PolicySegmented modeId={id} size="sm" />
            </div>
          );
        })}
      </div>
      <div className="k-policy-legend">
        {(['full', 'confirm_only', 'isolated'] as const).map((p) => (
          <span key={p} className="k-pill k-pill-sm k-pill-neutral">
            {POLICY_BADGE[p].label} = {POLICY_BADGE[p].explain}
          </span>
        ))}
      </div>
      <p className="k-set-note">无需重启会话，下一回合即按新策略执行 · 出厂默认：日常聊天 = 自动 · 其余 7 模式 = 确认</p>
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
              {d.kind === 'google' ? '🔑' : '📱'} {d.name}
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
  const platform = getPlatform();

  const status =
    conn.status === 'online'
      ? conn.engineOnline
        ? `🟢 Kesoku 引擎已连接${conn.latencyMs != null ? ` · ${conn.latencyMs}ms` : ''}`
        : '🔴 引擎离线'
      : conn.status === 'reconnecting'
        ? `🟡 重连中 (${Math.round((conn.retryInMs ?? 0) / 1000)}s)`
        : '⚪ 未连接';

  return (
    <div className="k-screen k-settings">
      <header className="k-screen-head">
        <button type="button" className="k-icon-btn" aria-label="返回" onClick={onClose}>
          ←
        </button>
        <h1>设置</h1>
      </header>
      <div className="k-screen-body">
        <section className="k-set-card k-conn-card" onClick={() => setShowConn((v) => !v)} role="button" tabIndex={0}>
          <div className="k-conn-status">{status}</div>
          <small>Cloud Relay · 单实例内存桥接 · asia-east1</small>
          {showConn && (
            <div className="k-conn-detail">
              <span>设备：{conn.deviceId ?? '—'}</span>
              <span>当前会话 seq：{head ?? '—'}</span>
              <span>引擎在线自：{conn.engineSince ? new Date(conn.engineSince * 1000).toLocaleString('zh-CN') : '—'}</span>
            </div>
          )}
        </section>

        <section className="k-set-card">
          <h2>🔐 身份与设备</h2>
          {authKind === 'google' && email && (
            <div className="k-kv">
              <span>Google 白名单</span>
              <span className="k-pill k-pill-ok k-pill-sm">{email}</span>
            </div>
          )}
          <div className="k-kv">
            <span>6位设备配对码已绑定</span>
            <b>120s一次性 · 5次错误即销毁</b>
          </div>
          <Devices />
          <button type="button" className="k-btn k-btn-ghost k-btn-block" onClick={() => setPairHelp((v) => !v)}>
            ＋ 配对新设备
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
          <h2>🤖 模型与缓存路由</h2>
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
          <p className="k-set-note">gemini-3.8-flash (Low · 极速直连 0.9s) · gemini-4-hydrogen 不支持显式缓存（只读信息）</p>
        </section>

        <section className="k-set-card">
          <h2>🔗 渠道同步</h2>
          <label className="k-kv">
            <span>默认显示全部渠道</span>
            <input type="checkbox" role="switch" checked={settings.allChannels} onChange={(e) => save({ allChannels: e.target.checked })} />
          </label>
          <div className="k-kv is-disabled">
            <span>非 app 会话发送时</span>
            <b>以普通聊天继续（固定）</b>
          </div>
        </section>

        <section className="k-set-card">
          <h2>🎨 外观</h2>
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

        <section className="k-set-card">
          <h2>🔊 语音</h2>
          <div className="k-kv is-disabled">
            <span>语音播放</span>
            <b>语音：点击才播放（设计承诺，不可关闭）</b>
          </div>
          <div className="k-kv">
            <span>朗读引擎 (通用翻译 ▶ 朗读)</span>
            <Segmented
              ariaLabel="朗读引擎"
              size="sm"
              value={settings.ttsEngine}
              onChange={(v) => save({ ttsEngine: v })}
              options={[
                { value: 'native', label: '系统原生' },
                { value: 'server', label: '服务端 qwen-tts' },
              ]}
            />
          </div>
        </section>

        <MemoryPolicyCard />

        <section className="k-set-card">
          <button type="button" className="k-link-row" onClick={() => actions.setUi({ screen: 'studio' })}>
            🎭 角色与形象工坊 ›
          </button>
          <button type="button" className="k-link-row" onClick={() => actions.setUi({ screen: 'files' })}>
            📁 Agent 目录 (band) ›
          </button>
          <div className="k-kv is-disabled">
            <span>平台</span>
            <b>{PLATFORM_LABEL[platform]}</b>
          </div>
        </section>
      </div>
    </div>
  );
}

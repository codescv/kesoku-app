import { useEffect, useState } from 'react';
import { parseDeepLink } from '../../native/deeplinks';
import { isNative } from '../../native/platform';
import { tryNativeQrScan } from '../../native/qr';
import { AuthError, getAuthConfig, getRelayBase, googleLogin, pair, preloadGoogleAuth, setRelayBase, type AuthConfig } from '../../lib/auth';
import { QrScannerModal } from './QrScannerModal';
import { UiIcon } from '@kesoku/ui';

export function AuthScreen({ onDone, initialCode, initialRelay }: { onDone: () => void; initialCode?: string; initialRelay?: string }) {
  const native = isNative();
  const [code, setCode] = useState(initialCode ?? '');
  const [relay, setRelay] = useState(initialRelay ?? '');
  const [google, setGoogle] = useState(false);
  const [authCfg, setAuthCfg] = useState<AuthConfig | null>(null);
  // Web: hold rendering until /auth/config answers so the pairing form never flashes.
  const [loadingConfig, setLoadingConfig] = useState(!native);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);

  useEffect(() => {
    if (native) {
      void getRelayBase().then((u) => setRelay((cur) => cur || u));
      return;
    }
    let alive = true;
    void getAuthConfig()
      .then((c) => {
        if (!alive) return;
        const enabled = !!c.firebase && c.google_login === true;
        setAuthCfg(c);
        setGoogle(enabled);
        if (enabled) void preloadGoogleAuth(c);
      })
      .finally(() => {
        if (alive) setLoadingConfig(false);
      });
    return () => {
      alive = false;
    };
  }, [native]);

  async function submitPairWith(targetRelay: string, targetCode: string) {
    setErr(null);
    setBusy(true);
    try {
      if (native) await setRelayBase(targetRelay.trim());
      await pair(targetCode);
      onDone();
    } catch (x) {
      setErr(x instanceof AuthError ? x.message : '网络错误，请检查中继地址');
    } finally {
      setBusy(false);
    }
  }

  /** A pasted or scanned `kesoku://pair?code=...&relay=...` link fills both fields at once. Returns true if handled. */
  function applyPairLink(text: string, autoSubmit = false): boolean {
    const trimmed = text.trim();
    if (/^kesoku:/i.test(trimmed) || /^https?:\/\//i.test(trimmed)) {
      const link = parseDeepLink(trimmed);
      if (link && link.kind === 'pair') {
        const nextRelay = link.relay || relay;
        setCode(link.code);
        if (link.relay) setRelay(link.relay);
        setErr(null);
        if (autoSubmit && (!native || nextRelay.trim().length > 0)) {
          void submitPairWith(nextRelay, link.code);
        }
        return true;
      }
    }
    if (autoSubmit && /^\d{3}[\s-]?\d{3}$/.test(trimmed)) {
      const digits = trimmed.replace(/\D/g, '');
      setCode(digits);
      setErr(null);
      if (!native || relay.trim().length > 0) {
        void submitPairWith(relay, digits);
      }
      return true;
    }
    return false;
  }

  async function handleStartQrScan() {
    setErr(null);
    const nativeOutcome = await tryNativeQrScan();
    if (nativeOutcome.status === 'scanned') {
      if (!applyPairLink(nativeOutcome.value, true)) {
        setErr('二维码不是有效的 Kesoku 配对码（请运行 kesoku app pair 生成二维码）');
      }
      return;
    }
    if (nativeOutcome.status === 'cancelled') return;
    setScannerOpen(true);
  }

  function handleModalQrDetected(value: string) {
    setScannerOpen(false);
    if (!applyPairLink(value, true)) {
      setErr('二维码不是有效的 Kesoku 配对码（请运行 kesoku app pair 生成二维码）');
    }
  }

  async function submitPair(e: React.FormEvent) {
    e.preventDefault();
    await submitPairWith(relay, code);
  }

  async function doGoogle() {
    setErr(null);
    setBusy(true);
    try {
      await googleLogin(authCfg ?? undefined);
      onDone();
    } catch (x) {
      setErr(x instanceof AuthError ? x.message : '登录失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  const showGoogleOnly = !native && !loadingConfig && google;
  const showPairing = native || (!loadingConfig && !google);

  return (
    <div className="k-auth">
      <div className="k-auth-card">
        <div className="k-auth-logo" aria-hidden>
          K
        </div>
        <h1>Kesoku</h1>
        {!native && loadingConfig && (
          <p className="k-auth-sub" aria-busy="true">
            正在加载…
          </p>
        )}
        {showGoogleOnly && (
          <>
            <p className="k-auth-sub">仅限白名单受权 Google 账号访问</p>
            {err && (
              <div className="k-auth-err" role="alert">
                {err}
              </div>
            )}
            <button type="button" className="k-btn k-btn-primary k-btn-block k-btn-lg" disabled={busy} onClick={() => void doGoogle()}>
              {busy ? '登录中…' : '使用 Google 账号登录'}
            </button>
          </>
        )}
        {showPairing && (
          <>
            <p className="k-auth-sub">连接你的自托管 Kesoku 引擎</p>
            <button
              type="button"
              className="k-btn k-btn-primary k-btn-block k-btn-lg k-qr-scan-btn"
              disabled={busy}
              onClick={() => void handleStartQrScan()}
            >
              <UiIcon name="qr" size={22} /> 扫码配对
            </button>
            <div className="k-auth-or">或手动输入配对码</div>
            <form onSubmit={submitPair} className="k-auth-form">
              {native && (
                <label className="k-field">
                  <span>中继地址</span>
                  <input
                    type="url"
                    inputMode="url"
                    required
                    placeholder="https://relay.example.com"
                    value={relay}
                    onChange={(e) => {
                      if (!applyPairLink(e.target.value)) setRelay(e.target.value);
                    }}
                    autoComplete="url"
                  />
                </label>
              )}
              <label className="k-field">
                <span>6 位配对码</span>
                <input
                  className="k-code-input"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9 ]{6,7}"
                  placeholder="483 920"
                  value={code}
                  onChange={(e) => {
                    if (!applyPairLink(e.target.value)) setCode(e.target.value.replace(/[^\d ]/g, '').slice(0, 7));
                  }}
                  aria-describedby="k-pair-hint"
                />
              </label>
              <p id="k-pair-hint" className="k-auth-hint">
                在引擎主机运行 <code>kesoku app pair</code>，扫码或 2 分钟内输入 · 连续 5 次错误即作废
              </p>
              {err && (
                <div className="k-auth-err" role="alert">
                  {err}
                </div>
              )}
              <button type="submit" className="k-btn k-btn-primary k-btn-block k-btn-lg" disabled={busy || code.replace(/\D/g, '').length !== 6}>
                {busy ? '连接中…' : '配对并连接'}
              </button>
            </form>
            {scannerOpen && (
              <QrScannerModal
                onDetect={handleModalQrDetected}
                onClose={() => setScannerOpen(false)}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

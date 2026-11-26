import { useEffect, useState } from 'react';
import { parseDeepLink } from '../../native/deeplinks';
import { isNative } from '../../native/platform';
import { tryNativeQrScan } from '../../native/qr';
import { AuthError, getAuthConfig, getRelayBase, googleLogin, pair, preloadGoogleAuth, setRelayBase, type AuthConfig } from '../../lib/auth';
import { QrScannerModal } from './QrScannerModal';
import { UiIcon, useT } from '@kesoku/ui';

export function AuthScreen({ onDone, initialCode, initialRelay }: { onDone: () => void; initialCode?: string; initialRelay?: string }) {
  const tr = useT();
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
      setErr(x instanceof AuthError ? x.message : tr('auth.networkError'));
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
        setErr(tr('auth.invalidQr'));
      }
      return;
    }
    if (nativeOutcome.status === 'cancelled') return;
    setScannerOpen(true);
  }

  function handleModalQrDetected(value: string) {
    setScannerOpen(false);
    if (!applyPairLink(value, true)) {
      setErr(tr('auth.invalidQr'));
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
      setErr(x instanceof AuthError ? x.message : tr('auth.loginFailedRetry'));
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
          <img src="/icons/icon.svg" alt="" width={64} height={64} />
        </div>
        <h1>Kesoku</h1>
        {!native && loadingConfig && (
          <p className="k-auth-sub" aria-busy="true">
            {tr('auth.loading')}
          </p>
        )}
        {showGoogleOnly && (
          <>
            <p className="k-auth-sub">{tr('auth.googleOnlySub')}</p>
            {err && (
              <div className="k-auth-err" role="alert">
                {err}
              </div>
            )}
            <button type="button" className="k-btn k-btn-primary k-btn-block k-btn-lg" disabled={busy} onClick={() => void doGoogle()}>
              {busy ? tr('auth.signingIn') : tr('auth.signInWithGoogle')}
            </button>
          </>
        )}
        {showPairing && (
          <>
            <p className="k-auth-sub">{tr('auth.pairSub')}</p>
            <button
              type="button"
              className="k-btn k-btn-primary k-btn-block k-btn-lg k-qr-scan-btn"
              disabled={busy}
              onClick={() => void handleStartQrScan()}
            >
              <UiIcon name="qr" size={22} /> {tr('auth.scanQrPair')}
            </button>
            <div className="k-auth-or">{tr('auth.orManualCode')}</div>
            <form onSubmit={submitPair} className="k-auth-form">
              {native && (
                <label className="k-field">
                  <span>{tr('auth.relayUrl')}</span>
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
                <span>{tr('auth.sixDigitCode')}</span>
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
                {tr('auth.pairHintBefore')}
                <code>kesoku app pair</code>
                {tr('auth.pairHintAfter')}
              </p>
              {err && (
                <div className="k-auth-err" role="alert">
                  {err}
                </div>
              )}
              <button type="submit" className="k-btn k-btn-primary k-btn-block k-btn-lg" disabled={busy || code.replace(/\D/g, '').length !== 6}>
                {busy ? tr('auth.connecting') : tr('auth.pairAndConnect')}
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

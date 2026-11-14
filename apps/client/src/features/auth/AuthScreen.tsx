import { useEffect, useState } from 'react';
import { isNative } from '../../native/platform';
import { AuthError, getAuthConfig, getRelayBase, googleLogin, pair, setRelayBase } from '../../lib/auth';

export function AuthScreen({ onDone, initialCode }: { onDone: () => void; initialCode?: string }) {
  const native = isNative();
  const [code, setCode] = useState(initialCode ?? '');
  const [relay, setRelay] = useState('');
  const [google, setGoogle] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (native) void getRelayBase().then(setRelay);
    else void getAuthConfig().then((c) => setGoogle(!!c.firebase && c.google_login !== false));
  }, [native]);

  async function submitPair(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      if (native) await setRelayBase(relay.trim());
      await pair(code);
      onDone();
    } catch (x) {
      setErr(x instanceof AuthError ? x.message : '网络错误，请检查中继地址');
    } finally {
      setBusy(false);
    }
  }

  async function doGoogle() {
    setErr(null);
    setBusy(true);
    try {
      await googleLogin();
      onDone();
    } catch (x) {
      setErr(x instanceof AuthError ? x.message : '登录已取消或失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="k-auth">
      <div className="k-auth-card">
        <div className="k-auth-logo" aria-hidden>
          K
        </div>
        <h1>Kesoku</h1>
        <p className="k-auth-sub">连接你的自托管 Kesoku 引擎</p>
        {!native && google && (
          <>
            <button type="button" className="k-btn k-btn-primary k-btn-block k-btn-lg" disabled={busy} onClick={() => void doGoogle()}>
              使用 Google 一键登录
            </button>
            <div className="k-auth-or">或使用配对码</div>
          </>
        )}
        <form onSubmit={submitPair} className="k-auth-form">
          {native && (
            <label className="k-field">
              <span>中继地址</span>
              <input type="url" inputMode="url" required placeholder="https://kesoku-relay-xxxx.a.run.app" value={relay} onChange={(e) => setRelay(e.target.value)} autoComplete="url" />
            </label>
          )}
          <label className="k-field">
            <span>6 位配对码</span>
            <input
              className="k-code-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,7}"
              maxLength={7}
              placeholder="483 920"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))}
              aria-describedby="k-pair-hint"
            />
          </label>
          <p id="k-pair-hint" className="k-auth-hint">
            在引擎主机运行 <code>kesoku app pair</code>，2 分钟内输入 · 连续 5 次错误即作废
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
      </div>
    </div>
  );
}

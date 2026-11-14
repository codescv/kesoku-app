import { useEffect, useRef, useState } from 'react';
import { modeMeta } from '@kesoku/ui';
import { kesoku } from '../../lib/client';
import { actions, useStore } from '../../lib/store';
import { compressImage, HoldRecorder } from '../../lib/files';
import { pickImages } from '../../native/camera';

interface Pending {
  file: File;
  preview: string;
}

/**
 * Persistent bottom dock (Plan A: no tab bar): always-visible multi-line text box + 📷 + 🎙️ + send.
 * travel_companion / translator / pokemon_assistant keep the keyboard box visible at all times (iron rule).
 */
export function Composer({ sessionId, modeId, readOnly, roleName }: { sessionId: string | null; modeId: string; readOnly?: boolean; roleName: string }) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Pending[]>([]);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [listenOther, setListenOther] = useState(false);
  const online = useStore((s) => s.conn.status === 'online');
  const insert = useStore((s) => s.ui.composerInsert);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const recRef = useRef<HoldRecorder | null>(null);
  const meta = modeMeta(modeId);

  useEffect(() => {
    if (!insert) return;
    setText((t) => (t ? `${t} ${insert.text}` : insert.text));
    taRef.current?.focus();
  }, [insert]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(160, ta.scrollHeight)}px`;
  }, [text]);

  useEffect(() => () => files.forEach((f) => URL.revokeObjectURL(f.preview)), [files]);

  const placeholder = modeId === 'chat' ? `发消息给${roleName}...` : meta.placeholder;
  const canSend = online && !busy && (text.trim().length > 0 || files.length > 0);

  async function send(extraFiles: File[] = []) {
    if (!online) return;
    const body = text.trim();
    const all = [...files.map((f) => f.file), ...extraFiles];
    if (!body && !all.length) return;
    setBusy(true);
    try {
      const sid = sessionId ?? (await kesoku.ensureSession());
      const attachments = [];
      for (const f of all) attachments.push(await kesoku.upload(f, 'message', sid));
      let msg = body;
      if (!msg && all.some((f) => f.type.startsWith('image/'))) {
        if (modeId === 'pokemon_assistant') msg = '识别画面中的宝可梦并给出弱点';
        else if (modeId === 'translator') msg = '翻译图片中的文字';
      }
      if (!msg && all.some((f) => f.type.startsWith('audio/')) && modeId === 'translator') msg = listenOther ? '【听对方说】翻译成中文' : '【按住说】翻译成对方语言';
      setText('');
      setFiles([]);
      await kesoku.sendMessage(sid, msg, attachments);
    } catch {
      actions.toast('上传失败，请重试', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function onPick() {
    const picked = await pickImages(6 - files.length);
    const next: Pending[] = [];
    for (const f of picked.slice(0, 6 - files.length)) {
      const c = await compressImage(f);
      next.push({ file: c, preview: URL.createObjectURL(c) });
    }
    setFiles((x) => [...x, ...next]);
  }

  async function micDown() {
    if (!HoldRecorder.supported()) return actions.toast('此设备不支持录音');
    try {
      recRef.current = new HoldRecorder();
      await recRef.current.start();
      setRecording(true);
    } catch {
      actions.toast('无法访问麦克风', 'error');
    }
  }
  async function micUp() {
    if (!recRef.current) return;
    setRecording(false);
    const f = await recRef.current.stop();
    recRef.current = null;
    if (f) await send([f]);
  }

  if (readOnly) return null;

  return (
    <div className="k-composer" style={{ ['--mode' as string]: meta.color }}>
      {modeId === 'translator' && (
        <div className="k-composer-sub">
          <button type="button" className={'k-pill k-pill-sm ' + (!listenOther ? 'is-active' : 'k-pill-neutral')} onClick={() => setListenOther(false)}>
            🎙️ 按住说
          </button>
          <button type="button" className={'k-pill k-pill-sm ' + (listenOther ? 'is-active' : 'k-pill-neutral')} onClick={() => setListenOther(true)}>
            👂 听对方说
          </button>
        </div>
      )}
      {files.length > 0 && (
        <div className="k-composer-files">
          {files.map((f, i) => (
            <span key={f.preview} className="k-thumb">
              <img src={f.preview} alt={`图${i + 1}`} />
              <span className="k-thumb-label">图{i + 1}</span>
              <button type="button" aria-label="移除" onClick={() => setFiles((x) => x.filter((_, j) => j !== i))}>
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="k-composer-row">
        <textarea
          ref={taRef}
          className="k-composer-input"
          rows={1}
          value={text}
          placeholder={recording ? '正在录音… 松开发送' : placeholder}
          lang={modeId === 'jp_classroom' ? 'ja' : undefined}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (canSend) void send();
            }
          }}
          aria-label="消息输入框"
        />
        <button type="button" className="k-composer-btn" aria-label="拍照或选图" onClick={() => void onPick()} disabled={busy}>
          📷
        </button>
        <button
          type="button"
          className={'k-composer-btn' + (recording ? ' is-recording' : '')}
          aria-label="按住说话"
          onPointerDown={(e) => {
            e.preventDefault();
            void micDown();
          }}
          onPointerUp={() => void micUp()}
          onPointerLeave={() => recording && void micUp()}
          disabled={busy || !online}
        >
          🎙️
        </button>
        <button type="button" className="k-composer-send" aria-label="发送" disabled={!canSend} onClick={() => void send()}>
          ↑
        </button>
      </div>
    </div>
  );
}

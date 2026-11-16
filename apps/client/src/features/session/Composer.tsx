import { useEffect, useRef, useState } from 'react';
import { UiIcon, modeMeta } from '@kesoku/ui';
import { kesoku } from '../../lib/client';
import { actions, useStore } from '../../lib/store';
import { compressImage, HoldRecorder } from '../../lib/files';
import { pickImages } from '../../native/camera';
import { resolveTranslatorPair, translatorLangLabel, type TranslatorPair } from '@kesoku/hud';
import { mergeTranslatorModePrefs } from '../../lib/translatorPrefs';

/**
 * Translator voice prompt: 【我说】 = I speak my 母语 → translate into the active foreign language;
 * 【听对方说】 = the other person speaks the foreign language → translate into my 母语.
 */
export function translatorVoicePrompt(listenOther: boolean, pair: Pick<TranslatorPair, 'nativeLang' | 'foreign'>): string {
  const native = translatorLangLabel(pair.nativeLang);
  const foreign = translatorLangLabel(pair.foreign);
  return listenOther ? `【听对方说】对方说${foreign}，翻译成我的母语${native}` : `【我说】我说${native}，翻译成${foreign}`;
}

const EMPTY_PREFS: Record<string, unknown> = {};

function fmtSec(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

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
  const [recordSec, setRecordSec] = useState(0);
  const [busy, setBusy] = useState(false);
  const [listenOther, setListenOther] = useState(false);
  const online = useStore((s) => s.conn.status === 'online');
  const insert = useStore((s) => s.ui.composerInsert);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const recRef = useRef<HoldRecorder | null>(null);
  const meta = modeMeta(modeId);
  const modePrefs = useStore((s) => (sessionId ? s.modePrefs[sessionId] : undefined)) ?? EMPTY_PREFS;
  const stateFiles = useStore((s) => (sessionId ? s.stateFiles[sessionId] : undefined)) ?? EMPTY_PREFS;
  const settings = useStore((s) => s.settings);

  useEffect(() => {
    if (!insert) return;
    setText((t) => (t ? `${t} ${insert.text}` : insert.text));
    taRef.current?.focus();
  }, [insert]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = '';
    if (!text) return;
    if (ta.scrollHeight > ta.clientHeight + 2) {
      const border = ta.offsetHeight - ta.clientHeight;
      ta.style.height = `${Math.min(160, ta.scrollHeight + border)}px`;
    }
  }, [text]);

  useEffect(() => () => files.forEach((f) => URL.revokeObjectURL(f.preview)), [files]);

  useEffect(() => {
    if (!recording) return;
    setRecordSec(0);
    const t = setInterval(() => setRecordSec((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  // Leaving the screen mid-recording discards it (and releases the microphone).
  useEffect(
    () => () => {
      recRef.current?.cancel();
      recRef.current = null;
    },
    [],
  );

  const placeholder = modeId === 'chat' ? `发消息给${roleName}...` : meta.placeholder;
  const hasText = text.trim().length > 0;
  const hasFiles = files.length > 0;
  const canSend = online && !busy && (hasText || hasFiles);
  const rowStateClass = hasText ? ' has-text' : hasFiles ? ' has-files' : ' is-empty';

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
      if (!msg && all.some((f) => f.type.startsWith('audio/')) && modeId === 'translator') {
        msg = translatorVoicePrompt(listenOther, resolveTranslatorPair(mergeTranslatorModePrefs(modePrefs, settings), stateFiles));
      }
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

  async function startRecording() {
    if (recording || recRef.current) return;
    if (!HoldRecorder.supported()) return actions.toast('此设备不支持录音');
    const rec = new HoldRecorder();
    recRef.current = rec;
    try {
      await rec.start();
      if (recRef.current !== rec) return; // cancelled / unmounted while opening the mic
      setRecordSec(0);
      setRecording(true);
    } catch {
      if (recRef.current === rec) {
        recRef.current = null;
        actions.toast('无法访问麦克风', 'error');
      }
    }
  }
  function cancelRecording() {
    recRef.current?.cancel();
    recRef.current = null;
    setRecording(false);
    setRecordSec(0);
  }
  async function confirmRecording() {
    const rec = recRef.current;
    if (!rec) return;
    recRef.current = null;
    setRecording(false);
    setRecordSec(0);
    const f = await rec.stop();
    if (f) await send([f]);
    else actions.toast('没有录到声音');
  }

  if (readOnly) return null;

  return (
    <div className="k-composer" style={{ ['--mode' as string]: meta.color }}>
      {modeId === 'translator' && (
        <div className="k-composer-sub">
          <button
            type="button"
            className={'k-pill k-pill-sm ' + (!listenOther ? 'is-active' : 'k-pill-neutral')}
            aria-pressed={!listenOther}
            title="录下我说的母语，翻译成外语"
            onClick={() => {
              setListenOther(false);
              void startRecording();
            }}
          >
            <UiIcon name="mic" size={14} /> 我说（译外语）
          </button>
          <button
            type="button"
            className={'k-pill k-pill-sm ' + (listenOther ? 'is-active' : 'k-pill-neutral')}
            aria-pressed={listenOther}
            title="录下对方说的外语，翻译成我的母语"
            onClick={() => {
              setListenOther(true);
              void startRecording();
            }}
          >
            <UiIcon name="volume" size={14} /> 听对方说（译母语）
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
                <UiIcon name="close" size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {recording ? (
        <div className="k-composer-row k-rec-bar" data-testid="composer-recording-bar">
          <button type="button" className="k-rec-cancel" aria-label="取消录音" onClick={cancelRecording}>
            <UiIcon name="close" size={18} /> 取消
          </button>
          <div className="k-rec-status" role="status">
            <span className="k-rec-dot" aria-hidden /> <span>录音中 {fmtSec(recordSec)}</span>
          </div>
          <button type="button" className="k-rec-send" aria-label="发送语音" disabled={busy} onClick={() => void confirmRecording()}>
            <UiIcon name="check" size={18} /> 发送
          </button>
        </div>
      ) : (
        <div className={'k-composer-row' + rowStateClass}>
          <textarea
            ref={taRef}
            className="k-composer-input"
            rows={1}
            value={text}
            placeholder={placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (canSend) void send();
              }
            }}
            aria-label="消息输入框"
          />
          <button type="button" className="k-composer-btn k-composer-cam" aria-label="拍照或选图" onClick={() => void onPick()} disabled={busy}>
            <UiIcon name="camera" size={22} />
          </button>
          <button type="button" className="k-composer-btn k-composer-mic" aria-label="开始语音输入" onClick={() => void startRecording()} disabled={busy || !online}>
            <UiIcon name="mic" size={22} />
          </button>
          <button type="button" className="k-composer-send" aria-label="发送" disabled={!canSend} onClick={() => void send()}>
            <UiIcon name="send" size={22} />
          </button>
        </div>
      )}
    </div>
  );
}

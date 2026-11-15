import { useEffect, useRef, useState } from 'react';
import { pickImages } from '../../native/camera';
import { decodeQrFromBlob, decodeQrFromSource } from '../../native/qr';
import { UiIcon } from '@kesoku/ui';

export function QrScannerModal({
  onDetect,
  onClose,
}: {
  onDetect: (value: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [camState, setCamState] = useState<'starting' | 'ready' | 'unavailable'>('starting');
  const [hint, setHint] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    let active = true;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    const canvas = document.createElement('canvas');

    async function startCamera() {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        if (active) setCamState('unavailable');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
        if (!active) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => undefined);
        }
        setCamState('ready');
        let scanningFrame = false;
        timer = setInterval(() => {
          const v = videoRef.current;
          if (!active || scanningFrame || !v || v.readyState < 2 || v.videoWidth <= 0) return;
          scanningFrame = true;
          void decodeQrFromSource(v, canvas)
            .then((decoded) => {
              if (active && decoded) {
                onDetect(decoded);
              }
            })
            .finally(() => {
              scanningFrame = false;
            });
        }, 120);
      } catch {
        if (active) setCamState('unavailable');
      }
    }

    void startCamera();

    return () => {
      active = false;
      if (timer) clearInterval(timer);
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }
    };
  }, [onDetect]);

  async function handlePickImage() {
    setHint(null);
    setPicking(true);
    try {
      const files = await pickImages(1, { source: 'gallery' });
      const file = files[0];
      if (!file) return;
      const decoded = await decodeQrFromBlob(file);
      if (decoded) {
        onDetect(decoded);
      } else {
        setHint('未在所选图片中识别到二维码，请确保二维码清晰完整');
      }
    } catch {
      setHint('读取图片失败，请重试');
    } finally {
      setPicking(false);
    }
  }

  return (
    <div className="k-modal-backdrop" role="dialog" aria-modal="true" aria-label="扫描配对二维码" onClick={onClose}>
      <div className="k-modal k-qr-modal" onClick={(e) => e.stopPropagation()}>
        <div className="k-qr-head">
          <strong className="k-ico-label">
            <UiIcon name="qr" size={20} /> 扫描配对二维码
          </strong>
          <button type="button" className="k-icon-btn" aria-label="关闭扫码" onClick={onClose}>
            <UiIcon name="close" size={20} />
          </button>
        </div>

        <div className="k-qr-stage">
          <video ref={videoRef} className="k-qr-video" playsInline muted autoPlay />
          {camState === 'ready' && (
            <div className="k-qr-reticle" aria-hidden>
              <span className="k-qr-corner tl" />
              <span className="k-qr-corner tr" />
              <span className="k-qr-corner bl" />
              <span className="k-qr-corner br" />
            </div>
          )}
          {camState === 'starting' && <div className="k-qr-overlay-msg">正在开启摄像头…</div>}
          {camState === 'unavailable' && (
            <div className="k-qr-overlay-msg">
              当前环境无法直接打开摄像头预览，请点击下方按钮拍照或从相册选择二维码图片
            </div>
          )}
        </div>

        <p className="k-auth-hint" style={{ marginTop: 10 }}>
          在引擎主机运行 <code>kesoku app pair</code>，将摄像头对准终端二维码即可自动填入并连接
        </p>

        {hint && (
          <div className="k-auth-err" role="alert">
            {hint}
          </div>
        )}

        <div className="k-qr-actions">
          <button
            type="button"
            className="k-btn k-btn-ghost k-btn-block"
            disabled={picking}
            onClick={() => void handlePickImage()}
          >
            {picking ? (
              '识别中…'
            ) : (
              <>
                <UiIcon name="image" size={18} /> 从相册 / 拍照识别二维码
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

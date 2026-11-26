import { useEffect, useRef, useState } from 'react';
import { ensureCameraPermission, pickImages } from '../../native/camera';
import { decodeQrFromBlob, decodeQrFromSource } from '../../native/qr';
import { UiIcon, useT } from '@kesoku/ui';

export function QrScannerModal({
  onDetect,
  onClose,
}: {
  onDetect: (value: string) => void;
  onClose: () => void;
}) {
  const tr = useT();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [camState, setCamState] = useState<'starting' | 'ready' | 'unavailable'>('starting');
  const [hint, setHint] = useState<string | null>(null);
  const [picking, setPicking] = useState<'camera' | 'gallery' | null>(null);

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
        await ensureCameraPermission();
        if (!active) return;
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

  async function handlePickImage(source: 'camera' | 'gallery') {
    setHint(null);
    setPicking(source);
    try {
      const files = await pickImages(1, { source });
      const file = files[0];
      if (!file) return;
      const decoded = await decodeQrFromBlob(file);
      if (decoded) {
        onDetect(decoded);
      } else {
        setHint(tr('qr.notFound'));
      }
    } catch {
      setHint(tr('qr.readFailed'));
    } finally {
      setPicking(null);
    }
  }

  return (
    <div className="k-modal-backdrop" role="dialog" aria-modal="true" aria-label={tr('qr.modalAria')} onClick={onClose}>
      <div className="k-modal k-qr-modal" onClick={(e) => e.stopPropagation()}>
        <div className="k-qr-head">
          <strong className="k-ico-label">
            <UiIcon name="qr" size={20} /> {tr('qr.title')}
          </strong>
          <button type="button" className="k-icon-btn" aria-label={tr('qr.closeAria')} onClick={onClose}>
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
          {camState === 'starting' && <div className="k-qr-overlay-msg">{tr('qr.startingCamera')}</div>}
          {camState === 'unavailable' && <div className="k-qr-overlay-msg">{tr('qr.cameraUnavailable')}</div>}
        </div>

        <p className="k-auth-hint" style={{ marginTop: 10 }}>
          {tr('qr.hintBefore')}
          <code>kesoku app pair</code>
          {tr('qr.hintAfter')}
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
            data-testid="qr-take-photo"
            disabled={!!picking}
            onClick={() => void handlePickImage('camera')}
          >
            {picking === 'camera' ? (
              tr('qr.decoding')
            ) : (
              <>
                <UiIcon name="camera" size={18} /> {tr('qr.takePhoto')}
              </>
            )}
          </button>
          <button
            type="button"
            className="k-btn k-btn-ghost k-btn-block"
            data-testid="qr-pick-gallery"
            disabled={!!picking}
            onClick={() => void handlePickImage('gallery')}
          >
            {picking === 'gallery' ? (
              tr('qr.decoding')
            ) : (
              <>
                <UiIcon name="image" size={18} /> {tr('qr.pickGallery')}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

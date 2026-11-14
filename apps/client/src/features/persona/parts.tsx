import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Sheet } from '@kesoku/ui';
import { checkAvatarFile } from './model';
import { actions } from '../../lib/store';

/** Accessible on/off switch (≥44px hit area). */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={'ps-switch' + (checked ? ' is-on' : '')}
      onClick={() => onChange(!checked)}
    >
      <span className="ps-switch-dot" aria-hidden />
    </button>
  );
}

/** Button that opens the file picker (image only) and validates type / size before handing over the file. */
export function PickImageButton({
  children,
  onPick,
  className,
  disabled,
  label,
}: {
  children: ReactNode;
  onPick: (file: File) => void;
  className?: string;
  disabled?: boolean;
  label?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className={className} disabled={disabled} onClick={() => ref.current?.click()}>
        {children}
      </button>
      <input
        ref={ref}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
        className="ps-file"
        aria-label={label ?? '选择图片'}
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          const err = checkAvatarFile(f);
          if (err) {
            actions.toast(err, 'error');
            return;
          }
          onPick(f);
        }}
      />
    </>
  );
}

/** Object URL for a local blob preview (revoked on change / unmount). */
export function useObjectUrl(blob: Blob | null): string | null {
  const url = useMemo(() => {
    if (!blob || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
    try {
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  }, [blob]);
  useEffect(
    () => () => {
      if (url && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
    },
    [url],
  );
  return url;
}

export function makePreviewUrl(blob: Blob): string | null {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  try {
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

const VIEW = 280;
const OUT = 1024;

/**
 * 1:1 crop preview: drag to reframe, slider to zoom. Confirm renders a square JPEG; if the browser
 * cannot decode the image (e.g. HEIC) or has no canvas, the original file is used (the engine
 * center-crops on its side).
 */
export function CropSheet({ file, onCancel, onConfirm }: { file: File; onCancel: () => void; onConfirm: (blob: File) => void }) {
  const url = useObjectUrl(file);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [broken, setBroken] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const imgRef = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const scale = nat ? (VIEW / Math.min(nat.w, nat.h)) * zoom : 1;
  const clamp = (o: { x: number; y: number }, s = scale) => {
    if (!nat) return o;
    const mx = Math.max(0, (nat.w * s - VIEW) / 2);
    const my = Math.max(0, (nat.h * s - VIEW) / 2);
    return { x: Math.max(-mx, Math.min(mx, o.x)), y: Math.max(-my, Math.min(my, o.y)) };
  };

  function onDown(e: ReactPointerEvent) {
    drag.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  }
  function onMove(e: ReactPointerEvent) {
    const d = drag.current;
    if (!d) return;
    setOff(clamp({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y }));
  }

  async function confirm() {
    const img = imgRef.current;
    if (!img || !nat || broken) return onConfirm(file);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = OUT;
      canvas.height = OUT;
      const ctx = canvas.getContext('2d');
      if (!ctx || typeof canvas.toBlob !== 'function') return onConfirm(file);
      const side = VIEW / scale;
      const sx = nat.w / 2 - off.x / scale - side / 2;
      const sy = nat.h / 2 - off.y / scale - side / 2;
      ctx.drawImage(img, sx, sy, side, side, 0, 0, OUT, OUT);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
      onConfirm(blob ? new File([blob], 'avatar.jpg', { type: 'image/jpeg' }) : file);
    } catch {
      onConfirm(file);
    }
  }

  return (
    <Sheet open onClose={onCancel} title="裁切头像 · 1:1" className="ps-crop">
      <div className="ps-crop-body">
        <div
          className="ps-crop-view"
          style={{ width: VIEW, height: VIEW }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
        >
          {url && !broken ? (
            <img
              ref={imgRef}
              src={url}
              alt="裁切预览"
              draggable={false}
              onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth || VIEW, h: e.currentTarget.naturalHeight || VIEW })}
              onError={() => setBroken(true)}
              style={
                nat
                  ? {
                      width: nat.w * scale,
                      height: nat.h * scale,
                      transform: `translate(calc(-50% + ${off.x}px), calc(-50% + ${off.y}px))`,
                    }
                  : undefined
              }
            />
          ) : (
            <span className="ps-crop-na">无法预览此格式 · 将按中心裁切</span>
          )}
          <span className="ps-crop-ring" aria-hidden />
        </div>
        <label className="ps-crop-zoom">
          <span>缩放</span>
          <input
            type="range"
            min={1}
            max={3}
            step={0.05}
            value={zoom}
            disabled={!nat || broken}
            onChange={(e) => {
              const z = Number(e.target.value);
              setZoom(z);
              if (nat) setOff((o) => clamp(o, (VIEW / Math.min(nat.w, nat.h)) * z));
            }}
          />
        </label>
        <div className="ps-dock ps-dock-inline">
          <button type="button" className="ps-btn ps-btn-sec" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="ps-btn ps-btn-pri" onClick={() => void confirm()}>
            ✓ 使用此图
          </button>
        </div>
      </div>
    </Sheet>
  );
}

export function Counter({ n, max, warnAt }: { n: number; max: number; warnAt?: number }) {
  const tone = n > max ? 'is-err' : warnAt !== undefined && n > warnAt ? 'is-warn' : '';
  return <span className={'ps-count ' + tone}>{`${n} / ${warnAt ?? max}`}</span>;
}

export function FieldError({ id, text }: { id: string; text?: string }) {
  if (!text) return null;
  return (
    <span id={id} className="ps-err" role="alert">
      {text}
    </span>
  );
}

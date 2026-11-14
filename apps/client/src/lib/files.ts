/** Downscale an image to long edge ≤ 2048 px (UI doc §5 attachments) and re-encode as JPEG/WebP. */
export async function compressImage(file: File, maxEdge = 2048): Promise<File> {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type)) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024) {
      bitmap.close?.();
      return file;
    }
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    if (!g) return file;
    g.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.86));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

/** Tap-to-record voice recorder (MediaRecorder on Web; WebView MediaRecorder on Android/iOS). */
export class HoldRecorder {
  private rec: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private stream: MediaStream | null = null;
  private cancelled = false;

  static supported(): boolean {
    return typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  async start(): Promise<void> {
    this.cancelled = false;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (this.cancelled) {
      // cancel() arrived while the permission prompt / device was opening.
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('cancelled');
    }
    this.stream = stream;
    const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported?.(m)) ?? '';
    this.rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start();
  }

  async stop(): Promise<File | null> {
    const rec = this.rec;
    if (!rec) return null;
    if (rec.state !== 'inactive') {
      const done = new Promise<void>((r) => (rec.onstop = () => r()));
      rec.stop();
      await done;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.rec = null;
    const type = rec.mimeType || 'audio/webm';
    if (!this.chunks.length) return null;
    const ext = type.includes('mp4') ? 'm4a' : 'webm';
    const file = new File(this.chunks, `voice-${Date.now()}.${ext}`, { type: type.split(';')[0] });
    this.chunks = [];
    return file;
  }

  /** Discard the recording: nothing is emitted or sent. */
  cancel(): void {
    this.cancelled = true;
    if (this.rec) {
      this.rec.ondataavailable = null;
      this.rec.onstop = null;
      try {
        if (this.rec.state !== 'inactive') this.rec.stop();
      } catch {
        /* ignore */
      }
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.rec = null;
    this.chunks = [];
  }
}

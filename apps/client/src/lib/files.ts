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

/** Hold-to-talk recorder (MediaRecorder on Web; WebView MediaRecorder on Android/iOS). */
export class HoldRecorder {
  private rec: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private stream: MediaStream | null = null;

  static supported(): boolean {
    return typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported?.(m)) ?? '';
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start();
  }

  async stop(): Promise<File | null> {
    const rec = this.rec;
    if (!rec) return null;
    const done = new Promise<void>((r) => (rec.onstop = () => r()));
    rec.stop();
    await done;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.rec = null;
    const type = rec.mimeType || 'audio/webm';
    if (!this.chunks.length) return null;
    const ext = type.includes('mp4') ? 'm4a' : 'webm';
    return new File(this.chunks, `voice-${Date.now()}.${ext}`, { type: type.split(';')[0] });
  }

  cancel(): void {
    try {
      this.rec?.stop();
    } catch {
      /* ignore */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.rec = null;
    this.chunks = [];
  }
}

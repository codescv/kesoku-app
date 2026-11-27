import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MessageRecord } from '@kesoku/protocol';

const m = vi.hoisted(() => ({
  resolveMedia: vi.fn(async () => 'https://cdn.invalid/media.png' as string | null),
  retry: vi.fn(),
  upload: vi.fn(),
  sendMessage: vi.fn(),
  ensureSession: vi.fn(async () => 's1'),
}));
vi.mock('../../src/lib/client', () => ({ kesoku: m }));

const camMock = vi.hoisted(() => ({
  pickImages: vi.fn(async () => [] as File[]),
}));
vi.mock('../../src/native/camera', () => camMock);

import {
  UserAttachmentItem,
  UserImageThumb,
  isAudioAttachment,
  isImageAttachment,
  MessageList,
} from '../../src/features/session/MessageList';
import { Composer } from '../../src/features/session/Composer';
import { useOverlays } from '../../src/features/session/overlays';
import { __mediaCacheTest, getCachedImageUrl, putCachedImage } from '../../src/lib/mediaCache';
import { initialState, recordToItem, splitAttachmentListing, useStore } from '../../src/lib/store';

let blobSeq = 0;

beforeEach(async () => {
  blobSeq = 0;
  useStore.setState(initialState(), true);
  useStore.setState((s) => ({ conn: { ...s.conn, status: 'online' } }));
  m.resolveMedia.mockReset().mockResolvedValue('https://cdn.invalid/media.png');
  m.upload.mockReset();
  m.sendMessage.mockReset().mockResolvedValue(undefined);
  camMock.pickImages.mockReset().mockResolvedValue([]);
  useOverlays.setState({ fullscreen: null, peek: null, image: null });
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:thumb/${++blobSeq}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  await __mediaCacheTest.resetAll();
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await __mediaCacheTest.resetAll();
});

describe('UserAttachmentItem & UserImageThumb', () => {
  it('classifies audio by MIME or extension and images separately', () => {
    expect(isAudioAttachment({ mime: 'audio/mp4' })).toBe(true);
    for (const f of ['v.m4a', 'v.webm', 'v.wav', 'v.mp3', 'v.ogg', 'v.aac', 'v.flac']) {
      expect(isAudioAttachment({ mime: 'application/octet-stream', filename: f })).toBe(true);
    }
    expect(isAudioAttachment({ mime: 'image/png', filename: 'a.png' })).toBe(false);
    expect(isImageAttachment({ mime: 'image/jpeg' })).toBe(true);
    expect(isImageAttachment({ mime: 'audio/webm' })).toBe(false);
  });

  it('renders a playable voice pill (语音) for a recorded voice message, never 图1', async () => {
    m.resolveMedia.mockResolvedValue('https://cdn.invalid/clip.m4a');
    render(<UserAttachmentItem a={{ object: 'media/s1/v.webm', mime: 'audio/webm', filename: 'v.webm' }} index={0} sessionId="s1" messageId="u1" />);
    expect(document.body.textContent).not.toContain('图1');
    expect(document.querySelector('[data-ui-icon="image"]')).toBeNull();
    const pill = screen.getByRole('button', { name: '播放语音' });
    expect(pill.textContent).toContain('语音');
    fireEvent.click(pill);
    await waitFor(() => expect(m.resolveMedia).toHaveBeenCalledWith({ object: 'media/s1/v.webm', ref: undefined, url: undefined }, { sessionId: 's1', messageId: 'u1' }));
  });

  it('uses the history ref when no object is known and shows a known duration', () => {
    render(<UserAttachmentItem a={{ object: '', ref: '/ws/u/v.m4a', mime: 'audio/mp4', duration_ms: 3000 }} index={0} sessionId="s1" />);
    expect(screen.getByRole('button', { name: '播放语音' }).textContent).toContain('0:03');
  });

  it('renders real image thumbnail for image attachments and opens ImageLightbox on click', async () => {
    m.resolveMedia.mockResolvedValue('https://cdn.invalid/p.png');
    render(<UserAttachmentItem a={{ object: 'media/s1/p.png', mime: 'image/png', filename: 'p.png' }} index={1} sessionId="s1" messageId="u1" />);
    const btn = screen.getByRole('button', { name: '查看图2' });
    await waitFor(() => expect(btn.querySelector('img')?.getAttribute('src')).toBe('https://cdn.invalid/p.png'));
    fireEvent.click(btn);
    expect(useOverlays.getState().image?.url).toBe('https://cdn.invalid/p.png');
  });

  it('auto-retries once with forceRefresh on img error, then shows retry fallback button', async () => {
    m.resolveMedia
      .mockResolvedValueOnce('https://cdn.invalid/stale.png')
      .mockResolvedValueOnce('https://cdn.invalid/retry1.png')
      .mockResolvedValueOnce('https://cdn.invalid/recovered.png');

    render(<UserImageThumb a={{ object: 'media/s1/bad.png', mime: 'image/png', filename: 'bad.png' }} index={0} sessionId="s1" messageId="u1" />);
    const img1 = await waitFor(() => {
      const el = document.querySelector('img');
      expect(el?.getAttribute('src')).toBe('https://cdn.invalid/stale.png');
      return el!;
    });

    // First error auto-retries once with forceRefresh: true.
    fireEvent.error(img1);
    await waitFor(() =>
      expect(m.resolveMedia).toHaveBeenCalledWith(
        { object: 'media/s1/bad.png', ref: undefined, url: undefined },
        expect.objectContaining({ sessionId: 's1', messageId: 'u1', kind: 'image', forceRefresh: true }),
      ),
    );
    const img2 = await waitFor(() => {
      const el = document.querySelector('img');
      expect(el?.getAttribute('src')).toBe('https://cdn.invalid/retry1.png');
      return el!;
    });

    // Second error transitions to compact retry button with image icon.
    fireEvent.error(img2);
    const retryBtn = await waitFor(() => {
      const btn = screen.getByRole('button', { name: '查看图1' });
      expect(btn.className).toContain('k-user-img-error');
      expect(btn.querySelector('[data-ui-icon="image"]')).toBeTruthy();
      expect(btn.textContent).toContain('重试');
      return btn;
    });

    // Manual retry recovers.
    fireEvent.click(retryBtn);
    await waitFor(() => expect(document.querySelector('img')?.getAttribute('src')).toBe('https://cdn.invalid/recovered.png'));
  });

  it('lazy-loads offscreen older history thumbnails via IntersectionObserver unless already cached', async () => {
    let ioCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
    const observe = vi.fn();
    const disconnect = vi.fn();
    class FakeIO {
      constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
        ioCallback = cb;
      }
      observe = observe;
      disconnect = disconnect;
    }
    vi.stubGlobal('IntersectionObserver', FakeIO);

    render(<UserImageThumb a={{ object: '', ref: 'old/photo.jpg', mime: 'image/jpeg' }} index={0} sessionId="s1" eager={false} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(observe).toHaveBeenCalledTimes(1);
    expect(m.resolveMedia).not.toHaveBeenCalled();

    // Scroll into view triggers resolveMedia.
    await act(async () => {
      ioCallback?.([{ isIntersecting: true }]);
    });
    await waitFor(() => expect(m.resolveMedia).toHaveBeenCalledTimes(1));
  });

  it('UserBubble groups images in .k-user-imgs (single, 2-col, 3-col grids) and keeps voice in .k-attach-row', async () => {
    const rec = {
      message_id: 'u1',
      role: 'user',
      ts: 1,
      text: '听听这个\n\nAttachments:\n[Attachment: v.m4a (audio/mp4) saved at /ws/u/v.m4a — image/audio attachments are already visible to you in this message; do not call analyze_media on them]\n[Attachment: p.jpg (image/jpeg) saved at /ws/u/p.jpg]',
    } as MessageRecord;
    useStore.setState({ items: { s1: [recordToItem(rec)] }, sessions: { s1: { session_id: 's1', title: 't', updated_at: 1 } as never } });
    render(<MessageList sessionId="s1" modeId="chat" />);
    const bubble = document.querySelector('.k-bubble-user')!;
    expect(bubble.textContent).toContain('听听这个');
    expect(bubble.textContent).not.toMatch(/saved at|Attachments:/);
    expect(bubble.querySelector('.k-attach-row .k-voice')).toBeTruthy();
    const imgsWrap = bubble.querySelector('.k-user-imgs.is-single')!;
    expect(imgsWrap).toBeTruthy();
    await waitFor(() => expect(imgsWrap.querySelector('img')?.getAttribute('src')).toBe('https://cdn.invalid/media.png'));
    expect(imgsWrap.querySelector('button[aria-label="查看图2"]')).toBeTruthy();
  });

  it('renders 2-col grid for 2 or 4 images and 3-col grid for 3 or 5 images', async () => {
    const makeAtts = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        object: `media/s1/img${i}.jpg`,
        mime: 'image/jpeg',
        filename: `img${i}.jpg`,
        bytes: 100,
      }));

    for (const [count, expectedClass] of [
      [1, 'is-single'],
      [2, 'is-grid-2'],
      [3, 'is-grid-3'],
      [4, 'is-grid-2'],
      [5, 'is-grid-3'],
    ] as const) {
      cleanup();
      useStore.setState({
        items: {
          s1: [{ key: `u-${count}`, kind: 'user', message_id: `u-${count}`, ts: 1, text: '', attachments: makeAtts(count), status: 'sent' }],
        },
        sessions: { s1: { session_id: 's1', title: 't', updated_at: 1 } as never },
      });
      render(<MessageList sessionId="s1" modeId="chat" />);
      const wrap = document.querySelector('.k-user-imgs')!;
      expect(wrap.className).toContain(expectedClass);
      expect(wrap.getAttribute('data-count')).toBe(String(count));
      await waitFor(() => expect(wrap.querySelectorAll('img')).toHaveLength(count));
    }
  });
});

describe('Composer image upload cache seeding (0ms thumbnail)', () => {
  it('seeds mediaCache right after upload so UserImageThumb renders immediately without calling resolveMedia', async () => {
    const file = new File([new Uint8Array(128)], 'cat.png', { type: 'image/png' });
    camMock.pickImages.mockResolvedValue([file]);
    m.upload.mockResolvedValue({ object: 'media/s1/cat.png', mime: 'image/png', filename: 'cat.png', bytes: 128 });

    render(<Composer sessionId="s1" modeId="chat" roleName="飞鸟" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '拍照或选图' }));
    });
    await waitFor(() => expect(document.querySelector('.k-composer-files img')).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
    });

    await waitFor(() => expect(m.sendMessage).toHaveBeenCalledTimes(1));
    const cachedUrl = await getCachedImageUrl(['obj:media/s1/cat.png']);
    expect(cachedUrl).toMatch(/^blob:thumb\//);

    // Now render UserImageThumb for the uploaded object -> displays immediately with 0 resolveMedia calls!
    m.resolveMedia.mockClear();
    render(<UserImageThumb a={{ object: 'media/s1/cat.png', mime: 'image/png', filename: 'cat.png' }} index={0} sessionId="s1" />);
    const img = document.querySelector('.k-user-img img');
    expect(img?.getAttribute('src')).toBe(cachedUrl);
    expect(m.resolveMedia).not.toHaveBeenCalled();
  });

  it('also supports pre-seeded cache directly in UserImageThumb for 0ms render', async () => {
    const seeded = await putCachedImage(['obj:media/s1/instant.webp'], new Blob([new Uint8Array(64)], { type: 'image/webp' }), 'image/webp');
    render(<UserImageThumb a={{ object: 'media/s1/instant.webp', mime: 'image/webp' }} index={0} sessionId="s1" />);
    expect(document.querySelector('.k-user-img img')?.getAttribute('src')).toBe(seeded);
    expect(m.resolveMedia).not.toHaveBeenCalled();
  });
});

describe('recordToItem attachment listing', () => {
  it('strips the injected listing and recovers attachments only when the record has none', () => {
    const split = splitAttachmentListing('hi\n\nAttachments:\n[Attachment: a.webm (audio/webm) saved at /x/a.webm]');
    expect(split.text).toBe('hi');
    expect(split.attachments).toEqual([{ object: '', mime: 'audio/webm', filename: 'a.webm', bytes: 0, ref: '/x/a.webm' }]);
    expect(splitAttachmentListing('Attachments: none').attachments).toEqual([]);
    const kept = recordToItem({
      message_id: 'u', role: 'user', ts: 1, text: 'hi',
      attachments: [{ object: 'media/o.webm', mime: 'audio/webm', filename: 'o.webm', bytes: 3 }],
    } as MessageRecord);
    expect(kept.attachments).toHaveLength(1);
    expect(kept.attachments![0].object).toBe('media/o.webm');
    const asst = recordToItem({ message_id: 'a', role: 'assistant', ts: 1, text: 'x\n\nAttachments:\n[Attachment: a (b) saved at c]' } as MessageRecord);
    expect(asst.text).toContain('Attachments:');
  });
});

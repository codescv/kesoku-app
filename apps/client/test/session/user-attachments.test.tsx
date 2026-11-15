import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MessageRecord } from '@kesoku/protocol';

const m = vi.hoisted(() => ({
  resolveMedia: vi.fn(async () => 'https://cdn.invalid/clip.m4a' as string | null),
  retry: vi.fn(),
}));
vi.mock('../../src/lib/client', () => ({ kesoku: m }));

import { UserAttachmentItem, isAudioAttachment, isImageAttachment, MessageList } from '../../src/features/session/MessageList';
import { useOverlays } from '../../src/features/session/overlays';
import { initialState, recordToItem, splitAttachmentListing, useStore } from '../../src/lib/store';

beforeEach(() => {
  useStore.setState(initialState(), true);
  m.resolveMedia.mockClear();
  useOverlays.setState({ fullscreen: null, peek: null, image: null });
});
afterEach(() => cleanup());

describe('UserAttachmentItem', () => {
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

  it('keeps 图N for images and opens the image overlay on tap', async () => {
    render(<UserAttachmentItem a={{ object: 'media/s1/p.png', mime: 'image/png', filename: 'p.png' }} index={1} sessionId="s1" messageId="u1" />);
    const btn = screen.getByRole('button', { name: '查看图2' });
    expect(btn.textContent).toContain('图2');
    expect(btn.querySelector('[data-ui-icon="image"]')).toBeTruthy();
    fireEvent.click(btn);
    await waitFor(() => expect(useOverlays.getState().image?.url).toBe('https://cdn.invalid/clip.m4a'));
  });

  it('UserBubble in MessageList renders voice + image pills from history records', () => {
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
    expect(bubble.querySelector('.k-voice')).toBeTruthy();
    expect(bubble.textContent).toContain('图2');
    expect(bubble.textContent).not.toContain('图1');
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

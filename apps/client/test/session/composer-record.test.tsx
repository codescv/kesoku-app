import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const m = vi.hoisted(() => ({
  upload: vi.fn(),
  sendMessage: vi.fn(),
  ensureSession: vi.fn(async () => 's'),
}));
vi.mock('../../src/lib/client', () => ({ kesoku: m }));

import { Composer } from '../../src/features/session/Composer';
import { initialState, useStore } from '../../src/lib/store';

const track = { stop: vi.fn() };
const recorders: FakeRecorder[] = [];

class FakeRecorder {
  state: 'inactive' | 'recording' = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  static isTypeSupported(t: string) {
    return t === 'audio/webm';
  }
  constructor() {
    recorders.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['voice-bytes'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}

beforeEach(() => {
  recorders.length = 0;
  track.stop.mockReset();
  m.upload.mockReset().mockResolvedValue({ object: 'media/s/voice.webm', mime: 'audio/webm', filename: 'v.webm', bytes: 11 });
  m.sendMessage.mockReset().mockResolvedValue(undefined);
  useStore.setState(initialState());
  useStore.setState((s) => ({ conn: { ...s.conn, status: 'online' } }));
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function startRecording() {
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '开始语音输入' })));
  return screen.getByTestId('composer-recording-bar');
}

describe('Composer · tap-to-record with 取消 / 发送', () => {
  it('one tap starts recording and shows a live timer bar', async () => {
    render(<Composer sessionId="s" modeId="chat" roleName="飞鸟" />);
    const bar = await startRecording();
    expect(bar.textContent).toContain('录音中 0:00');
    await act(async () => vi.advanceTimersByTime(3000));
    expect(bar.textContent).toContain('录音中 0:03');
    expect(screen.queryByLabelText('消息输入框')).toBeNull();
  });

  it('✕ 取消 discards the recording and sends nothing', async () => {
    render(<Composer sessionId="s" modeId="chat" roleName="飞鸟" />);
    await startRecording();
    const rec = recorders[0]!;
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '取消录音' })));
    expect(screen.queryByTestId('composer-recording-bar')).toBeNull();
    expect(rec.state).toBe('inactive');
    expect(rec.ondataavailable).toBeNull();
    expect(track.stop).toHaveBeenCalled();
    expect(m.upload).not.toHaveBeenCalled();
    expect(m.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByLabelText('消息输入框')).toBeTruthy();
  });

  it('✓ 发送 stops and sends the recorded audio', async () => {
    render(<Composer sessionId="s" modeId="chat" roleName="飞鸟" />);
    await startRecording();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '发送语音' })));
    expect(screen.queryByTestId('composer-recording-bar')).toBeNull();
    expect(m.upload).toHaveBeenCalledTimes(1);
    const [file, purpose] = m.upload.mock.calls[0]!;
    expect((file as File).type).toBe('audio/webm');
    expect(purpose).toBe('message');
    expect(m.sendMessage).toHaveBeenCalledWith('s', '', [expect.objectContaining({ object: 'media/s/voice.webm' })]);
  });

  it('translator voice defaults to 【我说】', async () => {
    render(<Composer sessionId="s" modeId="translator" roleName="飞鸟" />);
    expect(screen.getByText('我说')).toBeTruthy();
    await startRecording();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '发送语音' })));
    expect(m.sendMessage).toHaveBeenCalledWith('s', '【我说】翻译成对方语言', expect.any(Array));
  });

  it('unmounting mid-recording releases the microphone without sending', async () => {
    const { unmount } = render(<Composer sessionId="s" modeId="chat" roleName="飞鸟" />);
    await startRecording();
    unmount();
    expect(track.stop).toHaveBeenCalled();
    expect(m.sendMessage).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MessageRecord } from '@kesoku/protocol';

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  resolveMedia: vi.fn(async () => 'https://cdn.invalid/clip.m4a' as string | null),
  openSession: vi.fn(),
  renameSession: vi.fn(),
  deleteSession: vi.fn(),
  retry: vi.fn(),
  setModePrefs: vi.fn(),
}));
vi.mock('../src/lib/client', () => ({ kesoku: m }));

import { Markdown, parseBlocks } from '../src/features/segments/Markdown';
import { BilingualCard, toWordUnits } from '../src/features/segments/BilingualCard';
import { UserAttachmentItem, isAudioAttachment, isImageAttachment, MessageList } from '../src/features/session/MessageList';
import { useOverlays } from '../src/features/session/overlays';
import { SessionPanel } from '../src/features/session/SessionPanel';
import { TranslatorLangFields } from '../src/features/settings/SettingsScreen';
import { initialState, recordToItem, splitAttachmentListing, useStore, DEFAULT_SETTINGS } from '../src/lib/store';
import { mergeTranslatorModePrefs, translatorLangs, translatorSettingsPatch, translatorStartPrefs } from '../src/lib/translatorPrefs';

beforeEach(() => {
  useStore.setState(initialState(), true);
  m.resolveMedia.mockClear();
  useOverlays.setState({ fullscreen: null, peek: null, image: null });
});
afterEach(() => cleanup());

// ── Item 1 · user voice / image attachments ──────────────────────────────────────────────────────
describe('UserAttachmentItem (v0.3.7 Item 1)', () => {
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

describe('recordToItem attachment listing (v0.3.7 Item 1)', () => {
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

// ── Item 2 · multi-line spoilers ─────────────────────────────────────────────────────────────────
const SHOT2 = [
  '### ① 原文',
  '> 森(もり)さんは　毎晩(まいばん)　テレビを　見(み)る。',
  '> 甲(こう)：明日(あした)　ボーリングに　行(い)かない？ / 乙(おつ)：ごめん。　明日(あした)は　仕事(しごと)が　あるから…',
  '<spoiler>森先生每天晚上看电视。',
  '甲：明天去打保龄球怎么样？ / 乙：抱歉，明天还有工作……</spoiler>',
].join('\n');

describe('Markdown multi-line <spoiler> (v0.3.7 Item 2)', () => {
  it('parses a spoiler opening with text and closing on a later line as a spoiler block', () => {
    const blocks = parseBlocks(SHOT2);
    expect(blocks.map((b) => b.t)).toEqual(['h', 'quote', 'spoiler']);
    const sp = blocks[2] as { t: 'spoiler'; lines: string[]; body: string };
    expect(sp.body).toBe('森先生每天晚上看电视。\n甲：明天去打保龄球怎么样？ / 乙：抱歉，明天还有工作……');
    expect(sp.lines).toHaveLength(2);
  });

  it('renders the screenshot sample with no literal tags and a <br /> inside the Spoiler', () => {
    const { container } = render(<Markdown text={SHOT2} />);
    expect(container.textContent).not.toMatch(/<\/?spoiler>/i);
    const sp = container.querySelector('.k-spoiler')!;
    expect(sp).toBeTruthy();
    expect(sp.querySelectorAll('br').length).toBe(1);
    expect(sp.textContent).toContain('森先生每天晚上看电视。');
    expect(sp.textContent).toContain('乙：抱歉，明天还有工作……');
    expect(container.querySelector('blockquote ruby')).toBeTruthy();
  });

  it('keeps blank lines inside block spoilers and supports the legacy lone-tag form', () => {
    const b = parseBlocks('<spoiler>第一行\n\n第三行\n</spoiler>');
    expect(b).toHaveLength(1);
    expect((b[0] as { body: string }).body).toBe('第一行\n\n第三行');
    const legacy = parseBlocks('<spoiler>\nA\nB\n</spoiler>\nafter');
    expect(legacy.map((x) => x.t)).toEqual(['spoiler', 'p']);
    expect((legacy[0] as { lines: string[] }).lines).toEqual(['A', 'B']);
  });

  it('matches spoilers spanning lines inside a paragraph and a blockquote', () => {
    const { container } = render(<Markdown text={'前文 <spoiler>行一\n行二</spoiler> 后文\n\n> 引用 ||甲\n> 乙|| 结束'} />);
    expect(container.textContent).not.toMatch(/<\/?spoiler>|\|\|/);
    const spoilers = container.querySelectorAll('.k-spoiler');
    expect(spoilers).toHaveLength(2);
    expect(spoilers[0].querySelector('br')).toBeTruthy();
    expect(spoilers[1].closest('blockquote')).toBeTruthy();
    expect(container.querySelector('p')!.textContent).toBe('前文 行一行二 后文');
  });

  it('single-line inline spoilers and plain multi-line paragraphs are unchanged', () => {
    const { container } = render(<Markdown text={'a <spoiler>x</spoiler> b\nline2'} />);
    const p = container.querySelector('p')!;
    expect(p.querySelectorAll('br')).toHaveLength(1);
    expect(p.querySelector('.k-spoiler')!.textContent).toBe('x');
    expect(parseBlocks('```\n<spoiler>\n```').map((x) => x.t)).toEqual(['code']);
  });
});

describe('BilingualCard multi-line ja / zh (v0.3.7 Item 2)', () => {
  const seg = {
    type: 'bilingual',
    ja: '森(もり)さんは見(み)る。\n甲(こう)：行(い)かない？',
    ja_plain: '森さんは見る。\n甲：行かない？',
    ruby_parts: [
      { base: '森', rt: 'もり' },
      { base: 'さんは' },
      { base: '見', rt: 'み' },
      { base: 'る。\n' },
      { base: '甲', rt: 'こう' },
      { base: '：' },
      { base: '行', rt: 'い' },
      { base: 'かない？' },
    ],
    zh: '森先生看。\n甲：去不去？',
  };

  it('word units isolate the line break', () => {
    const units = toWordUnits(seg.ruby_parts);
    expect(units.some((u) => u.base === '\n')).toBe(true);
    expect(units.every((u) => u.base === '\n' || !u.base.includes('\n'))).toBe(true);
  });

  it('renders <br /> between Japanese lines and inside the Chinese translation', () => {
    const { container } = render(<BilingualCard seg={seg as never} resolveVoice={async () => null} explain={async () => null} />);
    expect(container.querySelectorAll('.k-bi-ja br')).toHaveLength(1);
    expect(container.querySelectorAll('.k-bi-ja ruby')).toHaveLength(4);
    const zh = container.querySelector('.k-bi-zh')!;
    expect(zh.querySelectorAll('br')).toHaveLength(1);
    expect(zh.textContent).toBe('森先生看。甲：去不去？');
  });
});

// ── Item 3 · casual chat icon ────────────────────────────────────────────────────────────────────
describe('SessionPanel mode icon (v0.3.7 Item 3)', () => {
  it('renders a ModeIcon for chat sessions and sessions without mode_id', () => {
    const now = Date.now() / 1000;
    useStore.setState({
      sessions: {
        a: { session_id: 'a', title: '闲聊', mode_id: 'chat', updated_at: now } as never,
        b: { session_id: 'b', title: '无模式', updated_at: now - 1 } as never,
        c: { session_id: 'c', title: '翻译', mode_id: 'translator', updated_at: now - 2 } as never,
      },
    });
    render(<SessionPanel />);
    const rows = Array.from(document.querySelectorAll('.k-srow'));
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.querySelector('.k-srow-mode [data-mode-icon]')).toBeTruthy();
    expect(document.querySelectorAll('.k-srow-mode [data-mode-icon="chat"]')).toHaveLength(2);
    expect(document.querySelector('.k-srow-mode [data-mode-icon="translator"]')).toBeTruthy();
  });
});

// ── Item 4 · translator languages ────────────────────────────────────────────────────────────────
describe('translator language settings (v0.3.7 Item 4)', () => {
  it('defaults to 简中 native with ja/en/ko foreign languages', () => {
    expect(DEFAULT_SETTINGS.translatorNativeLang).toBe('zh-CN');
    expect(DEFAULT_SETTINGS.translatorForeignLangs).toEqual(['ja', 'en', 'ko']);
    expect(translatorStartPrefs(DEFAULT_SETTINGS)).toEqual({ native_lang: 'zh-CN', foreign_langs: ['ja', 'en', 'ko'], src_lang: 'ja', dst_lang: 'zh-CN' });
  });

  it('sanitises settings and merges them over session prefs', () => {
    expect(translatorLangs({ translatorNativeLang: 'ja', translatorForeignLangs: ['ja', 'en'] })).toEqual({ native_lang: 'ja', foreign_langs: ['en'] });
    expect(translatorLangs({ translatorNativeLang: '', translatorForeignLangs: [] }).foreign_langs).toEqual(['ja', 'en', 'ko']);
    expect(mergeTranslatorModePrefs({ src_lang: 'en', native_lang: 'old' }, { translatorNativeLang: 'zh-TW', translatorForeignLangs: ['en'] })).toEqual({
      src_lang: 'en',
      native_lang: 'zh-TW',
      foreign_langs: ['en'],
    });
    expect(translatorSettingsPatch({ src_lang: 'en' })).toBeNull();
    expect(translatorSettingsPatch({ native_lang: 'ko', foreign_langs: ['ja', 1] })).toEqual({ translatorNativeLang: 'ko', translatorForeignLangs: ['ja'] });
  });

  it('SettingsScreen fields change 翻译母语 and toggle 常用外语 (keeping at least one)', () => {
    render(<TranslatorLangFields />);
    const sel = screen.getByRole('combobox', { name: '翻译母语' }) as HTMLSelectElement;
    expect(sel.value).toBe('zh-CN');
    expect(sel.options).toHaveLength(13);
    const group = screen.getByRole('group', { name: '常用外语' });
    expect(group.querySelectorAll('button')).toHaveLength(12); // all but the native language
    fireEvent.click(screen.getByRole('button', { name: /法语/ }));
    expect(useStore.getState().settings.translatorForeignLangs).toEqual(['ja', 'en', 'ko', 'fr']);
    fireEvent.click(screen.getByRole('button', { name: /韩语/ }));
    expect(useStore.getState().settings.translatorForeignLangs).toEqual(['ja', 'en', 'fr']);
    fireEvent.change(sel, { target: { value: 'ja' } });
    expect(useStore.getState().settings.translatorNativeLang).toBe('ja');
    expect(useStore.getState().settings.translatorForeignLangs).toEqual(['en', 'fr']);
    // At least one foreign language is always kept.
    act(() => useStore.setState((s) => ({ settings: { ...s.settings, translatorForeignLangs: ['en'] } })));
    const en = screen.getByRole('button', { name: /英语/ }) as HTMLButtonElement;
    expect(en.disabled).toBe(true);
    fireEvent.click(en);
    expect(useStore.getState().settings.translatorForeignLangs).toEqual(['en']);
  });
});

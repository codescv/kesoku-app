import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const rpcMock = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/client')>();
  return {
    ...actual,
    kesoku: {
      ...actual.kesoku,
      rpc: rpcMock,
    },
  };
});

import {
  NotesPanel,
  parseStickyNotes,
  serializeStickyNotes,
  sortStickyNotes,
  type StickyNoteItem,
} from '../NotesPanel';
import { MemoryPanel } from '../../memory/MemoryPanel';
import { SessionPanel } from '../../session/SessionPanel';
import { RoleModeCapsule } from '../../../app/TopBar';
import { SettingsScreen } from '../../settings/SettingsScreen';
import { initialState, useStore } from '../../../lib/store';
import { RpcError } from '../../../lib/ws';

beforeEach(() => {
  useStore.setState(initialState(), true);
  rpcMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('parseStickyNotes & serializeStickyNotes', () => {
  it('handles empty and whitespace-only content', () => {
    expect(parseStickyNotes('')).toEqual([]);
    expect(parseStickyNotes('   \n\n  ')).toEqual([]);
    expect(parseStickyNotes('<!-- header comment -->\n')).toEqual([]);
    expect(serializeStickyNotes([])).toBe('');
  });

  it('round-trips pinned and unpinned sticky notes separated by ---', () => {
    const items: StickyNoteItem[] = [
      { id: 'n1', timestamp: '2026-11-15 19:45', pinned: true, body: '临时记录的内容...\n- 第一项\n- 第二项' },
      { id: 'n2', timestamp: '2026-11-15 18:20', pinned: false, body: '另一条便签...' },
    ];
    const md = serializeStickyNotes(items);
    expect(md).toContain('### 📌 2026-11-15 19:45');
    expect(md).toContain('\n\n---\n\n');
    expect(md).toContain('### 2026-11-15 18:20');

    const parsed = parseStickyNotes(md);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      timestamp: '2026-11-15 19:45',
      pinned: true,
      body: '临时记录的内容...\n- 第一项\n- 第二项',
    });
    expect(parsed[1]).toMatchObject({
      timestamp: '2026-11-15 18:20',
      pinned: false,
      body: '另一条便签...',
    });
  });

  it('splits timestamped ### sections even without --- dividers', () => {
    const raw = `### 📌 2026-11-15 20:00\n置顶事项\n\n### 2026-11-15 19:00\n普通事项`;
    const parsed = parseStickyNotes(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ pinned: true, timestamp: '2026-11-15 20:00', body: '置顶事项' });
    expect(parsed[1]).toMatchObject({ pinned: false, timestamp: '2026-11-15 19:00', body: '普通事项' });
  });

  it('gracefully preserves arbitrary Agent-written Markdown without timestamp headers and round-trips it', () => {
    const raw = `# Agent 临时整理\n\n- API 地址: \`https://example.com\`\n- 记得检查配置\n\n---\n\n随手记的一段无标题文字\n### 子标题也保留在正文里\n正文内容`;
    const parsed = parseStickyNotes(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      timestamp: '便签',
      pinned: false,
      body: '# Agent 临时整理\n\n- API 地址: `https://example.com`\n- 记得检查配置',
    });
    expect(parsed[1]).toMatchObject({
      timestamp: '便签',
      pinned: false,
      body: '随手记的一段无标题文字\n### 子标题也保留在正文里\n正文内容',
    });

    const roundTripped = parseStickyNotes(serializeStickyNotes(parsed));
    expect(roundTripped.map(({ timestamp, pinned, body }) => ({ timestamp, pinned, body }))).toEqual(
      parsed.map(({ timestamp, pinned, body }) => ({ timestamp, pinned, body })),
    );
  });

  it('does not split on --- or ### inside fenced code blocks', () => {
    const raw = [
      '### 2026-11-15 21:10',
      '代码示例：',
      '```markdown',
      '---',
      '### 📌 2026-11-15 00:00',
      'inside fence',
      '```',
      '结尾说明',
    ].join('\n');

    const parsed = parseStickyNotes(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.body).toContain('```markdown\n---\n### 📌 2026-11-15 00:00\ninside fence\n```');
    expect(parsed[0]!.body).toContain('结尾说明');
  });

  it('sortStickyNotes orders pinned notes first while preserving relative order', () => {
    const sorted = sortStickyNotes([
      { id: '1', timestamp: '10:00', pinned: false, body: 'u1' },
      { id: '2', timestamp: '11:00', pinned: true, body: 'p1' },
      { id: '3', timestamp: '12:00', pinned: false, body: 'u2' },
      { id: '4', timestamp: '13:00', pinned: true, body: 'p2' },
    ]);
    expect(sorted.map((x) => x.body)).toEqual(['p1', 'p2', 'u1', 'u2']);
  });
});

describe('NotesPanel interactions', () => {
  it('treats NOT_FOUND on workspace.read as empty notes without showing an error banner', async () => {
    rpcMock.mockImplementation(async (type: string) => {
      if (type === 'workspace.read') throw new RpcError('NOT_FOUND', 'notes.md not found');
      return { rel_path: 'notes.md', bytes_written: 0 };
    });

    render(<NotesPanel />);
    await waitFor(() => expect(screen.getByTestId('notes-empty')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/还没有临时便签/)).toBeTruthy();
  });

  it('supports quick-add (with pin), inline edit, pin toggle, copy, search, delete, and raw Markdown mode', async () => {
    let disk = `### 2026-11-15 18:00\n第一条旧便签\n\n---\n\n### 2026-11-15 17:00\n第二条旧便签\n`;
    rpcMock.mockImplementation(async (type: string, payload: Record<string, unknown>) => {
      if (type === 'workspace.read') {
        expect(payload).toEqual({ rel_path: 'notes.md' });
        return { content: disk, size: disk.length };
      }
      if (type === 'workspace.write') {
        expect(payload.path).toBe('notes.md');
        expect(payload.overwrite).toBe(true);
        disk = String(payload.content ?? '');
        return { rel_path: 'notes.md', bytes_written: disk.length };
      }
      return {};
    });

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<NotesPanel />);
    await waitFor(() => expect(screen.getAllByTestId('note-card')).toHaveLength(2));
    // Search input only appears when >= 3 notes exist
    expect(screen.queryByPlaceholderText('搜索便签...')).toBeNull();

    // Quick-add a pinned note
    fireEvent.click(screen.getByTestId('notes-pin-toggle'));
    const input = screen.getByLabelText('新便签内容') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '**置顶采购**：买咖啡豆' } });
    fireEvent.click(screen.getByTestId('notes-add-btn'));

    await waitFor(() => expect(screen.getAllByTestId('note-card')).toHaveLength(3));
    expect(input.value).toBe('');
    expect(disk).toContain('### 📌 ');
    expect(disk).toContain('**置顶采购**：买咖啡豆');

    // Search bar now appears (>= 3 notes) and filters cards
    const searchInput = screen.getByPlaceholderText('搜索便签...');
    fireEvent.change(searchInput, { target: { value: '咖啡豆' } });
    expect(screen.getAllByTestId('note-card')).toHaveLength(1);
    fireEvent.change(searchInput, { target: { value: '' } });
    expect(screen.getAllByTestId('note-card')).toHaveLength(3);

    // Inline edit on the first (pinned) card
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]!);
    const editBox = screen.getByLabelText('编辑便签内容') as HTMLTextAreaElement;
    fireEvent.change(editBox, { target: { value: '**置顶采购**：买手冲咖啡豆' } });
    fireEvent.click(screen.getByTestId('note-edit-save'));
    await waitFor(() => expect(screen.getByText(/买手冲咖啡豆/)).toBeTruthy());
    expect(disk).toContain('买手冲咖啡豆');

    // Copy card body
    fireEvent.click(screen.getAllByRole('button', { name: '复制' })[0]!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('**置顶采购**：买手冲咖啡豆'));
    expect(useStore.getState().toasts.some((t) => t.text === '已复制到剪贴板')).toBe(true);

    // Unpin the first card
    fireEvent.click(screen.getByRole('button', { name: '取消置顶' }));
    await waitFor(() => expect(document.querySelectorAll('.k-note-card.is-pinned')).toHaveLength(0));

    // Delete one card
    fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0]!);
    await waitFor(() => expect(screen.getAllByTestId('note-card')).toHaveLength(2));
    expect(useStore.getState().toasts.some((t) => t.text === '已删除便签')).toBe(true);

    // Switch to Raw Markdown mode and save custom scratchpad text
    fireEvent.click(screen.getByRole('radio', { name: 'Markdown 源码' }));
    const rawEditor = screen.getByLabelText('notes.md Markdown 源码') as HTMLTextAreaElement;
    fireEvent.change(rawEditor, { target: { value: '### 📌 2026-11-15 22:00\n直接源码编辑的便签\n' } });
    fireEvent.click(screen.getByTestId('notes-raw-save-btn'));
    await waitFor(() => expect(disk).toBe('### 📌 2026-11-15 22:00\n直接源码编辑的便签\n'));

    // Switch back to cards view and verify synced card
    fireEvent.click(screen.getByRole('radio', { name: '便签卡片' }));
    expect(screen.getAllByTestId('note-card')).toHaveLength(1);
    expect(screen.getByText('直接源码编辑的便签')).toBeTruthy();
  });

  it('switches Desktop Inspector between Memory and Sticky Notes and navigates from Sidebar, TopBar, and Settings', async () => {
    rpcMock.mockImplementation(async (type: string) => {
      if (type === 'workspace.read') return { content: '', size: 0 };
      if (type === 'memory.list') return { files: [] };
      if (type === 'device.list') return { devices: [] };
      return {};
    });

    // Embedded NotesPanel -> Memory
    const { unmount: u1 } = render(<NotesPanel embedded />);
    await waitFor(() => expect(screen.getByTestId('inspector-tab-memory')).toBeTruthy());
    fireEvent.click(screen.getByTestId('inspector-tab-memory'));
    expect(useStore.getState().ui.inspector).toEqual({ kind: 'memory' });
    u1();

    // Embedded MemoryPanel -> Notes
    const { unmount: u2 } = render(<MemoryPanel embedded />);
    await waitFor(() => expect(screen.getByTestId('inspector-tab-notes')).toBeTruthy());
    fireEvent.click(screen.getByTestId('inspector-tab-notes'));
    expect(useStore.getState().ui.inspector).toEqual({ kind: 'notes' });
    u2();

    // Sidebar Tools button opens Tools hub (where Notes is housed alongside Files & Workout)
    const { unmount: u3 } = render(<SessionPanel />);
    const toolsBtn = screen.getByTestId('sidebar-tools-btn');
    fireEvent.click(toolsBtn);
    expect(useStore.getState().ui.screen).toBe('tools');
    expect(toolsBtn.classList.contains('is-active')).toBe(true);
    u3();

    // TopBar RoleModeCapsule no longer carries the global scratchpad entry (v0.1.27): sidebar / inspector only.
    useStore.setState((s) => ({ ui: { ...s.ui, screen: 'chat' } }));
    const { unmount: u4 } = render(<RoleModeCapsule sessionId="s1" modeId="chat" />);
    fireEvent.click(screen.getByRole('button', { name: '角色与模式' }));
    expect(screen.queryByTestId('topbar-notes-btn')).toBeNull();
    expect(screen.queryByText(/简易便签/)).toBeNull();
    expect(useStore.getState().ui.screen).toBe('chat');
    u4();

    // SettingsScreen no longer duplicates the sticky notes entry (streamlined in v0.1.20)
    useStore.setState((s) => ({ ui: { ...s.ui, screen: 'settings' } }));
    const { unmount: u5 } = render(<SettingsScreen onClose={() => {}} />);
    expect(screen.queryByTestId('settings-notes-btn')).toBeNull();
    expect(screen.queryByText(/简易便签/)).toBeNull();
    u5();
  });
});

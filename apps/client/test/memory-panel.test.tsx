import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
}));
vi.mock('../src/lib/client', () => ({ kesoku: m }));

import { MemoryPanel, stripFrontmatterForPreview } from '../src/features/memory/MemoryPanel';
import { initialState, useStore } from '../src/lib/store';

beforeEach(() => {
  useStore.setState(initialState(), true);
  m.rpc.mockReset();
});
afterEach(() => cleanup());

describe('MemoryPanel Markdown preview', () => {
  const FILE = '---\ndescription: 用户饮食偏好\ntags: [food, health]\n---\n# 饮食\n\n- 乳糖不耐受\n- 不吃香菜\n';
  beforeEach(() => {
    useStore.setState({ personas: [{ role_id: 'mio', display_name: '旅伴 Mio', tagline: '', builtin: false, avatar_rev: 0 }] });
    m.rpc.mockImplementation((type: string) => {
      if (type === 'memory.list') return Promise.resolve({ files: [{ rel_path: 'user/food.md', pinned: false, tags: [] }] });
      if (type === 'memory.get') return Promise.resolve({ content: FILE, pinned: false });
      return Promise.resolve({ ok: true });
    });
  });

  it('splits YAML frontmatter from the body', () => {
    const r = stripFrontmatterForPreview(FILE);
    expect(r.meta).toEqual([
      { key: 'description', value: '用户饮食偏好' },
      { key: 'tags', value: 'food, health' },
    ]);
    expect(r.body.startsWith('# 饮食')).toBe(true);
    expect(stripFrontmatterForPreview('plain').body).toBe('plain');
  });

  it('uses the first loaded role (no hardcoded persona) and previews files before editing', async () => {
    const { container } = render(<MemoryPanel />);
    await waitFor(() => expect(m.rpc).toHaveBeenCalledWith('memory.list', { role: 'mio' }));
    fireEvent.click(await screen.findByText('user/food.md'));
    await waitFor(() => expect(container.querySelector('.k-memory-md-preview')).toBeTruthy());
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelectorAll('.k-memory-md-preview li')).toHaveLength(2);
    expect(container.querySelector('.k-memory-meta')?.textContent).toContain('用户饮食偏好');
    fireEvent.click(screen.getByRole('button', { name: /编辑/ }));
    expect((screen.getByLabelText('记忆内容') as HTMLTextAreaElement).value).toBe(FILE);
    fireEvent.click(screen.getByRole('button', { name: /预览/ }));
    expect(container.querySelector('textarea')).toBeNull();
  });
});

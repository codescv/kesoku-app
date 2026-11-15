import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  upload: vi.fn(),
  resolveMedia: vi.fn(async () => null as string | null),
}));
vi.mock('../../src/lib/client', () => ({ kesoku: m }));

import { FileBrowser, validEntryName } from '../../src/features/files/FileBrowser';
import { initialState, useStore } from '../../src/lib/store';

type Call = [string, Record<string, unknown>, ...unknown[]];
const calls = (type: string) => (m.rpc.mock.calls as Call[]).filter((c) => c[0] === type);

const ROOT = [
  { name: 'notes', rel_path: 'notes', kind: 'dir', size: 0, updated_at: 100 },
  { name: 'README.md', rel_path: 'README.md', kind: 'file', size: 128, updated_at: 100 },
  { name: 'cover.png', rel_path: 'cover.png', kind: 'file', size: 2048, updated_at: 100 },
];

function defaultRpc(type: string, payload: Record<string, unknown>) {
  switch (type) {
    case 'workspace.list':
      return Promise.resolve({
        rel_path: payload.rel_path || '',
        awd_name: 'band',
        entries: payload.rel_path === 'notes' ? [{ name: 'a.txt', rel_path: 'notes/a.txt', kind: 'file', size: 3, updated_at: 100 }] : ROOT,
      });
    case 'workspace.read':
      return Promise.resolve({
        rel_path: payload.rel_path,
        name: String(payload.rel_path).split('/').pop(),
        kind: 'text',
        size: 12,
        updated_at: 100,
        mime: 'text/markdown',
        content: '# Hello band',
        writable: true,
      });
    case 'workspace.write':
      return Promise.resolve({ path: payload.path, name: String(payload.path).split('/').pop(), size: 1 });
    case 'workspace.mkdir':
      return Promise.resolve({ path: payload.path, name: String(payload.path).split('/').pop(), kind: 'dir' });
    case 'workspace.delete':
      return Promise.resolve({ path: payload.path, deleted: true });
    case 'workspace.download':
      return Promise.resolve({ path: payload.path, name: 'cover.png', size: 3, mime_type: 'image/png', base64: btoa('PNG') });
    default:
      return Promise.reject(Object.assign(new Error('unexpected'), { code: 'BAD_REQUEST' }));
  }
}

const createObjectURL = vi.fn((_b: Blob) => 'blob:mock-url');
const revokeObjectURL = vi.fn();
let clickSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  useStore.setState(initialState(), true);
  m.rpc.mockReset().mockImplementation(defaultRpc);
  createObjectURL.mockClear();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revokeObjectURL });
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => {
  clickSpy.mockRestore();
});

async function renderRoot() {
  render(<FileBrowser onClose={() => {}} />);
  await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy());
}

describe('FileBrowser · CRUD', () => {
  it('renders the root listing with 根目录 and never shows the awd name', async () => {
    await renderRoot();
    expect(screen.getByText('Agent 目录')).toBeTruthy();
    expect(screen.getByRole('button', { name: '根目录' })).toBeTruthy();
    expect(screen.getByText('notes')).toBeTruthy();
    expect(screen.getByTestId('file-browser').textContent ?? '').not.toMatch(/band/i);
    // vector icons only: no emoji glyphs in the chrome
    expect(screen.getByTestId('file-browser').textContent ?? '').not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    expect(document.querySelector('[data-ui-icon="folder"]')).toBeTruthy();
    expect(document.querySelector('[data-ui-icon="file-image"]')).toBeTruthy();
  });

  it('uploads picked files as base64 via workspace.write and refreshes', async () => {
    await renderRoot();
    const input = screen.getByTestId('fb-upload-input') as HTMLInputElement;
    const file = new File(['hello'], 'hi.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(calls('workspace.write')).toHaveLength(1));
    expect(calls('workspace.write')[0]![1]).toEqual({ path: 'hi.txt', base64: btoa('hello'), overwrite: false });
    await waitFor(() => expect(calls('workspace.list').length).toBeGreaterThanOrEqual(2));
  });

  it('uploads large files in ≤512 KiB chunks: first write then append:true', async () => {
    await renderRoot();
    const CH = 512 * 1024;
    const bytes = new Uint8Array(CH * 2 + 10).map((_, i) => i % 251);
    fireEvent.change(screen.getByTestId('fb-upload-input'), { target: { files: [new File([bytes], 'big.bin')] } });
    await waitFor(() => expect(calls('workspace.write')).toHaveLength(3), { timeout: 5000 });
    const w = calls('workspace.write').map((c) => c[1]);
    expect(w[0]).toMatchObject({ path: 'big.bin', overwrite: false });
    expect(w[0]).not.toHaveProperty('append');
    expect(w[1]).toMatchObject({ path: 'big.bin', append: true });
    expect(w[2]).toMatchObject({ path: 'big.bin', append: true });
    const sizes = w.map((p) => atob(String(p.base64)).length);
    expect(sizes).toEqual([CH, CH, 10]);
    const joined = w.map((p) => atob(String(p.base64))).join('');
    expect(joined.charCodeAt(CH + 7)).toBe((CH + 7) % 251);
  });

  it('refuses uploads above the 10 MiB cap without any RPC', async () => {
    await renderRoot();
    const huge = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'huge.bin');
    fireEvent.change(screen.getByTestId('fb-upload-input'), { target: { files: [huge] } });
    await waitFor(() => expect(useStore.getState().toasts.some((t) => t.text.includes('huge.bin') && t.tone === 'error')).toBe(true));
    expect(calls('workspace.write')).toHaveLength(0);
  });

  it('uploads into the current subdirectory', async () => {
    await renderRoot();
    fireEvent.click(screen.getByText('notes'));
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy());
    fireEvent.change(screen.getByTestId('fb-upload-input'), { target: { files: [new File(['x'], 'b.bin')] } });
    await waitFor(() => expect(calls('workspace.write')).toHaveLength(1));
    expect(calls('workspace.write')[0]![1]).toMatchObject({ path: 'notes/b.bin', base64: btoa('x') });
  });

  it('creates a folder through the inline name bar and rejects invalid names', async () => {
    await renderRoot();
    fireEvent.click(screen.getByRole('button', { name: '新建文件夹' }));
    const input = screen.getByLabelText('新文件夹名称');
    fireEvent.change(input, { target: { value: '..' } });
    expect((screen.getByRole('button', { name: '创建' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'drafts' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(calls('workspace.mkdir')).toHaveLength(1));
    expect(calls('workspace.mkdir')[0]![1]).toEqual({ path: 'drafts' });
    await waitFor(() => expect(screen.queryByLabelText('新文件夹名称')).toBeNull());
  });

  it('creates an empty file via workspace.write content ""', async () => {
    await renderRoot();
    fireEvent.click(screen.getByRole('button', { name: '新建文件' }));
    fireEvent.change(screen.getByLabelText('新文件名称'), { target: { value: 'todo.md' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(calls('workspace.write')).toHaveLength(1));
    expect(calls('workspace.write')[0]![1]).toEqual({ path: 'todo.md', content: '', overwrite: false });
  });

  it('refuses to create a file whose name already exists in the listing', async () => {
    await renderRoot();
    fireEvent.click(screen.getByRole('button', { name: '新建文件' }));
    fireEvent.change(screen.getByLabelText('新文件名称'), { target: { value: 'README.md' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(useStore.getState().toasts.some((t) => t.text.includes('已存在同名文件') && t.tone === 'error')).toBe(true));
    expect(calls('workspace.write')).toHaveLength(0);
  });

  it('upload over an existing name asks first: declined skips, confirmed sends overwrite:true', async () => {
    await renderRoot();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const input = screen.getByTestId('fb-upload-input');
    fireEvent.change(input, { target: { files: [new File(['v2'], 'README.md')] } });
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(calls('workspace.list').length).toBeGreaterThanOrEqual(2));
    expect(calls('workspace.write')).toHaveLength(0);
    fireEvent.change(input, { target: { files: [new File(['v2'], 'README.md')] } });
    await waitFor(() => expect(calls('workspace.write')).toHaveLength(1));
    expect(calls('workspace.write')[0]![1]).toEqual({ path: 'README.md', base64: btoa('v2'), overwrite: true });
    confirm.mockRestore();
  });

  it('edits a text file and saves via workspace.write {path, content}, then re-reads', async () => {
    await renderRoot();
    fireEvent.click(screen.getByText('README.md'));
    await waitFor(() => expect(screen.getByTestId('fb-viewer')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const editor = document.querySelector('textarea.fb-editor') as HTMLTextAreaElement;
    expect(editor.value).toBe('# Hello band');
    fireEvent.change(editor, { target: { value: '# Changed' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(calls('workspace.write')).toHaveLength(1));
    expect(calls('workspace.write')[0]![1]).toMatchObject({ path: 'README.md', content: '# Changed' });
    await waitFor(() => expect(calls('workspace.read')).toHaveLength(2));
    await waitFor(() => expect(document.querySelector('textarea.fb-editor')).toBeNull());
  });

  it('row edit button opens the file straight in the editor; 取消 leaves edit mode', async () => {
    await renderRoot();
    fireEvent.click(screen.getByRole('button', { name: '编辑 README.md' }));
    await waitFor(() => expect(document.querySelector('textarea.fb-editor')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(document.querySelector('textarea.fb-editor')).toBeNull();
    expect(calls('workspace.write')).toHaveLength(0);
  });

  it('deletes with a two-step inline confirm', async () => {
    await renderRoot();
    fireEvent.click(screen.getByRole('button', { name: '删除 cover.png' }));
    expect(calls('workspace.delete')).toHaveLength(0);
    const group = screen.getByRole('group', { name: '确认删除 cover.png' });
    expect(within(group).getByText('确认删除?')).toBeTruthy();
    fireEvent.click(within(group).getByRole('button', { name: '取消删除' }));
    expect(screen.queryByText('确认删除?')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '删除 cover.png' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(calls('workspace.delete')).toHaveLength(1));
    expect(calls('workspace.delete')[0]![1]).toEqual({ path: 'cover.png' });
    await waitFor(() => expect(calls('workspace.list').length).toBeGreaterThanOrEqual(2));
  });

  it('deleting the open file clears the viewer', async () => {
    await renderRoot();
    fireEvent.click(screen.getByText('README.md'));
    await waitFor(() => expect(screen.getByTestId('fb-viewer')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(calls('workspace.delete')).toHaveLength(1));
    expect(calls('workspace.delete')[0]![1]).toEqual({ path: 'README.md' });
    await waitFor(() => expect(screen.queryByTestId('fb-viewer')).toBeNull());
  });

  it('downloads via workspace.download and an object URL', async () => {
    await renderRoot();
    fireEvent.click(screen.getByRole('button', { name: '下载 cover.png' }));
    await waitFor(() => expect(calls('workspace.download')).toHaveLength(1));
    expect(calls('workspace.download')[0]![1]).toEqual({ path: 'cover.png' });
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const blob = createObjectURL.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(3);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    const anchor = clickSpy.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.download).toBe('cover.png');
  });

  it('falls back to fetching the signed url when download.result has no base64', async () => {
    m.rpc.mockImplementation((type: string, payload: Record<string, unknown>) =>
      type === 'workspace.download'
        ? Promise.resolve({ path: payload.path, name: 'cover.png', size: 900_000, mime_type: 'image/png', url: 'https://media.example/cover.png?sig=1', object: 'o/cover.png', expires_at: 9e9 })
        : defaultRpc(type, payload),
    );
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(['abcd'], { type: 'image/png' }) }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await renderRoot();
      fireEvent.click(screen.getByRole('button', { name: '下载 cover.png' }));
      await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
      expect(fetchMock).toHaveBeenCalledWith('https://media.example/cover.png?sig=1');
      expect((createObjectURL.mock.calls[0]![0] as Blob).size).toBe(4);
      expect((clickSpy.mock.instances[0] as unknown as HTMLAnchorElement).download).toBe('cover.png');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens the signed url directly when fetching it fails (e.g. CORS)', async () => {
    m.rpc.mockImplementation((type: string, payload: Record<string, unknown>) =>
      type === 'workspace.download'
        ? Promise.resolve({ path: payload.path, name: 'cover.png', size: 900_000, mime_type: 'image/png', url: 'https://media.example/cover.png?sig=2' })
        : defaultRpc(type, payload),
    );
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    try {
      await renderRoot();
      fireEvent.click(screen.getByRole('button', { name: '下载 cover.png' }));
      await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
      const a = clickSpy.mock.instances[0] as unknown as HTMLAnchorElement;
      expect(a.href).toBe('https://media.example/cover.png?sig=2');
      expect(createObjectURL).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('downloads an already-loaded text file without an RPC', async () => {
    await renderRoot();
    fireEvent.click(screen.getByText('README.md'));
    await waitFor(() => expect(screen.getByTestId('fb-viewer')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '下载' }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(calls('workspace.download')).toHaveLength(0);
  });

  it('views a .toml file with syntax highlighting (sections, keys, strings, comments)', async () => {
    m.rpc.mockImplementation((type: string, payload: Record<string, unknown>) => {
      if (type === 'workspace.list' && !payload.rel_path) {
        return Promise.resolve({ rel_path: '', entries: [...ROOT, { name: 'config.toml', rel_path: 'config.toml', kind: 'file', size: 64, updated_at: 100 }] });
      }
      if (type === 'workspace.read' && payload.rel_path === 'config.toml') {
        return Promise.resolve({
          rel_path: 'config.toml',
          name: 'config.toml',
          kind: 'text',
          size: 64,
          updated_at: 100,
          mime: 'application/toml',
          content: '# engine settings\n[engine]\nmodel = "qwen"\nport = 8080\ndebug = false\n',
          writable: true,
        });
      }
      return defaultRpc(type, payload);
    });
    await renderRoot();
    fireEvent.click(screen.getByText('config.toml'));
    await waitFor(() => expect(screen.getByTestId('fb-viewer')).toBeTruthy());
    const pre = screen.getByTestId('fb-code');
    expect(pre.tagName).toBe('PRE');
    expect(pre.className).toContain('k-fb-pre');
    expect(pre.getAttribute('data-lang')).toBe('toml');
    const spans = (cls: string) => Array.from(pre.querySelectorAll(`.hl-${cls}`)).map((n) => n.textContent);
    expect(spans('comment')).toEqual(['# engine settings']);
    expect(spans('sec')).toEqual(['[engine]']);
    expect(spans('key')).toEqual(['model', 'port', 'debug']);
    expect(spans('str')).toEqual(['"qwen"']);
    expect(spans('num')).toEqual(['8080']);
    expect(spans('bool')).toEqual(['false']);
    expect(pre.querySelectorAll('.hl-ln')).toHaveLength(5);
    // no Markdown 源码/预览 toggle for non-markdown files
    expect(screen.queryByRole('button', { name: '源码' })).toBeNull();
  });

  it('markdown previews via <Markdown> and its 源码 view is highlighted', async () => {
    await renderRoot();
    fireEvent.click(screen.getByText('README.md'));
    await waitFor(() => expect(screen.getByTestId('fb-viewer')).toBeTruthy());
    expect(screen.queryByTestId('fb-code')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '源码' }));
    const pre = screen.getByTestId('fb-code');
    expect(pre.getAttribute('data-lang')).toBe('markdown');
    expect(pre.querySelector('.hl-sec')?.textContent).toBe('# Hello band');
  });

  it('validEntryName rejects empty, slash and dot-dot names', () => {
    expect(validEntryName('')).toBeNull();
    expect(validEntryName('  ')).toBeNull();
    expect(validEntryName('a/b')).toBeNull();
    expect(validEntryName('..')).toBeNull();
    expect(validEntryName(' ok.md ')).toBe('ok.md');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PersonaSummary, UserProfile } from '@kesoku/protocol';

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  upload: vi.fn(),
  resolveMedia: vi.fn(async () => null as string | null),
}));
vi.mock('../../src/lib/client', () => ({ kesoku: m }));

import { PersonaStudio } from '../../src/features/persona';
import { FileBrowser } from '../../src/features/files/FileBrowser';
import { __avatarCache } from '../../src/features/persona/avatar';
import { actions, initialState, useStore } from '../../src/lib/store';

const ROLES: PersonaSummary[] = [
  { role_id: 'default', display_name: 'Default', tagline: '', builtin: true, avatar_rev: 0, avatar_ref: null },
  { role_id: 'asuka', display_name: '斋藤飞鸟 Asuka', tagline: '毒舌傲娇的专属伴游', builtin: true, avatar_rev: 2, voice_preset: 'cherry' },
  { role_id: 'coder', display_name: 'Coder', tagline: '', builtin: true, avatar_rev: 0, avatar_ref: null },
  { role_id: 'nao', display_name: '私教 Nao', tagline: '日语私教', builtin: false, avatar_rev: 0, avatar_ref: null },
];

const PROFILE: UserProfile = { nickname: '小张', bio: '软件工程师', cameo_opt_in: false, avatar_rev: 0, avatar_ref: null, character_dir: 'me_dir' };

type Call = [string, Record<string, unknown>, ...unknown[]];
const calls = (type: string) => (m.rpc.mock.calls as Call[]).filter((c) => c[0] === type);

function defaultRpc(type: string, payload: Record<string, unknown>) {
  switch (type) {
    case 'persona.get': {
      const r = ROLES.find((x) => x.role_id === payload.role_id)!;
      return Promise.resolve({ ...r, intro_md: `intro of ${r.role_id}`, preferences_md: 'prefs', readonly_notes: r.role_id === 'coder' ? '~/work (只读)' : undefined });
    }
    case 'persona.upsert':
      return Promise.resolve({ ok: true, role: { builtin: false, avatar_rev: 0, ...ROLES.find((x) => x.role_id === payload.role_id), ...payload } });
    case 'persona.delete':
      return Promise.resolve({ ok: true });
    case 'avatar.generate':
      return Promise.resolve({ job_id: 'job1', placeholders: ['ph1', 'ph2', 'ph3', 'ph4'], eta_ms: 20000 });
    case 'avatar.apply':
      return Promise.resolve({ ok: true, avatar_rev: 3 });
    case 'voice.preview':
      return Promise.resolve({ kind: 'voice', url: 'https://media.example/voice.ogg' });
    case 'user_profile.put':
      return Promise.resolve({ ok: true, profile: { ...PROFILE, ...payload } });
    case 'user_profile.get':
      return Promise.resolve(PROFILE);
    case 'workspace.list':
      return Promise.resolve({
        rel_path: payload.rel_path || '',
        awd_name: 'band',
        entries:
          payload.rel_path === 'roles'
            ? [{ name: 'asuka.md', rel_path: 'roles/asuka.md', kind: 'file', size: 42, updated_at: 100 }]
            : [
                { name: 'roles', rel_path: 'roles', kind: 'dir', size: 0, updated_at: 100 },
                { name: 'README.md', rel_path: 'README.md', kind: 'file', size: 128, updated_at: 100 },
              ],
      });
    case 'workspace.read':
      return Promise.resolve({
        rel_path: payload.rel_path,
        name: String(payload.rel_path).split('/').pop(),
        kind: 'text',
        size: 128,
        updated_at: 100,
        mime: 'text/markdown',
        content: '# Band Agent Workspace\n\nHello from band!',
      });
    default:
      return Promise.reject(Object.assign(new Error('unexpected'), { code: 'BAD_REQUEST' }));
  }
}

beforeEach(() => {
  __avatarCache.reset();
  useStore.setState(initialState(), true);
  actions.setPersonas(ROLES, [], true);
  m.rpc.mockReset().mockImplementation(defaultRpc);
  m.upload.mockReset().mockResolvedValue({ object: 'media/avatar/123e4567-e89b-12d3-a456-426614174000.png', mime: 'image/png', filename: 'a.png', bytes: 3 });
  m.resolveMedia.mockReset().mockResolvedValue(null);
});
afterEach(() => {
  cleanup(); // unmount before restoring media stubs
  vi.restoreAllMocks();
});

/** Internal file names / paths / token jargon must never reach the persona UI. */
const JARGON = [/intro\.md/, /preferences\.md/, /characters\//, /ref_face/, /0 token/i, /roles\//, /签名 URL/];
function expectNoJargon() {
  const text = document.body.textContent ?? '';
  for (const re of JARGON) expect(text).not.toMatch(re);
}

async function openRoles() {
  render(<PersonaStudio onClose={() => {}} />);
  return (await screen.findByLabelText('角色名称')) as HTMLInputElement;
}

describe('PersonaStudio · Screen 15 roles', () => {
  it('shows the role switcher with the current role and loads detail via persona.get', async () => {
    const name = await openRoles();
    expect(name.value).toBe('斋藤飞鸟 Asuka');
    expect(calls('persona.get')[0]![1]).toEqual({ role_id: 'asuka' });
    expect(screen.getByRole('radio', { name: 'AI 角色 (4)' })).toBeTruthy();
    const strip = screen.getByRole('group', { name: 'AI 角色' });
    const chips = within(strip).getAllByRole('button').map((b) => b.textContent);
    expect(chips[0]).toContain('斋藤飞鸟 Asuka');
    expect(chips[0]).toContain('当前');
    expect(chips.at(-1)).toContain('新建角色');
    expect(chips.at(-1)).not.toContain('＋');
  });

  it('builtin roles have no delete; custom roles delete via in-app two-step confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    await openRoles();
    expect(screen.getByText('内置')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '删除角色' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /私教 Nao/ }));
    await waitFor(() => expect((screen.getByLabelText('角色名称') as HTMLInputElement).value).toBe('私教 Nao'));
    expect(screen.queryByText('内置')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '删除角色' }));
    expect(calls('persona.delete')).toHaveLength(0);
    const dlg = screen.getByRole('alertdialog', { name: '确认删除角色' });
    fireEvent.click(within(dlg).getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(calls('persona.delete')[0]![1]).toEqual({ role_id: 'nao' }));
    await waitFor(() => expect(useStore.getState().personas.some((r) => r.role_id === 'nao')).toBe(false));
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('validates fields inline and blocks saving', async () => {
    const name = await openRoles();
    const save = screen.getByRole('button', { name: '保存角色设定' }) as HTMLButtonElement;
    fireEvent.change(name, { target: { value: 'x'.repeat(33) } });
    expect(screen.getByText('最多 32 个字符')).toBeTruthy();
    expect(save.disabled).toBe(true);
    fireEvent.change(name, { target: { value: '  ' } });
    expect(screen.getByText('请填写角色名称')).toBeTruthy();
    fireEvent.change(name, { target: { value: 'Asuka' } });
    expect(save.disabled).toBe(false);

    fireEvent.change(screen.getByLabelText('一句话标签'), { target: { value: '长'.repeat(81) } });
    expect(screen.getByText('最多 80 个字符')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('一句话标签'), { target: { value: '长'.repeat(45) } });
    expect(screen.getByText(/建议 ≤ 40 字/)).toBeTruthy();
    expect(save.disabled).toBe(false);

    // Markdown fields render as Markdown first; 编辑 switches to the raw textarea.
    expect(screen.queryByRole('textbox', { name: '性格与台词风格' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '性格与台词风格（点击编辑）' }));
    fireEvent.change(screen.getByLabelText('性格与台词风格'), { target: { value: 'a'.repeat(64 * 1024 + 1) } });
    expect(screen.getByText('超过 64 KiB 上限')).toBeTruthy();
    expect(save.disabled).toBe(true);

    // role_id is editable only when creating.
    expect(screen.queryByPlaceholderText(/留空按名称自动生成/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '新建角色' }));
    const rid = screen.getByPlaceholderText(/留空按名称自动生成/);
    fireEvent.change(rid, { target: { value: 'Bad-Id' } });
    expect(screen.getByText(/仅限小写字母/)).toBeTruthy();
    fireEvent.change(rid, { target: { value: 'nao' } });
    expect(screen.getByText('该 role_id 已存在')).toBeTruthy();
    expect(calls('persona.upsert')).toHaveLength(0);
  });

  it('save sends persona.upsert with the edited payload and toasts', async () => {
    await openRoles();
    fireEvent.change(screen.getByLabelText('一句话标签'), { target: { value: '新的标签' } });
    fireEvent.change(screen.getByLabelText('语音音色'), { target: { value: 'serena' } });
    fireEvent.click(screen.getByRole('button', { name: '保存角色设定' }));
    await waitFor(() => expect(calls('persona.upsert')).toHaveLength(1));
    expect(calls('persona.upsert')[0]![1]).toEqual({
      role_id: 'asuka',
      display_name: '斋藤飞鸟 Asuka',
      tagline: '新的标签',
      intro_md: 'intro of asuka',
      preferences_md: 'prefs',
      voice_preset: 'serena',
    });
    await waitFor(() => expect(useStore.getState().toasts.some((t) => t.text === '角色设定已保存')).toBe(true));
    expect(useStore.getState().personas.find((r) => r.role_id === 'asuka')!.tagline).toBe('新的标签');
  });

  it('creates a role without role_id when left blank and applies a template', async () => {
    await openRoles();
    fireEvent.click(screen.getByRole('button', { name: '新建角色' }));
    fireEvent.change(screen.getByLabelText('角色名称'), { target: { value: '旅伴 Mio' } });
    fireEvent.click(screen.getByRole('button', { name: '模板' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '伴游' }));
    expect((screen.getByLabelText('性格与台词风格') as HTMLTextAreaElement).value).toContain('随身伴游');
    // Non-empty intro → replacing needs an in-app confirmation.
    fireEvent.click(screen.getByRole('button', { name: '模板' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '空白' }));
    fireEvent.click(screen.getByRole('button', { name: '替换' }));
    expect((screen.getByLabelText('性格与台词风格') as HTMLTextAreaElement).value).toBe('');
    m.rpc.mockImplementation((type: string, payload: Record<string, unknown>) =>
      type === 'persona.upsert'
        ? Promise.resolve({ ok: true, role: { role_id: 'mio', builtin: false, avatar_rev: 0, tagline: '', ...payload } })
        : defaultRpc(type, payload),
    );
    fireEvent.click(screen.getByRole('button', { name: '创建角色' }));
    await waitFor(() => expect(calls('persona.upsert')).toHaveLength(1));
    const p = calls('persona.upsert')[0]![1];
    expect(p.role_id).toBeUndefined();
    expect(p.display_name).toBe('旅伴 Mio');
    await waitFor(() => expect(useStore.getState().personas.some((r) => r.role_id === 'mio')).toBe(true));
  });

  it('shows the read-only delegation note for Coder', async () => {
    await openRoles();
    fireEvent.click(screen.getByRole('button', { name: /^Coder/ }));
    expect(await screen.findByText('将编码任务委派给引擎主机上的本地 CLI 编码代理')).toBeTruthy();
    expect(screen.getByText('~/work (只读)')).toBeTruthy();
  });

  it('voice preview performs no rpc until tapped', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    await openRoles();
    const pill = screen.getByRole('button', { name: '播放语音' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(calls('voice.preview')).toHaveLength(0);
    expect(play).not.toHaveBeenCalled();
    fireEvent.click(pill);
    await waitFor(() => expect(calls('voice.preview')).toHaveLength(1));
    expect(calls('voice.preview')[0]![1]).toMatchObject({ voice_preset: 'cherry' });
    await waitFor(() => expect(play).toHaveBeenCalled());
  });

  it('selects a role-specific voice preset (e.g. "asuka") and previews it with role_id + toast on failure', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    m.rpc.mockImplementation((type: string, payload: Record<string, unknown>) =>
      type === 'persona.get' && payload.role_id === 'asuka'
        ? defaultRpc(type, payload).then((d) => ({ ...(d as object), voice_preset: 'asuka' }))
        : defaultRpc(type, payload),
    );
    await openRoles();
    const select = (await screen.findByLabelText('语音音色')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('asuka'));
    expect(select.selectedOptions[0]!.textContent).toBe('斋藤飞鸟 Asuka 原声 (asuka)');
    fireEvent.click(screen.getByRole('button', { name: '播放语音' }));
    await waitFor(() => expect(calls('voice.preview')).toHaveLength(1));
    expect(calls('voice.preview')[0]![1]).toMatchObject({ role_id: 'asuka', voice_preset: 'asuka' });

    // Switching the preset resets the pill so the old clip is never replayed; a failure toasts.
    m.rpc.mockImplementation((type: string, payload: Record<string, unknown>) =>
      type === 'voice.preview' ? Promise.reject(new Error('tts down')) : defaultRpc(type, payload),
    );
    fireEvent.change(select, { target: { value: 'serena' } });
    fireEvent.click(screen.getByRole('button', { name: '播放语音' }));
    await waitFor(() => expect(calls('voice.preview')).toHaveLength(2));
    expect(calls('voice.preview')[1]![1]).toMatchObject({ role_id: 'asuka', voice_preset: 'serena' });
    await waitFor(() => expect(useStore.getState().toasts.some((t) => t.text === '语音试听生成失败，请稍后重试')).toBe(true));
  });

  it('uploads a cropped avatar and commits it with persona.upsert{avatar_object}', async () => {
    await openRoles();
    const file = new File([new Uint8Array([1, 2, 3])], 'me.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('上传角色头像文件'), { target: { files: [file] } });
    fireEvent.click(await screen.findByRole('button', { name: '使用此图' }));
    await waitFor(() => expect(m.upload).toHaveBeenCalledWith(file, 'avatar_source'));
    await waitFor(() => expect(calls('persona.upsert')).toHaveLength(1));
    expect(calls('persona.upsert')[0]![1]).toMatchObject({ role_id: 'asuka', avatar_object: 'media/avatar/123e4567-e89b-12d3-a456-426614174000.png' });
  });
});

describe('PersonaStudio · Screen 16 avatar restyle', () => {
  it('generates 4 candidates, fades them in from store media and applies with register_reference', async () => {
    await openRoles();
    fireEvent.click(screen.getByRole('button', { name: 'AI 二次生成头像' }));
    expect(document.querySelector('.k-sheet.ps-gen')).toBeTruthy();
    const go = screen.getByRole('button', { name: '生成 4 张候选' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);

    const file = new File([new Uint8Array([1])], 'src.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('上传原图文件'), { target: { files: [file] } });
    await waitFor(() => expect(m.upload).toHaveBeenCalledWith(file, 'avatar_source'));
    await waitFor(() => expect(go.disabled).toBe(false));

    fireEvent.click(screen.getByRole('radio', { name: /赛博霓虹平涂/ }));
    fireEvent.change(screen.getByLabelText('细节补充'), { target: { value: '--style 保留刘海' } });
    fireEvent.click(go);
    await waitFor(() => expect(calls('avatar.generate')).toHaveLength(1));
    expect(calls('avatar.generate')[0]![1]).toEqual({
      target_type: 'role',
      target_id: 'asuka',
      source_object: 'media/avatar/123e4567-e89b-12d3-a456-426614174000.png',
      style_preset: 'cyber_flat',
      prompt_hint: 'style 保留刘海',
      count: 4,
    });

    await waitFor(() => expect(screen.getAllByTestId('ps-cand')).toHaveLength(4));
    expect(screen.getAllByTestId('ps-cand').every((el) => el.getAttribute('aria-busy') === 'true')).toBe(true);
    expect(screen.getByText(/生成中 · 约 20s/)).toBeTruthy();
    expect(useStore.getState().avatarJobs.job1).toBeTruthy();

    const apply = screen.getByRole('button', { name: '应用为角色头像' }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);

    act(() => {
      actions.setMedia('ph2', { status: 'ready', url: 'https://media.example/cand1.webp' });
      actions.setMedia('ph3', { status: 'failed', reason: 'x' });
    });
    const img = await screen.findByAltText('候选头像 #2');
    expect(img.getAttribute('src')).toBe('https://media.example/cand1.webp');
    expect(screen.getByRole('button', { name: '生成失败 · 重试' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '候选 #2' }));
    expect(screen.getByText('已选中')).toBeTruthy();
    expect(apply.disabled).toBe(false);
    expect(screen.getByRole('switch', { name: '同步为场景生图的锁脸参考' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(apply);
    await waitFor(() => expect(calls('avatar.apply')).toHaveLength(1));
    expect(calls('avatar.apply')[0]![1]).toEqual({ job_id: 'job1', index: 1, target_type: 'role', target_id: 'asuka', register_reference: false });
    await waitFor(() => expect(document.querySelector('.ps-gen')).toBeNull());
    const asuka = useStore.getState().personas.find((r) => r.role_id === 'asuka')!;
    expect(asuka.avatar_rev).toBe(3);
    expect(asuka.avatar_ai).toBe(true);
  });

  it('register_reference follows the toggle and 换一批 keeps a history strip', async () => {
    await openRoles();
    fireEvent.click(screen.getByRole('button', { name: 'AI 二次生成头像' }));
    fireEvent.change(screen.getByLabelText('上传原图文件'), { target: { files: [new File([new Uint8Array([1])], 's.png', { type: 'image/png' })] } });
    const go = screen.getByRole('button', { name: '生成 4 张候选' }) as HTMLButtonElement;
    await waitFor(() => expect(go.disabled).toBe(false));
    fireEvent.click(go);
    await waitFor(() => expect(screen.getAllByTestId('ps-cand')).toHaveLength(4));
    act(() => {
      for (const p of ['ph1', 'ph2', 'ph3', 'ph4']) actions.setMedia(p, { status: 'ready', url: `https://media.example/${p}.webp` });
    });
    m.rpc.mockImplementation((type: string, payload: Record<string, unknown>) =>
      type === 'avatar.generate' ? Promise.resolve({ job_id: 'job2', placeholders: ['q1', 'q2', 'q3', 'q4'], eta_ms: 20000 }) : defaultRpc(type, payload),
    );
    fireEvent.click(await screen.findByRole('button', { name: '换一批' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /第 2 批/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /第 1 批/ }));
    fireEvent.click(screen.getByRole('button', { name: '候选 #4' }));
    fireEvent.click(screen.getByRole('switch', { name: '同步为场景生图的锁脸参考' }));
    fireEvent.click(screen.getByRole('button', { name: '应用为角色头像' }));
    await waitFor(() => expect(calls('avatar.apply')).toHaveLength(1));
    expect(calls('avatar.apply')[0]![1]).toEqual({ job_id: 'job1', index: 3, target_type: 'role', target_id: 'asuka', register_reference: true });
  });
});

describe('PersonaStudio · avatar regeneration without re-upload', () => {
  it('a role with an existing original enables 生成 immediately and omits source_object', async () => {
    actions.setPersonas([{ ...ROLES[1]!, avatar_ref: 'roles/asuka/avatar.webp', has_source_image: true }]);
    m.resolveMedia.mockResolvedValue('https://media.example/asuka.webp');
    await openRoles();
    fireEvent.click(screen.getByRole('button', { name: 'AI 二次生成头像' }));
    const go = screen.getByRole('button', { name: '生成 4 张候选' }) as HTMLButtonElement;
    expect(go.disabled).toBe(false);
    expect(screen.getByText('当前原图')).toBeTruthy();
    expect(screen.getByText('更换原图')).toBeTruthy();
    await waitFor(() => expect(screen.getByAltText('当前原图').getAttribute('src')).toContain('https://media.example/asuka.webp'));
    fireEvent.click(go);
    await waitFor(() => expect(calls('avatar.generate')).toHaveLength(1));
    expect(m.upload).not.toHaveBeenCalled();
    const payload = calls('avatar.generate')[0]![1];
    expect(payload).toEqual({ target_type: 'role', target_id: 'asuka', style_preset: 'anime_clean', count: 4 });
    expect('source_object' in payload).toBe(false);
    await waitFor(() => expect(screen.getAllByTestId('ps-cand')).toHaveLength(4));
    expect((screen.getByRole('button', { name: '换一批' }) as HTMLButtonElement).disabled).toBe(true); // generating
  });

  it('a fresh upload still wins over the existing original', async () => {
    actions.setPersonas([{ ...ROLES[1]!, has_source_image: true }]);
    await openRoles();
    fireEvent.click(screen.getByRole('button', { name: 'AI 二次生成头像' }));
    fireEvent.change(screen.getByLabelText('上传原图文件'), { target: { files: [new File([new Uint8Array([1])], 's.png', { type: 'image/png' })] } });
    await waitFor(() => expect(m.upload).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('当前原图')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '生成 4 张候选' }));
    await waitFor(() => expect(calls('avatar.generate')).toHaveLength(1));
    expect(calls('avatar.generate')[0]![1]).toMatchObject({ source_object: 'media/avatar/123e4567-e89b-12d3-a456-426614174000.png' });
  });

  it('my profile with an existing avatar regenerates without a source_object', async () => {
    useStore.setState({ profile: { ...PROFILE, avatar_ref: 'user/avatar.webp', avatar_rev: 1, has_source_image: true } });
    render(<PersonaStudio onClose={() => {}} initialTab="me" />);
    fireEvent.click(screen.getByRole('button', { name: 'AI 风格化' }));
    const go = screen.getByRole('button', { name: '生成 4 张候选' }) as HTMLButtonElement;
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(calls('avatar.generate')).toHaveLength(1));
    expect(calls('avatar.generate')[0]![1]).not.toHaveProperty('source_object');
    expect(calls('avatar.generate')[0]![1]).toMatchObject({ target_type: 'user' });
  });
});

describe('PersonaStudio · Screen 17 my profile', () => {
  it('policy summary shows defaults, then deviations, and links to policy settings', async () => {
    const onOpen = vi.fn();
    useStore.setState({ profile: PROFILE });
    const { unmount } = render(<PersonaStudio onClose={() => {}} initialTab="me" onOpenPolicies={onOpen} />);
    expect(screen.getByTestId('ps-policy-summary').textContent).toBe('默认：日常聊天 [自动] · 其他模式 [确认]');
    fireEvent.click(screen.getByRole('button', { name: '按模式单独配置 (自动/确认/忽略)' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    unmount();

    act(() => actions.setPolicies({ policies: { galgame: 'isolated', jp_classroom: 'full' } }));
    render(<PersonaStudio onClose={() => {}} initialTab="me" />);
    const s = screen.getByTestId('ps-policy-summary').textContent ?? '';
    expect(s).toContain('约会 Galgame [忽略]');
    expect(s).toContain('日语小课堂 [自动]');
    expect(s).not.toContain('默认');
    expect(s).not.toContain('日常聊天');
  });

  it('cameo is enabled once a source photo or AI avatar exists; save sends user_profile.put', async () => {
    useStore.setState({ profile: PROFILE });
    render(<PersonaStudio onClose={() => {}} initialTab="me" />);
    const cameo = screen.getByRole('switch', { name: '允许在约会与剧场插画中与角色同框' }) as HTMLButtonElement;
    expect(cameo.disabled).toBe(true);
    expect(screen.getByText('这些信息会作为长期记忆供所有角色读取')).toBeTruthy();
    expect(screen.queryByText(/已由上传照片 AI 生成/)).toBeNull();

    // Direct uploaded source image (without AI avatar generation) is sufficient to enable cameo
    act(() => actions.setProfile({ ...PROFILE, avatar_ai: false, has_source_image: true, avatar_ref: 'user/avatar.webp' }));
    expect(cameo.disabled).toBe(false);

    act(() => actions.setProfile({ ...PROFILE, avatar_ai: true, avatar_rev: 1 }));
    expect(screen.getByRole('button', { name: '已由上传照片 AI 生成 · 重新生成' })).toBeTruthy();
    expect(cameo.disabled).toBe(false);
    fireEvent.click(cameo);
    fireEvent.change(screen.getByLabelText('我的昵称'), { target: { value: '阿张' } });
    fireEvent.click(screen.getByRole('button', { name: '保存个人形象' }));
    await waitFor(() => expect(calls('user_profile.put')).toHaveLength(1));
    expect(calls('user_profile.put')[0]![1]).toEqual({ nickname: '阿张', bio: '软件工程师', cameo_opt_in: true });
    await waitFor(() => expect(useStore.getState().profile?.nickname).toBe('阿张'));
  });

  it('AI 风格化 reuses the restyle sheet with target_type user', async () => {
    useStore.setState({ profile: PROFILE });
    render(<PersonaStudio onClose={() => {}} initialTab="me" />);
    fireEvent.click(screen.getByRole('button', { name: 'AI 风格化' }));
    fireEvent.change(screen.getByLabelText('上传原图文件'), { target: { files: [new File([new Uint8Array([1])], 's.png', { type: 'image/png' })] } });
    const go = screen.getByRole('button', { name: '生成 4 张候选' }) as HTMLButtonElement;
    await waitFor(() => expect(go.disabled).toBe(false));
    fireEvent.click(go);
    await waitFor(() => expect(calls('avatar.generate')).toHaveLength(1));
    expect(calls('avatar.generate')[0]![1]).toMatchObject({ target_type: 'user', style_preset: 'anime_clean', count: 4 });
    expect(screen.getByRole('button', { name: '应用为我的头像' })).toBeTruthy();
    expect(screen.getByText('后续场景插画将保持同一张脸')).toBeTruthy();
    expectNoJargon();
  });
});

describe('PersonaStudio · plain-language copy', () => {
  it('RolesPanel renders no internal paths, file names or emoji glyphs', async () => {
    await openRoles();
    fireEvent.click(screen.getByRole('button', { name: /偏好与规则/ }));
    expect(screen.getByLabelText('偏好与规则')).toBeTruthy();
    expect(screen.getByText('性格与台词风格')).toBeTruthy();
    expect(screen.queryByText(/仅点按/)).toBeNull();
    expectNoJargon();
    fireEvent.click(screen.getByRole('button', { name: '新建角色' }));
    expect(screen.getByText('角色 ID · 创建后不可改')).toBeTruthy();
    expectNoJargon();
    expect(document.body.textContent).not.toMatch(/[✨✓＋↻🔴🛡🔒🎙]/u);
  });

  it('ProfilePanel and AvatarSheet render no internal paths or token jargon', async () => {
    useStore.setState({ profile: { ...PROFILE, avatar_ai: true, avatar_rev: 1, avatar_ref: 'user/avatar.webp', has_source_image: true } });
    act(() => actions.setPolicies({ policies: { galgame: 'isolated' } }));
    render(<PersonaStudio onClose={() => {}} initialTab="me" />);
    expect(screen.getByText(/双人插画将直接以你的原图\/头像作为五官参考/)).toBeTruthy();
    expect(screen.getByText(/仅保存在你自己的主机上/)).toBeTruthy();
    const policy = screen.getByTestId('ps-policy-summary');
    expect(policy.querySelector('[data-mode-icon="galgame"]')).toBeTruthy();
    expect(policy.textContent).toBe('约会 Galgame [忽略]');
    expectNoJargon();
    expect(document.body.textContent).not.toMatch(/[✨✓✦🔴🛡🔒🌸]/u);

    fireEvent.click(screen.getByRole('button', { name: 'AI 风格化' }));
    expect(document.querySelector('.k-sheet.ps-gen')).toBeTruthy();
    expect(screen.getByText('同步为场景生图的锁脸参考')).toBeTruthy();
    expect(screen.getByText(/仅参考五官与发型，自动忽略道具、服饰与背景/)).toBeTruthy();
    expect(screen.getByRole('radio', { name: '日系清透立绘' })).toBeTruthy();
    expectNoJargon();
    expect(document.body.textContent).not.toMatch(/[✨✓✦＋→↻]/u);
  });
});

describe('FileBrowser · Agent workspace directory viewer', () => {
  it('lists directories and files, navigates into subdirectories, and previews Markdown files', async () => {
    const onClose = vi.fn();
    render(<FileBrowser onClose={onClose} />);
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy());
    expect(screen.getByText('roles')).toBeTruthy();

    fireEvent.click(screen.getByText('README.md'));
    await waitFor(() => expect(screen.getByTestId('fb-viewer')).toBeTruthy());
    expect(screen.getByText('Band Agent Workspace')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '源码' }));
    expect(screen.getByText(/# Band Agent Workspace/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
    fireEvent.click(screen.getByText('roles'));
    await waitFor(() => expect(screen.getByText('asuka.md')).toBeTruthy());
  });
});

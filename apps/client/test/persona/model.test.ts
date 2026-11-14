import { describe, expect, it } from 'vitest';
import { DEFAULT_MEMORY_POLICIES } from '@kesoku/protocol';
import { policyDeviations, roleAvatarRef, sanitizePromptHint, sortRoles, userAvatarRef, validatePersona, emptyDraft } from '../../src/features/persona/model';
import { withRev } from '../../src/features/persona/avatar';

describe('persona model', () => {
  it('sanitizes prompt hints', () => {
    expect(sanitizePromptHint('a\nb\r\nc')).toBe('a b c');
    expect(sanitizePromptHint('--style anime --ar 1:1 微笑')).toBe('style anime ar 1:1 微笑');
    expect(sanitizePromptHint('x\u0000\u0007y')).toBe('xy');
    expect(sanitizePromptHint('  hi  ', { trim: true })).toBe('hi');
    expect(Array.from(sanitizePromptHint('字'.repeat(100)))).toHaveLength(80);
  });

  it('validates persona drafts', () => {
    const ok = { ...emptyDraft(), display_name: 'A' };
    expect(validatePersona(ok, { isNew: false, existingIds: [] })).toEqual({});
    expect(validatePersona({ ...ok, display_name: '' }, { isNew: false, existingIds: [] }).display_name).toBeTruthy();
    expect(validatePersona({ ...ok, role_id: 'A!' }, { isNew: true, existingIds: [] }).role_id).toBeTruthy();
    expect(validatePersona({ ...ok, role_id: 'a' }, { isNew: true, existingIds: [] }).role_id).toBeTruthy();
    expect(validatePersona({ ...ok, role_id: 'good_id' }, { isNew: true, existingIds: [] })).toEqual({});
    // role_id is not validated when editing (it is not editable).
    expect(validatePersona({ ...ok, role_id: 'X' }, { isNew: false, existingIds: [] })).toEqual({});
    // 64 KiB counted in UTF-8 bytes.
    expect(validatePersona({ ...ok, intro_md: '字'.repeat(22000) }, { isNew: false, existingIds: [] }).intro_md).toBeTruthy();
  });

  it('computes policy deviations', () => {
    expect(policyDeviations({ ...DEFAULT_MEMORY_POLICIES }, { ...DEFAULT_MEMORY_POLICIES })).toEqual([]);
    expect(policyDeviations({ ...DEFAULT_MEMORY_POLICIES, trpg: 'isolated' }, {})).toEqual([{ mode: 'trpg', policy: 'isolated' }]);
  });

  it('derives avatar refs', () => {
    expect(roleAvatarRef({ role_id: 'asuka', avatar_rev: 1 })).toBe('roles/asuka/avatar.webp');
    expect(roleAvatarRef({ role_id: 'asuka', avatar_rev: 0, avatar_ref: null })).toBeNull();
    expect(roleAvatarRef({ role_id: 'asuka', avatar_rev: 0, avatar_ref: 'roles/asuka/avatar.webp' })).toBe('roles/asuka/avatar.webp');
    expect(userAvatarRef(null)).toBeNull();
    expect(userAvatarRef({ avatar_rev: 2 })).toBe('user/avatar.webp');
  });

  it('cache-busts avatar urls by revision without breaking signed urls', () => {
    expect(withRev('https://h/a.webp', 3)).toBe('https://h/a.webp?rev=3');
    expect(withRev('https://h/a.webp?x=1', 3)).toBe('https://h/a.webp?x=1&rev=3');
    expect(withRev('https://h/a.webp?X-Goog-Signature=abc', 3)).toBe('https://h/a.webp?X-Goog-Signature=abc#rev=3');
    expect(withRev('https://h/a.webp', 0)).toBe('https://h/a.webp');
  });

  it('sorts builtin roles first', () => {
    const r = (role_id: string, builtin = false) => ({ role_id, display_name: role_id, tagline: '', builtin, avatar_rev: 0 });
    expect(sortRoles([r('zed'), r('default', true), r('asuka', true), r('coder', true)]).map((x) => x.role_id)).toEqual(['asuka', 'coder', 'default', 'zed']);
  });
});

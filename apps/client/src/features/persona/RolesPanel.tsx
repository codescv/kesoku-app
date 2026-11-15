import { useEffect, useMemo, useState } from 'react';
import { LIMITS, type EngineToClientPayload, type PersonaDetail, type PersonaSummary } from '@kesoku/protocol';
import { Avatar, Pill, Skeleton, UiIcon, VoicePill } from '@kesoku/ui';
import { kesoku } from '../../lib/client';
import { actions, useStore } from '../../lib/store';
import { useAvatarUrl } from './avatar';
import { AvatarSheet, type AvatarSource } from './AvatarSheet';
import {
  CODER_NOTE,
  INTRO_TEMPLATES,
  TAGLINE_HINT,
  emptyDraft,
  errorCode,
  fallbackRoleId,
  fmtBytes,
  roleAvatarRef,
  roleSourceAvatarRef,
  sameDraft,
  sortRoles,
  utf8Bytes,
  validatePersona,
  voicePresetOptions,
  type PersonaDraft,
} from './model';
import { MarkdownEditable } from './MarkdownEditable';
import { CropSheet, Counter, FieldError, PickImageButton, makePreviewUrl } from './parts';

const NEW = '__new__';
/** Neutral Japanese sample line for voice previews (not tied to any persona). */
const VOICE_PREVIEW_TEXT = 'こんにちは！今日もよろしくね。';

function draftOf(d: PersonaDetail): PersonaDraft {
  return {
    role_id: d.role_id,
    display_name: d.display_name ?? '',
    tagline: d.tagline ?? '',
    intro_md: d.intro_md ?? '',
    preferences_md: d.preferences_md ?? '',
    voice_preset: d.voice_preset ?? null,
  };
}

function RoleChip({ role, active, current, onClick }: { role: PersonaSummary; active: boolean; current: boolean; onClick: () => void }) {
  const src = useAvatarUrl(roleAvatarRef(role), role.avatar_rev);
  return (
    <button type="button" className={'ps-chip' + (active ? ' is-on' : '')} aria-pressed={active} onClick={onClick}>
      <Avatar src={src} name={role.display_name || role.role_id} size={24} />
      <span className="ps-chip-name">{role.display_name || role.role_id}</span>
      {current && <span className="ps-chip-tag">当前</span>}
    </button>
  );
}

function BigAvatar({ role, staged, name }: { role: PersonaSummary | null; staged: string | null; name: string }) {
  const resolved = useAvatarUrl(role ? roleAvatarRef(role) : null, role?.avatar_rev);
  const src = staged ?? resolved;
  return (
    <span className="ps-big-avatar" key={src ?? 'letter'}>
      <Avatar src={src} name={name || '?'} size={84} ai={!!role?.avatar_ai && !staged} className="ps-avatar-sq" />
    </span>
  );
}

/** Screen 15 · AI role studio: role switcher + persona editor. */
export function RolesPanel({
  sources,
  setSource,
}: {
  sources: Record<string, AvatarSource | null>;
  setSource: (key: string, s: AvatarSource | null) => void;
}) {
  const personas = useStore((s) => s.personas);
  const sessionRole = useStore((s) => (s.currentSessionId ? s.sessions[s.currentSessionId]?.role : undefined));
  const roles = useMemo(() => sortRoles(personas), [personas]);
  // Generic default: the session's role, else the first role in display order — never a hardcoded persona.
  const currentRole = sessionRole ?? fallbackRoleId(personas);

  const [selected, setSelected] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, PersonaDetail>>({});
  const [drafts, setDrafts] = useState<Record<string, PersonaDraft>>({});
  const [loadErr, setLoadErr] = useState<Record<string, boolean>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const [tplPending, setTplPending] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [staged, setStaged] = useState<{ object: string; preview: string | null } | null>(null);
  const [genOpen, setGenOpen] = useState(false);

  // Default selection: the current session's role, else the first role.
  const sel = selected ?? (roles.some((r) => r.role_id === currentRole) ? currentRole : roles[0]?.role_id ?? null);
  const isNew = sel === NEW;
  const summary = isNew ? null : roles.find((r) => r.role_id === sel) ?? null;
  const detail = sel && !isNew ? details[sel] : undefined;
  const existingAvatarUrl = useAvatarUrl(summary ? roleAvatarRef(summary) : null, summary?.avatar_rev);
  const existingSourceUrl = useAvatarUrl(
    summary && (summary.has_source_image || summary.avatar_ref || summary.avatar_rev) ? roleSourceAvatarRef(summary) : null,
    summary?.avatar_rev,
  );
  const hasExistingSource = Boolean(existingSourceUrl || existingAvatarUrl || summary?.avatar_ref || summary?.has_source_image);

  useEffect(() => {
    if (!sel || isNew || details[sel] || loadErr[sel]) return;
    let alive = true;
    kesoku
      .rpc<EngineToClientPayload<'persona.get.result'>>('persona.get', { role_id: sel })
      .then((d) => {
        if (alive) setDetails((m) => ({ ...m, [sel]: d }));
      })
      .catch(() => {
        if (!alive) return;
        setLoadErr((m) => ({ ...m, [sel]: true }));
        actions.toast('角色设定加载失败', 'error');
      });
    return () => {
      alive = false;
    };
  }, [sel, isNew, details, loadErr]);

  const base: PersonaDraft | null = isNew ? emptyDraft() : detail ? draftOf(detail) : null;
  const draft: PersonaDraft | null = sel ? drafts[sel] ?? base : null;
  const dirty = !!draft && !!base && (!sameDraft(draft, base) || (isNew && !!staged));
  const errors = draft ? validatePersona(draft, { isNew, existingIds: roles.map((r) => r.role_id) }) : {};
  const hasErrors = Object.keys(errors).length > 0;

  function patch(p: Partial<PersonaDraft>) {
    if (!sel || !draft) return;
    setDrafts((m) => ({ ...m, [sel]: { ...draft, ...p } }));
  }

  function select(id: string) {
    setSelected(id);
    setConfirmDelete(false);
    setTplOpen(false);
    setTplPending(null);
    if (id !== NEW) setStaged(null);
  }

  function reset() {
    if (!sel) return;
    setDrafts((m) => {
      const n = { ...m };
      delete n[sel];
      return n;
    });
    if (isNew) setStaged(null);
  }

  function applyTemplate(id: string) {
    const t = INTRO_TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    patch({ intro_md: t.text });
    setTplPending(null);
    setTplOpen(false);
  }

  async function save() {
    if (!draft || hasErrors || saving) return;
    setSaving(true);
    const payload: Record<string, unknown> = {
      display_name: draft.display_name.trim(),
      tagline: draft.tagline.trim(),
      intro_md: draft.intro_md,
      preferences_md: draft.preferences_md,
      voice_preset: draft.voice_preset ?? null,
    };
    if (!isNew) payload.role_id = sel;
    else if (draft.role_id) payload.role_id = draft.role_id;
    if (isNew && staged) payload.avatar_object = staged.object;
    try {
      const res = await kesoku.rpc<EngineToClientPayload<'persona.upsert.result'>>('persona.upsert', payload);
      const role = res.role;
      actions.setPersonas([role]);
      setDetails((m) => ({
        ...m,
        [role.role_id]: { ...role, intro_md: draft.intro_md, preferences_md: draft.preferences_md, readonly_notes: m[role.role_id]?.readonly_notes },
      }));
      setDrafts((m) => {
        const n = { ...m };
        delete n[sel!];
        delete n[role.role_id];
        return n;
      });
      if (isNew) {
        if (staged && sources[NEW]) setSource(`role:${role.role_id}`, sources[NEW]);
        setStaged(null);
        setSelected(role.role_id);
      }
      actions.toast(isNew ? `已创建角色「${role.display_name}」` : '角色设定已保存');
    } catch (e) {
      const code = errorCode(e);
      actions.toast(code === 'BAD_REQUEST' ? '保存失败：字段不符合要求' : code === 'ENGINE_OFFLINE' ? '引擎离线，未保存' : '保存失败，请重试', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function doDelete() {
    if (!summary || summary.builtin || deleting) return;
    setDeleting(true);
    try {
      await kesoku.rpc('persona.delete', { role_id: summary.role_id });
      actions.setPersonas([], [summary.role_id]);
      setConfirmDelete(false);
      setSelected(null);
      actions.toast(`已删除角色「${summary.display_name}」`);
    } catch (e) {
      actions.toast(errorCode(e) === 'PERSONA_BUILTIN' ? '内置角色不可删除' : '删除失败，请重试', 'error');
    } finally {
      setDeleting(false);
    }
  }

  async function uploadAvatar(file: File) {
    setCropFile(null);
    if (!draft) return;
    setUploading(true);
    try {
      const up = await kesoku.upload(file, 'avatar_source');
      const preview = makePreviewUrl(file);
      if (isNew) {
        setStaged({ object: up.object, preview });
        setSource(NEW, { object: up.object, preview, at: Date.now() });
        return;
      }
      if (!detail || !sel) return;
      // Commit the avatar against the saved persona (unsaved field edits stay in the draft).
      const res = await kesoku.rpc<EngineToClientPayload<'persona.upsert.result'>>('persona.upsert', {
        role_id: sel,
        display_name: detail.display_name,
        tagline: detail.tagline ?? '',
        intro_md: detail.intro_md ?? '',
        preferences_md: detail.preferences_md ?? '',
        voice_preset: detail.voice_preset ?? null,
        avatar_object: up.object,
      });
      actions.setPersonas([res.role]);
      setSource(`role:${sel}`, { object: up.object, preview, at: Date.now() });
      actions.toast('头像已更新');
    } catch {
      actions.toast('头像上传失败，请重试', 'error');
    } finally {
      setUploading(false);
    }
  }

  const name = draft?.display_name || summary?.display_name || '';
  const introBytes = draft ? utf8Bytes(draft.intro_md) : 0;
  const prefsBytes = draft ? utf8Bytes(draft.preferences_md) : 0;
  const voiceRoleId = (isNew ? draft?.role_id : sel) || '';
  const voiceOptions = voicePresetOptions(draft ? { role_id: voiceRoleId, display_name: draft.display_name, voice_preset: draft.voice_preset } : null);
  const previewPreset = draft?.voice_preset || voiceRoleId || 'default';
  const genKey = sel ? `role:${sel}` : '';

  return (
    <div className="ps-panel">
      <div className="ps-body">
        <div className="ps-strip" role="group" aria-label="AI 角色">
          {roles.map((r) => (
            <RoleChip key={r.role_id} role={r} active={sel === r.role_id} current={r.role_id === currentRole} onClick={() => select(r.role_id)} />
          ))}
          <button type="button" className={'ps-chip ps-chip-add' + (isNew ? ' is-on' : '')} aria-pressed={isNew} onClick={() => select(NEW)}>
            <UiIcon name="plus" size={16} />
            新建角色
          </button>
        </div>

        {!sel && <Skeleton lines={4} />}
        {sel && !draft && !loadErr[sel] && (
          <div className="ps-card">
            <Skeleton lines={5} />
          </div>
        )}
        {sel && !draft && loadErr[sel] && (
          <div className="ps-card ps-row">
            <span>角色设定加载失败</span>
            <button type="button" className="ps-link" onClick={() => setLoadErr((m) => ({ ...m, [sel]: false }))}>
              重试
            </button>
          </div>
        )}

        {draft && (
          <>
            <section className="ps-card ps-avatar-card">
              <BigAvatar role={summary} staged={staged?.preview ?? null} name={name} />
              <div className="ps-avatar-main">
                <div className="ps-row">
                  <span className="ps-title">{isNew ? '新角色头像' : '角色头像'}</span>
                  {summary?.builtin && <Pill size="sm" tone="primary">内置</Pill>}
                  {summary?.avatar_ai && <Pill size="sm" tone="accent">
                      <UiIcon name="spark" size={13} /> AI 生成
                    </Pill>}
                  {summary && !summary.builtin && (
                    <button type="button" className="ps-link ps-danger" onClick={() => setConfirmDelete(true)} disabled={confirmDelete}>
                      删除角色
                    </button>
                  )}
                </div>
                <div className="ps-row ps-actions">
                  <button
                    type="button"
                    className="ps-btn-sm ps-btn-sm-pri"
                    disabled={isNew}
                    title={isNew ? '先保存角色再生成' : undefined}
                    onClick={() => setGenOpen(true)}
                  >
                    <UiIcon name="spark" size={16} />
                    AI 二次生成头像
                  </button>
                  <PickImageButton className="ps-btn-sm" onPick={setCropFile} disabled={uploading} label="上传角色头像文件">
                    {uploading ? '上传中…' : '上传图片'}
                  </PickImageButton>
                </div>
                {isNew && <span className="ps-sub">{staged ? '头像将随角色一起保存' : 'AI 生成需先保存角色'}</span>}
              </div>
            </section>

            {confirmDelete && summary && (
              <div className="ps-confirm" role="alertdialog" aria-label="确认删除角色">
                <span>
                  删除「{summary.display_name}」？角色资料将移入回收站，使用它的会话会回退到默认角色。
                </span>
                <div className="ps-row">
                  <button type="button" className="ps-btn-sm" onClick={() => setConfirmDelete(false)}>
                    取消
                  </button>
                  <button type="button" className="ps-btn-sm ps-btn-sm-danger" disabled={deleting} onClick={() => void doDelete()}>
                    {deleting ? '删除中…' : '确认删除'}
                  </button>
                </div>
              </div>
            )}

            <section className="ps-card">
              {isNew && (
                <label className="ps-field">
                  <span className="ps-label">
                    <span>角色 ID · 创建后不可改</span>
                  </span>
                  <input
                    className={'ps-input ps-mono' + (errors.role_id ? ' is-err' : '')}
                    value={draft.role_id}
                    placeholder="留空按名称自动生成，如 nao_tutor"
                    aria-invalid={!!errors.role_id}
                    aria-describedby="ps-err-role"
                    onChange={(e) => patch({ role_id: e.target.value.trim() })}
                  />
                  <FieldError id="ps-err-role" text={errors.role_id} />
                </label>
              )}
              <label className="ps-field">
                <span className="ps-label">
                  <span>角色名称</span>
                  <Counter n={draft.display_name.length} max={LIMITS.DISPLAY_NAME_MAX} />
                </span>
                <input
                  className={'ps-input ps-input-lg' + (errors.display_name ? ' is-err' : '')}
                  value={draft.display_name}
                  placeholder="如：旅伴 Mio"
                  aria-label="角色名称"
                  aria-invalid={!!errors.display_name}
                  aria-describedby="ps-err-name"
                  onChange={(e) => patch({ display_name: e.target.value })}
                />
                <FieldError id="ps-err-name" text={errors.display_name} />
              </label>
              <label className="ps-field">
                <span className="ps-label">
                  <span>一句话标签</span>
                  <Counter n={draft.tagline.length} max={LIMITS.TAGLINE_MAX} warnAt={TAGLINE_HINT} />
                </span>
                <input
                  className={'ps-input' + (errors.tagline ? ' is-err' : '')}
                  value={draft.tagline}
                  placeholder="显示于角色切换面板，建议 ≤ 40 字"
                  aria-label="一句话标签"
                  aria-invalid={!!errors.tagline}
                  aria-describedby="ps-err-tag"
                  onChange={(e) => patch({ tagline: e.target.value })}
                />
                <FieldError id="ps-err-tag" text={errors.tagline ?? (draft.tagline.length > TAGLINE_HINT ? `建议 ≤ ${TAGLINE_HINT} 字，切换面板会截断` : undefined)} />
              </label>
            </section>

            {sel === 'coder' && (
              <section className="ps-card ps-note">
                <div className="ps-row">
                  <span className="ps-title ps-icon-label">
                    <UiIcon name="file-code" size={17} /> 委派说明
                  </span>
                  <Pill size="sm">只读</Pill>
                </div>
                <div className="ps-note-text">{CODER_NOTE}</div>
                {detail?.readonly_notes && <pre className="ps-note-pre">{detail.readonly_notes}</pre>}
                <span className="ps-sub">工作目录白名单需在引擎主机配置</span>
              </section>
            )}

            <section className="ps-card">
              <MarkdownEditable
                label="性格与台词风格"
                ariaLabel="性格与台词风格"
                value={draft.intro_md}
                onChange={(v) => patch({ intro_md: v })}
                rows={7}
                invalid={!!errors.intro_md}
                resetKey={sel ?? ''}
                defaultEditing={isNew}
                placeholder="性格基调、说话风格、口头禅、禁区…（Markdown）"
                actions={
                  <>
                    <span className={'ps-count' + (errors.intro_md ? ' is-err' : '')}>{fmtBytes(introBytes)}</span>
                    <button type="button" className="ps-btn-sm ps-btn-icon" aria-expanded={tplOpen} aria-label="模板" onClick={() => setTplOpen((v) => !v)}>
                      模板 <UiIcon name="chevron-down" size={14} />
                    </button>
                  </>
                }
              />
              {tplOpen && (
                <div className="ps-tpl" role="menu" aria-label="模板">
                  {INTRO_TEMPLATES.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="menuitem"
                      className={'ps-pill-btn' + (tplPending === t.id ? ' is-on' : '')}
                      onClick={() => (draft.intro_md.trim() ? setTplPending(t.id) : applyTemplate(t.id))}
                    >
                      {t.label}
                    </button>
                  ))}
                  {tplPending && (
                    <div className="ps-tpl-confirm">
                      <span>替换当前内容？</span>
                      <button type="button" className="ps-btn-sm ps-btn-sm-pri" onClick={() => applyTemplate(tplPending)}>
                        替换
                      </button>
                      <button type="button" className="ps-btn-sm" onClick={() => setTplPending(null)}>
                        取消
                      </button>
                    </div>
                  )}
                </div>
              )}
              <FieldError id="ps-err-intro" text={errors.intro_md} />
            </section>

            <section className="ps-card">
              <MarkdownEditable
                label="偏好与规则"
                ariaLabel="偏好与规则"
                value={draft.preferences_md}
                onChange={(v) => patch({ preferences_md: v })}
                rows={5}
                invalid={!!errors.preferences_md}
                resetKey={sel ?? ''}
                defaultEditing={isNew}
                placeholder="默认模型与思考档位、默认回复语言、是否默认输出双语卡…"
                actions={<span className={'ps-count' + (errors.preferences_md ? ' is-err' : '')}>{fmtBytes(prefsBytes)}</span>}
              />
              <FieldError id="ps-err-prefs" text={errors.preferences_md} />
            </section>

            <section className="ps-card">
              <div className="ps-label">
                <span>语音音色绑定</span>
              </div>
              <div className="ps-voice-row">
                <UiIcon name="mic" size={20} className="ps-voice-ico" />
                <select
                  className="ps-select"
                  aria-label="语音音色"
                  value={draft.voice_preset ?? ''}
                  onChange={(e) => patch({ voice_preset: e.target.value || null })}
                >
                  <option value="">跟随默认声线</option>
                  {voiceOptions.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
                <VoicePill
                  key={`${voiceRoleId}:${previewPreset}`}
                  preloadKey={`${voiceRoleId}:${previewPreset}`}
                  label="点击试听"
                  className="ps-voice-pill"
                  resolveUrl={async () => {
                    try {
                      const r = await kesoku.rpc<EngineToClientPayload<'media.ready'>>(
                        'voice.preview',
                        { role_id: voiceRoleId || undefined, voice_preset: previewPreset, text: VOICE_PREVIEW_TEXT },
                        { timeoutMs: 60_000 },
                      );
                      if (!r?.url) actions.toast('语音试听生成失败，请稍后重试', 'error');
                      return r?.url || null;
                    } catch {
                      actions.toast('语音试听生成失败，请稍后重试', 'error');
                      return null;
                    }
                  }}
                />
              </div>
            </section>
          </>
        )}
      </div>

      {draft && (
        <div className="ps-dock">
          <button type="button" className="ps-btn ps-btn-sec" disabled={!dirty || saving} onClick={reset}>
            重置修改
          </button>
          <button type="button" className="ps-btn ps-btn-pri" disabled={hasErrors || saving || (!dirty && !isNew)} onClick={() => void save()}>
            {saving ? '保存中…' : (
              <>
                <UiIcon name="check" size={18} />
                {isNew ? '创建角色' : '保存角色设定'}
              </>
            )}
          </button>
        </div>
      )}

      {cropFile && <CropSheet file={cropFile} onCancel={() => setCropFile(null)} onConfirm={(f) => void uploadAvatar(f)} />}
      {genOpen && summary && (
        <AvatarSheet
          target={{ type: 'role', id: summary.role_id, name: summary.display_name }}
          source={sources[genKey] ?? null}
          onSource={(s) => setSource(genKey, s)}
          existingAvatarUrl={existingSourceUrl || existingAvatarUrl}
          hasExistingSource={hasExistingSource}
          onClose={() => setGenOpen(false)}
          onApplied={(rev) => actions.setPersonas([{ ...summary, avatar_ai: true, avatar_rev: rev ?? summary.avatar_rev + 1 }])}
        />
      )}
    </div>
  );
}

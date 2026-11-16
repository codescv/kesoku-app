import { useEffect, useState } from 'react';
import { LIMITS, type EngineToClientPayload, type UserProfile } from '@kesoku/protocol';
import { Avatar, Skeleton, UiIcon } from '@kesoku/ui';
import { kesoku } from '../../lib/client';
import { actions, useStore } from '../../lib/store';
import { useAvatarUrl } from './avatar';
import { AvatarSheet, type AvatarSource } from './AvatarSheet';
import { errorCode, fmtBytes, userAvatarRef, userSourceAvatarRef, utf8Bytes } from './model';
import { CropSheet, Counter, FieldError, PickImageButton, makePreviewUrl } from './parts';
import { MarkdownEditable } from './MarkdownEditable';

interface ProfileDraft {
  nickname: string;
  profile_md: string;
}

const USER_KEY = 'user';

function draftOf(p: UserProfile): ProfileDraft {
  return { nickname: p.nickname ?? '', profile_md: p.profile_md ?? p.bio ?? '' };
}

/** Screen 17 · My profile & avatar. */
export function ProfilePanel({
  sources,
  setSource,
}: {
  sources: Record<string, AvatarSource | null>;
  setSource: (key: string, s: AvatarSource | null) => void;
}) {
  const profile = useStore((s) => s.profile);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [genOpen, setGenOpen] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (profile || loadFailed) return;
    let alive = true;
    kesoku
      .rpc<EngineToClientPayload<'user_profile.get.result'>>('user_profile.get', {})
      .then((p) => alive && actions.setProfile(p))
      .catch(() => alive && setLoadFailed(true));
    return () => {
      alive = false;
    };
  }, [profile, loadFailed]);

  const avatarSrc = useAvatarUrl(userAvatarRef(profile), profile?.avatar_rev);
  const sourceSrc = useAvatarUrl(
    profile && (profile.has_source_image || profile.avatar_ref || profile.avatar_rev) ? userSourceAvatarRef(profile) : null,
    profile?.avatar_rev,
  );
  const hasExistingSource = Boolean(sourceSrc || avatarSrc || profile?.avatar_ref || profile?.has_source_image);

  if (!profile) {
    return (
      <div className="ps-panel">
        <div className="ps-body">
          {loadFailed ? (
            <div className="ps-card ps-row">
              <span>个人档案加载失败</span>
              <button type="button" className="ps-link" onClick={() => setLoadFailed(false)}>
                重试
              </button>
            </div>
          ) : (
            <div className="ps-card">
              <Skeleton lines={5} />
            </div>
          )}
        </div>
      </div>
    );
  }

  const base = draftOf(profile);
  const d = draft ?? base;
  const dirty = d.nickname !== base.nickname || d.profile_md !== base.profile_md;
  const hasAi = !!profile.avatar_ai;
  const profileBytes = utf8Bytes(d.profile_md);
  const errors = {
    nickname: d.nickname.length > 32 ? '最多 32 个字符' : undefined,
    profile_md: profileBytes > LIMITS.PROFILE_MD_MAX_BYTES ? '超过 12 KiB 上限' : undefined,
  };
  const hasErrors = !!(errors.nickname || errors.profile_md);
  const dir = profile.character_dir;
  const name = d.nickname || profile.nickname || '我';

  const patch = (p: Partial<ProfileDraft>) => setDraft({ ...d, ...p });

  async function save() {
    if (hasErrors || saving) return;
    setSaving(true);
    try {
      const res = await kesoku.rpc<EngineToClientPayload<'user_profile.put.result'>>('user_profile.put', {
        nickname: d.nickname.trim(),
        profile_md: d.profile_md,
        cameo_opt_in: true,
      });
      if (res?.profile) actions.setProfile(res.profile);
      setDraft(null);
      actions.toast('个人形象已保存 · 下一条消息生效');
    } catch (e) {
      actions.toast(errorCode(e) === 'ENGINE_OFFLINE' ? '引擎离线，未保存' : '保存失败，请重试', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function uploadPhoto(file: File) {
    setCropFile(null);
    setUploading(true);
    try {
      const up = await kesoku.upload(file, 'avatar_source');
      const res = await kesoku.rpc<EngineToClientPayload<'user_profile.put.result'>>('user_profile.put', {
        nickname: base.nickname,
        profile_md: base.profile_md,
        cameo_opt_in: true,
        avatar_object: up.object,
      });
      if (res?.profile) actions.setProfile(res.profile);
      setSource(USER_KEY, { object: up.object, preview: makePreviewUrl(file), at: Date.now() });
      actions.toast('头像已更新');
    } catch {
      actions.toast('照片上传失败，请重试', 'error');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="ps-panel">
      <div className="ps-body">
        <section className="ps-card ps-avatar-card ps-avatar-card-user">
          <span className="ps-big-avatar" key={avatarSrc ?? 'letter'}>
            <Avatar src={avatarSrc} name={name} size={84} ai={hasAi} className="ps-avatar-sq" />
          </span>
          <div className="ps-avatar-main">
            <div className="ps-row">
              <span className="ps-title">我的头像与参考照</span>
            </div>
            {hasAi && (
              <button type="button" className="ps-ai-badge" onClick={() => setGenOpen(true)}>
                <UiIcon name="spark" size={14} /> 已由上传照片 AI 生成 · 重新生成
              </button>
            )}
            <div className="ps-row ps-actions">
              <PickImageButton className="ps-btn-sm" onPick={setCropFile} disabled={uploading} label="上传照片文件">
                {uploading ? '上传中…' : '上传照片'}
              </PickImageButton>
              <button type="button" className="ps-btn-sm ps-btn-sm-pri" onClick={() => setGenOpen(true)}>
                <UiIcon name="spark" size={16} />
                AI 风格化
              </button>
            </div>
          </div>
        </section>

        <section className="ps-card">
          <label className="ps-field">
            <span className="ps-label">
              <span>我的昵称 / 称呼</span>
              <Counter n={d.nickname.length} max={32} />
            </span>
            <input
              className={'ps-input ps-input-lg' + (errors.nickname ? ' is-err' : '')}
              value={d.nickname}
              placeholder="角色对你的称呼，如：小张"
              aria-label="我的昵称"
              aria-invalid={!!errors.nickname}
              onChange={(e) => patch({ nickname: e.target.value })}
            />
            <FieldError id="ps-err-nick" text={errors.nickname} />
          </label>
          <div className="ps-field">
            <MarkdownEditable
              label="个人档案 (user/profile.md)"
              ariaLabel="个人档案 (user/profile.md)"
              value={d.profile_md}
              onChange={(v) => patch({ profile_md: v })}
              rows={6}
              invalid={!!errors.profile_md}
              placeholder="职业、爱好、忌口、学习进度…"
              actions={<span className={'ps-count' + (errors.profile_md ? ' is-err' : '')}>{`${fmtBytes(profileBytes)} / 12 KiB`}</span>}
            />
            <FieldError id="ps-err-bio" text={errors.profile_md} />
            <span className="ps-sub ps-icon-label">
              <UiIcon name="brain" size={14} /> AI 会在对话中自动补充更新此档案，你也可以随时在此直接修改，所有角色共享且下一条消息生效
            </span>
          </div>
        </section>
      </div>

      <div className="ps-dock">
        <button type="button" className="ps-btn ps-btn-sec" disabled={!dirty || saving} onClick={() => setDraft(null)}>
          重置修改
        </button>
        <button type="button" className="ps-btn ps-btn-pri" disabled={!dirty || hasErrors || saving} onClick={() => void save()}>
          {saving ? '保存中…' : (
            <>
              <UiIcon name="check" size={18} />
              保存个人形象
            </>
          )}
        </button>
      </div>

      {cropFile && <CropSheet file={cropFile} onCancel={() => setCropFile(null)} onConfirm={(f) => void uploadPhoto(f)} />}
      {genOpen && (
        <AvatarSheet
          target={{ type: 'user', id: USER_KEY, name, characterDir: dir }}
          source={sources[USER_KEY] ?? null}
          onSource={(s) => setSource(USER_KEY, s)}
          existingAvatarUrl={sourceSrc || avatarSrc}
          hasExistingSource={hasExistingSource}
          onClose={() => setGenOpen(false)}
          onApplied={(rev) => {
            const cur = useStore.getState().profile ?? profile;
            actions.setProfile({ ...cur, avatar_ai: true, avatar_rev: rev ?? (cur.avatar_rev ?? 0) + 1 });
          }}
        />
      )}
    </div>
  );
}

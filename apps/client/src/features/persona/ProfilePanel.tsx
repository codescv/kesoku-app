import { useEffect, useState } from 'react';
import { LIMITS, type EngineToClientPayload, type UserProfile } from '@kesoku/protocol';
import { Avatar, Skeleton, UiIcon, useT } from '@kesoku/ui';
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
  const t = useT();
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
              <span>{t('persona.profileLoadFailed')}</span>
              <button type="button" className="ps-link" onClick={() => setLoadFailed(false)}>
                {t('common.retry')}
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
    nickname: d.nickname.length > 32 ? t('persona.maxChars', { max: 32 }) : undefined,
    profile_md: profileBytes > LIMITS.PROFILE_MD_MAX_BYTES ? t('persona.exceeds12KiB') : undefined,
  };
  const hasErrors = !!(errors.nickname || errors.profile_md);
  const dir = profile.character_dir;
  const name = d.nickname || profile.nickname || t('common.me');

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
      actions.toast(t('persona.profileSaved'));
    } catch (e) {
      actions.toast(errorCode(e) === 'ENGINE_OFFLINE' ? t('common.engineOfflineUnsaved') : t('common.saveFailedRetry'), 'error');
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
      actions.toast(t('persona.avatarUpdated'));
    } catch {
      actions.toast(t('persona.photoUploadFailed'), 'error');
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
              <span className="ps-title">{t('persona.myAvatarTitle')}</span>
            </div>
            {hasAi && (
              <button type="button" className="ps-ai-badge" onClick={() => setGenOpen(true)}>
                <UiIcon name="spark" size={14} /> {t('persona.aiGeneratedRegen')}
              </button>
            )}
            <div className="ps-row ps-actions">
              <PickImageButton className="ps-btn-sm" onPick={setCropFile} disabled={uploading} label={t('persona.uploadPhotoAria')}>
                {uploading ? t('common.uploading') : t('persona.uploadPhoto')}
              </PickImageButton>
              <button type="button" className="ps-btn-sm ps-btn-sm-pri" onClick={() => setGenOpen(true)}>
                <UiIcon name="spark" size={16} />
                {t('persona.aiStylize')}
              </button>
            </div>
          </div>
        </section>

        <section className="ps-card">
          <label className="ps-field">
            <span className="ps-label">
              <span>{t('persona.myNickname')}</span>
              <Counter n={d.nickname.length} max={32} />
            </span>
            <input
              className={'ps-input ps-input-lg' + (errors.nickname ? ' is-err' : '')}
              value={d.nickname}
              placeholder={t('persona.nicknamePlaceholder')}
              aria-label={t('persona.nicknameAria')}
              aria-invalid={!!errors.nickname}
              onChange={(e) => patch({ nickname: e.target.value })}
            />
            <FieldError id="ps-err-nick" text={errors.nickname} />
          </label>
          <div className="ps-field">
            <MarkdownEditable
              label={t('persona.profileMdLabel')}
              ariaLabel={t('persona.profileMdLabel')}
              value={d.profile_md}
              onChange={(v) => patch({ profile_md: v })}
              rows={6}
              invalid={!!errors.profile_md}
              placeholder={t('persona.profileMdPlaceholder')}
              actions={<span className={'ps-count' + (errors.profile_md ? ' is-err' : '')}>{`${fmtBytes(profileBytes)} / 12 KiB`}</span>}
            />
            <FieldError id="ps-err-bio" text={errors.profile_md} />
            <span className="ps-sub ps-icon-label">
              <UiIcon name="brain" size={14} /> {t('persona.profileMdHint')}
            </span>
          </div>
        </section>
      </div>

      <div className="ps-dock">
        <button type="button" className="ps-btn ps-btn-sec" disabled={!dirty || saving} onClick={() => setDraft(null)}>
          {t('persona.resetChanges')}
        </button>
        <button type="button" className="ps-btn ps-btn-pri" disabled={!dirty || hasErrors || saving} onClick={() => void save()}>
          {saving ? t('common.saving') : (
            <>
              <UiIcon name="check" size={18} />
              {t('persona.saveProfile')}
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

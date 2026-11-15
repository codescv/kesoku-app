import { useEffect, useState } from 'react';
import { LIMITS, type EngineToClientPayload, type UserProfile } from '@kesoku/protocol';
import { Avatar, MODES, ModeIcon, POLICY_BADGE, Pill, Skeleton, UiIcon } from '@kesoku/ui';
import { kesoku } from '../../lib/client';
import { actions, useStore } from '../../lib/store';
import { useAvatarUrl } from './avatar';
import { AvatarSheet, type AvatarSource } from './AvatarSheet';
import { errorCode, fmtBytes, policyDeviations, userAvatarRef, userSourceAvatarRef, utf8Bytes } from './model';
import { CropSheet, Counter, FieldError, PickImageButton, Switch, makePreviewUrl } from './parts';

interface ProfileDraft {
  nickname: string;
  bio: string;
  cameo_opt_in: boolean;
}

const USER_KEY = 'user';

function draftOf(p: UserProfile): ProfileDraft {
  return { nickname: p.nickname ?? '', bio: p.bio ?? '', cameo_opt_in: !!p.cameo_opt_in };
}

/** `跨模式记忆沉淀策略` summary: defaults line, or the modes deviating from the defaults. */
export function PolicySummary({ onOpenPolicies }: { onOpenPolicies?: () => void }) {
  const policies = useStore((s) => s.policies);
  const dev = policyDeviations(policies.policies, policies.defaults);
  return (
    <section className="ps-card">
      <div className="ps-label">
        <span className="ps-icon-label">
          <UiIcon name="shield" size={16} /> 跨模式记忆沉淀策略
        </span>
        <Pill size="sm" tone="primary">8 模式可独立配置</Pill>
      </div>
      <div className="ps-policy" data-testid="ps-policy-summary">
        {dev.length === 0 ? (
          <span className="ps-policy-pill">默认：日常聊天 [自动] · 其他模式 [确认]</span>
        ) : (
          dev.map((d) => (
            <span key={d.mode} className={`ps-policy-pill is-${d.policy}`}>
              <ModeIcon mode={d.mode} size={16} />
              {`${MODES[d.mode].title} [${POLICY_BADGE[d.policy].label}]`}
            </span>
          ))
        )}
      </div>
      <button type="button" className="ps-link-btn" disabled={!onOpenPolicies} onClick={onOpenPolicies}>
        按模式单独配置 (自动/确认/忽略)
        <UiIcon name="chevron-right" size={14} />
      </button>
      <span className="ps-sub">个人介绍写入的是长期档案，不受各模式记忆策略影响</span>
    </section>
  );
}

/** Screen 17 · My profile & avatar. */
export function ProfilePanel({
  sources,
  setSource,
  onOpenPolicies,
}: {
  sources: Record<string, AvatarSource | null>;
  setSource: (key: string, s: AvatarSource | null) => void;
  onOpenPolicies?: () => void;
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
  const dirty = d.nickname !== base.nickname || d.bio !== base.bio || d.cameo_opt_in !== base.cameo_opt_in;
  const hasAi = !!profile.avatar_ai;
  const bioBytes = utf8Bytes(d.bio);
  const errors = {
    nickname: d.nickname.length > 32 ? '最多 32 个字符' : undefined,
    bio: bioBytes > LIMITS.BIO_MAX_BYTES ? '超过 2 KiB 上限' : undefined,
  };
  const hasErrors = !!(errors.nickname || errors.bio);
  const dir = profile.character_dir;
  const name = d.nickname || profile.nickname || '我';

  const patch = (p: Partial<ProfileDraft>) => setDraft({ ...d, ...p });

  async function save() {
    if (hasErrors || saving) return;
    setSaving(true);
    try {
      const res = await kesoku.rpc<EngineToClientPayload<'user_profile.put.result'>>('user_profile.put', {
        nickname: d.nickname.trim(),
        bio: d.bio,
        cameo_opt_in: hasAi ? d.cameo_opt_in : false,
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
        bio: base.bio,
        cameo_opt_in: base.cameo_opt_in,
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
              <span className="ps-title">我的头像与二次元形象</span>
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
          <label className="ps-field">
            <span className="ps-label">
              <span>个人介绍与背景</span>
              <span className={'ps-count' + (errors.bio ? ' is-err' : '')}>{`${fmtBytes(bioBytes)} / 2 KiB`}</span>
            </span>
            <textarea
              className={'ps-textarea' + (errors.bio ? ' is-err' : '')}
              rows={4}
              value={d.bio}
              placeholder="职业、爱好、忌口、学习进度…"
              aria-label="个人介绍与背景"
              aria-invalid={!!errors.bio}
              onChange={(e) => patch({ bio: e.target.value })}
            />
            <FieldError id="ps-err-bio" text={errors.bio} />
            <span className="ps-sub ps-icon-label">
              <UiIcon name="brain" size={14} /> 这些信息会作为长期记忆供所有角色读取
            </span>
          </label>
        </section>

        <section className="ps-card">
          <div className="ps-row ps-between">
            <div>
              <div className="ps-strong">允许在约会与剧场插画中以二次元形象同框</div>
              <div className="ps-sub">
                {hasAi ? '开启后作为我的锁脸参考' : '需先生成 AI 头像'}
              </div>
            </div>
            <Switch
              checked={hasAi && d.cameo_opt_in}
              disabled={!hasAi}
              onChange={(v) => patch({ cameo_opt_in: v })}
              label="允许在约会与剧场插画中以二次元形象同框"
            />
          </div>
        </section>

        <PolicySummary onOpenPolicies={onOpenPolicies} />

        <div className="ps-privacy ps-icon-label">
          <UiIcon name="shield" size={16} />
          <span>头像与原照片仅保存在你自己的主机上，不会在云端留存。</span>
        </div>
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

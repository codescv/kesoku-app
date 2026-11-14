import { useEffect, useState } from 'react';
import { LIMITS, type AvatarStylePreset, type EngineToClientPayload } from '@kesoku/protocol';
import { Sheet } from '@kesoku/ui';
import { kesoku } from '../../lib/client';
import { actions, useStore } from '../../lib/store';
import { SOURCE_REUSE_MS, STYLE_PRESETS, STYLE_PRESET_LABELS, errorCode, sanitizePromptHint } from './model';
import { PickImageButton, Switch, makePreviewUrl } from './parts';

export interface AvatarSource {
  object: string;
  preview: string | null;
  at: number;
}

export interface AvatarTarget {
  type: 'role' | 'user';
  id: string;
  name: string;
  /** `characters/<dir>/` that receives the face reference. */
  characterDir?: string;
}

interface Batch {
  job_id: string;
  placeholders: string[];
  eta_ms: number;
  startedAt: number;
  style: AvatarStylePreset;
}

const MAX_BATCHES = 3;

export function isFreshSource(s: AvatarSource | null | undefined): s is AvatarSource {
  return !!s && Date.now() - s.at < SOURCE_REUSE_MS;
}

/** One candidate tile; fades in as its placeholder becomes ready. */
function Candidate({
  placeholder,
  index,
  selected,
  onSelect,
  onRetry,
}: {
  placeholder: string;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onRetry: () => void;
}) {
  const entry = useStore((s) => s.media[placeholder]);
  const status = entry?.status ?? 'pending';
  if (status === 'failed') {
    return (
      <div className="ps-cand is-failed" data-testid="ps-cand">
        <button type="button" className="ps-cand-retry" onClick={onRetry}>
          生成失败 · 重试
        </button>
        <span className="ps-cand-no">#{index + 1}</span>
      </div>
    );
  }
  if (status !== 'ready' || !entry?.url) {
    return (
      <div className="ps-cand is-pending" data-testid="ps-cand" aria-busy="true" aria-label={`候选 #${index + 1} 生成中`}>
        <span className="ps-cand-pulse" />
        <span className="ps-cand-no">#{index + 1}</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      className={'ps-cand is-ready' + (selected ? ' is-picked' : '')}
      data-testid="ps-cand"
      aria-pressed={selected}
      aria-label={`候选 #${index + 1}`}
      onClick={onSelect}
    >
      <img src={entry.url} alt={`候选头像 #${index + 1}`} draggable={false} />
      {selected && <span className="ps-cand-check">✓ 已选中</span>}
      <span className="ps-cand-no">#{index + 1}</span>
    </button>
  );
}

function BatchThumb({ batch, n, active, onClick }: { batch: Batch; n: number; active: boolean; onClick: () => void }) {
  const urls = useStore((s) => batch.placeholders.map((p) => (s.media[p]?.status === 'ready' ? s.media[p]?.url ?? '' : '')).join('\n'));
  const list = urls.split('\n');
  return (
    <button type="button" className={'ps-hist' + (active ? ' is-on' : '')} aria-pressed={active} onClick={onClick}>
      <span className="ps-hist-grid" aria-hidden>
        {list.map((u, i) => (u ? <img key={i} src={u} alt="" /> : <i key={i} />))}
      </span>
      <span>第 {n} 批</span>
    </button>
  );
}

/** Screen 16 · Upload → AI avatar restyle sheet (dark), shared by roles (15) and the user profile (17). */
export function AvatarSheet({
  target,
  source,
  onSource,
  onClose,
  onApplied,
  existingAvatarUrl,
  hasExistingSource,
}: {
  target: AvatarTarget;
  source: AvatarSource | null;
  onSource: (s: AvatarSource | null) => void;
  onClose: () => void;
  onApplied?: (avatarRev?: number) => void;
  /** Current avatar of the target, shown as the default source thumbnail. */
  existingAvatarUrl?: string | null;
  /** The engine already keeps an original image for the target → generation needs no upload. */
  hasExistingSource?: boolean;
}) {
  const [style, setStyle] = useState<AvatarStylePreset>('anime_clean');
  const [hint, setHint] = useState('');
  const [uploading, setUploading] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [view, setView] = useState(0);
  const [pick, setPick] = useState<{ job_id: string; index: number } | null>(null);
  const [registerRef, setRegisterRef] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  const batch = batches[view] ?? null;
  const statuses = useStore((s) => (batch ? batch.placeholders.map((p) => s.media[p]?.status ?? 'pending').join(',') : ''));
  const list = statuses ? statuses.split(',') : [];
  const generating = requesting || list.some((x) => x === 'pending');
  const allFailed = list.length > 0 && list.every((x) => x === 'failed');
  const pickedReady = useStore((s) => {
    if (!pick) return false;
    const b = batches.find((x) => x.job_id === pick.job_id);
    const ph = b?.placeholders[pick.index];
    return !!ph && s.media[ph]?.status === 'ready';
  });
  const fresh = isFreshSource(source);
  /** No uploaded photo: regenerate from the target's existing original image (no re-upload). */
  const usingExisting = !source && !!hasExistingSource;
  const canGenerate = fresh || usingExisting;

  useEffect(() => {
    if (!generating) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [generating]);

  async function upload(file: File) {
    setUploading(true);
    try {
      const r = await kesoku.upload(file, 'avatar_source');
      onSource({ object: r.object, preview: makePreviewUrl(file), at: Date.now() });
    } catch {
      actions.toast('原图上传失败，请重试', 'error');
    } finally {
      setUploading(false);
    }
  }

  async function generate() {
    const freshNow = isFreshSource(source);
    const useExisting = !source && !!hasExistingSource;
    if ((!freshNow && !useExisting) || requesting) {
      if (!freshNow && !useExisting) actions.toast(source && hasExistingSource ? '上传的原图已过期，请重新上传或使用默认原图' : '请先上传原图', 'error');
      return;
    }
    const prompt_hint = sanitizePromptHint(hint, { trim: true });
    setRequesting(true);
    try {
      const job = await kesoku.rpc<EngineToClientPayload<'avatar.job'>>(
        'avatar.generate',
        {
          target_type: target.type,
          target_id: target.id,
          // Fresh upload → send it; otherwise omit so the engine uses the existing original on disk.
          ...(freshNow ? { source_object: source.object } : {}),
          style_preset: style,
          ...(prompt_hint ? { prompt_hint } : {}),
          count: 4,
        },
        { timeoutMs: 30_000 },
      );
      const b: Batch = { job_id: job.job_id, placeholders: job.placeholders.slice(0, 4), eta_ms: job.eta_ms ?? 20_000, startedAt: Date.now(), style };
      actions.addAvatarJob({ job_id: b.job_id, placeholders: b.placeholders, eta_ms: b.eta_ms, startedAt: b.startedAt });
      setNow(Date.now());
      const next = [...batches, b].slice(-MAX_BATCHES);
      setBatches(next);
      setView(next.length - 1);
    } catch (e) {
      const code = errorCode(e);
      if (code === 'RATE_LIMITED') actions.toast('生成太频繁，请稍后再试', 'error');
      else if (code === 'AVATAR_SOURCE_INVALID') {
        actions.toast(freshNow ? '原图无效或已过期，请重新上传' : '默认原图不可用，请上传原图', 'error');
        onSource(null);
      } else if (code === 'ENGINE_OFFLINE') actions.toast('🔴 引擎离线，无法生成', 'error');
      else actions.toast('生成请求失败，请重试', 'error');
    } finally {
      setRequesting(false);
    }
  }

  async function apply() {
    if (!pick || !pickedReady || applying) return;
    setApplying(true);
    try {
      const res = await kesoku.rpc<EngineToClientPayload<'avatar.apply.result'>>(
        'avatar.apply',
        { job_id: pick.job_id, index: pick.index, target_type: target.type, target_id: target.id, register_reference: registerRef },
        { timeoutMs: 30_000 },
      );
      actions.toast(target.type === 'user' ? '✨ 已应用为我的头像' : `✨ 已应用为「${target.name}」的头像`);
      onApplied?.(res?.avatar_rev);
      onClose();
    } catch (e) {
      actions.toast(errorCode(e) === 'NOT_FOUND' ? '候选已过期，请重新生成' : '应用头像失败，请重试', 'error');
    } finally {
      setApplying(false);
    }
  }

  const etaLeft = batch && !requesting ? Math.ceil((batch.startedAt + batch.eta_ms - now) / 1000) : 20;
  const progress = etaLeft > 0 ? `生成中 · 约 ${etaLeft}s` : '生成中 · 即将完成';
  const dir = target.characterDir ?? (target.type === 'role' ? target.id : '');
  const applyLabel = target.type === 'user' ? '✨ 应用为我的头像' : '✨ 应用为角色头像';

  return (
    <Sheet open onClose={onClose} title="头像二次 AI 风格化" className="ps-gen" height="full">
      <div className="ps-gen-body">
        <section className="ps-gen-card">
          <div className="ps-gen-src-row">
            <div className="ps-gen-src">
              <span className="ps-gen-src-thumb">
                {usingExisting ? (
                  existingAvatarUrl ? (
                    <img src={existingAvatarUrl} alt="当前原图" />
                  ) : (
                    <span aria-hidden>✓</span>
                  )
                ) : source?.preview ? (
                  <img src={source.preview} alt="已上传原图" />
                ) : (
                  <span aria-hidden>{fresh ? '✓' : '＋'}</span>
                )}
                <span className="ps-gen-src-tag">{usingExisting ? '当前原图' : '原图'}</span>
              </span>
              <PickImageButton className="ps-link" onPick={(f) => void upload(f)} disabled={uploading} label="上传原图文件">
                {uploading ? '上传中…' : source || usingExisting ? '更换原图' : '上传原图'}
              </PickImageButton>
              {source && !fresh && hasExistingSource && (
                <button type="button" className="ps-link" onClick={() => onSource(null)}>
                  使用默认原图
                </button>
              )}
            </div>
            <span className="ps-gen-arrow" aria-hidden>
              →
            </span>
            <div className="ps-presets" role="radiogroup" aria-label="画风预设">
              {STYLE_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={style === p}
                  className={'ps-preset' + (style === p ? ' is-on' : '')}
                  onClick={() => setStyle(p)}
                >
                  {STYLE_PRESET_LABELS[p]}
                  {style === p ? ' ✓' : ''}
                </button>
              ))}
            </div>
          </div>
          {source && !fresh && (
            <div className="ps-gen-warn">{hasExistingSource ? '上传的原图已超过 10 分钟，请重新上传或使用默认原图' : '原图已超过 10 分钟，请重新上传后再生成'}</div>
          )}
          <label className="ps-hint">
            <span className="ps-hint-k">细节补充</span>
            <input
              value={hint}
              maxLength={LIMITS.PROMPT_HINT_MAX}
              placeholder="可选，如：保留刘海特征，微侧头浅笑，柔和暖光"
              aria-label="细节补充"
              onChange={(e) => setHint(sanitizePromptHint(e.target.value))}
            />
            <span className="ps-count">{`${Array.from(hint).length}/${LIMITS.PROMPT_HINT_MAX}`}</span>
          </label>
          <button type="button" className="ps-btn ps-btn-pri ps-gen-go" disabled={!canGenerate || generating || uploading} onClick={() => void generate()}>
            {generating ? (
              <>
                <span className="ps-ring" aria-hidden /> {progress}
              </>
            ) : (
              '✨ 生成 4 张候选'
            )}
          </button>
        </section>

        {batch ? (
          <section className="ps-gen-grid-wrap">
            <div className="ps-gen-head">
              <span className="ps-strong">✨ AI 候选头像 · 点击择一</span>
              <span className="ps-pill-mini">{STYLE_PRESET_LABELS[batch.style].replace('✦ ', '')}</span>
              <button type="button" className="ps-link" disabled={!canGenerate || generating || uploading} onClick={() => void generate()}>
                ↻ 换一批
              </button>
            </div>
            <div className="ps-cand-grid">
              {batch.placeholders.map((ph, i) => (
                <Candidate
                  key={ph}
                  placeholder={ph}
                  index={i}
                  selected={pick?.job_id === batch.job_id && pick.index === i}
                  onSelect={() => setPick({ job_id: batch.job_id, index: i })}
                  onRetry={() => void generate()}
                />
              ))}
            </div>
            {allFailed && <div className="ps-gen-warn">全部生成失败 · 试试更换原图或画风</div>}
            {batches.length > 1 && (
              <div className="ps-hist-strip" aria-label="历史批次">
                {batches.map((b, i) => (
                  <BatchThumb key={b.job_id} batch={b} n={i + 1} active={i === view} onClick={() => setView(i)} />
                ))}
              </div>
            )}
          </section>
        ) : (
          <div className="ps-gen-empty">{canGenerate ? '选择画风后生成 4 张候选 · 保留脸型 / 发型 / 配饰，只改画风' : '① 上传原图 → ② 选画风 → ③ 生成 4 张候选'}</div>
        )}

        <div className="ps-gen-toggle">
          <div>
            <div className="ps-strong">同步为场景生图锁脸参考图 (characters/)</div>
            <div className="ps-sub">{dir ? `保存 ref_face.webp 并更新 characters/${dir}/characters.json` : '保存 ref_face.webp 并更新 characters.json'}</div>
          </div>
          <Switch checked={registerRef} onChange={setRegisterRef} label="同步为场景生图锁脸参考图" />
        </div>
      </div>
      <div className="ps-dock ps-dock-dark">
        <button type="button" className="ps-btn ps-btn-sec" onClick={onClose}>
          取消
        </button>
        <button type="button" className="ps-btn ps-btn-pri" disabled={!pickedReady || applying} onClick={() => void apply()}>
          {applying ? '应用中…' : applyLabel}
        </button>
      </div>
    </Sheet>
  );
}

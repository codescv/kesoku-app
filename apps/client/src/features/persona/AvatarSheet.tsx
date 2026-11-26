import { useEffect, useState } from 'react';
import { LIMITS, type AvatarStylePreset, type EngineToClientPayload } from '@kesoku/protocol';
import { Sheet, UiIcon, useT } from '@kesoku/ui';
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

/** Style preset label without the decorative `✦ ` marker. */
function presetLabel(p: AvatarStylePreset): string {
  return STYLE_PRESET_LABELS[p].replace(/^✦\s*/, '');
}

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
  const t = useT();
  const entry = useStore((s) => s.media[placeholder]);
  const status = entry?.status ?? 'pending';
  if (status === 'failed') {
    return (
      <div className="ps-cand is-failed" data-testid="ps-cand">
        <button type="button" className="ps-cand-retry" onClick={onRetry}>
          {t('avatar.candFailedRetry')}
        </button>
        <span className="ps-cand-no">#{index + 1}</span>
      </div>
    );
  }
  if (status !== 'ready' || !entry?.url) {
    return (
      <div className="ps-cand is-pending" data-testid="ps-cand" aria-busy="true" aria-label={t('avatar.candPendingAria', { n: index + 1 })}>
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
      aria-label={t('avatar.candAria', { n: index + 1 })}
      onClick={onSelect}
    >
      <img src={entry.url} alt={t('avatar.candAlt', { n: index + 1 })} draggable={false} />
      {selected && (
        <span className="ps-cand-check">
          <UiIcon name="check" size={13} /> {t('avatar.selected')}
        </span>
      )}
      <span className="ps-cand-no">#{index + 1}</span>
    </button>
  );
}

function BatchThumb({ batch, n, active, onClick }: { batch: Batch; n: number; active: boolean; onClick: () => void }) {
  const t = useT();
  const urls = useStore((s) => batch.placeholders.map((p) => (s.media[p]?.status === 'ready' ? s.media[p]?.url ?? '' : '')).join('\n'));
  const list = urls.split('\n');
  return (
    <button type="button" className={'ps-hist' + (active ? ' is-on' : '')} aria-pressed={active} onClick={onClick}>
      <span className="ps-hist-grid" aria-hidden>
        {list.map((u, i) => (u ? <img key={i} src={u} alt="" /> : <i key={i} />))}
      </span>
      <span>{t('avatar.batchN', { n })}</span>
    </button>
  );
}

/** Screen 16 · Upload → AI avatar restyle sheet (follows the active theme), shared by roles (15) and the user profile (17). */
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
  const t = useT();
  const [style, setStyle] = useState<AvatarStylePreset>('anime_clean');
  const [hint, setHint] = useState('');
  const [uploading, setUploading] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [view, setView] = useState(0);
  const [pick, setPick] = useState<{ job_id: string; index: number } | null>(null);
  const [registerRef, setRegisterRef] = useState(false);
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
      actions.toast(t('avatar.sourceUploadFailed'), 'error');
    } finally {
      setUploading(false);
    }
  }

  async function generate() {
    const freshNow = isFreshSource(source);
    const useExisting = !source && !!hasExistingSource;
    if ((!freshNow && !useExisting) || requesting) {
      if (!freshNow && !useExisting) actions.toast(source && hasExistingSource ? t('avatar.sourceExpiredChoose') : t('avatar.uploadSourceFirst'), 'error');
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
      if (code === 'RATE_LIMITED') actions.toast(t('avatar.rateLimited'), 'error');
      else if (code === 'AVATAR_SOURCE_INVALID') {
        actions.toast(freshNow ? t('avatar.sourceInvalidReupload') : t('avatar.defaultSourceUnavailable'), 'error');
        onSource(null);
      } else if (code === 'ENGINE_OFFLINE') actions.toast(t('avatar.engineOfflineGen'), 'error');
      else actions.toast(t('avatar.genRequestFailed'), 'error');
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
      actions.toast(target.type === 'user' ? t('avatar.appliedUser') : t('avatar.appliedRole', { name: target.name }));
      onApplied?.(res?.avatar_rev);
      onClose();
    } catch (e) {
      actions.toast(errorCode(e) === 'NOT_FOUND' ? t('avatar.candExpired') : t('avatar.applyFailed'), 'error');
    } finally {
      setApplying(false);
    }
  }

  const etaLeft = batch && !requesting ? Math.ceil((batch.startedAt + batch.eta_ms - now) / 1000) : 20;
  const progress = etaLeft > 0 ? t('avatar.generatingEta', { sec: etaLeft }) : t('avatar.generatingSoon');
  const applyLabel = target.type === 'user' ? t('avatar.applyUserBtn') : t('avatar.applyRoleBtn');

  return (
    <Sheet open onClose={onClose} title={t('avatar.sheetTitle')} className="ps-gen" height="full">
      <div className="ps-gen-body">
        <section className="ps-gen-card">
          <div className="ps-gen-src-row">
            <div className="ps-gen-src">
              <span className="ps-gen-src-thumb">
                {usingExisting ? (
                  existingAvatarUrl ? (
                    <img src={existingAvatarUrl} alt={t('avatar.currentSource')} />
                  ) : (
                    <UiIcon name="check" size={24} />
                  )
                ) : source?.preview ? (
                  <img src={source.preview} alt={t('avatar.uploadedSourceAlt')} />
                ) : (
                  <UiIcon name={fresh ? 'check' : 'plus'} size={24} />
                )}
                <span className="ps-gen-src-tag">{usingExisting ? t('avatar.currentSource') : t('avatar.sourceTag')}</span>
              </span>
              <PickImageButton className="ps-link" onPick={(f) => void upload(f)} disabled={uploading} label={t('avatar.uploadSourceAria')}>
                {uploading ? t('common.uploading') : source || usingExisting ? t('avatar.changeSource') : t('avatar.uploadSource')}
              </PickImageButton>
              {source && !fresh && hasExistingSource && (
                <button type="button" className="ps-link" onClick={() => onSource(null)}>
                  {t('avatar.useDefaultSource')}
                </button>
              )}
            </div>
            <span className="ps-gen-arrow" aria-hidden>
              <UiIcon name="chevron-right" size={20} />
            </span>
            <div className="ps-presets" role="radiogroup" aria-label={t('avatar.stylePresetsAria')}>
              {STYLE_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={style === p}
                  className={'ps-preset' + (style === p ? ' is-on' : '')}
                  onClick={() => setStyle(p)}
                >
                  {presetLabel(p)}
                  {style === p && <UiIcon name="check" size={14} />}
                </button>
              ))}
            </div>
          </div>
          {source && !fresh && (
            <div className="ps-gen-warn">{hasExistingSource ? t('avatar.sourceExpiredWarnExisting') : t('avatar.sourceExpiredWarn')}</div>
          )}
          <label className="ps-hint">
            <span className="ps-hint-k">{t('avatar.detailHintLabel')}</span>
            <input
              value={hint}
              maxLength={LIMITS.PROMPT_HINT_MAX}
              placeholder={t('avatar.detailHintPlaceholder')}
              aria-label={t('avatar.detailHintLabel')}
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
              <>
                <UiIcon name="spark" size={18} />
                {t('avatar.generateFour')}
              </>
            )}
          </button>
        </section>

        {batch ? (
          <section className="ps-gen-grid-wrap">
            <div className="ps-gen-head">
              <span className="ps-strong ps-icon-label">
                <UiIcon name="spark" size={16} /> {t('avatar.candidatesHeading')}
              </span>
              <span className="ps-pill-mini">{presetLabel(batch.style)}</span>
              <button type="button" className="ps-link" disabled={!canGenerate || generating || uploading} onClick={() => void generate()}>
                <UiIcon name="refresh" size={15} />
                {t('avatar.regenerate')}
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
            {allFailed && <div className="ps-gen-warn">{t('avatar.allFailed')}</div>}
            {batches.length > 1 && (
              <div className="ps-hist-strip" aria-label={t('avatar.historyBatchesAria')}>
                {batches.map((b, i) => (
                  <BatchThumb key={b.job_id} batch={b} n={i + 1} active={i === view} onClick={() => setView(i)} />
                ))}
              </div>
            )}
          </section>
        ) : (
          <div className="ps-gen-empty">{canGenerate ? t('avatar.emptyReady') : t('avatar.emptySteps')}</div>
        )}

        <div className="ps-gen-toggle">
          <div>
            <div className="ps-strong">{t('avatar.registerRefTitle')}</div>
            <div className="ps-sub">{t('avatar.registerRefSub')}</div>
          </div>
          <Switch checked={registerRef} onChange={setRegisterRef} label={t('avatar.registerRefTitle')} />
        </div>
      </div>
      <div className="ps-dock ps-dock-sheet">
        <button type="button" className="ps-btn ps-btn-sec" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button type="button" className="ps-btn ps-btn-pri" disabled={!pickedReady || applying} onClick={() => void apply()}>
          {applying ? t('avatar.applying') : applyLabel}
        </button>
      </div>
    </Sheet>
  );
}

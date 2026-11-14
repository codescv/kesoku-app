import type { CardProps } from '../types';
import { CardShell, Ja, LineVoice, toLine } from '../parts';
import { cardMedia, charDiff, obj, pick, strList, useImageUrl, type Dict } from '../util';

function passOf(d: Dict): boolean | null {
  if (typeof d.pass === 'boolean') return d.pass;
  if (typeof d.passed === 'boolean') return d.passed;
  const v = String(d.verdict ?? d.result ?? '').toLowerCase();
  if (['pass', 'ok', 'correct', 'passed'].includes(v)) return true;
  if (['retry', 'fail', 'wrong', 'failed'].includes(v)) return false;
  return null;
}

function Diffed({ parts, kind }: { parts: Array<[string, boolean]>; kind: 'del' | 'ins' }) {
  return (
    <>
      {parts.map(([t, changed], i) =>
        changed ? (
          kind === 'del' ? (
            <del key={i} className="kc-diff-del">
              {t}
            </del>
          ) : (
            <ins key={i} className="kc-diff-ins">
              {t}
            </ins>
          )
        ) : (
          <span key={i}>{t}</span>
        ),
      )}
    </>
  );
}

/** Grading result (Screen 06): big PASS / 再试 badge, original vs corrected with diff, native upgrade. */
export function Grading({ data, ctx }: CardProps<Dict>) {
  const d = obj(data);
  const pass = passOf(d);
  const label = pick(d, 'label', 'headline', 'summary', 'reason');
  const original = pick(d, 'original', 'answer', 'user_answer', 'input');
  const corrected = pick(d, 'corrected', 'correct', 'fixed');
  const diff = original && corrected && original !== corrected ? charDiff(original, corrected) : null;
  const upgrade = toLine(d.upgrade ?? d.native_upgrade ?? d.native);
  const notes = strList(d.notes ?? d.note);
  const streak = pick(d, 'streak');
  const imgRef = cardMedia(ctx, ['reward_image', 'image', 'cg'], d.reward_image ?? d.image);
  const imgUrl = useImageUrl(ctx.resolveMedia, imgRef);
  const imgCaption = pick(d, 'image_caption', 'reward');

  return (
    <CardShell kind="grading" tone={pass === false ? 'danger' : 'ok'}>
      <div className="kc-grade-top">
        <span className={'kc-grade-badge ' + (pass === false ? 'is-retry' : 'is-pass')}>{pass === false ? '✗ 再试' : '✓ PASS'}</span>
        {label && <span className="kc-grade-label">{label}</span>}
        {streak && <span className="kc-badge kc-badge-warn">🔥 连对 ×{streak}</span>}
      </div>
      {(original || corrected) && (
        <div className="kc-grade-cmp">
          {original && (
            <div className="kc-grade-row is-orig">
              <span className="kc-grade-k">原句</span>
              <span className="kc-grade-v" lang="ja">
                {diff ? <Diffed parts={diff.a} kind="del" /> : original}
              </span>
            </div>
          )}
          {corrected && corrected !== original && (
            <div className="kc-grade-row is-fixed">
              <span className="kc-grade-k">修正</span>
              <span className="kc-grade-v" lang="ja">
                {diff ? <Diffed parts={diff.b} kind="ins" /> : corrected}
              </span>
            </div>
          )}
        </div>
      )}
      {upgrade && (
        <div className="kc-grade-up">
          <div className="kc-grade-up-head">🔥 母语者升级表达</div>
          <div className="kc-line-main">
            <Ja text={upgrade.text} ruby={upgrade.ruby} rubyParts={upgrade.rubyParts} className="kc-line-ja" />
            <LineVoice voice={upgrade.voice} ctx={ctx} />
          </div>
          {upgrade.zh && <div className="kc-line-zh">{upgrade.zh}</div>}
        </div>
      )}
      {notes.length > 0 && (
        <ul className="kc-notes">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {imgRef && (
        <button
          type="button"
          className="kc-grade-img"
          onClick={() => imgUrl && ctx.openFullscreen(<img className="kc-full-img" src={imgUrl} alt={imgCaption || '奖惩图'} />)}
          aria-label="查看大图"
        >
          {imgUrl ? <img src={imgUrl} alt={imgCaption || '奖惩图'} /> : <span className="kc-img-skel" aria-busy={imgUrl === undefined} />}
          {imgCaption && <span className="kc-grade-img-cap">{imgCaption}</span>}
        </button>
      )}
    </CardShell>
  );
}


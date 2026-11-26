import type { ReactNode } from 'react';
import { useT } from '@kesoku/ui';
import type { CardContext, CardProps } from '../types';
import { CardShell, Ja, LineVoice, toLine, type LineLike } from '../parts';
import { arr, isObj, obj, pick, strList, type Dict } from '../util';

function lines(v: unknown): LineLike[] {
  const list = Array.isArray(v) ? v : v == null ? [] : [v];
  return list.map(toLine).filter((x): x is LineLike => !!x);
}

function LineRow({ line, ctx }: { line: LineLike; ctx: CardContext }) {
  return (
    <div className="kc-line">
      <div className="kc-line-main">
        <Ja text={line.text} ruby={line.ruby} rubyParts={line.rubyParts} className="kc-line-ja" />
        <LineVoice voice={line.voice} ctx={ctx} />
      </div>
      {line.zh && <div className="kc-line-zh">{line.zh}</div>}
      {line.tag && <span className="kc-badge kc-badge-tag">{line.tag}</span>}
    </div>
  );
}

function Step({ n, title, children, tone }: { n: string; title: ReactNode; children: ReactNode; tone?: string }) {
  return (
    <div className={['kc-step', tone ? `kc-step-${tone}` : ''].filter(Boolean).join(' ')}>
      <div className="kc-step-title">
        <span className="kc-step-n">{n}</span>
        {title}
      </div>
      {children}
    </div>
  );
}

/** Structured 4-step lesson card (Screen 05): ①例句 ②语法点 ③📘 vs 🔥 ④常见误区. */
export function LessonCard({ data, ctx }: CardProps<Dict>) {
  const t = useT();
  const d = obj(data);
  const title = pick(d, 'title', 'pattern', 'point');
  const examples = lines(d.examples ?? d.example);
  const g = isObj(d.grammar) ? d.grammar : {};
  const gPoint = pick(g, 'point', 'title', 'pattern') || pick(d, 'grammar_point', 'grammar');
  const gExplain = pick(g, 'explain', 'zh', 'meaning') || pick(d, 'grammar_explain', 'explain');
  const rules = strList(g.rules ?? d.rules);
  const textbook = lines(d.textbook);
  const native = lines(d.native ?? d.colloquial ?? d.real);
  const scenes = strList(d.scenes ?? d.native_scenes);
  const pitfalls = arr(d.pitfalls ?? d.mistakes ?? d.common_mistakes)
    .map((p) => (isObj(p) ? { wrong: pick(p, 'wrong', 'bad', 'error'), right: pick(p, 'right', 'correct', 'good'), note: pick(p, 'note', 'why', 'zh') } : { wrong: '', right: '', note: String(p ?? '') }))
    .filter((p) => p.wrong || p.right || p.note);
  const lessonTag = pick(d, 'lesson_label', 'lesson');

  return (
    <CardShell
      kind="lesson_card"
      tone="mode"
      head={
        <>
          <span className="kc-title">📘 {title || t('card.lessonFallback')}</span>
          {lessonTag && <span className="kc-badge kc-badge-mode">{/^\d+$/.test(lessonTag) ? t('hud.lessonNo', { no: lessonTag }) : lessonTag}</span>}
        </>
      }
    >
      {examples.length > 0 && (
        <Step n="①" title={t('card.stepExamples')}>
          {examples.map((l, i) => (
            <LineRow key={i} line={l} ctx={ctx} />
          ))}
        </Step>
      )}
      {(gPoint || gExplain || rules.length > 0) && (
        <Step n="②" title={t('card.stepGrammar')}>
          {gPoint && (
            <div className="kc-gram-point" lang="ja">
              {gPoint}
            </div>
          )}
          {gExplain && <div className="kc-gram-explain">{gExplain}</div>}
          {rules.length > 0 && (
            <div className="kc-chips">
              {rules.map((r) => (
                <span key={r} className="kc-badge kc-badge-tag" lang="ja">
                  {r}
                </span>
              ))}
            </div>
          )}
        </Step>
      )}
      {(textbook.length > 0 || native.length > 0) && (
        <Step n="③" title={t('card.stepCompare')}>
          <div className="kc-dual">
            <div className="kc-dual-col is-textbook">
              <div className="kc-dual-head">{t('card.textbookHead')}</div>
              {textbook.map((l, i) => (
                <LineRow key={i} line={l} ctx={ctx} />
              ))}
            </div>
            <div className="kc-dual-col is-native">
              <div className="kc-dual-head">
                {t('card.nativeHead')}
                {scenes.map((s) => (
                  <span key={s} className="kc-badge kc-badge-warn">
                    {s}
                  </span>
                ))}
              </div>
              {native.map((l, i) => (
                <LineRow key={i} line={l} ctx={ctx} />
              ))}
            </div>
          </div>
        </Step>
      )}
      {pitfalls.length > 0 && (
        <Step n="④" title={t('card.stepPitfalls')} tone="danger">
          {pitfalls.map((p, i) => (
            <div key={i} className="kc-pitfall">
              {p.wrong && (
                <span className="kc-pit-wrong" lang="ja">
                  ✗ {p.wrong}
                </span>
              )}
              {p.right && (
                <span className="kc-pit-right" lang="ja">
                  ✓ {p.right}
                </span>
              )}
              {p.note && <span className="kc-pit-note">{p.note}</span>}
            </div>
          ))}
        </Step>
      )}
    </CardShell>
  );
}

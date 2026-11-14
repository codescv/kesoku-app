import type { CardProps } from '../types';
import { CardShell, Ja } from '../parts';
import { arr, isObj, obj, pick, strList, type Dict } from '../util';

/** Grammar / lexical breakdown body (shared by `breakdown` cards and the translation card's inline fold). */
export function BreakdownBody({ data }: { data: Dict }) {
  const d = obj(data);
  const tokens = (arr(d.tokens ?? d.items ?? d.words).filter(isObj) as Dict[]).filter((t) => pick(t, 'surface', 'word', 'base', 'ja'));
  const points = arr(d.grammar ?? d.points ?? d.grammar_points)
    .map((g) => (isObj(g) ? { title: pick(g, 'point', 'title', 'pattern', 'name'), body: pick(g, 'explain', 'zh', 'note', 'meaning'), ex: pick(g, 'example', 'ja') } : { title: String(g ?? ''), body: '', ex: '' }))
    .filter((g) => g.title);
  const notes = strList(d.notes ?? d.note);
  return (
    <div className="kc-bd">
      {tokens.length > 0 && (
        <div className="kc-bd-tokens">
          {tokens.map((t, i) => {
            const surface = pick(t, 'surface', 'word', 'base', 'ja');
            const reading = pick(t, 'reading', 'kana', 'rt');
            const pos = pick(t, 'pos');
            const meaning = pick(t, 'meaning', 'gloss', 'zh');
            const tb = pick(t, 'textbook');
            const coll = pick(t, 'colloquial');
            return (
              <div key={i} className="kc-bd-token">
                <span className="kc-bd-surface" lang="ja">
                  {surface}
                  {reading && reading !== surface && <small> {reading}</small>}
                </span>
                {pos && <span className="kc-badge kc-badge-accent">{pos}</span>}
                {meaning && <span className="kc-bd-meaning">{meaning}</span>}
                {(tb || coll) && (
                  <span className="kc-bd-forms">
                    {tb && <span className="kc-badge kc-badge-primary">📘 {tb}</span>}
                    {coll && <span className="kc-badge kc-badge-warn">🔥 {coll}</span>}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {points.map((g, i) => (
        <div key={i} className="kc-bd-point">
          <b lang="ja">{g.title}</b>
          {g.body && <span> · {g.body}</span>}
          {g.ex && (
            <div className="kc-bd-ex">
              <Ja text={g.ex} />
            </div>
          )}
        </div>
      ))}
      {notes.map((n, i) => (
        <p key={i} className="kc-bd-note">
          {n}
        </p>
      ))}
    </div>
  );
}

export function Breakdown({ data }: CardProps<Dict>) {
  const d = obj(data);
  const source = pick(d, 'source', 'sentence', 'ja');
  return (
    <CardShell kind="breakdown" head={<span className="kc-title kc-title-accent">🔍 语法拆解</span>}>
      {source && (
        <div className="kc-bd-source">
          <Ja text={source} ruby={d.source_ruby ?? d.ruby} rubyParts={d.ruby_parts} />
        </div>
      )}
      <BreakdownBody data={d} />
    </CardShell>
  );
}

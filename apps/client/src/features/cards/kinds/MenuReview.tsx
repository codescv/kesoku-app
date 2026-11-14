import { useMemo, useState } from 'react';
import type { CardProps } from '../types';
import { CardShell, PhotoTag } from '../parts';
import { arr, isObj, obj, photoNumber, pick, strList, type Dict } from '../util';

type Verdict = 'pick' | 'hazard' | 'ok';

interface Dish {
  key: string;
  name: string;
  nameLocal: string;
  nameZh: string;
  verdict: Verdict;
  tags: string[];
  reason: string;
  price: string;
  raw: Dict;
}

function verdictOf(v: unknown): Verdict {
  const s = String(v ?? '').toLowerCase();
  if (s === 'pick' || s === 'recommend' || s === 'best' || s === '主推') return 'pick';
  if (s === 'hazard' || s === 'avoid' || s === 'danger' || s === '排雷') return 'hazard';
  return 'ok';
}

export function dishesOf(data: Dict): Dish[] {
  return (arr(data.items).filter(isObj) as Dict[])
    .map((it, i) => {
      const nameLocal = pick(it, 'name_local', 'local');
      const nameZh = pick(it, 'name_zh', 'zh', 'name');
      return {
        key: String(i),
        name: nameLocal || nameZh,
        nameLocal,
        nameZh,
        verdict: verdictOf(it.verdict),
        tags: strList(it.tags),
        reason: pick(it, 'reason', 'note', 'hazard_reason'),
        price: pick(it, 'price'),
        raw: it,
      };
    })
    .filter((d) => d.name);
}

/** Menu review (Screen 07): selectable dish rows; hazards are red and locked; CTA builds the order request. */
export function MenuReview({ data, ctx }: CardProps<Dict>) {
  const d = obj(data);
  const dishes = useMemo(() => dishesOf(d), [d]);
  const [qty, setQty] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const x of dishes) if (x.verdict === 'pick') init[x.key] = 1;
    return init;
  });
  const chosen = dishes.filter((x) => x.verdict !== 'hazard' && (qty[x.key] ?? 0) > 0);
  const title = pick(d, 'title') || '菜单排雷';

  const toggle = (x: Dish) => {
    if (x.verdict === 'hazard') return;
    setQty((q) => ({ ...q, [x.key]: (q[x.key] ?? 0) > 0 ? 0 : 1 }));
  };
  const bump = (x: Dish, delta: number) => setQty((q) => ({ ...q, [x.key]: Math.max(0, Math.min(20, (q[x.key] ?? 0) + delta)) }));

  const send = () => {
    if (!chosen.length) return;
    ctx.sendText(`生成店员点单卡：${chosen.map((x) => `${x.name}×${qty[x.key]}`).join('、')}`);
  };

  return (
    <CardShell kind="menu_review" head={<span className="kc-title">🍽️ {title}</span>}>
      <ul className="kc-dishes">
        {dishes.map((x) => {
          const n = qty[x.key] ?? 0;
          const on = n > 0 && x.verdict !== 'hazard';
          const badge = x.verdict === 'pick' ? '★ 主推' : x.verdict === 'hazard' ? '⚠️ 排雷' : '可选';
          return (
            <li key={x.key} className={`kc-dish is-${x.verdict}` + (on ? ' is-on' : '')}>
              <label className="kc-dish-main">
                <input
                  type="checkbox"
                  className="kc-dish-check"
                  checked={on}
                  disabled={x.verdict === 'hazard'}
                  onChange={() => toggle(x)}
                  aria-label={`${x.verdict === 'hazard' ? '排雷，不可选' : '选择'} ${x.name}`}
                />
                <span className="kc-dish-body">
                  <span className="kc-dish-badges">
                    <span className={`kc-badge kc-badge-${x.verdict === 'pick' ? 'ok' : x.verdict === 'hazard' ? 'danger' : 'neutral'}`}>{badge}</span>
                    {x.tags.map((t) => (
                      <span key={t} className={`kc-badge kc-badge-${x.verdict === 'hazard' ? 'danger-soft' : 'tag'}`}>
                        {t}
                      </span>
                    ))}
                  </span>
                  <span className="kc-dish-name">
                    {x.nameZh && x.nameLocal ? (
                      <>
                        {x.nameZh} <span className="kc-dish-local" lang="ja">({x.nameLocal})</span>
                      </>
                    ) : (
                      x.name
                    )}
                  </span>
                  {x.reason && <span className="kc-dish-reason">{x.reason}</span>}
                </span>
              </label>
              <span className="kc-dish-side">
                <PhotoTag n={photoNumber(x.raw.photo_index)} bbox={x.raw.bbox} position={pick(x.raw, 'position', 'photo_pos')} data={d} ctx={ctx} />
                {x.price && <span className="kc-dish-price">{x.price}</span>}
                {on && (
                  <span className="kc-stepper" aria-label={`${x.name} 数量`}>
                    <button type="button" onClick={() => bump(x, -1)} aria-label="减少">
                      −
                    </button>
                    <b>×{n}</b>
                    <button type="button" onClick={() => bump(x, 1)} aria-label="增加">
                      ＋
                    </button>
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <button type="button" className="kc-cta" disabled={!chosen.length} onClick={send}>
        🧾 生成店员点单卡 ({chosen.length}道) ›
      </button>
    </CardShell>
  );
}

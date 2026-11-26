import { useT } from '@kesoku/ui';
import type { CardProps } from '../types';
import { CardShell, PhotoTag } from '../parts';
import { arr, isObj, num, obj, photoNumber, pick, type Dict } from '../util';

/**
 * Staff order card (Screen 08). 100% persona-free: no avatar, no nickname, and NO ▶ / TTS control of any
 * kind — it is shown to the waiter, never voiced. Huge local-language lines + allergy banner + zh note.
 */
export function OrderCardBody({ data, ctx, fullscreen }: CardProps<Dict> & { fullscreen?: boolean }) {
  const t = useT();
  const d = obj(data);
  const headline = pick(d, 'headline_local', 'greeting_local', 'title_local');
  const banner = pick(d, 'banner_local', 'allergy_local', 'dietary_local');
  const bannerZh = pick(d, 'banner_zh', 'note_zh', 'zh');
  const items = arr(d.items).filter(isObj) as Dict[];
  const total = pick(d, 'total_local', 'total');
  const totalZh = pick(d, 'total_zh');
  return (
    <div className={'kc-show' + (fullscreen ? ' is-full' : '')} lang="ja">
      {(headline || banner) && (
        <div className="kc-show-banner" role="note">
          {headline && <div className="kc-show-headline">{headline}</div>}
          {banner && (
            <div className="kc-show-allergy">
              <span aria-hidden>⚠️ </span>
              {banner}
            </div>
          )}
          {bannerZh && (
            <div className="kc-show-zh" lang="zh">
              {t('card.orderCheckNote', { text: bannerZh })}
            </div>
          )}
        </div>
      )}
      {!headline && !banner && bannerZh && (
        <div className="kc-show-zh" lang="zh">
          {bannerZh}
        </div>
      )}
      <ol className="kc-show-items">
        {items.map((it, i) => {
          const name = pick(it, 'name_local', 'name', 'local');
          if (!name) return null;
          const qty = num(it.qty ?? it.quantity) ?? 1;
          const zh = pick(it, 'name_zh', 'zh');
          const price = pick(it, 'price');
          return (
            <li key={i} className="kc-show-item">
              <div className="kc-show-row">
                <span className="kc-show-name">{name}</span>
                <span className="kc-show-qty">×{qty}</span>
              </div>
              <div className="kc-show-meta">
                <PhotoTag n={photoNumber(it.photo_index)} bbox={it.bbox} position={pick(it, 'position', 'photo_pos')} data={d} ctx={ctx} />
                {(zh || price) && (
                  <span className="kc-show-item-zh" lang="zh">
                    {[zh, price].filter(Boolean).join(' · ')}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {(total || totalZh) && (
        <div className="kc-show-total">
          {total && <span className="kc-show-total-local">{total}</span>}
          {totalZh && <span className="kc-show-zh" lang="zh">{totalZh}</span>}
        </div>
      )}
    </div>
  );
}

export function OrderCard({ data, ctx }: CardProps<Dict>) {
  const t = useT();
  return (
    <CardShell
      kind="order_card"
      className="kc-showcard"
      head={
        <>
          <span className="kc-badge kc-badge-ink">{t('card.orderTitle')}</span>
          <button type="button" className="kc-btn kc-btn-ink" onClick={() => ctx.openFullscreen(<OrderCardBody data={data} ctx={ctx} fullscreen />)}>
            {t('card.fullscreenShow')}
          </button>
        </>
      }
    >
      <OrderCardBody data={data} ctx={ctx} />
    </CardShell>
  );
}

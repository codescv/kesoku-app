import { useT } from '@kesoku/ui';
import type { CardProps } from '../types';
import { CardShell, PhotoTag } from '../parts';
import { cardMedia, obj, photoNumber, pick, useImageUrl, type Dict } from '../util';

/** Direction big-text card: same persona-free, voice-free template as the order card. */
export function DirectionCardBody({ data, ctx, fullscreen }: CardProps<Dict> & { fullscreen?: boolean }) {
  const t = useT();
  const d = obj(data);
  const line = pick(d, 'text_local', 'destination_local', 'line_local', 'local', 'text');
  const address = pick(d, 'address_local', 'address');
  const zh = pick(d, 'note_zh', 'zh', 'destination_zh');
  const mapRef = cardMedia(ctx, ['map', 'map_image', 'image'], d.map ?? d.map_image ?? d.image);
  const mapUrl = useImageUrl(ctx.resolveMedia, mapRef);
  return (
    <div className={'kc-show' + (fullscreen ? ' is-full' : '')} lang="ja">
      {line && <div className="kc-show-headline kc-show-dest">{line}</div>}
      {address && <div className="kc-show-address">{address}</div>}
      {zh && (
        <div className="kc-show-zh" lang="zh">
          {zh}
        </div>
      )}
      {mapRef && (
        <div className="kc-show-map">{mapUrl ? <img src={mapUrl} alt={t('card.mapAlt')} draggable={false} /> : <div className="kc-locator-empty">{mapUrl === undefined ? t('card.mapLoading') : t('card.mapUnavailable')}</div>}</div>
      )}
      <PhotoTag n={photoNumber(d.photo_index)} bbox={d.bbox} position={pick(d, 'position')} data={d} ctx={ctx} />
    </div>
  );
}

export function DirectionCard({ data, ctx }: CardProps<Dict>) {
  const t = useT();
  return (
    <CardShell
      kind="direction_card"
      className="kc-showcard"
      head={
        <>
          <span className="kc-badge kc-badge-ink">{t('card.directionTitle')}</span>
          <button type="button" className="kc-btn kc-btn-ink" onClick={() => ctx.openFullscreen(<DirectionCardBody data={data} ctx={ctx} fullscreen />)}>
            {t('card.fullscreenShow')}
          </button>
        </>
      }
    >
      <DirectionCardBody data={data} ctx={ctx} />
    </CardShell>
  );
}

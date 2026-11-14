import { useState } from 'react';
import type { CardProps } from '../types';
import { CardShell, Ja } from '../parts';
import { BreakdownBody } from './Breakdown';
import { arr, hasKana, isObj, obj, pick, speechLang, strList, type Dict } from '../util';

/** Full-screen show card for a translation (target huge, source small). No TTS control here. */
export function TranslationShow({ data }: { data: Dict }) {
  const d = obj(data);
  const target = pick(d, 'target', 'translation');
  const source = pick(d, 'source');
  return (
    <div className="kc-show is-full">
      <div className="kc-show-headline">{target}</div>
      {source && <div className="kc-show-zh">{source}</div>}
    </div>
  );
}

/** Translator result card (Screen 09): zero persona — source (ruby) + big bold target + action row. */
export function Translation({ data, ctx }: CardProps<Dict>) {
  const d = obj(data);
  const source = pick(d, 'source', 'src', 'original');
  const target = pick(d, 'target', 'translation', 'dst');
  const back = pick(d, 'back_translation');
  const notes = strList(d.notes ?? d.note);
  const regions = arr(d.regions).filter(isObj) as Dict[];
  const hasBreakdown = isObj(d.breakdown) || Array.isArray(d.breakdown);
  const [bdOpen, setBdOpen] = useState(false);
  const srcLang = pick(d, 'source_lang', 'src_lang');
  const dstLang = pick(d, 'target_lang', 'dst_lang');
  const srcIsJa = srcLang ? srcLang.toLowerCase().startsWith('ja') || srcLang === '日语' : hasKana(source) || d.source_ruby != null;
  const tag = pick(d, 'tag', 'context', 'scene');

  const onBreakdown = () => {
    if (hasBreakdown) setBdOpen((o) => !o);
    else if (source) ctx.sendText(`语法拆解：${source}`);
  };

  return (
    <CardShell kind="translation" head={tag ? <span className="kc-badge kc-badge-primary">{tag}</span> : undefined}>
      {source && (
        <div className="kc-tr-source">
          <Ja text={source} ruby={d.source_ruby ?? d.ruby} rubyParts={d.source_ruby_parts ?? d.ruby_parts} lang={srcIsJa ? 'ja' : 'x'} />
        </div>
      )}
      {target && <div className="kc-tr-target">{target}</div>}
      {back && <div className="kc-tr-back">↩ {back}</div>}
      {regions.length > 0 && (
        <ul className="kc-tr-regions">
          {regions.map((r, i) => (
            <li key={i}>
              <span lang="ja">{pick(r, 'source', 'text')}</span> → <b>{pick(r, 'target', 'translation')}</b>
            </li>
          ))}
        </ul>
      )}
      {notes.length > 0 && (
        <div className="kc-tr-notes">
          {notes.map((n) => (
            <span key={n} className="kc-badge kc-badge-tag">
              {n}
            </span>
          ))}
        </div>
      )}
      <div className="kc-actions">
        <button type="button" className="kc-btn" onClick={() => ctx.copy(target)} disabled={!target}>
          📋 复制
        </button>
        <button type="button" className="kc-btn kc-btn-primary" onClick={() => ctx.speak(target, speechLang(dstLang, target))} disabled={!target}>
          ▶ 朗读
        </button>
        <button type="button" className="kc-btn" onClick={() => ctx.openFullscreen(<TranslationShow data={d} />)} disabled={!target}>
          ⛶ 全屏出示
        </button>
        <button type="button" className="kc-btn" aria-expanded={hasBreakdown ? bdOpen : undefined} onClick={onBreakdown} disabled={!source}>
          语法拆解 {hasBreakdown && bdOpen ? '▴' : '▾'}
        </button>
      </div>
      {hasBreakdown && bdOpen && (
        <div className="kc-tr-bd">
          <BreakdownBody data={Array.isArray(d.breakdown) ? { tokens: d.breakdown } : obj(d.breakdown)} />
        </div>
      )}
    </CardShell>
  );
}

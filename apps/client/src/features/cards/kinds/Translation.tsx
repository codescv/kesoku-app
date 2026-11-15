import { useState } from 'react';
import type { CardProps } from '../types';
import { CardShell, Ja } from '../parts';
import { BreakdownBody } from './Breakdown';
import { arr, hasKana, isObj, obj, pick, speechLang, strList, type Dict } from '../util';

function isJaLang(l: string): boolean {
  return l.toLowerCase().startsWith('ja') || l === '日语' || l === '日本語';
}

/** Which sides of a translation card are Japanese (explicit lang codes win, else kana / ruby presence). */
export function jaSides(d: Dict, source: string, target: string): { srcIsJa: boolean; dstIsJa: boolean } {
  const srcLang = pick(d, 'source_lang', 'src_lang');
  const dstLang = pick(d, 'target_lang', 'dst_lang');
  const srcIsJa = srcLang ? isJaLang(srcLang) : hasKana(source) || hasKana(String(d.source_ruby ?? '')) || d.source_ruby != null;
  const dstIsJa = dstLang
    ? isJaLang(dstLang)
    : hasKana(target) || hasKana(String(d.target_ruby ?? '')) || d.target_ruby != null || d.target_ruby_parts != null;
  return { srcIsJa, dstIsJa };
}

/** Bundled analysed tokens for one side (`source_tokens` / `target_tokens`, or `tokens` for the Japanese side). */
function sideTokens(d: Dict, side: 'source' | 'target', isJa: boolean, otherIsJa: boolean): unknown {
  const own = d[`${side}_tokens`];
  if (Array.isArray(own)) return own;
  return isJa && (side === 'source' || !otherIsJa) ? d.tokens : undefined;
}

/** Full-screen show card for a translation (target huge, source small). No TTS control here. */
export function TranslationShow({ data }: { data: Dict }) {
  const d = obj(data);
  const target = pick(d, 'target', 'translation');
  const source = pick(d, 'source');
  const { srcIsJa, dstIsJa } = jaSides(d, source, target);
  return (
    <div className="kc-show is-full">
      <div className="kc-show-headline">
        <Ja text={target} ruby={d.target_ruby} rubyParts={d.target_ruby_parts} lang={dstIsJa ? 'ja' : 'x'} />
      </div>
      {source && (
        <div className="kc-show-zh">
          <Ja text={source} ruby={d.source_ruby ?? d.ruby} rubyParts={d.source_ruby_parts ?? d.ruby_parts} lang={srcIsJa ? 'ja' : 'x'} />
        </div>
      )}
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
  const dstLang = pick(d, 'target_lang', 'dst_lang');
  const { srcIsJa, dstIsJa } = jaSides(d, source, target);
  const tag = pick(d, 'tag', 'context', 'scene');

  const onBreakdown = () => {
    if (hasBreakdown) setBdOpen((o) => !o);
    else if (source) ctx.sendText(`语法拆解：${source}`);
  };

  return (
    <CardShell kind="translation" head={tag ? <span className="kc-badge kc-badge-primary">{tag}</span> : undefined}>
      {source && (
        <div className="kc-tr-source">
          <Ja
            text={source}
            ruby={d.source_ruby ?? d.ruby}
            rubyParts={d.source_ruby_parts ?? d.ruby_parts}
            lang={srcIsJa ? 'ja' : 'x'}
            interactive
            ctx={ctx}
            tokens={sideTokens(d, 'source', srcIsJa, dstIsJa)}
          />
        </div>
      )}
      {target && (
        <div className="kc-tr-target">
          <Ja
            text={target}
            ruby={d.target_ruby}
            rubyParts={d.target_ruby_parts}
            lang={dstIsJa ? 'ja' : 'x'}
            interactive
            ctx={ctx}
            tokens={sideTokens(d, 'target', dstIsJa, srcIsJa)}
          />
        </div>
      )}
      {back && <div className="kc-tr-back">↩ {back}</div>}
      {regions.length > 0 && (
        <ul className="kc-tr-regions">
          {regions.map((r, i) => (
            <li key={i}>
              <Ja text={pick(r, 'source', 'text')} ruby={r.source_ruby ?? r.ruby} lang={srcIsJa || hasKana(pick(r, 'source', 'text')) ? 'ja' : 'x'} /> →{' '}
              <b>
                <Ja text={pick(r, 'target', 'translation')} ruby={r.target_ruby} lang={dstIsJa && hasKana(pick(r, 'target', 'translation')) ? 'ja' : 'x'} />
              </b>
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

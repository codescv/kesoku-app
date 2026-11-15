import { useEffect, useMemo, useState } from 'react';
import type { MemoryPolicy, ModeId } from '@kesoku/protocol';
import { ModeHud, detectActiveMode } from '@kesoku/hud';
import { ModeIcon, Sheet, UiIcon, modeMeta } from '@kesoku/ui';
import { kesoku } from '../lib/client';
import { actions, useStore } from '../lib/store';
import type { InspectorPanel } from '../lib/types';
import { TopBar } from './TopBar';
import { useIsDesktop, useIsTablet } from './useMedia';
import { SessionPanel } from '../features/session/SessionPanel';
import { MessageList } from '../features/session/MessageList';
import { Composer } from '../features/session/Composer';
import { Launchpad } from '../features/session/Launchpad';
import { makeCardContext } from '../features/session/cardContext';
import { overlays, useOverlays } from '../features/session/overlays';
import { MemoryPanel } from '../features/memory/MemoryPanel';
import { SettingsScreen } from '../features/settings/SettingsScreen';
import { LexCard } from '../features/segments/BilingualCard';
import { GalgameStage, ModePanel, PeekSheet } from '../features/modes';
import { PersonaStudio } from '../features/persona';
import { FileBrowser } from '../features/files/FileBrowser';

const EMPTY: Record<string, unknown> = {};
const CHANNEL: Record<string, string> = { discord: 'Discord', discord_asuka: 'Discord', wechat: '微信' };

function defaultInspector(mode: ModeId): InspectorPanel {
  switch (mode) {
    case 'jp_classroom':
      return { kind: 'lesson' };
    case 'trpg':
      return { kind: 'party' };
    case 'pokemon_assistant':
      return { kind: 'dex' };
    case 'story_theater':
      return { kind: 'roster' };
    case 'travel_companion':
      return { kind: 'travel' };
    default:
      return { kind: 'memory' };
  }
}

function Inspector({ panel, sessionId, modeId }: { panel: InspectorPanel; sessionId: string | null; modeId: ModeId }) {
  const stateFiles = useStore((s) => (sessionId ? s.stateFiles[sessionId] : undefined)) ?? EMPTY;
  const prefs = useStore((s) => (sessionId ? s.modePrefs[sessionId] : undefined)) ?? EMPTY;
  if (panel.kind === 'memory' || panel.kind === 'persona') return <MemoryPanel embedded />;
  if (panel.kind === 'word')
    return (
      <div className="k-inspector-word">
        <h2>词汇与语法解析</h2>
        {panel.sentence && (
          <p className="k-inspector-sentence" lang="ja">
            {panel.sentence}
          </p>
        )}
        <LexCard token={panel.token} />
        <button type="button" className="k-btn k-btn-ghost" onClick={() => actions.setUi({ inspector: null })}>
          返回记忆库
        </button>
      </div>
    );
  if (!sessionId) return <MemoryPanel embedded />;
  return <ModePanel panel={panel.kind} stateFiles={stateFiles} modePrefs={prefs} ctx={makeCardContext(sessionId, '', modeId)} />;
}

function Overlays({ sessionId, modeId }: { sessionId: string | null; modeId: ModeId }) {
  const { fullscreen, peek, image } = useOverlays();
  return (
    <>
      {fullscreen && (
        <div className="k-fullscreen" role="dialog" aria-modal="true">
          <button type="button" className="k-fullscreen-close" onClick={() => overlays.fullscreen(null)}>
            <UiIcon name="close" size={18} /> 返回对话
          </button>
          <div className="k-fullscreen-body">{fullscreen}</div>
        </div>
      )}
      {image && (
        <div className="k-imgview" role="dialog" aria-modal="true" onClick={() => overlays.image(null)}>
          <div className="k-imgview-frame">
            <img src={image.url} alt="大图" />
            {image.bbox && image.bbox.length === 4 && (
              <span className="k-imgview-box" style={{ left: `${image.bbox[0] * 100}%`, top: `${image.bbox[1] * 100}%`, width: `${image.bbox[2] * 100}%`, height: `${image.bbox[3] * 100}%` }} />
            )}
          </div>
        </div>
      )}
      {peek && sessionId && <PeekSheet entry={peek.entry} glossary={peek.glossary} ctx={makeCardContext(sessionId, '', modeId)} onClose={() => overlays.peek(null)} />}
    </>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="k-toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={'k-toast' + (t.tone === 'error' ? ' is-error' : '')}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function Shell() {
  const desktop = useIsDesktop();
  const tablet = useIsTablet();
  const sid = useStore((s) => s.currentSessionId);
  const ui = useStore((s) => s.ui);
  const conn = useStore((s) => s.conn);
  const stateFiles = useStore((s) => (sid ? s.stateFiles[sid] : undefined)) ?? EMPTY;
  const modePrefs = useStore((s) => (sid ? s.modePrefs[sid] : undefined)) ?? EMPTY;
  const origin = useStore((s) => (sid ? s.origin[sid] : undefined));
  const takenOver = useStore((s) => (sid ? s.takenOver[sid] : false));
  const session = useStore((s) => (sid ? s.sessions[sid] : undefined));
  const items = useStore((s) => (sid ? s.items[sid] : undefined));
  const preview = useStore((s) => (sid ? s.previews[sid] : undefined));
  const policies = useStore((s) => s.policies.policies);
  const personas = useStore((s) => s.personas);
  const [panelSheet, setPanelSheet] = useState<InspectorPanel['kind'] | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);

  const foreign = !!origin && origin !== 'app' && (session?.chatbot_id ?? 'app') !== 'app';
  const active = useMemo(() => detectActiveMode(stateFiles), [stateFiles]);
  const modeId: ModeId = foreign ? 'chat' : active.modeId;
  const meta = modeMeta(modeId);
  const policy = (policies[modeId] ?? 'confirm_only') as MemoryPolicy;
  const roleName = personas.find((p) => p.role_id === (session?.role ?? 'asuka'))?.display_name?.split(' ')[0] ?? '飞鸟';
  const fullRoleName = personas.find((p) => p.role_id === (session?.role ?? 'asuka'))?.display_name || '斋藤飞鸟';
  const showLaunchpad = ui.screen === 'chat' && (ui.launchpad || !sid);
  const galStage = modeId === 'galgame' && ui.stageView === 'stage' && !showLaunchpad && !!sid;

  // Right column follows the mode: reset any pinned panel when the mode changes.
  useEffect(() => {
    actions.setUi({ inspector: null });
  }, [modeId, sid]);

  // Keyboard shortcuts (desktop workbench).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (!desktop) actions.setUi({ drawerOpen: true });
        setTimeout(() => document.getElementById('k-search')?.focus(), 50);
      } else if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        useStore.setState({ currentSessionId: null });
        actions.setUi({ launchpad: true, screen: 'chat' });
      } else if (e.key === 'Escape') {
        if (useStore.getState().ui.inspector?.kind === 'word') actions.setUi({ inspector: null });
        if (useStore.getState().ui.drawerOpen) actions.setUi({ drawerOpen: false });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [desktop]);

  const openPanel = (p: InspectorPanel['kind']) => {
    if (desktop) actions.setUi({ inspector: { kind: p } as InspectorPanel });
    else setPanelSheet(p);
  };

  const center = (() => {
    if (ui.screen === 'settings') return <SettingsScreen onClose={() => actions.setUi({ screen: 'chat' })} />;
    if (ui.screen === 'files') return <FileBrowser onClose={() => actions.setUi({ screen: 'chat' })} />;
    if (ui.screen === 'memory')
      return (
        <div className="k-screen">
          <header className="k-screen-head">
            <button type="button" className="k-icon-btn" aria-label="返回" onClick={() => actions.setUi({ screen: 'chat' })}>
              <UiIcon name="arrow-left" size={22} />
            </button>
            <h1>记忆库</h1>
          </header>
          <div className="k-screen-body">
            <MemoryPanel />
          </div>
        </div>
      );
    if (ui.screen === 'studio')
      return (
        <PersonaStudio
          onClose={() => actions.setUi({ screen: 'chat' })}
          onOpenPolicies={() => {
            actions.setUi({ screen: 'settings' });
            setTimeout(() => document.getElementById('memory-policies')?.scrollIntoView({ behavior: 'smooth' }), 80);
          }}
        />
      );
    return (
      <>
        <TopBar sessionId={sid} modeId={modeId} nestedTitle={active.nested?.title} showMenu={!desktop && (!tablet || leftCollapsed)} onMenu={() => (tablet ? setLeftCollapsed(false) : actions.setUi({ drawerOpen: true }))} />
        {conn.status !== 'online' && conn.status !== 'idle' && (
          <div className="k-connbar" role="status">
            {conn.status === 'reconnecting' || conn.status === 'connecting' || conn.status === 'authenticating' ? '重连中…' : conn.status === 'suspended' ? '已暂停（回到前台自动恢复）' : '未连接'}
          </div>
        )}
        {conn.status === 'online' && !conn.engineOnline && <div className="k-connbar is-offline">引擎离线 · 消息将在引擎恢复后送达</div>}
        {foreign && (
          <div className={'k-banner' + (takenOver ? ' is-taken' : '')}>
            {takenOver ? '已由 App 接管 (普通聊天)' : `此会话来自 ${CHANNEL[origin!] ?? origin} · 发送消息将以普通聊天模式继续`}
          </div>
        )}
        {!foreign && !showLaunchpad && sid && modeId !== 'chat' && !galStage && (
          <ModeHud
            modeId={modeId}
            stateFiles={stateFiles}
            modePrefs={modePrefs}
            policy={policy}
            onPolicyChange={(p) => void kesoku.setPolicy(modeId, p)}
            onPrefsChange={(prefs) => void kesoku.setModePrefs(sid, prefs)}
            onOpenPanel={openPanel}
          />
        )}
        <main className="k-stage" style={{ ['--mode' as string]: meta.color }}>
          {showLaunchpad ? (
            <Launchpad />
          ) : galStage ? (
            <GalgameStage
              items={items ?? []}
              preview={preview ?? null}
              stateFiles={stateFiles}
              ctx={makeCardContext(sid!, '', modeId)}
              policy={policy}
              onPolicyChange={(p: MemoryPolicy) => void kesoku.setPolicy('galgame', p)}
              onPick={(qid: string, choices: string[]) => void kesoku.pick(sid!, qid, choices)}
              onExit={() => actions.setUi({ stageView: 'bubbles' })}
              personaName={fullRoleName}
            />
          ) : (
            sid && <MessageList sessionId={sid} modeId={modeId} />
          )}
          {modeId === 'galgame' && !galStage && !showLaunchpad && sid && (
            <button type="button" className="k-stage-toggle" onClick={() => actions.setUi({ stageView: 'stage' })}>
              <ModeIcon mode="galgame" size={18} /> 回到 CG 舞台
            </button>
          )}
        </main>
        {!galStage && <Composer sessionId={sid} modeId={showLaunchpad ? 'chat' : modeId} roleName={roleName} />}
        {galStage && <Composer sessionId={sid} modeId={modeId} roleName={roleName} />}
      </>
    );
  })();

  const inspectorPanel = ui.inspector ?? defaultInspector(modeId);

  return (
    <div className={'k-shell' + (desktop ? ' is-desktop' : tablet ? ' is-tablet' : ' is-mobile') + (meta.dark && modeId !== 'chat' ? ' is-mode-dark' : '')} data-mode={modeId}>
      {(desktop || (tablet && !leftCollapsed)) && (
        <aside className="k-col-left">
          {tablet && !desktop && (
            <button type="button" className="k-collapse" aria-label="收起会话栏" onClick={() => setLeftCollapsed(true)}>
              <UiIcon name="chevron-left" size={18} />
            </button>
          )}
          <SessionPanel />
        </aside>
      )}
      <section className="k-col-center">{center}</section>
      {desktop && (
        <aside className="k-col-right" aria-label="上下文检视器">
          <Inspector panel={inspectorPanel} sessionId={sid} modeId={modeId} />
        </aside>
      )}
      {!desktop && !tablet && ui.drawerOpen && (
        <div className="k-drawer-root">
          <div className="k-scrim" onClick={() => actions.setUi({ drawerOpen: false })} />
          <div className="k-drawer">
            <SessionPanel onNavigate={() => actions.setUi({ drawerOpen: false })} />
          </div>
        </div>
      )}
      <Sheet open={!!panelSheet} onClose={() => setPanelSheet(null)} height="half" title={panelSheet === 'mistakes' ? '待复习错题本' : panelSheet === 'roster' ? '演员定妆表' : panelSheet === 'memory' ? '记忆库' : undefined}>
        {panelSheet && <Inspector panel={{ kind: panelSheet } as InspectorPanel} sessionId={sid} modeId={modeId} />}
      </Sheet>
      <Overlays sessionId={sid} modeId={modeId} />
      <Toasts />
    </div>
  );
}

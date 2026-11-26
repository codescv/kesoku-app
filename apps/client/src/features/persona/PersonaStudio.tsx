import { useCallback, useEffect, useRef, useState } from 'react';
import type { EngineToClientPayload } from '@kesoku/protocol';
import { Segmented, UiIcon, t as tGlobal, useT } from '@kesoku/ui';
import { kesoku } from '../../lib/client';
import { actions, useStore } from '../../lib/store';
import type { AvatarSource } from './AvatarSheet';
import { ProfilePanel } from './ProfilePanel';
import { RolesPanel } from './RolesPanel';
import './persona.css';

export interface PersonaStudioProps {
  onClose: () => void;
  initialTab?: 'roles' | 'me';
}

/** 🎭 Persona & Avatar Studio — full-screen secondary page (Screens 15–17). */
export function PersonaStudio({ onClose, initialTab = 'roles' }: PersonaStudioProps) {
  const t = useT();
  const [tab, setTab] = useState<'roles' | 'me'>(initialTab);
  const count = useStore((s) => s.personas.length);
  const [sources, setSources] = useState<Record<string, AvatarSource | null>>({});
  const previews = useRef(new Set<string>());

  // Fetch the role list once if the core has not loaded it yet.
  useEffect(() => {
    if (useStore.getState().personas.length) return;
    let alive = true;
    kesoku
      .rpc<EngineToClientPayload<'persona.list.result'>>('persona.list', {})
      .then((r) => alive && actions.setPersonas(r.roles, [], true))
      .catch(() => alive && actions.toast(tGlobal('persona.loadListFailed'), 'error'));
    return () => {
      alive = false;
    };
  }, []);

  // Revoke local preview object URLs when the studio closes.
  useEffect(() => {
    const set = previews.current;
    return () => {
      if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') for (const u of set) URL.revokeObjectURL(u);
      set.clear();
    };
  }, []);

  const setSource = useCallback((key: string, s: AvatarSource | null) => {
    if (s?.preview) previews.current.add(s.preview);
    setSources((m) => ({ ...m, [key]: s }));
  }, []);

  return (
    <div className="ps-root" role="region" data-testid="persona-studio" aria-label={t('persona.studioTitle')}>
      <header className="ps-top">
        <button type="button" className="ps-back" aria-label={t('common.back')} onClick={onClose}>
          <UiIcon name="arrow-left" size={20} />
        </button>
        <h1 className="ps-top-title">{t('persona.studioTitle')}</h1>
        <Segmented
          ariaLabel={t('persona.tabsAria')}
          size="sm"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'roles', label: t('persona.tabRoles', { count }) },
            { value: 'me', label: t('persona.tabMe') },
          ]}
        />
      </header>
      {tab === 'roles' ? (
        <RolesPanel sources={sources} setSource={setSource} />
      ) : (
        <ProfilePanel sources={sources} setSource={setSource} />
      )}
    </div>
  );
}

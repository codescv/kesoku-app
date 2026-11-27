import { useEffect, useMemo, useState } from 'react';
import { Sheet, UiIcon, useLocale, useT } from '@kesoku/ui';
import { hapticTap } from '../../native/haptics';
import { equipmentLabel, formatExerciseInlineSummary } from './format';
import { deriveTemplateStats } from './merge';
import {
  EQUIPMENT_TYPES,
  makeTemplateId,
  normalizeExerciseName,
  type EquipmentType,
  type ExerciseTemplate,
  type MonthlyWorkoutLogFile,
} from './types';

export interface QuickAddSheetProps {
  open: boolean;
  templates: readonly ExerciseTemplate[];
  logs: Record<string, MonthlyWorkoutLogFile>;
  onClose: () => void;
  onSelectTemplate: (templateId: string) => void;
  onCreateAndAdd: (name: string, equipment: EquipmentType) => void;
}

/**
 * Exercise + equipment template picker.
 * Deliberately does NOT auto-focus the search input on open (zero system keyboard pop-up for repeat exercises).
 */
export function QuickAddSheet({
  open,
  templates,
  logs,
  onClose,
  onSelectTemplate,
  onCreateAndAdd,
}: QuickAddSheetProps) {
  const locale = useLocale();
  const tr = useT();
  const [query, setQuery] = useState('');
  const [eqFilter, setEqFilter] = useState<EquipmentType | 'all'>('all');
  const [createEq, setCreateEq] = useState<EquipmentType>('dumbbell');

  useEffect(() => {
    if (open) {
      setQuery('');
      setEqFilter('all');
    }
  }, [open]);

  const stats = useMemo(() => deriveTemplateStats(logs), [logs]);

  const visibleTemplates = useMemo(() => {
    const q = normalizeExerciseName(query);
    return templates
      .filter((tpl) => !tpl.archived)
      .filter((tpl) => eqFilter === 'all' || tpl.equipment === eqFilter)
      .filter((tpl) => {
        if (!q) return true;
        const nameNorm = normalizeExerciseName(tpl.name);
        const eqNorm = normalizeExerciseName(equipmentLabel(tpl.equipment, locale));
        return nameNorm.includes(q) || eqNorm.includes(q) || tpl.equipment.includes(q);
      })
      .sort((a, b) => {
        const la = stats.get(a.id)?.lastUsedAt ?? 0;
        const lb = stats.get(b.id)?.lastUsedAt ?? 0;
        if (la !== lb) return lb - la;
        return b.updatedAt - a.updatedAt || a.name.localeCompare(b.name);
      });
  }, [templates, eqFilter, query, stats, locale]);

  const trimmedQuery = query.trim();
  const targetCreateEq: EquipmentType = eqFilter === 'all' ? createEq : eqFilter;
  const candidateId = trimmedQuery ? makeTemplateId(trimmedQuery, targetCreateEq) : '';
  const hasExactMatch = trimmedQuery ? templates.some((t) => !t.archived && t.id === candidateId) : false;

  return (
    <Sheet open={open} onClose={onClose} height="half" title={tr('workout.quickAddTitle')} className="k-wk-quickadd-sheet">
      <div className="k-wk-qa" data-testid="quick-add-sheet">
        <div className="k-wk-qa-search">
          <UiIcon name="search" size={18} className="k-wk-qa-search-icon" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tr('workout.searchPlaceholder')}
            aria-label={tr('workout.searchAria')}
            data-testid="quick-add-search"
          />
          {query && (
            <button
              type="button"
              className="k-wk-qa-clear"
              aria-label={tr('common.clear')}
              onClick={() => setQuery('')}
            >
              <UiIcon name="close" size={16} />
            </button>
          )}
        </div>

        <div className="k-wk-qa-chips" data-sheet-no-drag role="tablist" aria-label={tr('workout.eq.all')}>
          <button
            type="button"
            role="tab"
            aria-selected={eqFilter === 'all'}
            className={'k-wk-chip' + (eqFilter === 'all' ? ' is-on' : '')}
            data-testid="eq-filter-all"
            onClick={() => {
              void hapticTap();
              setEqFilter('all');
            }}
          >
            {tr('workout.eq.all')}
          </button>
          {EQUIPMENT_TYPES.map((eq) => (
            <button
              key={eq}
              type="button"
              role="tab"
              aria-selected={eqFilter === eq}
              className={'k-wk-chip' + (eqFilter === eq ? ' is-on' : '')}
              data-testid={`eq-filter-${eq}`}
              onClick={() => {
                void hapticTap();
                setEqFilter(eq);
                setCreateEq(eq);
              }}
            >
              {equipmentLabel(eq, locale)}
            </button>
          ))}
        </div>

        {trimmedQuery && !hasExactMatch && (
          <div className="k-wk-qa-create-box">
            {eqFilter === 'all' && (
              <div className="k-wk-qa-create-eqs" data-sheet-no-drag>
                {EQUIPMENT_TYPES.map((eq) => (
                  <button
                    key={eq}
                    type="button"
                    className={'k-wk-chip is-sm' + (createEq === eq ? ' is-on' : '')}
                    data-testid={`create-eq-${eq}`}
                    onClick={() => {
                      void hapticTap();
                      setCreateEq(eq);
                    }}
                  >
                    {equipmentLabel(eq, locale)}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              className="k-wk-qa-create-btn"
              data-testid="quick-add-create-btn"
              onClick={() => {
                void hapticTap();
                onCreateAndAdd(trimmedQuery, targetCreateEq);
                onClose();
              }}
            >
              <UiIcon name="plus" size={18} />
              <span>
                {tr('workout.createAndAdd', {
                  name: trimmedQuery,
                  equipment: equipmentLabel(targetCreateEq, locale),
                })}
              </span>
            </button>
          </div>
        )}

        <div className="k-wk-qa-list" role="list">
          {visibleTemplates.length > 0 ? (
            visibleTemplates.map((tpl) => {
              const stat = stats.get(tpl.id);
              const summary = stat ? formatExerciseInlineSummary(stat.lastExercise, locale) : null;
              return (
                <button
                  key={tpl.id}
                  type="button"
                  role="listitem"
                  className="k-wk-qa-item"
                  data-testid={`quick-add-item-${tpl.id}`}
                  onClick={() => {
                    void hapticTap();
                    onSelectTemplate(tpl.id);
                    onClose();
                  }}
                >
                  <span className="k-wk-qa-item-main">
                    <b>{tpl.name}</b>
                    <span className="k-wk-eq-tag">{equipmentLabel(tpl.equipment, locale)}</span>
                  </span>
                  <span className="k-wk-qa-item-sub">
                    {summary ?? tr('workout.noHistory')}
                  </span>
                </button>
              );
            })
          ) : !trimmedQuery ? (
            <div className="k-empty">{tr('workout.emptyTemplates')}</div>
          ) : null}
        </div>
      </div>
    </Sheet>
  );
}

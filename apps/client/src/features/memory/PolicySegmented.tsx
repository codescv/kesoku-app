import type { MemoryPolicy, ModeId } from '@kesoku/protocol';
import { MEMORY_POLICIES } from '@kesoku/protocol';
import { Segmented, getPolicyBadge, modeMeta, useLocale, useT } from '@kesoku/ui';
import { kesoku } from '../../lib/client';
import { useStore } from '../../lib/store';

/** `[Auto | Confirm | Ignore]` — sends `memory.policy.set` (zero LLM turn), optimistic + rollback. */
export function PolicySegmented({ modeId, value, size }: { modeId: ModeId; value?: MemoryPolicy; size?: 'sm' | 'md' }) {
  const locale = useLocale();
  const tr = useT();
  const current = useStore((s) => s.policies.policies[modeId]);
  const meta = modeMeta(modeId, locale);
  const options = MEMORY_POLICIES.map((v) => ({ value: v, label: getPolicyBadge(v, locale).label }));
  return (
    <Segmented<MemoryPolicy>
      ariaLabel={tr('policy.modeAria', { title: meta.title })}
      options={options}
      value={value ?? current}
      color={meta.color}
      size={size}
      onChange={(p) => void kesoku.setPolicy(modeId, p)}
    />
  );
}

import type { MemoryPolicy, ModeId } from '@kesoku/protocol';
import { MEMORY_POLICY_LABELS } from '@kesoku/protocol';
import { Segmented, modeMeta } from '@kesoku/ui';
import { kesoku } from '../../lib/client';
import { useStore } from '../../lib/store';

const OPTIONS: Array<{ value: MemoryPolicy; label: string }> = [
  { value: 'full', label: MEMORY_POLICY_LABELS.full },
  { value: 'confirm_only', label: MEMORY_POLICY_LABELS.confirm_only },
  { value: 'isolated', label: MEMORY_POLICY_LABELS.isolated },
];

/** `[自动 | 确认 | 忽略]` — sends `memory.policy.set` (zero LLM turn), optimistic + rollback. */
export function PolicySegmented({ modeId, value, size }: { modeId: ModeId; value?: MemoryPolicy; size?: 'sm' | 'md' }) {
  const current = useStore((s) => s.policies.policies[modeId]);
  return (
    <Segmented<MemoryPolicy>
      ariaLabel={`${modeMeta(modeId).title} 记忆策略`}
      options={OPTIONS}
      value={value ?? current}
      color={modeMeta(modeId).color}
      size={size}
      onChange={(p) => void kesoku.setPolicy(modeId, p)}
    />
  );
}

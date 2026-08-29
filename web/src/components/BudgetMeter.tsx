import { fmt$$ } from '../lib/butterbase-client';

interface Props {
  spentUsd: number;
  budgetUsd: number;
  status: 'active' | 'warning' | 'exhausted';
}

export default function BudgetMeter({ spentUsd, budgetUsd, status }: Props) {
  const pct = budgetUsd > 0 ? Math.min((spentUsd / budgetUsd) * 100, 100) : 0;
  const barColor =
    status === 'exhausted' ? 'bg-red-500' :
    status === 'warning' ? 'bg-amber-400' :
    'bg-indigo-500';

  return (
    <div className="w-full">
      <div className="flex justify-between text-xs text-gray-500 mb-1">
        <span>{fmt$$(spentUsd)} spent</span>
        <span>{fmt$$(budgetUsd)} budget</span>
      </div>
      <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {status !== 'active' && (
        <p className={`text-xs mt-1 ${status === 'exhausted' ? 'text-red-600' : 'text-amber-600'}`}>
          {status === 'exhausted' ? 'Budget exhausted — LLM calls paused' : 'Approaching budget limit'}
        </p>
      )}
    </div>
  );
}

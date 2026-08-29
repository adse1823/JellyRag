import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { butterbase, ReviewQueueItem, Transaction, fmt$$, fmtDate } from '../lib/butterbase-client';
import { useOrg } from '../lib/OrgContext';

interface QueueRow extends ReviewQueueItem {
  transactions: Transaction;
}

function priorityScore(item: QueueRow): number {
  let score = 0;
  if (item.flag_reasons.includes('dispute')) score += 1000;
  score += (item.transactions?.amount_usd ?? 0);
  score -= (item.suggested_confidence ?? 1) * 100;
  return score;
}

const FLAG_LABELS: Record<string, { label: string; cls: string }> = {
  dispute: { label: 'Dispute', cls: 'bg-red-100 text-red-700' },
  low_confidence: { label: 'Low confidence', cls: 'bg-amber-100 text-amber-700' },
  high_value: { label: 'High value', cls: 'bg-orange-100 text-orange-700' },
  new_vendor: { label: 'New vendor', cls: 'bg-blue-100 text-blue-700' },
  unmatched_payout: { label: 'Unmatched payout', cls: 'bg-purple-100 text-purple-700' },
  reserve_hold: { label: 'Reserve hold', cls: 'bg-gray-100 text-gray-600' },
};

export default function Review() {
  const { org } = useOrg();
  const [items, setItems] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!org) return;
    (butterbase as any)
      .from('review_queue')
      .select('*, transactions(*)')
      .eq('organization_id', org.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(200)
      .then(({ data }: { data: QueueRow[] | null }) => {
        const sorted = (data ?? []).sort((a, b) => priorityScore(b) - priorityScore(a));
        setItems(sorted);
        setLoading(false);
      });
  }, [org]);

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Review queue</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {items.length} pending · sorted by priority
          </p>
        </div>
        <div className="text-xs text-gray-400 bg-gray-100 rounded-lg px-3 py-2">
          <span className="font-mono">A</span> accept · <span className="font-mono">O</span> override · <span className="font-mono">S</span> skip · <span className="font-mono">R</span> rule+accept
        </div>
      </div>

      {items.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <p className="text-4xl mb-3">✓</p>
          <p className="text-gray-900 font-medium">Queue is clear</p>
          <p className="text-sm text-gray-400 mt-1">All transactions have been reviewed.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
          {items.map(item => {
            const tx = item.transactions;
            return (
              <Link
                key={item.id}
                to={`/review/${item.id}`}
                className="flex items-start gap-4 px-5 py-4 hover:bg-gray-50 transition-colors group"
              >
                {/* Flag badges */}
                <div className="flex flex-wrap gap-1 pt-0.5 min-w-0 w-36">
                  {item.flag_reasons.map(r => {
                    const f = FLAG_LABELS[r] ?? { label: r, cls: 'bg-gray-100 text-gray-600' };
                    return (
                      <span key={r} className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${f.cls}`}>
                        {f.label}
                      </span>
                    );
                  })}
                </div>

                {/* Transaction info */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {tx?.vendor_name ?? tx?.description ?? '—'}
                  </p>
                  <p className="text-xs text-gray-400 truncate mt-0.5">{tx?.description}</p>
                </div>

                {/* Amount + date */}
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-semibold text-gray-900">{tx ? fmt$$(tx.amount_usd) : '—'}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{tx ? fmtDate(tx.date) : ''}</p>
                </div>

                {/* Confidence */}
                <div className="text-right flex-shrink-0 w-16">
                  {item.suggested_confidence !== null ? (
                    <>
                      <p className={`text-sm font-medium ${
                        item.suggested_confidence >= 0.8 ? 'text-green-600' :
                        item.suggested_confidence >= 0.6 ? 'text-amber-600' : 'text-red-500'
                      }`}>
                        {(item.suggested_confidence * 100).toFixed(0)}%
                      </p>
                      <p className="text-xs text-gray-400">confidence</p>
                    </>
                  ) : null}
                </div>

                <span className="text-gray-300 group-hover:text-gray-400 self-center">›</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

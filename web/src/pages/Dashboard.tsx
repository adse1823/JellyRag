import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { butterbase, CategorizationEvent, MonthlyBudget, fmt$$, fmtRelative } from '../lib/butterbase-client';
import { useOrg } from '../lib/OrgContext';
import BudgetMeter from '../components/BudgetMeter';

interface TxCounts { pending: number; in_review: number; categorized: number; total: number; }
interface PayoutCounts { matched: number; unmatched: number; pending: number; }

export default function Dashboard() {
  const { org } = useOrg();
  const [txCounts, setTxCounts] = useState<TxCounts | null>(null);
  const [payoutCounts, setPayoutCounts] = useState<PayoutCounts | null>(null);
  const [reviewCount, setReviewCount] = useState<number | null>(null);
  const [budget, setBudget] = useState<MonthlyBudget | null>(null);
  const [recentEvents, setRecentEvents] = useState<CategorizationEvent[]>([]);
  const [accountMap, setAccountMap] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!org) return;
    const bb = butterbase as any;
    const month = new Date().toISOString().slice(0, 7);

    async function load() {
      const [txRes, payoutRes, reviewRes, budgetRes, eventRes, acctRes] = await Promise.all([
        bb.from('transactions').select('category_status').eq('organization_id', org!.id).limit(5000),
        bb.from('channel_payouts').select('reconciliation_status').eq('organization_id', org!.id).limit(1000),
        bb.from('review_queue').select('id', { count: 'exact', head: true })
          .eq('organization_id', org!.id).eq('status', 'pending'),
        bb.from('monthly_budgets').select('*').eq('organization_id', org!.id).eq('month', month).maybeSingle(),
        bb.from('categorization_events')
          .select('*, transactions(description, vendor_name, amount_usd, date), chart_of_accounts(name, full_name)')
          .eq('organization_id', org!.id)
          .order('created_at', { ascending: false })
          .limit(10),
        bb.from('chart_of_accounts').select('id, name').eq('organization_id', org!.id).eq('is_active', true),
      ]);

      if (txRes.data) {
        const txs = txRes.data as { category_status: string }[];
        setTxCounts({
          pending: txs.filter(t => t.category_status === 'pending').length,
          in_review: txs.filter(t => t.category_status === 'in_review').length,
          categorized: txs.filter(t => t.category_status === 'categorized').length,
          total: txs.length,
        });
      }

      if (payoutRes.data) {
        const ps = payoutRes.data as { reconciliation_status: string }[];
        setPayoutCounts({
          matched: ps.filter(p => p.reconciliation_status === 'matched').length,
          unmatched: ps.filter(p => p.reconciliation_status === 'unmatched').length,
          pending: ps.filter(p => p.reconciliation_status === 'pending').length,
        });
      }

      if (reviewRes.count !== null) setReviewCount(reviewRes.count);
      if (budgetRes.data) setBudget(budgetRes.data);
      if (eventRes.data) setRecentEvents(eventRes.data as CategorizationEvent[]);
      if (acctRes.data) {
        const m: Record<string, string> = {};
        for (const a of acctRes.data as { id: string; name: string }[]) m[a.id] = a.name;
        setAccountMap(m);
      }
    }

    load();
  }, [org]);

  const triggerLabel: Record<string, string> = {
    vendor_rule: 'Vendor rule',
    rag_match: 'RAG match',
    llm: 'AI',
    human: 'Human',
  };

  const triggerBadge: Record<string, string> = {
    vendor_rule: 'bg-blue-100 text-blue-700',
    rag_match: 'bg-purple-100 text-purple-700',
    llm: 'bg-indigo-100 text-indigo-700',
    human: 'bg-green-100 text-green-700',
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-xl font-semibold text-gray-900 mb-6">Dashboard</h1>

      {/* Metric cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {/* Transactions */}
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500 mb-1">Transactions</p>
          <p className="text-2xl font-bold text-gray-900">{txCounts?.total ?? '—'}</p>
          {txCounts && (
            <div className="mt-2 space-y-0.5 text-xs text-gray-500">
              <div className="flex justify-between">
                <span>Categorized</span>
                <span className="font-medium text-green-600">{txCounts.categorized}</span>
              </div>
              <div className="flex justify-between">
                <span>In review</span>
                <span className="font-medium text-amber-600">{txCounts.in_review}</span>
              </div>
              <div className="flex justify-between">
                <span>Pending</span>
                <span className="font-medium text-gray-400">{txCounts.pending}</span>
              </div>
            </div>
          )}
        </div>

        {/* Review queue */}
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500 mb-1">Review queue</p>
          <p className={`text-2xl font-bold ${reviewCount ? 'text-amber-600' : 'text-gray-900'}`}>
            {reviewCount ?? '—'}
          </p>
          <p className="text-xs text-gray-400 mt-1 mb-3">pending items</p>
          {reviewCount !== null && reviewCount > 0 && (
            <Link to="/review"
              className="inline-block text-xs bg-amber-100 text-amber-700 px-3 py-1 rounded-full hover:bg-amber-200 transition-colors">
              Review now →
            </Link>
          )}
        </div>

        {/* Shopify payouts */}
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500 mb-1">Shopify payouts</p>
          <p className="text-2xl font-bold text-gray-900">
            {payoutCounts ? payoutCounts.matched + payoutCounts.unmatched + payoutCounts.pending : '—'}
          </p>
          {payoutCounts && (
            <div className="mt-2 space-y-0.5 text-xs text-gray-500">
              <div className="flex justify-between">
                <span>Matched</span>
                <span className="font-medium text-green-600">{payoutCounts.matched}</span>
              </div>
              <div className="flex justify-between">
                <span>Unmatched</span>
                <span className="font-medium text-red-500">{payoutCounts.unmatched}</span>
              </div>
            </div>
          )}
        </div>

        {/* LLM budget */}
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500 mb-1">LLM budget</p>
          {budget ? (
            <>
              <p className="text-2xl font-bold text-gray-900">{fmt$$(budget.spent_usd)}</p>
              <p className="text-xs text-gray-400 mt-1 mb-3">of {fmt$$(budget.budget_usd)}</p>
              <BudgetMeter
                spentUsd={budget.spent_usd}
                budgetUsd={budget.budget_usd}
                status={budget.status}
              />
            </>
          ) : (
            <p className="text-2xl font-bold text-gray-400">—</p>
          )}
        </div>
      </div>

      {/* Recent activity */}
      <div className="bg-white rounded-xl border border-gray-200">
        <div className="px-5 py-4 border-b border-gray-100">
          <h2 className="font-medium text-gray-900">Recent activity</h2>
        </div>
        {recentEvents.length === 0 ? (
          <p className="text-sm text-gray-400 px-5 py-6 text-center">No activity yet.</p>
        ) : (
          <div className="divide-y divide-gray-50">
            {recentEvents.map(ev => {
              const tx = ev.transactions as { description: string; vendor_name: string | null; amount_usd: number } | undefined;
              const acctName = accountMap[ev.account_id] ?? 'Unknown account';
              return (
                <div key={ev.id} className="px-5 py-3 flex items-start gap-3">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium mt-0.5 ${triggerBadge[ev.triggered_by] ?? 'bg-gray-100 text-gray-600'}`}>
                    {triggerLabel[ev.triggered_by] ?? ev.triggered_by}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-900 truncate">
                      {tx?.vendor_name ?? tx?.description ?? 'Transaction'} → <span className="font-medium">{acctName}</span>
                    </p>
                    <p className="text-xs text-gray-400">
                      {tx ? fmt$$(tx.amount_usd) : ''} · confidence {(ev.confidence * 100).toFixed(0)}%
                    </p>
                  </div>
                  <span className="text-xs text-gray-400 flex-shrink-0">{fmtRelative(ev.created_at)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

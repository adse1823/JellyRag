import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { butterbase, ReconciliationRun, ChannelPayout, invokeFunction, fmtDate, fmt$$ } from '../lib/butterbase-client';
import { useOrg } from '../lib/OrgContext';

export default function ReconciliationRunPage() {
  const { id } = useParams<{ id: string }>();
  const { org, user } = useOrg();
  const [run, setRun] = useState<ReconciliationRun | null>(null);
  const [payouts, setPayouts] = useState<ChannelPayout[]>([]);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState('');

  async function loadData() {
    if (!org || !id) return;
    const bb = butterbase as any;
    const [runRes, payoutRes] = await Promise.all([
      bb.from('reconciliation_runs').select('*').eq('id', id).single(),
      bb.from('channel_payouts')
        .select('*')
        .eq('organization_id', org.id)
        .order('payout_date', { ascending: false })
        .limit(100),
    ]);
    setRun(runRes.data);
    setPayouts(payoutRes.data ?? []);
    setLoading(false);
  }

  useEffect(() => { loadData(); }, [org, id]);

  async function approve() {
    if (!run || !user) return;
    setApproving(true);
    setError('');
    try {
      await invokeFunction('approve-month-end', {
        run_id: run.id,
        approved_by: user.id,
      });
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve');
    } finally {
      setApproving(false);
    }
  }

  const payoutBadge: Record<string, string> = {
    matched: 'bg-green-100 text-green-700',
    partial: 'bg-amber-100 text-amber-700',
    unmatched: 'bg-red-100 text-red-600',
    pending: 'bg-gray-100 text-gray-500',
  };

  const runBadge: Record<string, string> = {
    in_progress: 'bg-blue-100 text-blue-700',
    pending_review: 'bg-amber-100 text-amber-700',
    closed: 'bg-green-100 text-green-700',
  };

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!run) return <div className="p-6 text-gray-400">Run not found.</div>;

  const canApprove = run.status === 'pending_review' && run.unresolved === 0;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <Link to="/reconciliation" className="text-sm text-gray-500 hover:text-gray-700 mb-5 inline-block">
        ← Reconciliation
      </Link>

      {/* Run summary */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-4">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-lg font-semibold text-gray-900">
                {fmtDate(run.period_start)} – {fmtDate(run.period_end)}
              </h1>
              <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${runBadge[run.status] ?? 'bg-gray-100 text-gray-500'}`}>
                {run.status.replace('_', ' ')}
              </span>
            </div>
            {run.approved_at && (
              <p className="text-xs text-gray-400">Closed {fmtDate(run.approved_at)}</p>
            )}
          </div>

          {run.status !== 'closed' && (
            <button
              onClick={approve}
              disabled={!canApprove || approving}
              title={!canApprove ? `${run.unresolved} transactions still unresolved` : ''}
              className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-40 transition-colors flex-shrink-0"
            >
              {approving ? 'Approving…' : 'Approve & close'}
            </button>
          )}
        </div>

        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            ['Total transactions', run.total_transactions ?? 0],
            ['Unresolved', run.unresolved ?? 0],
            ['Auto-categorized', run.auto_categorized ?? 0],
            ['Human-reviewed', run.human_reviewed ?? 0],
          ].map(([label, value]) => (
            <div key={String(label)} className="bg-gray-50 rounded-lg px-3 py-2 text-sm">
              <p className="text-xs text-gray-400">{label}</p>
              <p className="font-semibold text-gray-900">{value}</p>
            </div>
          ))}
        </div>

        {(run.total_matched_usd !== null || run.total_unmatched_usd !== null) && (
          <div className="grid grid-cols-2 gap-3 mt-3">
            {run.total_matched_usd !== null && (
              <div className="bg-green-50 rounded-lg px-3 py-2 text-sm">
                <p className="text-xs text-green-600">Matched</p>
                <p className="font-semibold text-green-700">{fmt$$(run.total_matched_usd)}</p>
              </div>
            )}
            {run.total_unmatched_usd !== null && (
              <div className="bg-red-50 rounded-lg px-3 py-2 text-sm">
                <p className="text-xs text-red-500">Unmatched</p>
                <p className="font-semibold text-red-600">{fmt$$(run.total_unmatched_usd)}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Payout breakdown */}
      <div className="bg-white rounded-xl border border-gray-200">
        <div className="px-5 py-4 border-b border-gray-100">
          <h2 className="font-medium text-gray-900">Shopify payouts in period</h2>
        </div>
        {payouts.length === 0 ? (
          <p className="text-sm text-gray-400 px-5 py-6 text-center">No payouts in this period.</p>
        ) : (
          <div className="divide-y divide-gray-50">
            {payouts
              .filter(p => p.payout_date >= run.period_start && p.payout_date <= run.period_end)
              .map(p => (
                <div key={p.id} className="flex items-center gap-4 px-5 py-3">
                  <div className="flex-1">
                    <p className="text-sm font-medium text-gray-900">{fmtDate(p.payout_date)}</p>
                    <p className="text-xs text-gray-400">
                      Gross {fmt$$(p.gross_amount)} · Fees {fmt$$(p.fees)}
                    </p>
                  </div>
                  <p className="text-sm font-semibold text-gray-900">{fmt$$(p.net_amount)}</p>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${payoutBadge[p.reconciliation_status] ?? 'bg-gray-100 text-gray-500'}`}>
                    {p.reconciliation_status}
                  </span>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState, FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { butterbase, ReconciliationRun, invokeFunction, fmtDate, fmt$$ } from '../lib/butterbase-client';
import { useOrg } from '../lib/OrgContext';

const STATUS_BADGE: Record<string, string> = {
  in_progress: 'bg-blue-100 text-blue-700',
  pending_review: 'bg-amber-100 text-amber-700',
  closed: 'bg-green-100 text-green-700',
};

export default function Reconciliation() {
  const { org, user } = useOrg();
  const [runs, setRuns] = useState<ReconciliationRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInitiate, setShowInitiate] = useState(false);
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function loadRuns() {
    if (!org) return;
    const { data } = await (butterbase as any)
      .from('reconciliation_runs')
      .select('*')
      .eq('organization_id', org.id)
      .order('created_at', { ascending: false })
      .limit(50);
    setRuns(data ?? []);
    setLoading(false);
  }

  useEffect(() => { loadRuns(); }, [org]);

  // Default period to current month
  useEffect(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const last = new Date(y, now.getMonth() + 1, 0).getDate();
    setPeriodStart(`${y}-${m}-01`);
    setPeriodEnd(`${y}-${m}-${last}`);
  }, []);

  async function initiate(e: FormEvent) {
    e.preventDefault();
    if (!org || !user) return;
    setSubmitting(true);
    setError('');
    try {
      await invokeFunction('initiate-month-end', {
        organization_id: org.id,
        period_start: periodStart,
        period_end: periodEnd,
        initiated_by: user.id,
      });
      setShowInitiate(false);
      await loadRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to initiate');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Reconciliation</h1>
        <button
          onClick={() => setShowInitiate(true)}
          className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors"
        >
          Initiate month-end close
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-40">
          <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : runs.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <p className="text-gray-400 text-sm">No reconciliation runs yet.</p>
          <p className="text-gray-400 text-sm mt-1">Initiate your first month-end close above.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
          {runs.map(run => (
            <Link
              key={run.id}
              to={`/reconciliation/${run.id}`}
              className="flex items-center gap-4 px-5 py-4 hover:bg-gray-50 transition-colors group"
            >
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <p className="text-sm font-medium text-gray-900">
                    {fmtDate(run.period_start)} – {fmtDate(run.period_end)}
                  </p>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_BADGE[run.status] ?? 'bg-gray-100 text-gray-500'}`}>
                    {run.status.replace('_', ' ')}
                  </span>
                </div>
                <p className="text-xs text-gray-400">
                  {run.total_transactions ?? 0} transactions ·{' '}
                  {run.unresolved ? `${run.unresolved} unresolved · ` : ''}
                  {run.auto_categorized ?? 0} auto-categorized · {run.human_reviewed ?? 0} human-reviewed
                </p>
              </div>
              <div className="text-right flex-shrink-0">
                {run.total_matched_usd !== null && (
                  <p className="text-sm font-semibold text-green-600">{fmt$$(run.total_matched_usd)} matched</p>
                )}
                {run.total_unmatched_usd !== null && run.total_unmatched_usd > 0 && (
                  <p className="text-xs text-red-500">{fmt$$(run.total_unmatched_usd)} unmatched</p>
                )}
                {run.approved_at && (
                  <p className="text-xs text-gray-400">Closed {fmtDate(run.approved_at)}</p>
                )}
              </div>
              <span className="text-gray-300 group-hover:text-gray-400">›</span>
            </Link>
          ))}
        </div>
      )}

      {/* Initiate modal */}
      {showInitiate && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onClick={e => { if (e.target === e.currentTarget) setShowInitiate(false); }}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <h3 className="font-semibold text-gray-900 mb-1">Initiate month-end close</h3>
            <p className="text-sm text-gray-500 mb-5">
              This will check all transactions in the period and flag any that aren't categorized.
            </p>
            <form onSubmit={initiate} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Period start</label>
                  <input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)} required
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Period end</label>
                  <input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} required
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <div className="flex gap-3">
                <button type="submit" disabled={submitting}
                  className="flex-1 bg-indigo-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                  {submitting ? 'Processing…' : 'Initiate close'}
                </button>
                <button type="button" onClick={() => setShowInitiate(false)}
                  className="px-4 bg-white border border-gray-300 text-gray-700 py-2 rounded-lg text-sm hover:bg-gray-50">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

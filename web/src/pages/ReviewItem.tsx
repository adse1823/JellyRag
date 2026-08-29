import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { butterbase, Account, ReviewQueueItem, Transaction, invokeFunction, fmt$$, fmtDate } from '../lib/butterbase-client';
import { useOrg } from '../lib/OrgContext';

interface QueueRow extends ReviewQueueItem {
  transactions: Transaction;
}

interface TopAlt { account_id: string; confidence: number; reasoning: string; }

export default function ReviewItemPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { org, user } = useOrg();

  const [item, setItem] = useState<QueueRow | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [suggestedAccount, setSuggestedAccount] = useState<Account | null>(null);
  const [showOverride, setShowOverride] = useState(false);
  const [overrideSearch, setOverrideSearch] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!org || !id) return;
    const bb = butterbase as any;
    Promise.all([
      bb.from('review_queue').select('*, transactions(*)').eq('id', id).single(),
      bb.from('chart_of_accounts').select('*').eq('organization_id', org.id).eq('is_active', true).order('full_name'),
    ]).then(([qRes, acctRes]: [{ data: QueueRow | null }, { data: Account[] | null }]) => {
      if (qRes.data) {
        setItem(qRes.data);
        setSelectedAccountId(qRes.data.suggested_account_id ?? '');
      }
      if (acctRes.data) {
        setAccounts(acctRes.data);
      }
      setLoading(false);
    });
  }, [org, id]);

  useEffect(() => {
    if (!item || !accounts.length) return;
    const acct = accounts.find(a => a.id === item.suggested_account_id);
    setSuggestedAccount(acct ?? null);
  }, [item, accounts]);

  const resolve = useCallback(async (accountId: string, addVendorRule = false) => {
    if (!item || !user) return;
    setSubmitting(true);
    setError('');
    try {
      await invokeFunction('process-review-decision', {
        review_queue_id: item.id,
        reviewer_id: user.id,
        account_id: accountId,
        add_vendor_rule: addVendorRule,
      });
      navigate('/review');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit decision');
      setSubmitting(false);
    }
  }, [item, user, navigate]);

  const skip = useCallback(async () => {
    if (!item) return;
    setSubmitting(true);
    try {
      await (butterbase as any)
        .from('review_queue')
        .update({ status: 'skipped' })
        .eq('id', item.id);
      navigate('/review');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to skip');
      setSubmitting(false);
    }
  }, [item, navigate]);

  const handleAccept = useCallback(() => {
    if (item?.suggested_account_id) resolve(item.suggested_account_id);
  }, [item, resolve]);

  const handleRuleAndAccept = useCallback(() => {
    if (item?.suggested_account_id) resolve(item.suggested_account_id, true);
  }, [item, resolve]);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (submitting) return;
      if (e.key === 'a' || e.key === 'A') handleAccept();
      if (e.key === 'o' || e.key === 'O') setShowOverride(true);
      if (e.key === 's' || e.key === 'S') skip();
      if (e.key === 'r' || e.key === 'R') handleRuleAndAccept();
      if (e.key === 'Escape') setShowOverride(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleAccept, skip, handleRuleAndAccept, submitting]);

  const filteredAccounts = accounts.filter(a =>
    a.full_name.toLowerCase().includes(overrideSearch.toLowerCase()) ||
    a.name.toLowerCase().includes(overrideSearch.toLowerCase())
  );

  const topAlts: TopAlt[] = item?.top_alternatives
    ? (item.top_alternatives as TopAlt[])
    : [];

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!item) {
    return (
      <div className="p-6 text-center">
        <p className="text-gray-500">Item not found or already resolved.</p>
      </div>
    );
  }

  const tx = item.transactions;
  const conf = item.suggested_confidence ?? 0;
  const confColor = conf >= 0.8 ? 'text-green-600' : conf >= 0.6 ? 'text-amber-600' : 'text-red-500';
  const confBarColor = conf >= 0.8 ? 'bg-green-500' : conf >= 0.6 ? 'bg-amber-400' : 'bg-red-500';

  return (
    <div className="p-6 max-w-3xl mx-auto">
      {/* Back + keyboard hint */}
      <div className="flex items-center justify-between mb-5">
        <button onClick={() => navigate('/review')} className="text-sm text-gray-500 hover:text-gray-700">
          ← Review queue
        </button>
        <span className="text-xs text-gray-400 bg-gray-100 rounded-lg px-3 py-1.5">
          <kbd className="font-mono">A</kbd> accept · <kbd className="font-mono">O</kbd> override · <kbd className="font-mono">S</kbd> skip · <kbd className="font-mono">R</kbd> rule+accept
        </span>
      </div>

      {/* Transaction card */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-4">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <p className="text-lg font-semibold text-gray-900">{tx?.vendor_name ?? tx?.description ?? '—'}</p>
            <p className="text-sm text-gray-400 mt-0.5">{tx?.description}</p>
          </div>
          <div className="text-right flex-shrink-0">
            <p className="text-xl font-bold text-gray-900">{tx ? fmt$$(tx.amount_usd) : '—'}</p>
            <p className="text-xs text-gray-400">{tx ? fmtDate(tx.date) : ''}</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 text-xs">
          <span className="bg-gray-100 text-gray-600 px-2 py-1 rounded">
            Source: {tx?.source?.toUpperCase()}
          </span>
          <span className="bg-gray-100 text-gray-600 px-2 py-1 rounded">
            Type: {tx?.transaction_type}
          </span>
          {item.flag_reasons.map(r => (
            <span key={r} className="bg-amber-100 text-amber-700 px-2 py-1 rounded">{r.replace(/_/g, ' ')}</span>
          ))}
        </div>
      </div>

      {/* AI suggestion card */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-medium text-gray-900">AI suggestion</h2>
          <div className="flex items-center gap-2">
            <span className={`text-sm font-semibold ${confColor}`}>{(conf * 100).toFixed(0)}% confidence</span>
            <div className="w-20 h-1.5 bg-gray-200 rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${confBarColor}`} style={{ width: `${conf * 100}%` }} />
            </div>
          </div>
        </div>

        {suggestedAccount ? (
          <div className="bg-gray-50 rounded-lg px-4 py-3 mb-3">
            <p className="text-sm font-semibold text-gray-900">{suggestedAccount.full_name}</p>
            <p className="text-xs text-gray-500 mt-0.5">{suggestedAccount.account_type}</p>
          </div>
        ) : (
          <p className="text-sm text-gray-400 mb-3">No suggestion available</p>
        )}

        {item.suggested_reasoning && (
          <div className="border-l-2 border-indigo-200 pl-3">
            <p className="text-xs text-gray-500 leading-relaxed italic">{item.suggested_reasoning}</p>
          </div>
        )}

        {/* Alternatives */}
        {topAlts.length > 0 && (
          <div className="mt-4">
            <p className="text-xs font-medium text-gray-500 mb-2">Other options considered</p>
            <div className="space-y-1">
              {topAlts.slice(0, 3).map((alt, i) => {
                const acct = accounts.find(a => a.id === alt.account_id);
                return (
                  <div key={i} className="flex items-center justify-between text-xs text-gray-500">
                    <span>{acct?.full_name ?? alt.account_id}</span>
                    <span>{(alt.confidence * 100).toFixed(0)}%</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {error && <p className="text-sm text-red-600 mb-4 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

      {/* Action buttons */}
      <div className="flex gap-3">
        <button
          onClick={handleAccept}
          disabled={submitting || !item.suggested_account_id}
          className="flex-1 bg-indigo-600 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          <kbd className="bg-indigo-500 text-xs px-1 rounded mr-1">A</kbd> Accept
        </button>
        <button
          onClick={() => setShowOverride(true)}
          disabled={submitting}
          className="flex-1 bg-white border border-gray-300 text-gray-700 py-2.5 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors"
        >
          <kbd className="bg-gray-100 text-xs px-1 rounded mr-1">O</kbd> Override
        </button>
        <button
          onClick={handleRuleAndAccept}
          disabled={submitting || !item.suggested_account_id || !tx?.vendor_name}
          className="flex-1 bg-white border border-gray-300 text-gray-700 py-2.5 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors"
          title={!tx?.vendor_name ? 'No vendor name to create rule from' : ''}
        >
          <kbd className="bg-gray-100 text-xs px-1 rounded mr-1">R</kbd> Rule+Accept
        </button>
        <button
          onClick={skip}
          disabled={submitting}
          className="px-4 bg-white border border-gray-300 text-gray-500 py-2.5 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50 transition-colors"
        >
          <kbd className="bg-gray-100 text-xs px-1 rounded mr-1">S</kbd> Skip
        </button>
      </div>

      {/* Override modal */}
      {showOverride && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onClick={e => { if (e.target === e.currentTarget) setShowOverride(false); }}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
            <div className="px-5 py-4 border-b border-gray-100">
              <h3 className="font-medium text-gray-900">Select category</h3>
            </div>
            <div className="p-3">
              <input
                autoFocus
                type="text"
                value={overrideSearch}
                onChange={e => setOverrideSearch(e.target.value)}
                placeholder="Search accounts…"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div className="max-h-64 overflow-y-auto divide-y divide-gray-50">
              {filteredAccounts.map(acct => (
                <button
                  key={acct.id}
                  onClick={() => {
                    setShowOverride(false);
                    resolve(acct.id);
                  }}
                  className={`w-full text-left px-5 py-3 hover:bg-gray-50 transition-colors ${
                    acct.id === selectedAccountId ? 'bg-indigo-50' : ''
                  }`}
                >
                  <p className="text-sm font-medium text-gray-900">{acct.full_name}</p>
                  <p className="text-xs text-gray-400">{acct.account_type}</p>
                </button>
              ))}
              {filteredAccounts.length === 0 && (
                <p className="text-sm text-gray-400 px-5 py-4 text-center">No matching accounts</p>
              )}
            </div>
            <div className="px-5 py-3 border-t border-gray-100">
              <button onClick={() => setShowOverride(false)}
                className="text-sm text-gray-500 hover:text-gray-700">Cancel (Esc)</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

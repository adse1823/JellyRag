import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { butterbase, Transaction, CategorizationEvent, Account, fmt$$, fmtDate, fmtRelative } from '../lib/butterbase-client';
import { useOrg } from '../lib/OrgContext';

export default function TransactionDetail() {
  const { id } = useParams<{ id: string }>();
  const { org } = useOrg();
  const [tx, setTx] = useState<Transaction | null>(null);
  const [events, setEvents] = useState<CategorizationEvent[]>([]);
  const [accountMap, setAccountMap] = useState<Record<string, Account>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!org || !id) return;
    const bb = butterbase as any;
    Promise.all([
      bb.from('transactions').select('*').eq('id', id).single(),
      bb.from('categorization_events').select('*').eq('transaction_id', id).order('created_at', { ascending: false }),
      bb.from('chart_of_accounts').select('*').eq('organization_id', org.id),
    ]).then(([txRes, evRes, acctRes]: [{ data: Transaction | null }, { data: CategorizationEvent[] | null }, { data: Account[] | null }]) => {
      setTx(txRes.data);
      setEvents(evRes.data ?? []);
      const m: Record<string, Account> = {};
      for (const a of acctRes.data ?? []) m[a.id] = a;
      setAccountMap(m);
      setLoading(false);
    });
  }, [org, id]);

  const triggerBadge: Record<string, string> = {
    vendor_rule: 'bg-blue-100 text-blue-700',
    rag_match: 'bg-purple-100 text-purple-700',
    llm: 'bg-indigo-100 text-indigo-700',
    human: 'bg-green-100 text-green-700',
  };

  const triggerLabel: Record<string, string> = {
    vendor_rule: 'Vendor rule',
    rag_match: 'RAG match',
    llm: 'AI',
    human: 'Human',
  };

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!tx) {
    return <div className="p-6 text-gray-400">Transaction not found.</div>;
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <Link to="/transactions" className="text-sm text-gray-500 hover:text-gray-700 mb-5 inline-block">
        ← Transactions
      </Link>

      {/* Transaction details */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-4">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <p className="text-lg font-semibold text-gray-900">{tx.vendor_name ?? tx.description}</p>
            <p className="text-sm text-gray-400">{tx.description}</p>
          </div>
          <p className="text-xl font-bold text-gray-900 flex-shrink-0">{fmt$$(tx.amount_usd)}</p>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          {[
            ['Date', fmtDate(tx.date)],
            ['Source', tx.source.toUpperCase()],
            ['Type', tx.transaction_type],
            ['Status', tx.category_status.replace('_', ' ')],
            ['Category', tx.account_id ? accountMap[tx.account_id]?.full_name ?? '—' : 'Uncategorized'],
            ['QBO write', tx.qbo_write_status ?? 'n/a'],
          ].map(([label, value]) => (
            <div key={label} className="bg-gray-50 rounded-lg px-3 py-2">
              <p className="text-xs text-gray-400">{label}</p>
              <p className="font-medium text-gray-900 capitalize">{value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Audit trail */}
      <div className="bg-white rounded-xl border border-gray-200">
        <div className="px-5 py-4 border-b border-gray-100">
          <h2 className="font-medium text-gray-900">Categorization history</h2>
        </div>

        {events.length === 0 ? (
          <p className="text-sm text-gray-400 px-5 py-6 text-center">No categorization events yet.</p>
        ) : (
          <div className="divide-y divide-gray-50">
            {events.map((ev, i) => {
              const acct = accountMap[ev.account_id];
              return (
                <div key={ev.id} className="px-5 py-4">
                  <div className="flex items-start gap-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium mt-0.5 flex-shrink-0 ${triggerBadge[ev.triggered_by] ?? 'bg-gray-100 text-gray-600'}`}>
                      {triggerLabel[ev.triggered_by] ?? ev.triggered_by}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-gray-900">
                          → {acct?.full_name ?? ev.account_id}
                        </p>
                        {i === 0 && (
                          <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">current</span>
                        )}
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5">
                        Confidence: {(ev.confidence * 100).toFixed(0)}%
                        {ev.model_id && ` · ${ev.model_id}`}
                        {ev.llm_cost_usd && ` · ${fmt$$(ev.llm_cost_usd)}`}
                        {' · '}{fmtRelative(ev.created_at)}
                      </p>
                      {ev.reasoning && (
                        <p className="text-xs text-gray-500 mt-2 italic leading-relaxed border-l-2 border-gray-200 pl-2">
                          {ev.reasoning}
                        </p>
                      )}
                      {ev.overrode_suggestion && (
                        <p className="text-xs text-amber-600 mt-1">
                          Overrode: {accountMap[ev.overrode_suggestion]?.full_name ?? ev.overrode_suggestion}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { butterbase, fmt$$, fmtDate, fmtRelative } from '../lib/butterbase-client';
import { useOrg } from '../lib/OrgContext';

const TRIGGER_BADGE: Record<string, string> = {
  vendor_rule: 'bg-blue-100 text-blue-700',
  rag_match: 'bg-purple-100 text-purple-700',
  llm: 'bg-indigo-100 text-indigo-700',
  human: 'bg-green-100 text-green-700',
};

const TRIGGER_LABEL: Record<string, string> = {
  vendor_rule: 'Vendor rule',
  rag_match: 'RAG match',
  llm: 'AI',
  human: 'Human',
};

interface EventRow {
  id: string;
  organization_id: string;
  transaction_id: string;
  triggered_by: string;
  account_id: string;
  confidence: number;
  reasoning: string | null;
  llm_cost_usd: number | null;
  created_at: string;
  transactions: { id: string; description: string; vendor_name: string | null; amount_usd: number; date: string } | null;
  chart_of_accounts: { name: string; full_name: string } | null;
}

export default function Audit() {
  const { org } = useOrg();
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [triggerFilter, setTriggerFilter] = useState<string>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!org) return;
    (butterbase as any)
      .from('categorization_events')
      .select('*, transactions(id, description, vendor_name, amount_usd, date), chart_of_accounts(name, full_name)')
      .eq('organization_id', org.id)
      .order('created_at', { ascending: false })
      .limit(300)
      .then(({ data }: { data: EventRow[] | null }) => {
        setEvents(data ?? []);
        setLoading(false);
      });
  }, [org]);

  const filtered = triggerFilter === 'all'
    ? events
    : events.filter(ev => ev.triggered_by === triggerFilter);

  function toggleExpand(id: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-xl font-semibold text-gray-900">Audit trail</h1>
        <select value={triggerFilter} onChange={e => setTriggerFilter(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
          <option value="all">All sources</option>
          <option value="vendor_rule">Vendor rule</option>
          <option value="rag_match">RAG match</option>
          <option value="llm">AI (LLM)</option>
          <option value="human">Human</option>
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-40">
          <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-50">
          {filtered.length === 0 && (
            <p className="text-sm text-gray-400 px-5 py-8 text-center">No categorization events yet.</p>
          )}
          {filtered.map(ev => {
            const tx = ev.transactions;
            const isExpanded = expanded.has(ev.id);
            return (
              <div key={ev.id} className="px-5 py-3">
                <div className="flex items-start gap-3">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium mt-0.5 flex-shrink-0 ${TRIGGER_BADGE[ev.triggered_by] ?? 'bg-gray-100 text-gray-600'}`}>
                    {TRIGGER_LABEL[ev.triggered_by] ?? ev.triggered_by}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link to={`/transactions/${tx?.id}`} className="text-sm font-medium text-gray-900 hover:text-indigo-600 truncate">
                        {tx?.vendor_name ?? tx?.description ?? '—'}
                      </Link>
                      <span className="text-gray-300">→</span>
                      <span className="text-sm text-gray-700">{ev.chart_of_accounts?.full_name ?? ev.account_id}</span>
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {tx ? `${fmt$$(tx.amount_usd)} · ${fmtDate(tx.date)} · ` : ''}
                      {(ev.confidence * 100).toFixed(0)}% confidence
                      {ev.llm_cost_usd ? ` · ${fmt$$(ev.llm_cost_usd)} LLM cost` : ''}
                      {' · '}{fmtRelative(ev.created_at)}
                    </p>
                    {ev.reasoning && (
                      <button
                        onClick={() => toggleExpand(ev.id)}
                        className="text-xs text-indigo-500 hover:text-indigo-700 mt-1"
                      >
                        {isExpanded ? 'Hide reasoning' : 'Show reasoning'}
                      </button>
                    )}
                    {isExpanded && ev.reasoning && (
                      <p className="text-xs text-gray-500 mt-2 italic leading-relaxed border-l-2 border-indigo-200 pl-2">
                        {ev.reasoning}
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
  );
}

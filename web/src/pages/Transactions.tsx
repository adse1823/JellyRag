import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { butterbase, Transaction, fmt$$, fmtDate } from '../lib/butterbase-client';
import { useOrg } from '../lib/OrgContext';

const STATUS_BADGE: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-500',
  in_review: 'bg-amber-100 text-amber-700',
  categorized: 'bg-green-100 text-green-700',
};

export default function Transactions() {
  const { org } = useOrg();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!org) return;
    (butterbase as any)
      .from('transactions')
      .select('*')
      .eq('organization_id', org.id)
      .order('date', { ascending: false })
      .limit(500)
      .then(({ data }: { data: Transaction[] | null }) => {
        setTransactions(data ?? []);
        setLoading(false);
      });
  }, [org]);

  const filtered = transactions.filter(tx => {
    if (statusFilter !== 'all' && tx.category_status !== statusFilter) return false;
    if (sourceFilter !== 'all' && tx.source !== sourceFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!tx.description.toLowerCase().includes(q) && !(tx.vendor_name?.toLowerCase().includes(q))) return false;
    }
    return true;
  });

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-xl font-semibold text-gray-900 mb-5">Transactions</h1>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-5">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search description or vendor…"
          className="flex-1 min-w-48 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white">
          <option value="all">All statuses</option>
          <option value="pending">Pending</option>
          <option value="in_review">In review</option>
          <option value="categorized">Categorized</option>
        </select>
        <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white">
          <option value="all">All sources</option>
          <option value="qbo">QBO</option>
          <option value="shopify">Shopify</option>
          <option value="manual">Manual</option>
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-40">
          <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-5 py-3 text-xs font-medium text-gray-500">Date</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-gray-500">Description</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-gray-500">Source</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-gray-500">Status</th>
                  <th className="text-right px-5 py-3 text-xs font-medium text-gray-500">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.slice(0, 200).map(tx => (
                  <tr key={tx.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-5 py-3 text-gray-500 whitespace-nowrap">{fmtDate(tx.date)}</td>
                    <td className="px-5 py-3 max-w-xs">
                      <Link to={`/transactions/${tx.id}`} className="hover:text-indigo-600 transition-colors">
                        <p className="font-medium text-gray-900 truncate">{tx.vendor_name ?? tx.description}</p>
                        {tx.vendor_name && (
                          <p className="text-xs text-gray-400 truncate">{tx.description}</p>
                        )}
                      </Link>
                    </td>
                    <td className="px-5 py-3">
                      <span className="text-xs text-gray-500 uppercase">{tx.source}</span>
                    </td>
                    <td className="px-5 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_BADGE[tx.category_status] ?? 'bg-gray-100 text-gray-500'}`}>
                        {tx.category_status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right font-medium text-gray-900 whitespace-nowrap">
                      {fmt$$(tx.amount_usd)}
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-5 py-8 text-center text-gray-400 text-sm">
                      No transactions match your filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {filtered.length > 200 && (
            <p className="text-xs text-gray-400 px-5 py-3 border-t border-gray-100">
              Showing 200 of {filtered.length} results. Refine your filters to see more.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

import { useEffect, useState, FormEvent } from 'react';
import { butterbase, Account, VendorRule, IntegrationConnection, invokeFunction } from '../lib/butterbase-client';
import { useOrg } from '../lib/OrgContext';

export default function Settings() {
  const { org, user, reload } = useOrg();
  const [orgName, setOrgName] = useState(org?.name ?? '');
  const [hitlAmount, setHitlAmount] = useState(String(org?.settings.hitl_amount_threshold_usd ?? 500));
  const [hitlConf, setHitlConf] = useState(String(org?.settings.hitl_confidence_threshold ?? 0.85));
  const [budget, setBudget] = useState(String(org?.settings.monthly_llm_budget_usd ?? 25));
  const [strictMode, setStrictMode] = useState(org?.settings.strict_month_end ?? false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  const [rules, setRules] = useState<(VendorRule & { chart_of_accounts?: { full_name: string } | null })[]>([]);
  const [connections, setConnections] = useState<IntegrationConnection[]>([]);
  const [accountMap, setAccountMap] = useState<Record<string, Account>>({});
  const [shopDomain, setShopDomain] = useState('');
  const [connectingQBO, setConnectingQBO] = useState(false);
  const [connectingShopify, setConnectingShopify] = useState(false);
  const [deletingRule, setDeletingRule] = useState<string | null>(null);

  useEffect(() => {
    if (!org) return;
    const bb = butterbase as any;
    Promise.all([
      bb.from('vendor_rules').select('*, chart_of_accounts(name, full_name)').eq('organization_id', org.id).order('apply_count', { ascending: false }),
      bb.from('integration_connections').select('*').eq('organization_id', org.id),
      bb.from('chart_of_accounts').select('*').eq('organization_id', org.id),
    ]).then(([rRes, cRes, aRes]: [
      { data: (VendorRule & { chart_of_accounts?: { full_name: string } | null })[] | null },
      { data: IntegrationConnection[] | null },
      { data: Account[] | null }
    ]) => {
      setRules(rRes.data ?? []);
      setConnections(cRes.data ?? []);
      const m: Record<string, Account> = {};
      for (const a of aRes.data ?? []) m[a.id] = a;
      setAccountMap(m);
    });
  }, [org]);

  async function savePreferences(e: FormEvent) {
    e.preventDefault();
    if (!org) return;
    setSaving(true);
    setSaveMsg('');
    try {
      const { error } = await (butterbase as any)
        .from('organizations')
        .update({
          name: orgName.trim(),
          settings: {
            hitl_amount_threshold_usd: parseFloat(hitlAmount),
            hitl_confidence_threshold: parseFloat(hitlConf),
            strict_month_end: strictMode,
            monthly_llm_budget_usd: parseFloat(budget),
          },
        })
        .eq('id', org.id);
      if (error) throw new Error(error.message);
      await reload();
      setSaveMsg('Saved');
      setTimeout(() => setSaveMsg(''), 2000);
    } catch {
      setSaveMsg('Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function deleteRule(ruleId: string) {
    setDeletingRule(ruleId);
    await (butterbase as any).from('vendor_rules').delete().eq('id', ruleId);
    setRules(prev => prev.filter(r => r.id !== ruleId));
    setDeletingRule(null);
  }

  async function connectQBO() {
    if (!org) return;
    setConnectingQBO(true);
    try {
      const { url } = await invokeFunction<{ url: string }>('qbo-oauth-init', { organization_id: org.id });
      window.location.href = url;
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to connect QBO');
      setConnectingQBO(false);
    }
  }

  async function connectShopify(e: FormEvent) {
    e.preventDefault();
    if (!org) return;
    setConnectingShopify(true);
    try {
      const shop = shopDomain.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
      const { url } = await invokeFunction<{ url: string }>('shopify-oauth-init', { organization_id: org.id, shop });
      window.location.href = url;
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to connect Shopify');
      setConnectingShopify(false);
    }
  }

  const qboConn = connections.find(c => c.provider === 'qbo');
  const shopifyConn = connections.find(c => c.provider === 'shopify');

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <h1 className="text-xl font-semibold text-gray-900">Settings</h1>

      {/* Organization + thresholds */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="font-medium text-gray-900 mb-4">Organization</h2>
        <form onSubmit={savePreferences} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Organization name</label>
            <input type="text" value={orgName} onChange={e => setOrgName(e.target.value)} required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">HITL amount threshold ($)</label>
              <input type="number" value={hitlAmount} onChange={e => setHitlAmount(e.target.value)} min="0" step="50"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">HITL confidence threshold</label>
              <input type="number" value={hitlConf} onChange={e => setHitlConf(e.target.value)} min="0" max="1" step="0.05"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Monthly LLM budget ($)</label>
              <input type="number" value={budget} onChange={e => setBudget(e.target.value)} min="1" step="5"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <div className="flex items-center gap-3 pt-6">
              <input type="checkbox" id="strict" checked={strictMode} onChange={e => setStrictMode(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
              <label htmlFor="strict" className="text-sm text-gray-700">Strict month-end (require approval even if all categorized)</label>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button type="submit" disabled={saving}
              className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
              {saving ? 'Saving…' : 'Save changes'}
            </button>
            {saveMsg && (
              <span className={`text-sm ${saveMsg === 'Saved' ? 'text-green-600' : 'text-red-600'}`}>{saveMsg}</span>
            )}
          </div>
        </form>
      </div>

      {/* Integrations */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="font-medium text-gray-900 mb-4">Integrations</h2>
        <div className="space-y-4">
          {/* QBO */}
          <div className="flex items-center justify-between p-4 border border-gray-200 rounded-lg">
            <div>
              <p className="text-sm font-medium text-gray-900">QuickBooks Online</p>
              {qboConn ? (
                <p className="text-xs text-gray-400 mt-0.5">
                  <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${qboConn.status === 'active' ? 'bg-green-500' : 'bg-red-400'}`} />
                  {qboConn.status} · Realm {qboConn.qbo_realm_id}
                </p>
              ) : (
                <p className="text-xs text-gray-400 mt-0.5">Not connected</p>
              )}
            </div>
            <button onClick={connectQBO} disabled={connectingQBO}
              className="text-sm text-indigo-600 hover:text-indigo-700 disabled:opacity-50 font-medium">
              {connectingQBO ? 'Redirecting…' : qboConn ? 'Reconnect' : 'Connect'}
            </button>
          </div>

          {/* Shopify */}
          <div className="p-4 border border-gray-200 rounded-lg">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-sm font-medium text-gray-900">Shopify</p>
                {shopifyConn ? (
                  <p className="text-xs text-gray-400 mt-0.5">
                    <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${shopifyConn.status === 'active' ? 'bg-green-500' : 'bg-red-400'}`} />
                    {shopifyConn.status} · {shopifyConn.shopify_shop_name ?? shopifyConn.shopify_domain}
                  </p>
                ) : (
                  <p className="text-xs text-gray-400 mt-0.5">Not connected</p>
                )}
              </div>
            </div>
            <form onSubmit={connectShopify} className="flex gap-2">
              <input type="text" value={shopDomain} onChange={e => setShopDomain(e.target.value)}
                placeholder="mystore.myshopify.com"
                className="flex-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <button type="submit" disabled={connectingShopify}
                className="text-sm text-indigo-600 hover:text-indigo-700 disabled:opacity-50 font-medium px-3 py-1.5 border border-indigo-200 rounded-lg">
                {connectingShopify ? 'Redirecting…' : shopifyConn ? 'Reconnect' : 'Connect'}
              </button>
            </form>
          </div>
        </div>
      </div>

      {/* Vendor rules */}
      <div className="bg-white rounded-xl border border-gray-200">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h2 className="font-medium text-gray-900">Vendor rules</h2>
            <p className="text-xs text-gray-400 mt-0.5">{rules.length} rules · sorted by usage</p>
          </div>
        </div>
        {rules.length === 0 ? (
          <p className="text-sm text-gray-400 px-5 py-6 text-center">
            No vendor rules yet. Rules are created automatically when you click "Rule+Accept" in the review queue.
          </p>
        ) : (
          <div className="divide-y divide-gray-50">
            {rules.map(rule => {
              const acct = rule.chart_of_accounts ?? (rule.account_id ? { full_name: accountMap[rule.account_id]?.full_name ?? rule.account_id } : null);
              return (
                <div key={rule.id} className="flex items-center gap-4 px-5 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{rule.vendor_pattern}</p>
                    <p className="text-xs text-gray-400">
                      {rule.match_type} · → {acct?.full_name ?? '—'} · {rule.apply_count} uses
                    </p>
                  </div>
                  <span className="text-xs text-gray-400">{(rule.confidence * 100).toFixed(0)}%</span>
                  <button
                    onClick={() => deleteRule(rule.id)}
                    disabled={deletingRule === rule.id}
                    className="text-xs text-red-400 hover:text-red-600 disabled:opacity-50"
                  >
                    {deletingRule === rule.id ? '…' : 'Delete'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Account info */}
      {user && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="font-medium text-gray-900 mb-2">Account</h2>
          <p className="text-sm text-gray-500">{user.email}</p>
          <p className="text-xs text-gray-400 mt-0.5">Org ID: {org?.id}</p>
        </div>
      )}
    </div>
  );
}

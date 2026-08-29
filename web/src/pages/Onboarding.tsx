import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { butterbase, invokeFunction } from '../lib/butterbase-client';
import { useOrg } from '../lib/OrgContext';

const STEPS = ['Organization', 'Connect QBO', 'Connect Shopify', 'Preferences', 'Done'];

export default function Onboarding() {
  const navigate = useNavigate();
  const { user, reload } = useOrg();

  const [step, setStep] = useState(0);
  const [orgName, setOrgName] = useState('');
  const [orgId, setOrgId] = useState('');
  const [shopDomain, setShopDomain] = useState('');
  const [hitlAmount, setHitlAmount] = useState('500');
  const [hitlConfidence, setHitlConfidence] = useState('0.85');
  const [budget, setBudget] = useState('25');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function createOrg(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data, error: err } = await (butterbase as any)
        .from('organizations')
        .insert({
          name: orgName.trim(),
          owner_id: user!.id,
          settings: {
            hitl_amount_threshold_usd: 500,
            hitl_confidence_threshold: 0.85,
            strict_month_end: false,
            monthly_llm_budget_usd: 25,
          },
        })
        .select('id')
        .single();
      if (err) throw new Error(err.message);
      setOrgId(data.id);
      setStep(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create organization');
    } finally {
      setLoading(false);
    }
  }

  async function connectQBO() {
    setError('');
    setLoading(true);
    try {
      const { url } = await invokeFunction<{ url: string }>('qbo-oauth-init', { organization_id: orgId });
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start QBO connection');
      setLoading(false);
    }
  }

  async function connectShopify(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const shop = shopDomain.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
      const { url } = await invokeFunction<{ url: string }>('shopify-oauth-init', {
        organization_id: orgId,
        shop,
      });
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start Shopify connection');
      setLoading(false);
    }
  }

  async function savePreferences(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { error: err } = await (butterbase as any)
        .from('organizations')
        .update({
          settings: {
            hitl_amount_threshold_usd: parseFloat(hitlAmount),
            hitl_confidence_threshold: parseFloat(hitlConfidence),
            strict_month_end: false,
            monthly_llm_budget_usd: parseFloat(budget),
          },
        })
        .eq('id', orgId);
      if (err) throw new Error(err.message);
      // Seed monthly budget row
      await (butterbase as any).from('monthly_budgets').upsert({
        organization_id: orgId,
        month: new Date().toISOString().slice(0, 7),
        budget_usd: parseFloat(budget),
        spent_usd: 0,
        status: 'active',
      }, { onConflict: 'organization_id,month', ignoreDuplicates: true });
      setStep(4);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save preferences');
    } finally {
      setLoading(false);
    }
  }

  async function finish() {
    await reload();
    navigate('/dashboard');
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-lg">
        {/* Progress */}
        <div className="flex items-center gap-2 mb-8">
          {STEPS.map((label, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold
                ${i < step ? 'bg-indigo-600 text-white' :
                  i === step ? 'bg-indigo-600 text-white ring-4 ring-indigo-100' :
                  'bg-gray-200 text-gray-500'}`}>
                {i < step ? '✓' : i + 1}
              </div>
              <span className={`text-xs hidden sm:block ${i === step ? 'text-gray-900 font-medium' : 'text-gray-400'}`}>
                {label}
              </span>
              {i < STEPS.length - 1 && <div className="w-6 h-px bg-gray-300 mx-1" />}
            </div>
          ))}
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          {/* Step 0: Org name */}
          {step === 0 && (
            <>
              <h2 className="text-lg font-semibold mb-1">Name your organization</h2>
              <p className="text-sm text-gray-500 mb-5">This is how your company will appear in the app.</p>
              <form onSubmit={createOrg} className="space-y-4">
                <input
                  type="text"
                  value={orgName}
                  onChange={e => setOrgName(e.target.value)}
                  required
                  placeholder="Acme Commerce LLC"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                {error && <p className="text-sm text-red-600">{error}</p>}
                <button type="submit" disabled={loading}
                  className="w-full bg-indigo-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                  {loading ? 'Creating…' : 'Continue'}
                </button>
              </form>
            </>
          )}

          {/* Step 1: QBO */}
          {step === 1 && (
            <>
              <h2 className="text-lg font-semibold mb-1">Connect QuickBooks Online</h2>
              <p className="text-sm text-gray-500 mb-5">
                JellyRag reads your transactions and writes approved categorizations back to QBO.
              </p>
              {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
              <div className="space-y-3">
                <button onClick={connectQBO} disabled={loading}
                  className="w-full bg-green-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50">
                  {loading ? 'Redirecting…' : 'Connect QuickBooks →'}
                </button>
                <button onClick={() => setStep(2)}
                  className="w-full text-gray-500 py-2 text-sm hover:text-gray-700">
                  Skip for now
                </button>
              </div>
            </>
          )}

          {/* Step 2: Shopify */}
          {step === 2 && (
            <>
              <h2 className="text-lg font-semibold mb-1">Connect Shopify</h2>
              <p className="text-sm text-gray-500 mb-5">
                JellyRag syncs your Shopify payouts and reconciles them against your bank transactions.
              </p>
              <form onSubmit={connectShopify} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Shopify store domain</label>
                  <input
                    type="text"
                    value={shopDomain}
                    onChange={e => setShopDomain(e.target.value)}
                    placeholder="mystore.myshopify.com"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                {error && <p className="text-sm text-red-600">{error}</p>}
                <button type="submit" disabled={loading}
                  className="w-full bg-green-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50">
                  {loading ? 'Redirecting…' : 'Connect Shopify →'}
                </button>
              </form>
              <button onClick={() => setStep(3)}
                className="w-full text-gray-500 py-2 text-sm hover:text-gray-700 mt-2">
                Skip for now
              </button>
            </>
          )}

          {/* Step 3: Preferences */}
          {step === 3 && (
            <>
              <h2 className="text-lg font-semibold mb-1">Set preferences</h2>
              <p className="text-sm text-gray-500 mb-5">Configure when the AI should flag transactions for your review.</p>
              <form onSubmit={savePreferences} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Flag transactions above ($)
                  </label>
                  <input type="number" value={hitlAmount} onChange={e => setHitlAmount(e.target.value)}
                    min="0" step="50"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  <p className="text-xs text-gray-400 mt-1">Transactions above this amount always go to review</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Confidence threshold (0–1)
                  </label>
                  <input type="number" value={hitlConfidence} onChange={e => setHitlConfidence(e.target.value)}
                    min="0" max="1" step="0.05"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  <p className="text-xs text-gray-400 mt-1">AI decisions below this confidence go to review</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Monthly AI budget ($)</label>
                  <input type="number" value={budget} onChange={e => setBudget(e.target.value)}
                    min="1" step="5"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  <p className="text-xs text-gray-400 mt-1">LLM calls pause when this limit is reached</p>
                </div>
                {error && <p className="text-sm text-red-600">{error}</p>}
                <button type="submit" disabled={loading}
                  className="w-full bg-indigo-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                  {loading ? 'Saving…' : 'Save & continue'}
                </button>
              </form>
            </>
          )}

          {/* Step 4: Done */}
          {step === 4 && (
            <div className="text-center py-4">
              <div className="text-5xl mb-4">✓</div>
              <h2 className="text-lg font-semibold mb-2">You're set up</h2>
              <p className="text-sm text-gray-500 mb-6">
                JellyRag is ready to start categorizing your transactions.
              </p>
              <button onClick={finish}
                className="bg-indigo-600 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700">
                Go to dashboard →
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { invokeFunction } from '../lib/butterbase-client';

export default function QBOCallback() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<'processing' | 'success' | 'error'>('processing');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const realmId = params.get('realmId');
    const state = params.get('state');
    const error = params.get('error');

    if (error) {
      setStatus('error');
      setMessage(params.get('error_description') ?? error);
      return;
    }

    if (!code || !realmId || !state) {
      setStatus('error');
      setMessage('Missing required parameters from QBO redirect.');
      return;
    }

    invokeFunction('qbo-oauth-callback', { code, realm_id: realmId, state })
      .then(() => {
        setStatus('success');
        setTimeout(() => navigate('/onboarding?step=2'), 1500);
      })
      .catch((err: Error) => {
        setStatus('error');
        setMessage(err.message);
      });
  }, [navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white rounded-xl border border-gray-200 p-8 max-w-sm w-full text-center">
        {status === 'processing' && (
          <>
            <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-gray-700 font-medium">Connecting QuickBooks…</p>
            <p className="text-sm text-gray-400 mt-1">Exchanging authorization code</p>
          </>
        )}
        {status === 'success' && (
          <>
            <p className="text-4xl mb-3">✓</p>
            <p className="text-gray-900 font-medium">QuickBooks connected</p>
            <p className="text-sm text-gray-400 mt-1">Redirecting you back…</p>
          </>
        )}
        {status === 'error' && (
          <>
            <p className="text-4xl mb-3">✗</p>
            <p className="text-gray-900 font-medium">Connection failed</p>
            <p className="text-sm text-red-500 mt-1">{message}</p>
            <button
              onClick={() => navigate('/onboarding')}
              className="mt-4 text-sm text-indigo-600 hover:underline"
            >
              Back to onboarding
            </button>
          </>
        )}
      </div>
    </div>
  );
}

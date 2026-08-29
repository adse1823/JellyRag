import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect, useState, ReactNode } from 'react';
import { butterbase } from './lib/butterbase-client';
import { OrgProvider, useOrg } from './lib/OrgContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import Onboarding from './pages/Onboarding';
import Dashboard from './pages/Dashboard';
import Review from './pages/Review';
import ReviewItemPage from './pages/ReviewItem';
import Transactions from './pages/Transactions';
import TransactionDetail from './pages/TransactionDetail';
import Reconciliation from './pages/Reconciliation';
import ReconciliationRun from './pages/ReconciliationRun';
import Audit from './pages/Audit';
import Settings from './pages/Settings';
import QBOCallback from './pages/QBOCallback';
import ShopifyCallback from './pages/ShopifyCallback';

function Spinner() {
  return (
    <div className="flex items-center justify-center h-screen bg-gray-50">
      <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

function AuthGate({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    (butterbase as any).auth.getUser().then(({ data }: { data: unknown }) => {
      setAuthed(!!data);
    });
    const { unsubscribe } = (butterbase as any).onAuthStateChange(
      (_e: string, session: { user: unknown } | null) => {
        setAuthed(!!session?.user);
      }
    );
    return unsubscribe;
  }, []);

  if (authed === null) return <Spinner />;
  if (!authed) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function OrgGate({ children }: { children: ReactNode }) {
  const { org, loading } = useOrg();
  if (loading) return <Spinner />;
  if (!org) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <OrgProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/auth/qbo/callback" element={<QBOCallback />} />
          <Route path="/auth/shopify/callback" element={<ShopifyCallback />} />
          <Route
            path="/onboarding"
            element={
              <AuthGate>
                <Onboarding />
              </AuthGate>
            }
          />
          <Route
            element={
              <AuthGate>
                <OrgGate>
                  <Layout />
                </OrgGate>
              </AuthGate>
            }
          >
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/review" element={<Review />} />
            <Route path="/review/:id" element={<ReviewItemPage />} />
            <Route path="/transactions" element={<Transactions />} />
            <Route path="/transactions/:id" element={<TransactionDetail />} />
            <Route path="/reconciliation" element={<Reconciliation />} />
            <Route path="/reconciliation/:id" element={<ReconciliationRun />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
        </Routes>
      </OrgProvider>
    </BrowserRouter>
  );
}

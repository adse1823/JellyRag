import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useOrg } from '../lib/OrgContext';
import { butterbase } from '../lib/butterbase-client';

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: '▦' },
  { to: '/review', label: 'Review', icon: '◈' },
  { to: '/transactions', label: 'Transactions', icon: '≡' },
  { to: '/reconciliation', label: 'Reconciliation', icon: '⊞' },
  { to: '/audit', label: 'Audit', icon: '◉' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

export default function Layout() {
  const { org, user } = useOrg();
  const navigate = useNavigate();

  async function signOut() {
    await (butterbase as any).auth.signOut();
    navigate('/login');
  }

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 bg-slate-900 flex flex-col">
        {/* Logo */}
        <div className="px-5 py-5 border-b border-slate-800">
          <span className="text-white font-semibold text-lg tracking-tight">JellyRag</span>
          {org && <p className="text-slate-400 text-xs mt-0.5 truncate">{org.name}</p>}
        </div>

        {/* Nav links */}
        <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
          {NAV.map(({ to, label, icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
                }`
              }
            >
              <span className="text-base w-4 text-center">{icon}</span>
              {label}
            </NavLink>
          ))}
        </nav>

        {/* User footer */}
        <div className="px-4 py-4 border-t border-slate-800">
          {user && (
            <p className="text-slate-500 text-xs truncate mb-2">{user.email}</p>
          )}
          <button
            onClick={signOut}
            className="text-slate-400 hover:text-white text-xs transition-colors"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}

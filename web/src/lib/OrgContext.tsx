import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { butterbase, Organization, BBUser, getCurrentOrg, getCurrentUser } from './butterbase-client';

interface OrgContextValue {
  org: Organization | null;
  user: BBUser | null;
  loading: boolean;
  reload: () => Promise<void>;
}

const OrgContext = createContext<OrgContextValue>({
  org: null,
  user: null,
  loading: true,
  reload: async () => {},
});

export function OrgProvider({ children }: { children: ReactNode }) {
  const [org, setOrg] = useState<Organization | null>(null);
  const [user, setUser] = useState<BBUser | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      const [u, o] = await Promise.all([getCurrentUser(), getCurrentOrg()]);
      setUser(u);
      setOrg(o);
    } catch {
      setOrg(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const { unsubscribe } = (butterbase as any).onAuthStateChange(
      (event: string, session: { user: BBUser } | null) => {
        if (event === 'SIGNED_IN' || event === 'SESSION_RESTORED' || event === 'TOKEN_REFRESHED') {
          if (session?.user) load();
          else { setOrg(null); setUser(null); setLoading(false); }
        } else if (event === 'SIGNED_OUT') {
          setOrg(null);
          setUser(null);
          setLoading(false);
        }
      }
    );
    load();
    return unsubscribe;
  }, []);

  return (
    <OrgContext.Provider value={{ org, user, loading, reload: load }}>
      {children}
    </OrgContext.Provider>
  );
}

export const useOrg = () => useContext(OrgContext);

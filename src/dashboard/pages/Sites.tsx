import { useCallback, useEffect, useState } from 'react';
import { navigate, useMe } from '../App';
import { Favicon } from '../components/Icons';
import { Logo } from '../components/Logo';
import { Modal } from '../components/Modal';
import { api, type Site } from '../lib/api';
import { fmtNumber } from '../lib/format';

export function Sites() {
  const { me } = useMe();
  const [sites, setSites] = useState<Site[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const s = await api<Site[]>('/api/sites');
      setSites(s);
      if (!s.length) setAdding(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Your websites could not be loaded.');
    }
  }, []);

  useEffect(() => void load(), [load]);

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    window.dispatchEvent(new Event('ml:logout'));
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:py-12">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Logo />
        <div className="flex items-center gap-2">
          {me.hosted && me.user && (
            <button className="hidden items-center gap-2 rounded-xl px-2 py-1 text-sm text-stone-600 hover:bg-stone-100 sm:flex" onClick={() => navigate('/billing')} title="Plan & billing">
              {me.user.avatar ? <img src={me.user.avatar} alt="" className="h-7 w-7 rounded-full" referrerPolicy="no-referrer" /> : null}
              {me.user.email}
            </button>
          )}
          <button className="btn" onClick={logout}>
            Log out
          </button>
          <button className="btn-dark" onClick={() => setAdding(true)}>
            + Add website
          </button>
        </div>
      </div>

      <h1 className="mt-10 text-2xl font-semibold">Your websites</h1>
      {error && (
        <div className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900" role="alert">
          <p>Your websites could not be loaded. {error}</p>
          <button className="btn mt-3" onClick={() => void load()}>Try again</button>
        </div>
      )}
      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {sites === null && !error && [1, 2, 3].map((item) => (
          <div key={item} className="card h-36 animate-pulse bg-stone-100 motion-reduce:animate-none" aria-hidden="true" />
        ))}
        {sites?.map((s) => (
          <button key={s.id} onClick={() => navigate(`/site/${s.id}`)} className="card p-5 text-left transition hover:-translate-y-0.5 hover:shadow-md">
            <div className="flex items-center gap-3">
              <Favicon domain={s.domain} size={28} />
              <div className="min-w-0">
                <div className="truncate font-semibold">{s.name}</div>
                <div className="truncate text-sm text-stone-500">{s.domain}</div>
              </div>
            </div>
            <div className="mt-5 flex items-end justify-between">
              <div>
                <div className="text-2xl font-semibold">{fmtNumber(s.visitors24h ?? 0)}</div>
                <div className="text-xs text-stone-500">visitors in the last 24h</div>
              </div>
              <div className="flex items-center gap-1.5 text-sm text-stone-600">
                <span className={`h-2 w-2 rounded-full ${s.online ? 'animate-pulse bg-green-500' : 'bg-stone-300'}`} />
                {s.online} online
              </div>
            </div>
          </button>
        ))}
        {sites && !sites.length && (
          <div className="card col-span-full p-10 text-center text-stone-500">No websites yet. Add your first one to get a tracking snippet.</div>
        )}
      </div>
      <AddSite open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}

const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD', 'SGD', 'JPY', 'BRL'];

function AddSite({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [domain, setDomain] = useState('');
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [currency, setCurrency] = useState('USD');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const site = await api<Site>('/api/sites', { method: 'POST', json: { domain, name, timezone, currency } });
      navigate(`/site/${site.id}/settings`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add a website" width="max-w-md">
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label" htmlFor="new-site-domain">Domain</label>
          <input id="new-site-domain" className="input" placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} autoFocus required />
          <p className="mt-1 text-xs text-stone-500">Subdomains (app.example.com) are tracked under the same site.</p>
        </div>
        <div>
          <label className="label" htmlFor="new-site-name">Website name</label>
          <input id="new-site-name" className="input" placeholder="Acme website" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="new-site-timezone">Timezone</label>
            <input id="new-site-timezone" className="input" value={timezone} onChange={(e) => setTimezone(e.target.value)} required />
          </div>
          <div>
            <label className="label" htmlFor="new-site-currency">Reporting currency</label>
            <select id="new-site-currency" className="input" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>
        {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
        <button className="btn-dark w-full" disabled={!domain || !timezone || saving}>
          {saving ? 'Adding website…' : 'Add website'}
        </button>
      </form>
    </Modal>
  );
}

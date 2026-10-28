import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { isReconnectError, type SearchConsoleProperty, type SearchConsoleStatus } from '../lib/searchConsole';

export function SearchConsoleSettings({ siteId }: { siteId: string }) {
  const [status, setStatus] = useState<SearchConsoleStatus | null>(null);
  const [properties, setProperties] = useState<SearchConsoleProperty[]>([]);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [reconnect, setReconnect] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setReconnect(false);
    try {
      const next = await api<SearchConsoleStatus>(`/api/sites/${siteId}/integrations/search-console/status`);
      setStatus(next);
      setSelected(next.property?.propertyUri ?? '');
      if (next.connected) {
        const result = await api<{ properties: SearchConsoleProperty[] }>(`/api/sites/${siteId}/integrations/search-console/properties`);
        setProperties(result.properties);
      } else {
        setProperties([]);
      }
    } catch (cause) {
      if (isReconnectError(cause)) setReconnect(true);
      else setError(cause instanceof Error ? cause.message : 'Search Console could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => void load(), [load]);

  const connect = () => window.location.assign(`/api/sites/${siteId}/integrations/search-console/oauth/start`);

  async function chooseProperty() {
    if (!selected) return;
    setSaving(true);
    setError('');
    try {
      const result = await api<{ property: SearchConsoleStatus['property'] }>(`/api/sites/${siteId}/integrations/search-console/property`, {
        method: 'PUT',
        json: { propertyUri: selected },
      });
      setStatus((current) => (current ? { ...current, property: result.property } : current));
    } catch (cause) {
      if (isReconnectError(cause)) setReconnect(true);
      else setError(cause instanceof ApiError ? cause.message : 'That property could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function disconnect() {
    if (!window.confirm('Disconnect Google Search Console from this website?')) return;
    setSaving(true);
    try {
      await api(`/api/sites/${siteId}/integrations/search-console`, { method: 'DELETE' });
      setStatus((current) => (current ? { ...current, connected: false, property: null } : current));
      setProperties([]);
      setReconnect(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Search Console could not be disconnected.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card p-6" aria-labelledby="search-console-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-xl">
          <h2 id="search-console-title" className="text-lg font-semibold">Google Search Console</h2>
          <p className="mt-1 text-sm text-stone-500">Add Google search clicks, visibility, queries, and landing pages to Performance.</p>
        </div>
        {status?.connected && !loading && (
          <button className="btn text-red-600" onClick={disconnect} disabled={saving}>Disconnect</button>
        )}
      </div>

      <div className="mt-5" aria-live="polite">
        {loading && <p className="text-sm text-stone-500">Checking connection…</p>}

        {!loading && reconnect && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
            <p className="font-medium text-amber-950">Reconnect to keep search data up to date</p>
            <p className="mt-1 text-sm text-amber-800">Google access has expired or was removed.</p>
            <button className="btn-dark mt-3" onClick={connect}>Reconnect Google</button>
          </div>
        )}

        {!loading && error && !reconnect && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4" role="alert">
            <p className="font-medium text-red-900">Search Console is unavailable</p>
            <p className="mt-1 text-sm text-red-700">{error}</p>
            <button className="btn mt-3" onClick={load}>Try again</button>
          </div>
        )}

        {!loading && !error && !reconnect && !status?.connected && (
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl bg-stone-50 p-4">
            <div>
              <p className="font-medium">Not connected</p>
              <p className="mt-1 text-sm text-stone-500">Connect the Google account that can view this website in Search Console.</p>
              {!status?.configured && <p className="mt-2 text-xs text-stone-500">Your Vysta administrator still needs to enable this connection.</p>}
            </div>
            <button className="btn-dark" onClick={connect} disabled={!status?.configured}>Connect Google</button>
          </div>
        )}

        {!loading && !error && !reconnect && status?.connected && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm text-emerald-700">
              <span aria-hidden="true">●</span>
              <span>{status.property ? 'Connected and ready' : 'Connected — choose a website property'}</span>
            </div>
            {properties.length > 0 ? (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="min-w-0 flex-1">
                  <label className="label" htmlFor="search-console-property">Website property</label>
                  <select id="search-console-property" className="input" value={selected} onChange={(event) => setSelected(event.target.value)}>
                    <option value="">Choose a property</option>
                    {properties.map((property) => <option key={property.propertyUri} value={property.propertyUri}>{property.propertyUri}</option>)}
                  </select>
                </div>
                <button className="btn-dark sm:mb-px" onClick={chooseProperty} disabled={!selected || saving}>
                  {saving ? 'Saving…' : status.property ? 'Save property' : 'Use this property'}
                </button>
              </div>
            ) : (
              <p className="text-sm text-stone-500">No Search Console properties were found for this Google account.</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

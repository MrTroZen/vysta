import { useCallback, useEffect, useState } from 'react';
import type { TrackingHealth as TrackingHealthData, HealthWarning } from '../../worker/trackingHealth';
import { api } from '../lib/api';
import { browserHealthState, serverGoalHealthState, warningCopy, type HealthState } from '../lib/trackingHealth';

const badgeClasses = {
  good: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  neutral: 'border-stone-200 bg-stone-50 text-stone-700',
  warning: 'border-amber-200 bg-amber-50 text-amber-900',
} as const;

function Status({ state }: { state: HealthState }) {
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${badgeClasses[state.tone]}`}>{state.label}</span>;
}

function Seen({ value }: { value: number | null }) {
  if (!value) return <>Never</>;
  const minutes = (value - Date.now()) / 60_000;
  const [amount, unit] = Math.abs(minutes) < 60
    ? [Math.round(minutes), 'minute' as const]
    : Math.abs(minutes) < 24 * 60
      ? [Math.round(minutes / 60), 'hour' as const]
      : [Math.round(minutes / (24 * 60)), 'day' as const];
  return (
    <time dateTime={new Date(value).toISOString()} title={new Date(value).toLocaleString()}>
      {new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(amount, unit)}
    </time>
  );
}

function Metric({ label, value, help }: { label: string; value: number; help?: string }) {
  return (
    <div className="rounded-xl border border-stone-200/80 bg-stone-50/70 p-3">
      <div className="text-xl font-semibold text-ink">{value.toLocaleString()}</div>
      <div className="mt-0.5 text-xs font-medium text-stone-700">{label}</div>
      {help && <div className="mt-1 text-xs leading-relaxed text-stone-500">{help}</div>}
    </div>
  );
}

function WarningDetails({ source, warnings }: { source: 'browser' | 'server_goal'; warnings: HealthWarning[] }) {
  if (!warnings.length) return null;
  return (
    <details className="mt-4 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-sm">
      <summary className="cursor-pointer font-medium text-amber-950">Why some requests need attention</summary>
      <ul className="mt-3 space-y-3 text-amber-950">
        {warnings.map((warning) => (
          <li key={warning.code}>
            <div>{warningCopy(source, warning.code)} ({warning.count.toLocaleString()})</div>
            <div className="mt-1 text-xs text-amber-800">
              Technical reason: <code>{warning.code}</code>
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}

function LoadingHealth() {
  return (
    <section className="card p-6" aria-busy="true" aria-label="Checking tracking health">
      <div className="h-6 w-40 animate-pulse rounded bg-stone-200 motion-reduce:animate-none" />
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="h-36 animate-pulse rounded-xl bg-stone-100 motion-reduce:animate-none" />
        <div className="h-36 animate-pulse rounded-xl bg-stone-100 motion-reduce:animate-none" />
      </div>
    </section>
  );
}

export function TrackingHealth({ siteId }: { siteId: string }) {
  const [health, setHealth] = useState<TrackingHealthData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setHealth(await api<TrackingHealthData>(`/api/sites/${siteId}/tracking-health`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !health) return <LoadingHealth />;
  if (!health) {
    return (
      <section className="card p-6" aria-labelledby="tracking-health-title">
        <h2 id="tracking-health-title" className="text-lg font-semibold">Tracking health</h2>
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900" role="alert">
          <p>Tracking health could not be checked. {error}</p>
          <button className="btn mt-3" onClick={() => void load()}>Try again</button>
        </div>
      </section>
    );
  }

  const browserState = browserHealthState(health.browser);
  const serverState = serverGoalHealthState(health.serverGoals);
  return (
    <section className="card p-6" aria-labelledby="tracking-health-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="tracking-health-title" className="text-lg font-semibold">Tracking health</h2>
          <p className="mt-1 max-w-2xl text-sm text-stone-500">
            Recent request diagnostics are kept as hourly totals for 30 days. They do not store rejected request bodies.
          </p>
        </div>
        <button className="btn" disabled={loading} onClick={() => void load()}>{loading ? 'Checking…' : 'Refresh'}</button>
      </div>

      {error && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900" role="alert">
          Tracking health could not be refreshed. {error}
        </div>
      )}

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <article className="rounded-2xl border border-stone-200 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">Website tracking</h3>
            <Status state={browserState} />
          </div>
          <p className="mt-2 text-sm leading-relaxed text-stone-600">{browserState.message}</p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Metric label="Tracking requests" value={health.browser.requests24h} help="All recent tracker calls, including pings and retries." />
            <Metric label="Analytics events recorded" value={health.browser.analyticsEvents24h} help="Page views, goals, and outbound clicks added to reports." />
          </div>
          <dl className="mt-4 grid gap-2 text-sm text-stone-600 sm:grid-cols-2">
            <div><dt className="inline font-medium text-stone-800">Last request:</dt> <dd className="inline"><Seen value={health.browser.lastRequestAt} /></dd></div>
            <div><dt className="inline font-medium text-stone-800">Last event:</dt> <dd className="inline"><Seen value={health.browser.lastEventAt} /></dd></div>
            {health.browser.lastHostname && <div className="sm:col-span-2"><dt className="inline font-medium text-stone-800">Last hostname:</dt> <dd className="inline break-all">{health.browser.lastHostname}</dd></div>}
          </dl>
          <WarningDetails source="browser" warnings={health.browser.warningReasons} />
        </article>

        <article className="rounded-2xl border border-stone-200 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">Server-side goals</h3>
            <Status state={serverState} />
          </div>
          <p className="mt-2 text-sm leading-relaxed text-stone-600">{serverState.message}</p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Metric label="Goal requests" value={health.serverGoals.requests24h} help="Recent calls to the server-side goals API." />
            <Metric label="Goals recorded" value={health.serverGoals.recorded24h} help="New goals added to analytics reports." />
          </div>
          <dl className="mt-4 grid gap-2 text-sm text-stone-600 sm:grid-cols-2">
            <div><dt className="inline font-medium text-stone-800">Last request:</dt> <dd className="inline"><Seen value={health.serverGoals.lastRequestAt} /></dd></div>
            <div><dt className="inline font-medium text-stone-800">Last goal:</dt> <dd className="inline"><Seen value={health.serverGoals.lastEventAt} /></dd></div>
            {health.serverGoals.duplicates24h > 0 && <div className="sm:col-span-2"><dt className="inline font-medium text-stone-800">Safe retries:</dt> <dd className="inline">{health.serverGoals.duplicates24h.toLocaleString()}</dd></div>}
          </dl>
          <WarningDetails source="server_goal" warnings={health.serverGoals.warningReasons} />
        </article>
      </div>
      <p className="mt-4 text-xs leading-relaxed text-stone-500">
        “Working” means Vysta recently received valid data for this site. It does not prove the tracker is installed on every page.
      </p>
    </section>
  );
}

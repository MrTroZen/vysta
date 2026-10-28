import { useEffect, useState, type ReactNode } from 'react';
import { actionLabel, AUTOMATIC_ACTIONS } from '../../shared/actions';
import { navigate } from '../App';
import { Favicon } from '../components/Icons';
import { InsightsPanel } from '../components/InsightsPanel';
import { PERIODS } from '../components/Toolbar';
import { qs, type BreakdownRow, type Overview, type Site } from '../lib/api';
import { buildInsights } from '../lib/insights';
import { loadSearchConsolePerformance, searchConsoleDates, searchConsoleViewForStatus, type SearchConsoleStatus, type SearchConsoleView } from '../lib/searchConsole';
import { useApi } from '../lib/useApi';
import { useQueryState } from '../lib/useQueryState';

function changeLabel(current: number, previous: number) {
  if (current === previous) return 'No change';
  if (previous === 0) return current > 0 ? 'New this period' : 'No change';
  const change = ((current - previous) / previous) * 100;
  return `${change > 0 ? '+' : ''}${change.toFixed(Math.abs(change) >= 10 ? 0 : 1)}%`;
}

function MetricCard({ label, current, previous }: { label: string; current: number; previous: number }) {
  return <article className="card p-5"><p className="text-sm font-medium text-stone-500">{label}</p><p className="mt-2 text-3xl font-semibold tracking-tight">{current.toLocaleString()}</p><p className="mt-2 text-xs text-stone-500"><span className="font-medium text-stone-700">{changeLabel(current, previous)}</span> from the previous period</p></article>;
}

function ListCard({ title, description, rows, kind }: { title: string; description: string; rows: BreakdownRow[] | null; kind: 'source' | 'page' | 'goal' | 'outcome' }) {
  return <section className="card min-w-0 p-5"><h2 className="text-lg font-semibold">{title}</h2><p className="mt-1 text-sm text-stone-500">{description}</p>{!rows ? <div className="mt-5 space-y-3" aria-label={`Loading ${title}`}>{[1, 2, 3].map((item) => <div key={item} className="h-10 animate-pulse rounded-xl bg-stone-100" />)}</div> : rows.length === 0 ? <p className="mt-6 rounded-xl bg-stone-50 p-4 text-sm text-stone-500">No {kind === 'goal' ? 'actions' : kind === 'outcome' ? 'confirmed outcomes' : kind === 'page' ? 'pages' : 'traffic sources'} in this period.</p> : <div className="mt-4 overflow-x-auto" role="region" aria-label={title} tabIndex={0}><table className="w-full min-w-[360px] text-sm"><thead className="text-left text-xs uppercase tracking-wide text-stone-400"><tr><th className="pb-2 font-medium">{kind === 'goal' ? 'Action' : kind === 'outcome' ? 'Outcome' : kind === 'page' ? 'Page' : 'Source'}</th><th className="pb-2 text-right font-medium">Visitors</th>{kind !== 'source' && <th className="pb-2 text-right font-medium">{kind === 'goal' ? 'Times' : kind === 'outcome' ? 'Completions' : 'Views'}</th>}</tr></thead><tbody>{rows.slice(0, 8).map((row, index) => <tr key={`${row.label}-${index}`} className="border-t border-stone-100"><th scope="row" className="max-w-[20rem] py-3 pr-4 text-left font-medium"><span className="block truncate" title={row.label ?? undefined}>{kind === 'goal' ? actionLabel(row.label) : row.label || (kind === 'source' ? 'Direct / unknown' : 'Untitled')}</span></th><td className="py-3 text-right tabular-nums">{row.visitors.toLocaleString()}</td>{kind !== 'source' && <td className="py-3 text-right tabular-nums">{(row.pageviews ?? 0).toLocaleString()}</td>}</tr>)}</tbody></table></div>}</section>;
}

function OutcomePages({ rows }: { rows: BreakdownRow[] | null }) {
  return <section className="card min-w-0 p-5"><h2 className="text-lg font-semibold">Pages producing confirmed outcomes</h2><p className="mt-1 text-sm text-stone-500">Success and confirmation pages that completed your configured goals.</p>{!rows ? <div className="mt-5 h-28 animate-pulse rounded-xl bg-stone-100" /> : rows.length === 0 ? <p className="mt-5 rounded-xl bg-stone-50 p-4 text-sm text-stone-500">No confirmed outcomes in this period.</p> : <div className="mt-4 overflow-x-auto" role="region" aria-label="Pages producing confirmed outcomes" tabIndex={0}><table className="w-full min-w-[520px] text-sm"><thead className="text-left text-xs uppercase tracking-wide text-stone-400"><tr><th className="pb-2 font-medium">Outcome</th><th className="pb-2 font-medium">Page</th><th className="pb-2 text-right font-medium">People</th><th className="pb-2 text-right font-medium">Completions</th></tr></thead><tbody>{rows.map((row, index) => <tr key={`${row.label}-${row.extra}-${index}`} className="border-t border-stone-100"><th scope="row" className="py-3 pr-4 text-left font-medium">{row.label}</th><td className="max-w-[24rem] py-3 pr-4"><span className="block truncate" title={row.extra ?? undefined}>{row.extra || '/'}</span></td><td className="py-3 text-right tabular-nums">{row.visitors.toLocaleString()}</td><td className="py-3 text-right tabular-nums">{(row.pageviews ?? 0).toLocaleString()}</td></tr>)}</tbody></table></div>}</section>;
}

function AutomaticActionSummary({ rows }: { rows: BreakdownRow[] | null }) {
  const actions = [
    { name: AUTOMATIC_ACTIONS.phone, label: 'Phone intent' },
    { name: AUTOMATIC_ACTIONS.whatsapp, label: 'WhatsApp intent' },
    { name: AUTOMATIC_ACTIONS.email, label: 'Email intent' },
    { name: AUTOMATIC_ACTIONS.form, label: 'Form intent' },
  ];
  return <section className="card p-5" aria-labelledby="lead-actions-title"><h2 id="lead-actions-title" className="text-lg font-semibold">Contact actions</h2><p className="mt-1 text-sm text-stone-500">Intent signals only—not confirmed calls, conversations, submissions received, or business outcomes.</p><dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{actions.map((action) => { const row = rows?.find((item) => item.label === action.name); return <div key={action.name} className="rounded-xl bg-stone-50 p-4"><dt className="text-sm font-medium text-stone-600">{action.label}</dt><dd className="mt-2 text-2xl font-semibold">{rows ? (row?.visitors ?? 0).toLocaleString() : '—'}</dd><dd className="mt-1 text-xs text-stone-500">people · {rows ? (row?.pageviews ?? 0).toLocaleString() : '—'} actions</dd></div>; })}</dl></section>;
}

function ActionPages({ rows }: { rows: BreakdownRow[] | null }) {
  return <section className="card min-w-0 p-5"><h2 className="text-lg font-semibold">Pages generating actions</h2><p className="mt-1 text-sm text-stone-500">See where contact intent and configured actions happened.</p>{!rows ? <div className="mt-5 h-28 animate-pulse rounded-xl bg-stone-100" /> : rows.length === 0 ? <p className="mt-5 rounded-xl bg-stone-50 p-4 text-sm text-stone-500">No actions in this period.</p> : <div className="mt-4 overflow-x-auto" role="region" aria-label="Pages generating actions" tabIndex={0}><table className="w-full min-w-[520px] text-sm"><thead className="text-left text-xs uppercase tracking-wide text-stone-400"><tr><th className="pb-2 font-medium">Action</th><th className="pb-2 font-medium">Page</th><th className="pb-2 text-right font-medium">People</th><th className="pb-2 text-right font-medium">Times</th></tr></thead><tbody>{rows.map((row, index) => <tr key={`${row.label}-${row.extra}-${index}`} className="border-t border-stone-100"><th scope="row" className="py-3 pr-4 text-left font-medium">{actionLabel(row.label)}</th><td className="max-w-[24rem] py-3 pr-4"><span className="block truncate" title={row.extra ?? undefined}>{row.extra || '/'}</span></td><td className="py-3 text-right tabular-nums">{row.visitors.toLocaleString()}</td><td className="py-3 text-right tabular-nums">{(row.pageviews ?? 0).toLocaleString()}</td></tr>)}</tbody></table></div>}</section>;
}

function SearchMetric({ label, value, suffix = '' }: { label: string; value: string; suffix?: string }) {
  return <div className="rounded-xl bg-stone-50 p-4"><dt className="text-xs font-medium uppercase tracking-wide text-stone-500">{label}</dt><dd className="mt-1 text-xl font-semibold">{value}{suffix}</dd></div>;
}

function SearchList({ title, rows, dimension }: { title: string; rows: Extract<SearchConsoleView, { state: 'ready' }>['queries']; dimension: 'query' | 'page' }) {
  return <div className="min-w-0"><h3 className="font-semibold">{title}</h3><div className="mt-2 overflow-x-auto" role="region" aria-label={title} tabIndex={0}><table className="w-full min-w-[360px] text-sm"><thead className="text-left text-xs uppercase tracking-wide text-stone-400"><tr><th className="pb-2 font-medium">{dimension === 'query' ? 'Search' : 'Page'}</th><th className="pb-2 text-right font-medium">Clicks</th><th className="pb-2 text-right font-medium">Views</th></tr></thead><tbody>{rows.map((row, index) => <tr key={`${row.dimensions[dimension]}-${index}`} className="border-t border-stone-100"><th scope="row" className="max-w-[20rem] py-3 pr-4 text-left font-medium"><span className="block truncate" title={row.dimensions[dimension]}>{row.dimensions[dimension] || 'Unknown'}</span></th><td className="py-3 text-right tabular-nums">{row.clicks.toLocaleString()}</td><td className="py-3 text-right tabular-nums">{row.impressions.toLocaleString()}</td></tr>)}</tbody></table></div></div>;
}

function SearchConsoleSection({ view, siteId, retry }: { view: SearchConsoleView; siteId: string; retry: () => void }) {
  let content: ReactNode;
  if (view.state === 'loading') content = <div className="h-20 animate-pulse rounded-xl bg-stone-100" aria-label="Loading Google Search" />;
  else if (view.state === 'not-connected') content = <div className="rounded-xl bg-stone-50 p-4"><p className="font-medium">See how people find you on Google</p><p className="mt-1 text-sm text-stone-500">Connect Search Console to add clicks, visibility, searches, and top search pages.</p><button className="btn-dark mt-3" onClick={() => navigate(`/site/${siteId}/settings`)}>Connect in Settings</button></div>;
  else if (view.state === 'needs-property') content = <div className="rounded-xl bg-stone-50 p-4"><p className="font-medium">Choose your website property</p><p className="mt-1 text-sm text-stone-500">Your Google account is connected. Select the website you want to report on.</p><button className="btn mt-3" onClick={() => navigate(`/site/${siteId}/settings`)}>Choose property</button></div>;
  else if (view.state === 'reconnect') content = <div className="rounded-xl border border-amber-200 bg-amber-50 p-4"><p className="font-medium text-amber-950">Reconnect Google Search Console</p><p className="mt-1 text-sm text-amber-800">Google access needs to be renewed before search data can update.</p><button className="btn-dark mt-3" onClick={() => navigate(`/site/${siteId}/settings`)}>Reconnect in Settings</button></div>;
  else if (view.state === 'error') content = <div className="rounded-xl border border-red-200 bg-red-50 p-4" role="alert"><p className="font-medium text-red-900">Google Search data is unavailable</p><p className="mt-1 text-sm text-red-700">Your Vysta performance data is still available above.</p><button className="btn mt-3" onClick={retry}>Try again</button></div>;
  else if (view.state === 'empty') content = <div className="rounded-xl bg-stone-50 p-4"><p className="font-medium">No Google Search data for this period</p><p className="mt-1 text-sm text-stone-500">Try a longer date range or check again after Search Console has collected data.</p></div>;
  else content = <><dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><SearchMetric label="Clicks" value={view.summary.clicks.toLocaleString()} /><SearchMetric label="Impressions" value={view.summary.impressions.toLocaleString()} /><SearchMetric label="Click-through rate" value={(view.summary.ctr * 100).toFixed(1)} suffix="%" /><SearchMetric label="Average position" value={view.summary.position.toFixed(1)} /></dl><div className="mt-6 grid gap-6 lg:grid-cols-2"><SearchList title="Top searches" rows={view.queries} dimension="query" /><SearchList title="Top search pages" rows={view.pages} dimension="page" /></div></>;
  return <section className="card p-5"><div className="mb-4"><h2 className="text-lg font-semibold">Google Search</h2><p className="mt-1 text-sm text-stone-500">Organic search performance from Google Search Console.</p></div>{content}</section>;
}

export function Performance({ siteId }: { siteId: string }) {
  const [q, update] = useQueryState();
  const [reloadKey, setReloadKey] = useState(0);
  const { data: sites } = useApi<Site[]>('/api/sites');
  const site = sites?.find((candidate) => candidate.id === siteId);
  const { data: overview, error: overviewError, loading } = useApi<Overview>(site ? `/api/sites/${siteId}/overview?${qs(q)}` : null, reloadKey);
  const sourcesRequest = useApi<BreakdownRow[]>(site ? `/api/sites/${siteId}/breakdown?${qs(q, { dim: 'source', limit: 100 })}` : null, reloadKey);
  const pagesRequest = useApi<BreakdownRow[]>(site ? `/api/sites/${siteId}/breakdown?${qs(q, { dim: 'page', limit: 100 })}` : null, reloadKey);
  const actionsRequest = useApi<BreakdownRow[]>(site ? `/api/sites/${siteId}/breakdown?${qs(q, { dim: 'goal', limit: 100 })}` : null, reloadKey);
  const actionPagesRequest = useApi<BreakdownRow[]>(site ? `/api/sites/${siteId}/breakdown?${qs(q, { dim: 'action_page', limit: 100 })}` : null, reloadKey);
  const outcomesRequest = useApi<BreakdownRow[]>(site ? `/api/sites/${siteId}/breakdown?${qs(q, { dim: 'outcome', limit: 100 })}` : null, reloadKey);
  const outcomePagesRequest = useApi<BreakdownRow[]>(site ? `/api/sites/${siteId}/breakdown?${qs(q, { dim: 'outcome_page', limit: 100 })}` : null, reloadKey);
  const previousSourcesRequest = useApi<BreakdownRow[]>(site ? `/api/sites/${siteId}/breakdown?${qs(q, { dim: 'source', limit: 100, compare: 'previous' })}` : null, reloadKey);
  const previousPagesRequest = useApi<BreakdownRow[]>(site ? `/api/sites/${siteId}/breakdown?${qs(q, { dim: 'page', limit: 100, compare: 'previous' })}` : null, reloadKey);
  const previousActionsRequest = useApi<BreakdownRow[]>(site ? `/api/sites/${siteId}/breakdown?${qs(q, { dim: 'goal', limit: 100, compare: 'previous' })}` : null, reloadKey);
  const previousActionPagesRequest = useApi<BreakdownRow[]>(site ? `/api/sites/${siteId}/breakdown?${qs(q, { dim: 'action_page', limit: 100, compare: 'previous' })}` : null, reloadKey);
  const sources = sourcesRequest.data;
  const pages = pagesRequest.data;
  const actions = actionsRequest.data;
  const actionPages = actionPagesRequest.data;
  const outcomes = outcomesRequest.data;
  const outcomePages = outcomePagesRequest.data;
  const { data: searchStatus, error: searchStatusError } = useApi<SearchConsoleStatus>(site ? `/api/sites/${siteId}/integrations/search-console/status` : null, reloadKey);
  const [searchView, setSearchView] = useState<SearchConsoleView>({ state: 'loading' });

  useEffect(() => {
    const initial = searchConsoleViewForStatus(searchStatus, searchStatusError);
    if (initial.state !== 'loading' || !searchStatus) return setSearchView(initial);
    if (!overview || !site) return;
    let active = true;
    setSearchView({ state: 'loading' });
    loadSearchConsolePerformance(siteId, searchConsoleDates(overview.range, site.timezone)).then((result) => active && setSearchView(result));
    return () => { active = false; };
  }, [searchStatus, searchStatusError, overview, site, siteId, reloadKey]);

  if (sites && !site) return <div className="p-10 text-center">Website not found. <button className="underline" onClick={() => navigate('/')}>Back to websites</button></div>;
  if (!site) return null;
  const retry = () => setReloadKey((key) => key + 1);
  const insightRequests = [sourcesRequest, pagesRequest, actionsRequest, actionPagesRequest, previousSourcesRequest, previousPagesRequest, previousActionsRequest, previousActionPagesRequest];
  const insightDataReady = Boolean(overview) && insightRequests.every((request) => request.data !== null || request.error !== null);
  const insights = insightDataReady && overview ? buildInsights({
    current: overview.current,
    previous: overview.previous,
    sources: sources !== null && previousSourcesRequest.data !== null ? { current: sources, previous: previousSourcesRequest.data } : { current: [], previous: [] },
    pages: pages !== null && previousPagesRequest.data !== null ? { current: pages, previous: previousPagesRequest.data } : { current: [], previous: [] },
    actions: actions !== null && previousActionsRequest.data !== null ? { current: actions, previous: previousActionsRequest.data } : { current: [], previous: [] },
    actionPages: actionPages !== null && previousActionPagesRequest.data !== null ? { current: actionPages, previous: previousActionPagesRequest.data } : { current: [], previous: [] },
  }) : null;

  return <main className="mx-auto max-w-[1280px] px-4 py-6 sm:px-6 lg:py-10"><header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2 text-sm text-stone-500"><Favicon domain={site.domain} size={18} /> {site.name}</div><h1 className="mt-1 text-3xl font-semibold tracking-tight">Performance</h1><p className="mt-1 text-sm text-stone-500">A clear view of visits, interest, and the actions people take.</p></div><nav className="flex flex-wrap gap-2" aria-label="Website"><button className="btn" onClick={() => navigate(`/site/${siteId}`)}>Dashboard</button><button className="btn" onClick={() => navigate(`/site/${siteId}/settings`)}>Settings</button></nav></header><div className="mt-6 flex flex-wrap items-end justify-between gap-3"><div className="flex flex-wrap items-end gap-2"><div><label className="label" htmlFor="performance-period">Date range</label><select id="performance-period" className="input min-w-[12rem]" value={q.period} onChange={(event) => update({ period: event.target.value, granularity: undefined })}>{PERIODS.filter((period) => period.value !== 'all').map((period) => <option key={period.value} value={period.value}>{period.label}</option>)}<option value="custom">Custom dates</option></select></div>{q.period === 'custom' && <><div><label className="label" htmlFor="performance-from">From</label><input id="performance-from" className="input" type="date" value={q.from ?? ''} onChange={(event) => update({ from: event.target.value })} /></div><div><label className="label" htmlFor="performance-to">To</label><input id="performance-to" className="input" type="date" value={q.to ?? ''} onChange={(event) => update({ to: event.target.value })} /></div></>}</div><div className="flex items-center gap-3"><p className="text-sm text-stone-500">Compared with the previous matching period</p><button className="btn" onClick={retry} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button></div></div>{overviewError && <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4" role="alert"><p className="font-medium text-red-900">Performance could not be loaded</p><p className="mt-1 text-sm text-red-700">{overviewError}</p><button className="btn mt-3" onClick={retry}>Try again</button></div>}<section className="mt-6" aria-labelledby="summary-title"><h2 id="summary-title" className="sr-only">Performance summary</h2>{overview ? <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5"><MetricCard label="Visitors" current={overview.current.visitors} previous={overview.previous.visitors} /><MetricCard label="Pageviews" current={overview.current.pageviews} previous={overview.previous.pageviews} /><MetricCard label="Intent & actions" current={overview.current.actions} previous={overview.previous.actions} /><MetricCard label="Confirmed outcomes" current={overview.current.outcomes} previous={overview.previous.outcomes} /><MetricCard label="Customers" current={overview.current.customers} previous={overview.previous.customers} /></div> : <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Loading performance summary">{[1, 2, 3, 4].map((item) => <div key={item} className="card h-36 animate-pulse bg-stone-100" />)}</div>}</section><div className="mt-5"><InsightsPanel insights={insights} /></div><div className="mt-5"><AutomaticActionSummary rows={actions} /></div><div className="mt-5 grid gap-5 lg:grid-cols-2"><ListCard title="Where visitors came from" description="Traffic sources ranked by visitors." rows={sources} kind="source" /><ListCard title="Best pages" description="Pages that attracted the most visitors." rows={pages} kind="page" /></div><div className="mt-5"><ListCard title="All actions" description="Automatic intent signals and other actions you configured." rows={actions} kind="goal" /></div><div className="mt-5 grid gap-5 lg:grid-cols-2"><ListCard title="Confirmed outcomes" description="Completed success and confirmation goals, kept separate from intent signals." rows={outcomes} kind="outcome" /><OutcomePages rows={outcomePages} /></div><div className="mt-5"><ActionPages rows={actionPages} /></div><div className="mt-5"><SearchConsoleSection view={searchView} siteId={siteId} retry={retry} /></div><p className="mt-8 text-center text-xs text-stone-400">Dates use {site.timezone}. Google Search may take a few days to finalize.</p></main>;
}

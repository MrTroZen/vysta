import { ApiError, api } from './api';

export interface SearchConsoleStatus {
  configured: boolean;
  connected: boolean;
  property: { propertyUri: string; permissionLevel: string | null } | null;
  connectedAt: number | null;
  updatedAt: number | null;
}

export interface SearchConsoleProperty {
  propertyUri: string;
  permissionLevel: string;
}

export interface SearchConsolePerformance {
  source: 'google-search-console';
  propertyUri: string;
  startDate: string;
  endDate: string;
  dimensions: Array<'date' | 'query' | 'page' | 'device'>;
  totals: { clicks: number; impressions: number; ctr: number; position: number };
  rows: Array<{
    dimensions: { date?: string; query?: string; page?: string; device?: string };
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
  nextStartRow: number | null;
  incompleteFrom: string | null;
}

export type SearchConsoleView =
  | { state: 'not-connected' }
  | { state: 'needs-property' }
  | { state: 'loading' }
  | { state: 'reconnect' }
  | { state: 'error'; message: string }
  | { state: 'empty'; propertyUri: string }
  | {
      state: 'ready';
      propertyUri: string;
      summary: SearchConsolePerformance['totals'];
      queries: SearchConsolePerformance['rows'];
      pages: SearchConsolePerformance['rows'];
    };

function localDate(at: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(at));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/** Convert the Vysta half-open report range to Search Console's inclusive local calendar dates. */
export function searchConsoleDates(range: { from: number; to: number }, timezone: string) {
  return { startDate: localDate(range.from, timezone), endDate: localDate(Math.max(range.from, range.to - 1), timezone) };
}

export function isReconnectError(error: unknown) {
  return error instanceof ApiError && error.code === 'search_console_reconnect_required';
}

export function searchConsoleViewForStatus(status: SearchConsoleStatus | null, error?: string | null): SearchConsoleView {
  if (error) return { state: 'error', message: error };
  if (!status) return { state: 'loading' };
  if (!status.connected) return { state: 'not-connected' };
  if (!status.property) return { state: 'needs-property' };
  return { state: 'loading' };
}

export async function loadSearchConsolePerformance(
  siteId: string,
  dates: { startDate: string; endDate: string },
  request: typeof api = api,
): Promise<SearchConsoleView> {
  const base = `/api/sites/${siteId}/integrations/search-console/performance`;
  const query = (dimensions?: 'query' | 'page') => {
    const params = new URLSearchParams({ ...dates });
    if (dimensions) {
      params.set('dimensions', dimensions);
      params.set('rowLimit', '10');
    }
    return request<SearchConsolePerformance>(`${base}?${params}`);
  };

  try {
    const [summary, queries, pages] = await Promise.all([query(), query('query'), query('page')]);
    const hasData = summary.totals.clicks > 0 || summary.totals.impressions > 0 || queries.rows.length > 0 || pages.rows.length > 0;
    if (!hasData) return { state: 'empty', propertyUri: summary.propertyUri };
    return {
      state: 'ready',
      propertyUri: summary.propertyUri,
      summary: summary.totals,
      queries: queries.rows,
      pages: pages.rows,
    };
  } catch (error) {
    if (isReconnectError(error)) return { state: 'reconnect' };
    return { state: 'error', message: error instanceof Error ? error.message : 'Google Search data is unavailable right now.' };
  }
}

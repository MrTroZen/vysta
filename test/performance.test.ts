import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/dashboard/lib/api';
import { loadSearchConsolePerformance, searchConsoleDates, searchConsoleViewForStatus, type SearchConsolePerformance } from '../src/dashboard/lib/searchConsole';

function response(dimensions: SearchConsolePerformance['dimensions'], rows: SearchConsolePerformance['rows'] = [], totals = { clicks: 12, impressions: 300, ctr: 0.04, position: 5.2 }): SearchConsolePerformance {
  return {
    source: 'google-search-console',
    propertyUri: 'sc-domain:example.com',
    startDate: '2026-03-29',
    endDate: '2026-03-29',
    dimensions,
    totals,
    rows,
    nextStartRow: null,
    incompleteFrom: null,
  };
}

describe('Performance v1 composition', () => {
  it('maps connection status to loading, not-connected, and property-required UI states', () => {
    expect(searchConsoleViewForStatus(null)).toEqual({ state: 'loading' });
    expect(searchConsoleViewForStatus(null, 'Status failed')).toEqual({ state: 'error', message: 'Status failed' });
    expect(searchConsoleViewForStatus({ configured: true, connected: false, property: null, connectedAt: null, updatedAt: null })).toEqual({ state: 'not-connected' });
    expect(searchConsoleViewForStatus({ configured: true, connected: true, property: null, connectedAt: 1, updatedAt: 1 })).toEqual({ state: 'needs-property' });
  });

  it('turns half-open Vysta ranges into inclusive site-local Search Console dates across DST', () => {
    expect(searchConsoleDates({ from: Date.UTC(2026, 2, 29, 0), to: Date.UTC(2026, 2, 29, 23) }, 'Europe/London')).toEqual({
      startDate: '2026-03-29',
      endDate: '2026-03-29',
    });
    expect(searchConsoleDates({ from: Date.UTC(2026, 4, 31, 18), to: Date.UTC(2026, 5, 1, 18) }, 'Asia/Dhaka')).toEqual({
      startDate: '2026-06-01',
      endDate: '2026-06-01',
    });
  });

  it('loads summary, top queries, and top pages from mocked API responses', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response(['query'], [{ dimensions: { query: 'best tea' }, clicks: 8, impressions: 100, ctr: 0.08, position: 2 }]))
      .mockResolvedValueOnce(response(['page'], [{ dimensions: { page: 'https://example.com/tea' }, clicks: 6, impressions: 90, ctr: 0.067, position: 3 }]));

    await expect(loadSearchConsolePerformance('site-a', { startDate: '2026-03-29', endDate: '2026-03-29' }, request as never)).resolves.toMatchObject({
      state: 'ready',
      summary: { clicks: 12, impressions: 300 },
      queries: [{ dimensions: { query: 'best tea' } }],
      pages: [{ dimensions: { page: 'https://example.com/tea' } }],
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      '/api/sites/site-a/integrations/search-console/performance?startDate=2026-03-29&endDate=2026-03-29',
      '/api/sites/site-a/integrations/search-console/performance?startDate=2026-03-29&endDate=2026-03-29&dimensions=query&rowLimit=10',
      '/api/sites/site-a/integrations/search-console/performance?startDate=2026-03-29&endDate=2026-03-29&dimensions=page&rowLimit=10',
    ]);
  });

  it('maps no data, reconnect-required, and upstream failures to owner-facing states', async () => {
    const empty = vi.fn().mockResolvedValue(response([], [], { clicks: 0, impressions: 0, ctr: 0, position: 0 }));
    await expect(loadSearchConsolePerformance('site-a', { startDate: '2026-03-29', endDate: '2026-03-29' }, empty as never)).resolves.toEqual({ state: 'empty', propertyUri: 'sc-domain:example.com' });

    const reconnect = vi.fn().mockRejectedValue(new ApiError(401, 'Reconnect', 'search_console_reconnect_required'));
    await expect(loadSearchConsolePerformance('site-a', { startDate: '2026-03-29', endDate: '2026-03-29' }, reconnect as never)).resolves.toEqual({ state: 'reconnect' });

    const failed = vi.fn().mockRejectedValue(new ApiError(503, 'Google is busy', 'search_console_upstream_unavailable'));
    await expect(loadSearchConsolePerformance('site-a', { startDate: '2026-03-29', endDate: '2026-03-29' }, failed as never)).resolves.toEqual({ state: 'error', message: 'Google is busy' });
  });
});

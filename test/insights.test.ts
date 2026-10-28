import { describe, expect, it } from 'vitest';
import { AUTOMATIC_ACTIONS } from '../src/shared/actions';
import { buildInsights, type InsightInput } from '../src/dashboard/lib/insights';
import type { BreakdownRow, Kpis } from '../src/dashboard/lib/api';

function kpis(overrides: Partial<Kpis> = {}): Kpis {
  return {
    visitors: 0,
    sessions: 0,
    pageviews: 0,
    actions: 0,
    bounceRate: 0,
    avgDuration: 0,
    revenue: 0,
    payments: 0,
    customers: 0,
    conversionRate: 0,
    revenuePerVisitor: 0,
    ...overrides,
  };
}

function row(label: string, visitors: number, times = visitors, extra?: string): BreakdownRow {
  return { label, visitors, pageviews: times, revenue: 0, customers: 0, extra };
}

function input(overrides: Partial<InsightInput> = {}): InsightInput {
  return {
    current: kpis(),
    previous: kpis(),
    sources: { current: [], previous: [] },
    pages: { current: [], previous: [] },
    actions: { current: [], previous: [] },
    actionPages: { current: [], previous: [] },
    ...overrides,
  };
}

describe('deterministic performance insights', () => {
  it('describes material increases and decreases in owner language', () => {
    const insights = buildInsights(input({
      current: kpis({ visitors: 150, pageviews: 140, actions: 6 }),
      previous: kpis({ visitors: 100, pageviews: 200, actions: 12 }),
    }));
    expect(insights.map((item) => item.title)).toEqual([
      'Website visitors increased',
      'Recorded actions decreased',
      'Page views decreased',
    ]);
    expect(insights[0].detail).toContain('from 100 to 150');
    expect(insights[1].detail).toContain('not necessarily confirmed outcomes');
  });

  it('suppresses large percentages when absolute volume is tiny', () => {
    const insights = buildInsights(input({
      current: kpis({ visitors: 4, pageviews: 7, actions: 2 }),
      previous: kpis({ visitors: 1, pageviews: 2, actions: 0 }),
    }));
    expect(insights).toEqual([]);
  });

  it('handles zero denominators without Infinity or noisy zero-to-small changes', () => {
    expect(buildInsights(input())).toEqual([]);
    expect(buildInsights(input({ current: kpis({ visitors: 9 }), previous: kpis() }))).toEqual([]);
    const [insight] = buildInsights(input({ current: kpis({ visitors: 25 }), previous: kpis() }));
    expect(insight.title).toBe('Website visitors increased');
    expect(insight.detail).toBe('Website visitors appeared this period, reaching 25.');
    expect(insight.detail).not.toContain('Infinity');
  });

  it('breaks ties deterministically and avoids claiming one tied source was strongest', () => {
    const insights = buildInsights(input({
      current: kpis({ visitors: 80 }),
      previous: kpis({ visitors: 80 }),
      sources: { current: [row('Email', 25), row('Google', 25)], previous: [row('Email', 25), row('Google', 25)] },
    }));
    expect(insights).toHaveLength(1);
    expect(insights[0].title).toBe('Email was a leading traffic source');
  });

  it('ranks by business importance and returns only the requested number', () => {
    const insights = buildInsights(input({
      current: kpis({ visitors: 150, pageviews: 150, actions: 20 }),
      previous: kpis({ visitors: 100, pageviews: 100, actions: 5 }),
    }), 2);
    expect(insights.map((item) => item.id)).toEqual(['total:actions', 'total:visitors']);
  });

  it('reports meaningful contact-action movement as intent, not an outcome', () => {
    const insights = buildInsights(input({
      current: kpis({ actions: 8 }),
      previous: kpis({ actions: 3 }),
      actions: {
        current: [row(AUTOMATIC_ACTIONS.phone, 6, 8)],
        previous: [row(AUTOMATIC_ACTIONS.phone, 2, 3)],
      },
    }));
    const contact = insights.find((item) => item.id === `contact:${AUTOMATIC_ACTIONS.phone}`);
    expect(contact?.title).toBe('Phone clicks increased');
    expect(contact?.detail).toContain('intent signal, not a confirmed business outcome');
  });

  it('finds meaningful source and page gains and losses', () => {
    const insights = buildInsights(input({
      current: kpis({ visitors: 100 }),
      previous: kpis({ visitors: 100 }),
      sources: { current: [row('Google', 40)], previous: [row('Google', 20)] },
      pages: { current: [row('/services', 12)], previous: [row('/services', 25)] },
    }));
    expect(insights.map((item) => item.title)).toEqual([
      'Google traffic increased',
      '/services decreased in traffic',
    ]);
  });

  it('identifies a meaningful action-by-page increase', () => {
    const insights = buildInsights(input({
      current: kpis({ actions: 8 }),
      previous: kpis({ actions: 3 }),
      actionPages: {
        current: [row(AUTOMATIC_ACTIONS.form, 5, 8, '/contact')],
        previous: [row(AUTOMATIC_ACTIONS.form, 2, 3, '/contact')],
      },
    }));
    const page = insights.find((item) => item.id.startsWith('action-page:'));
    expect(page?.title).toBe('Form submissions on /contact increased');
    expect(page?.detail).toContain('not necessarily a confirmed outcome');
  });

  it('finds the page generating the most actions and handles top-page ties', () => {
    const insights = buildInsights(input({
      current: kpis({ actions: 8 }),
      previous: kpis({ actions: 8 }),
      actionPages: {
        current: [row('booking_start', 3, 4, '/book'), row(AUTOMATIC_ACTIONS.phone, 2, 4, '/contact')],
        previous: [row('booking_start', 3, 4, '/book'), row(AUTOMATIC_ACTIONS.phone, 2, 4, '/contact')],
      },
    }));
    expect(insights.find((item) => item.id === 'action-page-top:/book')?.title).toBe('/book was a leading action page');
  });

  it('supports deterministic Search Console changes without requiring Google', () => {
    const insights = buildInsights(input({
      search: {
        current: { clicks: 30, impressions: 400 },
        previous: { clicks: 15, impressions: 300 },
      },
    }));
    expect(insights.map((item) => item.title)).toEqual(['Google Search clicks increased']);
  });

  it('supports meaningful search-page movement with mocked values', () => {
    const insights = buildInsights(input({
      search: {
        current: { clicks: 20, impressions: 200, pages: [{ page: 'https://example.com/services', clicks: 15, impressions: 100 }] },
        previous: { clicks: 20, impressions: 200, pages: [{ page: 'https://example.com/services', clicks: 5, impressions: 80 }] },
      },
    }));
    expect(insights[0].title).toBe('Google traffic to /services increased');
  });

  it('returns a neutral no-insight result when nothing clears the rules', () => {
    const insights = buildInsights(input({
      current: kpis({ visitors: 100, pageviews: 220, actions: 10 }),
      previous: kpis({ visitors: 95, pageviews: 210, actions: 9 }),
      sources: { current: [row('Google', 8)], previous: [row('Google', 7)] },
      pages: { current: [row('/', 9)], previous: [row('/', 8)] },
    }));
    expect(insights).toEqual([]);
  });
});

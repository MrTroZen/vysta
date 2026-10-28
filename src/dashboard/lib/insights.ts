import { actionLabel, AUTOMATIC_ACTIONS } from '../../shared/actions';
import type { BreakdownRow, Kpis } from './api';

export const INSIGHT_THRESHOLDS = {
  visitors: { minVolume: 20, minAbsolute: 10, minPercent: 0.2 },
  pageviews: { minVolume: 30, minAbsolute: 15, minPercent: 0.2 },
  actions: { minVolume: 5, minAbsolute: 3, minPercent: 0.3 },
  contactAction: { minVolume: 4, minAbsolute: 3, minPercent: 0.4 },
  source: { minVolume: 10, minAbsolute: 5, minPercent: 0.3 },
  page: { minVolume: 10, minAbsolute: 5, minPercent: 0.3 },
  actionPage: { minVolume: 4, minAbsolute: 3, minPercent: 0.5 },
  searchClicks: { minVolume: 10, minAbsolute: 5, minPercent: 0.25 },
  searchImpressions: { minVolume: 100, minAbsolute: 50, minPercent: 0.25 },
  searchPage: { minVolume: 10, minAbsolute: 5, minPercent: 0.3 },
} as const;

export interface Insight {
  id: string;
  category: 'traffic' | 'actions' | 'source' | 'page' | 'search';
  tone: 'positive' | 'negative' | 'neutral';
  title: string;
  detail: string;
  score: number;
}

export interface SearchInsightData {
  clicks: number;
  impressions: number;
  pages?: Array<{ page: string; clicks: number; impressions: number }>;
}

export interface InsightInput {
  current: Kpis;
  previous: Kpis;
  sources: { current: BreakdownRow[]; previous: BreakdownRow[] };
  pages: { current: BreakdownRow[]; previous: BreakdownRow[] };
  actions: { current: BreakdownRow[]; previous: BreakdownRow[] };
  actionPages: { current: BreakdownRow[]; previous: BreakdownRow[] };
  search?: { current: SearchInsightData; previous: SearchInsightData };
}

interface Threshold {
  minVolume: number;
  minAbsolute: number;
  minPercent: number;
}

interface Change {
  current: number;
  previous: number;
  absolute: number;
  percent: number | null;
  direction: 'increased' | 'decreased';
}

function change(current: number, previous: number, threshold: Threshold): Change | null {
  if (current === previous) return null;
  const absolute = current - previous;
  const magnitude = Math.abs(absolute);
  const volume = Math.max(current, previous);
  if (volume < threshold.minVolume || magnitude < threshold.minAbsolute) return null;
  if (previous === 0) {
    return current >= threshold.minVolume ? { current, previous, absolute, percent: null, direction: 'increased' } : null;
  }
  const percent = magnitude / previous;
  if (percent < threshold.minPercent) return null;
  return { current, previous, absolute, percent, direction: absolute > 0 ? 'increased' : 'decreased' };
}

function number(value: number) {
  return Math.round(value).toLocaleString('en-US');
}

function changeDetail(label: string, value: Change) {
  if (value.previous === 0) return `${label} appeared this period, reaching ${number(value.current)}.`;
  if (value.current === 0) return `${label} fell from ${number(value.previous)} to zero.`;
  return `${label} ${value.direction} ${Math.round((value.percent ?? 0) * 100)}%, from ${number(value.previous)} to ${number(value.current)}.`;
}

function score(base: number, value: Change, threshold: Threshold) {
  const absoluteWeight = Math.min(Math.abs(value.absolute) / threshold.minAbsolute, 5) * 5;
  const percentWeight = Math.min((value.percent ?? 1) * 10, 20);
  return base + absoluteWeight + percentWeight;
}

function rowsByLabel(rows: BreakdownRow[]) {
  return new Map(rows.filter((row) => row.label).map((row) => [row.label as string, row]));
}

function rowValue(row: BreakdownRow | undefined, field: 'visitors' | 'pageviews') {
  return row ? (field === 'visitors' ? row.visitors : row.pageviews ?? 0) : 0;
}

function movementCandidates(
  currentRows: BreakdownRow[],
  previousRows: BreakdownRow[],
  field: 'visitors' | 'pageviews',
  threshold: Threshold,
) {
  const current = rowsByLabel(currentRows);
  const previous = rowsByLabel(previousRows);
  return [...new Set([...current.keys(), ...previous.keys()])].sort().flatMap((label) => {
    const value = change(rowValue(current.get(label), field), rowValue(previous.get(label), field), threshold);
    return value ? [{ label, value }] : [];
  });
}

function totalInsights(input: InsightInput): Insight[] {
  const definitions = [
    { key: 'visitors', label: 'Website visitors', base: 110, threshold: INSIGHT_THRESHOLDS.visitors },
    { key: 'pageviews', label: 'Page views', base: 90, threshold: INSIGHT_THRESHOLDS.pageviews },
    { key: 'actions', label: 'Recorded actions', base: 105, threshold: INSIGHT_THRESHOLDS.actions },
  ] as const;
  return definitions.flatMap(({ key, label, base, threshold }) => {
    const value = change(input.current[key], input.previous[key], threshold);
    if (!value) return [];
    const actionNote = key === 'actions' ? ' Actions include contact intent and configured actions, not necessarily confirmed outcomes.' : '';
    return [{
      id: `total:${key}`,
      category: key === 'actions' ? 'actions' : 'traffic',
      tone: value.direction === 'increased' ? 'positive' : 'negative',
      title: `${label} ${value.direction}`,
      detail: changeDetail(label, value) + actionNote,
      score: score(base, value, threshold),
    } satisfies Insight];
  });
}

function contactActionInsights(input: InsightInput): Insight[] {
  const automaticNames = new Set<string>(Object.values(AUTOMATIC_ACTIONS));
  return movementCandidates(input.actions.current, input.actions.previous, 'pageviews', INSIGHT_THRESHOLDS.contactAction)
    .filter(({ label }) => automaticNames.has(label))
    .map(({ label, value }) => ({
      id: `contact:${label}`,
      category: 'actions' as const,
      tone: value.direction === 'increased' ? 'positive' as const : 'negative' as const,
      title: `${actionLabel(label)} ${value.direction}`,
      detail: `${changeDetail(actionLabel(label), value)} This is an intent signal, not a confirmed business outcome.`,
      score: score(82, value, INSIGHT_THRESHOLDS.contactAction),
    }));
}

function sourceInsights(input: InsightInput): Insight[] {
  const movements: Insight[] = movementCandidates(input.sources.current, input.sources.previous, 'visitors', INSIGHT_THRESHOLDS.source)
    .map(({ label, value }) => ({
      id: `source:${label}`,
      category: 'source',
      tone: value.direction === 'increased' ? 'positive' : 'negative',
      title: `${label} traffic ${value.direction}`,
      detail: changeDetail(`Visitors from ${label}`, value),
      score: score(78, value, INSIGHT_THRESHOLDS.source),
    }));
  const sorted = [...input.sources.current].filter((row) => row.label).sort((a, b) => b.visitors - a.visitors || String(a.label).localeCompare(String(b.label)));
  const top = sorted[0];
  const second = sorted[1];
  if (!top || top.visitors < 15 || top.visitors < input.current.visitors * 0.25 || movements.some((item) => item.id === `source:${top.label}`)) return movements;
  const tied = second?.visitors === top.visitors;
  movements.push({
    id: `source-top:${top.label}`,
    category: 'source',
    tone: 'neutral',
    title: tied ? `${top.label} was a leading traffic source` : `${top.label} was your strongest traffic source`,
    detail: `${number(top.visitors)} visitors came from ${top.label} this period.`,
    score: 45 + Math.min(top.visitors / 15, 5) * 5,
  });
  return movements;
}

function pageInsights(input: InsightInput): Insight[] {
  return movementCandidates(input.pages.current, input.pages.previous, 'visitors', INSIGHT_THRESHOLDS.page)
    .map(({ label, value }) => ({
      id: `page:${label}`,
      category: 'page' as const,
      tone: value.direction === 'increased' ? 'positive' as const : 'negative' as const,
      title: `${label} ${value.direction} in traffic`,
      detail: changeDetail(`Visitors to ${label}`, value),
      score: score(74, value, INSIGHT_THRESHOLDS.page),
    }));
}

function actionPageKey(row: BreakdownRow) {
  return `${row.label ?? ''}\u0000${row.extra ?? '/'}`;
}

function actionPageInsights(input: InsightInput): Insight[] {
  const current = new Map(input.actionPages.current.map((row) => [actionPageKey(row), row]));
  const previous = new Map(input.actionPages.previous.map((row) => [actionPageKey(row), row]));
  const movements: Insight[] = [...new Set([...current.keys(), ...previous.keys()])].sort().flatMap((key) => {
    const currentRow = current.get(key);
    const previousRow = previous.get(key);
    const value = change(currentRow?.pageviews ?? 0, previousRow?.pageviews ?? 0, INSIGHT_THRESHOLDS.actionPage);
    if (!value) return [];
    const row = currentRow ?? previousRow;
    const label = actionLabel(row?.label);
    const page = row?.extra || '/';
    return [{
      id: `action-page:${key}`,
      category: 'actions' as const,
      tone: value.direction === 'increased' ? 'positive' as const : 'negative' as const,
      title: `${label} on ${page} ${value.direction}`,
      detail: `${changeDetail(`${label} on ${page}`, value)} This records an action or intent, not necessarily a confirmed outcome.`,
      score: score(76, value, INSIGHT_THRESHOLDS.actionPage),
    }];
  });

  const byPage = new Map<string, { actions: number; people: number }>();
  for (const row of input.actionPages.current) {
    const page = row.extra || '/';
    const total = byPage.get(page) ?? { actions: 0, people: 0 };
    total.actions += row.pageviews ?? 0;
    // Rows are distinct by action, so the maximum is a safe lower bound for distinct people across the page.
    total.people = Math.max(total.people, row.visitors);
    byPage.set(page, total);
  }
  const top = [...byPage.entries()].sort((a, b) => b[1].actions - a[1].actions || b[1].people - a[1].people || a[0].localeCompare(b[0]))[0];
  if (!top || top[1].actions < 4 || top[1].people < 2 || movements.some((item) => item.title.includes(` on ${top[0]} `))) return movements;
  const tied = [...byPage.values()].filter((value) => value.actions === top[1].actions).length > 1;
  movements.push({
    id: `action-page-top:${top[0]}`,
    category: 'actions',
    tone: 'neutral',
    title: tied ? `${top[0]} was a leading action page` : `${top[0]} generated the most actions`,
    detail: `${number(top[1].actions)} actions were recorded; at least ${number(top[1].people)} people took one of them. These may include intent signals, not only confirmed outcomes.`,
    score: 48 + Math.min(top[1].actions / 4, 5) * 5,
  });
  return movements;
}

function searchInsights(input: InsightInput): Insight[] {
  if (!input.search) return [];
  const definitions = [
    { key: 'clicks', label: 'Google Search clicks', threshold: INSIGHT_THRESHOLDS.searchClicks },
    { key: 'impressions', label: 'Google Search impressions', threshold: INSIGHT_THRESHOLDS.searchImpressions },
  ] as const;
  const totals: Insight[] = definitions.flatMap(({ key, label, threshold }) => {
    const value = change(input.search!.current[key], input.search!.previous[key], threshold);
    return value ? [{
      id: `search:${key}`,
      category: 'search' as const,
      tone: value.direction === 'increased' ? 'positive' as const : 'negative' as const,
      title: `${label} ${value.direction}`,
      detail: changeDetail(label, value),
      score: score(72, value, threshold),
    }] : [];
  });
  const currentPages = new Map((input.search.current.pages ?? []).map((page) => [page.page, page]));
  const previousPages = new Map((input.search.previous.pages ?? []).map((page) => [page.page, page]));
  const pages: Insight[] = [...new Set([...currentPages.keys(), ...previousPages.keys()])].sort().flatMap((page) => {
    const value = change(currentPages.get(page)?.clicks ?? 0, previousPages.get(page)?.clicks ?? 0, INSIGHT_THRESHOLDS.searchPage);
    if (!value) return [];
    let label = page;
    try { label = new URL(page).pathname || '/'; } catch {}
    return [{
      id: `search-page:${page}`,
      category: 'search',
      tone: value.direction === 'increased' ? 'positive' : 'negative',
      title: `Google traffic to ${label} ${value.direction}`,
      detail: changeDetail(`Google Search clicks to ${label}`, value),
      score: score(68, value, INSIGHT_THRESHOLDS.searchPage),
    }];
  });
  return [...totals, ...pages];
}

/** Produce a small, deterministic set of owner-facing observations. */
export function buildInsights(input: InsightInput, limit = 4): Insight[] {
  const candidates = [
    ...totalInsights(input),
    ...contactActionInsights(input),
    ...sourceInsights(input),
    ...pageInsights(input),
    ...actionPageInsights(input),
    ...searchInsights(input),
  ].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const caps: Record<Insight['category'], number> = { traffic: 2, actions: 2, source: 1, page: 1, search: 1 };
  const counts = new Map<Insight['category'], number>();
  const selected: Insight[] = [];
  for (const insight of candidates) {
    if ((counts.get(insight.category) ?? 0) >= caps[insight.category]) continue;
    selected.push(insight);
    counts.set(insight.category, (counts.get(insight.category) ?? 0) + 1);
    if (selected.length === limit) break;
  }
  return selected;
}

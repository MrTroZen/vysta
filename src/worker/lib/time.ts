const DAY = 86_400_000;
const HOUR = 3_600_000;

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function localParts(tz: string, at: number): LocalParts {
  let formatter = formatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, formatter);
  }
  const parts = formatter.formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Offset of `tz` from UTC in ms at `at` (positive east of UTC). */
export function tzOffset(tz: string, at: number = Date.now()): number {
  try {
    const parts = localParts(tz, at);
    const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return Math.round((asUTC - Math.floor(at / 1000) * 1000) / 60_000) * 60_000;
  } catch {
    return 0;
  }
}

/** Convert a local calendar midnight to its UTC instant. */
function localMidnight(year: number, month: number, day: number, tz: string): number {
  const wallClock = Date.UTC(year, month - 1, day);
  let instant = wallClock - tzOffset(tz, wallClock);
  for (let i = 0; i < 8; i++) {
    const next = wallClock - tzOffset(tz, instant);
    if (next === instant) return instant;
    instant = next;
  }
  return instant;
}

/** Midnight (site time) of the day containing `at`, as a UTC timestamp. */
export function startOfDay(at: number, tz: string): number {
  const parts = localParts(tz, at);
  return localMidnight(parts.year, parts.month, parts.day, tz);
}

/** Shift a local calendar date without assuming that every day is 24 elapsed hours. */
function addLocalDays(at: number, days: number, tz: string): number {
  const parts = localParts(tz, at);
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return localMidnight(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), tz);
}

/** Parse YYYY-MM-DD as midnight in the site's timezone. */
function parseDay(s: string, tz: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) return null;
  const year = +match[1];
  const month = +match[2];
  const day = +match[3];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return localMidnight(year, month, day, tz);
}

export type Granularity = 'hour' | 'day' | 'week' | 'month';

export interface Range {
  from: number;
  to: number;
  granularity: Granularity;
}

export const PERIODS = ['today', 'yesterday', '24h', '48h', '7d', '30d', '90d', '12m', 'all', 'custom'] as const;
export type Period = (typeof PERIODS)[number];

export function resolveRange(
  q: { period?: string; from?: string; to?: string; granularity?: string },
  tz: string,
  siteCreatedAt: number,
  now = Date.now(),
): Range {
  const today = startOfDay(now, tz);
  let from: number;
  let to = now;
  switch (q.period as Period) {
    case 'today':
      from = today;
      break;
    case 'yesterday':
      from = addLocalDays(today, -1, tz);
      to = today;
      break;
    case '24h':
      from = now - 24 * HOUR;
      break;
    case '48h':
      from = now - 48 * HOUR;
      break;
    case '7d':
      from = addLocalDays(today, -6, tz);
      break;
    case '90d':
      from = addLocalDays(today, -89, tz);
      break;
    case '12m':
      from = addLocalDays(today, -364, tz);
      break;
    case 'all':
      from = startOfDay(siteCreatedAt, tz);
      break;
    case 'custom': {
      const first = q.from ? parseDay(q.from, tz) : null;
      const last = q.to ? parseDay(q.to, tz) : null;
      from = first ?? today;
      // `to` is inclusive of the whole local calendar day.
      to = Math.min(last !== null ? addLocalDays(last, 1, tz) : now, now);
      if (to <= from) to = addLocalDays(from, 1, tz);
      break;
    }
    case '30d':
    default:
      from = addLocalDays(today, -29, tz);
  }
  const span = to - from;
  const auto: Granularity = span <= 2 * DAY + HOUR ? 'hour' : span <= 120 * DAY ? 'day' : span <= 400 * DAY ? 'week' : 'month';
  const requested = (['hour', 'day', 'week', 'month'] as const).includes(q.granularity as Granularity)
    ? (q.granularity as Granularity)
    : auto;
  // Hourly buckets over months would be thousands of points; fall back to the automatic choice.
  const granularity = requested === 'hour' && span > 7 * DAY ? auto : requested;
  return { from, to, granularity };
}

/** Start of the immediately preceding comparison period. Full local-day ranges stay aligned to local midnights. */
export function previousPeriodStart(range: Range, tz: string): number {
  if (startOfDay(range.from, tz) === range.from && startOfDay(range.to, tz) === range.to) {
    const first = localParts(tz, range.from);
    const last = localParts(tz, range.to);
    const days = Math.round(
      (Date.UTC(last.year, last.month - 1, last.day) - Date.UTC(first.year, first.month - 1, first.day)) / DAY,
    );
    if (days > 0) return addLocalDays(range.from, -days, tz);
  }
  return range.from - (range.to - range.from);
}

interface OffsetTransition {
  at: number;
  offset: number;
}

const transitionCache = new Map<string, OffsetTransition[]>();

function transitionAt(tz: string, low: number, high: number, oldOffset: number): number {
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (tzOffset(tz, middle) === oldOffset) low = middle;
    else high = middle;
  }
  return high;
}

/** UTC instants where a timezone's offset changes inside one report range. */
function transitionsInRange(tz: string, from: number, to: number): OffsetTransition[] {
  const key = `${tz}:${from}:${to}`;
  const cached = transitionCache.get(key);
  if (cached) return cached;

  const transitions: OffsetTransition[] = [];
  let previousAt = from;
  let previousOffset = tzOffset(tz, previousAt);
  while (previousAt < to) {
    const checkpoint = Math.min(previousAt + DAY, to);
    const offset = tzOffset(tz, checkpoint);
    if (offset !== previousOffset) {
      const at = transitionAt(tz, previousAt, checkpoint, previousOffset);
      if (at < to) transitions.push({ at, offset: tzOffset(tz, at) });
    }
    previousAt = checkpoint;
    previousOffset = offset;
  }
  if (transitionCache.size >= 100) transitionCache.delete(transitionCache.keys().next().value as string);
  transitionCache.set(key, transitions);
  return transitions;
}

/** SQL expression yielding the correct timezone offset for each timestamp in a range. */
export function timezoneOffsetSql(col: string, tz: string, from: number, to: number): string {
  const ordered = transitionsInRange(tz, from, to).map((transition) => [transition.at, transition.offset] as const);
  let offset = tzOffset(tz, from);
  if (!ordered.length) return String(offset);
  const cases: string[] = [];
  for (const [at, nextOffset] of ordered) {
    cases.push(`WHEN ${col} < ${at} THEN ${offset}`);
    offset = nextOffset;
  }
  return `(CASE ${cases.join(' ')} ELSE ${offset} END)`;
}

/** SQLite expression that turns a ms timestamp column into a bucket label in site time. */
export function bucketSql(col: string, granularity: Granularity, offsetMs: number | string): string {
  const offset = typeof offsetMs === 'number' ? Math.trunc(offsetMs) : offsetMs;
  const timestamp = `((${col} + (${offset})) / 1000)`;
  switch (granularity) {
    case 'hour':
      return `strftime('%Y-%m-%dT%H:00', ${timestamp}, 'unixepoch')`;
    case 'day':
      return `strftime('%Y-%m-%d', ${timestamp}, 'unixepoch')`;
    case 'week':
      return `date(${timestamp}, 'unixepoch', 'weekday 0', '-6 days')`;
    case 'month':
      return `strftime('%Y-%m', ${timestamp}, 'unixepoch')`;
  }
}

function dateLabel(parts: LocalParts): string {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function labelAt(at: number, granularity: Granularity, tz: string): string {
  const parts = localParts(tz, at);
  const date = dateLabel(parts);
  if (granularity === 'hour') return `${date}T${String(parts.hour).padStart(2, '0')}:00`;
  if (granularity === 'day') return date;
  if (granularity === 'month') return date.slice(0, 7);

  const utcDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const daysSinceMonday = (utcDate.getUTCDay() + 6) % 7;
  utcDate.setUTCDate(utcDate.getUTCDate() - daysSinceMonday);
  return utcDate.toISOString().slice(0, 10);
}

/** Every bucket label in the range, so the chart has no gaps. Mirrors bucketSql. */
export function bucketLabels(range: Range, timezoneOrOffset: string | number): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  const add = (label: string) => {
    if (!seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  };

  if (typeof timezoneOrOffset === 'number') {
    const step = range.granularity === 'hour' ? HOUR : DAY;
    for (let at = range.from; at < range.to; at += step) {
      const shifted = new Date(at + timezoneOrOffset);
      const iso = shifted.toISOString();
      if (range.granularity === 'hour') add(iso.slice(0, 13) + ':00');
      else if (range.granularity === 'day') add(iso.slice(0, 10));
      else if (range.granularity === 'month') add(iso.slice(0, 7));
      else {
        const daysToMonday = (shifted.getUTCDay() + 6) % 7;
        add(new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - daysToMonday)).toISOString().slice(0, 10));
      }
    }
    return labels;
  }

  const tz = timezoneOrOffset;
  if (range.granularity === 'hour') {
    for (let at = range.from; at < range.to; at += HOUR) add(labelAt(at, range.granularity, tz));
    return labels;
  }

  for (let at = startOfDay(range.from, tz); at < range.to; ) {
    add(labelAt(at, range.granularity, tz));
    const next = addLocalDays(at, 1, tz);
    if (next <= at) break;
    at = next;
  }
  return labels;
}

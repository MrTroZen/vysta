import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const trackerSource = readFileSync(new URL('../public/js/script.js', import.meta.url), 'utf8');

interface CookieValue {
  value: string;
  expiresAt: number | null;
}

class CookieJar {
  private readonly values = new Map<string, CookieValue>();
  private sequence = 0;

  get header() {
    this.expire();
    return [...this.values].map(([name, item]) => `${name}=${item.value}`).join('; ');
  }

  set header(raw: string) {
    const parts = raw.split(';').map((part) => part.trim());
    const separator = parts[0].indexOf('=');
    const name = parts[0].slice(0, separator);
    const value = parts[0].slice(separator + 1);
    const maxAgePart = parts.find((part) => part.toLowerCase().startsWith('max-age='));
    const maxAge = maxAgePart ? Number(maxAgePart.slice('max-age='.length)) : null;
    if (maxAge !== null && maxAge <= 0) this.values.delete(name);
    else this.values.set(name, { value, expiresAt: maxAge === null ? null : Date.now() + maxAge * 1_000 });
  }

  nextUuid() {
    this.sequence++;
    return `00000000-0000-4000-8000-${String(this.sequence).padStart(12, '0')}`;
  }

  private expire() {
    for (const [name, item] of this.values) {
      if (item.expiresAt !== null && item.expiresAt <= Date.now()) this.values.delete(name);
    }
  }
}

interface TrackerOptions {
  url?: string;
  referrer?: string;
  jar?: CookieJar;
  webdriver?: boolean;
  allowLocalhost?: boolean;
  sendBeacon?: boolean;
  queued?: unknown[][];
}

class TrackerHarness {
  readonly jar: CookieJar;
  readonly requests: Record<string, unknown>[] = [];
  readonly beacons: Blob[] = [];
  readonly intervals: (() => void)[] = [];
  readonly local = new Map<string, string>();
  readonly runtime: Record<string, any>;
  private currentUrl: URL;
  private readonly documentListeners = new Map<string, ((event: any) => void)[]>();
  private readonly windowListeners = new Map<string, ((event: any) => void)[]>();

  constructor(options: TrackerOptions = {}) {
    this.jar = options.jar ?? new CookieJar();
    this.currentUrl = new URL(options.url ?? 'https://example.com/');
    const location = {
      get href() {
        return harness.currentUrl.href;
      },
      get hostname() {
        return harness.currentUrl.hostname;
      },
      get protocol() {
        return harness.currentUrl.protocol;
      },
      get pathname() {
        return harness.currentUrl.pathname;
      },
      get search() {
        return harness.currentUrl.search;
      },
    };
    const harness = this;
    const attributes = new Map<string, string>([
      ['data-website-id', 'site000000000001'],
      ['data-api', 'https://collector.example/api/event'],
    ]);
    if (options.allowLocalhost) attributes.set('data-allow-localhost', '');
    const document = {
      currentScript: {
        src: 'https://collector.example/js/script.js',
        getAttribute: (name: string) => attributes.get(name) ?? null,
        hasAttribute: (name: string) => attributes.has(name),
      },
      referrer: options.referrer ?? '',
      visibilityState: 'visible',
      readyState: 'complete',
      documentElement: {},
      get cookie() {
        return harness.jar.header;
      },
      set cookie(value: string) {
        harness.jar.header = value;
      },
      addEventListener: (type: string, listener: (event: any) => void) => this.addListener(this.documentListeners, type, listener),
      querySelectorAll: () => [],
    };
    const history = {
      pushState: (_state: unknown, _unused: string, next?: string | URL | null) => {
        if (next !== undefined && next !== null) this.currentUrl = new URL(String(next), this.currentUrl);
      },
      replaceState: (_state: unknown, _unused: string, next?: string | URL | null) => {
        if (next !== undefined && next !== null) this.currentUrl = new URL(String(next), this.currentUrl);
      },
    };
    const navigator: Record<string, unknown> = { webdriver: options.webdriver ?? false };
    if (options.sendBeacon !== undefined) {
      navigator.sendBeacon = (_endpoint: string, body: Blob) => {
        this.beacons.push(body);
        return options.sendBeacon;
      };
    }
    const runtime: Record<string, any> = {
      document,
      location,
      navigator,
      history,
      screen: { width: 1440 },
      localStorage: {
        getItem: (key: string) => this.local.get(key) ?? null,
        setItem: (key: string, value: string) => this.local.set(key, value),
        removeItem: (key: string) => this.local.delete(key),
      },
      crypto: { randomUUID: () => this.jar.nextUuid() },
      fetch: (_endpoint: string, init: { body: string }) => {
        this.requests.push(JSON.parse(init.body) as Record<string, unknown>);
        return Promise.resolve({ ok: true });
      },
      Blob,
      URL,
      URLSearchParams,
      Date,
      setTimeout: (fn: () => void) => {
        fn();
        return 1;
      },
      setInterval: (fn: () => void) => {
        this.intervals.push(fn);
        return this.intervals.length;
      },
      MutationObserver: class {
        observe() {}
      },
      addEventListener: (type: string, listener: (event: any) => void) => this.addListener(this.windowListeners, type, listener),
    };
    runtime.window = runtime;
    if (options.queued) runtime.minilytics = { q: options.queued };
    this.runtime = runtime;
  }

  load() {
    vm.runInNewContext(trackerSource, this.runtime, { filename: 'script.js' });
  }

  call(...args: unknown[]) {
    this.runtime.minilytics(...args);
  }

  push(path: string) {
    this.runtime.history.pushState({}, '', path);
  }

  navigateAndPop(path: string) {
    this.currentUrl = new URL(path, this.currentUrl);
    this.dispatch(this.windowListeners, 'popstate', {});
  }

  setVisibility(value: 'visible' | 'hidden') {
    this.runtime.document.visibilityState = value;
    this.dispatch(this.documentListeners, 'visibilitychange', {});
  }

  pagehide() {
    this.dispatch(this.windowListeners, 'pagehide', {});
  }

  clickGoal(name: string, properties: Record<string, string> = {}) {
    const attributes = [
      { name: 'data-ml-goal', value: name },
      ...Object.entries(properties).map(([key, value]) => ({ name: `data-ml-goal-${key}`, value })),
    ];
    const element = {
      attributes,
      getAttribute: (key: string) => (key === 'data-ml-goal' ? name : null),
      closest: (selector: string) => (selector === '[data-ml-goal]' ? element : null),
    };
    this.dispatch(this.documentListeners, 'click', { target: element });
  }

  clickLink(href: string, times = 1) {
    const element = {
      href,
      attributes: [],
      getAttribute: () => null,
      closest: (selector: string) => selector === 'a[href]' ? element : null,
    };
    for (let i = 0; i < times; i++) this.dispatch(this.documentListeners, 'click', { target: element });
  }

  submitForm(times = 1) {
    const form = { tagName: 'FORM', email: 'private@example.com', fields: { message: 'private message' } };
    for (let i = 0; i < times; i++) this.dispatch(this.documentListeners, 'submit', { target: form });
  }

  submitNonForm() {
    this.dispatch(this.documentListeners, 'submit', { target: { tagName: 'DIV' } });
  }

  private addListener(store: Map<string, ((event: any) => void)[]>, type: string, listener: (event: any) => void) {
    store.set(type, [...(store.get(type) ?? []), listener]);
  }

  private dispatch(store: Map<string, ((event: any) => void)[]>, type: string, event: any) {
    for (const listener of store.get(type) ?? []) listener(event);
  }
}

describe('browser tracker characterization', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-23T12:00:00Z'));
  });

  afterEach(() => vi.useRealTimers());

  it('creates a one-year visitor and sliding 30-minute session on first load', () => {
    const tracker = new TrackerHarness({ url: 'https://example.com/welcome', referrer: 'https://www.google.com/search?q=vysta' });
    tracker.load();
    expect(tracker.requests).toHaveLength(1);
    expect(tracker.requests[0]).toMatchObject({
      t: 'pageview',
      tv: '2',
      eid: '00000000-0000-4000-8000-000000000003',
      u: 'https://example.com/welcome',
      r: 'https://www.google.com/search?q=vysta',
      vid: '00000000-0000-4000-8000-000000000001',
      sid: '00000000-0000-4000-8000-000000000002',
    });
    expect(decodeURIComponent(tracker.jar.header)).toContain('ml_vid=00000000-0000-4000-8000-000000000001');
    expect(decodeURIComponent(tracker.jar.header)).toContain('ml_sid=00000000-0000-4000-8000-000000000002');
  });

  it('reuses the session under 30 minutes and rotates only the session after inactivity', () => {
    const jar = new CookieJar();
    const first = new TrackerHarness({ jar });
    first.load();
    const original = first.requests[0];

    vi.setSystemTime(new Date('2026-10-23T12:29:00Z'));
    const returning = new TrackerHarness({ jar });
    returning.load();
    expect(returning.requests[0]).toMatchObject({ vid: original.vid, sid: original.sid });

    vi.setSystemTime(new Date('2026-10-23T13:00:01Z'));
    const expired = new TrackerHarness({ jar });
    expired.load();
    expect(expired.requests[0].vid).toBe(original.vid);
    expect(expired.requests[0].sid).not.toBe(original.sid);

    vi.setSystemTime(new Date('2026-10-24T13:00:01Z'));
    const nextDay = new TrackerHarness({ jar });
    nextDay.load();
    expect(nextDay.requests[0].vid).toBe(original.vid);
    expect(nextDay.requests[0].sid).not.toBe(expired.requests[0].sid);
  });

  it('shares visitor and session cookies across subdomains and tabs', () => {
    const jar = new CookieJar();
    const root = new TrackerHarness({ jar, url: 'https://example.com/' });
    root.load();
    const app = new TrackerHarness({ jar, url: 'https://app.example.com/dashboard' });
    app.load();
    expect(app.requests[0]).toMatchObject({ vid: root.requests[0].vid, sid: root.requests[0].sid });
  });

  it('tracks SPA pathname and query changes, popstate, and forced API pageviews but not hash-only changes', () => {
    const tracker = new TrackerHarness({ url: 'https://example.com/products' });
    tracker.load();
    tracker.push('/products');
    tracker.push('/products?sort=price');
    tracker.push('/products?sort=price#details');
    tracker.navigateAndPop('/pricing');
    tracker.call('pageview');
    expect(tracker.requests.map((request) => request.t)).toEqual(['pageview', 'pageview', 'pageview', 'pageview']);
    expect(tracker.requests.map((request) => request.u)).toEqual([
      'https://example.com/products',
      'https://example.com/products?sort=price',
      'https://example.com/pricing',
      'https://example.com/pricing',
    ]);
    expect(tracker.requests.slice(1).map((request) => request.r)).toEqual(['', '', '']);
  });

  it('captures declarative, API, and pre-load queued goals without client-side deduplication', () => {
    const tracker = new TrackerHarness({ queued: [['goal', 'queued_signup', { plan: 'starter' }]] });
    tracker.load();
    tracker.clickGoal('cta_click', { plan: 'pro' });
    tracker.call('goal', 'api_signup', { plan: 'business' });
    tracker.call('goal', 'api_signup', { plan: 'business' });
    expect(tracker.requests.slice(1)).toMatchObject([
      { t: 'goal', n: 'queued_signup', p: { plan: 'starter' } },
      { t: 'goal', n: 'cta_click', p: { plan: 'pro' } },
      { t: 'goal', n: 'api_signup', p: { plan: 'business' } },
      { t: 'goal', n: 'api_signup', p: { plan: 'business' } },
    ]);
  });

  it('records generic phone, WhatsApp, and email intent without destination PII or duplicate outbound events', () => {
    const tracker = new TrackerHarness({ url: 'https://example.com/contact' });
    tracker.load();
    tracker.clickLink('tel:+1-555-0100');
    tracker.clickLink('https://wa.me/15550100?text=private-message');
    tracker.clickLink('mailto:owner@example.com?subject=Private');

    expect(tracker.requests.slice(1)).toMatchObject([
      { t: 'goal', n: '__vysta_phone_intent', u: 'https://example.com/contact' },
      { t: 'goal', n: '__vysta_whatsapp_intent', u: 'https://example.com/contact' },
      { t: 'goal', n: '__vysta_email_intent', u: 'https://example.com/contact' },
    ]);
    expect(tracker.requests.some((request) => request.t === 'outbound')).toBe(false);
    expect(JSON.stringify(tracker.requests)).not.toContain('15550100');
    expect(JSON.stringify(tracker.requests)).not.toContain('owner@example.com');
    expect(tracker.requests.slice(1).every((request) => request.p === undefined)).toBe(true);
  });

  it('recognizes WhatsApp app and web links while leaving ordinary outbound tracking unchanged', () => {
    const tracker = new TrackerHarness();
    tracker.load();
    tracker.clickLink('whatsapp://send?phone=15550100');
    tracker.clickLink('https://api.whatsapp.com/send?phone=15550100');
    tracker.clickLink('https://partner.example.org/book?email=private@example.com');

    expect(tracker.requests.filter((request) => request.n === '__vysta_whatsapp_intent')).toHaveLength(2);
    expect(tracker.requests.at(-1)).toMatchObject({ t: 'outbound', n: 'https://partner.example.org/book' });
    expect(JSON.stringify(tracker.requests)).not.toContain('private@example.com');
  });

  it('records genuine form submit intent without fields and suppresses rapid duplicate delivery', () => {
    const tracker = new TrackerHarness({ url: 'https://example.com/request-a-quote' });
    tracker.load();
    tracker.submitNonForm();
    tracker.submitForm(2);
    expect(tracker.requests.filter((request) => request.n === '__vysta_form_intent')).toHaveLength(1);
    expect(JSON.stringify(tracker.requests)).not.toContain('private@example.com');
    expect(JSON.stringify(tracker.requests)).not.toContain('private message');

    vi.setSystemTime(new Date('2026-10-23T12:00:01.001Z'));
    tracker.submitForm();
    expect(tracker.requests.filter((request) => request.n === '__vysta_form_intent')).toHaveLength(2);
  });

  it('attributes automatic actions to the current SPA page and still initializes listeners once', () => {
    const tracker = new TrackerHarness({ url: 'https://example.com/' });
    tracker.load();
    tracker.load();
    tracker.push('/contact');
    tracker.clickLink('tel:+880123456789');
    expect(tracker.requests.filter((request) => request.n === '__vysta_phone_intent')).toEqual([
      expect.objectContaining({ u: 'https://example.com/contact' }),
    ]);
  });

  it('initializes once when the tracker script is included twice', () => {
    const tracker = new TrackerHarness();
    tracker.load();
    tracker.load();
    tracker.push('/next');
    tracker.clickGoal('signup');
    expect(tracker.requests.filter((request) => request.t === 'pageview')).toHaveLength(2);
    expect(tracker.requests.filter((request) => request.t === 'goal')).toHaveLength(1);
    expect(tracker.intervals).toHaveLength(1);
  });

  it('gives every logical send a unique event id and includes the tracker version', () => {
    const tracker = new TrackerHarness();
    tracker.load();
    tracker.call('goal', 'signup');
    tracker.call('goal', 'signup');
    const eventIds = tracker.requests.map((request) => request.eid);
    expect(new Set(eventIds).size).toBe(3);
    expect(tracker.requests.every((request) => request.tv === '2')).toBe(true);
  });

  it('sends visible engaged time in pings and counts two visible tabs independently', () => {
    const jar = new CookieJar();
    const tabA = new TrackerHarness({ jar });
    const tabB = new TrackerHarness({ jar });
    tabA.load();
    tabB.load();
    vi.setSystemTime(new Date('2026-10-23T12:01:00Z'));
    tabA.intervals[0]();
    tabB.intervals[0]();
    expect(tabA.requests.at(-1)).toMatchObject({ t: 'ping', d: 60_000, sid: tabB.requests[0].sid });
    expect(tabB.requests.at(-1)).toMatchObject({ t: 'ping', d: 60_000, sid: tabA.requests[0].sid });

    vi.setSystemTime(new Date('2026-10-23T12:01:02.400Z'));
    tabA.setVisibility('hidden');
    expect(tabA.requests.at(-1)).toMatchObject({ t: 'ping', d: 2_400 });
  });

  it('stops automatic minute pings after thirty intervals until a pageview resets the counter', () => {
    const tracker = new TrackerHarness();
    tracker.load();
    for (let minute = 1; minute <= 31; minute++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 23, 12, minute)));
      tracker.intervals[0]();
    }
    expect(tracker.requests.filter((request) => request.t === 'ping')).toHaveLength(30);
    tracker.push('/next');
    // Navigation flushes the visible minute accumulated after the automatic cap,
    // then the new page resets the cap and the following interval sends again.
    expect(tracker.requests.filter((request) => request.t === 'ping')).toHaveLength(31);
    vi.setSystemTime(new Date('2026-10-23T12:32:00Z'));
    tracker.intervals[0]();
    expect(tracker.requests.filter((request) => request.t === 'ping')).toHaveLength(32);
  });

  it('uses beacon when accepted and falls back to fetch when beacon declines', async () => {
    const accepted = new TrackerHarness({ sendBeacon: true });
    accepted.load();
    accepted.call('goal', 'signup');
    expect(accepted.requests).toHaveLength(1);
    expect(JSON.parse(await accepted.beacons[0].text())).toMatchObject({ t: 'goal', n: 'signup' });

    const declined = new TrackerHarness({ sendBeacon: false });
    declined.load();
    declined.call('goal', 'signup');
    expect(declined.beacons).toHaveLength(1);
    expect(declined.requests.at(-1)).toMatchObject({ t: 'goal', n: 'signup' });
    expect(JSON.parse(await declined.beacons[0].text()).eid).toBe(declined.requests.at(-1)?.eid);
  });

  it('does not retry a failed fetch', async () => {
    const tracker = new TrackerHarness();
    tracker.runtime.fetch = (_endpoint: string, init: { body: string }) => {
      tracker.requests.push(JSON.parse(init.body));
      return Promise.reject(new Error('offline'));
    };
    tracker.load();
    await Promise.resolve();
    expect(tracker.requests).toHaveLength(1);
  });

  it('honors ml_ignore, webdriver, and localhost suppression', () => {
    const ignored = new TrackerHarness({ url: 'https://example.com/?ml_ignore=true' });
    ignored.load();
    ignored.call('goal', 'nope');
    expect(ignored.requests).toHaveLength(0);

    const webdriver = new TrackerHarness({ webdriver: true });
    webdriver.load();
    expect(webdriver.requests).toHaveLength(0);

    const local = new TrackerHarness({ url: 'http://localhost:3000/' });
    local.load();
    expect(local.requests).toHaveLength(0);

    const allowed = new TrackerHarness({ url: 'http://localhost:3000/', allowLocalhost: true });
    allowed.load();
    expect(allowed.requests).toHaveLength(1);
  });

  it('removes denylisted private query parameters before transport', () => {
    const tracker = new TrackerHarness({
      url: 'https://example.com/thanks?email=a%40example.com&token=secret&utm_source=reddit&order=42',
    });
    tracker.load();
    expect(tracker.requests[0].u).toBe('https://example.com/thanks?utm_source=reddit&order=42');
  });
});

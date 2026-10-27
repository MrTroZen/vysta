import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { classify } from '../src/shared/sources';
import { belongsTo, normalizePath } from '../src/worker/collect';
import { verifyStandardWebhook } from '../src/worker/lib/crypto';
import { isAllowedOrigin, SECURITY_HEADERS } from '../src/worker/lib/security';
import { bucketLabels, previousPeriodStart, resolveRange, startOfDay, tzOffset } from '../src/worker/lib/time';
import { isBot, parseUA } from '../src/worker/lib/ua';

describe('classify', () => {
  const sourceFixtures = [
    ['google.co.uk', 'Google', 'Organic Search'],
    ['www.bing.com', 'Bing', 'Organic Search'],
    ['duckduckgo.com', 'DuckDuckGo', 'Organic Search'],
    ['search.yahoo.com', 'Yahoo', 'Organic Search'],
    ['m.facebook.com', 'Facebook', 'Organic Social'],
    ['l.instagram.com', 'Instagram', 'Organic Social'],
    ['lnkd.in', 'LinkedIn', 'Organic Social'],
    ['mobile.twitter.com', 'X', 'Organic Social'],
    ['out.reddit.com', 'Reddit', 'Organic Social'],
    ['m.youtube.com', 'YouTube', 'Organic Social'],
    ['vm.tiktok.com', 'TikTok', 'Organic Social'],
    ['chatgpt.com', 'ChatGPT', 'AI'],
    ['www.perplexity.ai', 'Perplexity', 'AI'],
    ['claude.ai', 'Claude', 'AI'],
    ['gemini.google.com', 'Gemini', 'AI'],
  ] as const;

  it.each(sourceFixtures)('maps %s to %s / %s', (referrerDomain, source, channel) => {
    expect(classify({ referrerDomain })).toMatchObject({ source, channel });
  });

  it('maps t.co to X / social', () => {
    expect(classify({ referrerDomain: 't.co' })).toMatchObject({ source: 'X', channel: 'Organic Social' });
  });
  it('maps Google to organic search', () => {
    expect(classify({ referrerDomain: 'google.co.in' })).toMatchObject({ source: 'Google', channel: 'Organic Search' });
  });
  it('recognises AI assistants, including utm_source=chatgpt.com', () => {
    expect(classify({ referrerDomain: null, utmSource: 'chatgpt.com' })).toMatchObject({ source: 'ChatGPT', channel: 'AI' });
  });
  it('lets ref/utm tags win over the referrer', () => {
    expect(classify({ referrerDomain: 'google.com', ref: 'producthunt' })).toMatchObject({ source: 'Product Hunt' });
    expect(classify({ referrerDomain: null, ref: 'my-newsletter-42' })).toMatchObject({ source: 'my-newsletter-42', channel: 'Referral' });
  });
  it('gives utm_source precedence over ref when both are present', () => {
    expect(classify({ referrerDomain: null, utmSource: 'linkedin', ref: 'reddit' })).toMatchObject({
      source: 'LinkedIn',
      channel: 'Organic Social',
    });
  });
  it.each([
    ['utm_source', { utmSource: 'partner-42' }, 'partner-42'],
    ['ref', { ref: 'launch-tweet-42' }, 'launch-tweet-42'],
  ] as const)('keeps an unknown explicit %s ahead of a known HTTP referrer', (_label, explicit, source) => {
    expect(classify({ referrerDomain: 'google.com', ...explicit })).toMatchObject({
      source,
      channel: 'Referral',
    });
  });
  it.each([
    ['cpc', 'Paid'],
    ['newsletter', 'Email'],
    ['social', 'Organic Social'],
  ] as const)('keeps %s medium precedence for an explicit custom source', (utmMedium, channel) => {
    expect(classify({ referrerDomain: 'google.com', utmSource: 'partner-42', utmMedium })).toMatchObject({
      source: 'partner-42',
      channel,
    });
  });
  it('keeps a generic external referrer as its source', () => {
    expect(classify({ referrerDomain: 'news.example.org' })).toMatchObject({
      source: 'news.example.org',
      channel: 'Referral',
    });
  });
  it('detects paid and email by medium', () => {
    expect(classify({ referrerDomain: 'google.com', utmMedium: 'cpc' }).channel).toBe('Paid');
    expect(classify({ referrerDomain: null, utmSource: 'buttondown', utmMedium: 'email' }).channel).toBe('Email');
  });
  it('falls back to Direct', () => {
    expect(classify({ referrerDomain: null })).toMatchObject({ source: 'Direct/None', channel: 'Direct' });
  });
  it('does not confuse mail.google.com with Google search', () => {
    expect(classify({ referrerDomain: 'mail.google.com' })).toMatchObject({ source: 'Gmail', channel: 'Email' });
  });
});

describe('user agents', () => {
  it('parses common browsers', () => {
    expect(parseUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toEqual({ browser: 'Mobile Safari', os: 'iOS', device: 'Mobile' });
    expect(parseUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0')).toEqual({ browser: 'Edge', os: 'Windows', device: 'Desktop' });
    expect(parseUA('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36').browser).toBe('Chrome');
  });
  it('flags bots', () => {
    expect(isBot('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe(true);
    expect(isBot('Mozilla/5.0 HeadlessChrome/120')).toBe(true);
    expect(isBot('')).toBe(true);
    expect(isBot('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36')).toBe(false);
  });
  it('separates automation from legitimate privacy browsers', () => {
    expect(isBot('Mozilla/5.0 AppleWebKit/537.36 Chrome/129 Safari/537.36 Brave/1.71')).toBe(false);
    expect(isBot('Mozilla/5.0 AppleWebKit/537.36 Chrome/129 Safari/537.36 DuckDuckGo/7')).toBe(false);
    expect(isBot('curl/8.10.1')).toBe(true);
    expect(isBot('python-requests/2.32')).toBe(true);
    // A scripted request that copies a normal browser UA is intentionally indistinguishable here.
    expect(isBot('Mozilla/5.0 AppleWebKit/537.36 Chrome/129 Safari/537.36')).toBe(false);
  });
});

describe('domains and paths', () => {
  it('accepts subdomains only', () => {
    expect(belongsTo('app.shipkit.dev', 'shipkit.dev')).toBe(true);
    expect(belongsTo('www.shipkit.dev', 'shipkit.dev')).toBe(true);
    expect(belongsTo('evilshipkit.dev', 'shipkit.dev')).toBe(false);
  });
  it('normalises paths', () => {
    expect(normalizePath('/pricing/')).toBe('/pricing');
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('/caf%C3%A9')).toBe('/café');
  });
});

describe('time ranges', () => {
  const now = Date.UTC(2026, 9, 23, 12, 0); // 23 Oct 2026 12:00 UTC
  it('computes timezone offsets', () => {
    expect(tzOffset('Asia/Kolkata', now)).toBe(330 * 60_000);
    expect(tzOffset('UTC', now)).toBe(0);
  });
  it('starts "today" at local midnight', () => {
    const r = resolveRange({ period: 'today' }, 'Asia/Kolkata', 0, now);
    expect(r.from).toBe(Date.UTC(2026, 9, 22, 18, 30));
    expect(r.granularity).toBe('hour');
  });
  it('last 30 days covers 30 local days', () => {
    const r = resolveRange({ period: '30d' }, 'UTC', 0, now);
    expect(r.from).toBe(startOfDay(now, 'UTC') - 29 * 86_400_000);
    expect(bucketLabels(r, 0)).toHaveLength(30);
  });
  it('custom ranges include the whole last day', () => {
    const r = resolveRange({ period: 'custom', from: '2026-10-01', to: '2026-10-07' }, 'UTC', 0, now);
    expect(r.to - r.from).toBe(7 * 86_400_000);
  });
  it('weekly buckets start on Monday', () => {
    const r = resolveRange({ period: '30d', granularity: 'week' }, 'UTC', 0, now);
    for (const l of bucketLabels(r, 0)) expect(new Date(l + 'T00:00:00Z').getUTCDay()).toBe(1);
  });
  it('uses the offset at local midnight on a DST transition day', () => {
    const afterLondonSpringForward = Date.UTC(2026, 2, 29, 12, 0);
    expect(startOfDay(afterLondonSpringForward, 'Europe/London')).toBe(Date.UTC(2026, 2, 29, 0, 0));
  });
  it('makes the London spring-forward day 23 hours with no local 01:00 bucket', () => {
    const r = resolveRange(
      { period: 'custom', from: '2026-03-29', to: '2026-03-29', granularity: 'hour' },
      'Europe/London',
      0,
      Date.UTC(2026, 2, 30, 12),
    );
    expect(r).toMatchObject({ from: Date.UTC(2026, 2, 29), to: Date.UTC(2026, 2, 29, 23) });
    const labels = bucketLabels(r, 'Europe/London');
    expect(labels).toHaveLength(23);
    expect(labels).not.toContain('2026-03-29T01:00');
    expect(previousPeriodStart(r, 'Europe/London')).toBe(Date.UTC(2026, 2, 28));
  });
  it('makes the London fall-back day 25 hours and merges the repeated local hour label', () => {
    const r = resolveRange(
      { period: 'custom', from: '2026-10-25', to: '2026-10-25', granularity: 'hour' },
      'Europe/London',
      0,
      Date.UTC(2026, 9, 26, 12),
    );
    expect(r).toMatchObject({ from: Date.UTC(2026, 9, 24, 23), to: Date.UTC(2026, 9, 26) });
    const labels = bucketLabels(r, 'Europe/London');
    expect(labels).toHaveLength(24);
    expect(labels.filter((label) => label === '2026-10-25T01:00')).toHaveLength(1);
    expect(previousPeriodStart(r, 'Europe/London')).toBe(Date.UTC(2026, 9, 23, 23));
  });
  it('keeps a non-DST Dhaka day at 24 hours', () => {
    const r = resolveRange(
      { period: 'custom', from: '2026-06-01', to: '2026-06-01', granularity: 'hour' },
      'Asia/Dhaka',
      0,
      Date.UTC(2026, 5, 2, 12),
    );
    expect(r.to - r.from).toBe(24 * 3_600_000);
    expect(r.from).toBe(Date.UTC(2026, 4, 31, 18));
    expect(bucketLabels(r, 'Asia/Dhaka')).toHaveLength(24);
  });
});

describe('Standard Webhooks (Dodo)', () => {
  const key = Buffer.from('super-secret-key-bytes');
  const secret = 'whsec_' + key.toString('base64');
  const body = '{"type":"payment.succeeded"}';
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', key).update(`msg_1.${ts}.${body}`).digest('base64');
  it('accepts a valid signature (also among several)', async () => {
    expect(await verifyStandardWebhook(secret, { id: 'msg_1', timestamp: ts, signature: `v1,${sig}` }, body)).toBe(true);
    expect(await verifyStandardWebhook(secret, { id: 'msg_1', timestamp: ts, signature: `v1,old v1,${sig}` }, body)).toBe(true);
  });
  it('rejects tampering and stale timestamps', async () => {
    expect(await verifyStandardWebhook(secret, { id: 'msg_1', timestamp: ts, signature: `v1,${sig}` }, body + ' ')).toBe(false);
    expect(await verifyStandardWebhook(secret, { id: 'msg_1', timestamp: String(Number(ts) - 3600), signature: `v1,${sig}` }, body)).toBe(false);
  });
});

describe('security baseline', () => {
  it('defines defensive security headers', () => {
    expect(SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
    expect(SECURITY_HEADERS['X-Frame-Options']).toBe('DENY');
    expect(SECURITY_HEADERS['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(SECURITY_HEADERS['Permissions-Policy']).toBeDefined();
  });

  const mockHeaders = (map: Record<string, string>) => ({
    get: (k: string) => map[k.toLowerCase()] ?? null,
  });

  it('blocks sec-fetch-site cross-site requests', () => {
    const headers = mockHeaders({ 'sec-fetch-site': 'cross-site' });
    expect(isAllowedOrigin(headers, 'https://vysta.example.com/api/sites')).toBe(false);
  });

  it('allows same-origin requests matching request host', () => {
    const headers = mockHeaders({
      host: 'vysta.example.com',
      origin: 'https://vysta.example.com',
    });
    expect(isAllowedOrigin(headers, 'https://vysta.example.com/api/sites')).toBe(true);
  });

  it('rejects cross-origin requests from foreign domains', () => {
    const headers = mockHeaders({
      host: 'vysta.example.com',
      origin: 'https://malicious.example.com',
    });
    expect(isAllowedOrigin(headers, 'https://vysta.example.com/api/sites')).toBe(false);
  });

  it('allows local development proxying across localhost ports', () => {
    const headers = mockHeaders({
      host: 'localhost:8787',
      origin: 'http://localhost:5173',
    });
    expect(isAllowedOrigin(headers, 'http://localhost:8787/api/sites')).toBe(true);
  });

  it('allows requests without origin header (direct API / curl)', () => {
    const headers = mockHeaders({ host: 'vysta.example.com' });
    expect(isAllowedOrigin(headers, 'https://vysta.example.com/api/sites')).toBe(true);
  });
});

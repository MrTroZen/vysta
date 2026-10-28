# Vysta Tracking & Integration Guide

This guide describes how to install, configure, verify, and customize the Vysta analytics tracker on production websites.

---

## 1. Quick Start: Standard Installation Snippet

Embed the lightweight (9 KB / 3.5 KB gzipped), dependency-free tracking script in the `<head>` of your website or application template:

```html
<script defer data-website-id="YOUR_SITE_ID" src="https://vysta-production.vysta.workers.dev/js/script.js"></script>
```

### Script Attributes Reference
| Attribute | Required | Description | Example |
| :--- | :--- | :--- | :--- |
| `data-website-id` | **Yes** | The public 16-character alphanumeric routing token generated when creating the site in Vysta. | `data-website-id="1u4b6w5o0n1q696u"` |
| `src` | **Yes** | The absolute URL serving `script.js` from the Vysta production Worker. | `https://vysta-production.vysta.workers.dev/js/script.js` |
| `defer` | Recommended | Ensures script downloads asynchronously without blocking HTML parsing. | `defer` |
| `data-domain` | Optional | Shared root domain for tracking cross-subdomain sessions via first-party cookies. | `data-domain="example.com"` |
| `data-allow-localhost` | Optional | Allows tracking on `localhost` and `127.0.0.1` during testing. | `data-allow-localhost` |
| `data-api` | Optional | Custom endpoint destination for event ingestion. Defaults to `<script.src origin>/api/event`. | `data-api="/api/event"` |

---

## 2. Architecture & Data Endpoints

- **Tracker Source:** `https://vysta-production.vysta.workers.dev/js/script.js` (Cached via Cloudflare CDN edge; `Access-Control-Allow-Origin: *`).
- **Ingestion Endpoint:** `POST https://vysta-production.vysta.workers.dev/api/event`
  - Payload format: `text/plain` JSON string (bypasses browser CORS preflight requests for maximum performance).
  - Transport: Browser `navigator.sendBeacon()` with fallback to keepalive `fetch()`.

---

## 3. Site Creation & Routing

1. In the Vysta dashboard, click **Add website**.
2. Enter:
   - **Domain:** Primary apex or subdomain (e.g., `example.com`). Both `example.com` and `www.example.com` are automatically handled.
   - **Timezone:** Local timezone for reporting daily midnight boundaries (e.g., `Europe/London`).
   - **Currency:** Primary currency (e.g., `GBP`, `USD`, `EUR`).
3. Copy the generated `data-website-id`. Note: The Website ID is a public routing identifier, not an authentication secret.

---

## 4. Supported Events & Automatic Tracking

### Automatic Tracking
- **Pageviews:** Dispatched on initial page load and on client-side route transitions in Single Page Applications (Next.js, React Router, Vue, SvelteKit, etc.) via History API monkey-patching.
- **Engaged Duration:** Periodic heartbeat pings flush active, tab-visible time (up to 24 hours maximum per session).
- **Outbound Link Clicks:** Automatically captured when a user clicks an `<a>` tag leading to a different domain.
- **Contact intent:** `tel:`, WhatsApp, and `mailto:` link clicks are recorded as stable generic actions. Vysta does not send the destination URL, phone number, email address, or prefilled message.
- **Form intent:** Native HTML `submit` events are recorded as a generic action. Form contents, field names, field values, and action URLs are not sent.
- **Acquisition Attribution:** UTM parameters (`utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`), `ref` query strings, and HTTP Referrer headers are captured once upon session creation.

Automatic contact/form actions are intent signals. They do not prove that a call connected, a message was delivered, a form was accepted by the server, or a lead became a customer.

### No-code confirmed outcomes

In Site Settings, an owner can give a success-page path an owner-friendly outcome name, such as `/thank-you` → “Lead submitted.” Rules can match one exact normalized path or a path and its child segments. Matching uses no domain, query-string value, fragment, form field, or page content.

An enabled rule records its confirmed outcome once per visit when Vysta accepts a matching page view, including History API SPA navigation. Paused rules do not fire. These configured outcomes are reported separately from automatic contact/form intent and other custom actions. Internal names beginning with `__vysta_outcome_` are reserved and are rejected by browser and server goal ingestion.

### Custom Actions and Confirmed Outcomes
Track site-specific interactions using HTML data attributes or the JavaScript API. Use the server API for confirmed backend outcomes:

#### Option A: Declarative HTML Attributes
Attach `data-ml-goal` to any clickable element (buttons, links, forms):
```html
<button data-ml-goal="booking_start">Book Driving Lesson</button>
<a href="/contact" data-ml-goal="contact_phone">Call Office</a>
```

#### Option B: JavaScript Client API
Trigger programmatic goals anywhere in application code:
```javascript
window.minilytics('goal', 'booking_start', { plan: 'standard', source: 'pricing_table' });
```
*(The global `window.minilytics` stub queues events safely if called before `script.js` finishes loading).*

#### Option C: Server-Side Goals API
For webhook-verified backend events (e.g., CRM leads, completed payments):
```bash
curl -X POST https://vysta-production.vysta.workers.dev/api/v1/goals \
  -H "Authorization: Bearer <SITE_API_KEY>" \
  -H "Idempotency-Key: booking_<DURABLE_BUSINESS_ID>" \
  -H "Content-Type: application/json" \
  -d '{"name": "booking_complete", "session_id": "sid_...", "properties": {"amount": 45}}'
```

Send `name` plus either the captured `session_id` or `visitor_id`. A supplied session ID is used exactly and must belong to the visitor when both IDs are sent; without it, Vysta uses that visitor's latest session. Sessions must have been active within the last 30 days. Use a durable, unique `Idempotency-Key` header (or `idempotency_key` body field) for confirmed backend outcomes: retrying the same request is safe, while reusing the key for different content returns `409`. Legacy `props` and requests without an idempotency key remain accepted, but unkeyed retries are not deduplicated.

### Tracking health interpretation

Site Settings reports browser tracking and server-side goals separately:

- **Tracking requests** include valid tracker calls, maintenance calls such as pings/identify, safe retries, and site-scoped warnings.
- **Analytics events recorded** include only page views, browser goals, and outbound clicks that were added to reports.
- **Server-side goals — Not used** means this site has never called the server-goal endpoint. It is neutral and requires no action.
- **Working** means Vysta recently received valid data for this site; it does not prove the script is installed on every page.

Recent counters use UTC hourly aggregates. Vysta keeps 30 days (720 hourly buckets), stores no rejected request bodies, and shows technical reason codes only inside warning details.

---

## 5. Event Naming Conventions

Configured action names should use **`lower_snake_case`** for consistent dashboard reporting and funnel aggregation. Names beginning with `__vysta_` are reserved by Vysta for automatic intent and configured outcome events.

| Goal Name | Trigger / Context |
| :--- | :--- |
| `booking_start` | User initiates checkout or opens booking calendar |
| `booking_complete` | User completes payment or appointment reservation |

---

## 6. Framework Installation Patterns

### Next.js (App Router)
In `app/layout.tsx`:
```tsx
import Script from 'next/script';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <Script
          defer
          data-website-id="YOUR_SITE_ID"
          src="https://vysta-production.vysta.workers.dev/js/script.js"
          strategy="afterInteractive"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
```

### Static HTML / WordPress
Add the standard snippet into `header.php` immediately before `</head>`:
```php
<script defer data-website-id="YOUR_SITE_ID" src="https://vysta-production.vysta.workers.dev/js/script.js"></script>
```

### Google Tag Manager (GTM)
1. Add a **Custom HTML Tag**.
2. Paste the snippet.
3. Trigger on **All Pages** (or after Cookie Consent event if required).

---

## 7. Privacy, Consent & Internal Traffic Exclusion

### GDPR / Cookie-Consent Handling
- Vysta uses first-party session cookies (`ml_vid`, `ml_sid`) and does not perform cross-site tracking or profile fingerprinting.
- If your website uses a Consent Management Platform (Cookiebot, OneTrust, Termly), conditionally inject the script tag or trigger the GTM tag upon user analytics consent.

### Internal Exclusion (Developer / Tester Opt-Out)
To prevent internal team visits from skewing analytics data:
1. Visit your website with `?ml_ignore=true` in the URL (e.g., `https://example.com/?ml_ignore=true`).
2. The tracker sets `localStorage.setItem('ml_ignore', '1')` and stops tracking all subsequent sessions from that browser.
3. To re-enable tracking on that browser, navigate to `https://example.com/?ml_ignore=false`.

---

## 8. First-Site QA & Verification Checklist

- [ ] Script tag loads with HTTP 200 from `https://vysta-production.vysta.workers.dev/js/script.js`.
- [ ] No browser console errors (`minilytics is not defined`, CORS, or CSP violations).
- [ ] Initial pageview sends `POST /api/event` returning HTTP 202.
- [ ] Visitor and session appear in dashboard **Realtime / Live View**.
- [ ] Navigating between pages records SPA pageviews without duplicate events.
- [ ] Phone, WhatsApp, email, and native form actions appear without destination or form details.
- [ ] Configured action triggers continue to record their named events in the dashboard.
- [ ] UTM acquisition tags appear correctly under **Sources & Campaigns**.
- [ ] Both desktop and mobile form factors record appropriate device/browser classifications.


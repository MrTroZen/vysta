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
- **Acquisition Attribution:** UTM parameters (`utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`), `ref` query strings, and HTTP Referrer headers are captured once upon session creation.

### Custom Conversion Goals
Track key user interactions using HTML data attributes, JavaScript API, or server-side calls:

#### Option A: Declarative HTML Attributes
Attach `data-ml-goal` to any clickable element (buttons, links, forms):
```html
<button data-ml-goal="booking_start">Book Driving Lesson</button>
<a href="/contact" data-ml-goal="contact_phone">Call Office</a>
```

#### Option B: JavaScript Client API
Trigger programmatic goals anywhere in application code:
```javascript
window.minilytics('lead_form_submit', { plan: 'standard', source: 'pricing_table' });
```
*(The global `window.minilytics` stub queues events safely if called before `script.js` finishes loading).*

#### Option C: Server-Side Goals API
For webhook-verified backend events (e.g., CRM leads, completed payments):
```bash
curl -X POST https://vysta-production.vysta.workers.dev/api/v1/goals \
  -H "Authorization: Bearer <SITE_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"name": "booking_complete", "session_id": "sid_...", "properties": {"amount": 45}}'
```

---

## 5. Event Naming Conventions

All goal names must follow strict **`lower_snake_case`** for consistent dashboard reporting and funnel aggregation:

| Goal Name | Trigger / Context |
| :--- | :--- |
| `contact_whatsapp` | User clicks WhatsApp chat link |
| `contact_phone` | User clicks telephone number link (`tel:`) |
| `lead_form_submit` | User successfully submits an enquiry or contact form |
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
- [ ] Goal triggers record corresponding events in dashboard.
- [ ] UTM acquisition tags appear correctly under **Sources & Campaigns**.
- [ ] Both desktop and mobile form factors record appropriate device/browser classifications.

---

## 9. Production Case Study: Smart Driving School (`smart-drivingschool.co.uk`)

### Configuration Overview
- **Domain:** `smart-drivingschool.co.uk`
- **Site Name:** Smart Driving School
- **Timezone:** `Europe/London`
- **Currency:** `GBP`
- **Site ID:** `712t666h1x2v0306`
- **Platform:** WordPress 7.1 (Apache, `udrive` / `udrive-child` theme, Elementor, Contact Form 7, Autoptimize)

### Production Tracking Snippet
```html
<!-- Vysta Analytics Tracker -->
<script defer data-website-id="712t666h1x2v0306" src="https://vysta-production.vysta.workers.dev/js/script.js"></script>

<!-- Smart Driving School Automated Goal Tracking Companion -->
<script>
(function() {
  function getVysta() {
    return window.minilytics || function() { (window.minilytics.q = window.minilytics.q || []).push(arguments); };
  }

  // 1. Lead Form Submissions (Contact Form 7: #wpcf7-f2028-p10-o1, #wpcf7-f2082-p566-o1, #wpcf7-f423)
  document.addEventListener('wpcf7mailsent', function(e) {
    var v = getVysta();
    var formId = e.detail ? e.detail.contactFormId : (e.target ? e.target.id : 'form');
    v('goal', 'lead_form_submit', { form_id: String(formId) });
  }, false);

  // 2. Click-based conversion goals (Delegated click listener)
  document.addEventListener('click', function(e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    var text = (a.innerText || a.textContent || '').trim().toLowerCase();
    var v = getVysta();

    // WhatsApp Clicks
    if (/wa\.me|api\.whatsapp\.com/i.test(href) || a.closest('.chaty-widget') || a.closest('[data-channel="whatsapp"]')) {
      if (text.includes('tester') || href.includes('tester')) {
        v('goal', 'tester_lesson_click', { channel: 'whatsapp' });
      }
      v('goal', 'contact_whatsapp', { href: href.slice(0, 100) });
      return;
    }

    // Telephone Call Clicks
    if (/^tel:/i.test(href)) {
      if (text.includes('tester')) {
        v('goal', 'tester_lesson_click', { channel: 'phone' });
      }
      v('goal', 'contact_phone', { phone: href.replace(/^tel:/i, '').trim() });
      return;
    }

    // Tester Lesson Dedicated CTA Clicks
    if (text.includes('tester lesson') || href.includes('first-driving-lesson')) {
      v('goal', 'tester_lesson_click', { text: text.slice(0, 50) });
      return;
    }

    // Booking Start CTA Clicks ("Book Now" links leading to /contact/ or enquiry form)
    if (text === 'book now' || text.includes('book your') || href.includes('/contact/')) {
      if (text.includes('tester')) {
        v('goal', 'tester_lesson_click', { type: 'book_tester' });
      } else if (text === 'book now' || text.includes('book')) {
        v('goal', 'booking_start', { text: text.slice(0, 50) });
      }
    }
  }, true);
})();
</script>
```

### Installation Method in WordPress
Add the combined snippet into `wp-content/themes/udrive-child/functions.php`:
```php
add_action('wp_head', function () {
    ?>
    <script defer data-website-id="712t666h1x2v0306" src="https://vysta-production.vysta.workers.dev/js/script.js"></script>
    <script>
    (function() {
      function getVysta() {
        return window.minilytics || function() { (window.minilytics.q = window.minilytics.q || []).push(arguments); };
      }
      document.addEventListener('wpcf7mailsent', function(e) {
        var v = getVysta();
        var formId = e.detail ? e.detail.contactFormId : (e.target ? e.target.id : 'form');
        v('goal', 'lead_form_submit', { form_id: String(formId) });
      }, false);
      document.addEventListener('click', function(e) {
        var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        if (!a) return;
        var href = a.getAttribute('href') || '';
        var text = (a.innerText || a.textContent || '').trim().toLowerCase();
        var v = getVysta();
        if (/wa\.me|api\.whatsapp\.com/i.test(href) || a.closest('.chaty-widget') || a.closest('[data-channel="whatsapp"]')) {
          if (text.includes('tester') || href.includes('tester')) {
            v('goal', 'tester_lesson_click', { channel: 'whatsapp' });
          }
          v('goal', 'contact_whatsapp', { href: href.slice(0, 100) });
          return;
        }
        if (/^tel:/i.test(href)) {
          if (text.includes('tester')) {
            v('goal', 'tester_lesson_click', { channel: 'phone' });
          }
          v('goal', 'contact_phone', { phone: href.replace(/^tel:/i, '').trim() });
          return;
        }
        if (text.includes('tester lesson') || href.includes('first-driving-lesson')) {
          v('goal', 'tester_lesson_click', { text: text.slice(0, 50) });
          return;
        }
        if (text === 'book now' || text.includes('book your') || href.includes('/contact/')) {
          if (text.includes('tester')) {
            v('goal', 'tester_lesson_click', { type: 'book_tester' });
          } else if (text === 'book now' || text.includes('book')) {
            v('goal', 'booking_start', { text: text.slice(0, 50) });
          }
        }
      }, true);
    })();
    </script>
    <?php
});
```
Or insert via the **WPCode** plugin (`Header Scripts`) or Cloudflare Zaraz.


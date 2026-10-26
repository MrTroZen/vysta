export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

/**
 * Validates request origin and sec-fetch-site metadata to block cross-site request forgery (CSRF)
 * on mutating dashboard endpoints. Allows same-origin, trusted local development ports, and non-browser callers.
 */
export function isAllowedOrigin(
  headers: { get(name: string): string | null },
  url: string,
): boolean {
  const fetchSite = headers.get('sec-fetch-site');
  if (fetchSite === 'cross-site') return false;

  const origin = headers.get('origin');
  if (!origin) return true;

  try {
    const originHost = new URL(origin).host.toLowerCase();
    const reqHost = (headers.get('host') || new URL(url).host).toLowerCase();

    if (originHost === reqHost) return true;

    // Allow local development proxying (e.g. Vite on port 5173 -> Wrangler on port 8787)
    const isLocal = (h: string) =>
      h.startsWith('localhost:') || h === 'localhost' || h.startsWith('127.0.0.1:') || h === '127.0.0.1';

    if (isLocal(originHost) && isLocal(reqHost)) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

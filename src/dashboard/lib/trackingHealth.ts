import type { TrackingHealth } from '../../worker/trackingHealth';

export type HealthTone = 'good' | 'neutral' | 'warning';
export type HealthState = { label: string; message: string; tone: HealthTone };

export function browserHealthState(browser: TrackingHealth['browser']): HealthState {
  if (browser.warnings24h > 0 && browser.analyticsEvents24h > 0) {
    return { label: 'Working with warnings', message: 'Analytics events are being recorded, but some recent requests need attention.', tone: 'warning' };
  }
  if (browser.warnings24h > 0) {
    return { label: 'Needs attention', message: 'Recent tracking requests were received, but they did not record analytics events.', tone: 'warning' };
  }
  if (browser.analyticsEvents24h > 0) {
    return { label: 'Working', message: 'Recent page views, goals, or outbound clicks are being recorded.', tone: 'good' };
  }
  if (browser.requests24h > 0) {
    return {
      label: 'Requests only',
      message: 'Tracking requests are arriving, but no page views, goals, or outbound clicks were recorded recently.',
      tone: 'neutral',
    };
  }
  if (browser.lastRequestAt) {
    return { label: 'No recent data', message: 'Vysta has seen this tracker before, but no tracking requests arrived recently.', tone: 'neutral' };
  }
  return { label: 'Waiting for data', message: 'No tracking requests have reached Vysta for this site yet.', tone: 'neutral' };
}

export function serverGoalHealthState(serverGoals: TrackingHealth['serverGoals']): HealthState {
  if (!serverGoals.lastRequestAt) {
    return { label: 'Not used', message: 'No server-side goal requests have been sent for this site.', tone: 'neutral' };
  }
  if (serverGoals.warnings24h > 0 && serverGoals.recorded24h > 0) {
    return { label: 'Working with warnings', message: 'Server-side goals are being recorded, but some recent requests need attention.', tone: 'warning' };
  }
  if (serverGoals.warnings24h > 0) {
    return { label: 'Needs attention', message: 'Recent server-side goal requests did not record a goal.', tone: 'warning' };
  }
  if (serverGoals.recorded24h > 0) {
    return { label: 'Working', message: 'Recent server-side goals were recorded successfully.', tone: 'good' };
  }
  if (serverGoals.duplicates24h > 0) {
    return { label: 'Retries received', message: 'Recent retries were safely ignored because their goals were already recorded.', tone: 'neutral' };
  }
  return { label: 'No recent goals', message: 'Server-side goals were used before, but none were recorded recently.', tone: 'neutral' };
}

const BROWSER_WARNING_COPY: Record<string, string> = {
  inactive_plan: 'Tracking was paused while the site owner plan was inactive.',
  invalid_domain: 'Requests came from a domain that does not match this site.',
  invalid_event: 'Some event requests were missing required event details.',
  invalid_goal: 'Some browser goal requests were missing a goal name.',
  invalid_url: 'Some requests contained an invalid page URL.',
  session_mismatch: 'Some requests used a session that belongs to a different visitor.',
};

const SERVER_WARNING_COPY: Record<string, string> = {
  idempotency_conflict: 'An idempotency key was reused for a different server goal.',
  invalid_idempotency_key: 'Some server goals used an invalid or conflicting idempotency key.',
  invalid_request: 'Some server goals were missing a name or visitor/session ID.',
  receipt_failed: 'Vysta could not confirm that a server goal receipt was stored.',
  session_mismatch: 'A server goal supplied visitor and session IDs that do not belong together.',
  session_not_found: 'Vysta could not find a matching session active within the last 30 days.',
};

export function warningCopy(source: 'browser' | 'server_goal', code: string) {
  const messages = source === 'browser' ? BROWSER_WARNING_COPY : SERVER_WARNING_COPY;
  return messages[code] ?? 'Some requests could not be recorded.';
}

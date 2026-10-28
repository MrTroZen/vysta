import { outcomeEventName, type OutcomeMatchType } from '../shared/outcomeGoals';

export interface OutcomeGoalRule {
  id: string;
  name: string;
  matchType: OutcomeMatchType;
  path: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

interface RuleRow {
  id: string;
  name: string;
  match_type: OutcomeMatchType;
  path: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface OutcomeGoalInput {
  name?: unknown;
  matchType?: unknown;
  path?: unknown;
  enabled?: unknown;
}

export class OutcomeGoalValidationError extends Error {}

function normalizeConfiguredPath(path: string) {
  let value = path;
  try { value = decodeURI(value); } catch {}
  if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

export function validateOutcomeGoal(input: OutcomeGoalInput, current?: OutcomeGoalRule) {
  const rawName = input.name === undefined ? current?.name : input.name;
  const name = typeof rawName === 'string' ? rawName.trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new OutcomeGoalValidationError('Use a goal name between 1 and 64 characters.');
  }

  const matchType = (input.matchType === undefined ? current?.matchType : input.matchType) as OutcomeMatchType;
  if (matchType !== 'exact' && matchType !== 'starts_with') {
    throw new OutcomeGoalValidationError('Choose exact path or path starts with.');
  }

  const rawPath = input.path === undefined ? current?.path : input.path;
  if (typeof rawPath !== 'string') throw new OutcomeGoalValidationError('Enter a page path.');
  const trimmed = rawPath.trim();
  if (
    !trimmed.startsWith('/') ||
    trimmed.length > 300 ||
    trimmed.includes('?') ||
    trimmed.includes('#') ||
    trimmed.includes('://') ||
    trimmed.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    throw new OutcomeGoalValidationError('Enter a path such as /thank-you, without a domain, query string, or # section.');
  }
  const path = normalizeConfiguredPath(trimmed);
  if (path.length > 300 || /[\\?\#\u0000-\u001f\u007f]/.test(path)) {
    throw new OutcomeGoalValidationError('Enter a path such as /thank-you, without a domain, query string, or # section.');
  }
  const enabled = input.enabled === undefined ? current?.enabled ?? true : input.enabled;
  if (typeof enabled !== 'boolean') throw new OutcomeGoalValidationError('Enabled must be true or false.');
  return { name, matchType, path, enabled };
}

export function pathMatchesOutcome(path: string, rule: Pick<OutcomeGoalRule, 'path' | 'matchType'>) {
  if (rule.matchType === 'exact') return path === rule.path;
  if (rule.path === '/') return true;
  return path === rule.path || path.startsWith(`${rule.path}/`);
}

function present(row: RuleRow): OutcomeGoalRule {
  return {
    id: row.id,
    name: row.name,
    matchType: row.match_type,
    path: row.path,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listOutcomeGoals(db: D1Database, siteId: string) {
  const rows = await db.prepare(
    `SELECT id, name, match_type, path, enabled, created_at, updated_at
     FROM outcome_goal_rules WHERE site_id = ? AND deleted_at IS NULL ORDER BY created_at, id`,
  ).bind(siteId).all<RuleRow>();
  return rows.results.map(present);
}

export async function enabledOutcomeGoals(db: D1Database, siteId: string) {
  const rows = await db.prepare(
    `SELECT id, name, match_type, path, enabled, created_at, updated_at
     FROM outcome_goal_rules WHERE site_id = ? AND enabled = 1 AND deleted_at IS NULL ORDER BY created_at, id`,
  ).bind(siteId).all<RuleRow>();
  return rows.results.map(present);
}

export function outcomeStatements(
  db: D1Database,
  siteId: string,
  sessionId: string,
  visitorId: string,
  path: string,
  now: number,
  rules: OutcomeGoalRule[],
) {
  return rules.filter((rule) => pathMatchesOutcome(path, rule)).flatMap((rule) => {
    const token = crypto.randomUUID();
    const predicate = `EXISTS (SELECT 1 FROM outcome_goal_receipts ogr
      WHERE ogr.site_id = ? AND ogr.session_id = ? AND ogr.rule_id = ? AND ogr.processing_token = ?)`;
    const args = [siteId, sessionId, rule.id, token];
    return [
      db.prepare(
        `INSERT OR IGNORE INTO outcome_goal_receipts
         (site_id, session_id, rule_id, processing_token, first_matched_at) VALUES (?, ?, ?, ?, ?)`,
      ).bind(siteId, sessionId, rule.id, token, now),
      db.prepare(`UPDATE sessions SET goals = goals + 1, last_seen_at = ?
        WHERE site_id = ? AND id = ? AND ${predicate}`)
        .bind(now, siteId, sessionId, ...args),
      db.prepare(`INSERT INTO events (site_id, session_id, visitor_id, ts, type, name, path, props)
        SELECT ?, ?, ?, ?, 'goal', ?, ?, NULL WHERE ${predicate}`)
        .bind(siteId, sessionId, visitorId, now, outcomeEventName(rule.id), path, ...args),
    ];
  });
}

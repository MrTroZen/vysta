export const OUTCOME_GOAL_PREFIX = '__vysta_outcome_';

export type OutcomeMatchType = 'exact' | 'starts_with';

export function outcomeEventName(ruleId: string) {
  return `${OUTCOME_GOAL_PREFIX}${ruleId}`;
}

export function isOutcomeEventName(name: unknown): name is string {
  return typeof name === 'string' && name.startsWith(OUTCOME_GOAL_PREFIX);
}

export function outcomeRuleId(name: string) {
  return isOutcomeEventName(name) ? name.slice(OUTCOME_GOAL_PREFIX.length) : null;
}

export type BudgetLimitState = 'normal' | 'warning' | 'reached';

export function getBudgetLimitState(
  usagePercentage: number,
  warningThreshold: number,
): BudgetLimitState {
  if (usagePercentage >= 100) return 'reached';
  return usagePercentage >= warningThreshold ? 'warning' : 'normal';
}

export function normalizeBudgetThreshold(value?: string): number {
  const threshold = Number(value ?? 80);
  return Number.isInteger(threshold) && threshold >= 1 && threshold <= 100
    ? threshold
    : 80;
}

import type { Account, Goal, GoalEntry, PersonEntry, Transaction } from '../../types/models';
import { calculateAccountBalance } from '../finance/FinanceService';
import { parseDateKey, todayLocal } from '../../utils/date';

export function goalEntryDelta(
  type: GoalEntry['type'],
  amountMinor: number,
): number {
  if (type === 'WITHDRAW') return -amountMinor;
  return amountMinor;
}

export function calculateGoalSaved(
  initialSavedMinor: number,
  entries: Pick<GoalEntry, 'type' | 'amount_minor'>[],
): number {
  return (
    initialSavedMinor +
    entries.reduce(
      (sum, entry) => sum + goalEntryDelta(entry.type, entry.amount_minor),
      0,
    )
  );
}

export function calculateGoalRemaining(
  targetMinor: number,
  savedMinor: number,
): number {
  return Math.max(0, targetMinor - savedMinor);
}

export function calculateGoalProgress(
  targetMinor: number,
  savedMinor: number,
): number {
  if (targetMinor <= 0) return 0;
  return Math.min(999, Math.max(0, Math.round((savedMinor / targetMinor) * 100)));
}

export function getGoalOverBalance(
  savedMinor: number,
  linkedAccountId: string | null | undefined,
  accounts: Account[],
  transactions: Transaction[],
  entries: PersonEntry[],
): { balanceMinor: number } | null {
  if (!linkedAccountId) return null;
  const account = accounts.find((item) => item.id === linkedAccountId);
  if (!account) return null;
  const balanceMinor = calculateAccountBalance(account, transactions, entries);
  return savedMinor > balanceMinor ? { balanceMinor } : null;
}

export type GoalStatus = 'IN_PROGRESS' | 'NEEDS_ATTENTION' | 'COMPLETED' | 'ARCHIVED';

export function getGoalStatus(
  goal: Pick<Goal, 'target_amount_minor' | 'target_date' | 'is_archived'>,
  savedMinor: number,
  today = todayLocal(),
): GoalStatus {
  if (goal.is_archived) return 'ARCHIVED';
  if (savedMinor >= goal.target_amount_minor) return 'COMPLETED';
  if (goal.target_date && goal.target_date < today) return 'NEEDS_ATTENTION';
  return 'IN_PROGRESS';
}

export function goalStatusLabel(status: GoalStatus): string {
  if (status === 'COMPLETED') return 'Completed';
  if (status === 'ARCHIVED') return 'Archived';
  if (status === 'NEEDS_ATTENTION') return 'Needs attention';
  return 'In progress';
}

export function calculateSuggestedMonthlySaving(
  remainingMinor: number,
  targetDate?: string | null,
  today = todayLocal(),
): number {
  if (!targetDate || remainingMinor <= 0) return 0;
  const start = parseDateKey(today);
  const target = parseDateKey(targetDate);
  const months = Math.max(
    1,
    (target.getFullYear() - start.getFullYear()) * 12 +
      target.getMonth() -
      start.getMonth(),
  );
  return Math.ceil(remainingMinor / months);
}

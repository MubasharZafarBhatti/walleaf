import type { PersonEntry, Transaction } from '../../types/models';
import { addMonthsNoDrift, monthKey } from '../../utils/date';

type SpendingTransaction = Pick<
  Transaction,
  'type' | 'amount_minor' | 'occurred_on' | 'category_id' | 'deleted_at'
>;

export function isPersonalSpendingTransaction(
  tx: Pick<Transaction, 'type' | 'deleted_at'>,
): boolean {
  return !tx.deleted_at && tx.type === 'EXPENSE';
}

function safeMoneyTotal(total: number, amount: number): number {
  const next = total + amount;
  if (!Number.isSafeInteger(next)) throw new Error('Money total is outside the supported range.');
  return next;
}

export function calculatePersonalSpendingForRange(
  transactions: SpendingTransaction[],
  from: string,
  to: string,
): number {
  return transactions
    .filter((tx) => isPersonalSpendingTransaction(tx) && tx.occurred_on >= from && tx.occurred_on <= to)
    .reduce((sum, tx) => safeMoneyTotal(sum, tx.amount_minor), 0);
}

export function calculateCategoryPersonalSpendingForRange(
  transactions: SpendingTransaction[],
  from: string,
  to: string,
  categoryId: string,
): number {
  return transactions
    .filter(
      (tx) =>
        isPersonalSpendingTransaction(tx) &&
        tx.category_id === categoryId &&
        tx.occurred_on >= from &&
        tx.occurred_on <= to,
    )
    .reduce((sum, tx) => safeMoneyTotal(sum, tx.amount_minor), 0);
}

export function calculatePersonalSpending(
  transactions: Pick<
    Transaction,
    'type' | 'amount_minor' | 'occurred_on' | 'deleted_at'
  >[],
  targetMonth: string,
): number {
  return transactions
    .filter((tx) => isPersonalSpendingTransaction(tx) && tx.occurred_on.startsWith(targetMonth))
    .reduce((sum, tx) => safeMoneyTotal(sum, tx.amount_minor), 0);
}

export const getMonthlyExpenseTotal = calculatePersonalSpending;

export function calculateCategoryPersonalSpending(
  transactions: Pick<
    Transaction,
    'type' | 'amount_minor' | 'occurred_on' | 'category_id' | 'deleted_at'
  >[],
  targetMonth: string,
  categoryId: string,
): number {
  return transactions
    .filter(
      (tx) =>
        isPersonalSpendingTransaction(tx) &&
        tx.category_id === categoryId &&
        tx.occurred_on.startsWith(targetMonth),
    )
    .reduce((sum, tx) => safeMoneyTotal(sum, tx.amount_minor), 0);
}

export const getCategoryExpenseTotal = calculateCategoryPersonalSpending;

export function getBudgetRemaining(
  budgetMinor: number,
  spentMinor: number,
): number {
  return budgetMinor - spentMinor;
}

export function getBudgetUsagePercentage(
  budgetMinor: number,
  spentMinor: number,
): number {
  if (budgetMinor <= 0) return 0;
  return Math.min(999, Math.round((spentMinor / budgetMinor) * 100));
}

export function peopleEntriesExcludedFromBudget(
  _entries: PersonEntry[],
): number {
  return 0;
}

export function calculateDailyBudgetAllowance(
  remainingMinor: number,
  todayDateKey: string,
): number {
  const [, month, day] = todayDateKey.split('-').map(Number);
  const year = Number(todayDateKey.slice(0, 4));
  const daysInMonth = new Date(year, month, 0).getDate();
  const daysRemaining = Math.max(1, daysInMonth - day + 1);
  return Math.max(0, Math.floor(remainingMinor / daysRemaining));
}

export function shiftMonthKey(targetMonth: string, months: number): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(targetMonth))
    throw new Error('Invalid spending plan month.');
  return monthKey(addMonthsNoDrift(`${targetMonth}-01`, months));
}

export type DailyAllowanceState =
  | { kind: 'no-plan' | 'historical' | 'future' | 'exhausted'; allowanceMinor: null; daysRemaining: number }
  | { kind: 'overspent'; allowanceMinor: null; daysRemaining: number; overMinor: number }
  | { kind: 'available'; allowanceMinor: number; daysRemaining: number };

export function getDailyAllowanceState(
  planMinor: number | null,
  spentMinor: number,
  targetMonth: string,
  todayDateKey: string,
): DailyAllowanceState {
  const currentMonth = monthKey(todayDateKey);
  if (planMinor === null) return { kind: 'no-plan', allowanceMinor: null, daysRemaining: 0 };
  if (targetMonth < currentMonth) return { kind: 'historical', allowanceMinor: null, daysRemaining: 0 };
  if (targetMonth > currentMonth) return { kind: 'future', allowanceMinor: null, daysRemaining: 0 };
  const [, month, day] = todayDateKey.split('-').map(Number);
  const year = Number(todayDateKey.slice(0, 4));
  const daysRemaining = Math.max(0, new Date(year, month, 0).getDate() - day + 1);
  const remainingMinor = planMinor - spentMinor;
  if (remainingMinor < 0)
    return { kind: 'overspent', allowanceMinor: null, daysRemaining, overMinor: Math.abs(remainingMinor) };
  if (remainingMinor === 0 || daysRemaining === 0)
    return { kind: 'exhausted', allowanceMinor: null, daysRemaining };
  return {
    kind: 'available',
    allowanceMinor: Math.floor(remainingMinor / daysRemaining),
    daysRemaining,
  };
}

export type ThreeMonthSuggestion = {
  months: [string, string, string];
  monthlySpendingMinor: [number, number, number];
  averageMinor: number;
  hasHistory: boolean;
};

export function getThreeMonthCategorySuggestion(
  transactions: Pick<Transaction, 'type' | 'amount_minor' | 'occurred_on' | 'category_id' | 'deleted_at'>[],
  categoryId: string,
  targetMonth: string,
  todayDateKey: string,
): ThreeMonthSuggestion {
  const lastCompleteMonth = shiftMonthKey(monthKey(todayDateKey), -1);
  const priorToPlan = shiftMonthKey(targetMonth, -1);
  const endMonth = priorToPlan < lastCompleteMonth ? priorToPlan : lastCompleteMonth;
  const months = [shiftMonthKey(endMonth, -2), shiftMonthKey(endMonth, -1), endMonth] as const;
  const monthlySpendingMinor = months.map((month) =>
    calculateCategoryPersonalSpending(transactions, month, categoryId),
  ) as [number, number, number];
  const total = monthlySpendingMinor.reduce((sum, amount) => {
    const next = sum + amount;
    if (!Number.isSafeInteger(next)) throw new Error('Spending history total is too large.');
    return next;
  }, 0);
  return {
    months: [...months],
    monthlySpendingMinor,
    averageMinor: Math.round(total / 3),
    hasHistory: total > 0,
  };
}

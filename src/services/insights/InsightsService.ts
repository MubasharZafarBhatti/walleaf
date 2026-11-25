import type { Account, Category, Person, PersonEntry, Subscription, Transaction } from '../../types/models';
import { addMonthsNoDrift, displayMonthYear, monthKey, todayLocal } from '../../utils/date';
import { activityDateBounds, type ActivityRange } from '../activity/ActivityService';
import {
  calculateCategoryPersonalSpendingForRange,
  calculatePersonalSpendingForRange,
  isPersonalSpendingTransaction,
} from '../budget/BudgetService';
import { calculateAccountBalance, calculateTotalAccountCashChange } from '../finance/FinanceService';
import { calculatePersonBalance } from '../people/PeopleBalanceService';
import { getSubscriptionDueStatus, normalizedMonthlyCost } from '../subscriptions/SubscriptionService';

export type InsightsRange = Exclude<ActivityRange, 'ALL'>;
export type TrendMonths = 3 | 6 | 12;
export type InsightsRangeSelection = { range: InsightsRange; from?: string; to?: string };
export type InsightCategory = { id: string; name: string; amountMinor: number; sharePercent: number };
export type InsightTrendPoint = { month: string; label: string; amountMinor: number };

export type InsightsSnapshot = {
  from: string;
  to: string;
  personalSpendingMinor: number;
  incomeMinor: number;
  personalResultMinor: number;
  accountCashChangeMinor: number;
  totalAccountBalanceMinor: number;
  peopleOweYouMinor: number;
  youOwePeopleMinor: number;
  netPeoplePositionMinor: number;
  netPersonalPositionMinor: number;
  categoryTotalMinor: number;
  categories: InsightCategory[];
  trend: InsightTrendPoint[];
  subscriptionMonthlyMinor: number;
  activeSubscriptionCount: number;
  hasMultipleAccountCurrencies: boolean;
};

function addMoney(total: number, amount: number): number {
  const next = total + amount;
  if (!Number.isSafeInteger(next)) throw new Error('Insight total is outside the supported range.');
  return next;
}

export function insightsDateBounds(selection: InsightsRangeSelection, today = todayLocal()) {
  return activityDateBounds(selection, today) as { from: string; to: string };
}

export function buildSpendingTrend(
  transactions: Transaction[],
  count: TrendMonths,
  today = todayLocal(),
): InsightTrendPoint[] {
  const current = `${monthKey(today)}-01`;
  return Array.from({ length: count }, (_, index) => {
    const month = monthKey(addMonthsNoDrift(current, index - count + 1));
    return {
      month,
      label: displayMonthYear(`${month}-01`),
      amountMinor: transactions
        .filter((tx) => isPersonalSpendingTransaction(tx) && tx.occurred_on.startsWith(month))
        .reduce((sum, tx) => addMoney(sum, tx.amount_minor), 0),
    };
  });
}

export function buildInsightsSnapshot(input: {
  selection: InsightsRangeSelection;
  trendMonths: TrendMonths;
  today?: string;
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  people: Person[];
  peopleEntries: PersonEntry[];
  subscriptions: Subscription[];
  /** One currency's accounts: money moved to or from another currency counts as cash in or out. */
  accountIds?: ReadonlySet<string>;
}): InsightsSnapshot {
  const today = input.today ?? todayLocal();
  const { from, to } = insightsDateBounds(input.selection, today);
  const personalSpendingMinor = calculatePersonalSpendingForRange(input.transactions, from, to);
  const incomeMinor = input.transactions
    .filter((tx) => !tx.deleted_at && tx.type === 'INCOME' && tx.occurred_on >= from && tx.occurred_on <= to)
    .reduce((sum, tx) => addMoney(sum, tx.amount_minor), 0);
  const personalResultMinor = addMoney(incomeMinor, -personalSpendingMinor);
  const accountCashChangeMinor = calculateTotalAccountCashChange(input.transactions, input.peopleEntries, from, to, input.accountIds);
  const totalAccountBalanceMinor = input.accounts
    .filter((account) => !account.deleted_at && !account.is_archived)
    .reduce((sum, account) => addMoney(sum, calculateAccountBalance(account, input.transactions, input.peopleEntries)), 0);
  const personBalances = input.people
    .filter((person) => !person.deleted_at)
    .map((person) => calculatePersonBalance(input.peopleEntries.filter((entry) => !entry.deleted_at && entry.person_id === person.id)));
  const peopleOweYouMinor = personBalances.filter((balance) => balance > 0).reduce(addMoney, 0);
  const youOwePeopleMinor = personBalances.filter((balance) => balance < 0).reduce((sum, balance) => addMoney(sum, -balance), 0);
  const netPeoplePositionMinor = addMoney(peopleOweYouMinor, -youOwePeopleMinor);
  const netPersonalPositionMinor = addMoney(totalAccountBalanceMinor, netPeoplePositionMinor);
  const categoryRows = input.categories
    .filter((category) => !category.deleted_at && category.type === 'EXPENSE')
    .map((category) => ({
      id: category.id,
      name: category.name,
      amountMinor: calculateCategoryPersonalSpendingForRange(input.transactions, from, to, category.id),
    }))
    .filter((category) => category.amountMinor > 0)
    .sort((left, right) => right.amountMinor - left.amountMinor || left.id.localeCompare(right.id));
  const categoryTotalMinor = categoryRows.reduce((sum, row) => addMoney(sum, row.amountMinor), 0);
  const categories = categoryRows.map((row) => ({
    ...row,
    sharePercent: personalSpendingMinor > 0 ? Math.round((row.amountMinor / personalSpendingMinor) * 100) : 0,
  }));
  const activeSubscriptions = input.subscriptions.filter(
    (subscription) =>
      !subscription.deleted_at &&
      subscription.status === 'ACTIVE' &&
      getSubscriptionDueStatus(subscription, today).status !== 'ENDED',
  );
  const subscriptionMonthlyMinor = activeSubscriptions
    .reduce((sum, subscription) => addMoney(sum, normalizedMonthlyCost(subscription)), 0);
  return {
    from,
    to,
    personalSpendingMinor,
    incomeMinor,
    personalResultMinor,
    accountCashChangeMinor,
    totalAccountBalanceMinor,
    peopleOweYouMinor,
    youOwePeopleMinor,
    netPeoplePositionMinor,
    netPersonalPositionMinor,
    categoryTotalMinor,
    categories,
    trend: buildSpendingTrend(input.transactions, input.trendMonths, today),
    subscriptionMonthlyMinor,
    activeSubscriptionCount: activeSubscriptions.length,
    hasMultipleAccountCurrencies: new Set(
      input.accounts.filter((account) => !account.deleted_at && !account.is_archived).map((account) => account.currency),
    ).size > 1,
  };
}

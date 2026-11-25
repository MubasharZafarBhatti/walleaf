import {
  addMoney,
  formatMoney,
  minorUnitsToMoney,
  moneyToMinorUnits,
} from '../utils/money';
import { formatDateInput, inputDateToDateKey } from '../utils/date';
import { getBudgetLimitState, normalizeBudgetThreshold } from '../utils/budget';
import { getFirstDateOffset, getWeekdayLabels } from '../utils/calendar';
import {
  calculatePersonBalance,
  buildBalanceCrossingMessage,
  detectBalanceCrossing,
  personEntryDelta,
  resolvePeopleAction,
} from '../services/people/PeopleBalanceService';
import {
  calculateOtherShares,
  calculateOwnShare,
  splitByExactAmounts,
  splitByPercentage,
  splitByShares,
  splitEvenly,
  validateCustomSplit,
  validateSplitAccounting,
} from '../services/split/SplitService';
import {
  calculateDailyBudgetAllowance,
  getCategoryExpenseTotal,
  getBudgetUsagePercentage,
  getMonthlyExpenseTotal,
  peopleEntriesExcludedFromBudget,
} from '../services/budget/BudgetService';
import {
  calculateNextRenewal,
  calculateReminderDate,
} from '../services/subscriptions/SubscriptionService';
import { calculateAccountBalance } from '../services/finance/FinanceService';
import {
  accountTypeRows,
  formatAccountType,
  hasActiveAccountNamed,
} from '../services/accounts/AccountService';
import {
  calculateGoalProgress,
  calculateGoalRemaining,
  calculateGoalSaved,
  calculateSuggestedMonthlySaving,
} from '../services/goals/GoalService';
import {
  calculateNextRecurrence,
  nextPlannedDueDateAfterAction,
} from '../services/planned/PlannedPaymentService';
import {
  formatRecurrenceLabel,
  validateRecurrenceInterval,
} from '../utils/recurrence';
import { validateDemoGroupRows } from './fixtures/demoValidation';
import { buildSharedExpensePostingPlan } from '../services/sharedExpense/SharedExpenseService';
import type {
  Account,
  PersonEntry,
  PlannedPayment,
  Transaction,
} from '../types/models';

const account: Account = {
  id: 'cash',
  name: 'Cash',
  type: 'CASH',
  currency: 'PKR',
  opening_balance_minor: 100000,
  is_archived: 0,
  created_at: '',
  updated_at: '',
  deleted_at: null,
  sync_status: 'LOCAL',
};
const tx = (
  type: Transaction['type'],
  amount: number,
  extra: Partial<Transaction> = {},
): Transaction => ({
  id: Math.random().toString(),
  type,
  amount_minor: amount,
  account_id: 'cash',
  destination_account_id: null,
  category_id: 'food',
  title: type,
  note: null,
  occurred_on: '2026-09-05',
  source: 'MANUAL',
  group_id: null,
  created_at: '',
  updated_at: '',
  deleted_at: null,
  sync_status: 'LOCAL',
  ...extra,
});
const entry = (
  type: PersonEntry['type'],
  amount: number,
  extra: Partial<PersonEntry> = {},
): PersonEntry => ({
  id: Math.random().toString(),
  person_id: 'ali',
  type,
  amount_minor: amount,
  account_id: 'cash',
  title: type,
  note: null,
  occurred_on: '2026-09-05',
  split_group_id: null,
  created_at: '',
  updated_at: '',
  deleted_at: null,
  sync_status: 'LOCAL',
  ...extra,
});

describe('money', () => {
  test('formatting and conversion use minor units', () => {
    expect(moneyToMinorUnits('1500.50')).toBe(150050);
    expect(minorUnitsToMoney(150050)).toBe('1500.50');
    expect(formatMoney(150050)).toBe('Rs. 1,500.50');
    expect(addMoney(1, 2, 3)).toBe(6);
  });
  test('formats supported display currencies', () => {
    expect(formatMoney(150000, 'PKR')).toBe('Rs. 1,500');
    expect(formatMoney(150000, 'USD')).toBe('$1,500');
    expect(formatMoney(150000, 'EUR')).toBe('€1,500');
    expect(formatMoney(150000, 'GBP')).toBe('£1,500');
    expect(formatMoney(150000, 'AED')).toBe('AED 1,500');
    expect(formatMoney(150000, 'SAR')).toBe('SAR 1,500');
  });
  test('rounding boundaries are explicit', () => {
    expect(moneyToMinorUnits('10.9')).toBe(1090);
    expect(moneyToMinorUnits('10.99')).toBe(1099);
    expect(Number.isNaN(moneyToMinorUnits('10.999'))).toBe(true);
  });
});

describe('date input', () => {
  test('formats numeric input as DD-MM-YYYY', () => {
    expect(formatDateInput('09092026')).toBe('09-09-2026');
    expect(formatDateInput('4')).toBe('04-');
    expect(formatDateInput('459')).toBe('04-05-209');
    expect(formatDateInput('4526')).toBe('04-05-2026');
    expect(formatDateInput('09926')).toBe('09-09-2026');
  });

  test('keeps valid formatted dates compatible with saved date keys', () => {
    expect(inputDateToDateKey('04-05-2026')).toBe('2026-05-04');
    expect(inputDateToDateKey('32-05-2026')).toBeNull();
  });
});

describe('calendar week start', () => {
  test('orders weekdays from saved setting', () => {
    expect(getWeekdayLabels('SUNDAY')).toEqual([
      'Sun',
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri',
      'Sat',
    ]);
    expect(getWeekdayLabels('MONDAY')).toEqual([
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri',
      'Sat',
      'Sun',
    ]);
  });
  test('computes first date offset for selected week start', () => {
    const september2026 = new Date(2026, 8, 1);
    expect(getFirstDateOffset(september2026, 'SUNDAY')).toBe(2);
    expect(getFirstDateOffset(september2026, 'MONDAY')).toBe(1);
  });
});

describe('people', () => {
  test('entry deltas and balances', () => {
    expect(personEntryDelta('GIVEN', 1000)).toBe(1000);
    expect(personEntryDelta('RECEIVED_BACK', 400)).toBe(-400);
    expect(personEntryDelta('BORROWED_FROM', 500)).toBe(-500);
    expect(personEntryDelta('PAID_BACK', 200)).toBe(200);
    expect(
      calculatePersonBalance([
        entry('GIVEN', 150000),
        entry('RECEIVED_BACK', 50000),
      ]),
    ).toBe(100000);
    expect(
      calculatePersonBalance([
        entry('BORROWED_FROM', 200000),
        entry('PAID_BACK', 50000),
      ]),
    ).toBe(-150000);
  });
  test('settlement and balance crossing', () => {
    expect(
      calculatePersonBalance([
        entry('GIVEN', 1000),
        entry('RECEIVED_BACK', 1000),
      ]),
    ).toBe(0);
    expect(
      detectBalanceCrossing(100000, personEntryDelta('RECEIVED_BACK', 150000)),
    ).toBe(-50000);
  });
  test('visible Give/Borrow actions resolve to accounting entries', () => {
    expect(resolvePeopleAction(0, 'GIVE', 1000)).toMatchObject({
      type: 'GIVEN',
      label: 'You gave',
      nextBalance: 1000,
      requiresCrossingConfirmation: false,
    });
    expect(resolvePeopleAction(-3000, 'GIVE', 1000)).toMatchObject({
      type: 'PAID_BACK',
      label: 'Paid back',
      nextBalance: -2000,
      requiresCrossingConfirmation: false,
    });
    expect(resolvePeopleAction(3000, 'BORROW', 1000)).toMatchObject({
      type: 'RECEIVED_BACK',
      label: 'Received back',
      nextBalance: 2000,
      requiresCrossingConfirmation: false,
    });
    expect(resolvePeopleAction(0, 'BORROW', 1000)).toMatchObject({
      type: 'BORROWED_FROM',
      label: 'You borrowed',
      nextBalance: -1000,
      requiresCrossingConfirmation: false,
    });
    expect(resolvePeopleAction(-1000, 'GIVE', 1500)).toMatchObject({
      nextBalance: 500,
      requiresCrossingConfirmation: true,
    });
    expect(resolvePeopleAction(1000, 'BORROW', 1500)).toMatchObject({
      nextBalance: -500,
      requiresCrossingConfirmation: true,
    });
  });
  test('balance crossing message describes relationship meaning', () => {
    expect(buildBalanceCrossingMessage('Ali', 200000, 'BORROW', 1500000)).toBe(
      'Ali currently owes you Rs. 2,000.\n\nReceiving Rs. 15,000 from Ali will settle that amount and leave you owing Ali Rs. 13,000.',
    );
    expect(buildBalanceCrossingMessage('Ali', -200000, 'GIVE', 500000)).toBe(
      'You currently owe Ali Rs. 2,000.\n\nGiving Rs. 5,000 will settle that amount and leave Ali owing you Rs. 3,000.',
    );
  });
});

describe('split', () => {
  test('10000 split between 7 people is exact', () => {
    const total = moneyToMinorUnits('10000');
    const names = [
      'Mubashar',
      'Muazzam',
      'Mehroz',
      'Ammar',
      'Awais',
      'Atif',
      'Shahbaz',
    ];
    const shares = splitEvenly(
      total,
      names.map((name, index) => ({ name, isSelf: index === 0 })),
    );
    expect(shares).toHaveLength(7);
    expect(shares.reduce((sum, share) => sum + share.shareMinor, 0)).toBe(
      total,
    );
    expect(shares[0].shareMinor).toBe(142858);
    expect(shares[6].shareMinor).toBe(142857);
    expect(calculateOwnShare(shares)).toBe(shares[0].shareMinor);
    expect(calculateOtherShares(shares)).toHaveLength(6);
    expect(
      validateSplitAccounting(
        total,
        { amount_minor: calculateOwnShare(shares) },
        calculateOtherShares(shares).map((share) => ({
          amount_minor: share.shareMinor,
        })),
      ),
    ).toBe(true);
  });
  test('custom split validation', () => {
    expect(
      validateCustomSplit(1000, [{ shareMinor: 400 }, { shareMinor: 600 }]),
    ).toBe(true);
    expect(
      validateCustomSplit(1000, [{ shareMinor: 400 }, { shareMinor: 500 }]),
    ).toBe(false);
  });
  test('exact percentage and shares split methods preserve totals', () => {
    expect(
      splitByExactAmounts(1000, [
        { name: 'Me', isSelf: true, shareMinor: 250 },
        { name: 'Ali', shareMinor: 750 },
      ]).reduce((sum, share) => sum + share.shareMinor, 0),
    ).toBe(1000);
    expect(
      splitByPercentage(1001, [
        { name: 'Me', isSelf: true, percentage: 50 },
        { name: 'Ali', percentage: 50 },
      ]).reduce((sum, share) => sum + share.shareMinor, 0),
    ).toBe(1001);
    const byShares = splitByShares(1000, [
      { name: 'Me', isSelf: true, shares: 1 },
      { name: 'Ali', shares: 2 },
      { name: 'Awais', shares: 1 },
    ]);
    expect(byShares.map((share) => share.shareMinor)).toEqual([250, 500, 250]);
  });
});

describe('shared expense posting', () => {
  const sharedBase = {
    title: 'Dinner Split',
    totalAmountMinor: 1000000,
    categoryId: 'food',
    accountId: 'cash',
    occurredOn: '2026-09-05',
  };
  const impactTransactions = (plan: ReturnType<typeof buildSharedExpensePostingPlan>) =>
    plan.personalExpenseTransaction
      ? [
          tx('EXPENSE', plan.personalExpenseTransaction.amount_minor, {
            source: 'SPLIT',
            group_id: plan.personalExpenseTransaction.group_id,
            financial_event_id: plan.personalExpenseTransaction.financial_event_id,
            category_id: plan.personalExpenseTransaction.category_id,
          }),
        ]
      : [];
  const impactEntries = (plan: ReturnType<typeof buildSharedExpensePostingPlan>) =>
    plan.personEntries.map((item) =>
      entry(item.type, item.amount_minor, {
        person_id: item.person_id,
        split_group_id: item.split_group_id,
        financial_event_id: item.financial_event_id,
      }),
    );

  test('10,000 / 7 equal user-paid split posts only own share as spending', () => {
    const total = moneyToMinorUnits('10000');
    const shares = splitEvenly(total, [
      { name: 'You', isSelf: true },
      { name: 'Muazzam', personId: 'muazzam' },
      { name: 'Mehroz', personId: 'mehroz' },
      { name: 'Ammar', personId: 'ammar' },
      { name: 'Awais', personId: 'awais' },
      { name: 'Atif', personId: 'atif' },
      { name: 'Shahbaz', personId: 'shahbaz' },
    ]);
    const plan = buildSharedExpensePostingPlan({
      ...sharedBase,
      totalAmountMinor: total,
      payerIsSelf: true,
      shares,
    });
    const transactions = impactTransactions(plan);
    const entries = impactEntries(plan);
    expect(plan.participants.reduce((sum, row) => sum + row.share_minor, 0)).toBe(total);
    expect(plan.accountCashOutflowMinor).toBe(total);
    expect(plan.personalExpenseMinor).toBe(shares[0].shareMinor);
    expect(plan.personEntries).toHaveLength(6);
    expect(getMonthlyExpenseTotal(transactions, '2026-09')).toBe(shares[0].shareMinor);
    expect(getCategoryExpenseTotal(transactions, '2026-09', 'food')).toBe(shares[0].shareMinor);
    expect(calculateAccountBalance(account, transactions, entries)).toBe(100000 - total);
  });

  test('exact split user paid posts receivables for other shares', () => {
    const plan = buildSharedExpensePostingPlan({
      ...sharedBase,
      payerIsSelf: true,
      shares: splitByExactAmounts(sharedBase.totalAmountMinor, [
        { name: 'You', isSelf: true, shareMinor: 200000 },
        { name: 'Ali', personId: 'ali', shareMinor: 300000 },
        { name: 'Awais', personId: 'awais', shareMinor: 500000 },
      ]),
    });
    expect(plan.personalExpenseMinor).toBe(200000);
    expect(plan.personEntries.map((item) => item.amount_minor)).toEqual([300000, 500000]);
    expect(calculatePersonBalance(impactEntries(plan).filter((item) => item.person_id === 'ali'))).toBe(300000);
  });

  test('percentage split user paid posts exact percentages', () => {
    const plan = buildSharedExpensePostingPlan({
      ...sharedBase,
      payerIsSelf: true,
      shares: splitByPercentage(sharedBase.totalAmountMinor, [
        { name: 'You', isSelf: true, percentage: 20 },
        { name: 'Ali', personId: 'ali', percentage: 30 },
        { name: 'Awais', personId: 'awais', percentage: 50 },
      ]),
    });
    expect(plan.personalExpenseMinor).toBe(200000);
    expect(plan.personEntries.map((item) => item.amount_minor)).toEqual([300000, 500000]);
  });

  test('shares split preserves exact integer totals', () => {
    const plan = buildSharedExpensePostingPlan({
      ...sharedBase,
      payerIsSelf: true,
      shares: splitByShares(sharedBase.totalAmountMinor, [
        { name: 'You', isSelf: true, shares: 1 },
        { name: 'Ali', personId: 'ali', shares: 2 },
        { name: 'Awais', personId: 'awais', shares: 1 },
      ]),
    });
    expect(plan.participants.map((item) => item.share_minor)).toEqual([250000, 500000, 250000]);
  });

  test('another person paid creates spending and debt without account movement', () => {
    const plan = buildSharedExpensePostingPlan({
      ...sharedBase,
      payerIsSelf: false,
      payerPersonId: 'awais',
      payerName: 'Awais',
      shares: splitEvenly(sharedBase.totalAmountMinor, [
        { name: 'You', isSelf: true },
        { name: 'Ali', personId: 'ali' },
        { name: 'Awais', personId: 'awais' },
        { name: 'Atif', personId: 'atif' },
        { name: 'Shahbaz', personId: 'shahbaz' },
      ]),
    });
    const transactions = impactTransactions(plan);
    const entries = impactEntries(plan);
    expect(plan.personalExpenseMinor).toBe(200000);
    expect(plan.accountCashOutflowMinor).toBe(0);
    expect(plan.personEntries).toMatchObject([{ type: 'BORROWED_FROM', amount_minor: 200000 }]);
    expect(getMonthlyExpenseTotal(transactions, '2026-09')).toBe(200000);
    expect(calculateAccountBalance(account, transactions, entries)).toBe(100000);
    const repayment = entry('PAID_BACK', 200000, { person_id: 'awais' });
    expect(calculatePersonBalance([...entries, repayment])).toBe(0);
    expect(getMonthlyExpenseTotal(transactions, '2026-09')).toBe(200000);
    expect(calculateAccountBalance(account, transactions, [...entries, repayment])).toBe(-100000);
  });

  test('user pays for others only has no personal spending', () => {
    const plan = buildSharedExpensePostingPlan({
      ...sharedBase,
      totalAmountMinor: 600000,
      payerIsSelf: true,
      shares: splitEvenly(600000, [
        { name: 'Ali', personId: 'ali' },
        { name: 'Awais', personId: 'awais' },
      ]),
    });
    const transactions = impactTransactions(plan);
    const entries = impactEntries(plan);
    expect(plan.personalExpenseTransaction).toBeUndefined();
    expect(plan.personalExpenseMinor).toBe(0);
    expect(plan.personEntries.reduce((sum, item) => sum + item.amount_minor, 0)).toBe(600000);
    expect(getMonthlyExpenseTotal(transactions, '2026-09')).toBe(0);
    expect(calculateAccountBalance(account, transactions, entries)).toBe(100000 - 600000);
  });

  test('other person paid while user absent has no current-user finance impact', () => {
    const plan = buildSharedExpensePostingPlan({
      ...sharedBase,
      totalAmountMinor: 600000,
      payerIsSelf: false,
      payerPersonId: 'awais',
      payerName: 'Awais',
      shares: splitEvenly(600000, [
        { name: 'Ali', personId: 'ali' },
        { name: 'Atif', personId: 'atif' },
      ]),
    });
    expect(plan.participants.reduce((sum, item) => sum + item.share_minor, 0)).toBe(600000);
    expect(plan.personalExpenseTransaction).toBeUndefined();
    expect(plan.personEntries).toEqual([]);
    expect(plan.accountCashOutflowMinor).toBe(0);
  });

  test('received back after shared receivable is not income or budget spending', () => {
    const plan = buildSharedExpensePostingPlan({
      ...sharedBase,
      totalAmountMinor: 300000,
      payerIsSelf: true,
      shares: splitEvenly(300000, [
        { name: 'Ali', personId: 'ali' },
        { name: 'Awais', personId: 'awais' },
      ]),
    });
    const transactions = impactTransactions(plan);
    const entries = impactEntries(plan);
    const received = entry('RECEIVED_BACK', 100000, { person_id: 'ali' });
    expect(getMonthlyExpenseTotal(transactions, '2026-09')).toBe(0);
    expect(calculatePersonBalance([...entries, received].filter((item) => item.person_id === 'ali'))).toBe(50000);
    expect(calculateAccountBalance(account, transactions, [...entries, received])).toBe(100000 - 200000);
  });

  test('standalone and group-linked shared expenses have equivalent financial impacts', () => {
    const shares = splitEvenly(900000, [
      { name: 'You', isSelf: true },
      { name: 'Ali', personId: 'ali' },
      { name: 'Awais', personId: 'awais' },
    ]);
    const standalone = buildSharedExpensePostingPlan({
      ...sharedBase,
      totalAmountMinor: 900000,
      payerIsSelf: true,
      shares,
    });
    const group = buildSharedExpensePostingPlan({
      ...sharedBase,
      totalAmountMinor: 900000,
      groupId: 'group_murree',
      payerIsSelf: true,
      shares,
    });
    expect(group.splitGroup.group_id).toBe('group_murree');
    expect(standalone.personalExpenseMinor).toBe(group.personalExpenseMinor);
    expect(standalone.accountCashOutflowMinor).toBe(group.accountCashOutflowMinor);
    expect(standalone.personEntries.map((item) => item.amount_minor)).toEqual(
      group.personEntries.map((item) => item.amount_minor),
    );
  });
});

describe('budget', () => {
  test('only expenses count', () => {
    const rows = [
      tx('EXPENSE', 1000),
      tx('INCOME', 9000),
      tx('TRANSFER', 2000),
      tx('EXPENSE', 500, { source: 'SPLIT' }),
    ];
    expect(getMonthlyExpenseTotal(rows, '2026-09')).toBe(1500);
    expect(peopleEntriesExcludedFromBudget([entry('GIVEN', 1000)])).toBe(0);
    expect(getBudgetUsagePercentage(10000, 8000)).toBe(80);
    expect(calculateDailyBudgetAllowance(1855000, '2026-09-11')).toBe(92750);
  });
  test('warning threshold is configurable', () => {
    expect(getBudgetLimitState(79, 80)).toBe('normal');
    expect(getBudgetLimitState(80, 80)).toBe('warning');
    expect(getBudgetLimitState(100, 80)).toBe('reached');
    expect(getBudgetLimitState(70, 70)).toBe('warning');
    expect(normalizeBudgetThreshold('0')).toBe(80);
    expect(normalizeBudgetThreshold('70')).toBe(70);
  });
});

describe('goals', () => {
  test('goal progress is derived and does not imply expense', () => {
    const saved = calculateGoalSaved(6000000, [
      { type: 'ADD', amount_minor: 1500000 },
    ]);
    expect(calculateGoalRemaining(15000000, saved)).toBe(7500000);
    expect(calculateGoalProgress(15000000, saved)).toBe(50);
    expect(
      calculateSuggestedMonthlySaving(9000000, '2027-03-10', '2026-09-10'),
    ).toBe(1500000);
  });
});

describe('planned payments', () => {
  const planned: PlannedPayment = {
    id: 'p',
    name: 'Internet',
    type: 'EXPENSE',
    amount_minor: 350000,
    category_id: 'bills',
    account_id: 'cash',
    next_due_date: '2026-09-15',
    recurrence_type: 'MONTHLY',
    recurrence_interval: 1,
    end_date: null,
    occurrence_limit: null,
    completed_occurrences: 0,
    reminder_enabled: 0,
    reminder_days_before: 3,
    subscription_metadata: null,
    status: 'ACTIVE',
    note: null,
    created_at: '',
    updated_at: '',
    deleted_at: null,
    sync_status: 'LOCAL',
  };
  test('recurrence next dates support paid and skip flows', () => {
    expect(calculateNextRecurrence('2026-01-31', 'MONTHLY')).toBe('2026-02-28');
    expect(calculateNextRecurrence('2026-01-31', 'EVERY_N_MONTHS', 2)).toBe(
      '2026-03-31',
    );
    expect(calculateNextRecurrence('2026-01-31', 'EVERY_N_MONTHS', 3)).toBe(
      '2026-04-30',
    );
    expect(calculateNextRecurrence('2026-01-31', 'EVERY_N_MONTHS', 6)).toBe(
      '2026-07-31',
    );
    expect(calculateNextRecurrence('2026-02-28', 'YEARLY')).toBe('2027-02-28');
    expect(nextPlannedDueDateAfterAction(planned)).toBe('2026-10-15');
  });
});

describe('subscriptions', () => {
  test('renewals and reminders avoid drift', () => {
    expect(calculateNextRenewal('2026-01-31', 'MONTHLY')).toBe('2026-02-28');
    expect(calculateNextRenewal('2026-01-31', 'EVERY_N_MONTHS', 2)).toBe(
      '2026-03-31',
    );
    expect(calculateNextRenewal('2026-01-31', 'EVERY_N_MONTHS', 3)).toBe(
      '2026-04-30',
    );
    expect(calculateNextRenewal('2026-01-31', 'EVERY_N_MONTHS', 6)).toBe(
      '2026-07-31',
    );
    expect(calculateNextRenewal('2026-02-28', 'YEARLY')).toBe('2027-02-28');
    expect(calculateReminderDate('2026-09-10', 3)).toBe('2026-09-07');
  });
  test('recurrence labels and interval validation are centralized', () => {
    expect(formatRecurrenceLabel('MONTHLY')).toBe('Monthly');
    expect(formatRecurrenceLabel('EVERY_N_MONTHS', 2)).toBe('Every 2 months');
    expect(formatRecurrenceLabel('EVERY_N_MONTHS', 3)).toBe('Every 3 months');
    expect(formatRecurrenceLabel('EVERY_N_MONTHS', 6)).toBe('Every 6 months');
    expect(formatRecurrenceLabel('YEARLY')).toBe('Yearly');
    expect(validateRecurrenceInterval('EVERY_N_MONTHS', 1)).toBe(
      'Repeat every must be at least 2 months.',
    );
    expect(validateRecurrenceInterval('EVERY_N_MONTHS', 3)).toBeNull();
  });
});

describe('comprehensive demo group rows', () => {
  test('required group demo rows are linked and balanced', () => {
    const groups = [
      { id: 'demo_group_university', name: 'University Friends' },
      { id: 'demo_group_murree_trip', name: 'Murree Trip' },
    ];
    const members = [
      { group_id: 'demo_group_university', person_id: null, is_self: 1 },
      { group_id: 'demo_group_university', person_id: 'muazzam', is_self: 0 },
      { group_id: 'demo_group_university', person_id: 'mehroz', is_self: 0 },
      { group_id: 'demo_group_university', person_id: 'ammar', is_self: 0 },
      { group_id: 'demo_group_murree_trip', person_id: null, is_self: 1 },
      { group_id: 'demo_group_murree_trip', person_id: 'ali', is_self: 0 },
      { group_id: 'demo_group_murree_trip', person_id: 'awais', is_self: 0 },
      { group_id: 'demo_group_murree_trip', person_id: 'atif', is_self: 0 },
      { group_id: 'demo_group_murree_trip', person_id: 'shahbaz', is_self: 0 },
    ];
    const splitGroups = [
      { id: 'uni_books', title: 'Printing and Books', total_amount_minor: 480000, group_id: 'demo_group_university', payer_person_id: null, payer_is_self: 1 },
      { id: 'uni_lunch', title: 'University Lunch', total_amount_minor: 600000, group_id: 'demo_group_university', payer_person_id: 'mehroz', payer_is_self: 0 },
      { id: 'murree_hotel', title: 'Murree Hotel', total_amount_minor: 2500000, group_id: 'demo_group_murree_trip', payer_person_id: null, payer_is_self: 1 },
      { id: 'murree_dinner', title: 'Murree Dinner', total_amount_minor: 1200000, group_id: 'demo_group_murree_trip', payer_person_id: 'awais', payer_is_self: 0 },
      { id: 'murree_fuel', title: 'Murree Fuel', total_amount_minor: 900000, group_id: 'demo_group_murree_trip', payer_person_id: 'atif', payer_is_self: 0 },
      { id: 'murree_snacks', title: 'Tea & Snacks', total_amount_minor: 300000, group_id: 'demo_group_murree_trip', payer_person_id: null, payer_is_self: 1 },
    ];
    const participants = [
      ...['self', 'muazzam', 'mehroz', 'ammar'].map((id, index) => ({ id: `uni_books_${id}`, split_group_id: 'uni_books', person_id: index === 0 ? null : id, is_self: index === 0 ? 1 : 0, share_minor: 120000 })),
      ...['self', 'muazzam', 'mehroz', 'ammar'].map((id, index) => ({ id: `uni_lunch_${id}`, split_group_id: 'uni_lunch', person_id: index === 0 ? null : id, is_self: index === 0 ? 1 : 0, share_minor: 150000 })),
      ...['self', 'ali', 'awais', 'atif', 'shahbaz'].map((id, index) => ({ id: `murree_hotel_${id}`, split_group_id: 'murree_hotel', person_id: index === 0 ? null : id, is_self: index === 0 ? 1 : 0, share_minor: 500000 })),
      ...['self', 'ali', 'awais', 'atif', 'shahbaz'].map((id, index) => ({ id: `murree_dinner_${id}`, split_group_id: 'murree_dinner', person_id: index === 0 ? null : id, is_self: index === 0 ? 1 : 0, share_minor: 240000 })),
      ...['self', 'atif', 'shahbaz'].map((id, index) => ({ id: `murree_fuel_${id}`, split_group_id: 'murree_fuel', person_id: index === 0 ? null : id, is_self: index === 0 ? 1 : 0, share_minor: [225000, 450000, 225000][index] })),
      ...['self', 'ali', 'shahbaz'].map((id, index) => ({ id: `murree_snacks_${id}`, split_group_id: 'murree_snacks', person_id: index === 0 ? null : id, is_self: index === 0 ? 1 : 0, share_minor: 100000 })),
    ];
    expect(validateDemoGroupRows({ groups, members, splitGroups, participants })).toEqual([]);
  });
});

describe('account balance', () => {
  test('income expense people entries and transfer', () => {
    const transactions = [
      tx('INCOME', 50000),
      tx('EXPENSE', 10000),
      tx('TRANSFER', 5000),
      tx('TRANSFER', 2000, {
        account_id: 'bank',
        destination_account_id: 'cash',
      }),
    ];
    const people = [
      entry('GIVEN', 1000),
      entry('RECEIVED_BACK', 200),
      entry('BORROWED_FROM', 300),
      entry('PAID_BACK', 100),
    ];
    expect(calculateAccountBalance(account, transactions, people)).toBe(136400);
  });
  test('other-person-paid split debt does not create fake cash movement', () => {
    const people = [
      { ...entry('BORROWED_FROM', 300), split_group_id: 'split_1' },
    ];
    expect(calculateAccountBalance(account, [], people)).toBe(100000);
  });
});

describe('accounts', () => {
  const cashOnly = [account];
  test('normal initialization model has one default Cash account', () => {
    expect(cashOnly).toHaveLength(1);
    expect(cashOnly[0]).toMatchObject({ name: 'Cash', type: 'CASH' });
    expect(hasActiveAccountNamed(cashOnly, 'Cash')).toBe(true);
    expect(hasActiveAccountNamed(cashOnly, 'cash')).toBe(true);
  });
  test('re-running initialization should not duplicate Cash', () => {
    const insertIfMissing = (rows: Account[]) =>
      hasActiveAccountNamed(rows, 'Cash')
        ? rows
        : [...rows, { ...account, id: 'account_cash_default' }];
    expect(insertIfMissing(insertIfMissing(cashOnly))).toHaveLength(1);
  });
  test('account type and account name are separate and friendly', () => {
    expect(accountTypeRows).toEqual([
      ['CASH', 'Cash'],
      ['BANK', 'Bank'],
      ['EWALLET', 'E-wallet'],
      ['OTHER', 'Other'],
    ]);
    expect(formatAccountType('BANK')).toBe('Bank');
    expect(formatAccountType('EWALLET')).toBe('E-wallet');
    expect({ type: 'BANK', name: 'Meezan Bank' }).toEqual({
      type: 'BANK',
      name: 'Meezan Bank',
    });
  });
  test('multiple bank and e-wallet account names can coexist', () => {
    const rows: Account[] = [
      account,
      { ...account, id: 'bank_1', name: 'Meezan Bank', type: 'BANK', opening_balance_minor: 5000000 },
      { ...account, id: 'bank_2', name: 'HBL', type: 'BANK', opening_balance_minor: 2500000 },
      { ...account, id: 'wallet_1', name: 'Easypaisa', type: 'EWALLET', opening_balance_minor: 100000 },
      { ...account, id: 'wallet_2', name: 'JazzCash', type: 'EWALLET', opening_balance_minor: 200000 },
    ];
    expect(rows.filter((row) => row.type === 'BANK')).toHaveLength(2);
    expect(rows.filter((row) => row.type === 'EWALLET')).toHaveLength(2);
    expect(hasActiveAccountNamed(rows, 'Meezan Bank')).toBe(true);
    expect(hasActiveAccountNamed(rows, 'meezan bank')).toBe(true);
  });
  test('opening balance is starting state, not income', () => {
    const bank = {
      ...account,
      id: 'bank_1',
      name: 'Meezan Bank',
      type: 'BANK' as const,
      opening_balance_minor: 5000000,
    };
    expect(calculateAccountBalance(bank, [], [])).toBe(5000000);
    expect(getMonthlyExpenseTotal([], '2026-09')).toBe(0);
  });
  test('move money remains wealth neutral and not income or expense', () => {
    const bank = { ...account, id: 'bank', name: 'Meezan Bank', type: 'BANK' as const, opening_balance_minor: 5000000 };
    const wallet = { ...account, id: 'wallet', name: 'Easypaisa', type: 'EWALLET' as const, opening_balance_minor: 1000000 };
    const transfer = tx('TRANSFER', 1000000, {
      account_id: 'bank',
      destination_account_id: 'wallet',
    });
    expect(calculateAccountBalance(bank, [transfer], [])).toBe(4000000);
    expect(calculateAccountBalance(wallet, [transfer], [])).toBe(2000000);
    expect(getMonthlyExpenseTotal([transfer], '2026-09')).toBe(0);
  });

});

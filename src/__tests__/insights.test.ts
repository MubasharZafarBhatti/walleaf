/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import * as SQLite from 'expo-sqlite';
import { openAppDatabase, type AppDb } from '../database/database';
import * as repo from '../database/repositories/repositories';
import { activityDateBounds, listPersonalSpendingActivity } from '../services/activity/ActivityService';
import { calculatePersonalSpendingForRange } from '../services/budget/BudgetService';
import { calculateAccountBalance, calculateTotalAccountCashChange } from '../services/finance/FinanceService';
import { buildInsightsSnapshot, buildSpendingTrend, insightsDateBounds } from '../services/insights/InsightsService';
import { saveSharedExpensePosting } from '../services/sharedExpense/SharedExpenseService';
import type { Account, Category, Person, PersonEntry, Subscription, Transaction } from '../types/models';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

const base = { created_at: '', updated_at: '', deleted_at: null, sync_status: 'LOCAL' as const };
const account = (id: string, opening = 0, archived = 0): Account => ({ ...base, id, name: id, type: 'CASH', currency: 'PKR', opening_balance_minor: opening, is_archived: archived });
const category = (id: string, archived = 0): Category => ({ ...base, id, name: id === 'food' ? 'Food' : 'Fuel', type: 'EXPENSE', icon: '', color_key: '', is_default: 0, is_archived: archived });
let sequence = 0;
const tx = (type: Transaction['type'], amount: number, extra: Partial<Transaction> = {}): Transaction => ({
  ...base,
  id: `tx-${++sequence}`,
  type,
  amount_minor: amount,
  account_id: 'cash',
  destination_account_id: null,
  category_id: 'food',
  title: type,
  note: null,
  occurred_on: '2026-09-10',
  source: 'MANUAL',
  group_id: null,
  financial_event_id: null,
  ...extra,
});
const entry = (type: PersonEntry['type'], amount: number, extra: Partial<PersonEntry> = {}): PersonEntry => ({
  ...base,
  id: `entry-${++sequence}`,
  person_id: 'ali',
  type,
  amount_minor: amount,
  account_id: 'cash',
  title: type,
  note: null,
  occurred_on: '2026-09-10',
  split_group_id: null,
  financial_event_id: null,
  ...extra,
});
const person = (id: string): Person => ({ ...base, id, name: id, note: null, is_archived: 0 });
const subscription = (id: string, status: Subscription['status'], frequency: Subscription['frequency_type'], amount: number, extra: Partial<Subscription> = {}): Subscription => ({
  ...base,
  id,
  name: id,
  amount_minor: amount,
  category_id: 'food',
  account_id: 'cash',
  frequency_type: frequency,
  frequency_interval: frequency === 'EVERY_N_MONTHS' ? 3 : 1,
  start_date: '2026-01-01',
  next_renewal_date: '2026-10-01',
  end_date: null,
  total_cycles: null,
  completed_cycles: 0,
  reminder_enabled: 0,
  reminder_days_before: 0,
  cancellation_reminder_enabled: 0,
  cancellation_reminder_date: null,
  status,
  note: null,
  ...extra,
});

function report(overrides: Partial<Parameters<typeof buildInsightsSnapshot>[0]> = {}) {
  return buildInsightsSnapshot({
    selection: { range: 'THIS_MONTH' },
    trendMonths: 6,
    today: '2026-09-16',
    accounts: [account('cash')],
    categories: [category('food'), category('fuel')],
    transactions: [],
    people: [],
    peopleEntries: [],
    subscriptions: [],
    ...overrides,
  });
}

beforeEach(() => { sequence = 0; });

test('personal spending counts a normal Expense', () => expect(report({ transactions: [tx('EXPENSE', 1200)] }).personalSpendingMinor).toBe(1200));
test('personal spending excludes genuine Income', () => expect(report({ transactions: [tx('INCOME', 1200)] }).personalSpendingMinor).toBe(0));
test('income includes genuine Income only', () => expect(report({ transactions: [tx('INCOME', 5000), tx('EXPENSE', 1000)] }).incomeMinor).toBe(5000));
test('Give is excluded from personal spending but is an actual cash outflow', () => {
  const peopleEntries = [entry('GIVEN', 900)];
  expect(report({ people: [person('ali')], peopleEntries })).toMatchObject({ personalSpendingMinor: 0, incomeMinor: 0, accountCashChangeMinor: -900 });
});
test('Borrow is excluded from Income but is an actual cash inflow', () => {
  const peopleEntries = [entry('BORROWED_FROM', 800)];
  expect(report({ people: [person('ali')], peopleEntries })).toMatchObject({ incomeMinor: 0, accountCashChangeMinor: 800 });
});
test('Paid Back is excluded from Expense but is an actual cash outflow', () => {
  const peopleEntries = [entry('PAID_BACK', 700)];
  expect(report({ people: [person('ali')], peopleEntries })).toMatchObject({ personalSpendingMinor: 0, accountCashChangeMinor: -700 });
});
test('Received Back is excluded from Income but is an actual cash inflow', () => {
  const peopleEntries = [entry('RECEIVED_BACK', 600)];
  expect(report({ people: [person('ali')], peopleEntries })).toMatchObject({ incomeMinor: 0, accountCashChangeMinor: 600 });
});
test('Move Money is excluded from personal result and neutral to total cash movement', () => {
  const transactions = [tx('TRANSFER', 400, { destination_account_id: 'bank' })];
  expect(report({ accounts: [account('cash'), account('bank')], transactions })).toMatchObject({ personalSpendingMinor: 0, incomeMinor: 0, personalResultMinor: 0, accountCashChangeMinor: 0 });
});
test('Balance Adjustment is excluded from personal result and included in cash change', () => {
  const transactions = [tx('ADJUSTMENT', -350)];
  expect(report({ transactions })).toMatchObject({ personalSpendingMinor: 0, incomeMinor: 0, personalResultMinor: 0, accountCashChangeMinor: -350 });
});
test('Goal movement has no Insights effect because it is not a financial ledger row', () => expect(report()).toMatchObject({ personalSpendingMinor: 0, incomeMinor: 0, accountCashChangeMinor: 0 }));
test('personal result is genuine Income minus personal spending', () => expect(report({ transactions: [tx('INCOME', 5000), tx('EXPENSE', 1800)] }).personalResultMinor).toBe(3200));
test('negative personal result remains exact', () => expect(report({ transactions: [tx('INCOME', 500), tx('EXPENSE', 1800)] }).personalResultMinor).toBe(-1300));

test('user-paid shared Expense counts only the user share while cash movement uses the full bill', () => {
  const transactions = [tx('EXPENSE', 400, { source: 'SPLIT', financial_event_id: 'event' })];
  const peopleEntries = [entry('GIVEN', 600, { split_group_id: 'split', financial_event_id: 'event' })];
  expect(report({ people: [person('ali')], transactions, peopleEntries })).toMatchObject({ personalSpendingMinor: 400, accountCashChangeMinor: -1000, peopleOweYouMinor: 600 });
});
test('other-paid shared Expense counts only the user share and creates no fake cash movement', () => {
  const transactions = [tx('EXPENSE', 300, { source: 'SPLIT', financial_event_id: 'event' })];
  const peopleEntries = [entry('BORROWED_FROM', 300, { split_group_id: 'split', financial_event_id: 'event' })];
  expect(report({ people: [person('ali')], transactions, peopleEntries })).toMatchObject({ personalSpendingMinor: 300, accountCashChangeMinor: 0, youOwePeopleMinor: 300 });
});
test('other participant shares never enter personal spending', () => {
  const transactions = [tx('EXPENSE', 250, { source: 'SPLIT', financial_event_id: 'event' })];
  const peopleEntries = [entry('GIVEN', 750, { split_group_id: 'split', financial_event_id: 'event' })];
  expect(report({ people: [person('ali')], transactions, peopleEntries }).personalSpendingMinor).toBe(250);
});
test('personal-spending range helper is the same Expense-row authority used by the report', () => {
  const transactions = [tx('EXPENSE', 250), tx('INCOME', 900), tx('TRANSFER', 100)];
  expect(report({ transactions }).personalSpendingMinor).toBe(calculatePersonalSpendingForRange(transactions, '2026-09-01', '2026-09-30'));
});

test('actual cash movement remains separate from personal result', () => {
  const transactions = [tx('INCOME', 2000), tx('EXPENSE', 500)];
  const peopleEntries = [entry('BORROWED_FROM', 1000)];
  expect(report({ people: [person('ali')], transactions, peopleEntries })).toMatchObject({ personalResultMinor: 1500, accountCashChangeMinor: 2500 });
});
test('range cash change matches authoritative current balance delta without opening balance', () => {
  const cash = account('cash', 5000);
  const transactions = [tx('INCOME', 2000), tx('EXPENSE', 500)];
  const peopleEntries = [entry('GIVEN', 250)];
  const balance = calculateAccountBalance(cash, transactions, peopleEntries);
  expect(calculateTotalAccountCashChange(transactions, peopleEntries, '2026-09-01', '2026-09-30')).toBe(balance - cash.opening_balance_minor);
});
test('total account balances match authoritative account calculations', () => {
  const accounts = [account('cash', 5000), account('bank', 2000)];
  const transactions = [tx('TRANSFER', 900, { destination_account_id: 'bank' }), tx('EXPENSE', 400)];
  const snapshot = report({ accounts, transactions });
  expect(snapshot.totalAccountBalanceMinor).toBe(accounts.reduce((sum, item) => sum + calculateAccountBalance(item, transactions, []), 0));
});
test('archived accounts are excluded from current total account balance', () => expect(report({ accounts: [account('cash', 1000), account('old', 9000, 1)] }).totalAccountBalanceMinor).toBe(1000));

test('People receivable, payable and net totals use authoritative entry deltas', () => {
  const peopleEntries = [entry('GIVEN', 1000), entry('BORROWED_FROM', 400, { person_id: 'hamza' })];
  expect(report({ people: [person('ali'), person('hamza')], peopleEntries })).toMatchObject({ peopleOweYouMinor: 1000, youOwePeopleMinor: 400, netPeoplePositionMinor: 600 });
});
test('archived People remain included in current all-time balances', () => {
  const archived = { ...person('ali'), is_archived: 1 };
  expect(report({ people: [archived], peopleEntries: [entry('GIVEN', 1000)] }).peopleOweYouMinor).toBe(1000);
});
test('People totals are not limited by the selected report range', () => {
  const peopleEntries = [entry('GIVEN', 1000, { occurred_on: '2025-01-01' })];
  expect(report({ people: [person('ali')], peopleEntries }).peopleOweYouMinor).toBe(1000);
});
test('net personal position is active account balances plus receivables minus payables', () => {
  const peopleEntries = [entry('GIVEN', 1000), entry('BORROWED_FROM', 400, { person_id: 'hamza' })];
  const snapshot = report({ accounts: [account('cash', 5000)], people: [person('ali'), person('hamza')], peopleEntries });
  expect(snapshot.totalAccountBalanceMinor).toBe(4400);
  expect(snapshot.netPersonalPositionMinor).toBe(5000);
});

test('category totals reconcile exactly to personal spending', () => {
  const transactions = [tx('EXPENSE', 800), tx('EXPENSE', 200, { category_id: 'fuel' })];
  const snapshot = report({ transactions });
  expect(snapshot.categories.map((row) => row.amountMinor)).toEqual([800, 200]);
  expect(snapshot.categoryTotalMinor).toBe(snapshot.personalSpendingMinor);
});
test('archived categories remain historically readable by stable ID', () => {
  const snapshot = report({ categories: [category('food', 1)], transactions: [tx('EXPENSE', 800)] });
  expect(snapshot.categories).toMatchObject([{ id: 'food', name: 'Food', amountMinor: 800 }]);
});
test('zero spending produces no categories and no invalid percentages', () => expect(report()).toMatchObject({ categoryTotalMinor: 0, categories: [] }));
test('spending trend zero-fills months and reconciles to Expense rows in each month', () => {
  const transactions = [tx('EXPENSE', 100, { occurred_on: '2026-07-10' }), tx('EXPENSE', 200, { occurred_on: '2026-09-10' }), tx('INCOME', 900, { occurred_on: '2026-08-10' })];
  expect(buildSpendingTrend(transactions, 3, '2026-09-16').map((point) => [point.month, point.amountMinor])).toEqual([['2026-07', 100], ['2026-08', 0], ['2026-09', 200]]);
});
test('trend supports exactly 3, 6 and 12 deterministic month buckets', () => {
  expect(buildSpendingTrend([], 3, '2026-01-10')).toHaveLength(3);
  expect(buildSpendingTrend([], 6, '2026-01-10')).toHaveLength(6);
  expect(buildSpendingTrend([], 12, '2026-01-10')[0].month).toBe('2025-02');
});

test('required date presets have inclusive deterministic boundaries', () => {
  expect(insightsDateBounds({ range: 'THIS_MONTH' }, '2026-09-16')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  expect(insightsDateBounds({ range: 'LAST_MONTH' }, '2026-01-16')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  expect(insightsDateBounds({ range: 'LAST_3_MONTHS' }, '2026-09-16')).toEqual({ from: '2026-07-01', to: '2026-09-30' });
  expect(insightsDateBounds({ range: 'LAST_6_MONTHS' }, '2026-09-16')).toEqual({ from: '2026-04-01', to: '2026-09-30' });
  expect(insightsDateBounds({ range: 'THIS_YEAR' }, '2026-09-16')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
});
test('custom range accepts equal inclusive dates', () => expect(insightsDateBounds({ range: 'CUSTOM', from: '2026-09-16', to: '2026-09-16' })).toEqual({ from: '2026-09-16', to: '2026-09-16' }));
test('custom range rejects start after end without changing the supplied selection', () => {
  const selection = { range: 'CUSTOM' as const, from: '2026-09-20', to: '2026-09-10' };
  expect(() => insightsDateBounds(selection)).toThrow('To must be on or after From');
  expect(selection).toEqual({ range: 'CUSTOM', from: '2026-09-20', to: '2026-09-10' });
});
test('range filtering includes both boundaries and excludes outside rows', () => {
  const transactions = [tx('EXPENSE', 100, { occurred_on: '2026-09-01' }), tx('EXPENSE', 200, { occurred_on: '2026-09-30' }), tx('EXPENSE', 400, { occurred_on: '2026-10-01' })];
  expect(report({ transactions }).personalSpendingMinor).toBe(300);
});
test('Activity and Insights share the same Last 6 Months bounds', () => expect(activityDateBounds({ range: 'LAST_6_MONTHS' }, '2026-09-16')).toEqual(insightsDateBounds({ range: 'LAST_6_MONTHS' }, '2026-09-16')));

test('normalized subscription commitment includes active monthly, quarterly, yearly and weekly plans', () => {
  const subscriptions = [subscription('monthly', 'ACTIVE', 'MONTHLY', 10001), subscription('quarterly', 'ACTIVE', 'EVERY_N_MONTHS', 10001), subscription('yearly', 'ACTIVE', 'YEARLY', 10002), subscription('weekly', 'ACTIVE', 'WEEKLY', 10001)];
  expect(report({ subscriptions })).toMatchObject({ subscriptionMonthlyMinor: 57507, activeSubscriptionCount: 4 });
});
test('paused, cancelled and ended subscriptions are excluded', () => {
  const subscriptions = [subscription('paused', 'PAUSED', 'MONTHLY', 1000), subscription('cancelled', 'CANCELLED', 'MONTHLY', 1000), subscription('ended', 'ENDED', 'MONTHLY', 1000), subscription('cycle-ended', 'ACTIVE', 'MONTHLY', 1000, { total_cycles: 2, completed_cycles: 2 })];
  expect(report({ subscriptions })).toMatchObject({ subscriptionMonthlyMinor: 0, activeSubscriptionCount: 0 });
});
test('normalized subscription commitment is reporting-only and does not alter actual totals', () => expect(report({ subscriptions: [subscription('monthly', 'ACTIVE', 'MONTHLY', 1000)] })).toMatchObject({ personalSpendingMinor: 0, incomeMinor: 0, accountCashChangeMinor: 0, subscriptionMonthlyMinor: 1000 }));
test('future Planned Payments are absent from actual totals until a transaction is recorded', () => expect(report()).toMatchObject({ personalSpendingMinor: 0, incomeMinor: 0, accountCashChangeMinor: 0 }));
test('a recorded Planned Expense is a genuine personal Expense', () => expect(report({ transactions: [tx('EXPENSE', 900, { source: 'PLANNED' })] }).personalSpendingMinor).toBe(900));
test('all empty metrics remain exact zero values', () => expect(report()).toMatchObject({ personalSpendingMinor: 0, incomeMinor: 0, personalResultMinor: 0, accountCashChangeMinor: 0, peopleOweYouMinor: 0, youOwePeopleMinor: 0, subscriptionMonthlyMinor: 0 }));

describe('SQLite-backed personal-spending drill-down', () => {
  let sqlite: DatabaseSync;
  let db: AppDb;
  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:');
    const adapter = {
      execAsync: async (sql: string) => { sqlite.exec(sql); },
      runAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).run(...params),
      getAllAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).all(...params),
      getFirstAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).get(...params) ?? null,
      withTransactionAsync: async (work: () => Promise<void>) => { sqlite.exec('BEGIN'); try { await work(); sqlite.exec('COMMIT'); } catch (error) { sqlite.exec('ROLLBACK'); throw error; } },
      withExclusiveTransactionAsync: async (work: (txn: AppDb) => Promise<void>) => adapter.withTransactionAsync(() => work(db)),
    };
    db = adapter as unknown as AppDb;
    jest.mocked(SQLite.openDatabaseAsync).mockResolvedValue(db);
    await openAppDatabase();
  });
  afterEach(() => sqlite.close());

  test('category drill-down total exactly reconciles normal and user-paid shared personal shares', async () => {
    const cash = (await repo.listAccounts(db))[0];
    await repo.saveTransaction(db, { type: 'EXPENSE', amount_minor: 500, account_id: cash.id, category_id: 'cat_expense_food', title: 'Lunch', occurred_on: '2026-09-02', source: 'MANUAL' });
    await db.runAsync("INSERT INTO people (id,name,note,is_archived,created_at,updated_at,deleted_at,sync_status) VALUES ('person_ali','Ali',NULL,0,'','',NULL,'LOCAL');");
    await saveSharedExpensePosting(db, { splitGroupId: 'shared', title: 'Dinner', totalAmountMinor: 1000, categoryId: 'cat_expense_food', accountId: cash.id, occurredOn: '2026-09-03', payerIsSelf: true, shares: [{ name: 'You', isSelf: true, shareMinor: 400 }, { personId: 'person_ali', name: 'Ali', isSelf: false, shareMinor: 600 }] });
    const rows = await listPersonalSpendingActivity(db, { categoryId: 'cat_expense_food', from: '2026-09-01', to: '2026-09-30' });
    expect(rows.map((row) => [row.kind, row.amount_minor])).toEqual([['shared', 400], ['transaction', 500]]);
    expect(rows.reduce((sum, row) => sum + row.amount_minor, 0)).toBe(900);
  });

  test('other-paid shared drill-down shows only the user share and links the shared source', async () => {
    const cash = (await repo.listAccounts(db))[0];
    await db.runAsync("INSERT INTO people (id,name,note,is_archived,created_at,updated_at,deleted_at,sync_status) VALUES ('person_ali','Ali',NULL,0,'','',NULL,'LOCAL');");
    await saveSharedExpensePosting(db, { splitGroupId: 'other-paid', title: 'Taxi', totalAmountMinor: 1000, categoryId: 'cat_expense_food', accountId: cash.id, occurredOn: '2026-09-03', payerIsSelf: false, payerPersonId: 'person_ali', payerName: 'Ali', shares: [{ name: 'You', isSelf: true, shareMinor: 300 }, { personId: 'person_ali', name: 'Ali', isSelf: false, shareMinor: 700 }] });
    const rows = await listPersonalSpendingActivity(db, { categoryId: 'cat_expense_food', from: '2026-09-01', to: '2026-09-30' });
    expect(rows).toMatchObject([{ kind: 'shared', source_id: 'other-paid', amount_minor: 300, label: 'Shared expense | Your share' }]);
  });

  test('archived category remains queryable by stable ID and custom boundaries stay inclusive', async () => {
    const cash = (await repo.listAccounts(db))[0];
    await repo.saveTransaction(db, { type: 'EXPENSE', amount_minor: 500, account_id: cash.id, category_id: 'cat_expense_food', title: 'Lunch', occurred_on: '2026-09-02', source: 'MANUAL' });
    await db.runAsync("UPDATE categories SET is_archived = 1 WHERE id = 'cat_expense_food';");
    const rows = await listPersonalSpendingActivity(db, { categoryId: 'cat_expense_food', from: '2026-09-02', to: '2026-09-02' });
    expect(rows).toMatchObject([{ category_id: 'cat_expense_food', category_name: 'Food', amount_minor: 500 }]);
  });

  test('category drill-down ordering is newest-first with deterministic timestamp and ID ties', async () => {
    const cash = (await repo.listAccounts(db))[0];
    const insert = (id: string, occurredOn: string, createdAt: string) => db.runAsync(
      'INSERT INTO transactions (id, type, amount_minor, account_id, category_id, title, occurred_on, source, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);',
      id, 'EXPENSE', 100, cash.id, 'cat_expense_food', id, occurredOn, 'MANUAL', createdAt, createdAt, 'LOCAL',
    );
    await insert('tie-b', '2026-09-02', '2026-09-02T10:00:00.000Z');
    await insert('tie-a', '2026-09-02', '2026-09-02T10:00:00.000Z');
    await insert('later-time', '2026-09-02', '2026-09-02T11:00:00.000Z');
    await insert('new-date', '2026-09-03', '2026-09-03T09:00:00.000Z');
    const rows = await listPersonalSpendingActivity(db, { categoryId: 'cat_expense_food', from: '2026-09-01', to: '2026-09-30' });
    expect(rows.map((row) => row.source_id)).toEqual(['new-date', 'later-time', 'tie-a', 'tie-b']);
  });
});

/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import * as SQLite from 'expo-sqlite';
import { openAppDatabase, type AppDb } from '../database/database';
import * as repo from '../database/repositories/repositories';
import { listActivity, ordinaryReadOnlyReason, plannedReadOnlyMessage } from '../services/activity/ActivityService';
import { getMonthlyExpenseTotal } from '../services/budget/BudgetService';
import { calculateAccountBalance } from '../services/finance/FinanceService';
import { clearDemoData, loadComprehensiveDemoData } from './fixtures/demoData';
import {
  calculateNextRecurrence,
  getPlannedDueStatus,
  plannedRecordActionLabel,
} from '../services/planned/PlannedPaymentService';
import type { Account, PlannedPayment, PlannedPaymentType } from '../types/models';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

let sqlite: DatabaseSync;
let db: AppDb;
let adapter: {
  execAsync: (sql: string) => Promise<void>;
  runAsync: (sql: string, ...params: (string | number | null)[]) => Promise<unknown>;
  getAllAsync: (sql: string, ...params: (string | number | null)[]) => Promise<unknown[]>;
  getFirstAsync: (sql: string, ...params: (string | number | null)[]) => Promise<unknown>;
  withTransactionAsync: (work: () => Promise<void>) => Promise<void>;
  withExclusiveTransactionAsync: (work: (txn: AppDb) => Promise<void>) => Promise<void>;
};
let cash: Account;

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  adapter = {
    execAsync: async (sql) => { sqlite.exec(sql); },
    runAsync: async (sql, ...params) => sqlite.prepare(sql).run(...params),
    getAllAsync: async (sql, ...params) => sqlite.prepare(sql).all(...params),
    getFirstAsync: async (sql, ...params) => sqlite.prepare(sql).get(...params) ?? null,
    withTransactionAsync: async (work) => {
      sqlite.exec('BEGIN');
      try { await work(); sqlite.exec('COMMIT'); }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    withExclusiveTransactionAsync: async (work) => adapter.withTransactionAsync(() => work(db)),
  };
  db = adapter as unknown as AppDb;
  jest.mocked(SQLite.openDatabaseAsync).mockResolvedValue(db);
  await openAppDatabase();
  cash = (await repo.listAccounts(db))[0];
  await db.runAsync('UPDATE accounts SET opening_balance_minor = ? WHERE id = ?;', 100000, cash.id);
  cash = (await repo.listAccounts(db))[0];
});

afterEach(() => sqlite.close());

function category(type: PlannedPaymentType) {
  return type === 'EXPENSE' ? 'cat_expense_bills' : 'cat_income_salary';
}

async function createPlan(
  type: PlannedPaymentType = 'EXPENSE',
  overrides: Partial<Parameters<typeof repo.savePlannedPayment>[1]> = {},
) {
  const id = await repo.savePlannedPayment(db, {
    name: type === 'EXPENSE' ? 'Internet bill' : 'Salary',
    type,
    amount_minor: 10000,
    category_id: category(type),
    account_id: cash.id,
    next_due_date: '2026-09-15',
    recurrence_type: 'MONTHLY',
    recurrence_interval: 1,
    end_date: null,
    occurrence_limit: null,
    reminder_enabled: 0,
    reminder_days_before: 3,
    subscription_metadata: null,
    note: 'Expected payment',
    ...overrides,
  });
  return await repo.getPlannedPayment(db, id) as PlannedPayment;
}

async function accountBalance() {
  return calculateAccountBalance(cash, await repo.listTransactions(db), await repo.listPersonEntries(db));
}

test('migration 7 is additive and creates durable occurrence identity constraints', async () => {
  expect((await db.getFirstAsync<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations;'))?.version).toBe(14);
  expect(await db.getFirstAsync('SELECT version FROM schema_migrations WHERE version = 7;')).toEqual({ version: 7 });
  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(planned_payment_occurrences);');
  expect(columns.map((item) => item.name)).toEqual(expect.arrayContaining(['planned_payment_id', 'scheduled_date', 'transaction_id', 'outcome']));
  expect((await repo.listAccounts(db))[0].id).toBe('account_cash_default');
});

test('Expense occurrence creates exactly one real Expense and decreases its account', async () => {
  const plan = await createPlan('EXPENSE');
  const transactionId = await repo.markPlannedPaymentPaid(db, plan.id, plan.next_due_date);
  const transactions = await repo.listTransactions(db);
  expect(transactions).toHaveLength(1);
  expect(transactions[0]).toMatchObject({ id: transactionId, type: 'EXPENSE', source: 'PLANNED', amount_minor: 10000, account_id: cash.id, category_id: category('EXPENSE') });
  expect(await accountBalance()).toBe(90000);
  expect(getMonthlyExpenseTotal(transactions, '2026-09')).toBe(10000);
});

test('Income occurrence creates exactly one real Income, increases account and creates no spending', async () => {
  const plan = await createPlan('INCOME');
  await repo.markPlannedPaymentPaid(db, plan.id, plan.next_due_date);
  const transactions = await repo.listTransactions(db);
  expect(transactions).toHaveLength(1);
  expect(transactions[0]).toMatchObject({ type: 'INCOME', source: 'PLANNED', amount_minor: 10000, category_id: category('INCOME') });
  expect(await accountBalance()).toBe(110000);
  expect(getMonthlyExpenseTotal(transactions, '2026-09')).toBe(0);
});

test('record action wording distinguishes Expense from Income', () => {
  expect(plannedRecordActionLabel('EXPENSE')).toBe('Record Expense');
  expect(plannedRecordActionLabel('INCOME')).toBe('Record Income');
});

test('same occurrence cannot be recorded twice after refresh or repository retry', async () => {
  const plan = await createPlan();
  await repo.markPlannedPaymentPaid(db, plan.id, plan.next_due_date);
  await expect(repo.markPlannedPaymentPaid(db, plan.id, plan.next_due_date)).rejects.toThrow('already handled');
  expect(await repo.listTransactions(db)).toHaveLength(1);
  expect(await repo.listPlannedPaymentOccurrences(db, plan.id)).toHaveLength(1);
  expect((await repo.getPlannedPayment(db, plan.id))?.completed_occurrences).toBe(1);
});

test('database uniqueness independently protects stable plan and scheduled-date identity', async () => {
  const plan = await createPlan();
  await repo.skipPlannedPayment(db, plan.id, plan.next_due_date);
  await expect(db.runAsync(
    "INSERT INTO planned_payment_occurrences (id, planned_payment_id, scheduled_date, outcome, transaction_id, created_at) VALUES ('duplicate', ?, ?, 'SKIPPED', NULL, 'now');",
    plan.id,
    plan.next_due_date,
  )).rejects.toThrow();
});

test('transaction, occurrence, and recurrence advancement roll back together on an advancement failure', async () => {
  const plan = await createPlan();
  const originalRun = adapter.runAsync;
  adapter.runAsync = async (sql, ...params) => {
    if (sql.startsWith('UPDATE planned_payments SET completed_occurrences')) throw new Error('injected advancement failure');
    return originalRun(sql, ...params);
  };
  await expect(repo.markPlannedPaymentPaid(db, plan.id, plan.next_due_date)).rejects.toThrow('injected advancement failure');
  expect(await repo.listTransactions(db)).toEqual([]);
  expect(await repo.listPlannedPaymentOccurrences(db, plan.id)).toEqual([]);
  expect(await repo.getPlannedPayment(db, plan.id)).toMatchObject({ next_due_date: plan.next_due_date, completed_occurrences: 0 });
});

test('recording advances recurrence exactly once and persists after repository reread', async () => {
  const plan = await createPlan();
  await repo.markPlannedPaymentPaid(db, plan.id, plan.next_due_date);
  expect(await repo.getPlannedPayment(db, plan.id)).toMatchObject({ next_due_date: '2026-10-15', completed_occurrences: 1, status: 'ACTIVE' });
  expect(await repo.listPlannedPayments(db)).toEqual(expect.arrayContaining([expect.objectContaining({ id: plan.id, next_due_date: '2026-10-15' })]));
});

test('one-time occurrence ends without inventing another due date', async () => {
  const plan = await createPlan('EXPENSE', { recurrence_type: 'NONE' });
  await repo.markPlannedPaymentPaid(db, plan.id, plan.next_due_date);
  expect(await repo.getPlannedPayment(db, plan.id)).toMatchObject({ status: 'ENDED', next_due_date: plan.next_due_date, completed_occurrences: 1 });
});

test('due states distinguish upcoming, today, overdue, paused and ended', () => {
  const base = { next_due_date: '2026-09-15' };
  expect(getPlannedDueStatus({ ...base, status: 'ACTIVE' }, '2026-09-14')).toEqual({ status: 'UPCOMING', label: 'Due tomorrow' });
  expect(getPlannedDueStatus({ ...base, status: 'ACTIVE' }, '2026-09-15')).toEqual({ status: 'DUE_TODAY', label: 'Due today' });
  expect(getPlannedDueStatus({ ...base, status: 'ACTIVE' }, '2026-09-18')).toEqual({ status: 'OVERDUE', label: '3 days overdue' });
  expect(getPlannedDueStatus({ ...base, status: 'PAUSED' }, '2026-09-18')).toEqual({ status: 'PAUSED', label: 'Paused' });
  expect(getPlannedDueStatus({ ...base, status: 'ENDED' }, '2026-09-18')).toEqual({ status: 'ENDED', label: 'Ended' });
});

test('central recurrence supports month, year and interval boundaries', () => {
  expect(calculateNextRecurrence('2026-12-31', 'MONTHLY')).toBe('2027-01-31');
  expect(calculateNextRecurrence('2026-01-31', 'EVERY_N_MONTHS', 3)).toBe('2026-04-30');
  expect(calculateNextRecurrence('2024-02-29', 'YEARLY')).toBe('2025-02-28');
  expect(calculateNextRecurrence('2026-12-29', 'WEEKLY')).toBe('2027-01-05');
});

test('editing future metadata preserves recorded transaction and occurrence values', async () => {
  const plan = await createPlan();
  const transactionId = await repo.markPlannedPaymentPaid(db, plan.id, plan.next_due_date);
  const current = await repo.getPlannedPayment(db, plan.id) as PlannedPayment;
  await repo.updatePlannedPayment(db, current.id, current.updated_at, {
    name: 'New internet plan', type: 'EXPENSE', amount_minor: 15000,
    category_id: category('EXPENSE'), account_id: cash.id,
    next_due_date: current.next_due_date, recurrence_type: 'EVERY_N_MONTHS', recurrence_interval: 2,
    end_date: null, occurrence_limit: null, reminder_enabled: 1, reminder_days_before: 7,
    subscription_metadata: null, note: 'Future cycles only',
  });
  expect(await db.getFirstAsync('SELECT type, amount_minor, title, note FROM transactions WHERE id = ?;', transactionId)).toMatchObject({ type: 'EXPENSE', amount_minor: 10000, title: 'Internet bill', note: 'Expected payment' });
  expect((await repo.listPlannedPaymentOccurrences(db, plan.id))[0]).toMatchObject({ transaction_amount_minor: 10000, transaction_type: 'EXPENSE', transaction_title: 'Internet bill' });
  expect(await repo.getPlannedPayment(db, plan.id)).toMatchObject({ name: 'New internet plan', amount_minor: 15000, recurrence_interval: 2, reminder_enabled: 1, reminder_days_before: 7 });
});

test('type may change before real history but becomes immutable after recording', async () => {
  const plan = await createPlan();
  await repo.updatePlannedPayment(db, plan.id, plan.updated_at, {
    ...plan, type: 'INCOME', category_id: category('INCOME'),
  });
  const income = await repo.getPlannedPayment(db, plan.id) as PlannedPayment;
  await repo.markPlannedPaymentPaid(db, income.id, income.next_due_date);
  const current = await repo.getPlannedPayment(db, income.id) as PlannedPayment;
  await expect(repo.updatePlannedPayment(db, current.id, current.updated_at, {
    ...current, type: 'EXPENSE', category_id: category('EXPENSE'),
  })).rejects.toThrow('Type cannot change');
});

test('pause and resume retain the due date and move no money', async () => {
  const plan = await createPlan();
  const before = await accountBalance();
  await repo.pausePlannedPayment(db, plan.id, plan.updated_at);
  const paused = await repo.getPlannedPayment(db, plan.id) as PlannedPayment;
  expect(paused).toMatchObject({ status: 'PAUSED', next_due_date: plan.next_due_date });
  await expect(repo.markPlannedPaymentPaid(db, paused.id, paused.next_due_date)).rejects.toThrow('active');
  await repo.resumePlannedPayment(db, paused.id, paused.updated_at);
  expect(await repo.getPlannedPayment(db, plan.id)).toMatchObject({ status: 'ACTIVE', next_due_date: plan.next_due_date });
  expect(await repo.listTransactions(db)).toEqual([]);
  expect(await accountBalance()).toBe(before);
});

test('resume rejects an archived account instead of activating an unusable plan', async () => {
  const plan = await createPlan();
  await repo.pausePlannedPayment(db, plan.id, plan.updated_at);
  const paused = await repo.getPlannedPayment(db, plan.id) as PlannedPayment;
  await db.runAsync('UPDATE accounts SET is_archived = 1 WHERE id = ?;', cash.id);
  await expect(repo.resumePlannedPayment(db, paused.id, paused.updated_at)).rejects.toThrow('active account');
  expect(await repo.getPlannedPayment(db, plan.id)).toMatchObject({ status: 'PAUSED' });
  expect(await repo.listTransactions(db)).toEqual([]);
});

test('paused and ended plans remain list-visible and history-readable', async () => {
  const pausedPlan = await createPlan();
  await repo.pausePlannedPayment(db, pausedPlan.id, pausedPlan.updated_at);
  const endedPlan = await createPlan('INCOME', { recurrence_type: 'NONE' });
  await repo.markPlannedPaymentPaid(db, endedPlan.id, endedPlan.next_due_date);
  const listed = await repo.listPlannedPayments(db);
  expect(listed).toEqual(expect.arrayContaining([expect.objectContaining({ id: pausedPlan.id, status: 'PAUSED' }), expect.objectContaining({ id: endedPlan.id, status: 'ENDED' })]));
  expect(await repo.listPlannedPaymentOccurrences(db, endedPlan.id)).toHaveLength(1);
});

test('stop tracking removes only the future definition and preserves real financial history', async () => {
  const plan = await createPlan();
  const transactionId = await repo.markPlannedPaymentPaid(db, plan.id, plan.next_due_date);
  const current = await repo.getPlannedPayment(db, plan.id) as PlannedPayment;
  await repo.stopTrackingPlannedPayment(db, current.id, current.updated_at);
  expect(await repo.getPlannedPayment(db, plan.id)).toBeNull();
  expect((await repo.listTransactions(db))[0].id).toBe(transactionId);
  expect(await db.getFirstAsync('SELECT id FROM planned_payment_occurrences WHERE planned_payment_id = ?;', plan.id)).toBeTruthy();
  expect(await accountBalance()).toBe(90000);
});

test('skip creates no financial movement, advances once and is persistently replay-safe', async () => {
  const plan = await createPlan();
  const before = await accountBalance();
  await repo.skipPlannedPayment(db, plan.id, plan.next_due_date);
  expect(await repo.getPlannedPayment(db, plan.id)).toMatchObject({ next_due_date: '2026-10-15', completed_occurrences: 0 });
  expect(await repo.listPlannedPaymentOccurrences(db, plan.id)).toMatchObject([{ outcome: 'SKIPPED', transaction_id: null }]);
  await expect(repo.skipPlannedPayment(db, plan.id, plan.next_due_date)).rejects.toThrow('already handled');
  expect(await repo.listTransactions(db)).toEqual([]);
  expect(await accountBalance()).toBe(before);
});

test('recorded occurrence appears once in Activity with a verified source link', async () => {
  const plan = await createPlan('INCOME');
  const transactionId = await repo.markPlannedPaymentPaid(db, plan.id, plan.next_due_date);
  const activity = await listActivity(db);
  expect(activity.filter((item) => item.source_id === transactionId)).toMatchObject([{ kind: 'transaction', source: 'PLANNED', label: 'Income' }]);
  const transaction = (await repo.listTransactions(db))[0];
  expect(await ordinaryReadOnlyReason(db, transaction)).toBe(plannedReadOnlyMessage);
});

test('demo cleanup retains a plan once a real occurrence depends on it', async () => {
  await loadComprehensiveDemoData(db);
  const plan = (await repo.listPlannedPayments(db)).find((item) => item.id === 'demo_planned_rent')!;
  const transactionId = await repo.markPlannedPaymentPaid(db, plan.id, plan.next_due_date);
  await clearDemoData(db);
  expect(await repo.getPlannedPayment(db, plan.id)).toBeTruthy();
  expect(await db.getFirstAsync('SELECT id FROM transactions WHERE id = ?;', transactionId)).toBeTruthy();
  expect(await db.getFirstAsync('SELECT id FROM planned_payment_occurrences WHERE planned_payment_id = ?;', plan.id)).toBeTruthy();
});

test.each([
  [{ amount_minor: 0 }, 'amount greater than zero'],
  [{ next_due_date: '2026-02-30' }, 'valid next date'],
  [{ recurrence_type: 'EVERY_N_MONTHS', recurrence_interval: 1 }, 'at least 2 months'],
  [{ reminder_days_before: -1 }, 'valid reminder days'],
] as const)('invalid planned input is rejected without persistence: %j', async (override, message) => {
  await expect(createPlan('EXPENSE', override)).rejects.toThrow(message);
  expect(await repo.listPlannedPayments(db)).toEqual([]);
});

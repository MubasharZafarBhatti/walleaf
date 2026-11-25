/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { removeMigration11ForFixture } from './schemaFixtures';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as SQLite from 'expo-sqlite';
import { openAppDatabase, type AppDb } from '../database/database';
import { migration8 } from '../database/migration8';
import * as repo from '../database/repositories/repositories';
import { calculateAccountBalance } from '../services/finance/FinanceService';
import { getMonthlyExpenseTotal } from '../services/budget/BudgetService';
import { listActivity, ordinaryReadOnlyReason, subscriptionReadOnlyMessage } from '../services/activity/ActivityService';
import { calculateNextRenewal, getSubscriptionDueStatus, normalizedMonthlyCost, type SubscriptionInput } from '../services/subscriptions/SubscriptionService';
import { clearDemoData, loadComprehensiveDemoData } from './fixtures/demoData';
import type { FrequencyType, Subscription } from '../types/models';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
let sqlite: DatabaseSync;
let db: AppDb;
let fail = '';
let directory: string;
let tail: Promise<unknown>;
function connect(path: string) {
  sqlite = new DatabaseSync(path);
  const adapter = {
    execAsync: async (sql: string) => { sqlite.exec(sql); },
    runAsync: async (sql: string, ...params: (string | number | null)[]) => {
      if (fail && sql.startsWith(fail)) throw new Error('Injected write failure');
      return sqlite.prepare(sql).run(...params);
    },
    getAllAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).all(...params),
    getFirstAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).get(...params) ?? null,
    withTransactionAsync: async (work: () => Promise<void>) => {
      sqlite.exec('BEGIN IMMEDIATE');
      try { await work(); sqlite.exec('COMMIT'); }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    withExclusiveTransactionAsync: (work: (txn: AppDb) => Promise<void>) => {
      const result = tail.then(() => adapter.withTransactionAsync(() => work(db)));
      tail = result.catch(() => {});
      return result;
    },
  };
  db = adapter as unknown as AppDb;
  jest.mocked(SQLite.openDatabaseAsync).mockResolvedValue(db);
}
beforeEach(async () => {
  // This suite's fixed accounting fixture is September, independent of the host date.
  jest.useFakeTimers({ now: new Date(2026, 8, 15, 12) });
  fail = ''; tail = Promise.resolve();
  directory = mkdtempSync(join(tmpdir(), 'subscription-phase12-'));
  connect(join(directory, 'test.sqlite'));
  await openAppDatabase();
  await db.runAsync('UPDATE accounts SET opening_balance_minor = 100000 WHERE id = ?;', 'account_cash_default');
});
afterEach(() => { sqlite.close(); rmSync(directory, { recursive: true, force: true }); jest.useRealTimers(); });
const input: SubscriptionInput = {
  name: 'Netflix', amount_minor: 15000, account_id: 'account_cash_default', category_id: 'cat_expense_subscriptions',
  start_date: '2026-08-15', next_renewal_date: '2026-09-15', frequency_type: 'MONTHLY', frequency_interval: 1,
  reminder_enabled: 1, reminder_days_before: 3, cancellation_reminder_enabled: 0, note: 'Original note',
};
async function createSub(overrides: Partial<SubscriptionInput> = {}) {
  const id = await repo.saveSubscription(db, { ...input, ...overrides });
  return (await repo.getSubscription(db, id))!;
}
async function fresh(sub: Subscription) { return (await repo.getSubscription(db, sub.id))!; }
async function pay(sub: Subscription) { return repo.markSubscriptionPaid(db, sub.id, sub.next_renewal_date, sub.updated_at); }
async function balance() {
  return calculateAccountBalance((await repo.listAccounts(db))[0], await repo.listTransactions(db), await repo.listPersonEntries(db));
}

test('Mark Paid uses one real Expense, one account decrease, normal Spending Plan and one Activity source', async () => {
  const sub = await createSub();
  expect(await repo.listTransactions(db)).toHaveLength(0);
  const id = await pay(sub);
  const transactions = await repo.listTransactions(db);
  expect(transactions).toHaveLength(1);
  expect(transactions[0]).toMatchObject({ id, type: 'EXPENSE', source: 'SUBSCRIPTION', amount_minor: 15000, account_id: input.account_id, category_id: input.category_id });
  expect(await balance()).toBe(85000);
  expect(getMonthlyExpenseTotal(transactions, '2026-09')).toBe(15000);
  expect(await repo.listPersonEntries(db)).toEqual([]);
  expect(await listActivity(db)).toEqual([expect.objectContaining({ source_id: id, source: 'SUBSCRIPTION', type: 'EXPENSE' })]);
  const history = await repo.listSubscriptionPayments(db, sub.id);
  expect(history).toEqual([expect.objectContaining({ id: transactions[0].financial_event_id, transaction_id: id, transaction_available: 1, transaction_amount_minor: 15000, transaction_title: 'Netflix', account_name: 'Cash', category_name: 'Subscriptions' })]);
  expect(await fresh(sub)).toMatchObject({ next_renewal_date: '2026-10-15', completed_cycles: 1 });
  expect(await ordinaryReadOnlyReason(db, transactions[0])).toBe(subscriptionReadOnlyMessage);
});

test('Record Today atomically creates one first Expense/history with today cash/spending and one renewal', async () => {
  jest.setSystemTime(new Date(2026, 9, 6, 12));
  await db.runAsync('UPDATE accounts SET opening_balance_minor = 3300000');
  const id = await repo.saveSubscription(db, { ...input, amount_minor: 50000, start_date: '2026-10-06', next_renewal_date: '2026-10-06' }, { recordToday: true });
  const sub = (await repo.getSubscription(db, id))!;
  const tx = await repo.listTransactions(db);
  expect(tx).toEqual([expect.objectContaining({ type: 'EXPENSE', source: 'SUBSCRIPTION', amount_minor: 50000, occurred_on: '2026-10-06' })]);
  expect(await balance()).toBe(3250000);
  expect(getMonthlyExpenseTotal(tx, '2026-10')).toBe(50000);
  expect(getMonthlyExpenseTotal(tx, '2026-11')).toBe(0);
  expect(await repo.listSubscriptionPayments(db, id)).toEqual([expect.objectContaining({ scheduled_date: '2026-10-06', transaction_date: '2026-10-06', transaction_id: tx[0].id })]);
  expect(await listActivity(db)).toEqual([expect.objectContaining({ source_id: tx[0].id, occurred_on: '2026-10-06' })]);
  expect(sub).toMatchObject({ next_renewal_date: '2026-11-06', completed_cycles: 1 });
  await expect(repo.markSubscriptionPaid(db, id, '2026-10-06', sub.updated_at)).rejects.toThrow('already paid');
  expect(await repo.listTransactions(db)).toHaveLength(1);
});

test('Start Next Renewal is tracking-only with empty history and unchanged accounts/spending', async () => {
  jest.setSystemTime(new Date(2026, 9, 6, 12));
  const sub = await createSub({ start_date: '2026-10-06', next_renewal_date: '2026-11-06' });
  expect(sub).toMatchObject({ next_renewal_date: '2026-11-06', completed_cycles: 0 });
  expect(await repo.listTransactions(db)).toEqual([]);
  expect(await repo.listSubscriptionPayments(db, sub.id)).toEqual([]);
  expect(await balance()).toBe(100000);
  expect(getMonthlyExpenseTotal(await repo.listTransactions(db), '2026-10')).toBe(0);
});

test('early Mark Paid defaults to actual today and retains the scheduled anchor/replay key', async () => {
  jest.setSystemTime(new Date(2026, 9, 6, 12));
  const sub = await createSub({ start_date: '2026-10-06', next_renewal_date: '2026-11-06' });
  const txId = await pay(sub);
  expect(await repo.listTransactions(db)).toEqual([expect.objectContaining({ id: txId, occurred_on: '2026-10-06' })]);
  expect(await repo.listSubscriptionPayments(db, sub.id)).toEqual([expect.objectContaining({ scheduled_date: '2026-11-06', transaction_date: '2026-10-06' })]);
  expect(getMonthlyExpenseTotal(await repo.listTransactions(db), '2026-10')).toBe(15000);
  expect(getMonthlyExpenseTotal(await repo.listTransactions(db), '2026-11')).toBe(0);
  expect(await fresh(sub)).toMatchObject({ next_renewal_date: '2026-12-06', completed_cycles: 1 });
  await expect(pay(sub)).rejects.toThrow('already paid');
  expect(await balance()).toBe(85000);
});

test.each(['INSERT INTO transactions', 'INSERT INTO subscription_payments', 'UPDATE subscriptions SET completed_cycles'])('first payment failure at %s rolls back subscription creation too', async (write) => {
  const today = '2026-09-15';
  fail = write;
  await expect(repo.saveSubscription(db, { ...input, start_date: today, next_renewal_date: today }, { recordToday: true })).rejects.toThrow('Injected write failure');
  expect(await repo.listSubscriptions(db)).toEqual([]);
  expect(await repo.listTransactions(db)).toEqual([]);
  expect(await db.getAllAsync('SELECT * FROM subscription_payments')).toEqual([]);
  expect(await balance()).toBe(100000);
});

test.each(['2026-09-16', '2026-02-30', 'invalid'])('invalid/future actual payment date %s is rejected without writes', async (paymentDate) => {
  const sub = await createSub();
  await expect(repo.markSubscriptionPaid(db, sub.id, sub.next_renewal_date, sub.updated_at, paymentDate)).rejects.toThrow('Payment date');
  expect(await repo.listTransactions(db)).toEqual([]);
  expect(await fresh(sub)).toEqual(sub);
});

test('parallel double tap and stale screen can record the same occurrence only once', async () => {
  const sub = await createSub();
  const results = await Promise.allSettled([pay(sub), pay(sub)]);
  expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  await expect(pay(sub)).rejects.toThrow('already paid');
  expect(await repo.listTransactions(db)).toHaveLength(1);
  expect(await balance()).toBe(85000);
  expect((await fresh(sub)).completed_cycles).toBe(1);
});

test('close and reopen the actual SQLite file preserves replay protection', async () => {
  const sub = await createSub(); await pay(sub);
  sqlite.close(); connect(join(directory, 'test.sqlite')); await openAppDatabase();
  await expect(pay(sub)).rejects.toThrow('already paid');
  expect(await repo.listSubscriptionPayments(db, sub.id)).toHaveLength(1);
  expect(await repo.listTransactions(db)).toHaveLength(1);
  expect(await balance()).toBe(85000);
});

test.each(['INSERT INTO transactions', 'INSERT INTO subscription_payments', 'UPDATE subscriptions SET completed_cycles'])('rollback at %s leaves no payment, Expense or advancement', async (write) => {
  const sub = await createSub(); fail = write;
  await expect(pay(sub)).rejects.toThrow('Injected write failure');
  expect(await repo.listTransactions(db)).toEqual([]);
  expect(await repo.listSubscriptionPayments(db, sub.id)).toEqual([]);
  expect(await fresh(sub)).toEqual(sub);
  expect(await balance()).toBe(100000);
  fail = ''; await pay(sub);
  expect(await repo.listTransactions(db)).toHaveLength(1);
});

test('pause/resume changes metadata only and retains the due date without missed payments', async () => {
  const sub = await createSub(); await pay(sub);
  const before = await repo.listTransactions(db);
  let current = await fresh(sub);
  await repo.changeSubscriptionStatus(db, sub.id, current.updated_at, 'PAUSED');
  current = await fresh(sub);
  expect(getSubscriptionDueStatus(current, '2028-12-31')).toEqual({ status: 'PAUSED', label: 'Paused' });
  await expect(pay(current)).rejects.toThrow('Only active');
  await repo.changeSubscriptionStatus(db, sub.id, current.updated_at, 'ACTIVE');
  expect(await fresh(sub)).toMatchObject({ next_renewal_date: '2026-10-15', completed_cycles: 1, status: 'ACTIVE' });
  expect(await repo.listTransactions(db)).toEqual(before);
  expect(await balance()).toBe(85000);
});

test('Cancel Tracking retains Expense and linked history and disallows future payment', async () => {
  const sub = await createSub(); await pay(sub);
  const before = await repo.listTransactions(db);
  const history = await repo.listSubscriptionPayments(db, sub.id);
  await repo.changeSubscriptionStatus(db, sub.id, (await fresh(sub)).updated_at, 'CANCELLED');
  expect(await repo.listTransactions(db)).toEqual(before);
  expect(await repo.listSubscriptionPayments(db, sub.id)).toEqual(history);
  await expect(pay(await fresh(sub))).rejects.toThrow('Only active');
  expect(getSubscriptionDueStatus(await fresh(sub), '2028-01-01').label).toBe('Cancelled');
  expect((await repo.listSubscriptions(db)).map((s) => s.id)).toContain(sub.id);
});

test('prospective account/category/name/amount/frequency edits leave historical Expense fields intact', async () => {
  const sub = await createSub(); await pay(sub);
  const before = await repo.listTransactions(db);
  await repo.createAccount(db, { name: 'My bank', type: 'BANK', opening_balance_minor: 50000 });
  const bank = (await repo.listAccounts(db)).find((account) => account.name === 'My bank')!.id;
  const current = await fresh(sub);
  await repo.updateSubscription(db, sub.id, current.updated_at, { ...current, name: 'Future service', amount_minor: 10000, account_id: bank, category_id: 'cat_expense_bills', frequency_type: 'EVERY_N_MONTHS', frequency_interval: 3, note: 'Future note' });
  expect(await repo.listTransactions(db)).toEqual(before);
  await pay(await fresh(sub));
  const rows = await repo.listSubscriptionPayments(db, sub.id);
  expect(rows.map((r) => [r.transaction_title, r.transaction_amount_minor, r.account_name, r.category_name])).toEqual([
    ['Future service', 10000, 'My bank', 'Bills'], ['Netflix', 15000, 'Cash', 'Subscriptions'],
  ]);
  expect((await fresh(sub)).next_renewal_date).toBe('2027-01-15');
});

test('stale pre-edit Mark Paid and restoring an already-paid scheduled date are rejected', async () => {
  const sub = await createSub();
  await repo.updateSubscription(db, sub.id, sub.updated_at, { ...sub, amount_minor: 20000 });
  await expect(pay(sub)).rejects.toThrow('changed');
  await pay(await fresh(sub));
  const current = await fresh(sub);
  await expect(repo.updateSubscription(db, sub.id, current.updated_at, { ...current, next_renewal_date: sub.next_renewal_date })).rejects.toThrow('already paid');
  expect(await repo.listTransactions(db)).toHaveLength(1);
});

test.each([29, 30, 31])('stored monthly anchor %i survives February and later payment/edit cycles', async (day) => {
  let sub = await createSub({ start_date: `2027-01-${day}`, next_renewal_date: `2027-01-${day}` });
  await pay(sub); sub = await fresh(sub);
  expect(sub.next_renewal_date).toBe('2027-02-28');
  await repo.updateSubscription(db, sub.id, sub.updated_at, { ...sub, note: 'Keeps anchor' });
  await pay(await fresh(sub)); sub = await fresh(sub);
  expect(sub.next_renewal_date).toBe(`2027-03-${day}`);
  expect(sub.recurrence_anchor_day).toBe(day);
});

test.each([
  ['2028-01-31', 'MONTHLY', 1, 31, '2028-02-29', '2028-03-31'],
  ['2027-11-30', 'EVERY_N_MONTHS', 3, 30, '2028-02-29', '2028-05-30'],
  ['2027-12-31', 'EVERY_N_MONTHS', 2, 31, '2028-02-29', '2028-04-30'],
  ['2028-02-29', 'YEARLY', 1, 29, '2029-02-28', '2030-02-28'],
  ['2026-12-28', 'WEEKLY', 1, 28, '2027-01-04', '2027-01-11'],
] as const)('central recurrence %s %s follows deterministic boundaries', (date, frequency, interval, anchor, first, second) => {
  expect(calculateNextRenewal(date, frequency, interval, anchor)).toBe(first);
  expect(calculateNextRenewal(first, frequency, interval, anchor)).toBe(second);
});

test('yearly leap-day anchor returns to February 29 in the next leap year', async () => {
  let sub = await createSub({ start_date: '2028-02-29', next_renewal_date: '2028-02-29', frequency_type: 'YEARLY' });
  for (const expected of ['2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']) {
    await pay(sub); sub = await fresh(sub); expect(sub.next_renewal_date).toBe(expected);
  }
});

test('explicit next-date editing establishes a prospective anchor without rewriting earlier payments', async () => {
  let sub = await createSub({ start_date: '2027-01-31', next_renewal_date: '2027-01-31' });
  await pay(sub); sub = await fresh(sub);
  await repo.updateSubscription(db, sub.id, sub.updated_at, { ...sub, next_renewal_date: '2027-03-30' });
  await pay(await fresh(sub));
  expect(await fresh(sub)).toMatchObject({ next_renewal_date: '2027-04-30', recurrence_anchor_day: 30 });
  expect((await repo.listSubscriptionPayments(db, sub.id))[1].scheduled_date).toBe('2027-01-31');
});

test.each([
  ['MONTHLY', 1, 10001, 10001], ['EVERY_N_MONTHS', 3, 10001, 3334],
  ['YEARLY', 1, 10002, 834], ['WEEKLY', 1, 10001, 43338],
] as const)('normalized %s reporting uses deterministic integer rounding', (frequency, interval, amount, expected) => {
  expect(normalizedMonthlyCost({ frequency_type: frequency, frequency_interval: interval, amount_minor: amount })).toBe(expected);
});

test('monthly reporting is integer safe at boundaries and creates no financial records', async () => {
  expect(normalizedMonthlyCost({ frequency_type: 'YEARLY', frequency_interval: 1, amount_minor: Number.MAX_SAFE_INTEGER })).toBe(750599937895083);
  expect(() => normalizedMonthlyCost({ frequency_type: 'WEEKLY', frequency_interval: 1, amount_minor: Number.MAX_SAFE_INTEGER })).toThrow('supported range');
  const sub = await createSub(); normalizedMonthlyCost(sub);
  expect(await repo.listTransactions(db)).toEqual([]); expect(await balance()).toBe(100000);
});

test.each([
  ['2026-09-14', 'UPCOMING'], ['2026-09-15', 'DUE_TODAY'], ['2026-09-16', 'OVERDUE'],
] as const)('friendly due status at %s is %s', async (today, expected) => {
  const sub = await createSub(); expect(getSubscriptionDueStatus(sub, today).status).toBe(expected);
});

test('cycle and end-date limits end tracking after one payment, retaining history', async () => {
  for (const overrides of [{ total_cycles: 1 }, { end_date: '2026-09-30' }]) {
    const sub = await createSub(overrides); await pay(sub);
    expect((await fresh(sub)).status).toBe('ENDED');
    await expect(pay(await fresh(sub))).rejects.toThrow('already paid');
    expect(await repo.listSubscriptionPayments(db, sub.id)).toHaveLength(1);
  }
});

test('archived active references reject stale payment and resume, while history retains their names', async () => {
  const sub = await createSub(); await pay(sub);
  await db.runAsync('UPDATE categories SET is_archived = 1 WHERE id = ?;', sub.category_id);
  await expect(pay(await fresh(sub))).rejects.toThrow();
  await repo.changeSubscriptionStatus(db, sub.id, (await fresh(sub)).updated_at, 'PAUSED');
  await expect(repo.changeSubscriptionStatus(db, sub.id, (await fresh(sub)).updated_at, 'ACTIVE')).rejects.toThrow();
  expect((await repo.listSubscriptionPayments(db, sub.id))[0].category_name).toBe('Subscriptions');
  expect(await repo.listTransactions(db)).toHaveLength(1);
});

test('removed real Expense is accurately unavailable in history and its occurrence remains consumed', async () => {
  const sub = await createSub(); const tx = await pay(sub);
  await db.runAsync('UPDATE transactions SET deleted_at = ? WHERE id = ?;', '2026-10-01', tx);
  expect((await repo.listSubscriptionPayments(db, sub.id))[0].transaction_available).toBe(0);
  await expect(pay(sub)).rejects.toThrow('already paid');
  expect(await balance()).toBe(100000);
});

test('SQLite independently rejects duplicate identity and wrong source linkage', async () => {
  const sub = await createSub(); const tx = await pay(sub);
  const p = (await repo.listSubscriptionPayments(db, sub.id))[0];
  await expect(db.runAsync('INSERT INTO subscription_payments (id, subscription_id, scheduled_date, transaction_id, created_at) VALUES (?, ?, ?, ?, ?);', p.id, sub.id, p.scheduled_date, tx, 'now')).rejects.toThrow();
  await expect(db.runAsync('UPDATE subscription_payments SET scheduled_date = ? WHERE id = ?;', '2026-10-15', p.id)).rejects.toThrow('immutable');
  await expect(db.runAsync('INSERT INTO subscription_payments (id, subscription_id, scheduled_date, transaction_id, created_at) VALUES (?, ?, ?, ?, ?);', 'wrong', sub.id, '2026-10-15', tx, 'now')).rejects.toThrow('Invalid subscription payment source');
});

test('the SQL occurrence unique constraint rejects a second otherwise valid Expense link atomically', async () => {
  const sub = await createSub(); await pay(sub);
  await expect(db.withExclusiveTransactionAsync(async (txn) => {
    // Simulate an erroneous future writer that bypassed the repository replay check.
    await txn.runAsync('UPDATE subscriptions SET next_renewal_date = ? WHERE id = ?;', sub.next_renewal_date, sub.id);
    const tx = await repo.saveTransaction(txn, { type: 'EXPENSE', amount_minor: sub.amount_minor, account_id: sub.account_id, category_id: sub.category_id, occurred_on: sub.next_renewal_date, title: sub.name, source: 'SUBSCRIPTION', financial_event_id: 'second-payment' });
    await txn.runAsync('INSERT INTO subscription_payments (id, subscription_id, scheduled_date, transaction_id, created_at) VALUES (?, ?, ?, ?, ?);', 'second-payment', sub.id, sub.next_renewal_date, tx, 'now');
  })).rejects.toThrow('UNIQUE constraint failed: subscription_payments.subscription_id, subscription_payments.scheduled_date');
  expect(await repo.listTransactions(db)).toHaveLength(1);
  expect(await balance()).toBe(85000);
  expect((await fresh(sub)).next_renewal_date).toBe('2026-10-15');
});

test.each([2, 3, 6])('every %i months posts and advances with its saved anchor', async (interval) => {
  let sub = await createSub({ frequency_type: 'EVERY_N_MONTHS', frequency_interval: interval, start_date: '2027-11-30', next_renewal_date: '2027-11-30' });
  await pay(sub); sub = await fresh(sub);
  const first = interval === 2 ? '2028-01-30' : interval === 3 ? '2028-02-29' : '2028-05-30';
  expect(sub.next_renewal_date).toBe(first);
  await pay(sub); sub = await fresh(sub);
  expect(sub.recurrence_anchor_day).toBe(30); expect(sub.completed_cycles).toBe(2);
  expect(await repo.listSubscriptionPayments(db, sub.id)).toHaveLength(2);
});

test('migration 8 preserves all legacy schedule fields and financial history without inferred payments', async () => {
  const sub = await createSub();
  await repo.saveTransaction(db, { type: 'EXPENSE', amount_minor: 500, account_id: input.account_id, category_id: input.category_id, title: 'Old source', occurred_on: '2026-08-15', source: 'SUBSCRIPTION' });
  await removeMigration11ForFixture(db);
  await db.execAsync('ALTER TABLE split_groups DROP COLUMN split_definition; DROP TABLE subscription_payments; ALTER TABLE subscriptions DROP COLUMN recurrence_anchor_day; ALTER TABLE subscriptions DROP COLUMN user_managed; DELETE FROM schema_migrations WHERE version >= 8;');
  const before = await db.getAllAsync('SELECT * FROM subscriptions;');
  const transactions = await repo.listTransactions(db);
  await openAppDatabase();
  const after = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM subscriptions;');
  expect(after.map(({ recurrence_anchor_day: anchor, user_managed: managed, schedule_provenance: provenance, ...row }) => { expect(anchor).toBeNull(); expect(managed).toBe(0); expect(provenance).toBeNull(); return row; })).toEqual(before);
  expect(await repo.listTransactions(db)).toEqual(transactions.map((row) => ({ ...row, cash_effect_minor: null, destination_amount_minor: null })));
  expect(await repo.listSubscriptionPayments(db, sub.id)).toEqual([]);
  expect((await db.getFirstAsync<{ v: number }>('SELECT MAX(version) v FROM schema_migrations;'))?.v).toBe(14);
});

test('failed additive migration rolls its columns and payment table back together', async () => {
  const isolated = new DatabaseSync(':memory:');
  try {
    isolated.exec('CREATE TABLE subscriptions (id TEXT PRIMARY KEY); BEGIN;');
    expect(() => isolated.exec(`${migration8} SELECT * FROM injected_missing_table;`)).toThrow();
    isolated.exec('ROLLBACK;');
    expect(isolated.prepare('PRAGMA table_info(subscriptions);').all()).toHaveLength(1);
    expect(isolated.prepare("SELECT name FROM sqlite_master WHERE name = 'subscription_payments';").all()).toEqual([]);
  } finally { isolated.close(); }
});

test('demo clear retains real subscription payments and manually edited tracking definitions', async () => {
  await loadComprehensiveDemoData(db);
  const subs = await repo.listSubscriptions(db);
  const paid = subs[0]; await pay(paid);
  const edited = subs[1]; await repo.updateSubscription(db, edited.id, edited.updated_at, { ...edited, name: 'My tracked service' });
  await clearDemoData(db);
  expect(await repo.getSubscription(db, paid.id)).not.toBeNull();
  expect(await repo.listSubscriptionPayments(db, paid.id)).toHaveLength(1);
  expect((await repo.getSubscription(db, edited.id))?.name).toBe('My tracked service');
  expect((await repo.listTransactions(db)).filter((t) => t.source === 'SUBSCRIPTION')).toHaveLength(1);
});

test.each(['NONE', 'INVALID'])('unsupported subscription frequency %s is rejected without writes', async (frequency) => {
  await expect(createSub({ frequency_type: frequency as FrequencyType })).rejects.toThrow();
  expect(await repo.listSubscriptions(db)).toEqual([]);
});

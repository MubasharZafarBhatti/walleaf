/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import * as SQLite from 'expo-sqlite';
import { openAppDatabase, type AppDb } from '../database/database';
import * as repo from '../database/repositories/repositories';
import { activityDateBounds, activitySubtitle, legacyReadOnlyMessage, listActivity, ordinaryReadOnlyReason, plannedReadOnlyMessage, readSharedEvent, subscriptionReadOnlyMessage } from '../services/activity/ActivityService';
import { readGroupSnapshot } from '../services/groups/GroupService';
import { deleteTransaction, updateTransaction } from '../services/finance/TransactionService';
import { deleteSharedExpense, saveSharedExpensePosting, sharedReadOnlyReason, updateSharedExpense, type SharedExpensePostingInput } from '../services/sharedExpense/SharedExpenseService';
import { calculateAccountBalance } from '../services/finance/FinanceService';
import { getMonthlyExpenseTotal } from '../services/budget/BudgetService';
import { calculatePersonBalance } from '../services/people/PeopleBalanceService';
import { clearDemoData, loadComprehensiveDemoData } from './fixtures/demoData';
import type { Account, TransactionType } from '../types/models';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
let sqlite: DatabaseSync;
let db: AppDb;
let failOn: string | null;
let ali: string;
let sam: string;
let bank: string;
const cash = 'account_cash_default';
const food = 'cat_expense_food';
const salary = 'cat_income_salary';
const day = '2026-09-12';

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  failOn = null;
  const adapter = {
    execAsync: async (sql: string) => { sqlite.exec(sql); },
    runAsync: async (sql: string, ...params: (string | number | null)[]) => {
      if (failOn && sql.includes(failOn)) throw new Error('Injected failure');
      return sqlite.prepare(sql).run(...params);
    },
    getAllAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).all(...params),
    getFirstAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).get(...params) ?? null,
    withTransactionAsync: async (work: () => Promise<void>) => {
      sqlite.exec('BEGIN');
      try { await work(); sqlite.exec('COMMIT'); } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    },
    withExclusiveTransactionAsync: async (work: (txn: AppDb) => Promise<void>) => adapter.withTransactionAsync(() => work(db)),
  };
  db = adapter as unknown as AppDb;
  jest.mocked(SQLite.openDatabaseAsync).mockResolvedValue(db);
  await openAppDatabase();
  ali = await repo.savePerson(db, 'Ali');
  sam = await repo.savePerson(db, 'Sam');
  await repo.createAccount(db, { name: 'My bank', type: 'BANK', opening_balance_minor: 0 });
  bank = (await repo.listAccounts(db)).find((a) => a.name === 'My bank')!.id;
});
afterEach(() => sqlite.close());

function input(overrides: Partial<SharedExpensePostingInput> = {}): SharedExpensePostingInput {
  return { title: 'Dinner', totalAmountMinor: 10000, categoryId: food, accountId: cash, occurredOn: day, payerIsSelf: true, shares: [{ name: 'You', isSelf: true, shareMinor: 4000 }, { name: 'Ali', personId: ali, isSelf: false, shareMinor: 6000 }], ...overrides };
}
async function normal(type: TransactionType = 'EXPENSE') {
  const id = await repo.saveTransaction(db, { type, amount_minor: 1000, account_id: cash, destination_account_id: type === 'TRANSFER' ? bank : null, category_id: type === 'TRANSFER' ? null : type === 'INCOME' ? salary : food, title: 'Ordinary', note: 'A note', occurred_on: day, source: 'MANUAL' });
  return (await repo.listTransactions(db)).find((t) => t.id === id)!;
}
async function balances() {
  const txs = await repo.listTransactions(db);
  const entries = await repo.listPersonEntries(db);
  const accounts = await db.getAllAsync<Account>('SELECT * FROM accounts;');
  return { cash: calculateAccountBalance(accounts.find((a) => a.id === cash)!, txs, entries), bank: calculateAccountBalance(accounts.find((a) => a.id === bank)!, txs, entries), spent: getMonthlyExpenseTotal(txs, '2026-09'), ali: calculatePersonBalance(entries.filter((e) => e.person_id === ali)), sam: calculatePersonBalance(entries.filter((e) => e.person_id === sam)) };
}
function snapshot() {
  return JSON.stringify(['transactions', 'person_entries', 'split_groups', 'split_participants', 'people', 'accounts', 'categories', 'groups', 'group_members', 'planned_payments', 'subscriptions'].map((table) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()));
}

test('recorded order beats future effective dates and ordinary/shared edits preserve original creation rank', async () => {
  const old = await normal();
  const future = await repo.saveTransaction(db, { type: 'EXPENSE', amount_minor: 100, account_id: cash, category_id: food, title: 'Future dated', occurred_on: '2027-01-01', source: 'MANUAL' });
  const shared = await saveSharedExpensePosting(db, input());
  const newest = await repo.saveTransaction(db, { type: 'EXPENSE', amount_minor: 100, account_id: cash, category_id: food, title: 'Newest recorded', occurred_on: '2026-08-01', source: 'MANUAL' });
  await db.runAsync("UPDATE transactions SET created_at = '2026-09-01T00:00:00.000Z' WHERE id = ?;", old.id);
  await db.runAsync("UPDATE transactions SET created_at = '2026-09-02T00:00:00.000Z' WHERE id = ?;", future);
  await db.runAsync("UPDATE split_groups SET created_at = '2026-09-03T00:00:00.000Z' WHERE id = ?;", shared.splitGroup.id);
  await db.runAsync("UPDATE transactions SET created_at = '2026-09-04T00:00:00.000Z' WHERE id = ?;", newest);
  const ids = () => listActivity(db, { order: 'CREATED' }).then((rows) => rows.map((row) => row.source_id));
  expect(await ids()).toEqual([newest, shared.splitGroup.id, future, old.id]);
  await updateTransaction(db, old.id, old.updated_at, { ...old, title: 'Old corrected', occurred_on: '2028-01-01' });
  const records = await readSharedEvent(db, shared.splitGroup.id);
  await updateSharedExpense(db, records.split.id, records.split.updated_at, input({ title: 'Shared corrected', occurredOn: '2028-02-01' }));
  expect(await ids()).toEqual([newest, shared.splitGroup.id, future, old.id]);
  expect((await readSharedEvent(db, shared.splitGroup.id)).split.created_at).toBe('2026-09-03T00:00:00.000Z');
  expect((await listActivity(db, { range: 'CUSTOM', from: '2027-01-01', to: '2027-01-01' })).map((row) => row.source_id)).toEqual([future]);
});

test('date order lists the newest activity date first and breaks same-day ties by newest recorded', async () => {
  const early = await repo.saveTransaction(db, { type: 'EXPENSE', amount_minor: 100, account_id: cash, category_id: food, title: 'Back-dated', occurred_on: '2026-08-01', source: 'MANUAL' });
  const late = await repo.saveTransaction(db, { type: 'EXPENSE', amount_minor: 100, account_id: cash, category_id: food, title: 'Later date', occurred_on: '2026-08-20', source: 'MANUAL' });
  const sameDayFirst = await repo.saveTransaction(db, { type: 'EXPENSE', amount_minor: 100, account_id: cash, category_id: food, title: 'Same day 1', occurred_on: '2026-08-10', source: 'MANUAL' });
  const sameDaySecond = await repo.saveTransaction(db, { type: 'EXPENSE', amount_minor: 100, account_id: cash, category_id: food, title: 'Same day 2', occurred_on: '2026-08-10', source: 'MANUAL' });
  await db.runAsync("UPDATE transactions SET created_at = '2026-09-04T00:00:00.000Z' WHERE id = ?;", early);
  await db.runAsync("UPDATE transactions SET created_at = '2026-09-01T00:00:00.000Z' WHERE id = ?;", late);
  await db.runAsync("UPDATE transactions SET created_at = '2026-09-02T00:00:00.000Z' WHERE id = ?;", sameDayFirst);
  await db.runAsync("UPDATE transactions SET created_at = '2026-09-03T00:00:00.000Z' WHERE id = ?;", sameDaySecond);
  expect((await listActivity(db)).map((row) => row.source_id)).toEqual([late, sameDaySecond, sameDayFirst, early]);
  expect((await listActivity(db, { order: 'DATE' })).map((row) => row.source_id)).toEqual([late, sameDaySecond, sameDayFirst, early]);
  expect((await listActivity(db, { order: 'CREATED' })).map((row) => row.source_id)).toEqual([early, sameDaySecond, sameDayFirst, late]);
});

test('creation ordering normalizes timezone timestamps and has an edit-independent stable legacy fallback', async () => {
  const fixtures = [
    ['utc', '2026-10-07T09:00:00.000Z'], ['offset', '2026-10-07T11:00:00+02:00'],
    ['date-only', '2026-10-06'], ['legacy-a', ''], ['legacy-b', 'bad'], ['legacy-c', '12:30'],
  ];
  for (const [id, created] of fixtures) {
    const tx = await normal();
    await db.runAsync('UPDATE transactions SET id = ?, created_at = ? WHERE id = ?;', id, created, tx.id);
  }
  expect((await listActivity(db, { order: 'CREATED' })).map((row) => row.source_id)).toEqual(['offset', 'utc', 'date-only', 'legacy-a', 'legacy-b', 'legacy-c']);
  await db.runAsync("UPDATE transactions SET updated_at = '2099-01-01T00:00:00.000Z', occurred_on = '2099-01-01' WHERE id = 'legacy-b';");
  expect((await listActivity(db, { order: 'CREATED' })).map((row) => row.source_id)).toEqual(['offset', 'utc', 'date-only', 'legacy-a', 'legacy-b', 'legacy-c']);
});

test('third-party Tea remains in Group history/detail but has no personal feed or financial effect', async () => {
  const groupId = await repo.createGroup(db, { name: 'Others', personIds: [ali, sam], includeSelf: false });
  const before = await balances();
  const plan = await saveSharedExpensePosting(db, input({ title: 'Tea', groupId, payerIsSelf: false, payerPersonId: ali, shares: [{ name: 'Sam', personId: sam, isSelf: false, shareMinor: 10000 }] }));
  expect(await balances()).toEqual(before);
  expect(await listActivity(db)).toEqual([]);
  expect((await readGroupSnapshot(db, groupId)).expenses.map((row) => row.id)).toEqual([plan.splitGroup.id]);
  expect(await listActivity(db, { activityId: `shared:${plan.splitGroup.id}` })).toHaveLength(1);
  const userParticipant = await saveSharedExpensePosting(db, input({ groupId, payerIsSelf: false, payerPersonId: ali }));
  expect((await listActivity(db)).map((row) => row.source_id)).toEqual([userParticipant.splitGroup.id]);
});

test('adjustment subtitle names account and optional reason without repeating the title', async () => {
  const tx = await normal();
  await db.runAsync("UPDATE transactions SET type = 'ADJUSTMENT', title = 'Balance adjustment', note = 'Bank reconciliation', category_id = NULL WHERE id = ?;", tx.id);
  const row = (await listActivity(db))[0];
  expect(activitySubtitle(row, '7 Oct')).toBe('Cash · Bank reconciliation · 7 Oct');
  expect(activitySubtitle({ ...row, note: null }, '7 Oct')).toBe('Cash · 7 Oct');
});
async function assertNoOrphans() {
  expect(await db.getAllAsync('SELECT p.id FROM split_participants p LEFT JOIN split_groups s ON s.id = p.split_group_id WHERE s.id IS NULL;')).toEqual([]);
  expect(await db.getAllAsync('SELECT e.id FROM person_entries e LEFT JOIN split_groups s ON s.id = e.split_group_id WHERE e.split_group_id IS NOT NULL AND s.id IS NULL;')).toEqual([]);
  expect(await db.getAllAsync("SELECT t.id FROM transactions t LEFT JOIN split_groups s ON s.id = t.group_id WHERE t.source = 'SPLIT' AND s.id IS NULL;")).toEqual([]);
}

test.each(['EXPENSE', 'INCOME', 'TRANSFER'] as const)('%s edit updates accounts/date/category; delete reverses both effects without People/budget leakage', async (type) => {
  const tx = await normal(type);
  const changed = { ...tx, amount_minor: 2500, account_id: bank, destination_account_id: type === 'TRANSFER' ? cash : null, title: 'Corrected', note: 'New note', occurred_on: '2026-08-31' };
  await updateTransaction(db, tx.id, tx.updated_at, changed);
  const saved = (await repo.listTransactions(db))[0];
  expect(saved).toMatchObject({ title: 'Corrected', note: 'New note', occurred_on: '2026-08-31', amount_minor: 2500 });
  expect(await balances()).toEqual({ cash: type === 'TRANSFER' ? 2500 : 0, bank: type === 'INCOME' ? 2500 : -2500, spent: 0, ali: 0, sam: 0 });
  await deleteTransaction(db, saved.id, saved.updated_at);
  expect(await balances()).toEqual({ cash: 0, bank: 0, spent: 0, ali: 0, sam: 0 });
  expect(await listActivity(db)).toEqual([]);
});

test('normal category/amount correction changes personal spending and preserves unrelated income', async () => {
  const tx = await normal();
  const income = await normal('INCOME');
  await updateTransaction(db, tx.id, tx.updated_at, { ...tx, amount_minor: 2500, category_id: 'cat_expense_fuel' });
  expect(await balances()).toMatchObject({ cash: -1500, spent: 2500 });
  expect(await listActivity(db, { categoryId: 'cat_expense_fuel' })).toHaveLength(1);
  await deleteTransaction(db, income.id, income.updated_at);
  expect(await balances()).toMatchObject({ cash: -2500, spent: 2500 });
});

test('Home limit four returns the newest unified events and never shared child duplicates', async () => {
  jest.useFakeTimers();
  try {
    for (let i = 1; i <= 5; i++) {
      jest.setSystemTime(new Date(`2026-09-12T10:00:0${i}.000Z`));
      await repo.saveTransaction(db, { type: 'EXPENSE', amount_minor: 100, account_id: cash, category_id: food, title: `Event ${i}`, occurred_on: `2026-09-0${6 - i}`, source: 'MANUAL' });
    }
    jest.setSystemTime(new Date('2026-09-12T10:00:06.000Z'));
    await saveSharedExpensePosting(db, input({ title: 'Latest shared bill', occurredOn: '2026-09-06' }));
    const rows = await listActivity(db, { type: 'ALL', range: 'ALL', limit: 4, order: 'CREATED' });
    expect(rows.map((row) => row.title)).toEqual(['Latest shared bill', 'Event 5', 'Event 4', 'Event 3']);
    // Default order is by activity date (6 Sep shared bill, then Event 1 on 5 Sep ...), newest recorded first on a tie.
    expect((await listActivity(db, { type: 'ALL', range: 'ALL', limit: 4 })).map((row) => row.title)).toEqual(['Latest shared bill', 'Event 1', 'Event 2', 'Event 3']);
    expect(rows[0].kind).toBe('shared');
    expect(rows).toHaveLength(4);
  } finally { jest.useRealTimers(); }
});

test.each(['UPDATE transactions', 'DELETE FROM transactions'])('ordinary %s failure rolls back', async (sql) => {
  const tx = await normal();
  const before = snapshot();
  failOn = sql;
  await expect(sql.startsWith('UPDATE') ? updateTransaction(db, tx.id, tx.updated_at, { ...tx, amount_minor: 2000 }) : deleteTransaction(db, tx.id, tx.updated_at)).rejects.toThrow('Injected');
  expect(snapshot()).toBe(before);
});

test('stale ordinary edit/delete cannot repeat or overwrite a successful correction', async () => {
  const tx = await normal();
  await updateTransaction(db, tx.id, tx.updated_at, tx);
  await expect(updateTransaction(db, tx.id, tx.updated_at, tx)).rejects.toThrow('changed');
  await expect(deleteTransaction(db, tx.id, tx.updated_at)).rejects.toThrow('changed');
});

test.each([0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])('invalid ordinary amount %s leaves data intact', async (amount_minor) => {
  const tx = await normal();
  const before = snapshot();
  await expect(updateTransaction(db, tx.id, tx.updated_at, { ...tx, amount_minor })).rejects.toThrow();
  expect(snapshot()).toBe(before);
});

test('invalid transfer destination and wrong category/date fail without writes', async () => {
  const tx = await normal('TRANSFER');
  await expect(updateTransaction(db, tx.id, tx.updated_at, { ...tx, destination_account_id: cash })).rejects.toThrow('different');
  const expense = await normal();
  await expect(updateTransaction(db, expense.id, expense.updated_at, { ...expense, category_id: salary })).rejects.toThrow('category');
  await expect(updateTransaction(db, expense.id, expense.updated_at, { ...expense, occurred_on: '2026-02-30' })).rejects.toThrow('date');
});

test('shared payer, account, person, amount and category updates use existing accounting; unrelated repayment survives delete', async () => {
  const plan = await saveSharedExpensePosting(db, input());
  const id = plan.splitGroup.id;
  await repo.savePersonEntry(db, { person_id: ali, type: 'RECEIVED_BACK', amount_minor: 1000, account_id: cash, title: 'Dinner', occurred_on: day });
  expect(await balances()).toEqual({ cash: -9000, bank: 0, spent: 4000, ali: 5000, sam: 0 });
  let records = await readSharedEvent(db, id);
  await updateSharedExpense(db, id, records.split.updated_at, input({ payerIsSelf: false, payerPersonId: sam, accountId: bank, categoryId: 'cat_expense_fuel', totalAmountMinor: 15000, shares: [{ name: 'You', isSelf: true, shareMinor: 5000 }, { name: 'Sam', personId: sam, isSelf: false, shareMinor: 10000 }] }));
  expect(await balances()).toEqual({ cash: 1000, bank: 0, spent: 5000, ali: -1000, sam: -5000 });
  records = await readSharedEvent(db, id);
  expect(await sharedReadOnlyReason(db, records)).toBeNull();
  expect(records.transactions).toHaveLength(1);
  expect(records.entries).toHaveLength(1);
  await updateSharedExpense(db, id, records.split.updated_at, input({ payerIsSelf: true, accountId: bank, shares: [{ name: 'You', isSelf: true, shareMinor: 4000 }, { name: 'Sam', personId: sam, isSelf: false, shareMinor: 6000 }] }));
  expect(await balances()).toEqual({ cash: 1000, bank: -10000, spent: 4000, ali: -1000, sam: 6000 });
  records = await readSharedEvent(db, id);
  await deleteSharedExpense(db, id, records.split.updated_at);
  expect(await balances()).toEqual({ cash: 1000, bank: 0, spent: 0, ali: -1000, sam: 0 });
  expect(await repo.listPersonEntries(db)).toHaveLength(1);
  await assertNoOrphans();
});

test.each([true, false])('user-absent event paid by self=%s retains detail/edit/delete with only user-relevant personal feed visibility', async (payerIsSelf) => {
  const plan = await saveSharedExpensePosting(db, input({ payerIsSelf, payerPersonId: payerIsSelf ? null : ali, shares: [{ name: 'Ali', personId: ali, isSelf: false, shareMinor: 10000 }] }));
  expect(await repo.listTransactions(db)).toHaveLength(0);
  expect(await listActivity(db, { type: 'SHARED' })).toHaveLength(payerIsSelf ? 1 : 0);
  expect(await listActivity(db, { activityId: `shared:${plan.splitGroup.id}` })).toHaveLength(1);
  expect(await balances()).toMatchObject({ cash: payerIsSelf ? -10000 : 0, spent: 0 });
  const records = await readSharedEvent(db, plan.splitGroup.id);
  expect(await sharedReadOnlyReason(db, records)).toBeNull();
  await updateSharedExpense(db, records.split.id, records.split.updated_at, input());
  const changed = await readSharedEvent(db, records.split.id);
  await deleteSharedExpense(db, changed.split.id, changed.split.updated_at);
  await assertNoOrphans();
  expect(await balances()).toMatchObject({ cash: 0, spent: 0 });
});

test.each(['DELETE FROM transactions', 'DELETE FROM person_entries', 'DELETE FROM split_participants', 'DELETE FROM split_groups', 'INSERT INTO split_groups', 'INSERT INTO split_participants', 'INSERT INTO transactions', 'INSERT INTO person_entries', 'UPDATE split_groups'])('shared update rollback at %s preserves original and removes new Person', async (sql) => {
  const plan = await saveSharedExpensePosting(db, input({ payerIsSelf: false, payerPersonId: ali }));
  const records = await readSharedEvent(db, plan.splitGroup.id);
  const before = snapshot();
  failOn = sql;
  await expect(updateSharedExpense(db, records.split.id, records.split.updated_at, input({ shares: [{ name: 'You', isSelf: true, shareMinor: 4000 }, { name: 'New person', isSelf: false, shareMinor: 6000 }] }))).rejects.toThrow('Injected');
  expect(snapshot()).toBe(before);
  expect(await balances()).toMatchObject({ cash: 0, spent: 4000, ali: -4000 });
  await assertNoOrphans();
});

test.each(['DELETE FROM transactions', 'DELETE FROM person_entries', 'DELETE FROM split_participants', 'DELETE FROM split_groups'])('shared delete rollback at %s keeps other-paid event cash neutral', async (sql) => {
  const plan = await saveSharedExpensePosting(db, input({ payerIsSelf: false, payerPersonId: ali }));
  const records = await readSharedEvent(db, plan.splitGroup.id);
  const before = snapshot();
  failOn = sql;
  await expect(deleteSharedExpense(db, records.split.id, records.split.updated_at)).rejects.toThrow('Injected');
  expect(snapshot()).toBe(before);
  expect(await balances()).toMatchObject({ cash: 0, spent: 4000, ali: -4000 });
});

test('new Person + creation rollback and duplicate participant rejection are atomic', async () => {
  failOn = 'INSERT INTO person_entries';
  await expect(saveSharedExpensePosting(db, input({ shares: [{ name: 'You', isSelf: true, shareMinor: 4000 }, { name: 'New person', isSelf: false, shareMinor: 6000 }] }))).rejects.toThrow();
  expect(await repo.listPeople(db)).toHaveLength(2);
  expect(await listActivity(db)).toEqual([]);
  failOn = null;
  await expect(saveSharedExpensePosting(db, input({ shares: [{ name: 'Ali', personId: ali, isSelf: false, shareMinor: 4000 }, { name: 'ali', isSelf: false, shareMinor: 6000 }] }))).rejects.toThrow('once');
  await expect(saveSharedExpensePosting(db, input({ shares: [{ name: 'Me', isSelf: true, shareMinor: 4000 }, { name: 'You', isSelf: true, shareMinor: 6000 }] }))).rejects.toThrow('once');
  await expect(saveSharedExpensePosting(db, input({ payerIsSelf: false, payerPersonId: 'missing' }))).rejects.toThrow('paid');
  expect(await listActivity(db)).toEqual([]);
});

test('stale shared edit/delete and repeated explicit creation ID cannot duplicate posting', async () => {
  const plan = await saveSharedExpensePosting(db, input({ splitGroupId: 'stable_split', financialEventId: 'stable_event' }));
  const records = await readSharedEvent(db, plan.splitGroup.id);
  await updateSharedExpense(db, records.split.id, records.split.updated_at, input());
  await expect(updateSharedExpense(db, records.split.id, records.split.updated_at, input())).rejects.toThrow('changed');
  await expect(deleteSharedExpense(db, records.split.id, records.split.updated_at)).rejects.toThrow('changed');
  await expect(saveSharedExpensePosting(db, input({ splitGroupId: 'stable_split' }))).rejects.toThrow();
  expect(await listActivity(db)).toHaveLength(1);
});

test.each(['null event', 'wrong split link', 'wrong entry event', 'missing debt', 'duplicate event', 'manual event sibling', 'legacy payer default'])('%s is read-only and neither ordinary nor shared delete can damage it', async (scenario) => {
  const plan = await saveSharedExpensePosting(db, input({ payerIsSelf: false, payerPersonId: ali }));
  const id = plan.splitGroup.id;
  if (scenario === 'null event') await db.runAsync('UPDATE split_groups SET financial_event_id = NULL WHERE id = ?;', id);
  if (scenario === 'wrong split link') await db.runAsync('UPDATE transactions SET group_id = ? WHERE id = ?;', 'another_split', plan.personalExpenseTransaction!.id);
  if (scenario === 'wrong entry event') await db.runAsync('UPDATE person_entries SET financial_event_id = ?;', 'wrong_event');
  if (scenario === 'missing debt') await db.runAsync('DELETE FROM person_entries;');
  if (scenario === 'duplicate event') {
    const other = await saveSharedExpensePosting(db, input());
    await db.runAsync('UPDATE split_groups SET financial_event_id = ? WHERE id = ?;', plan.splitGroup.financial_event_id, other.splitGroup.id);
  }
  if (scenario === 'manual event sibling') await repo.savePersonEntry(db, { person_id: ali, type: 'PAID_BACK', amount_minor: 1000, account_id: cash, title: 'repayment', occurred_on: day, financial_event_id: plan.splitGroup.financial_event_id });
  if (scenario === 'legacy payer default') await db.runAsync('UPDATE split_groups SET payer_is_self = 1, payer_person_id = NULL WHERE id = ?;', id);
  const records = await readSharedEvent(db, id);
  const before = snapshot();
  expect(await sharedReadOnlyReason(db, records)).toContain('read-only');
  await expect(deleteSharedExpense(db, id, records.split.updated_at)).rejects.toThrow('read-only');
  await expect(updateSharedExpense(db, id, records.split.updated_at, input())).rejects.toThrow('read-only');
  await expect(deleteTransaction(db, plan.personalExpenseTransaction!.id, '')).rejects.toThrow('read-only');
  expect(snapshot()).toBe(before);
});

test('explicit event-only transaction link resolves, while generic financial softDelete is blocked', async () => {
  const plan = await saveSharedExpensePosting(db, input());
  await db.runAsync('UPDATE transactions SET group_id = NULL;');
  const records = await readSharedEvent(db, plan.splitGroup.id);
  expect(await sharedReadOnlyReason(db, records)).toBeNull();
  expect(await listActivity(db)).toHaveLength(1);
  await expect(repo.softDelete(db, 'transactions', records.transactions[0].id)).rejects.toThrow('complete activity');
  await expect(repo.softDelete(db, 'person_entries', records.entries[0].id)).rejects.toThrow('complete activity');
  await deleteSharedExpense(db, records.split.id, records.split.updated_at);
  await assertNoOrphans();
});

test('same title/amount/group never captures unrelated activity; group id means persistent group only on split', async () => {
  const groupId = await repo.createGroup(db, { name: 'Trip', personIds: [ali] });
  const plan = await saveSharedExpensePosting(db, input({ groupId }));
  const tx = await normal();
  await repo.savePersonEntry(db, { person_id: ali, type: 'RECEIVED_BACK', amount_minor: 6000, account_id: cash, title: 'Dinner', occurred_on: day });
  expect(await listActivity(db)).toHaveLength(3);
  expect(await listActivity(db, { groupId })).toHaveLength(1);
  const records = await readSharedEvent(db, plan.splitGroup.id);
  expect(records.transactions[0].group_id).toBe(records.split.id);
  await deleteSharedExpense(db, records.split.id, records.split.updated_at);
  expect(await repo.listTransactions(db)).toMatchObject([{ id: tx.id }]);
  expect(await repo.listPersonEntries(db)).toHaveLength(1);
  expect(await repo.listGroups(db)).toHaveLength(1);
  await assertNoOrphans();
});

test.each(['clear', 'reset'])('edited demo shared and normal activity survive %s with safe references', async (action) => {
  await loadComprehensiveDemoData(db);
  const splits = await repo.listSplitGroups(db);
  const original = splits.find((s) => s.title === 'Murree Hotel')!;
  const records = await readSharedEvent(db, original.id);
  await updateSharedExpense(db, original.id, original.updated_at, { title: 'My corrected hotel', totalAmountMinor: original.total_amount_minor, categoryId: original.category_id, accountId: original.account_id, occurredOn: original.occurred_on, payerIsSelf: true, shares: records.participants.map((p) => ({ name: p.name, isSelf: !!p.is_self, personId: p.person_id, shareMinor: p.share_minor })) });
  const tx = (await repo.listTransactions(db)).find((t) => t.id.startsWith('demo_') && t.source === 'MANUAL')!;
  const adoptedId = await updateTransaction(db, tx.id, tx.updated_at, { ...tx, title: 'My corrected purchase' });
  expect(adoptedId.startsWith('demo_')).toBe(false);
  const adopted = (await repo.listTransactions(db)).find((t) => t.id === adoptedId)!;
  expect((await repo.listTransactions(db)).some((t) => t.id === tx.id)).toBe(false);
  await expect(updateTransaction(db, tx.id, tx.updated_at, tx)).rejects.toThrow('no longer exists');
  const before = await readSharedEvent(db, original.id);
  expect(before.participants.every((p) => !p.id.startsWith('demo_'))).toBe(true);
  if (action === 'clear') await clearDemoData(db); else await loadComprehensiveDemoData(db);
  expect(await readSharedEvent(db, original.id)).toEqual(before);
  expect((await repo.listTransactions(db)).find((t) => t.id === adoptedId)).toEqual(adopted);
  // Reset seeds the now-vacant ordinary demo ID again; the adopted correction is separate.
  expect((await repo.listTransactions(db)).some((t) => t.id === tx.id)).toBe(action === 'reset');
  const after = snapshot();
  if (action === 'clear') await clearDemoData(db); else await loadComprehensiveDemoData(db);
  expect(await readSharedEvent(db, original.id)).toEqual(before);
  expect((await repo.listTransactions(db)).filter((t) => t.id === adoptedId)).toEqual([adopted]);
  if (action === 'clear') expect(snapshot()).toBe(after);
  expect(await sharedReadOnlyReason(db, await readSharedEvent(db, original.id))).toBeNull();
  await assertNoOrphans();
});

test('SQL read model covers all types, participant/payer/group/account/category/note search and combined filters', async () => {
  await normal(); await normal('INCOME'); await normal('TRANSFER');
  await repo.savePersonEntry(db, { person_id: sam, type: 'PAID_BACK', amount_minor: 500, account_id: bank, title: 'Returned', occurred_on: day });
  const groupId = await repo.createGroup(db, { name: 'Holiday', personIds: [ali, sam] });
  await saveSharedExpensePosting(db, input({ groupId }));
  expect(await listActivity(db)).toHaveLength(5);
  for (const type of ['EXPENSE', 'INCOME', 'TRANSFER', 'PEOPLE', 'SHARED'] as const) expect(await listActivity(db, { type })).toHaveLength(1);
  expect(await listActivity(db, { query: 'holiday' })).toHaveLength(1);
  expect(await listActivity(db, { query: 'ALI' })).toHaveLength(1);
  expect(await listActivity(db, { query: 'A note' })).toHaveLength(3);
  expect(await listActivity(db, { query: 'My bank' })).toHaveLength(2);
  expect(await listActivity(db, { query: 'Food' })).toHaveLength(2);
  expect(await listActivity(db, { personId: sam })).toHaveLength(1);
  expect(await listActivity(db, { groupId, personId: ali, categoryId: food, accountId: cash, type: 'SHARED', query: 'dinner', range: 'CUSTOM', from: day, to: day })).toHaveLength(1);
  expect(await listActivity(db, { query: "%' OR 1=1 --" })).toEqual([]);
});

test('date presets have calendar boundaries including year rollover and leap days', () => {
  expect(activityDateBounds({ range: 'THIS_MONTH' }, '2026-01-12')).toEqual({ from: '2026-01-01', to: '2026-01-31' });
  expect(activityDateBounds({ range: 'LAST_MONTH' }, '2026-01-12')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  expect(activityDateBounds({ range: 'LAST_3_MONTHS' }, '2026-01-12')).toEqual({ from: '2025-11-01', to: '2026-01-31' });
  expect(activityDateBounds({ range: 'THIS_YEAR' }, day)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  expect(activityDateBounds({ range: 'LAST_MONTH' }, '2024-03-01')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
  expect(activityDateBounds({ range: 'ALL' }, day)).toEqual({});
});

test('SQL custom range is inclusive and rejects reversed/missing/invalid dates', async () => {
  const tx = await normal();
  expect(await listActivity(db, { range: 'CUSTOM', from: day, to: day })).toHaveLength(1);
  expect(await listActivity(db, { range: 'CUSTOM', from: '2026-09-13', to: '2026-09-30' })).toHaveLength(0);
  for (const bounds of [{ from: day, to: '2026-09-01' }, { from: '', to: day }, { from: '2026-02-30', to: day }]) await expect(listActivity(db, { range: 'CUSTOM', ...bounds })).rejects.toThrow('From');
  expect(await ordinaryReadOnlyReason(db, tx)).toBeNull();
});

test.each([
  ['THIS_MONTH', 2], ['LAST_MONTH', 1], ['LAST_3_MONTHS', 4], ['THIS_YEAR', 6], ['ALL', 7],
] as const)('SQL date preset %s selects %s rows', async (range, count) => {
  jest.useFakeTimers().setSystemTime(new Date(2026, 8, 12, 12));
  try {
    for (const occurred_on of ['2025-12-31', '2026-01-01', '2026-06-30', '2026-07-01', '2026-08-31', '2026-09-01', '2026-09-30']) {
      await repo.saveTransaction(db, { type: 'EXPENSE', amount_minor: 100, account_id: cash, category_id: food, title: occurred_on, occurred_on, source: 'MANUAL' });
    }
    expect(await listActivity(db, { range })).toHaveLength(count);
  } finally { jest.useRealTimers(); }
});

test('new shared saves cannot reuse another financial event key', async () => {
  await saveSharedExpensePosting(db, input({ financialEventId: 'unique_event' }));
  const before = snapshot();
  await expect(saveSharedExpensePosting(db, input({ financialEventId: 'unique_event' }))).rejects.toThrow('already');
  expect(snapshot()).toBe(before);
});

test('manual row sharing an explicit event with People cannot be deleted as ordinary', async () => {
  const tx = await normal();
  await db.runAsync('UPDATE transactions SET financial_event_id = ? WHERE id = ?;', 'shared_manual_key', tx.id);
  await repo.savePersonEntry(db, { person_id: ali, type: 'GIVEN', amount_minor: 1000, account_id: cash, title: 'Explicitly linked', occurred_on: day, financial_event_id: 'shared_manual_key' });
  const before = snapshot();
  await expect(deleteTransaction(db, tx.id, tx.updated_at)).rejects.toThrow('read-only');
  expect(snapshot()).toBe(before);
});

test.each(['EXPENSE', 'INCOME', 'TRANSFER'] as const)('%s rejects missing/archived/deleted accounts and invalid fields without changing accounting', async (type) => {
  const tx = await normal(type);
  await db.runAsync('UPDATE accounts SET is_archived = 1 WHERE id = ?;', bank);
  const before = snapshot();
  const accounting = await balances();
  const invalid = [
    { account_id: 'missing' }, { account_id: bank, destination_account_id: type === 'TRANSFER' ? cash : null }, { title: ' \t ' },
    { occurred_on: '2026-02-30' }, { occurred_on: '12-09-2026' },
    ...(type === 'TRANSFER' ? [{ destination_account_id: 'missing' }, { destination_account_id: bank }, { destination_account_id: null }, { destination_account_id: cash }] : [{ category_id: 'missing' }, { category_id: type === 'INCOME' ? food : salary }]),
  ];
  for (const change of invalid) {
    await expect(updateTransaction(db, tx.id, tx.updated_at, { ...tx, ...change })).rejects.toThrow();
    expect(snapshot()).toBe(before);
    expect(await balances()).toEqual(accounting);
  }
  await db.runAsync('UPDATE accounts SET is_archived = 0, deleted_at = ? WHERE id = ?;', day, bank);
  const deletedSnapshot = snapshot();
  await expect(updateTransaction(db, tx.id, tx.updated_at, { ...tx, account_id: bank, destination_account_id: type === 'TRANSFER' ? cash : null })).rejects.toThrow('active account');
  expect(snapshot()).toBe(deletedSnapshot);
});

test.each(['EXPENSE', 'INCOME'] as const)('%s rejects archived/deleted matching categories', async (type) => {
  const tx = await normal(type);
  for (const state of ['is_archived = 1', "is_archived = 0, deleted_at = '2026-09-12'"]) {
    await db.runAsync(`UPDATE categories SET ${state} WHERE id = ?;`, tx.category_id!);
    const before = snapshot();
    const accounting = await balances();
    await expect(updateTransaction(db, tx.id, tx.updated_at, tx)).rejects.toThrow('category');
    expect(snapshot()).toBe(before);
    expect(await balances()).toEqual(accounting);
  }
});

test.each([
  ['missing account', { accountId: 'missing' }], ['wrong category type', { categoryId: salary }],
  ['missing category', { categoryId: 'missing' }], ['empty title', { title: ' \t ' }],
  ['invalid date', { occurredOn: '2026-02-30' }], ['zero total', { totalAmountMinor: 0 }],
  ['negative total', { totalAmountMinor: -1 }], ['fractional total', { totalAmountMinor: 10000.5 }],
  ['unsafe total', { totalAmountMinor: Number.MAX_SAFE_INTEGER + 1 }], ['NaN total', { totalAmountMinor: NaN }],
  ['unequal share total', { totalAmountMinor: 9999 }], ['no participants', { shares: [] }],
  ['negative share', { shares: [{ name: 'You', isSelf: true, shareMinor: -1 }, { name: 'Ali', isSelf: false, shareMinor: 10001 }] }],
  ['fractional share', { shares: [{ name: 'You', isSelf: true, shareMinor: 0.5 }, { name: 'Ali', isSelf: false, shareMinor: 9999.5 }] }],
  ['missing participant', { shares: [{ name: 'Missing', personId: 'missing', isSelf: false, shareMinor: 10000 }] }],
  ['missing payer', { payerIsSelf: false, payerPersonId: 'missing' }],
] satisfies [string, Partial<SharedExpensePostingInput>][])('shared update rejects %s with exact rollback', async (_name, change) => {
  const plan = await saveSharedExpensePosting(db, input());
  const records = await readSharedEvent(db, plan.splitGroup.id);
  const before = snapshot();
  const accounting = await balances();
  await expect(updateSharedExpense(db, records.split.id, records.split.updated_at, input(change))).rejects.toThrow();
  expect(snapshot()).toBe(before);
  expect(await balances()).toEqual(accounting);
  await assertNoOrphans();
});

test.each(['archived account', 'deleted account', 'archived category', 'deleted category', 'deleted participant', 'missing group', 'deleted group'])('shared update rejects %s while preserving existing records', async (scenario) => {
  const groupId = await repo.createGroup(db, { name: 'Trip', personIds: [ali] });
  const plan = await saveSharedExpensePosting(db, input({ groupId }));
  const records = await readSharedEvent(db, plan.splitGroup.id);
  const table = scenario.includes('account') ? 'accounts' : scenario.includes('category') ? 'categories' : scenario.includes('participant') ? 'people' : 'groups';
  const id = table === 'accounts' ? cash : table === 'categories' ? food : table === 'people' ? ali : groupId;
  if (scenario === 'missing group') await db.runAsync('DELETE FROM groups WHERE id = ?;', id);
  else await db.runAsync(`UPDATE ${table} SET ${scenario.startsWith('archived') ? 'is_archived = 1' : "deleted_at = '2026-09-12'"} WHERE id = ?;`, id);
  const before = snapshot();
  const accounting = await balances();
  // The saved group is authoritative, not a replacement supplied by a stale form.
  await expect(updateSharedExpense(db, records.split.id, records.split.updated_at, input({ groupId: 'ignored' }))).rejects.toThrow();
  expect(snapshot()).toBe(before);
  expect(await balances()).toEqual(accounting);
});

test('shared update retains a persisted participant archived after posting', async () => {
  const groupId = await repo.createGroup(db, { name: 'Trip', personIds: [ali] });
  const plan = await saveSharedExpensePosting(db, input({ groupId }));
  const records = await readSharedEvent(db, plan.splitGroup.id);
  await db.runAsync('UPDATE people SET is_archived = 1 WHERE id = ?;', ali);
  const accounting = await balances();
  await updateSharedExpense(db, records.split.id, records.split.updated_at, input({ groupId: 'ignored', title: 'Corrected dinner' }));
  const changed = await readSharedEvent(db, records.split.id);
  expect(changed.split.title).toBe('Corrected dinner');
  expect(changed.participants.some((participant) => participant.person_id === ali)).toBe(true);
  expect(await balances()).toEqual(accounting);
});

test.each(['missing participant', 'missing payer', 'resolved duplicate', 'late posting failure'])('multi-participant resolution rolls back new People on %s', async (scenario) => {
  const plan = await saveSharedExpensePosting(db, input({ payerIsSelf: false, payerPersonId: ali }));
  const records = await readSharedEvent(db, plan.splitGroup.id);
  const shares = [
    { name: 'New one', isSelf: false, shareMinor: 2000 },
    { name: 'New two', isSelf: false, shareMinor: 2000 },
    { name: 'Ali', personId: ali, isSelf: false, shareMinor: 3000 },
    { name: 'You', isSelf: true, shareMinor: 3000 },
  ];
  if (scenario === 'missing participant') shares[2].personId = 'missing';
  if (scenario === 'resolved duplicate') shares[3] = { name: 'ali', isSelf: false, shareMinor: 3000 };
  if (scenario === 'late posting failure') failOn = 'INSERT INTO person_entries';
  const before = snapshot();
  const accounting = await balances();
  await expect(updateSharedExpense(db, records.split.id, records.split.updated_at, input({ shares, ...(scenario === 'missing payer' ? { payerIsSelf: false, payerPersonId: 'missing' } : {}) }))).rejects.toThrow();
  expect(snapshot()).toBe(before);
  expect(await balances()).toEqual(accounting);
  await assertNoOrphans();
});

test('activity source is persisted transaction provenance or the shared/People domain, never guessed from a title', async () => {
  const tx = await normal();
  const subscriptionId = await repo.saveTransaction(db, { ...tx, title: 'Ordinary', source: 'SUBSCRIPTION' });
  const shared = await saveSharedExpensePosting(db, input());
  const personId = await repo.savePersonEntry(db, { person_id: ali, type: 'GIVEN', amount_minor: 100, account_id: cash, title: 'Ordinary', occurred_on: day });
  const rows = await listActivity(db);
  expect(rows.find((r) => r.source_id === tx.id)?.source).toBe('MANUAL');
  expect(rows.find((r) => r.source_id === subscriptionId)?.source).toBe('SUBSCRIPTION');
  expect(rows.find((r) => r.source_id === shared.splitGroup.id)?.source).toBe('SPLIT');
  expect(rows.find((r) => r.source_id === personId)?.source).toBe('PEOPLE');
  const subscription = (await repo.listTransactions(db)).find((t) => t.id === subscriptionId)!;
  const before = snapshot();
  const accounting = await balances();
  expect(await ordinaryReadOnlyReason(db, subscription)).toBe(subscriptionReadOnlyMessage);
  await expect(updateTransaction(db, subscription.id, subscription.updated_at, subscription)).rejects.toThrow(subscriptionReadOnlyMessage);
  await expect(deleteTransaction(db, subscription.id, subscription.updated_at)).rejects.toThrow(subscriptionReadOnlyMessage);
  expect(snapshot()).toBe(before);
  expect(await balances()).toEqual(accounting);
});

test('planned occurrence has durable provenance and cannot rewrite schedule history through ordinary editing', async () => {
  const id = await repo.savePlannedPayment(db, { name: 'Dinner', type: 'EXPENSE', amount_minor: 1000, category_id: food, account_id: cash, next_due_date: day, recurrence_type: 'MONTHLY', recurrence_interval: 1, reminder_enabled: 0, reminder_days_before: 0 });
  const planned = (await repo.listPlannedPayments(db)).find((p) => p.id === id)!;
  await repo.markPlannedPaymentPaid(db, planned.id, planned.next_due_date);
  const schedule = await repo.listPlannedPayments(db);
  const tx = (await repo.listTransactions(db))[0];
  expect((await listActivity(db))[0]).toMatchObject({ source: 'PLANNED', source_id: tx.id });
  expect(await ordinaryReadOnlyReason(db, tx)).toBe(plannedReadOnlyMessage);
  await expect(updateTransaction(db, tx.id, tx.updated_at, { ...tx, amount_minor: 2000 })).rejects.toThrow(plannedReadOnlyMessage);
  await expect(deleteTransaction(db, tx.id, tx.updated_at)).rejects.toThrow(plannedReadOnlyMessage);
  expect(await repo.listPlannedPayments(db)).toEqual(schedule);
  expect(await balances()).toEqual({ cash: -1000, bank: 0, spent: 1000, ali: 0, sam: 0 });
});

test.each(['AI', 'IMPORT', 'SPLIT'] as const)('%s transaction remains conservatively read-only', async (source) => {
  const tx = await normal();
  await db.runAsync('UPDATE transactions SET source = ? WHERE id = ?;', source, tx.id);
  const stored = (await repo.listTransactions(db))[0];
  expect(await ordinaryReadOnlyReason(db, stored)).toBe(legacyReadOnlyMessage);
  const before = snapshot();
  await expect(updateTransaction(db, tx.id, tx.updated_at, tx)).rejects.toThrow('read-only');
  await expect(deleteTransaction(db, tx.id, tx.updated_at)).rejects.toThrow('read-only');
  expect(snapshot()).toBe(before);
});

test.each(['transactions', 'person_entries', 'split_groups'])('duplicate event key held by %s rejects creation and rolls back resolved People', async (table) => {
  const tx = await normal();
  if (table === 'transactions') await db.runAsync('UPDATE transactions SET financial_event_id = ? WHERE id = ?;', 'held_event', tx.id);
  if (table === 'person_entries') await repo.savePersonEntry(db, { person_id: ali, type: 'GIVEN', amount_minor: 100, account_id: cash, title: 'Held', occurred_on: day, financial_event_id: 'held_event' });
  if (table === 'split_groups') await saveSharedExpensePosting(db, input({ financialEventId: 'held_event' }));
  const before = snapshot();
  const accounting = await balances();
  await expect(saveSharedExpensePosting(db, input({ financialEventId: 'held_event', shares: [{ name: 'New person', isSelf: false, shareMinor: 10000 }] }))).rejects.toThrow('already');
  expect(snapshot()).toBe(before);
  expect(await balances()).toEqual(accounting);
});

test('repeated shared edits keep stable event identity, fresh unique child IDs and no orphan records', async () => {
  const plan = await saveSharedExpensePosting(db, input());
  const seen = new Set<string>();
  for (let i = 0; i < 4; i++) {
    const records = await readSharedEvent(db, plan.splitGroup.id);
    for (const row of [...records.participants, ...records.transactions, ...records.entries]) {
      expect(seen.has(row.id)).toBe(false);
      seen.add(row.id);
    }
    expect(records.split.financial_event_id).toBe(plan.splitGroup.financial_event_id);
    expect(await sharedReadOnlyReason(db, records)).toBeNull();
    expect(await balances()).toEqual({ cash: -10000, bank: 0, spent: 4000, ali: 6000, sam: 0 });
    await assertNoOrphans();
    if (i < 3) await updateSharedExpense(db, records.split.id, records.split.updated_at, input());
    else await deleteSharedExpense(db, records.split.id, records.split.updated_at);
  }
  expect(await listActivity(db)).toEqual([]);
  await assertNoOrphans();
});

test.each(['participant', 'person entry'])('duplicate explicit %s IDs reject the entire new event without overwriting history', async (kind) => {
  await normal();
  const shares = [
    { name: 'You', isSelf: true, shareMinor: 2000 },
    { name: 'Ali', personId: ali, isSelf: false, shareMinor: 4000 },
    { name: 'Sam', personId: sam, isSelf: false, shareMinor: 4000 },
  ];
  const before = snapshot();
  const accounting = await balances();
  await expect(saveSharedExpensePosting(db, input({
    shares: kind === 'participant' ? shares.map((s) => ({ ...s, participantId: 'duplicate' })) : shares,
    personEntryIds: kind === 'person entry' ? { [ali]: 'duplicate', [sam]: 'duplicate' } : undefined,
  }))).rejects.toThrow('UNIQUE');
  expect(snapshot()).toBe(before);
  expect(await balances()).toEqual(accounting);
  await assertNoOrphans();
});

test.each(['transaction', 'person', 'shared'])('soft-deleted %s event sibling still prevents ordinary mutation', async (kind) => {
  const tx = await normal();
  const event = 'legacy_event';
  await db.runAsync('UPDATE transactions SET financial_event_id = ? WHERE id = ?;', event, tx.id);
  if (kind === 'transaction') {
    const sibling = await normal();
    await db.runAsync('UPDATE transactions SET financial_event_id = ?, deleted_at = ? WHERE id = ?;', event, day, sibling.id);
  } else if (kind === 'person') {
    const id = await repo.savePersonEntry(db, { person_id: ali, type: 'GIVEN', amount_minor: 100, account_id: cash, title: 'Legacy', occurred_on: day, financial_event_id: event });
    await db.runAsync('UPDATE person_entries SET deleted_at = ? WHERE id = ?;', day, id);
  } else {
    const plan = await saveSharedExpensePosting(db, input());
    await db.runAsync('UPDATE split_groups SET financial_event_id = ?, deleted_at = ? WHERE id = ?;', event, day, plan.splitGroup.id);
  }
  const before = snapshot();
  const accounting = await balances();
  await expect(updateTransaction(db, tx.id, tx.updated_at, tx)).rejects.toThrow(legacyReadOnlyMessage);
  await expect(deleteTransaction(db, tx.id, tx.updated_at)).rejects.toThrow(legacyReadOnlyMessage);
  expect(snapshot()).toBe(before);
  expect(await balances()).toEqual(accounting);
});

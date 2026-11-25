/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import * as SQLite from 'expo-sqlite';
import { openAppDatabase, type AppDb } from '../database/database';
import * as repo from '../database/repositories/repositories';
import { accountActivityEffect, accountTotalsByCurrency, adjustAccountBalance, archiveAccount, listArchivedAccounts, readAccountSnapshot, renameAccount, restoreAccount } from '../services/accounts/AccountService';
import { listActivity, ordinaryReadOnlyReason } from '../services/activity/ActivityService';
import { getMonthlyExpenseTotal } from '../services/budget/BudgetService';
import { calculateAccountBalance } from '../services/finance/FinanceService';
import { recordPeopleAction } from '../services/people/PersonService';
import type { Account, Transaction } from '../types/models';
import { monthKey, todayLocal } from '../utils/date';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

let sqlite: DatabaseSync;
let db: AppDb;
let failOn: string | null;
let cash: Account;

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  failOn = null;
  const adapter = {
    execAsync: async (sql: string) => { sqlite.exec(sql); },
    runAsync: async (sql: string, ...params: (string | number | null)[]) => {
      if (failOn && sql.includes(failOn)) throw new Error('Injected write failure');
      return sqlite.prepare(sql).run(...params);
    },
    getAllAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).all(...params),
    getFirstAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).get(...params) ?? null,
    withTransactionAsync: async (work: () => Promise<void>) => {
      sqlite.exec('BEGIN');
      try { await work(); sqlite.exec('COMMIT'); }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    withExclusiveTransactionAsync: async (work: (txn: AppDb) => Promise<void>) => adapter.withTransactionAsync(() => work(db)),
  };
  db = adapter as unknown as AppDb;
  jest.mocked(SQLite.openDatabaseAsync).mockResolvedValue(db);
  await openAppDatabase();
  cash = (await repo.listAccounts(db))[0];
});

afterEach(() => sqlite.close());

test('active totals derive from FinanceService, separate currencies and keep owned transfers neutral', async () => {
  const bank = await createBank('Bank', 10000);
  await repo.createAccount(db, { name: 'Dollar wallet', type: 'EWALLET', currency: 'USD', opening_balance_minor: 500 });
  const totals = async () => accountTotalsByCurrency(await repo.listAccounts(db), await repo.listTransactions(db), await repo.listPersonEntries(db));
  expect(await totals()).toEqual(expect.arrayContaining([{ currency: 'PKR', amountMinor: 10000 }, { currency: 'USD', amountMinor: 500 }]));
  await repo.saveTransaction(db, { type: 'TRANSFER', amount_minor: 2000, account_id: bank.id, destination_account_id: cash.id, title: 'Move Money', occurred_on: todayLocal(), source: 'MANUAL' });
  expect(await totals()).toEqual(expect.arrayContaining([{ currency: 'PKR', amountMinor: 10000 }, { currency: 'USD', amountMinor: 500 }]));
  await repo.saveTransaction(db, { type: 'EXPENSE', amount_minor: 1000, account_id: bank.id, category_id: 'cat_expense_food', title: 'Dinner', occurred_on: todayLocal(), source: 'MANUAL' });
  expect(await totals()).toContainEqual({ currency: 'PKR', amountMinor: 9000 });
  await repo.saveTransaction(db, { type: 'INCOME', amount_minor: 1000, account_id: bank.id, category_id: 'cat_income_salary', title: 'Income', occurred_on: todayLocal(), source: 'MANUAL' });
  expect(await totals()).toContainEqual({ currency: 'PKR', amountMinor: 10000 });
  const personId = await repo.savePerson(db, 'Totals person');
  await recordPeopleAction(db, { personId, accountId: bank.id, action: 'GIVE', amountMinor: 500, expectedBalanceMinor: 0 });
  expect(await totals()).toContainEqual({ currency: 'PKR', amountMinor: 9500 });
  await recordPeopleAction(db, { personId, accountId: bank.id, action: 'BORROW', amountMinor: 200, expectedBalanceMinor: 500 });
  expect(await totals()).toContainEqual({ currency: 'PKR', amountMinor: 9700 });
  await recordPeopleAction(db, { personId, accountId: bank.id, action: 'BORROW', amountMinor: 300, expectedBalanceMinor: 300 });
  expect(await totals()).toContainEqual({ currency: 'PKR', amountMinor: 10000 });
  await repo.saveSplit(db, { title: 'Full bill cash', total_amount_minor: 1000, category_id: 'cat_expense_food', account_id: bank.id, occurred_on: todayLocal(), shares: [{ name: 'You', isSelf: true, shareMinor: 500 }, { name: 'Totals person', personId, isSelf: false, shareMinor: 500 }] });
  expect(await totals()).toContainEqual({ currency: 'PKR', amountMinor: 9000 });
  await adjustAccountBalance(db, bank.id, 9000, 'Counted cash');
  expect(await totals()).toContainEqual({ currency: 'PKR', amountMinor: 11000 });
});

async function createBank(name = 'Meezan Bank', opening = 0) {
  await repo.createAccount(db, { name, type: 'BANK', opening_balance_minor: opening });
  return (await repo.listAccounts(db)).find((account) => account.name === name)!;
}

async function accountBalance(account: Account) {
  return calculateAccountBalance(account, await repo.listTransactions(db), await repo.listPersonEntries(db));
}

test('restore same archived account preserves zero balance, metadata/history and active selector identity with no financial write', async () => {
  const bank = await createBank('Restore bank', 1000);
  await repo.saveTransaction(db, { type: 'EXPENSE', amount_minor: 1000, account_id: bank.id, category_id: 'cat_expense_food', title: 'Old expense', occurred_on: todayLocal(), source: 'MANUAL' });
  await archiveAccount(db, bank.id, bank.updated_at);
  const archived = (await listArchivedAccounts(db))[0];
  const transactions = await repo.listTransactions(db);
  const activity = await listActivity(db);
  const entries = await repo.listPersonEntries(db);
  await restoreAccount(db, bank.id, archived.updated_at);
  const restored = (await repo.listAccounts(db)).find((row) => row.id === bank.id)!;
  expect(restored).toMatchObject({ ...bank, is_archived: 0, updated_at: expect.any(String) });
  expect(await accountBalance(restored)).toBe(0);
  expect(await listArchivedAccounts(db)).toEqual([]);
  expect(await repo.listTransactions(db)).toEqual(transactions);
  expect(await repo.listPersonEntries(db)).toEqual(entries);
  expect(await listActivity(db)).toEqual(activity);
  await expect(restoreAccount(db, bank.id, archived.updated_at)).rejects.toThrow('changed');
});

test('restore preserves imported archived nonzero balance and fails atomically for duplicate name/write failure', async () => {
  const bank = await createBank('Restore bank', 1234);
  await repo.saveTransaction(db, { type: 'EXPENSE', amount_minor: 34, account_id: bank.id, category_id: 'cat_expense_food', title: 'Archived history balance', occurred_on: todayLocal(), source: 'MANUAL' });
  await db.runAsync('UPDATE accounts SET is_archived = 1 WHERE id = ?;', bank.id);
  const before = await db.getAllAsync('SELECT * FROM accounts ORDER BY id;');
  await createBank(' restore BANK ');
  await expect(restoreAccount(db, bank.id, bank.updated_at)).rejects.toThrow('ACCOUNT_NAME_EXISTS');
  expect((await listArchivedAccounts(db))[0]).toEqual({ ...bank, is_archived: 1 });
  const duplicate = (await repo.listAccounts(db)).find((row) => row.name.trim() === 'restore BANK')!;
  await renameAccount(db, duplicate.id, duplicate.updated_at, 'Different bank');
  failOn = 'UPDATE accounts';
  await expect(restoreAccount(db, bank.id, bank.updated_at)).rejects.toThrow('Injected');
  expect((await listArchivedAccounts(db))[0].opening_balance_minor).toBe(1234);
  expect((await db.getAllAsync<Account>('SELECT * FROM accounts ORDER BY id;')).find((row) => row.id === bank.id)).toEqual(before.find((row: any) => row.id === bank.id));
  failOn = null;
  await restoreAccount(db, bank.id, bank.updated_at);
  expect((await readAccountSnapshot(db, bank.id)).currentBalanceMinor).toBe(1200);
});

test('archived account names remain available to Goal and paused Planned detail without reentering selectors', async () => {
  const bank = await createBank();
  const goalId = await repo.saveGoal(db, { name: 'Laptop', target_amount_minor: 100000, initial_saved_minor: 0, linked_account_id: bank.id });
  const planId = await repo.savePlannedPayment(db, {
    name: 'Internet', type: 'EXPENSE', amount_minor: 1000, category_id: 'cat_expense_bills',
    account_id: bank.id, next_due_date: todayLocal(), recurrence_type: 'MONTHLY',
    recurrence_interval: 1, reminder_enabled: 0, reminder_days_before: 0,
  });
  const plan = (await repo.getPlannedPayment(db, planId))!;
  await repo.pausePlannedPayment(db, planId, plan.updated_at);
  await archiveAccount(db, bank.id, bank.updated_at);
  expect((await repo.listAccounts(db)).map((item) => item.id)).not.toContain(bank.id);
  expect((await repo.listGoals(db, true)).find((item) => item.id === goalId)).toMatchObject({ linked_account_id: bank.id, linked_account_name: 'Meezan Bank' });
  expect((await repo.listPlannedPayments(db)).find((item) => item.id === planId)).toMatchObject({ account_id: bank.id, account_name: 'Meezan Bank', status: 'PAUSED' });
  expect(await repo.listTransactions(db)).toEqual([]);
  expect(await accountBalance(bank)).toBe(0);
});

test('account rename preserves identity, type, opening balance and historical Activity links', async () => {
  const bank = await createBank('Meezan Bank', 10000);
  await repo.saveTransaction(db, { type: 'EXPENSE', amount_minor: 500, account_id: bank.id, category_id: 'cat_expense_food', title: 'Lunch', occurred_on: todayLocal(), source: 'MANUAL' });
  await renameAccount(db, bank.id, bank.updated_at, '  HBL  ');
  const snapshot = await readAccountSnapshot(db, bank.id);
  expect(snapshot.account).toMatchObject({ id: bank.id, name: 'HBL', type: 'BANK', opening_balance_minor: 10000 });
  expect(snapshot.activity).toMatchObject([{ title: 'Lunch', account_name: 'HBL' }]);
});

test('duplicate active account names are rejected case-insensitively on rename', async () => {
  const bank = await createBank('Meezan Bank');
  await createBank('HBL');
  await expect(renameAccount(db, bank.id, bank.updated_at, ' hBl ')).rejects.toThrow('ACCOUNT_NAME_EXISTS');
  expect((await readAccountSnapshot(db, bank.id)).account.name).toBe('Meezan Bank');
});

test('stale account rename is rejected', async () => {
  const bank = await createBank();
  await renameAccount(db, bank.id, bank.updated_at, 'HBL');
  await expect(renameAccount(db, bank.id, bank.updated_at, 'Bank')).rejects.toThrow('changed');
});

test('positive balance adjustment reaches the entered actual balance', async () => {
  const result = await adjustAccountBalance(db, cash.id, 150000, 'Cash count correction');
  expect(result).toEqual({ previousBalanceMinor: 0, adjustmentMinor: 150000, actualBalanceMinor: 150000 });
  expect(await accountBalance(cash)).toBe(150000);
});

test('negative balance adjustment reaches a negative actual balance', async () => {
  const result = await adjustAccountBalance(db, cash.id, -2500, 'Bank reconciliation');
  expect(result.adjustmentMinor).toBe(-2500);
  expect(await accountBalance(cash)).toBe(-2500);
});

test('adjustment is an explicit understandable Activity event with its reason', async () => {
  await adjustAccountBalance(db, cash.id, 12500, 'Cash count correction');
  const rows = await listActivity(db, { type: 'ADJUSTMENT', accountId: cash.id });
  expect(rows).toMatchObject([{ type: 'ADJUSTMENT', label: 'Balance adjustment', title: 'Balance adjustment', note: 'Cash count correction', amount_minor: 12500, account_name: 'Cash' }]);
  const tx = (await repo.listTransactions(db))[0];
  await expect(ordinaryReadOnlyReason(db, tx)).resolves.toContain('read-only history');
});

test('adjustment is not Income or Expense and has no Spending Plan effect', async () => {
  await adjustAccountBalance(db, cash.id, 50000);
  const transactions = await repo.listTransactions(db);
  expect(transactions.filter((tx) => tx.type === 'INCOME')).toEqual([]);
  expect(transactions.filter((tx) => tx.type === 'EXPENSE')).toEqual([]);
  expect(getMonthlyExpenseTotal(transactions, monthKey(todayLocal()))).toBe(0);
  expect(await listActivity(db, { type: 'INCOME' })).toEqual([]);
  expect(await listActivity(db, { type: 'EXPENSE' })).toEqual([]);
});

test('adjustment has no People effect', async () => {
  await adjustAccountBalance(db, cash.id, 50000);
  expect(await repo.listPersonEntries(db)).toEqual([]);
});

test('generic transaction writes cannot manufacture adjustments', async () => {
  await expect(repo.saveTransaction(db, { type: 'ADJUSTMENT', amount_minor: 100, account_id: cash.id, title: 'Wrong path', occurred_on: todayLocal(), source: 'MANUAL' })).rejects.toThrow('Adjust Balance');
  expect(await repo.listTransactions(db)).toEqual([]);
});

test('failed adjustment insert rolls back without changing calculated balance', async () => {
  failOn = 'INSERT INTO transactions';
  await expect(adjustAccountBalance(db, cash.id, 10000)).rejects.toThrow('Injected');
  expect(await accountBalance(cash)).toBe(0);
  expect(await repo.listTransactions(db)).toEqual([]);
});

test('zero-value adjustment is rejected without creating history', async () => {
  await expect(adjustAccountBalance(db, cash.id, 0)).rejects.toThrow('already matches');
  expect(await repo.listTransactions(db)).toEqual([]);
});

test('nonzero account archive is prevented with the fresh balance', async () => {
  const bank = await createBank('HBL', 1250000);
  await expect(archiveAccount(db, bank.id, bank.updated_at)).rejects.toMatchObject({ balanceMinor: 1250000 });
  expect((await readAccountSnapshot(db, bank.id)).account.is_archived).toBe(0);
});

test('default Cash cannot be archived when it is the only active account', async () => {
  await expect(archiveAccount(db, cash.id, cash.updated_at)).rejects.toThrow('Default Cash');
  expect(await repo.listAccounts(db)).toHaveLength(1);
});

test('archive hides a zero account from active selectors but preserves its row and historical detail', async () => {
  const bank = await createBank('HBL', 1000);
  await repo.saveTransaction(db, { type: 'EXPENSE', amount_minor: 1000, account_id: bank.id, category_id: 'cat_expense_food', title: 'Historical lunch', occurred_on: todayLocal(), source: 'MANUAL' });
  await archiveAccount(db, bank.id, bank.updated_at);
  expect((await repo.listAccounts(db)).map((account) => account.id)).not.toContain(bank.id);
  const stored = await db.getFirstAsync<Account>('SELECT * FROM accounts WHERE id = ?;', bank.id);
  expect(stored).toMatchObject({ id: bank.id, name: 'HBL', is_archived: 1, deleted_at: null });
  const snapshot = await readAccountSnapshot(db, bank.id);
  expect(snapshot.currentBalanceMinor).toBe(0);
  expect(snapshot.activity).toMatchObject([{ title: 'Historical lunch', account_name: 'HBL' }]);
});

test('archived account names can be reused because only active duplicates are prohibited', async () => {
  const bank = await createBank('HBL');
  await archiveAccount(db, bank.id, bank.updated_at);
  await createBank('hbl');
  expect((await repo.listAccounts(db)).filter((account) => account.name.toLowerCase() === 'hbl')).toHaveLength(1);
});

test('new transaction and People writes reject an archived account from a stale form', async () => {
  const bank = await createBank('HBL');
  await archiveAccount(db, bank.id, bank.updated_at);
  const tx = { type: 'EXPENSE' as const, amount_minor: 100, account_id: bank.id, category_id: 'cat_expense_food', title: 'Stale', occurred_on: todayLocal(), source: 'MANUAL' as const };
  await expect(repo.saveTransaction(db, tx)).rejects.toThrow('active account');
  const personId = await repo.savePerson(db, 'Ali');
  await expect(repo.savePersonEntry(db, { person_id: personId, type: 'GIVEN', amount_minor: 100, account_id: bank.id, title: 'Stale', occurred_on: todayLocal() })).rejects.toThrow('active account');
});

test('active schedules prevent archive so future payments are not stranded', async () => {
  const bank = await createBank('HBL');
  await repo.savePlannedPayment(db, { name: 'Rent', type: 'EXPENSE', amount_minor: 1000, category_id: 'cat_expense_rent', account_id: bank.id, next_due_date: todayLocal(), recurrence_type: 'MONTHLY', recurrence_interval: 1, reminder_enabled: 0, reminder_days_before: 0 });
  await expect(archiveAccount(db, bank.id, bank.updated_at)).rejects.toThrow('planned payment or subscription');
});

test('Move Money remains neutral after adjustment support', async () => {
  const bank = await createBank('HBL');
  await adjustAccountBalance(db, cash.id, 10000);
  await repo.saveTransaction(db, { type: 'TRANSFER', amount_minor: 4000, account_id: cash.id, destination_account_id: bank.id, title: 'Move Money', occurred_on: todayLocal(), source: 'MANUAL' });
  const transactions = await repo.listTransactions(db);
  expect(await accountBalance(cash)).toBe(6000);
  expect(await accountBalance(bank)).toBe(4000);
  expect(getMonthlyExpenseTotal(transactions, monthKey(todayLocal()))).toBe(0);
});

test('account Activity limit is database validated and applied', async () => {
  await adjustAccountBalance(db, cash.id, 100);
  await adjustAccountBalance(db, cash.id, 200);
  expect(await listActivity(db, { accountId: cash.id, limit: 1 })).toHaveLength(1);
  await expect(listActivity(db, { accountId: cash.id, limit: 0 })).rejects.toThrow('limit');
});

test('account Activity effects distinguish every supported cash movement', () => {
  const row = { amount_minor: 1000, destination_account_id: null, label: '' } as any;
  expect(accountActivityEffect({ ...row, type: 'EXPENSE' }, 'cash')).toBe(-1000);
  expect(accountActivityEffect({ ...row, type: 'INCOME' }, 'cash')).toBe(1000);
  expect(accountActivityEffect({ ...row, type: 'TRANSFER', destination_account_id: 'cash' }, 'cash')).toBe(1000);
  expect(accountActivityEffect({ ...row, type: 'TRANSFER', account_id: 'cash', destination_account_id: 'bank' }, 'cash')).toBe(-1000);
  expect(accountActivityEffect({ ...row, type: 'SHARED' }, 'cash')).toBe(-1000);
  expect(accountActivityEffect({ ...row, type: 'PEOPLE', label: 'You gave' }, 'cash')).toBe(-1000);
  expect(accountActivityEffect({ ...row, type: 'PEOPLE', label: 'Paid back' }, 'cash')).toBe(-1000);
  expect(accountActivityEffect({ ...row, type: 'PEOPLE', label: 'You borrowed' }, 'cash')).toBe(1000);
  expect(accountActivityEffect({ ...row, type: 'PEOPLE', label: 'Received back' }, 'cash')).toBe(1000);
  expect(accountActivityEffect({ ...row, type: 'ADJUSTMENT', amount_minor: -1000 }, 'cash')).toBe(-1000);
});

test('archiving is a metadata update, never a hard delete', async () => {
  const bank = await createBank('HBL');
  await archiveAccount(db, bank.id, bank.updated_at);
  expect(await db.getFirstAsync('SELECT id FROM accounts WHERE id = ?;', bank.id)).toBeTruthy();
  expect(await db.getFirstAsync('SELECT id FROM accounts WHERE id = ? AND deleted_at IS NULL;', bank.id)).toBeTruthy();
});

test('adjustment rows remain signed safe integers', async () => {
  await expect(adjustAccountBalance(db, cash.id, Number.MAX_SAFE_INTEGER)).resolves.toMatchObject({ adjustmentMinor: Number.MAX_SAFE_INTEGER });
  const transaction = (await repo.listTransactions(db))[0] as Transaction;
  expect(Number.isSafeInteger(transaction.amount_minor)).toBe(true);
  await expect(adjustAccountBalance(db, cash.id, Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow('valid actual balance');
});

/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as SQLite from 'expo-sqlite';
import { openAppDatabase, type AppDb } from '../database/database';
import * as repo from '../database/repositories/repositories';
import { renameAccount } from '../services/accounts/AccountService';
import { calculateAccountBalance, calculateTotalAccountCashChange } from '../services/finance/FinanceService';
import { getMonthlyExpenseTotal } from '../services/budget/BudgetService';
import { createCategoryBudget } from '../services/budget/SpendingPlanService';
import { archivePerson, readPersonSnapshot, recordPeopleAction } from '../services/people/PersonService';
import { personBalancesByCurrency, scopeToCurrency, currenciesInUse } from '../services/currency/CurrencyScope';
import { readGroupSnapshot, reconcileAllocation, saveGroupDetails } from '../services/groups/GroupService';
import { saveSharedExpensePosting } from '../services/sharedExpense/SharedExpenseService';
import { BackupService } from '../services/backup/BackupService';
import type { Backup } from '../services/backup/BackupFormat';
import { updateTransaction } from '../services/finance/TransactionService';
import { listActivity } from '../services/activity/ActivityService';
import { exchangeRateText } from '../utils/money';
import { monthKey, todayLocal } from '../utils/date';
import { removeMigration14ForFixture, stripCurrenciesForFixture } from './schemaFixtures';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

// Each account keeps one currency, every record takes its account's currency and
// nothing is ever converted. Real SQL (migrations and triggers) on Node SQLite.
let directory: string;
let path: string;
let main: DatabaseSync;
let db: AppDb;
let usdId: string;
const cashId = 'account_cash_default';
const today = todayLocal();
const month = monthKey(today);

function adapter(sqlite: DatabaseSync): AppDb {
  const transaction = async (work: () => Promise<void>) => {
    sqlite.exec('BEGIN');
    try { await work(); sqlite.exec('COMMIT'); } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  };
  const result = {
    execAsync: async (sql: string) => { sqlite.exec(sql); },
    runAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).run(...params),
    getAllAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).all(...params),
    getFirstAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).get(...params) ?? null,
    closeAsync: async () => { sqlite.close(); },
    withTransactionAsync: transaction,
    withExclusiveTransactionAsync: async (work: (txn: AppDb) => Promise<void>) => transaction(() => work(result as unknown as AppDb)),
  };
  return result as unknown as AppDb;
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'walleaf-currency-'));
  path = join(directory, 'data.db');
  main = new DatabaseSync(path);
  db = adapter(main);
  jest.mocked(SQLite.openDatabaseAsync).mockResolvedValue(db);
  await openAppDatabase();
  await repo.createAccount(db, { name: 'Cash', type: 'CASH', opening_balance_minor: 50000, currency: 'USD' });
  usdId = (await repo.listAccounts(db)).find((account) => account.currency === 'USD')!.id;
});
afterEach(() => {
  try { main.close(); } catch { /* already closed by a restore */ }
  try { rmSync(directory, { recursive: true, force: true }); } catch { /* Windows may still hold the file briefly */ }
});

async function personNamed(name: string) {
  await repo.savePerson(db, name);
  return (await repo.listPeople(db)).find((person) => person.name === name)!.id;
}

test('the same account name is fine in another currency but not twice in one currency', async () => {
  const accounts = await repo.listAccounts(db);
  expect(accounts.map((account) => [account.name, account.currency]).sort()).toEqual([['Cash', 'PKR'], ['Cash', 'USD']]);
  await expect(repo.createAccount(db, { name: ' cash ', type: 'CASH', opening_balance_minor: 0, currency: 'USD' })).rejects.toThrow('ACCOUNT_NAME_EXISTS');
  expect(currenciesInUse(accounts, 'PKR')).toEqual(['PKR', 'USD']);
});

test('an exchange moves exactly the amounts typed: what left one account and what arrived in the other', async () => {
  // $100 handed to the exchange, Rs 27,500 received after its fee.
  await expect(repo.saveTransaction(db, { type: 'TRANSFER', amount_minor: 10000, account_id: usdId, destination_account_id: cashId, title: 'Exchange', occurred_on: today, source: 'MANUAL' }))
    .rejects.toThrow('Enter the amount that arrived.');
  const id = await repo.saveTransaction(db, { type: 'TRANSFER', amount_minor: 10000, account_id: usdId, destination_account_id: cashId, destination_amount_minor: 2750000, title: 'Exchange', occurred_on: today, source: 'MANUAL' });
  const [accounts, transactions] = [await repo.listAccounts(db), await repo.listTransactions(db)];
  const balance = (accountId: string) => calculateAccountBalance(accounts.find((account) => account.id === accountId)!, transactions, []);
  expect(balance(usdId)).toBe(40000);
  expect(balance(cashId)).toBe(2750000);
  // An exchange is neither spending nor income in either currency.
  expect(getMonthlyExpenseTotal(transactions, month)).toBe(0);
  const currencyOf = new Map(accounts.map((account) => [account.id, account.currency]));
  const data = { transactions, entries: [], budgets: [], goals: [], subscriptions: [], plannedPayments: [] };
  const usd = scopeToCurrency(data, currencyOf, 'USD', 'PKR');
  const pkr = scopeToCurrency(data, currencyOf, 'PKR', 'PKR');
  expect(calculateTotalAccountCashChange(usd.transactions, [], today, today, usd.accountIds)).toBe(-10000);
  expect(calculateTotalAccountCashChange(pkr.transactions, [], today, today, pkr.accountIds)).toBe(2750000);
  // The amount received can be corrected later; a move in one currency keeps a single amount.
  const tx = transactions.find((row) => row.id === id)!;
  await updateTransaction(db, id, tx.updated_at, { amount_minor: 10000, account_id: usdId, destination_account_id: cashId, destination_amount_minor: 2760000, category_id: null, title: 'Exchange', note: null, occurred_on: today });
  expect((await repo.listTransactions(db)).find((row) => row.id === id)!.destination_amount_minor).toBe(2760000);
  await repo.createAccount(db, { name: 'Bank', type: 'BANK', opening_balance_minor: 0, currency: 'USD' });
  const bank = (await repo.listAccounts(db)).find((account) => account.name === 'Bank')!.id;
  const same = await repo.saveTransaction(db, { type: 'TRANSFER', amount_minor: 500, account_id: usdId, destination_account_id: bank, destination_amount_minor: 999, title: 'Move', occurred_on: today, source: 'MANUAL' });
  expect((await repo.listTransactions(db)).find((row) => row.id === same)!.destination_amount_minor).toBeNull();
  // The database itself refuses a move between currencies without the amount received.
  await expect(db.runAsync("INSERT INTO transactions (id, type, amount_minor, account_id, destination_account_id, title, occurred_on, source, created_at, updated_at, sync_status) VALUES ('raw', 'TRANSFER', 100, ?, ?, 'Raw', ?, 'MANUAL', ?, ?, 'LOCAL');", usdId, cashId, today, '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z'))
    .rejects.toThrow('needs the amount received');
});

test("an account's currency can change only while it has no records", async () => {
  const empty = (await repo.listAccounts(db)).find((account) => account.id === usdId)!;
  await renameAccount(db, usdId, empty.updated_at, 'Dollars', 'EUR');
  let account = (await repo.listAccounts(db)).find((row) => row.id === usdId)!;
  expect([account.name, account.currency]).toEqual(['Dollars', 'EUR']);
  await repo.saveTransaction(db, { type: 'EXPENSE', amount_minor: 100, account_id: usdId, category_id: 'cat_expense_food', title: 'Coffee', occurred_on: today, source: 'MANUAL' });
  account = (await repo.listAccounts(db)).find((row) => row.id === usdId)!;
  await expect(renameAccount(db, usdId, account.updated_at, 'Dollars', 'USD')).rejects.toThrow('its currency stays the same');
  await expect(db.runAsync('UPDATE accounts SET currency = ? WHERE id = ?;', 'USD', usdId)).rejects.toThrow('cannot change once it has records');
});

test('spending and plans are worked out one currency at a time, never added together', async () => {
  await repo.saveTransaction(db, { type: 'EXPENSE', amount_minor: 100000, account_id: cashId, category_id: 'cat_expense_food', title: 'Groceries', occurred_on: today, source: 'MANUAL' });
  await repo.saveTransaction(db, { type: 'EXPENSE', amount_minor: 2500, account_id: usdId, category_id: 'cat_expense_food', title: 'Lunch', occurred_on: today, source: 'MANUAL' });
  await repo.saveBudget(db, { month_key: month, amount_minor: 5000000, currency: 'PKR' });
  await repo.saveBudget(db, { month_key: month, amount_minor: 30000, currency: 'USD' });
  await createCategoryBudget(db, { month, categoryId: 'cat_expense_food', amountMinor: 1000000, currency: 'PKR' });
  await createCategoryBudget(db, { month, categoryId: 'cat_expense_food', amountMinor: 10000, currency: 'USD' });
  await expect(createCategoryBudget(db, { month, categoryId: 'cat_expense_food', amountMinor: 1, currency: 'USD' })).rejects.toThrow('already has a budget');
  const accounts = await repo.listAccounts(db);
  const data = { transactions: await repo.listTransactions(db), entries: [], budgets: await repo.listBudgets(db, month), goals: [], subscriptions: [], plannedPayments: [] };
  const currencyOf = new Map(accounts.map((account) => [account.id, account.currency]));
  const pkr = scopeToCurrency(data, currencyOf, 'PKR', 'PKR');
  const usd = scopeToCurrency(data, currencyOf, 'USD', 'PKR');
  expect(getMonthlyExpenseTotal(pkr.transactions, month)).toBe(100000);
  expect(getMonthlyExpenseTotal(usd.transactions, month)).toBe(2500);
  expect(pkr.budgets.find((budget) => !budget.category_id)!.amount_minor).toBe(5000000);
  expect(usd.budgets.find((budget) => !budget.category_id)!.amount_minor).toBe(30000);
  expect(usd.budgets.filter((budget) => budget.category_id)).toHaveLength(1);
});

test('people balances are kept per currency and never cancel each other out', async () => {
  const ali = await personNamed('Ali');
  await recordPeopleAction(db, { personId: ali, action: 'GIVE', amountMinor: 300000, accountId: cashId, expectedBalanceMinor: 0 });
  // The dollar balance starts at zero: the rupee debt does not count against it.
  await recordPeopleAction(db, { personId: ali, action: 'BORROW', amountMinor: 2000, accountId: usdId, expectedBalanceMinor: 0 });
  const entries = await repo.listPersonEntries(db);
  const currencyOf = new Map((await repo.listAccounts(db)).map((account) => [account.id, account.currency]));
  expect(personBalancesByCurrency(entries, currencyOf, 'PKR')).toEqual([{ currency: 'PKR', amountMinor: 300000 }, { currency: 'USD', amountMinor: -2000 }]);
  expect(entries.map((entry) => entry.type).sort()).toEqual(['BORROWED_FROM', 'GIVEN']);
  expect((await readPersonSnapshot(db, ali, 'USD')).balanceMinor).toBe(-2000);
  const person = (await repo.listPeople(db)).find((row) => row.id === ali)!;
  await expect(archivePerson(db, ali, person.updated_at)).rejects.toMatchObject({ balanceMinor: 300000, currency: 'PKR' });
});

test('group bills, debts and payments are matched only within one currency', async () => {
  const ali = await personNamed('Ali');
  const groupId = await saveGroupDetails(db, { name: 'Dubai trip', personIds: [ali], includeSelf: true });
  await saveSharedExpensePosting(db, {
    title: 'Hotel', totalAmountMinor: 20000, categoryId: 'cat_expense_food', accountId: usdId, occurredOn: today, groupId,
    payerIsSelf: true, payerPersonId: null,
    shares: [{ name: 'You', isSelf: true, shareMinor: 10000 }, { name: 'Ali', personId: ali, isSelf: false, shareMinor: 10000 }],
  });
  const usd = await readGroupSnapshot(db, groupId, 'USD');
  expect(usd.currencies).toEqual(['USD']);
  expect(usd.positions.find((position) => position.personId === ali)!.owedMinor).toBe(10000);
  expect((await readGroupSnapshot(db, groupId, 'PKR')).targets).toEqual([]);
  // Rupees received from Ali cannot settle a dollar bill.
  const rupees = await repo.savePersonEntry(db, { person_id: ali, account_id: cashId, type: 'BORROWED_FROM', amount_minor: 10000, title: 'Cash from Ali', occurred_on: today });
  await expect(reconcileAllocation(db, { id: 'cross', sourceEntryId: rupees, targetEntryId: usd.targets[0].id, amountMinor: 100 })).rejects.toThrow();
  expect(await db.getAllAsync('SELECT * FROM entry_allocations;')).toEqual([]);
});

test('a backup keeps every currency, and an older one-currency backup restores into the main currency', async () => {
  await repo.saveTransaction(db, { type: 'TRANSFER', amount_minor: 10000, account_id: usdId, destination_account_id: cashId, destination_amount_minor: 2750000, title: 'Exchange', occurred_on: today, source: 'MANUAL' });
  await repo.saveBudget(db, { month_key: month, amount_minor: 30000, currency: 'USD' });
  await repo.saveGoal(db, { name: 'Laptop', target_amount_minor: 120000, initial_saved_minor: 0, linked_account_id: usdId });
  await repo.saveGoal(db, { name: 'Trip', target_amount_minor: 90000, initial_saved_minor: 0, currency: 'EUR' });
  const service = new BackupService({ now: () => '2026-11-20T12:00:00.000Z', open: async (staging) => adapter(new DatabaseSync(staging ? ':memory:' : path, { enableForeignKeyConstraints: false })) });
  const text = await service.export();
  const backup = JSON.parse(text) as Backup;
  expect(backup.schemaVersion).toBe(14);
  expect(backup.data.goals.map((goal) => [goal.name, goal.currency]).sort()).toEqual([['Laptop', 'USD'], ['Trip', 'EUR']]);
  await service.restore(text, async () => {});
  expect((await repo.listTransactions(db))[0].destination_amount_minor).toBe(2750000);
  expect((await repo.listBudgets(db, month)).map((budget) => budget.currency)).toEqual(['USD']);
  // A backup from before multiple currencies showed every amount in its saved
  // currency, whatever an account had stored: everything restores in that currency.
  const legacy = JSON.parse(text) as Backup;
  legacy.schemaVersion = 13;
  legacy.data.transactions = [];
  stripCurrenciesForFixture(legacy);
  await service.restore(JSON.stringify(legacy), async () => {});
  expect((await repo.listAccounts(db)).map((account) => account.currency)).toEqual(['PKR', 'PKR']);
  expect((await repo.listBudgets(db, month)).map((budget) => budget.currency)).toEqual(['PKR']);
  expect((await repo.listGoals(db)).map((goal) => [goal.name, goal.currency]).sort()).toEqual([['Laptop', 'PKR'], ['Trip', 'PKR']]);
});

test('upgrading puts every account in the currency the app was showing, so one-currency data stays one currency', async () => {
  // Before multiple currencies, changing the setting only relabelled what was shown.
  await removeMigration14ForFixture(db);
  await db.runAsync("UPDATE app_settings SET value = 'EUR' WHERE key = 'currency';");
  await openAppDatabase();
  expect((await repo.listAccounts(db)).map((account) => account.currency)).toEqual(['EUR', 'EUR']);
  expect(currenciesInUse(await repo.listAccounts(db), 'EUR')).toEqual(['EUR']);
});

test('with one currency, changing it in Settings relabels everything as before; with several it changes nothing', async () => {
  const pkrOnly = await repo.listAccounts(db);
  await db.runAsync("UPDATE accounts SET currency = 'PKR' WHERE id = ?;", usdId);
  await repo.saveTransaction(db, { type: 'EXPENSE', amount_minor: 100, account_id: cashId, category_id: 'cat_expense_food', title: 'Tea', occurred_on: today, source: 'MANUAL' });
  await repo.saveBudget(db, { month_key: month, amount_minor: 5000 });
  await repo.saveGoal(db, { name: 'Bike', target_amount_minor: 9000, initial_saved_minor: 0, linked_account_id: cashId });
  expect(pkrOnly).toHaveLength(2);
  expect(await repo.relabelOnlyCurrency(db, 'USD')).toBe(true);
  expect((await repo.listAccounts(db)).map((account) => account.currency)).toEqual(['USD', 'USD']);
  expect((await repo.listBudgets(db, month)).map((budget) => budget.currency)).toEqual(['USD']);
  expect((await repo.listGoals(db)).map((goal) => goal.currency)).toEqual(['USD']);
  expect((await repo.getSettings(db)).currency).toBe('USD');
  // The lock is back: a used account still cannot change currency on its own.
  await expect(db.runAsync("UPDATE accounts SET currency = 'EUR' WHERE id = ?;", cashId)).rejects.toThrow('cannot change once it has records');
  await repo.createAccount(db, { name: 'Euro wallet', type: 'EWALLET', opening_balance_minor: 0, currency: 'EUR' });
  expect(await repo.relabelOnlyCurrency(db, 'PKR')).toBe(false);
  expect((await repo.listAccounts(db)).map((account) => account.currency).sort()).toEqual(['EUR', 'USD', 'USD']);
});

test('the exchange rate is shown for information only, whichever side is larger', () => {
  expect(exchangeRateText('USD', 'PKR', 10000, 2750000)).toBe('Your rate: $1 = Rs. 275.00');
  expect(exchangeRateText('PKR', 'USD', 2780000, 10000)).toBe('Your rate: $1 = Rs. 278.00');
  expect(exchangeRateText('EUR', 'USD', 10000, 10850)).toBe('Your rate: €1 = $1.085');
});

test('the Transactions currency filter keeps one currency, with an exchange shown on both sides', async () => {
  await repo.saveTransaction(db, { type: 'EXPENSE', amount_minor: 2500, account_id: usdId, category_id: 'cat_expense_food', title: 'Dollar lunch', occurred_on: today, source: 'MANUAL' });
  await repo.saveTransaction(db, { type: 'EXPENSE', amount_minor: 90000, account_id: cashId, category_id: 'cat_expense_food', title: 'Rupee lunch', occurred_on: today, source: 'MANUAL' });
  await repo.saveTransaction(db, { type: 'TRANSFER', amount_minor: 2800000, account_id: cashId, destination_account_id: usdId, destination_amount_minor: 10000, title: 'Exchange', occurred_on: today, source: 'MANUAL' });
  const ali = await personNamed('Ali');
  await recordPeopleAction(db, { personId: ali, action: 'GIVE', amountMinor: 4000, accountId: usdId, title: 'Dollar loan', occurredOn: today, expectedBalanceMinor: 0 });
  const titles = async (currency?: string) => (await listActivity(db, { currency })).map((row) => row.title).sort();
  expect(await titles('USD')).toEqual(['Dollar loan', 'Dollar lunch', 'Exchange']);
  expect(await titles('PKR')).toEqual(['Exchange', 'Rupee lunch']);
  expect(await titles()).toEqual(['Dollar loan', 'Dollar lunch', 'Exchange', 'Rupee lunch']);
  // Every row carries its own currency, so amounts are never shown in the wrong one.
  const rows = await listActivity(db, { currency: 'USD' });
  expect(rows.find((row) => row.title === 'Dollar lunch')!.currency).toBe('USD');
  expect(rows.find((row) => row.title === 'Exchange')!.destination_amount_minor).toBe(10000);
});

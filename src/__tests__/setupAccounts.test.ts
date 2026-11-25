/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as SQLite from 'expo-sqlite';
import { openAppDatabase, type AppDb } from '../database/database';
import * as repo from '../database/repositories/repositories';
import { validateSetupInput } from '../services/onboarding/OnboardingService';
import { accountTypeRows, defaultAccountId } from '../services/accounts/AccountService';
import { currencyRows, defaultCurrency } from '../utils/currency';
import { calculateAccountBalance } from '../services/finance/FinanceService';
import { getMonthlyExpenseTotal } from '../services/budget/BudgetService';
import { monthKey, todayLocal } from '../utils/date';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

// Real SQL and repository/init code, with a Node SQLite adapter for the Expo API.
let sqlite: DatabaseSync;
let db: AppDb;
let failOn: string | null;
let writes: string[];
const input = { name: '  Alex  ', currency: 'PKR', startingCash: '15,000.50', monthlyPlan: '50,000' };

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  failOn = null;
  writes = [];
  const adapter = {
    execAsync: async (sql: string) => { sqlite.exec(sql); },
    runAsync: async (sql: string, ...params: (string | number | null)[]) => {
      if (failOn && (sql.includes(failOn) || params[0] === failOn)) throw new Error('Injected write failure');
      writes.push(sql);
      return sqlite.prepare(sql).run(...params);
    },
    getAllAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).all(...params),
    getFirstAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).get(...params) ?? null,
    withTransactionAsync: async (task: () => Promise<void>) => {
      sqlite.exec('BEGIN');
      try { await task(); sqlite.exec('COMMIT'); }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    withExclusiveTransactionAsync: async (task: (txn: AppDb) => Promise<void>) => {
      await adapter.withTransactionAsync(() => task(db));
    },
  };
  db = adapter as unknown as AppDb;
  jest.mocked(SQLite.openDatabaseAsync).mockResolvedValue(db);
});
afterEach(() => sqlite.close());

test('actual initialization seeds only Cash and an empty profile, and reopening preserves edits', async () => {
  await openAppDatabase();
  expect(await repo.listAccounts(db)).toMatchObject([{ id: 'account_cash_default', name: 'Cash', opening_balance_minor: 0 }]);
  expect(await repo.getSettings(db)).toMatchObject({ user_name: '', setup_complete: 'false' });
  await repo.setSetting(db, 'user_name', 'My name');
  await openAppDatabase();
  expect(await repo.listAccounts(db)).toHaveLength(1);
  expect((await repo.getSettings(db)).user_name).toBe('My name');
  expect(await repo.listTransactions(db)).toEqual([]);
});

test('exactly six currency choices, PKR default', () => {
  expect(currencyRows.map(([code]) => code)).toEqual(['PKR', 'USD', 'EUR', 'GBP', 'AED', 'SAR']);
  expect(defaultCurrency()).toBe('PKR');
});

test.each(currencyRows.map(([code]) => code))('setup persists %s with opening state, optional plan and no income', async (currency) => {
  await openAppDatabase();
  await repo.completeSetup(db, { ...input, currency });
  expect(await repo.getSettings(db)).toMatchObject({ user_name: 'Alex', currency, setup_complete: 'true' });
  const accounts = await repo.listAccounts(db);
  expect(accounts).toHaveLength(1);
  expect(accounts[0]).toMatchObject({ currency, opening_balance_minor: 1500050 });
  expect(calculateAccountBalance(accounts[0], [], [])).toBe(1500050);
  expect(await repo.listBudgets(db, monthKey(todayLocal()))).toMatchObject([{ category_id: null, amount_minor: 5000000 }]);
  expect(await repo.listTransactions(db)).toEqual([]);
  expect(writes[writes.length - 1]).toContain('app_settings');
  await repo.completeSetup(db, { ...input, startingCash: '1' });
  expect((await repo.listAccounts(db))[0].opening_balance_minor).toBe(1500050);
});

test('missing default Cash is recreated; blank optional amounts mean zero cash and no plan', async () => {
  await openAppDatabase();
  await db.runAsync('DELETE FROM accounts;');
  await repo.completeSetup(db, { ...input, startingCash: '  ', monthlyPlan: '' });
  expect(await repo.listAccounts(db)).toMatchObject([{ id: 'account_cash_default', opening_balance_minor: 0 }]);
  expect(await repo.listBudgets(db, monthKey(todayLocal()))).toEqual([]);
});

test.each(['', '   '])('blank name %j is rejected before writes', async (name) => {
  await expect(repo.completeSetup(db, { ...input, name })).rejects.toThrow('name');
  expect(writes).toEqual([]);
});

test.each(['', 'JPY', 'usd'])('unsupported currency %j is rejected', (currency) => {
  expect(validateSetupInput({ ...input, currency }).ok).toBe(false);
});

test.each(['-1', 'abc', '1.001', 'Infinity', 'NaN', '90071992547410', '9'.repeat(400)])('unsafe/invalid money %j is rejected in both setup amounts', (amount) => {
  expect(validateSetupInput({ ...input, startingCash: amount }).ok).toBe(false);
  expect(validateSetupInput({ ...input, monthlyPlan: amount }).ok).toBe(false);
});

test('explicit zero cash is allowed but zero plan is not', () => {
  expect(validateSetupInput({ ...input, startingCash: '0' }).ok).toBe(true);
  expect(validateSetupInput({ ...input, monthlyPlan: '0' }).ok).toBe(false);
});

test.each(['INSERT INTO accounts', 'INSERT OR REPLACE INTO budgets', 'INSERT OR REPLACE INTO app_settings', 'setup_complete'])('setup rolls back on %s failure and can retry', async (statement) => {
  await openAppDatabase();
  failOn = statement;
  await expect(repo.completeSetup(db, input)).rejects.toThrow('Injected');
  expect(await repo.getSettings(db)).toMatchObject({ user_name: '', currency: 'PKR', setup_complete: 'false' });
  expect((await repo.listAccounts(db))[0].opening_balance_minor).toBe(0);
  expect(await repo.listBudgets(db, monthKey(todayLocal()))).toEqual([]);
  failOn = null;
  await repo.completeSetup(db, input);
  expect((await repo.getSettings(db)).setup_complete).toBe('true');
});

test('manual types and multiple banks/wallets persist without income; transfers preserve total wealth', async () => {
  await openAppDatabase();
  for (const [type] of accountTypeRows) {
    await repo.createAccount(db, { name: ` My ${type} `, type, opening_balance_minor: 10000, currency: 'USD' });
  }
  await repo.createAccount(db, { name: 'Second bank', type: 'BANK', opening_balance_minor: 0 });
  await repo.createAccount(db, { name: 'Second wallet', type: 'EWALLET', opening_balance_minor: 0 });
  const accounts = await repo.listAccounts(db);
  expect(accounts).toHaveLength(7);
  for (const [type] of accountTypeRows)
    expect(accounts.find((a) => a.name === `My ${type}`)).toMatchObject({ type, currency: 'USD', opening_balance_minor: 10000 });
  expect(accounts.filter((a) => a.type === 'BANK')).toHaveLength(2);
  expect(accounts.filter((a) => a.type === 'EWALLET')).toHaveLength(2);
  expect(await repo.listTransactions(db)).toEqual([]);
  await expect(repo.createAccount(db, { name: ' my bank ', type: 'BANK', opening_balance_minor: 0, currency: 'USD' })).rejects.toThrow('ACCOUNT_NAME_EXISTS');
  const usd = accounts.filter((a) => a.currency === 'USD');
  await repo.saveTransaction(db, { type: 'TRANSFER', amount_minor: 5000, account_id: usd[0].id, destination_account_id: usd[1].id, title: 'Move Money', occurred_on: todayLocal(), source: 'MANUAL' });
  const transactions = await repo.listTransactions(db);
  expect(accounts.reduce((sum, a) => sum + calculateAccountBalance(a, transactions, []), 0)).toBe(40000);
  expect(getMonthlyExpenseTotal(transactions, monthKey(todayLocal()))).toBe(0);
});

test.each([
  { name: ' ', type: 'BANK', opening_balance_minor: 0 },
  { name: 'Bank', type: 'INVALID', opening_balance_minor: 0 },
  ...[NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((opening_balance_minor) => ({ name: 'Bank', type: 'BANK', opening_balance_minor })),
])('account repository rejects invalid input %j before writes', async (account) => {
  await expect(repo.createAccount(db, account)).rejects.toThrow();
  expect(writes).toEqual([]);
});

describe('source UI assertions (not rendered interaction tests)', () => {
  const source = readFileSync(join(__dirname, '../navigation/AppNavigator.tsx'), 'utf8');
  const setup = source.split('function OnboardingScreen()')[1].split('function HomeScreen')[0];
  const accounts = source.split('function AccountsScreen')[1].split('function CategoriesScreen')[0];
  test('setup retains blank inputs/shared currency selector and awaits completion before refresh', () => {
    expect(setup).toContain("const [name, setName] = useState('')");
    expect(setup).toContain('rows={currencyRows}');
    expect(setup).toMatch(/await repo.completeSetup[\s\S]*await refresh\(\)/);
    expect(setup).toContain('if (savingRef.current) return');
    expect(setup).toContain('disabled={saving || !validateSetupInput');
    expect(setup).toContain('catch');
  });
  test('second-account transition repairs destination and missing selections show an error', () => {
    expect(accounts).toContain('accounts.find((a) => a.id !== from)?.id');
    expect(accounts).toContain('[accounts, fromAccount, toAccount, settings, moveBaseline]');
    // An archived selection is replaced without leaving a false unsaved-changes prompt.
    expect(accounts).toContain("if (`${fromAccount ?? ''}|${toAccount ?? ''}` === moveBaseline) setMoveBaseline(`${from ?? ''}|${to ?? ''}`);");
    expect(accounts).toContain("alert('Missing accounts'");
    expect(accounts).toContain('rows={accountTypeRows}');
    // The list follows the Settings display currency (amounts are never converted), like every other screen.
    // Each account is shown in its own currency, grouped with the other accounts in that currency.
    expect(accounts).toContain("<Text style={{ color: colors.text, fontWeight: '700' }}>{formatMoney(calculateAccountBalance(a, transactions, entries), a.currency)}</Text>");
    expect(accounts).toContain('accountTotalsByCurrency(accounts, transactions, entries)');
    expect(accounts).toContain('formatMoney(section.totalMinor, section.code)');
    expect(accounts).toContain("navigation.navigate('AccountDetail', { accountId: a.id })");
  });
});

test('default account: the saved choice while active, else Cash, else the first account', () => {
  const bank = { id: 'bank', type: 'BANK' as const };
  const cash = { id: 'cash', type: 'CASH' as const };
  // Accounts are listed by name, so a bank can come before Cash.
  expect(defaultAccountId([bank, cash])).toBe('cash');
  expect(defaultAccountId([bank, cash], { default_account_id: 'bank' })).toBe('bank');
  expect(defaultAccountId([bank, cash], { default_account_id: 'archived' })).toBe('cash');
  expect(defaultAccountId([bank])).toBe('bank');
  expect(defaultAccountId([])).toBeUndefined();
});

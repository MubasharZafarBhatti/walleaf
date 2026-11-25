/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import * as SQLite from 'expo-sqlite';
import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';
import { openAppDatabase, type AppDb } from '../database/database';
import * as repo from '../database/repositories/repositories';
import { TransactionFormScreen } from '../navigation/AppNavigator';
import { PrimaryButton, TextField } from '../components/common';
import { Picker } from '../components/forms';
import { recordPeopleAction } from '../services/people/PersonService';
import { calculatePersonBalance } from '../services/people/PeopleBalanceService';
import { calculateAccountBalance, calculateTotalAccountCashChange } from '../services/finance/FinanceService';
import { getMonthlyExpenseTotal } from '../services/budget/BudgetService';
import { listActivity, readSharedEvent } from '../services/activity/ActivityService';
import { deleteSharedExpense, reopenSharedExpenseInput, sharedIntegrityReason } from '../services/sharedExpense/SharedExpenseService';
import { personBalancesByCurrency } from '../services/currency/CurrencyScope';
import { BackupService } from '../services/backup/BackupService';
import { monthKey, todayLocal } from '../utils/date';
import type { Account, Category, Person, TransactionType } from '../types/models';

const mockNavigation = {
  addListener: jest.fn(() => () => {}), isFocused: () => true, canGoBack: () => true,
  goBack: jest.fn(), popTo: jest.fn(), dispatch: jest.fn(),
};
const mockDialog = { confirm: jest.fn(), showDialog: jest.fn(), showSuccess: jest.fn() };
const mockData = {
  db: null as AppDb | null, repo, refresh: jest.fn(), transactions: [],
  accounts: [] as Account[], categories: [] as Category[], people: [] as Person[], allPeople: [] as Person[],
  groups: [], groupMembers: [], settings: { currency: 'PKR', week_start: 'MONDAY' },
};
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('@react-navigation/native', () => ({ DefaultTheme: { colors: {} }, useNavigation: () => mockNavigation }));
jest.mock('@react-navigation/stack', () => ({ createStackNavigator: () => ({}) }));
jest.mock('@react-navigation/material-top-tabs', () => ({ createMaterialTopTabNavigator: () => ({}) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../hooks/useAppData', () => ({ useAppData: () => mockData }));
jest.mock('../components/dialogs/AppDialogProvider', () => ({ useAppDialog: () => mockDialog }));

// Shahbaz owes you Rs. 100 and then pays Rs. 158 for your meal: the meal is your
// spending, no account money moves, and you now owe Shahbaz Rs. 58.
let sqlite: DatabaseSync;
let db: AppDb;
let renderer: ReactTestRenderer | undefined;
let shahbaz: string;
const cash = 'account_cash_default';
const food = 'cat_expense_food';
const today = todayLocal();

function adapter(source: DatabaseSync, closes = false): AppDb {
  const result = {
    execAsync: async (sql: string) => { source.exec(sql); },
    runAsync: async (sql: string, ...params: (string | number | null)[]) => source.prepare(sql).run(...params),
    getAllAsync: async (sql: string, ...params: (string | number | null)[]) => source.prepare(sql).all(...params),
    getFirstAsync: async (sql: string, ...params: (string | number | null)[]) => source.prepare(sql).get(...params) ?? null,
    closeAsync: async () => { if (closes) source.close(); },
    withTransactionAsync: async (work: () => Promise<void>) => {
      source.exec('BEGIN');
      try { await work(); source.exec('COMMIT'); } catch (error) { source.exec('ROLLBACK'); throw error; }
    },
    withExclusiveTransactionAsync: async (work: (txn: AppDb) => Promise<void>) => result.withTransactionAsync(() => work(result as unknown as AppDb)),
  };
  return result as unknown as AppDb;
}

beforeEach(async () => {
  jest.clearAllMocks();
  sqlite = new DatabaseSync(':memory:');
  db = adapter(sqlite);
  jest.mocked(SQLite.openDatabaseAsync).mockResolvedValue(db);
  await openAppDatabase();
  shahbaz = await repo.savePerson(db, 'Shahbaz');
  await db.runAsync('UPDATE accounts SET opening_balance_minor = 100000 WHERE id = ?;', cash);
  await loadData();
  mockData.db = db;
  mockData.refresh.mockResolvedValue(undefined);
  mockDialog.confirm.mockResolvedValue(true);
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  sqlite.close();
  jest.restoreAllMocks();
});

async function loadData() {
  mockData.accounts = await repo.listAccounts(db);
  mockData.categories = await repo.listCategories(db);
  const entries = await repo.listPersonEntries(db);
  const currencyOf = new Map(mockData.accounts.map((account) => [account.id, account.currency]));
  const people = (await repo.listAllPeople(db)).map((person) => ({ ...person, balances: personBalancesByCurrency(entries.filter((entry) => entry.person_id === person.id), currencyOf, 'PKR') }));
  mockData.allPeople = people;
  mockData.people = people.filter((person) => !person.is_archived);
}
async function open(params: object = { type: 'EXPENSE' }) {
  await act(async () => { renderer = create(createElement(TransactionFormScreen, { navigation: mockNavigation, route: { params } })); });
}
const field = (label: string) => renderer!.root.findAllByType(TextField).find((node) => node.props.label === label);
const picker = (label: string) => renderer!.root.findAllByType(Picker).find((node) => node.props.label === label);
const texts = () => renderer!.root.findAllByType(Text).map((node) => [node.props.children].flat().join(''));
async function enter(label: string, value: string) { await act(async () => field(label)!.props.onChangeText(value)); }
async function choose(label: string, value: string) { await act(async () => picker(label)!.props.setValue(value)); }
async function save() { await act(async () => renderer!.root.findByType(PrimaryButton).props.onPress()); }
async function shahbazBalance() { return calculatePersonBalance((await repo.listPersonEntries(db)).filter((entry) => entry.person_id === shahbaz)); }
async function cashBalance() {
  return calculateAccountBalance((await repo.listAccounts(db)).find((a) => a.id === cash)!, await repo.listTransactions(db), await repo.listPersonEntries(db));
}
async function shahbazOwesMe100() {
  await recordPeopleAction(db, { personId: shahbaz, action: 'GIVE', amountMinor: 10000, accountId: cash, title: 'Loan', occurredOn: today, expectedBalanceMinor: 0 });
  await loadData();
}

test('a meal Shahbaz paid becomes your spending and moves his balance from owing you to you owing him', async () => {
  await shahbazOwesMe100();
  const cashBefore = await cashBalance();
  expect(await shahbazBalance()).toBe(10000);
  await open();
  await enter('Amount', '158');
  await choose('Paid by', shahbaz);
  await enter('Description', 'Lunch');
  await choose('Category', food);
  // No account is charged, so the Account picker and Note are replaced by the balance preview.
  expect(picker('Account')).toBeUndefined();
  expect(field('Note optional')).toBeUndefined();
  expect(texts()).toEqual(expect.arrayContaining(['No money leaves your accounts.', 'Now: Shahbaz owes you Rs. 100', 'After this: You owe Shahbaz Rs. 58']));
  await save();

  expect(mockDialog.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Balance will cross zero', message: 'Shahbaz: You will owe Shahbaz Rs. 58 after this expense. Continue?' }));
  expect(await shahbazBalance()).toBe(-5800);
  expect(await cashBalance()).toBe(cashBefore);
  const transactions = await repo.listTransactions(db);
  const meal = transactions.find((t) => t.title === 'Lunch')!;
  expect(meal).toMatchObject({ type: 'EXPENSE', amount_minor: 15800, category_id: food, source: 'SPLIT' });
  expect(getMonthlyExpenseTotal(transactions, monthKey(today))).toBe(15800);
  expect(calculateTotalAccountCashChange(transactions.filter((t) => t.title === 'Lunch'), (await repo.listPersonEntries(db)).filter((e) => e.title === 'Lunch'), today, today)).toBe(0);
  expect((await repo.listPersonEntries(db)).filter((e) => e.title === 'Lunch')).toEqual([expect.objectContaining({ type: 'RECEIVED_BACK', amount_minor: 15800, person_id: shahbaz })]);
  expect(mockNavigation.goBack).toHaveBeenCalled();

  // It is an ordinary shared bill: listed once, editable in Split, deletable, and backed up.
  const rows = (await listActivity(db)).filter((row) => row.title === 'Lunch');
  expect(rows).toHaveLength(1);
  const records = await readSharedEvent(db, rows[0].source_id);
  expect(await sharedIntegrityReason(db, records)).toBeNull();
  expect(reopenSharedExpenseInput(records)).toMatchObject({ payers: [{ identity: `PERSON:${shahbaz}`, paidMinor: 15800 }], shares: [expect.objectContaining({ isSelf: true, shareMinor: 15800 })] });
  const backup = new BackupService({ now: () => '2026-11-26T09:00:00.000Z', open: async (staging) => staging ? adapter(new DatabaseSync(':memory:'), true) : adapter(sqlite) });
  await expect(backup.preview(await backup.export())).resolves.toBeDefined();
  await deleteSharedExpense(db, records.split.id, records.split.updated_at);
  expect(await shahbazBalance()).toBe(10000);
  expect(await cashBalance()).toBe(cashBefore);
});

test('going back from the cross-zero warning saves nothing', async () => {
  await shahbazOwesMe100();
  mockDialog.confirm.mockResolvedValue(false);
  await open();
  await enter('Amount', '158');
  await choose('Paid by', shahbaz);
  await save();
  expect(await shahbazBalance()).toBe(10000);
  expect((await repo.listTransactions(db)).filter((t) => t.type === 'EXPENSE')).toHaveLength(0);
  expect(mockNavigation.goBack).not.toHaveBeenCalled();
});

test('when settled, an expense someone paid is recorded as money you owe them, without a warning', async () => {
  await open();
  await enter('Amount', '500');
  await choose('Paid by', shahbaz);
  expect(texts()).toEqual(expect.arrayContaining(['Now: Settled', 'After this: You owe Shahbaz Rs. 500']));
  await save();
  expect(mockDialog.confirm).not.toHaveBeenCalled();
  expect(await shahbazBalance()).toBe(-50000);
  expect((await repo.listPersonEntries(db))).toEqual([expect.objectContaining({ type: 'BORROWED_FROM', amount_minor: 50000 })]);
  expect(await cashBalance()).toBe(100000);
});

test('paid by You is the normal expense from the chosen account, with its note', async () => {
  await open();
  expect(picker('Paid by')!.props.value).toBe('SELF');
  expect(picker('Paid by')!.props.rows).toEqual([['SELF', 'You'], [shahbaz, 'Shahbaz']]);
  await enter('Amount', '200');
  await enter('Note optional', 'Tea');
  await save();
  expect(await repo.listTransactions(db)).toEqual([expect.objectContaining({ type: 'EXPENSE', amount_minor: 20000, source: 'MANUAL', note: 'Tea', account_id: cash })]);
  expect(await repo.listPersonEntries(db)).toEqual([]);
  expect(await cashBalance()).toBe(80000);
});

test('Paid by is offered only for a new expense when there are active people', async () => {
  await open({ type: 'INCOME' });
  expect(picker('Paid by')).toBeUndefined();
  await act(async () => renderer!.unmount());
  const id = await repo.saveTransaction(db, { type: 'EXPENSE', amount_minor: 1000, account_id: cash, destination_account_id: null, category_id: food, title: 'Old', note: '', occurred_on: today, source: 'MANUAL' });
  const transaction = (await repo.listTransactions(db)).find((t) => t.id === id)!;
  await open({ transaction: transaction as unknown as { type: TransactionType } });
  expect(picker('Paid by')).toBeUndefined();
  await act(async () => renderer!.unmount());
  mockData.people = [];
  await open();
  expect(picker('Paid by')).toBeUndefined();
  expect(picker('Account')).toBeDefined();
});

test('switching Paid by back to You brings back the Account and Note fields', async () => {
  await open();
  await choose('Paid by', shahbaz);
  await choose('Paid by', 'SELF');
  expect(picker('Account')).toBeDefined();
  expect(field('Note optional')).toBeDefined();
});

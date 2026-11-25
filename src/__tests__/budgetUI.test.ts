/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import * as SQLite from 'expo-sqlite';
import { act, createElement } from 'react';
import { Text } from 'react-native';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { openAppDatabase, type AppDb } from '../database/database';
import * as repo from '../database/repositories/repositories';
import { BudgetScreen } from '../navigation/AppNavigator';
import { ListRow, PrimaryButton, SecondaryButton, TextField } from '../components/common';
import { Picker } from '../components/forms';
import type { Budget, Category, Settings, Transaction } from '../types/models';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('@react-navigation/native', () => ({ DefaultTheme: { colors: {} }, NavigationContainer: 'NavigationContainer', useNavigation: () => ({ goBack: jest.fn() }), useIsFocused: () => true }));
jest.mock('@react-navigation/material-top-tabs', () => ({ createMaterialTopTabNavigator: () => ({ Navigator: 'Tabs', Screen: 'Tab' }) }));
jest.mock('@react-navigation/stack', () => ({ createStackNavigator: () => ({ Navigator: 'Stack', Screen: 'StackScreen' }) }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
const mockDialog = { confirm: jest.fn(), showDialog: jest.fn(), showSuccess: jest.fn() };
jest.mock('../components/dialogs/AppDialogProvider', () => ({ useAppDialog: () => mockDialog }));
const mockData = {
  db: null as AppDb | null,
  repo,
  budgets: [] as Budget[],
  transactions: [] as Transaction[],
  categories: [] as Category[],
  settings: { budget_alert_threshold: '80', currency: 'PKR' } as Settings,
  refresh: jest.fn(),
};
jest.mock('../hooks/useAppData', () => ({ useAppData: () => mockData }));
jest.mock('../hooks/useSubmitGuard', () => ({ useSubmitGuard: (refresh: () => Promise<void>) => ({
  saving: false,
  isSaving: () => false,
  submit: (work: () => Promise<void>) => work(),
  saved: async (_message: string, done: () => void) => { done(); await refresh(); },
}) }));
jest.mock('../hooks/useDirtyForm', () => ({ useDirtyForm: () => ({ discard: (action: () => void) => action(), leave: (action: () => void) => action() }) }));

type Value = string | number | null;
let sqlite: DatabaseSync;
let db: AppDb;
let renderer: ReactTestRenderer | undefined;

beforeEach(async () => {
  jest.useFakeTimers().setSystemTime(new Date(2026, 8, 15, 12));
  sqlite = new DatabaseSync(':memory:');
  const adapter = {
    execAsync: async (sql: string) => { sqlite.exec(sql); },
    runAsync: async (sql: string, ...params: Value[]) => sqlite.prepare(sql).run(...params),
    getAllAsync: async (sql: string, ...params: Value[]) => sqlite.prepare(sql).all(...params),
    getFirstAsync: async (sql: string, ...params: Value[]) => sqlite.prepare(sql).get(...params) ?? null,
    withTransactionAsync: async (work: () => Promise<void>) => { sqlite.exec('BEGIN'); try { await work(); sqlite.exec('COMMIT'); } catch (error) { sqlite.exec('ROLLBACK'); throw error; } },
    withExclusiveTransactionAsync: async (work: (txn: AppDb) => Promise<void>) => { sqlite.exec('BEGIN EXCLUSIVE'); try { await work(adapter as unknown as AppDb); sqlite.exec('COMMIT'); } catch (error) { sqlite.exec('ROLLBACK'); throw error; } },
  };
  db = adapter as unknown as AppDb;
  jest.mocked(SQLite.openDatabaseAsync).mockResolvedValue(db);
  await openAppDatabase();
  mockData.db = db;
  mockData.categories = await repo.listCategories(db);
  mockData.transactions = [];
  mockData.budgets = [];
  mockData.refresh.mockImplementation(async () => {
    mockData.categories = await repo.listCategories(db);
    mockData.transactions = await repo.listTransactions(db);
    mockData.budgets = await repo.listBudgets(db, '2026-09');
  });
  mockDialog.confirm.mockReset().mockResolvedValue(true);
  mockDialog.showDialog.mockReset();
  mockDialog.showSuccess.mockReset();
});

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  sqlite.close();
  jest.useRealTimers();
});

async function renderScreen() {
  await act(async () => { renderer = create(createElement(BudgetScreen)); });
  await act(async () => {});
}

function navButton(label: string) {
  return renderer!.root.findAll((node) => node.props.accessibilityLabel === label)[0];
}

test('month controls navigate previous/current/next and stop after the allowed next month', async () => {
  await repo.saveBudget(db, { month_key: '2026-08', amount_minor: 1000 });
  await renderScreen();
  expect(renderer!.root.findAllByType(Text).some((node) => node.props.children === 'September 2026')).toBe(true);
  await act(async () => navButton('Previous month').props.onPress());
  expect(renderer!.root.findAllByType(Text).some((node) => node.props.children === 'August 2026')).toBe(true);
  await act(async () => renderer!.root.findAllByType(SecondaryButton).find((button) => button.props.title === 'Return to current month')!.props.onPress());
  await act(async () => navButton('Next month').props.onPress());
  expect(renderer!.root.findAllByType(Text).some((node) => node.props.children === 'October 2026')).toBe(true);
  expect(navButton('Next month').props.disabled).toBe(true);
});

test('fresh plan has a visibly disabled inert previous arrow and browsing writes nothing', async () => {
  await renderScreen();
  expect(navButton('Previous month').props.disabled).toBe(true);
  expect(navButton('Previous month').props.accessibilityState.disabled).toBe(true);
  await act(async () => navButton('Previous month').props.onPress());
  expect(await db.getAllAsync('SELECT * FROM budgets')).toEqual([]);
  expect(renderer!.root.findAllByType(Text).some((node) => node.props.children === 'September 2026')).toBe(true);
});

test('total plan prefills by month, preserves a dirty amount during refresh, and keeps same-value USER adoption', async () => {
  await repo.saveBudget(db, { month_key: '2026-09', amount_minor: 7500000 });
  await repo.saveBudget(db, { month_key: '2026-08', amount_minor: 6000000 });
  await mockData.refresh();
  await renderScreen();
  const total = () => renderer!.root.findAllByType(TextField).find((field) => field.props.label === 'Edit Total Spending Plan')!;
  const save = () => renderer!.root.findAllByType(PrimaryButton).find((button) => button.props.title === 'Save Spending Plan')!;
  expect(total().props.value).toBe('75000');
  expect(save().props.disabled).toBe(false);
  await act(async () => total().props.onChangeText('80000'));
  await act(async () => { await mockData.refresh(); renderer!.update(createElement(BudgetScreen)); });
  expect(total().props.value).toBe('80000');
  await act(async () => save().props.onPress());
  expect((await repo.listBudgets(db, '2026-09'))[0].amount_minor).toBe(8000000);
  await act(async () => navButton('Previous month').props.onPress());
  expect(total().props.value).toBe('60000');
});

test('category budget form creates, edits, and safely removes a budget', async () => {
  await renderScreen();
  const picker = renderer!.root.findByType(Picker);
  expect(picker.props.rows.some((row: string[]) => row[0] === 'cat_expense_food')).toBe(true);
  await act(async () => picker.props.setValue('cat_expense_food'));
  await act(async () => renderer!.root.findAllByType(TextField).find((field) => field.props.label === 'Category Budget Amount')!.props.onChangeText('1200'));
  await act(async () => renderer!.root.findAllByType(PrimaryButton).find((button) => button.props.title === 'Add Category Budget')!.props.onPress());
  const foodRow = renderer!.root.findAllByType(ListRow).find((row) => row.props.title === 'Food')!;
  expect(String(foodRow.props.subtitle)).toContain('Allocated');
  await act(async () => foodRow.props.onPress());
  await act(async () => renderer!.root.findAllByType(TextField).find((field) => field.props.label === 'Edit Category Budget Amount')!.props.onChangeText('1500'));
  await act(async () => renderer!.root.findAllByType(PrimaryButton).find((button) => button.props.title === 'Update Category Budget')!.props.onPress());
  expect((await repo.listBudgets(db, '2026-09'))[0].amount_minor).toBe(150000);
  await act(async () => renderer!.root.findAllByType(ListRow).find((row) => row.props.title === 'Food')!.props.onPress());
  await act(async () => renderer!.root.findAllByType(SecondaryButton).find((button) => button.props.title === 'Remove Category Budget')!.props.onPress());
  expect(mockDialog.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Remove category budget?', destructive: true }));
  expect(await repo.listBudgets(db, '2026-09')).toEqual([]);
});

test('new selector excludes archived categories while historical archived budget keeps its name', async () => {
  await repo.saveBudget(db, { month_key: '2026-08', category_id: 'cat_expense_food', amount_minor: 100000 });
  const food = mockData.categories.find((row) => row.id === 'cat_expense_food')!;
  await repo.archiveCategory(db, food.id, food.updated_at);
  await mockData.refresh();
  await renderScreen();
  expect(renderer!.root.findByType(Picker).props.rows.some((row: string[]) => row[0] === food.id)).toBe(false);
  await act(async () => navButton('Previous month').props.onPress());
  const historical = renderer!.root.findAllByType(ListRow).find((row) => row.props.title === 'Food')!;
  expect(String(historical.props.subtitle)).toContain('Archived category');
});

test('copy preview confirms merge policy and copies only available prior-month rows', async () => {
  await repo.saveBudget(db, { month_key: '2026-08', amount_minor: 900000 });
  await repo.saveBudget(db, { month_key: '2026-08', category_id: 'cat_expense_food', amount_minor: 300000 });
  await repo.saveBudget(db, { month_key: '2026-09', amount_minor: 700000 });
  await mockData.refresh();
  await renderScreen();
  await act(async () => renderer!.root.findAllByType(SecondaryButton).find((button) => button.props.title === 'Copy previous month')!.props.onPress());
  expect(mockDialog.confirm).toHaveBeenCalledWith(expect.objectContaining({
    title: 'Copy previous month?',
    message: expect.stringContaining('existing item(s) kept'),
  }));
  expect((await repo.listBudgets(db, '2026-09')).map((row) => [row.category_id, row.amount_minor])).toEqual([[null, 700000], ['cat_expense_food', 300000]]);
});

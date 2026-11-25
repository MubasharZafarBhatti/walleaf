import { DatabaseSync } from 'node:sqlite';
import * as SQLite from 'expo-sqlite';
import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { FlatList } from 'react-native';
import { AddPlannedPaymentScreen, AddSubscriptionScreen, PlannedScreen, SubscriptionsScreen } from '../navigation/AppNavigator';
import { PrimaryButton, TextField } from '../components/common';
import { Picker } from '../components/forms';
import { openAppDatabase, type AppDb } from '../database/database';
import * as repo from '../database/repositories/repositories';
import { calculateAccountBalance } from '../services/finance/FinanceService';
import { getMonthlyExpenseTotal } from '../services/budget/BudgetService';
import { addDays, dateKeyToInputDate, todayLocal } from '../utils/date';
import { calculateNextRenewal } from '../services/subscriptions/SubscriptionService';
import { readReminderDelivery } from '../services/notifications/NotificationService';

const mockNavigation = { addListener: jest.fn(() => () => {}), isFocused: () => true, goBack: jest.fn(), navigate: jest.fn(), dispatch: jest.fn() };
const mockDialog = { confirm: jest.fn(), showDialog: jest.fn(), showSuccess: jest.fn() };
const mockOutflow = jest.fn();
const mockData: any = { repo, settings: { currency: 'PKR', week_start: 'MONDAY' }, refresh: jest.fn(), allPeople: [], transactions: [], entries: [], groups: [] };
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('@react-navigation/native', () => ({ DefaultTheme: { colors: {} }, useNavigation: () => mockNavigation }));
jest.mock('@react-navigation/stack', () => ({ createStackNavigator: () => ({}) }));
jest.mock('@react-navigation/material-top-tabs', () => ({ createMaterialTopTabNavigator: () => ({}) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../hooks/useAppData', () => ({ useAppData: () => mockData }));
jest.mock('../components/dialogs/AppDialogProvider', () => ({ useAppDialog: () => mockDialog }));
jest.mock('../hooks/useConfirmOutflow', () => ({ useConfirmOutflow: () => mockOutflow, useConfirmActivityChange: () => jest.fn() }));
jest.mock('../services/notifications/NotificationService', () => ({ ...jest.requireActual('../services/notifications/NotificationService'), readReminderDelivery: jest.fn() }));

let sqlite: DatabaseSync;
let db: AppDb;
let renderer: ReactTestRenderer | undefined;
beforeEach(async () => {
  jest.clearAllMocks();
  jest.mocked(readReminderDelivery).mockResolvedValue({ enabled: true, status: { permission: 'granted', canAskAgain: false, scheduling: 'available' } });
  mockDialog.showDialog.mockReset();
  mockNavigation.addListener.mockReturnValue(() => {});
  mockDialog.confirm.mockResolvedValue(true); mockOutflow.mockResolvedValue(true);
  sqlite = new DatabaseSync(':memory:');
  const transaction = async (work: () => Promise<void>) => { sqlite.exec('BEGIN'); try { await work(); sqlite.exec('COMMIT'); } catch (error) { sqlite.exec('ROLLBACK'); throw error; } };
  const adapter = {
    execAsync: async (sql: string) => { sqlite.exec(sql); },
    runAsync: async (sql: string, ...values: (string | number | null)[]) => sqlite.prepare(sql).run(...values),
    getFirstAsync: async (sql: string, ...values: (string | number | null)[]) => sqlite.prepare(sql).get(...values) ?? null,
    getAllAsync: async (sql: string, ...values: (string | number | null)[]) => sqlite.prepare(sql).all(...values),
    withTransactionAsync: transaction,
    withExclusiveTransactionAsync: async (work: (txn: AppDb) => Promise<void>) => transaction(() => work(db)),
  };
  db = adapter as unknown as AppDb;
  jest.mocked(SQLite.openDatabaseAsync).mockResolvedValue(db);
  await openAppDatabase();
  await db.runAsync('UPDATE accounts SET opening_balance_minor = 3300000');
  mockData.db = db;
  mockData.categories = await repo.listCategories(db); mockData.accounts = await repo.listAccounts(db);
  mockData.plannedPayments = []; mockData.subscriptions = [];
  mockData.refresh.mockImplementation(async () => {
    mockData.plannedPayments = await repo.listPlannedPayments(db);
    mockData.subscriptions = await repo.listSubscriptions(db);
  });
});
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; sqlite.close(); });
async function render(component: typeof PlannedScreen) {
  if (renderer) await act(async () => renderer!.unmount());
  await act(async () => { renderer = create(createElement(component, { navigation: mockNavigation })); });
}
const field = (label: string) => renderer!.root.findAllByType(TextField).find((node) => node.props.label === label)!;
async function enter(label: string, value: string) { await act(async () => field(label).props.onChangeText(value)); }
const save = () => renderer!.root.findByType(PrimaryButton).props.onPress();
async function cash() { return calculateAccountBalance(mockData.accounts[0], await repo.listTransactions(db), await repo.listPersonEntries(db)); }

test('Planned list -> FAB -> Add -> Save returns to the refreshed list and creates no financial rows', async () => {
  await render(PlannedScreen);
  expect(renderer!.root.findAllByType(TextField)).toHaveLength(0);
  await act(async () => renderer!.root.findByProps({ accessibilityLabel: 'Add planned payment' }).props.onPress());
  expect(mockNavigation.navigate).toHaveBeenCalledWith('AddPlannedPayment');
  await render(AddPlannedPaymentScreen);
  await enter('Name', 'Internet'); await enter('Amount', '500'); await enter('Next Date', dateKeyToInputDate(addDays(todayLocal(), 3)));
  await act(async () => save());
  expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
  expect(mockData.refresh).toHaveBeenCalledTimes(1);
  await render(PlannedScreen);
  const list = renderer!.root.findByType(FlatList);
  expect(list.props.data).toEqual([expect.objectContaining({ name: 'Internet', amount_minor: 50000 })]);
  await act(async () => list.props.renderItem({ item: list.props.data[0] }).props.onPress());
  expect(mockNavigation.navigate).toHaveBeenLastCalledWith('PlannedPaymentDetail', { plannedPaymentId: list.props.data[0].id });
  expect(await repo.listTransactions(db)).toEqual([]); expect(await repo.listPersonEntries(db)).toEqual([]);
  expect(await cash()).toBe(3300000);
});

test.each(['Record Today', 'Start Next Renewal'])('Subscription list -> Add -> %s -> Save returns to refreshed list with correct accounting', async (choice) => {
  mockDialog.showDialog.mockImplementation((options) => options.actions?.find((action: any) => action.text === choice)?.onPress());
  await render(SubscriptionsScreen);
  expect(renderer!.root.findAllByType(TextField)).toHaveLength(0);
  await act(async () => renderer!.root.findByProps({ accessibilityLabel: 'Add subscription' }).props.onPress());
  expect(mockNavigation.navigate).toHaveBeenCalledWith('AddSubscription');
  await render(AddSubscriptionScreen);
  await enter('Name', 'Netflix'); await enter('Amount', '500'); await enter('Start date', dateKeyToInputDate(todayLocal()));
  const press = save;
  await act(async () => { await press(); });
  expect(mockDialog.showDialog).toHaveBeenCalledWith(expect.objectContaining({ actions: expect.arrayContaining([expect.objectContaining({ text: 'Record Today' }), expect.objectContaining({ text: 'Start Next Renewal' })]) }));
  expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
  const transactions = await repo.listTransactions(db);
  expect(transactions).toHaveLength(choice === 'Record Today' ? 1 : 0);
  expect(await cash()).toBe(choice === 'Record Today' ? 3250000 : 3300000);
  expect(getMonthlyExpenseTotal(transactions, todayLocal().slice(0, 7))).toBe(choice === 'Record Today' ? 50000 : 0);
  const sub = mockData.subscriptions[0];
  expect(sub.next_renewal_date).toBe(calculateNextRenewal(todayLocal(), 'MONTHLY'));
  const payments = await repo.listSubscriptionPayments(db, sub.id);
  expect(payments).toHaveLength(choice === 'Record Today' ? 1 : 0);
  if (payments.length) expect(payments[0].transaction_date).toBe(todayLocal());
  expect(mockOutflow).toHaveBeenCalledTimes(choice === 'Record Today' ? 1 : 0);
  await render(SubscriptionsScreen);
  const list = renderer!.root.findByType(FlatList);
  expect(list.props.data).toEqual([expect.objectContaining({ name: 'Netflix' })]);
  await act(async () => list.props.renderItem({ item: sub }).props.onPress());
  expect(mockNavigation.navigate).toHaveBeenLastCalledWith('SubscriptionDetail', { subscriptionId: sub.id });
});

test.each([['future', 10], ['past', -10]] as const)('%s subscription start creates only tracking and no assumed/backfilled payment', async (_label, offset) => {
  await render(AddSubscriptionScreen);
  const start = addDays(todayLocal(), offset);
  await enter('Name', 'Scheduled service'); await enter('Amount', '500'); await enter('Start date', dateKeyToInputDate(start));
  await act(async () => save());
  expect(mockDialog.showDialog).not.toHaveBeenCalled();
  expect(mockData.subscriptions[0].next_renewal_date).toBe(offset > 0 ? start : calculateNextRenewal(start, 'MONTHLY'));
  expect(await repo.listTransactions(db)).toEqual([]); expect(await cash()).toBe(3300000);
});

test.each([AddPlannedPaymentScreen, AddSubscriptionScreen])('Add screen validation retains input and stays open', async (component) => {
  await render(component);
  await enter('Name', 'Keep this draft'); await enter('Amount', 'invalid');
  await act(async () => save());
  expect(field('Name').props.value).toBe('Keep this draft');
  expect(mockNavigation.goBack).not.toHaveBeenCalled();
  expect(await repo.listSubscriptions(db)).toEqual([]); expect(await repo.listPlannedPayments(db)).toEqual([]);
});

test('today choice cancellation and outflow cancellation do not create a partial subscription', async () => {
  mockDialog.showDialog.mockImplementation((options) => options.onCancel?.());
  await render(AddSubscriptionScreen);
  await enter('Name', 'Netflix'); await enter('Amount', '500'); await enter('Start date', dateKeyToInputDate(todayLocal()));
  await act(async () => save());
  expect(await repo.listSubscriptions(db)).toEqual([]);
  mockDialog.showDialog.mockImplementation((options) => options.actions.find((action: any) => action.text === 'Record Today').onPress());
  mockOutflow.mockResolvedValue(false);
  await act(async () => save());
  expect(await repo.listSubscriptions(db)).toEqual([]); expect(await repo.listTransactions(db)).toEqual([]);
  expect(field('Name').props.value).toBe('Netflix');
});

test('rapid first-payment save taps create one subscription and one real Expense', async () => {
  mockDialog.showDialog.mockImplementation((options) => options.actions.find((action: any) => action.text === 'Record Today').onPress());
  await render(AddSubscriptionScreen);
  await enter('Name', 'Netflix'); await enter('Amount', '500'); await enter('Start date', dateKeyToInputDate(todayLocal()));
  const press = renderer!.root.findByType(PrimaryButton).props.onPress;
  await act(async () => { const pending = press(); void press(); await pending; });
  expect(await repo.listSubscriptions(db)).toHaveLength(1); expect(await repo.listTransactions(db)).toHaveLength(1);
  expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
});

test.each([AddPlannedPaymentScreen, AddSubscriptionScreen])('Every N Days create control validates, persists and labels its interval without recording cash', async component => {
  await render(component);
  await enter('Name', 'Day schedule'); await enter('Amount', '200');
  const subscription = component === AddSubscriptionScreen;
  await enter(subscription ? 'Start date' : 'Next Date', dateKeyToInputDate(addDays(todayLocal(), 10)));
  const picker = renderer!.root.findAllByType(Picker).find(n => n.props.label === (subscription ? 'Frequency' : 'Recurrence'))!;
  expect(picker.props.rows).toEqual(expect.arrayContaining([['DAILY', 'Daily'], ['EVERY_N_DAYS', 'Every N Days']]));
  await act(async () => picker.props.setValue('EVERY_N_DAYS'));
  await enter('Repeat every', '0'); await act(async () => save());
  expect(mockDialog.showDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'Invalid repeat interval' })); expect(field('Name').props.value).toBe('Day schedule');
  await enter('Repeat every', '23'); await act(async () => save());
  const row = subscription ? (await repo.listSubscriptions(db))[0] : (await repo.listPlannedPayments(db))[0];
  expect(subscription ? (row as import('../types/models').Subscription).frequency_interval : (row as import('../types/models').PlannedPayment).recurrence_interval).toBe(23);
  expect(await repo.listTransactions(db)).toEqual([]); expect(await cash()).toBe(3300000);
  await render(subscription ? SubscriptionsScreen : PlannedScreen);
  const list = renderer!.root.findByType(FlatList); expect(list.props.renderItem({ item: row }).props.subtitle).toContain('Every 23 days');
});
test.each(['0', '1', '2', '3'])('Subscription creation exposes and persists the single selected reminder offset %s', async days => {
  await render(AddSubscriptionScreen); await enter('Name', 'Reminder preference'); await enter('Amount', '200'); await enter('Start date', dateKeyToInputDate(addDays(todayLocal(), 10)));
  const picker = () => renderer!.root.findAllByType(Picker).find(node => node.props.label === 'Remind me')!;
  await act(async () => picker().props.setValue(days)); await act(async () => save());
  expect((await repo.listSubscriptions(db))[0]).toMatchObject({ reminder_enabled: 1, reminder_days_before: Number(days) }); expect(await repo.listTransactions(db)).toEqual([]);
});

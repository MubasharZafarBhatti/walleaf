import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { Linking, Platform } from 'react-native';
import { AddPlannedPaymentScreen, AddSubscriptionScreen } from '../navigation/AppNavigator';
import { PlannedPaymentDetailScreen } from '../navigation/PlannedPaymentScreens';
import { SubscriptionDetailScreen } from '../navigation/SubscriptionScreens';
import { PrimaryButton, SecondaryButton, TextField } from '../components/common';
import { Picker } from '../components/forms';
import { useAppData } from '../hooks/useAppData';
import { useAppDialog } from '../components/dialogs/AppDialogProvider';
import * as repo from '../database/repositories/repositories';
import { localNotificationApi } from '../services/notifications/LocalNotificationApi';
import * as notifications from '../services/notifications/NotificationService';
import { reminderDatabase, reminderPlan, reminderSubscription } from './reminderFixtures';
import type { NotificationPermissionsStatus } from 'expo-notifications/build/NotificationPermissions.types';

type Dialog = Parameters<ReturnType<typeof useAppDialog>['showDialog']>[0];
const { enableLocalReminders, inspectReminderPermission, queueAppReminderReconciliation } = notifications;
const mockDialog = { confirm: jest.fn(), showDialog: jest.fn(), showSuccess: jest.fn() };
const mockNavigation = { addListener: jest.fn(() => () => {}), isFocused: () => true, goBack: jest.fn(), navigate: jest.fn() };
const mockData: Partial<ReturnType<typeof useAppData>> = {};
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('@react-navigation/native', () => ({ DefaultTheme: { colors: {} }, useNavigation: () => mockNavigation, useIsFocused: () => true }));
jest.mock('@react-navigation/material-top-tabs', () => ({ createMaterialTopTabNavigator: () => ({}) }));
jest.mock('@react-navigation/stack', () => ({ createStackNavigator: () => ({}) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../hooks/useAppData', () => ({ useAppData: () => mockData }));
jest.mock('../components/dialogs/AppDialogProvider', () => ({ useAppDialog: () => mockDialog }));
jest.mock('../hooks/useConfirmOutflow', () => ({ useConfirmOutflow: () => async () => true }));
let harness: Awaited<ReturnType<typeof reminderDatabase>>; let view: ReactTestRenderer | undefined;
let permission: NotificationPermissionsStatus; let requestResult: NotificationPermissionsStatus;
let blocked = false; let unavailable = false; let enablingFailure = false;
let pending: { identifier: string; content: { data?: Record<string, unknown> } }[];
function status(state: 'granted' | 'denied' | 'undetermined', canAskAgain = false): NotificationPermissionsStatus { return { status: state, granted: state === 'granted', canAskAgain, expires: 'never' } as NotificationPermissionsStatus; }
beforeEach(async () => {
  jest.clearAllMocks(); jest.useFakeTimers().setSystemTime(new Date(2026, 9, 8, 8)); jest.replaceProperty(Platform, 'OS', 'android');
  jest.spyOn(console, 'warn').mockImplementation(() => {}); jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
  harness = await reminderDatabase(); await repo.setSetting(harness.db, 'setup_complete', 'true'); await repo.setSetting(harness.db, 'notifications_intro_answered', 'true');
  permission = status('granted'); requestResult = status('granted'); blocked = unavailable = enablingFailure = false; pending = [];
  jest.spyOn(localNotificationApi, 'getPermissionsAsync').mockImplementation(async () => { if (unavailable) throw new Error("Cannot find native module 'ExpoNotificationPermissionsModule'"); return permission; });
  jest.spyOn(localNotificationApi, 'requestPermissionsAsync').mockImplementation(async () => { if (enablingFailure) throw new Error('Permission request failed'); permission = requestResult; return permission; });
  jest.spyOn(localNotificationApi, 'getNotificationChannelAsync').mockImplementation(async () => ({ id: 'financial-reminders-alert', importance: blocked ? localNotificationApi.AndroidImportance.NONE : localNotificationApi.AndroidImportance.DEFAULT }) as never);
  jest.spyOn(localNotificationApi, 'setNotificationChannelAsync').mockImplementation(async () => blocked ? { importance: localNotificationApi.AndroidImportance.NONE } as never : null);
  jest.spyOn(localNotificationApi, 'getAllScheduledNotificationsAsync').mockImplementation(async () => pending as never);
  jest.spyOn(localNotificationApi, 'scheduleNotificationAsync').mockImplementation(async input => { const identifier = input.identifier!; pending.push({ identifier, content: { data: input.content.data } }); return identifier; });
  jest.spyOn(localNotificationApi, 'cancelScheduledNotificationAsync').mockImplementation(async id => { pending = pending.filter(p => p.identifier !== id); });
  mockData.db = harness.db; mockData.repo = repo; mockData.categories = await repo.listCategories(harness.db); mockData.accounts = await repo.listAccounts(harness.db); mockData.settings = await repo.getSettings(harness.db); mockData.plannedPayments = []; mockData.subscriptions = [];
  mockData.refresh = async () => { mockData.settings = await repo.getSettings(harness.db); mockData.plannedPayments = await repo.listPlannedPayments(harness.db); mockData.subscriptions = await repo.listSubscriptions(harness.db); await queueAppReminderReconciliation(harness.db); };
  mockDialog.confirm.mockResolvedValue(true);
});
afterEach(async () => { if (view) await act(async () => view!.unmount()); view = undefined; harness.close(); jest.restoreAllMocks(); jest.useRealTimers(); });
const field = (label: string) => view!.root.findAllByType(TextField).find(n => n.props.label === label)!;
const picker = (label: string) => view!.root.findAllByType(Picker).find(n => n.props.label === label)!;
const primary = (label: string) => view!.root.findAllByType(PrimaryButton).find(n => n.props.title === label)!;
const secondary = (label: string) => view!.root.findAllByType(SecondaryButton).find(n => n.props.title === label)!;
async function enter(label: string, value: string) { await act(async () => field(label).props.onChangeText(value)); }
function warning() { return mockDialog.showDialog.mock.calls.map(c => c[0] as Dialog).filter(d => d.title === 'Reminders are turned off').at(-1)!; }
async function choose(text: string, d: Dialog = warning()) { const action = d.actions!.find(a => a.text === text)!; await act(async () => { await action.onPress?.(); }); }
async function createForm(subscription = false, income = false) {
  await act(async () => { view = create(createElement(subscription ? AddSubscriptionScreen : AddPlannedPaymentScreen, { navigation: mockNavigation })); });
  await enter('Name', subscription ? 'Follow-up Netflix' : income ? 'Follow-up Salary' : 'Follow-up Internet'); await enter('Amount', '200'); await enter(subscription ? 'Start date' : 'Next Date', '08-11-2026');
  if (income) await act(async () => picker('Type').props.setValue('INCOME'));
}
async function select(enabled = '1', days = '3') {
  await act(async () => picker('Reminder').props.setValue(enabled));
  if (enabled === '1' && !warning()) await act(async () => picker('Remind me').props.setValue(days));
}

test('Planned 3-day selection warns immediately despite onboarding Not Now; Save Without preserves offset and saves once', async () => {
  await createForm(); await select(); const d = warning(); expect(d.message).toContain('Follow-up Internet'); expect(d.message).toContain('setting is Off');
  expect(d.actionLayout).toBe('stacked');
  expect(d.actions?.map(a => [a.text, a.variant])).toEqual([['Enable Notifications', 'primary'], ['Save Without Notifications', 'secondary']]);
  await act(async () => { await d.actions![1].onPress?.(); await d.actions![1].onPress?.(); });
  expect(await repo.listPlannedPayments(harness.db)).toMatchObject([{ name: 'Follow-up Internet', reminder_enabled: 1, reminder_days_before: 3, amount_minor: 20000, next_due_date: '2026-11-08' }]);
  expect((await repo.getSettings(harness.db)).notifications_enabled).toBe('false'); expect(localNotificationApi.requestPermissionsAsync).not.toHaveBeenCalled(); expect(pending).toEqual([]); expect(mockNavigation.goBack).toHaveBeenCalledTimes(1); expect(await repo.listTransactions(harness.db)).toEqual([]);
  await enableLocalReminders(harness.db); expect(pending).toHaveLength(1); await queueAppReminderReconciliation(harness.db); expect(pending).toHaveLength(1);
});
test('Subscription selected offset saves normally without notifications and never repeats warning on unchanged Save', async () => {
  await createForm(true); await act(async () => picker('Remind me').props.setValue('1')); expect(warning().message).toContain('subscription can still be saved');
  await choose('Save Without Notifications'); expect(await repo.listSubscriptions(harness.db)).toMatchObject([{ reminder_enabled: 1, reminder_days_before: 1, frequency_type: 'MONTHLY', start_date: '2026-11-08' }]); expect(await repo.listTransactions(harness.db)).toEqual([]); expect(pending).toEqual([]); expect(mockDialog.showDialog.mock.calls.filter(c => c[0].title === 'Reminders are turned off')).toHaveLength(1);
});
test.each(['denied-requestable', 'denied-permanent', 'channel', 'unavailable'] as const)('On preference with %s delivery state warns, rather than assuming permission granted', async state => {
  await repo.setSetting(harness.db, 'notifications_enabled', 'true');
  if (state.startsWith('denied')) permission = status('denied', state === 'denied-requestable'); if (state === 'channel') blocked = true; if (state === 'unavailable') unavailable = true;
  await createForm(true); await act(async () => picker('Remind me').props.setValue('1'));
  expect(warning()).toBeTruthy(); expect(warning().message).toContain(state === 'channel' ? 'channel is blocked' : state === 'unavailable' ? 'module unavailable' : state === 'denied-permanent' ? 'open device Settings' : 'not allowed yet');
});
test.each([false, true])('Off selection and operational delivery (enabled=%s) do not warn', async enabled => {
  if (enabled) await repo.setSetting(harness.db, 'notifications_enabled', 'true'); await createForm(); await select(enabled ? '1' : '0'); expect(warning()).toBeUndefined();
});
test('expected income warning is income-aware and preserves draft on Android Back/dismissal', async () => {
  await createForm(false, true); await select(); const d = warning(); expect(d.message).toContain('expected income reminder for Follow-up Salary'); expect(d.message).toContain('planned income can still be saved');
  await act(async () => d.onCancel?.()); expect(field('Name').props.value).toBe('Follow-up Salary'); expect(field('Amount').props.value).toBe('200'); expect(picker('Reminder').props.value).toBe('1'); expect(await repo.listPlannedPayments(harness.db)).toEqual([]);
  await act(async () => primary('Save Planned Payment').props.onPress()); expect(mockDialog.showDialog.mock.calls.filter(c => c[0].title === d.title)).toHaveLength(1);
});
test('Enable requests once when appropriate, retains all fields and schedules only after explicit form Save', async () => {
  permission = status('undetermined', true); await createForm(); await select(); const d = warning();
  await act(async () => { const first = d.actions![0].onPress?.(); await d.actions![0].onPress?.(); await first; });
  expect(localNotificationApi.requestPermissionsAsync).toHaveBeenCalledTimes(1); expect(mockDialog.showSuccess).toHaveBeenCalledWith('Notifications enabled'); expect(field('Name').props.value).toBe('Follow-up Internet'); expect(field('Amount').props.value).toBe('200'); expect(picker('Remind me').props.value).toBe('3'); expect(await repo.listPlannedPayments(harness.db)).toEqual([]);
  await act(async () => primary('Save Planned Payment').props.onPress()); expect(pending).toHaveLength(1); expect(await repo.listPlannedPayments(harness.db)).toHaveLength(1); expect(mockDialog.showDialog.mock.calls.filter(c => c[0].title === d.title)).toHaveLength(1);
});
test('already-granted Enable does not request OS permission again', async () => {
  await createForm(true); await act(async () => picker('Remind me').props.setValue('2')); await choose('Enable Notifications'); expect(localNotificationApi.requestPermissionsAsync).not.toHaveBeenCalled(); expect((await repo.getSettings(harness.db)).notifications_enabled).toBe('true'); expect(field('Name').props.value).toBe('Follow-up Netflix');
});
test.each(['denied', 'permanent', 'channel', 'error'] as const)('Enable %s failure is nonfatal, never claims success and allows continuing with preserved fields', async failure => {
  permission = status('denied', failure !== 'permanent'); requestResult = status('denied', false); if (failure === 'channel') { permission = status('granted'); blocked = true; } if (failure === 'error') enablingFailure = true;
  await createForm(true); await act(async () => picker('Remind me').props.setValue('2')); await choose('Enable Notifications');
  expect(mockDialog.showSuccess).not.toHaveBeenCalledWith('Notifications enabled'); const explanation = mockDialog.showDialog.mock.calls.at(-1)![0] as Dialog;
  if (failure === 'channel') expect(explanation.message).toContain('channel is blocked'); else if (failure !== 'error') expect(explanation.message).toBe('Notifications are blocked in Android settings. Open your device settings to allow payment reminders.');
  expect(field('Name').props.value).toBe('Follow-up Netflix'); expect(field('Amount').props.value).toBe('200'); expect(picker('Remind me').props.value).toBe('2'); await choose('Continue Without Notifications', explanation); expect(await repo.listSubscriptions(harness.db)).toHaveLength(1); expect(pending).toEqual([]);
});
test('blocked permission device-settings action preserves unsaved data and the latest state recovers on return', async () => {
  permission = status('denied', false); await createForm(); await select(); await choose('Enable Notifications'); const d = mockDialog.showDialog.mock.calls.at(-1)![0] as Dialog;
  await choose('Open Device Settings', d); expect(Linking.openSettings).toHaveBeenCalledTimes(1); expect(field('Name').props.value).toBe('Follow-up Internet'); expect(await repo.listPlannedPayments(harness.db)).toEqual([]);
  permission = status('granted'); await inspectReminderPermission(); await act(async () => picker('Remind me').props.setValue('1')); await choose('Enable Notifications'); expect(localNotificationApi.requestPermissionsAsync).not.toHaveBeenCalled();
});
test.each(['planned', 'subscription'] as const)('%s edit does not warn on open/unrelated edits, but deliberate reminder changes warn again', async kind => {
  const original = kind === 'planned' ? await reminderPlan(harness.db) : await reminderSubscription(harness.db);
  await mockData.refresh!(); mockDialog.showDialog.mockClear();
  await act(async () => { view = create(createElement(kind === 'planned' ? PlannedPaymentDetailScreen : SubscriptionDetailScreen, { navigation: mockNavigation, route: { params: kind === 'planned' ? { plannedPaymentId: original.id } : { subscriptionId: original.id } } })); });
  await act(async () => secondary('Edit').props.onPress()); await enter('Note', 'Unrelated draft note'); expect(warning()).toBeUndefined();
  if (kind === 'planned') await act(async () => picker('Remind me').props.setValue('1')); else { await enter('Reminder days before', '1'); await act(async () => field('Reminder days before').props.onBlur()); }
  expect(warning()).toBeTruthy(); await act(async () => warning().onCancel?.()); await enter('Name', 'Name stays unsaved'); expect(mockDialog.showDialog.mock.calls.filter(c => c[0].title === 'Reminders are turned off')).toHaveLength(1);
  if (kind === 'planned') await act(async () => picker('Remind me').props.setValue('2')); else { await enter('Reminder days before', '2'); await act(async () => field('Reminder days before').props.onBlur()); }
  expect(mockDialog.showDialog.mock.calls.filter(c => c[0].title === 'Reminders are turned off')).toHaveLength(2); await choose('Save Without Notifications');
  const saved = kind === 'planned' ? await repo.getPlannedPayment(harness.db, original.id) : await repo.getSubscription(harness.db, original.id); expect(saved).toMatchObject({ name: 'Name stays unsaved', note: 'Unrelated draft note', reminder_days_before: 2, amount_minor: original.amount_minor, schedule_provenance: original.schedule_provenance }); expect(await repo.listTransactions(harness.db)).toEqual([]);
});
test('Save-time default Subscription reminder safety check saves once through the waiting submit lock', async () => {
  await createForm(true); let save!: Promise<void>; await act(async () => { save = primary('Save Subscription').props.onPress(); }); expect(warning()).toBeTruthy(); await choose('Save Without Notifications'); await act(async () => { await save; }); expect(await repo.listSubscriptions(harness.db)).toHaveLength(1); expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
});
test('device-like channel ERR_UNEXPECTED preserves the Planned edit draft and reports failure before any permission request', async () => {
  const p = await reminderPlan(harness.db, { name: 'Duplicate Record Test' }); await mockData.refresh!();
  await act(async () => { view = create(createElement(PlannedPaymentDetailScreen, { navigation: mockNavigation, route: { params: { plannedPaymentId: p.id } } })); });
  await act(async () => secondary('Edit').props.onPress()); await enter('Note', 'Unsaved note');
  await act(async () => picker('Remind me').props.setValue('3'));
  jest.mocked(localNotificationApi.setNotificationChannelAsync).mockRejectedValue(Object.assign(new Error('java.lang.IllegalStateException: channel initialization failed'), { code: 'ERR_UNEXPECTED' }));
  await choose('Enable Notifications');
  expect(field('Name').props.value).toBe('Duplicate Record Test'); expect(field('Note').props.value).toBe('Unsaved note'); expect(field('Amount').props.value).toBe('200.00'); expect(picker('Remind me').props.value).toBe('3');
  expect(localNotificationApi.requestPermissionsAsync).not.toHaveBeenCalled(); expect(mockDialog.showSuccess).not.toHaveBeenCalledWith('Notifications enabled');
  expect((mockDialog.showDialog.mock.calls.at(-1)![0] as Dialog).message).toContain('channel could not be prepared');
  expect((await repo.getPlannedPayment(harness.db, p.id))?.note).toBeNull(); expect((await repo.getSettings(harness.db)).notifications_enabled).toBe('false');
  expect(JSON.stringify(jest.mocked(console.warn).mock.calls)).not.toContain('Duplicate Record Test'); expect(JSON.stringify(jest.mocked(console.warn).mock.calls)).not.toContain('Unsaved note');
});
test('an asynchronous stale availability result cannot warn after selecting Off', async () => {
  await createForm(); let resolve!: (value: Awaited<ReturnType<typeof notifications.readReminderDelivery>>) => void;
  jest.spyOn(notifications, 'readReminderDelivery').mockReturnValue(new Promise(done => { resolve = done; }));
  await act(async () => picker('Reminder').props.setValue('1')); await act(async () => picker('Reminder').props.setValue('0'));
  await act(async () => resolve({ enabled: false, status: { permission: 'granted', canAskAgain: false, scheduling: 'available' } }));
  expect(warning()).toBeUndefined(); expect(picker('Reminder').props.value).toBe('0');
});
test('Save while the availability query is pending waits for one warning and commits only once', async () => {
  await createForm(); let resolve!: (value: Awaited<ReturnType<typeof notifications.readReminderDelivery>>) => void;
  jest.spyOn(notifications, 'readReminderDelivery').mockReturnValueOnce(new Promise(done => { resolve = done; }));
  await act(async () => picker('Reminder').props.setValue('1'));
  let save!: Promise<void>; await act(async () => { save = primary('Save Planned Payment').props.onPress(); });
  await act(async () => resolve({ enabled: false, status: { permission: 'granted', canAskAgain: false, scheduling: 'available' } }));
  await choose('Save Without Notifications'); await act(async () => { await save; });
  expect(await repo.listPlannedPayments(harness.db)).toHaveLength(1); expect(mockNavigation.goBack).toHaveBeenCalledTimes(1); expect(mockDialog.showDialog.mock.calls.filter(c => c[0].title === 'Reminders are turned off')).toHaveLength(1);
});
test.each(['planned', 'subscription'] as const)('saving unrelated %s edits without a reminder interaction does not warn or alter existing history', async kind => {
  const original = kind === 'planned' ? await reminderPlan(harness.db, { recurrence_type: 'EVERY_N_DAYS', recurrence_interval: 23 }) : await reminderSubscription(harness.db, { frequency_type: 'EVERY_N_DAYS', frequency_interval: 23 });
  if (kind === 'planned') await repo.markPlannedPaymentPaid(harness.db, original.id, '2026-10-20'); else await repo.markSubscriptionPaid(harness.db, original.id, '2026-10-20', original.updated_at);
  const transactions = await repo.listTransactions(harness.db); const history = kind === 'planned' ? await repo.listPlannedPaymentOccurrences(harness.db, original.id) : await repo.listSubscriptionPayments(harness.db, original.id);
  await mockData.refresh!(); await act(async () => { view = create(createElement(kind === 'planned' ? PlannedPaymentDetailScreen : SubscriptionDetailScreen, { navigation: mockNavigation, route: { params: kind === 'planned' ? { plannedPaymentId: original.id } : { subscriptionId: original.id } } })); });
  await act(async () => secondary('Edit').props.onPress()); if (kind === 'subscription') await act(async () => field('Reminder days before').props.onBlur());
  await enter('Note', 'Only the note changes'); await act(async () => primary('Save Changes').props.onPress()); expect(warning()).toBeUndefined();
  expect(await repo.listTransactions(harness.db)).toEqual(transactions); expect(kind === 'planned' ? await repo.listPlannedPaymentOccurrences(harness.db, original.id) : await repo.listSubscriptionPayments(harness.db, original.id)).toEqual(history);
});

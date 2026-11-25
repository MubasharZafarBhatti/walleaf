import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { AppState, FlatList, Text } from 'react-native';
import { ActivityDetailScreen, ActivityListScreen } from '../navigation/ActivityScreens';
import { AboutScreen, getHomeGreeting, getHomeGreetingCopy, HomeScreen, mainTabSceneStyle } from '../navigation/AppNavigator';
import appConfig from '../../app.json';
import { Card, ListRow, MoneyText, PrimaryButton, SecondaryButton, TextField } from '../components/common';
import { Picker } from '../components/forms';
import { listActivity, ordinaryReadOnlyReason, readSharedEvent, type ActivityRow } from '../services/activity/ActivityService';
import { deleteSharedExpense, sharedReadOnlyReason } from '../services/sharedExpense/SharedExpenseService';
import { deleteTransaction } from '../services/finance/TransactionService';
import { deleteRecordedPayment, readRecordedPaymentDeletion, type RecordedPaymentDeletion } from '../services/planned/RecordedPaymentService';

const mockNavigation = { addListener: jest.fn(() => () => {}), isFocused: () => true, goBack: jest.fn(), navigate: jest.fn() };
const mockDialog = { confirm: jest.fn(), showDialog: jest.fn(), showSuccess: jest.fn() };
const mockConfirmChange = jest.fn();
let mockFocused = true;
const tx = { id: 'tx', title: 'Dinner', type: 'EXPENSE', amount_minor: 1000, account_id: 'cash', category_id: 'food', occurred_on: '2026-09-12', updated_at: '2026-09-12T00:00:00.000Z', source: 'MANUAL' };
const mockData = {
  db: { getFirstAsync: jest.fn(), getAllAsync: jest.fn() }, refresh: jest.fn(), setSetting: jest.fn(), transactions: [], entries: [],
  accounts: [{ id: 'cash', name: 'Cash' }], categories: [{ id: 'food', name: 'Food' }], people: [{ id: 'ali', name: 'Ali' }], groups: [], budgets: [], settings: { currency: 'PKR', week_start: 'MONDAY', user_name: 'Mubashar' } as { currency: string; week_start: string; user_name: string; activity_sort_order?: string },
};
jest.mock('@react-navigation/native', () => ({ DefaultTheme: { colors: {} }, NavigationContainer: 'NavigationContainer', useNavigation: () => mockNavigation, useIsFocused: () => mockFocused }));
jest.mock('@react-navigation/material-top-tabs', () => ({ createMaterialTopTabNavigator: () => ({ Navigator: 'Tabs', Screen: 'Tab' }) }));
jest.mock('@react-navigation/stack', () => ({ createStackNavigator: () => ({ Navigator: 'Stack', Screen: 'StackScreen' }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../hooks/useAppData', () => ({ useAppData: () => mockData }));
jest.mock('../components/dialogs/AppDialogProvider', () => ({ useAppDialog: () => mockDialog }));
jest.mock('../hooks/useConfirmOutflow', () => ({ useConfirmActivityChange: () => mockConfirmChange }));
jest.mock('../services/activity/ActivityService', () => ({ ...jest.requireActual('../services/activity/ActivityService'), listActivity: jest.fn(), ordinaryReadOnlyReason: jest.fn(), readSharedEvent: jest.fn() }));
jest.mock('../services/sharedExpense/SharedExpenseService', () => ({ sharedReadOnlyReason: jest.fn(), deleteSharedExpense: jest.fn() }));
jest.mock('../services/finance/TransactionService', () => ({ deleteTransaction: jest.fn() }));
jest.mock('../services/planned/RecordedPaymentService', () => ({ readRecordedPaymentDeletion: jest.fn(), deleteRecordedPayment: jest.fn() }));

const row = { id: 'transaction:tx', kind: 'transaction', source_id: 'tx', type: 'EXPENSE', title: 'Dinner', amount_minor: 1000, occurred_on: '2026-09-12', account_name: 'Cash', category_name: 'Food', note: 'Friends' } as ActivityRow;
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  jest.resetAllMocks();
  mockFocused = true;
  mockData.settings.user_name = 'Mubashar';
  delete mockData.settings.activity_sort_order;
  mockData.setSetting.mockResolvedValue(undefined);
  mockData.transactions = [];
  mockData.entries = [];
  mockData.groups = [];
  mockData.budgets = [];
  mockNavigation.addListener.mockReturnValue(() => {});
  mockData.db.getFirstAsync.mockResolvedValue(tx);
  mockData.refresh.mockResolvedValue(undefined);
  mockDialog.confirm.mockResolvedValue(true);
  mockConfirmChange.mockResolvedValue(true);
  jest.mocked(listActivity).mockResolvedValue([row]);
  jest.mocked(ordinaryReadOnlyReason).mockResolvedValue(null);
  jest.mocked(deleteTransaction).mockResolvedValue(undefined);
  jest.mocked(sharedReadOnlyReason).mockResolvedValue(null);
  jest.mocked(deleteSharedExpense).mockResolvedValue(undefined);
  jest.mocked(readRecordedPaymentDeletion).mockRejectedValue(new Error('Unlinked history'));
  jest.mocked(deleteRecordedPayment).mockResolvedValue(undefined);
});
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; });

async function detail(kind = 'transaction') {
  await act(async () => { renderer = create(createElement(ActivityDetailScreen, { navigation: mockNavigation, route: { params: { kind, sourceId: 'tx' } } })); });
}

test.each(['PLANNED', 'SUBSCRIPTION'] as const)('%s recorded detail permits only guarded deletion and keeps source navigation', async source => {
  const deletion = { transaction: { ...tx, source }, source, sourceId: 'source', occurrenceId: 'occurrence', parentVersion: 'version', scheduledDate: '2026-09-12', nextDate: '2026-09-12', scheduleRestored: true, explanation: 'Saved schedule rebuilt; tracking status unchanged.' } as RecordedPaymentDeletion;
  mockData.db.getFirstAsync.mockResolvedValueOnce(deletion.transaction).mockResolvedValueOnce({ subscription_id: 'source' });
  jest.mocked(ordinaryReadOnlyReason).mockResolvedValue('Recorded history');
  jest.mocked(readRecordedPaymentDeletion).mockResolvedValue(deletion);
  await detail();
  expect(renderer!.root.findAllByType(PrimaryButton)).toHaveLength(0);
  const remove = renderer!.root.findAllByType(SecondaryButton).find(n => n.props.title === 'Delete Transaction')!;
  let resolve!: (value: boolean) => void; mockDialog.confirm.mockReturnValueOnce(new Promise<boolean>(done => { resolve = done; }));
  let first!: Promise<void>; await act(async () => { first = remove.props.onPress(); await remove.props.onPress(); });
  expect(jest.mocked(deleteRecordedPayment)).not.toHaveBeenCalled();
  expect(mockDialog.confirm).toHaveBeenCalledTimes(1); expect(mockDialog.confirm.mock.calls[0][0].message).toContain('restores');
  await act(async () => { resolve(true); await first; });
  expect(deleteRecordedPayment).toHaveBeenCalledTimes(1); expect(deleteRecordedPayment).toHaveBeenCalledWith(mockData.db, deletion); expect(deleteTransaction).not.toHaveBeenCalled(); expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
  if (source === 'SUBSCRIPTION') expect(renderer!.root.findAllByType(SecondaryButton).some(n => n.props.title === 'View Subscription')).toBe(true);
});

test.each(['cancel', 'failure', 'income'] as const)('recorded payment %s confirmation preserves records/input or explains income reversal', async scenario => {
  const deletion = { transaction: { ...tx, type: scenario === 'income' ? 'INCOME' : 'EXPENSE', source: 'PLANNED' }, source: 'PLANNED', sourceId: 'source', occurrenceId: 'occurrence', parentVersion: 'version', scheduledDate: '2026-09-12', nextDate: '2026-10-12', scheduleRestored: false, explanation: 'Current next date kept because original schedule unavailable.' } as RecordedPaymentDeletion;
  mockData.db.getFirstAsync.mockResolvedValue(deletion.transaction); jest.mocked(readRecordedPaymentDeletion).mockResolvedValue(deletion); jest.mocked(ordinaryReadOnlyReason).mockResolvedValue('Recorded history');
  if (scenario === 'cancel') mockDialog.confirm.mockResolvedValue(false);
  if (scenario === 'failure') jest.mocked(deleteRecordedPayment).mockRejectedValue(new Error('Write failed; records kept'));
  await detail(); await act(async () => renderer!.root.findAllByType(SecondaryButton).find(n => n.props.title === 'Delete Transaction')!.props.onPress());
  expect(mockDialog.confirm.mock.calls[0][0].message).toContain('Current next date kept');
  if (scenario === 'income') expect(mockDialog.confirm.mock.calls[0][0].message).toContain('deducts');
  else { expect(mockNavigation.goBack).not.toHaveBeenCalled(); expect(mockData.refresh).not.toHaveBeenCalled(); }
  if (scenario === 'cancel') expect(deleteRecordedPayment).not.toHaveBeenCalled();
  if (scenario === 'failure') expect(mockDialog.showDialog).toHaveBeenCalledWith({ title: 'Could not delete', message: 'Write failed; records kept' });
});

test('Home and Transactions render the canonical account/reason adjustment subtitle', async () => {
  const adjustment = { ...row, type: 'ADJUSTMENT', title: 'Balance adjustment', label: 'Balance adjustment', account_name: 'HBL', note: 'Bank reconciliation' } as ActivityRow;
  jest.mocked(listActivity).mockResolvedValue([adjustment]);
  await act(async () => { renderer = create(createElement(HomeScreen, { navigation: mockNavigation })); });
  const home = renderer!.root.findAllByType(ListRow).find((node) => node.props.title === 'Balance adjustment')!;
  expect(home.props.subtitle).toContain('HBL · Bank reconciliation ·');
  expect(home.props.subtitle).not.toContain('Balance adjustment');
  await act(async () => renderer!.unmount());
  await act(async () => { renderer = create(createElement(ActivityListScreen, { navigation: mockNavigation })); });
  const list = renderer!.root.findByType(FlatList);
  expect(list.props.renderItem({ item: adjustment }).props.subtitle).toContain('HBL · Bank reconciliation ·');
});

test('About displays actual config version/build and concise local-first privacy copy', async () => {
  await act(async () => { renderer = create(createElement(AboutScreen)); });
  const text = renderer!.root.findAllByType(Text).map((node) => node.props.children).flat(Infinity).join('');
  expect(text).toContain(`Version ${appConfig.expo.version}`);
  expect(text).not.toMatch(/Development|Senior Demo/);
  expect(text).toContain(`Android build ${appConfig.expo.android.versionCode}`);
  expect(text).toContain('Your data stays on this device unless you export a backup.');
  expect(text).not.toContain('No authentication');
});

test('financial detail retains a left type label and centered wrapping summary/description/note', async () => {
  jest.mocked(listActivity).mockResolvedValueOnce([{ ...row, label: 'Expense', source: 'MANUAL', note: 'I forgot, but it was 15k not 10k' }]);
  await detail();
  const card = renderer!.root.findByType(Card);
  expect(card.findAllByType(Text).find((n) => n.props.children === 'Expense')!.props.style.textAlign).not.toBe('center');
  expect(card.findByType(MoneyText).props.style.textAlign).toBe('center');
  expect(card.findAllByType(Text).find((n) => n.props.children === row.title)!.props.style.textAlign).toBe('center');
  const note = card.findAllByType(Text).find((n) => Array.isArray(n.props.children) && n.props.children.includes('I forgot, but it was 15k not 10k'))!;
  expect(note.props.style.textAlign).toBe('center');
  expect(note.props.numberOfLines).toBeUndefined();
});

test('Activity filters send SQL filter state; custom From/To reuse actual calendar fields', async () => {
  await act(async () => { renderer = create(createElement(ActivityListScreen, { navigation: mockNavigation })); });
  const picker = (label: string) => renderer!.root.findAllByType(Picker).find((node) => node.props.label === label)!;
  // Type and Date range are inside the Filter panel.
  await act(async () => renderer!.root.findAll((node) => node.props.accessibilityLabel === 'Filter' && typeof node.props.onPress === 'function')[0].props.onPress());
  await act(async () => picker('Type').props.setValue('SHARED'));
  expect(listActivity).toHaveBeenLastCalledWith(mockData.db, expect.objectContaining({ type: 'SHARED' }));
  await act(async () => picker('Date range').props.setValue('CUSTOM'));
  const dates = renderer!.root.findAllByType(TextField).filter((node) => ['From', 'To'].includes(node.props.label));
  expect(dates).toHaveLength(2);
  expect(dates.every((node) => node.props.placeholder === 'DD-MM-YYYY')).toBe(true);
  await act(async () => picker('Person').props.setValue('ali')); // same open panel
  expect(listActivity).toHaveBeenLastCalledWith(mockData.db, expect.objectContaining({ personId: 'ali', range: 'CUSTOM' }));
});

test('true initial Transactions load shows one loading state without a native refresh spinner', async () => {
  jest.mocked(listActivity).mockImplementationOnce(() => new Promise(() => {}));
  await act(async () => { renderer = create(createElement(ActivityListScreen, { navigation: mockNavigation })); });
  const list = renderer!.root.findByType(FlatList);
  expect(list.props.data).toEqual([]);
  expect(list.props.refreshing).toBe(false);
  expect(list.props.showsVerticalScrollIndicator).toBe(false);
  expect(list.props.scrollEnabled).not.toBe(false);
  expect(list.props.contentContainerStyle).toEqual(expect.objectContaining({ paddingBottom: expect.any(Number) }));
  // Rows are full-width cards with their own inner padding, so the list itself needs no side inset.
  expect(renderer!.root.findAllByType(Text).filter((node) => node.props.children === 'Loading activity...')).toHaveLength(1);
});

test('material tab scenes clip native children while retaining pager animation', () => {
  expect(mainTabSceneStyle).toMatchObject({ overflow: 'hidden' });
});

test('ordinary detail opens existing edit form with its saved snapshot', async () => {
  await detail();
  await act(async () => renderer!.root.findByType(PrimaryButton).props.onPress());
  expect(mockNavigation.navigate).toHaveBeenCalledWith('TransactionForm', { transaction: tx });
  expect(listActivity).toHaveBeenCalledWith(mockData.db, { activityId: 'transaction:tx' });
});

test('Activity links back to a subscription only through its verified payment identity', async () => {
  jest.mocked(listActivity).mockResolvedValue([{ ...row, source: 'SUBSCRIPTION' }]);
  jest.mocked(ordinaryReadOnlyReason).mockResolvedValue('Recorded subscription expenses are read-only.');
  mockData.db.getFirstAsync.mockResolvedValueOnce({ ...tx, source: 'SUBSCRIPTION', financial_event_id: 'payment' }).mockResolvedValueOnce({ subscription_id: 'sub' });
  await detail();
  expect(mockData.db.getFirstAsync).toHaveBeenLastCalledWith('SELECT subscription_id FROM subscription_payments WHERE transaction_id = ? AND id = ?;', 'tx', 'payment');
  const link = renderer!.root.findAllByType(SecondaryButton).find((node) => node.props.title === 'View Subscription')!;
  await act(async () => link.props.onPress());
  expect(mockNavigation.navigate).toHaveBeenCalledWith('SubscriptionDetail', { subscriptionId: 'sub' });
  expect(renderer!.root.findAllByType(PrimaryButton)).toHaveLength(0);
});

test('unlinked legacy subscription Activity never guesses its parent from the title', async () => {
  jest.mocked(listActivity).mockResolvedValue([{ ...row, source: 'SUBSCRIPTION' }]);
  jest.mocked(ordinaryReadOnlyReason).mockResolvedValue('Read-only subscription history.');
  mockData.db.getFirstAsync.mockResolvedValueOnce({ ...tx, source: 'SUBSCRIPTION' }).mockResolvedValueOnce(null);
  await detail();
  expect(renderer!.root.findAllByType(SecondaryButton)).toHaveLength(0);
  expect(outputHasSubscriptionLabel()).toBe(true);
});

function outputHasSubscriptionLabel() { return JSON.stringify(renderer!.toJSON()).includes('Subscription payment'); }

test('ambiguous shared detail explains read-only state and exposes no edit/delete', async () => {
  jest.mocked(listActivity).mockResolvedValue([{ ...row, kind: 'shared' }]);
  jest.mocked(readSharedEvent).mockResolvedValue({ split: { ...tx, payer_is_self: 1 }, participants: [], transactions: [], entries: [] } as any);
  jest.mocked(sharedReadOnlyReason).mockResolvedValue('Older activity is read-only.');
  await detail('shared');
  expect(renderer!.root.findAllByType(PrimaryButton)).toHaveLength(0);
  expect(renderer!.root.findAllByType(SecondaryButton)).toHaveLength(0);
  expect(JSON.stringify(renderer!.toJSON())).toContain('read-only');
  expect(deleteSharedExpense).not.toHaveBeenCalled();
});

test('manual People detail is readable without unsafe mutation buttons', async () => {
  jest.mocked(listActivity).mockResolvedValue([{ ...row, kind: 'person', label: 'Received back', person_name: 'Ali' }]);
  await detail('person');
  expect(JSON.stringify(renderer!.toJSON())).toContain('Received');
  expect(renderer!.root.findAllByType(PrimaryButton)).toHaveLength(0);
  expect(renderer!.root.findAllByType(SecondaryButton)).toHaveLength(0);
});

test('two delete taps across an awaited confirmation commit once, then refresh and leave', async () => {
  let release!: (value: boolean) => void;
  mockDialog.confirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = resolve; }));
  await detail();
  const remove = renderer!.root.findByType(SecondaryButton).props.onPress;
  let first!: Promise<void>;
  await act(async () => { first = remove(); await remove(); });
  expect(mockDialog.confirm).toHaveBeenCalledTimes(1);
  expect(renderer!.root.findByType(SecondaryButton).props.disabled).toBe(true);
  await act(async () => { release(true); await first; });
  expect(deleteTransaction).toHaveBeenCalledTimes(1);
  expect(deleteTransaction).toHaveBeenCalledWith(mockData.db, tx.id, tx.updated_at);
  expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
  expect(mockData.refresh).toHaveBeenCalledTimes(1);
  expect(mockDialog.showSuccess).toHaveBeenCalledWith('Activity deleted');
});

test('cancelled delete leaves detail and database untouched', async () => {
  mockDialog.confirm.mockResolvedValue(false);
  await detail();
  await act(async () => renderer!.root.findByType(SecondaryButton).props.onPress());
  expect(deleteTransaction).not.toHaveBeenCalled();
  expect(mockNavigation.goBack).not.toHaveBeenCalled();
});

test('failed delete keeps detail and shows the service safety explanation', async () => {
  jest.mocked(deleteTransaction).mockRejectedValueOnce(new Error('Activity changed. Reopen it.'));
  await detail();
  await act(async () => renderer!.root.findByType(SecondaryButton).props.onPress());
  expect(mockDialog.showDialog).toHaveBeenCalledWith({ title: 'Could not delete', message: 'Activity changed. Reopen it.' });
  expect(mockNavigation.goBack).not.toHaveBeenCalled();
  expect(mockData.refresh).not.toHaveBeenCalled();
});

async function list() {
  await act(async () => { renderer = create(createElement(ActivityListScreen, { navigation: mockNavigation })); });
}
async function button(title: string) {
  await act(async () => renderer!.root.findAllByType(SecondaryButton).find((node) => node.props.title === title)!.props.onPress());
}
const picker = (label: string) => renderer!.root.findAllByType(Picker).find((node) => node.props.label === label)!;
const text = () => renderer!.root.findAllByType(Text).flatMap((node) => node.props.children).filter((value) => typeof value === 'string' || typeof value === 'number').join(' ');

test('failed activity load offers Retry without exposing database internals', async () => {
  jest.mocked(listActivity).mockRejectedValueOnce(new Error('SQLITE_ERROR internal_record_id'));
  await list();
  expect(text()).toContain('Activity unavailable');
  expect(text()).not.toContain('internal_record_id');
  await button('Retry');
  expect(listActivity).toHaveBeenCalledTimes(2);
  expect(renderer!.root.findByType(FlatList).props.data).toEqual([row]);
});

test('new filters keep old results visible without a loading placeholder and obsolete responses cannot replace newer results', async () => {
  await list();
  let finishOlder!: (value: ActivityRow[]) => void;
  jest.mocked(listActivity).mockImplementationOnce(() => new Promise((resolve) => { finishOlder = resolve; }));
  await button('Filter');
  await act(async () => picker('Type').props.setValue('INCOME'));
  expect(renderer!.root.findByType(FlatList).props.data).toEqual([row]);
  expect(renderer!.root.findByType(FlatList).props.refreshing).toBe(false);
  expect(text()).not.toContain('Loading activity...');
  const latest = { ...row, title: 'New filter result' };
  jest.mocked(listActivity).mockResolvedValueOnce([latest]);
  await act(async () => picker('Type').props.setValue('TRANSFER'));
  await act(async () => finishOlder([{ ...row, title: 'Obsolete result' }]));
  expect(renderer!.root.findByType(FlatList).props.data).toEqual([latest]);
});

test('provider refresh keeps Transactions rows visible and replaces them atomically on success', async () => {
  await list();
  let finish!: (value: ActivityRow[]) => void;
  jest.mocked(listActivity).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  mockData.transactions = [{ ...tx }] as any;
  await act(async () => renderer!.update(createElement(ActivityListScreen, { navigation: mockNavigation })));
  expect(renderer!.root.findByType(FlatList).props.data).toEqual([row]);
  expect(text()).not.toContain('Loading activity...');
  const updated = { ...row, id: 'transaction:updated', source_id: 'updated', title: 'Updated dinner' };
  await act(async () => finish([updated]));
  expect(renderer!.root.findByType(FlatList).props.data).toEqual([updated]);
});

test('provider refresh failure retains the last successful Transactions rows and Retry', async () => {
  await list();
  jest.mocked(listActivity).mockRejectedValueOnce(new Error('read failed'));
  mockData.entries = [{ id: 'changed' }] as any;
  await act(async () => renderer!.update(createElement(ActivityListScreen, { navigation: mockNavigation })));
  expect(renderer!.root.findByType(FlatList).props.data).toEqual([row]);
  expect(text()).not.toContain('Loading activity...');
  expect(text()).toContain('Could not load activity. Please try again.');
  expect(renderer!.root.findAllByType(SecondaryButton).some((node) => node.props.title === 'Retry')).toBe(true);
});

test('Home and Transactions focus changes do not reload or clear the Transactions snapshot', async () => {
  await list();
  expect(listActivity).toHaveBeenCalledTimes(1);
  mockFocused = false;
  await act(async () => renderer!.update(createElement(ActivityListScreen, { navigation: mockNavigation })));
  mockFocused = true;
  await act(async () => renderer!.update(createElement(ActivityListScreen, { navigation: mockNavigation })));
  expect(listActivity).toHaveBeenCalledTimes(1);
  expect(renderer!.root.findByType(FlatList).props.data).toEqual([row]);
  expect(text()).not.toContain('Loading activity...');
});

test('custom range errors prevent SQL reads, remain correctable and are not database-load errors', async () => {
  await list();
  await button('Filter');
  await act(async () => picker('Date range').props.setValue('CUSTOM'));
  const field = (label: string) => renderer!.root.findAllByType(TextField).find((node) => node.props.label === label)!;
  await act(async () => { field('From').props.onChangeText('12-09-2026'); field('To').props.onChangeText('01-09-2026'); });
  expect(text()).toContain('To must be on or after From');
  const count = jest.mocked(listActivity).mock.calls.length;
  expect(renderer!.root.findAllByType(SecondaryButton).some((node) => node.props.title === 'Retry')).toBe(false);
  await act(async () => field('To').props.onChangeText('12-09-2026'));
  expect(listActivity).toHaveBeenCalledTimes(count + 1);
  expect(listActivity).toHaveBeenLastCalledWith(mockData.db, expect.objectContaining({ from: '2026-09-12', to: '2026-09-12' }));
});

test('custom From opens the actual Sage calendar and Today selects through the field', async () => {
  jest.useFakeTimers().setSystemTime(new Date(2026, 8, 12, 12));
  try {
    await list();
    await button('Filter');
    await act(async () => picker('Date range').props.setValue('CUSTOM'));
    await act(async () => renderer!.root.findAll((node) => node.props.accessibilityLabel === 'Change From' && typeof node.props.onPress === 'function')[0].props.onPress());
    const weekdays = renderer!.root.findAllByType(Text).filter((node) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].includes(node.props.children));
    expect(weekdays.slice(0, 7).map((node) => node.props.children)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    await button('Today');
    expect(renderer!.root.findAllByType(TextField).find((node) => node.props.label === 'From')!.props.value).toBe('12-09-2026');
    expect(renderer!.root.findAllByType(SecondaryButton).some((node) => node.props.title === 'Today')).toBe(false);
  } finally { jest.useRealTimers(); }
});

test('collapsed filters display selected names, reopen intact, and clear together', async () => {
  await list();
  await button('Filter');
  await act(async () => { picker('Account').props.setValue('cash'); picker('Category').props.setValue('food'); picker('Person').props.setValue('ali'); });
  await button('Hide filters');
  expect(text()).toContain('Account: Cash | Category: Food | Person: Ali');
  await button('Filter');
  expect(picker('Person').props.value).toBe('ali');
  await button('Clear filters');
  expect(listActivity).toHaveBeenLastCalledWith(mockData.db, expect.objectContaining({ accountId: '', categoryId: '', personId: '', groupId: '', type: 'ALL', range: 'ALL' }));
});

function mockShared() {
  const shared = { split: { ...tx, payer_is_self: 1, title: 'Shared Dinner' }, participants: [{ id: 'participant', is_self: 1, name: 'You', share_minor: 1000 }], transactions: [tx], entries: [] } as any;
  jest.mocked(listActivity).mockResolvedValue([{ ...row, kind: 'shared', source: 'SPLIT' }]);
  jest.mocked(readSharedEvent).mockResolvedValue(shared);
  return shared;
}

test('shared detail opens the existing Split editor and participant rows are not buttons', async () => {
  const shared = mockShared();
  await detail('shared');
  await act(async () => renderer!.root.findByType(PrimaryButton).props.onPress());
  expect(mockNavigation.navigate).toHaveBeenCalledWith('Split', { shared });
  const participant = renderer!.root.findByType(ListRow).findAll((node) => node.props.disabled === true)[0];
  expect(participant.props.accessibilityRole).toBeUndefined();
  expect(participant.props.disabled).toBe(true);
});

test.each(['success', 'cancel', 'failure'])('shared delete %s uses only the shared service and preserves guards', async (outcome) => {
  const shared = mockShared();
  if (outcome === 'cancel') mockDialog.confirm.mockResolvedValueOnce(false);
  if (outcome === 'failure') jest.mocked(deleteSharedExpense).mockRejectedValueOnce(new Error('Activity changed. Reopen it.'));
  await detail('shared');
  await button('Delete Shared Expense');
  expect(deleteTransaction).not.toHaveBeenCalled();
  expect(mockConfirmChange).not.toHaveBeenCalled();
  if (outcome === 'success') {
    expect(deleteSharedExpense).toHaveBeenCalledWith(mockData.db, shared.split.id, shared.split.updated_at);
    expect(mockData.refresh).toHaveBeenCalledTimes(1);
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
  } else {
    expect(mockNavigation.goBack).not.toHaveBeenCalled();
    expect(mockData.refresh).not.toHaveBeenCalled();
    if (outcome === 'cancel') expect(deleteSharedExpense).not.toHaveBeenCalled();
    else expect(mockDialog.showDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not delete' }));
  }
});

test('Home shared transaction child resolves exactly one explicit parent and opens shared detail', async () => {
  mockShared();
  jest.mocked(listActivity).mockResolvedValueOnce([]);
  mockData.db.getAllAsync.mockResolvedValueOnce([{ id: 'parent' }]);
  await detail();
  expect(listActivity).toHaveBeenLastCalledWith(mockData.db, { activityId: 'shared:parent' });
  expect(renderer!.root.findByType(PrimaryButton).props.title).toBe('Edit Shared Expense');
});

test.each([
  [5, 'Good morning', 'A fresh look at your finances.'],
  [11, 'Good morning', 'A fresh look at your finances.'],
  [12, 'Good afternoon', 'Here’s how your day is looking.'],
  [16, 'Good afternoon', 'Here’s how your day is looking.'],
  [17, 'Good evening', 'A quick look at today.'],
  [4, 'Good evening', 'A quick look at today.'],
])('Home greeting at hour %s uses personalized %s copy', (hour, primary, secondary) => {
  const date = new Date(2026, 8, 12, Number(hour));
  expect(getHomeGreeting(date)).toBe(primary);
  expect(getHomeGreetingCopy(date, '  Mubashar  ')).toEqual({ primary: `${primary}, Mubashar`, secondary });
});

test('Home greeting safely omits punctuation when the stored name is unavailable', () => {
  expect(getHomeGreetingCopy(new Date(2026, 8, 12, 8), '   ')).toEqual({
    primary: 'Good morning',
    secondary: 'A fresh look at your finances.',
  });
});

test('Home uses the stored profile name and opens the existing detail for recent Activity', async () => {
  await act(async () => { renderer = create(createElement(HomeScreen, { navigation: mockNavigation })); });
  expect(text()).toContain('Good');
  expect(text()).toContain('Mubashar');
  expect(listActivity).toHaveBeenCalledWith(mockData.db, { type: 'ALL', range: 'ALL', limit: 8, order: 'DATE' });
  const recent = renderer!.root.findAllByType(ListRow).find((node) => node.props.title === 'Dinner')!;
  await act(async () => recent.props.onPress());
  expect(mockNavigation.navigate).toHaveBeenCalledWith('ActivityDetail', { kind: 'transaction', sourceId: 'tx' });
});

test('Home passes all four newest events to the responsive preview in service order', async () => {
  const rows = [6, 5, 4, 3].map((day) => ({ ...row, id: `transaction:${day}`, source_id: String(day), title: `Event ${day}`, occurred_on: `2026-10-0${day}` }));
  jest.mocked(listActivity).mockResolvedValue(rows);
  await act(async () => { renderer = create(createElement(HomeScreen, { navigation: mockNavigation })); });
  expect(renderer!.root.findAllByType(ListRow).map((node) => node.props.title)).toEqual(['Event 6', 'Event 5', 'Event 4', 'Event 3']);
  expect(renderer!.root.findAllByType(ListRow).every((node) => node.props.preview)).toBe(true);
  expect(listActivity).toHaveBeenCalledWith(mockData.db, { type: 'ALL', range: 'ALL', limit: 8, order: 'DATE' });
});

test('Home Add menu contains only Expense and Income', async () => {
  await act(async () => { renderer = create(createElement(HomeScreen, { navigation: mockNavigation })); });
  await act(async () => renderer!.root.findByProps({ accessibilityLabel: 'Add transaction' }).props.onPress());
  const titles = renderer!.root.findAllByType(ListRow).map((node) => node.props.title);
  expect(titles).toEqual(expect.arrayContaining(['Expense', 'Income']));
  expect(titles).not.toEqual(expect.arrayContaining(['Give', 'Borrow']));
});

test('Home shows loading only for a true cold Activity load', async () => {
  let finish!: (rows: ActivityRow[]) => void;
  jest.mocked(listActivity).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => { renderer = create(createElement(HomeScreen, { navigation: mockNavigation })); });
  expect(text()).toContain('Loading recent activity...');
  await act(async () => finish([row]));
  expect(text()).toContain('Dinner');
  expect(text()).not.toContain('Loading recent activity...');
});

test('Home keeps cached Activity visible during silent refresh and replaces it on success', async () => {
  await act(async () => { renderer = create(createElement(HomeScreen, { navigation: mockNavigation })); });
  let finish!: (rows: ActivityRow[]) => void;
  jest.mocked(listActivity).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  mockData.transactions = [{ ...tx }] as any;
  await act(async () => renderer!.update(createElement(HomeScreen, { navigation: mockNavigation })));
  expect(text()).toContain('Dinner');
  expect(text()).not.toContain('Loading recent activity...');
  await act(async () => finish([{ ...row, id: 'transaction:new', source_id: 'new', title: 'Updated activity' }]));
  expect(text()).toContain('Updated activity');
  expect(text()).not.toContain('Dinner');
});

test('Home refresh failure preserves its last successful Activity rows and offers Retry', async () => {
  await act(async () => { renderer = create(createElement(HomeScreen, { navigation: mockNavigation })); });
  jest.mocked(listActivity).mockRejectedValueOnce(new Error('read failed'));
  mockData.entries = [{ id: 'changed' }] as any;
  await act(async () => renderer!.update(createElement(HomeScreen, { navigation: mockNavigation })));
  expect(text()).toContain('Dinner');
  expect(text()).toContain('Could not refresh recent activity. Showing the last update.');
  expect(text()).not.toContain('Loading recent activity...');
  expect(renderer!.root.findAllByType(SecondaryButton).some((node) => node.props.title === 'Retry recent activity')).toBe(true);
});

test('Home tab focus changes neither clear nor reload cached Activity', async () => {
  await act(async () => { renderer = create(createElement(HomeScreen, { navigation: mockNavigation })); });
  expect(listActivity).toHaveBeenCalledTimes(1);
  mockFocused = false;
  await act(async () => renderer!.update(createElement(HomeScreen, { navigation: mockNavigation })));
  mockFocused = true;
  await act(async () => renderer!.update(createElement(HomeScreen, { navigation: mockNavigation })));
  expect(text()).toContain('Dinner');
  expect(listActivity).toHaveBeenCalledTimes(1);
});

test('Home introduces no AppState listener', async () => {
  const listener = jest.spyOn(AppState, 'addEventListener');
  await act(async () => { renderer = create(createElement(HomeScreen, { navigation: mockNavigation })); });
  expect(listener).not.toHaveBeenCalled();
  listener.mockRestore();
});

test('Home only shows the compact daily allowance when the existing Spending Plan calculation has one', async () => {
  jest.useFakeTimers().setSystemTime(new Date(2026, 8, 12, 12));
  try {
    mockData.budgets = [{ id: 'plan', month_key: '2026-09', category_id: null, amount_minor: 100000, ownership: 'USER' }] as any;
    mockData.transactions = [{ ...tx, occurred_on: '2026-09-12', amount_minor: 1000 }] as any;
    await act(async () => { renderer = create(createElement(HomeScreen, { navigation: mockNavigation })); });
    expect(text()).toContain('/day available');
    mockData.budgets = [];
  } finally { jest.useRealTimers(); }
});

test('transfer deletion cancelled by account-impact warning makes no mutation', async () => {
  mockData.db.getFirstAsync.mockResolvedValue({ ...tx, type: 'TRANSFER', destination_account_id: 'bank' });
  jest.mocked(listActivity).mockResolvedValue([{ ...row, type: 'TRANSFER', label: 'Move Money', destination_name: 'My bank' }]);
  mockConfirmChange.mockResolvedValueOnce(false);
  await detail();
  expect(text()).toContain('My bank');
  await button('Delete');
  expect(mockConfirmChange).toHaveBeenCalledWith([expect.objectContaining({ destination_account_id: 'bank' })], [], [], []);
  expect(deleteTransaction).not.toHaveBeenCalled();
});

test('detail load failure can retry and a subscription source has an honest explanation', async () => {
  jest.mocked(listActivity).mockRejectedValueOnce(new Error('Could not load activity.'));
  await detail();
  expect(renderer!.root.findAllByType(PrimaryButton)).toHaveLength(0);
  jest.mocked(listActivity).mockResolvedValue([{ ...row, source: 'SUBSCRIPTION' }]);
  jest.mocked(ordinaryReadOnlyReason).mockResolvedValue('Subscription payment history editing is not supported yet.');
  await button('Retry');
  expect(text()).toContain('Subscription payment');
  expect(renderer!.root.findAllByType(PrimaryButton)).toHaveLength(0);
});

test('a save while Transactions is hidden marks it stale; it reloads once when shown, not on every visit', async () => {
  await act(async () => { renderer = create(createElement(ActivityListScreen, { navigation: mockNavigation })); });
  expect(listActivity).toHaveBeenCalledTimes(1);
  mockFocused = false;
  await act(async () => renderer!.update(createElement(ActivityListScreen, { navigation: mockNavigation })));
  mockData.transactions = [tx] as never; // a save on another screen refreshed the data
  await act(async () => renderer!.update(createElement(ActivityListScreen, { navigation: mockNavigation })));
  expect(listActivity).toHaveBeenCalledTimes(1);
  mockFocused = true;
  await act(async () => renderer!.update(createElement(ActivityListScreen, { navigation: mockNavigation })));
  expect(listActivity).toHaveBeenCalledTimes(2);
  mockFocused = false;
  await act(async () => renderer!.update(createElement(ActivityListScreen, { navigation: mockNavigation })));
  mockFocused = true;
  await act(async () => renderer!.update(createElement(ActivityListScreen, { navigation: mockNavigation })));
  expect(listActivity).toHaveBeenCalledTimes(2); // nothing changed: no reload just for switching tabs
});

test('Transactions reads 100 rows at a time and asks for more only when the page is full', async () => {
  jest.mocked(listActivity).mockResolvedValue(Array.from({ length: 100 }, (_, index) => ({ ...row, id: `transaction:${index}` })));
  await act(async () => { renderer = create(createElement(ActivityListScreen, { navigation: mockNavigation })); });
  expect(jest.mocked(listActivity).mock.calls[0][1]).toMatchObject({ limit: 100 });
  jest.mocked(listActivity).mockResolvedValue(Array.from({ length: 140 }, (_, index) => ({ ...row, id: `transaction:${index}` })));
  await act(async () => renderer!.root.findByType(FlatList).props.onEndReached());
  expect(jest.mocked(listActivity).mock.calls.at(-1)![1]).toMatchObject({ limit: 200 });
  const calls = jest.mocked(listActivity).mock.calls.length;
  await act(async () => renderer!.root.findByType(FlatList).props.onEndReached()); // 140 < 200: everything is loaded
  expect(jest.mocked(listActivity).mock.calls.length).toBe(calls);
});

test('Home shows an over-plan amount in amber instead of a negative "left" once spending passes the plan', async () => {
  const month = new Date().toISOString().slice(0, 7);
  mockData.budgets = [{ id: 'b', category_id: null, amount_minor: 5000, month_key: month }] as never;
  mockData.transactions = [{ ...tx, amount_minor: 8000, occurred_on: `${month}-01` }] as never;
  await act(async () => { renderer = create(createElement(HomeScreen, { navigation: mockNavigation })); });
  const text = renderer!.root.findAllByType(Text).map((node) => node.props.children).flat(Infinity).join('');
  expect(text).toContain('Rs. 30 over');
  expect(text).not.toContain('- Rs. 30 left');
});

test('Transactions rows are cards with a leading icon: category for expenses, person for People, group for shared bills', async () => {
  const rows = [
    { ...row, id: 'transaction:a', type: 'EXPENSE', category_name: 'Food' },
    { ...row, id: 'person:b', kind: 'person', type: 'PEOPLE' },
    { ...row, id: 'shared:c', kind: 'shared', type: 'SHARED', group_id: 'g' },
    { ...row, id: 'transaction:d', type: 'INCOME', category_name: 'Salary' },
  ] as ActivityRow[];
  jest.mocked(listActivity).mockResolvedValue(rows);
  await act(async () => { renderer = create(createElement(ActivityListScreen, { navigation: mockNavigation })); });
  const list = renderer!.root.findByType(FlatList);
  const rendered = rows.map((item) => list.props.renderItem({ item }).props);
  expect(rendered.map((props) => [props.card, props.icon, props.iconTone])).toEqual([
    [true, 'restaurant-outline', 'negative'], [true, 'person-outline', 'neutral'], [true, 'people-outline', 'negative'], [true, 'briefcase-outline', 'positive'],
  ]);
});

test('Type and Date range sit inside the Filter panel and show in the collapsed summary', async () => {
  await list();
  expect(picker('Type')).toBeUndefined();
  await button('Filter');
  await act(async () => { picker('Type').props.setValue('INCOME'); picker('Date range').props.setValue('THIS_MONTH'); });
  await button('Hide filters');
  expect(text()).toContain('Type: Income | Dates: This month');
});

test('Transactions sort button sits right of Filter at the same width, defaults to date, and saves the other order', async () => {
  await act(async () => { renderer = create(createElement(ActivityListScreen, { navigation: mockNavigation })); });
  const buttons = () => renderer!.root.findAllByType(SecondaryButton).map((node) => node.props.title);
  expect(buttons().slice(0, 2)).toEqual(['Filter', 'By Date']);
  expect(jest.mocked(listActivity).mock.calls.at(-1)![1]).toEqual(expect.objectContaining({ order: 'DATE' }));
  const sort = () => renderer!.root.findAllByType(SecondaryButton).find((node) => node.props.icon === 'swap-vertical-outline')!;
  const filter = renderer!.root.findAllByType(SecondaryButton).find((node) => node.props.title === 'Filter')!;
  expect(filter.parent!.props.style).toEqual({ flex: 1 });
  expect(sort().parent!.props.style).toEqual({ flex: 1 });
  await act(async () => sort().props.onPress());
  expect(sort().props.title).toBe('By Entry');
  expect(mockData.setSetting).toHaveBeenCalledWith(mockData.db, 'activity_sort_order', 'CREATED');
  expect(mockData.refresh).toHaveBeenCalled();
  expect(jest.mocked(listActivity).mock.calls.at(-1)![1]).toEqual(expect.objectContaining({ order: 'CREATED' }));
});

test('a saved entry-created order is used after a restart', async () => {
  mockData.settings.activity_sort_order = 'CREATED';
  await act(async () => { renderer = create(createElement(ActivityListScreen, { navigation: mockNavigation })); });
  expect(renderer!.root.findAllByType(SecondaryButton).some((node) => node.props.title === 'By Entry')).toBe(true);
  expect(jest.mocked(listActivity).mock.calls.at(-1)![1]).toEqual(expect.objectContaining({ order: 'CREATED' }));
});

import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { SubscriptionDetailScreen } from '../navigation/SubscriptionScreens';
import { ListRow, PrimaryButton, SecondaryButton, TextField, MoneyText } from '../components/common';
import { Picker } from '../components/forms';
import type { SubscriptionPayment } from '../types/models';
import { addDays, todayLocal } from '../utils/date';
import { readReminderDelivery } from '../services/notifications/NotificationService';

const mockNavigation = { addListener: jest.fn(() => () => {}), isFocused: () => true, goBack: jest.fn(), navigate: jest.fn() };
const mockDialog = { confirm: jest.fn(), showDialog: jest.fn(), showSuccess: jest.fn() };
const mockConfirmOutflow = jest.fn();
const original = {
  id: 'sub', name: 'Netflix', amount_minor: 150000, account_id: 'cash', category_id: 'subscriptions',
  start_date: '2026-08-15', next_renewal_date: '2026-09-15', frequency_type: 'MONTHLY', frequency_interval: 1,
  recurrence_anchor_day: 15, completed_cycles: 0, reminder_enabled: 1, reminder_days_before: 3,
  cancellation_reminder_enabled: 1, cancellation_reminder_date: '2026-09-14', note: 'Trial reference', status: 'ACTIVE',
  created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z', sync_status: 'LOCAL',
  account_name: 'Cash', category_name: 'Subscriptions',
};
let mockSubscription = { ...original };
const mockRepo = { getSubscription: jest.fn(), listSubscriptionPayments: jest.fn(), markSubscriptionPaid: jest.fn(), updateSubscription: jest.fn(), changeSubscriptionStatus: jest.fn() };
const mockData = {
  db: {}, repo: mockRepo, subscriptions: [original],
  categories: [{ id: 'subscriptions', name: 'Subscriptions', type: 'EXPENSE', is_archived: 0 }, { id: 'old', name: 'Old', type: 'EXPENSE', is_archived: 1 }],
  accounts: [{ id: 'cash', name: 'Cash' }], refresh: jest.fn(),
};
const history: SubscriptionPayment = {
  id: 'payment', subscription_id: 'sub', scheduled_date: '2026-08-15', transaction_id: 'expense', created_at: '2026-08-15',
  transaction_title: 'Old service', transaction_amount_minor: 120000, transaction_date: '2026-08-15', transaction_available: 1,
  account_name: 'Old bank', category_name: 'Old category',
};
jest.mock('@react-navigation/native', () => ({ useNavigation: () => mockNavigation, useIsFocused: () => true }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
jest.mock('../hooks/useAppData', () => ({ useAppData: () => mockData }));
jest.mock('../components/dialogs/AppDialogProvider', () => ({ useAppDialog: () => mockDialog }));
jest.mock('../hooks/useConfirmOutflow', () => ({ useConfirmOutflow: () => mockConfirmOutflow }));
jest.mock('../services/notifications/NotificationService', () => ({ ...jest.requireActual('../services/notifications/NotificationService'), readReminderDelivery: jest.fn() }));

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(readReminderDelivery).mockResolvedValue({ enabled: true, status: { permission: 'granted', canAskAgain: false, scheduling: 'available' } });
  mockNavigation.addListener.mockReturnValue(() => {});
  mockSubscription = { ...original };
  mockRepo.getSubscription.mockImplementation(async () => ({ ...mockSubscription }));
  mockRepo.listSubscriptionPayments.mockResolvedValue([]);
  mockRepo.markSubscriptionPaid.mockImplementation(async () => { mockSubscription.next_renewal_date = '2026-10-15'; return 'expense'; });
  mockRepo.changeSubscriptionStatus.mockImplementation(async (_db, _id, _version, status) => { mockSubscription.status = status; });
  mockData.refresh.mockResolvedValue(undefined);
  mockDialog.confirm.mockResolvedValue(true);
  mockConfirmOutflow.mockResolvedValue(true);
});
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; });
async function render() {
  await act(async () => { renderer = create(createElement(SubscriptionDetailScreen, { navigation: mockNavigation, route: { params: { subscriptionId: 'sub' } } })); });
}
const primary = (title: string) => renderer!.root.findAllByType(PrimaryButton).find((node) => node.props.title === title);
const secondary = (title: string) => renderer!.root.findAllByType(SecondaryButton).find((node) => node.props.title === title);
const field = (label: string) => renderer!.root.findAllByType(TextField).find((node) => node.props.label === label)!;
const output = () => JSON.stringify(renderer!.toJSON());

test('Every N Days detail/editor reopens the interval, validates and keeps it on save', async () => {
  mockSubscription.frequency_type = 'EVERY_N_DAYS'; mockSubscription.frequency_interval = 23;
  await render(); expect(output()).toContain('Every 23 days');
  await act(async () => secondary('Edit')!.props.onPress()); expect(field('Repeat every days').props.value).toBe('23');
  await act(async () => field('Repeat every days').props.onChangeText('1.5')); await act(async () => primary('Save Changes')!.props.onPress());
  expect(mockRepo.updateSubscription).not.toHaveBeenCalled(); expect(field('Repeat every days').props.value).toBe('1.5');
  await act(async () => field('Repeat every days').props.onChangeText('60')); await act(async () => primary('Save Changes')!.props.onPress());
  expect(mockRepo.updateSubscription).toHaveBeenCalledWith(mockData.db, 'sub', original.updated_at, expect.objectContaining({ frequency_type: 'EVERY_N_DAYS', frequency_interval: 60 }));
});
test('duplicate subscription payment has Already recorded/history feedback without refreshing or leaving', async () => {
  mockRepo.markSubscriptionPaid.mockRejectedValue(new Error('This subscription occurrence was already paid.'));
  await render(); await act(async () => primary('Mark Paid')!.props.onPress());
  expect(mockDialog.showDialog).toHaveBeenCalledWith({ title: 'Already recorded', message: 'This subscription payment has already been recorded for this scheduled date. You can review it in the payment history.' });
  expect(mockData.refresh).not.toHaveBeenCalled(); expect(mockNavigation.goBack).not.toHaveBeenCalled(); expect(primary('Mark Paid')).toBeTruthy();
});

test('Subscription Detail renders metadata, trial preference, monthly reporting and lifecycle actions', async () => {
  await render();
  for (const text of ['Netflix', 'Cash', 'Subscriptions', 'Monthly', 'Next billing', 'Status', 'Trial reference', 'Trial / cancellation reminder', 'Estimated monthly cost', 'Payment History']) expect(output()).toContain(text);
  expect(primary('Mark Paid') != null).toBe(true);
  expect(['Edit', 'Pause', 'Cancel Tracking'].every((title) => !!secondary(title))).toBe(true);
  expect(renderer!.root.findAllByType(MoneyText).map((n) => n.props.amount)).toEqual([150000, 150000]);
  expect(output()).not.toContain('ACTIVE');
});

test('Mark Paid confirms real payment, checks outflow and sends exact occurrence/version once on double tap', async () => {
  let release!: () => void;
  mockRepo.markSubscriptionPaid.mockImplementation(() => new Promise<string>((resolve) => { release = () => resolve('expense'); }));
  await render(); const press = primary('Mark Paid')!.props.onPress;
  let pending!: Promise<void>;
  await act(async () => { pending = press(); void press(); await Promise.resolve(); await Promise.resolve(); });
  expect(mockRepo.markSubscriptionPaid).toHaveBeenCalledTimes(1);
  expect(mockRepo.markSubscriptionPaid).toHaveBeenCalledWith(mockData.db, 'sub', '2026-09-15', original.updated_at, todayLocal());
  expect(mockConfirmOutflow).toHaveBeenCalledWith('cash', 150000);
  expect(primary('Mark Paid')!.props.saving).toBe(true);
  await act(async () => { release(); await pending; });
});

test.each(['payment confirmation', 'negative balance warning'])('cancelling %s prevents Mark Paid', async (which) => {
  if (which === 'payment confirmation') mockDialog.confirm.mockResolvedValue(false);
  else mockConfirmOutflow.mockResolvedValue(false);
  await render(); await act(async () => primary('Mark Paid')!.props.onPress());
  expect(mockRepo.markSubscriptionPaid).not.toHaveBeenCalled();
});

test('history displays original real Expense amount/account/category and opens Activity', async () => {
  mockRepo.listSubscriptionPayments.mockResolvedValue([history]); await render();
  const row = renderer!.root.findByType(ListRow);
  expect(row.props.title).toBe('Paid · Old service');
  expect(row.props.subtitle).toContain('Old bank'); expect(row.props.subtitle).toContain('Old category');
  expect(row.props.right.props.amount).toBe(-120000);
  await act(async () => row.props.onPress());
  expect(mockNavigation.navigate).toHaveBeenCalledWith('ActivityDetail', { kind: 'transaction', sourceId: 'expense' });
});

test('early payment confirmation states today and history shows actual date rather than the scheduled renewal', async () => {
  mockSubscription.next_renewal_date = addDays(todayLocal(), 30);
  mockRepo.listSubscriptionPayments.mockResolvedValue([{ ...history, scheduled_date: mockSubscription.next_renewal_date, transaction_date: todayLocal() }]);
  await render();
  const row = renderer!.root.findByType(ListRow);
  const { displayFullDate } = jest.requireActual('../utils/date');
  expect(row.props.subtitle).toContain(displayFullDate(todayLocal()));
  expect(row.props.subtitle).not.toContain(displayFullDate(mockSubscription.next_renewal_date));
  await act(async () => primary('Mark Paid')!.props.onPress());
  expect(mockDialog.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Record an early payment?', message: expect.stringContaining(displayFullDate(todayLocal())) }));
  expect(mockRepo.markSubscriptionPaid).toHaveBeenCalledWith(mockData.db, 'sub', addDays(todayLocal(), 30), original.updated_at, todayLocal());
});

test('unavailable Expense is not falsely shown as paid or tappable', async () => {
  mockRepo.listSubscriptionPayments.mockResolvedValue([{ ...history, transaction_available: 0 }]); await render();
  const row = renderer!.root.findByType(ListRow);
  expect(row.props.title).toBe('Expense unavailable'); expect(row.props.onPress).toBeUndefined(); expect(row.props.right).toBeUndefined();
});

test('Pause and Resume call metadata flow only and paused detail hides Mark Paid', async () => {
  await render(); await act(async () => secondary('Pause')!.props.onPress());
  expect(mockRepo.changeSubscriptionStatus).toHaveBeenLastCalledWith(mockData.db, 'sub', original.updated_at, 'PAUSED');
  expect(primary('Mark Paid') == null).toBe(true); expect(output()).toContain('Paused');
  await act(async () => secondary('Resume')!.props.onPress());
  expect(mockRepo.changeSubscriptionStatus).toHaveBeenLastCalledWith(mockData.db, 'sub', original.updated_at, 'ACTIVE');
  expect(mockRepo.markSubscriptionPaid).not.toHaveBeenCalled(); expect(mockConfirmOutflow).not.toHaveBeenCalled();
});

test('Cancel Tracking explains service scope and preserves visible linked history', async () => {
  mockRepo.listSubscriptionPayments.mockResolvedValue([history]); await render();
  await act(async () => secondary('Cancel Tracking')!.props.onPress());
  expect(mockDialog.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('does not cancel the actual service'), destructive: true }));
  expect(mockRepo.changeSubscriptionStatus).toHaveBeenCalledWith(mockData.db, 'sub', original.updated_at, 'CANCELLED');
  expect(output()).toContain('Cancelled'); expect(output()).toContain('Paid · Old service');
  expect(primary('Mark Paid') == null).toBe(true); expect(mockRepo.markSubscriptionPaid).not.toHaveBeenCalled();
});

test('edit uses future metadata and custom-calendar date field, retains invalid input and history', async () => {
  mockRepo.listSubscriptionPayments.mockResolvedValue([history]); await render();
  await act(async () => secondary('Edit')!.props.onPress());
  expect(field('Next billing date').props.allowFuture).toBe(true);
  const picker = renderer!.root.findAllByType(Picker).find((n) => n.props.label === 'Category')!;
  expect(picker.props.rows).toEqual([['subscriptions', 'Subscriptions', 'repeat-outline']]);
  await act(async () => field('Name').props.onChangeText('Future name'));
  await act(async () => field('Amount').props.onChangeText('bad'));
  await act(async () => primary('Save Changes')!.props.onPress());
  expect(mockRepo.updateSubscription).not.toHaveBeenCalled(); expect(field('Name').props.value).toBe('Future name');
  await act(async () => field('Amount').props.onChangeText('2000'));
  await act(async () => primary('Save Changes')!.props.onPress());
  expect(mockRepo.updateSubscription).toHaveBeenCalledWith(mockData.db, 'sub', original.updated_at, expect.objectContaining({ name: 'Future name', amount_minor: 200000, next_renewal_date: '2026-09-15', cancellation_reminder_enabled: 1 }));
  expect(output()).toContain('Paid · Old service');
});

test('failed save keeps editor open and failure feedback uses Sage dialog', async () => {
  mockRepo.updateSubscription.mockRejectedValue(new Error('Injected failure')); await render();
  await act(async () => secondary('Edit')!.props.onPress());
  await act(async () => field('Note').props.onChangeText('Keep this draft'));
  await act(async () => primary('Save Changes')!.props.onPress());
  expect(field('Note').props.value).toBe('Keep this draft'); expect(mockNavigation.goBack).not.toHaveBeenCalled();
  expect(mockDialog.showDialog).toHaveBeenCalled();
});

test('history read failure hides actions and Retry reloads without posting', async () => {
  mockRepo.listSubscriptionPayments.mockRejectedValueOnce(new Error('read failure'));
  await render(); expect(primary('Mark Paid') == null).toBe(true);
  await act(async () => secondary('Retry')!.props.onPress());
  expect(primary('Mark Paid') != null).toBe(true); expect(mockRepo.markSubscriptionPaid).not.toHaveBeenCalled();
});

test('failed post-commit refresh retries reads only and never repeats Expense posting', async () => {
  mockData.refresh.mockRejectedValueOnce(new Error('refresh failed'));
  await render(); await act(async () => primary('Mark Paid')!.props.onPress());
  expect(mockRepo.markSubscriptionPaid).toHaveBeenCalledTimes(1);
  expect(mockDialog.showDialog).toHaveBeenCalled();
  const notice = mockDialog.showDialog.mock.calls[mockDialog.showDialog.mock.calls.length - 1][0];
  const retry = notice.actions.find((action: { text: string }) => action.text === 'Retry refresh');
  expect(!!retry).toBe(true);
  await act(async () => retry.onPress());
  expect(mockRepo.markSubscriptionPaid).toHaveBeenCalledTimes(1);
});

test.each([[2, 'ACTIVE', 'Due in'], [0, 'ACTIVE', 'Due today'], [-2, 'ACTIVE', 'days overdue'], [-2, 'PAUSED', 'Paused']] as const)('detail derives date offset %i and state %s', async (days, status, label) => {
  mockSubscription.next_renewal_date = addDays(todayLocal(), days); mockSubscription.status = status;
  await render(); expect(output()).toContain(label);
  if (status === 'PAUSED') expect(output()).not.toContain('days overdue');
});

test.each([['EVERY_N_MONTHS', 3, 50000], ['YEARLY', 1, 12500], ['WEEKLY', 1, 650000]] as const)('detail shows normalized %s amount rather than posting it', async (frequency, interval, expected) => {
  mockSubscription.frequency_type = frequency; mockSubscription.frequency_interval = interval;
  await render();
  expect(renderer!.root.findAllByType(MoneyText).map((n) => n.props.amount)).toEqual([150000, expected]);
  expect(mockRepo.markSubscriptionPaid).not.toHaveBeenCalled();
});

test('dirty editor Cancel keeps draft when Sage discard confirmation is declined', async () => {
  mockDialog.confirm.mockResolvedValue(false); await render();
  await act(async () => secondary('Edit')!.props.onPress());
  await act(async () => field('Note').props.onChangeText('Unsaved note'));
  await act(async () => secondary('Cancel')!.props.onPress());
  expect(field('Note').props.value).toBe('Unsaved note');
  expect(mockDialog.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Discard changes?' }));
});

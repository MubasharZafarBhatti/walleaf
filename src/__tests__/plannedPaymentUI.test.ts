import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { PlannedPaymentDetailScreen } from '../navigation/PlannedPaymentScreens';
import { ListRow, PrimaryButton, SecondaryButton, TextField } from '../components/common';
import { Picker } from '../components/forms';
import type { PlannedPayment } from '../types/models';
import { readReminderDelivery } from '../services/notifications/NotificationService';

const mockNavigation = { addListener: jest.fn(() => () => {}), isFocused: () => true, goBack: jest.fn(), navigate: jest.fn() };
const mockDialog = { confirm: jest.fn(), showDialog: jest.fn(), showSuccess: jest.fn() };
const mockConfirmOutflow = jest.fn();
const expense = {
  id: 'planned-expense', name: 'Internet bill', type: 'EXPENSE', amount_minor: 350000,
  category_id: 'bills', account_id: 'cash', next_due_date: '2026-09-15',
  recurrence_type: 'MONTHLY', recurrence_interval: 1, end_date: null,
  occurrence_limit: null, completed_occurrences: 0, reminder_enabled: 1,
  reminder_days_before: 3, subscription_metadata: null, status: 'ACTIVE',
  note: 'Home internet', created_at: '2026-09-01', updated_at: '2026-09-15T00:00:00.000Z',
  deleted_at: null, sync_status: 'LOCAL',
} as const;
const income = { ...expense, id: 'planned-income', name: 'Salary', type: 'INCOME', category_id: 'salary', note: null } as const;
const occurrence = {
  id: 'occurrence', planned_payment_id: expense.id, scheduled_date: '2026-08-15',
  outcome: 'RECORDED', transaction_id: 'tx-expense', created_at: '2026-08-15',
  transaction_deleted_at: null, transaction_amount_minor: 300000,
  transaction_type: 'EXPENSE', transaction_title: 'Internet bill',
} as const;
const mockRepo = {
  listPlannedPaymentOccurrences: jest.fn(), markPlannedPaymentPaid: jest.fn(),
  skipPlannedPayment: jest.fn(), updatePlannedPayment: jest.fn(),
  pausePlannedPayment: jest.fn(), resumePlannedPayment: jest.fn(),
  stopTrackingPlannedPayment: jest.fn(),
};
const mockData = {
  db: {}, repo: mockRepo, plannedPayments: [expense] as PlannedPayment[],
  categories: [
    { id: 'bills', name: 'Bills', type: 'EXPENSE', is_archived: 0 },
    { id: 'salary', name: 'Salary', type: 'INCOME', is_archived: 0 },
  ],
  accounts: [{ id: 'cash', name: 'Cash' }], refresh: jest.fn(),
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
  mockData.plannedPayments = [expense] as any;
  mockData.accounts = [{ id: 'cash', name: 'Cash' }];
  mockData.refresh.mockResolvedValue(undefined);
  mockDialog.confirm.mockResolvedValue(true);
  mockConfirmOutflow.mockResolvedValue(true);
  mockRepo.listPlannedPaymentOccurrences.mockResolvedValue([]);
  mockRepo.markPlannedPaymentPaid.mockResolvedValue('tx');
  mockRepo.skipPlannedPayment.mockResolvedValue(undefined);
  mockRepo.updatePlannedPayment.mockResolvedValue(undefined);
  mockRepo.pausePlannedPayment.mockResolvedValue(undefined);
  mockRepo.resumePlannedPayment.mockResolvedValue(undefined);
  mockRepo.stopTrackingPlannedPayment.mockResolvedValue(undefined);
});
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; });

async function render(id: string = expense.id) {
  await act(async () => {
    renderer = create(createElement(PlannedPaymentDetailScreen, {
      navigation: mockNavigation,
      route: { params: { plannedPaymentId: id } },
    }));
  });
}
const primary = (title: string) => renderer!.root.findAllByType(PrimaryButton).find((node) => node.props.title === title);
const secondary = (title: string) => renderer!.root.findAllByType(SecondaryButton).find((node) => node.props.title === title);
const field = (label: string) => renderer!.root.findAllByType(TextField).find((node) => node.props.label === label)!;

test('Every N Days Planned detail/editor reopens, validates and preserves the interval', async () => {
  mockData.plannedPayments = [{ ...expense, recurrence_type: 'EVERY_N_DAYS', recurrence_interval: 23 }];
  await render(); expect(JSON.stringify(renderer!.toJSON())).toContain('Every 23 days');
  await act(async () => secondary('Edit')!.props.onPress()); expect(field('Repeat every days').props.value).toBe('23');
  await act(async () => field('Repeat every days').props.onChangeText('0')); await act(async () => primary('Save Changes')!.props.onPress());
  expect(mockRepo.updatePlannedPayment).not.toHaveBeenCalled(); expect(field('Repeat every days').props.value).toBe('0');
  await act(async () => field('Repeat every days').props.onChangeText('60')); await act(async () => primary('Save Changes')!.props.onPress());
  expect(mockRepo.updatePlannedPayment).toHaveBeenCalledWith(mockData.db, expense.id, expense.updated_at, expect.objectContaining({ recurrence_type: 'EVERY_N_DAYS', recurrence_interval: 60 }));
});
test('stale recorded Planned income explains Already recorded and directs to history', async () => {
  mockData.plannedPayments = [income]; mockRepo.listPlannedPaymentOccurrences.mockResolvedValue([{ ...occurrence, planned_payment_id: income.id, scheduled_date: income.next_due_date, transaction_type: 'INCOME' }]);
  mockRepo.markPlannedPaymentPaid.mockRejectedValue(new Error('This scheduled occurrence was already handled.'));
  await render(income.id); await act(async () => primary('Record Income')!.props.onPress());
  expect(mockDialog.showDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'Already recorded', message: expect.stringContaining('This income has already been recorded') }));
  expect(mockData.refresh).not.toHaveBeenCalled(); expect(mockConfirmOutflow).not.toHaveBeenCalled();
});

test('Planned Payment Detail shows friendly metadata, Expense wording and lifecycle actions', async () => {
  await render();
  const output = JSON.stringify(renderer!.toJSON());
  expect(output).toContain('Internet bill');
  expect(output).toContain('Expense');
  expect(output).toContain('Bills');
  expect(output).toContain('Cash');
  expect(output).toContain('Monthly');
  expect(output).toContain('Home internet');
  expect(output).toContain('Reminder');
  expect(primary('Record Expense')).toBeTruthy();
  expect(primary('Record Income')).toBeFalsy();
  expect(['Skip', 'Edit', 'Pause', 'Stop Tracking'].every((title) => secondary(title))).toBe(true);
  expect(output).not.toContain('EXPENSE');
  expect(output).not.toContain('ACTIVE');
});

test('Income detail uses Record Income and never Mark Paid', async () => {
  mockData.plannedPayments = [income] as any;
  await render(income.id);
  expect(primary('Record Income')).toBeTruthy();
  expect(primary('Record Expense')).toBeFalsy();
  expect(JSON.stringify(renderer!.toJSON())).not.toContain('Mark Paid');
});

test('paused detail resolves its archived account name but the editor offers only active accounts', async () => {
  mockData.plannedPayments = [{ ...expense, account_id: 'archived-bank', account_name: 'Meezan Bank', status: 'PAUSED' }] as any;
  await render();
  expect(JSON.stringify(renderer!.toJSON())).toContain('Meezan Bank');
  expect(JSON.stringify(renderer!.toJSON())).not.toContain('Archived account');
  await act(async () => secondary('Edit')!.props.onPress());
  const accountPicker = renderer!.root.findAllByType(Picker).find((node) => node.props.label === 'Account')!;
  expect(accountPicker.props.rows).toEqual([['cash', 'Cash']]);
  expect(mockRepo.markPlannedPaymentPaid).not.toHaveBeenCalled();
});

test('occurrence history links to its one real Activity record and keeps historical amount', async () => {
  mockRepo.listPlannedPaymentOccurrences.mockResolvedValue([occurrence]);
  await render();
  const row = renderer!.root.findAllByType(ListRow).find((node) => node.props.title === 'Expense recorded')!;
  expect(row.props.right.props.amount).toBe(-300000);
  await act(async () => row.props.onPress());
  expect(mockNavigation.navigate).toHaveBeenCalledWith('ActivityDetail', { kind: 'transaction', sourceId: 'tx-expense' });
});

test('rapid double Record Expense submits only once while save is pending', async () => {
  let release!: () => void;
  mockRepo.markPlannedPaymentPaid.mockImplementation(() => new Promise<string>((resolve) => { release = () => resolve('tx'); }));
  await render();
  const press = primary('Record Expense')!.props.onPress;
  let first!: Promise<void>;
  await act(async () => {
    first = press();
    void press();
    await Promise.resolve();
  });
  expect(mockRepo.markPlannedPaymentPaid).toHaveBeenCalledTimes(1);
  expect(mockConfirmOutflow).toHaveBeenCalledWith('cash', 350000);
  await act(async () => { release(); await first; });
});

test('stale recorded occurrence shows specific Sage feedback and retains state without another transaction', async () => {
  await render();
  mockRepo.markPlannedPaymentPaid.mockRejectedValue(new Error('This scheduled occurrence was already handled.'));
  mockRepo.listPlannedPaymentOccurrences.mockResolvedValue([{ ...occurrence, scheduled_date: expense.next_due_date }]);
  await act(async () => primary('Record Expense')!.props.onPress());
  expect(mockDialog.showDialog).toHaveBeenCalledWith({ title: 'Already recorded', message: 'This expense has already been recorded for this scheduled date. You can review it in the payment history. No duplicate transaction was created.' });
  expect(mockRepo.markPlannedPaymentPaid).toHaveBeenCalledTimes(1);
  expect(mockData.refresh).not.toHaveBeenCalled();
  expect(primary('Record Expense')).toBeTruthy();
});

test('prefilled editor stays disabled for equivalent formatted amount and enables a valid actual change', async () => {
  await render();
  await act(async () => secondary('Edit')!.props.onPress());
  expect(field('Amount').props.value).toBe('3500.00');
  expect(primary('Save Changes')!.props.disabled).toBe(true);
  await act(async () => field('Amount').props.onChangeText('3,500'));
  expect(primary('Save Changes')!.props.disabled).toBe(true);
  await act(async () => field('Amount').props.onChangeText('4000'));
  expect(primary('Save Changes')!.props.disabled).toBe(false);
  await act(async () => field('Amount').props.onChangeText('4.001'));
  expect(primary('Save Changes')!.props.disabled).toBe(true);
});

test('edit preserves history, keeps type fixed after recording and submits future metadata', async () => {
  mockRepo.listPlannedPaymentOccurrences.mockResolvedValue([occurrence]);
  await render();
  await act(async () => secondary('Edit')!.props.onPress());
  expect(JSON.stringify(renderer!.toJSON())).toContain('kept fixed after history is recorded');
  expect(renderer!.root.findAllByType(Picker).find((node) => node.props.label === 'Type')).toBeFalsy();
  await act(async () => field('Name').props.onChangeText('Updated internet'));
  await act(async () => field('Amount').props.onChangeText('4000'));
  await act(async () => field('Note').props.onChangeText('Future note'));
  await act(async () => primary('Save Changes')!.props.onPress());
  expect(mockRepo.updatePlannedPayment).toHaveBeenCalledWith(
    mockData.db,
    expense.id,
    expense.updated_at,
    expect.objectContaining({ name: 'Updated internet', type: 'EXPENSE', amount_minor: 400000, note: 'Future note' }),
  );
});

test('pause, resume and Stop Tracking use safe lifecycle writes without financial posting', async () => {
  await render();
  await act(async () => secondary('Pause')!.props.onPress());
  expect(mockRepo.pausePlannedPayment).toHaveBeenCalledWith(mockData.db, expense.id, expense.updated_at);
  expect(mockRepo.markPlannedPaymentPaid).not.toHaveBeenCalled();

  await act(async () => renderer!.unmount());
  renderer = undefined;
  mockData.plannedPayments = [{ ...expense, status: 'PAUSED' }] as any;
  await render();
  expect(JSON.stringify(renderer!.toJSON())).toContain('Paused');
  expect(primary('Record Expense')).toBeFalsy();
  await act(async () => secondary('Resume')!.props.onPress());
  expect(mockRepo.resumePlannedPayment).toHaveBeenCalled();
  expect(mockRepo.markPlannedPaymentPaid).not.toHaveBeenCalled();

  await act(async () => renderer!.unmount());
  renderer = undefined;
  mockData.plannedPayments = [expense] as any;
  await render();
  await act(async () => secondary('Stop Tracking')!.props.onPress());
  expect(mockDialog.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Stop tracking this plan?', destructive: true }));
  expect(mockRepo.stopTrackingPlannedPayment).toHaveBeenCalledWith(mockData.db, expense.id, expense.updated_at);
  expect(mockNavigation.goBack).toHaveBeenCalled();
  expect(mockRepo.markPlannedPaymentPaid).not.toHaveBeenCalled();
});

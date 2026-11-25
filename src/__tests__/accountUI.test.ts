import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { AccountAdjustScreen, AccountDetailScreen, AccountEditScreen, ArchivedAccountsPanel } from '../navigation/AccountScreens';
import { ListRow, PrimaryButton, SecondaryButton, TextField } from '../components/common';
import { adjustAccountBalance, archiveAccount, listArchivedAccounts, readAccountSnapshot, renameAccount, restoreAccount } from '../services/accounts/AccountService';

const mockNavigation = { addListener: jest.fn(() => () => {}), isFocused: () => true, goBack: jest.fn(), navigate: jest.fn() };
const mockDialog = { confirm: jest.fn(), showDialog: jest.fn(), showSuccess: jest.fn() };
const account = { id: 'bank', name: 'Meezan Bank', type: 'BANK', currency: 'PKR', opening_balance_minor: 500, is_archived: 0, created_at: '2026-09-01', updated_at: '2026-09-12T00:00:00.000Z', deleted_at: null, sync_status: 'LOCAL' } as const;
const activity = { id: 'transaction:tx', kind: 'transaction', source_id: 'tx', source: 'MANUAL', type: 'EXPENSE', title: 'Lunch', note: null, amount_minor: 1000, occurred_on: '2026-09-12', created_at: '2026-09-12', account_id: 'bank', destination_account_id: null, category_id: 'food', person_id: null, group_id: null, account_name: 'Meezan Bank', destination_name: '', category_name: 'Food', person_name: '', group_name: '', label: 'Expense' } as const;
const mockData = { db: {}, accounts: [account, { ...account, id: 'cash', name: 'Cash', type: 'CASH' }], transactions: [], entries: [], settings: { currency: 'PKR' }, refresh: jest.fn() };

jest.mock('@react-navigation/native', () => ({ useNavigation: () => mockNavigation, useIsFocused: () => true }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
jest.mock('../hooks/useAppData', () => ({ useAppData: () => mockData }));
jest.mock('../components/dialogs/AppDialogProvider', () => ({ useAppDialog: () => mockDialog }));
jest.mock('../services/accounts/AccountService', () => ({
  ...jest.requireActual('../services/accounts/AccountService'),
  readAccountSnapshot: jest.fn(),
  renameAccount: jest.fn(),
  adjustAccountBalance: jest.fn(),
  archiveAccount: jest.fn(),
  restoreAccount: jest.fn(),
  listArchivedAccounts: jest.fn(),
}));

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  jest.resetAllMocks();
  mockNavigation.addListener.mockReturnValue(() => {});
  mockData.refresh.mockResolvedValue(undefined);
  mockDialog.confirm.mockResolvedValue(true);
  jest.mocked(readAccountSnapshot).mockResolvedValue({ account: { ...account }, currentBalanceMinor: 1000, activity: [{ ...activity }] } as any);
  jest.mocked(renameAccount).mockResolvedValue(undefined);
  jest.mocked(adjustAccountBalance).mockResolvedValue({ previousBalanceMinor: 1000, adjustmentMinor: 1500, actualBalanceMinor: 2500 });
  jest.mocked(archiveAccount).mockResolvedValue(undefined);
  jest.mocked(restoreAccount).mockResolvedValue(undefined);
  jest.mocked(listArchivedAccounts).mockResolvedValue([]);
});
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; });

async function render(Component: any) {
  await act(async () => { renderer = create(createElement(Component, { navigation: mockNavigation, route: { params: { accountId: 'bank' } } })); });
}

const secondary = (title: string) => renderer!.root.findAllByType(SecondaryButton).find((node) => node.props.title === title)!;
const field = (label: string) => renderer!.root.findAllByType(TextField).find((node) => node.props.label === label)!;

test('Account Detail shows friendly account information, balances, activity and all actions', async () => {
  await render(AccountDetailScreen);
  const output = JSON.stringify(renderer!.toJSON());
  expect(output).toContain('Meezan Bank');
  expect(output).toContain('Bank');
  expect(output).toContain('Current balance');
  expect(output).toContain('Opening balance');
  expect(renderer!.root.findAllByType(ListRow).find((node) => node.props.title === 'Lunch')).toBeTruthy();
  expect(renderer!.root.findByType(PrimaryButton).props.title).toBe('Edit Account');
  expect(['Adjust Balance', 'Move Money', 'Archive Account'].every((title) => secondary(title))).toBe(true);
});

test('Account Detail routes to existing Activity and Move Money with account context', async () => {
  await render(AccountDetailScreen);
  await act(async () => renderer!.root.findAllByType(ListRow).find((node) => node.props.title === 'Lunch')!.props.onPress());
  expect(mockNavigation.navigate).toHaveBeenCalledWith('ActivityDetail', { kind: 'transaction', sourceId: 'tx' });
  await act(async () => secondary('Move Money').props.onPress());
  expect(mockNavigation.navigate).toHaveBeenCalledWith('TransactionForm', { type: 'TRANSFER', accountId: 'bank' });
});

test('Account Detail adjustment uses account/reason/date subtitle without repeating the title', async () => {
  jest.mocked(readAccountSnapshot).mockResolvedValue({ account, currentBalanceMinor: 1000, activity: [{ ...activity, type: 'ADJUSTMENT', title: 'Balance adjustment', label: 'Balance adjustment', note: 'Bank reconciliation' }] } as any);
  await render(AccountDetailScreen);
  const row = renderer!.root.findByType(ListRow);
  expect(row.props.subtitle).toContain('Meezan Bank · Bank reconciliation ·');
  expect(row.props.subtitle).not.toContain('Balance adjustment');
});

test('nonzero archive shows the balance warning and never calls archive service', async () => {
  await render(AccountDetailScreen);
  await act(async () => secondary('Archive Account').props.onPress());
  expect(mockDialog.showDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'Account still has money', message: expect.stringContaining('Rs. 10') }));
  expect(archiveAccount).not.toHaveBeenCalled();
});

test('zero account archive confirms once, preserves the screen and refreshes', async () => {
  jest.mocked(readAccountSnapshot).mockResolvedValue({ account: { ...account }, currentBalanceMinor: 0, activity: [] } as any);
  await render(AccountDetailScreen);
  await act(async () => secondary('Archive Account').props.onPress());
  expect(mockDialog.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Archive account?', confirmText: 'Archive' }));
  expect(archiveAccount).toHaveBeenCalledWith(mockData.db, 'bank', account.updated_at);
  expect(mockData.refresh).toHaveBeenCalledTimes(1);
});

test('archived Account Detail remains readable and removes lifecycle actions', async () => {
  jest.mocked(readAccountSnapshot).mockResolvedValue({ account: { ...account, is_archived: 1 }, currentBalanceMinor: 0, activity: [{ ...activity }] } as any);
  await render(AccountDetailScreen);
  expect(JSON.stringify(renderer!.toJSON())).toContain('Archived');
  expect(renderer!.root.findAllByType(PrimaryButton).map((node) => node.props.title)).toEqual(['Restore Account']);
  expect(renderer!.root.findAllByType(SecondaryButton)).toHaveLength(0);
  expect(renderer!.root.findAllByType(ListRow)).toHaveLength(1);
});

test('restore refreshes same-ID Account Detail without adjustments and duplicate names get clear feedback', async () => {
  const archived = { account: { ...account, is_archived: 1 }, currentBalanceMinor: 0, activity: [{ ...activity }] } as any;
  jest.mocked(readAccountSnapshot).mockResolvedValueOnce(archived).mockResolvedValue({ ...archived, account });
  await render(AccountDetailScreen);
  await act(async () => renderer!.root.findByType(PrimaryButton).props.onPress());
  expect(restoreAccount).toHaveBeenCalledWith(mockData.db, account.id, account.updated_at);
  expect(adjustAccountBalance).not.toHaveBeenCalled();
  expect(renderer!.root.findByType(PrimaryButton).props.title).toBe('Edit Account');
  await act(async () => renderer!.unmount());
  jest.mocked(readAccountSnapshot).mockResolvedValue(archived);
  jest.mocked(restoreAccount).mockRejectedValue(new Error('ACCOUNT_NAME_EXISTS'));
  await render(AccountDetailScreen);
  await act(async () => renderer!.root.findByType(PrimaryButton).props.onPress());
  expect(mockDialog.showDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'Duplicate account' }));
  expect(renderer!.root.findByType(PrimaryButton).props.title).toBe('Restore Account');
});

test('archived account control appears only when records exist and opens original stable Account ID', async () => {
  await render(ArchivedAccountsPanel);
  expect(renderer!.root.findAllByType(SecondaryButton).map((node) => node.props.title)).not.toContain('Show archived accounts');
  jest.mocked(listArchivedAccounts).mockResolvedValue([{ ...account, is_archived: 1 }]);
  await act(async () => { mockData.accounts = [...mockData.accounts]; renderer!.update(createElement(ArchivedAccountsPanel, { navigation: mockNavigation })); });
  await act(async () => secondary('Show archived accounts').props.onPress());
  await act(async () => renderer!.root.findByType(ListRow).props.onPress());
  expect(mockNavigation.navigate).toHaveBeenCalledWith('AccountDetail', { accountId: 'bank' });
  jest.mocked(listArchivedAccounts).mockResolvedValue([]);
  await act(async () => { mockData.accounts = [...mockData.accounts]; renderer!.update(createElement(ArchivedAccountsPanel, { navigation: mockNavigation })); });
  expect(renderer!.root.findAllByType(SecondaryButton).map((node) => node.props.title)).not.toContain('Show archived accounts');
  expect(renderer!.root.findAllByType(ListRow).length).toBe(0);
});

test('Edit Account keeps type read-only and submits a trimmed rename', async () => {
  await render(AccountEditScreen);
  expect(JSON.stringify(renderer!.toJSON())).toContain('existing history stays clear');
  await act(async () => field('Account name').props.onChangeText('  HBL  '));
  await act(async () => renderer!.root.findByType(PrimaryButton).props.onPress());
  expect(renameAccount).toHaveBeenCalledWith(mockData.db, 'bank', account.updated_at, '  HBL  ', account.currency);
  expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
});

test('Adjust Balance previews a signed correction and confirms neutrality before writing', async () => {
  await render(AccountAdjustScreen);
  await act(async () => field('Actual account balance').props.onChangeText('-5'));
  await act(async () => field('Reason optional').props.onChangeText('Bank reconciliation'));
  expect(JSON.stringify(renderer!.toJSON())).toContain('Adjustment');
  await act(async () => renderer!.root.findByType(PrimaryButton).props.onPress());
  expect(mockDialog.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('not income, expense') }));
  expect(mockDialog.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('negative balance') }));
  expect(adjustAccountBalance).toHaveBeenCalledWith(mockData.db, 'bank', -500, 'Bank reconciliation');
});

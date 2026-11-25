/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import * as SQLite from 'expo-sqlite';
import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { FlatList, Text } from 'react-native';
import { openAppDatabase, type AppDb } from '../database/database';
import * as repo from '../database/repositories/repositories';
import { GroupDetailScreen, GroupEditScreen, GroupListPanel, GroupReconcileScreen, GroupSettleScreen } from '../navigation/GroupScreens';
import { ActivityDetailScreen } from '../navigation/ActivityScreens';
import { ListRow, PrimaryButton, SecondaryButton, TextField } from '../components/common';
import { Picker } from '../components/forms';
import { archiveGroup, readGroupSnapshot, saveGroupDetails, settleGroup } from '../services/groups/GroupService';
import { saveSharedExpensePosting } from '../services/sharedExpense/SharedExpenseService';
import { addDays, todayLocal } from '../utils/date';
import type { Account, Group, Person, PersonEntry } from '../types/models';

const mockNavigation = { addListener: jest.fn(), isFocused: () => true, canGoBack: () => true, goBack: jest.fn(), navigate: jest.fn(), dispatch: jest.fn() };
const mockDialog = { confirm: jest.fn(), showDialog: jest.fn(), showSuccess: jest.fn() };
const mockConfirmOutflow = jest.fn();
let mockFocused = true;
const mockData = { db: null as AppDb | null, repo, accounts: [] as Account[], people: [] as Person[], allPeople: [] as Person[], entries: [] as PersonEntry[], groups: [] as Group[], transactions: [], settings: { currency: 'PKR', week_start: 'MONDAY' }, refresh: jest.fn() };

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('@react-navigation/native', () => ({ useNavigation: () => mockNavigation, useIsFocused: () => mockFocused }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../hooks/useAppData', () => ({ useAppData: () => mockData }));
jest.mock('../components/dialogs/AppDialogProvider', () => ({ useAppDialog: () => mockDialog }));
jest.mock('../hooks/useConfirmOutflow', () => ({ useConfirmOutflow: () => mockConfirmOutflow, useConfirmActivityChange: () => jest.fn() }));

let sqlite: DatabaseSync;
let db: AppDb;
let personId: string;
let groupId: string;
let targetId: string;
let splitId: string;
let renderer: ReactTestRenderer | undefined;

beforeEach(async () => {
  jest.clearAllMocks();
  mockFocused = true;
  mockNavigation.addListener.mockReturnValue(() => {});
  mockDialog.confirm.mockResolvedValue(true);
  mockConfirmOutflow.mockResolvedValue(true);
  sqlite = new DatabaseSync(':memory:');
  const adapter = {
    execAsync: async (sql: string) => { sqlite.exec(sql); },
    runAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).run(...params),
    getAllAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).all(...params),
    getFirstAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).get(...params) ?? null,
    withTransactionAsync: async (work: () => Promise<void>) => {
      sqlite.exec('BEGIN');
      try { await work(); sqlite.exec('COMMIT'); } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    withExclusiveTransactionAsync: async (work: (txn: AppDb) => Promise<void>) => adapter.withTransactionAsync(() => work(db)),
  };
  db = adapter as unknown as AppDb;
  jest.mocked(SQLite.openDatabaseAsync).mockResolvedValue(db);
  await openAppDatabase();
  personId = await repo.savePerson(db, 'Ali');
  groupId = await saveGroupDetails(db, { name: 'Trip', personIds: [personId] });
  const plan = await saveSharedExpensePosting(db, { title: 'Hotel', totalAmountMinor: 2000, categoryId: 'cat_expense_food', accountId: 'account_cash_default', occurredOn: todayLocal(), groupId, payerIsSelf: true, shares: [{ name: 'You', isSelf: true, shareMinor: 1000 }, { name: 'Ali', personId, isSelf: false, shareMinor: 1000 }] });
  targetId = plan.personEntries[0].id;
  splitId = plan.splitGroup.id;
  mockData.db = db;
  mockData.accounts = await repo.listAccounts(db);
  mockData.people = await repo.listPeople(db);
  mockData.allPeople = await repo.listAllPeople(db);
  mockData.entries = await repo.listPersonEntries(db);
  mockData.groups = await repo.listGroups(db);
  mockData.refresh.mockImplementation(async () => {
    mockData.entries = await repo.listPersonEntries(db);
    mockData.groups = await repo.listGroups(db);
    mockData.allPeople = await repo.listAllPeople(db);
  });
});

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  sqlite.close();
});
async function render(Component: any, params: Record<string, unknown> = { groupId, personId }) {
  await act(async () => { renderer = create(createElement(Component, { navigation: mockNavigation, route: { params } })); });
}
const field = (label: string) => renderer!.root.findAllByType(TextField).find((node) => node.props.label === label)!;
const picker = (label: string) => renderer!.root.findAllByType(Picker).find((node) => node.props.label === label)!;
const primary = (title: string) => renderer!.root.findAllByType(PrimaryButton).find((node) => node.props.title === title)!;
const secondary = (title: string) => renderer!.root.findAllByType(SecondaryButton).find((node) => node.props.title === title)!;
const text = () => renderer!.root.findAllByType(Text).map((node) => JSON.stringify(node.props.children)).join(' ');
async function earlierCash(amount = 500, type: 'RECEIVED_BACK' | 'BORROWED_FROM' = 'RECEIVED_BACK') {
  return repo.savePersonEntry(db, { person_id: personId, type, amount_minor: amount, account_id: 'account_cash_default', title: 'Earlier payment', occurred_on: todayLocal() });
}

test('list search derives owed/settled statuses and archived toggle retains detail navigation', async () => {
  const empty = await saveGroupDetails(db, { name: 'Empty', personIds: [] });
  await render(GroupListPanel);
  expect(secondary('Show archived groups')).toBeUndefined();
  let list = renderer!.root.findByType(FlatList);
  expect(list.props.data.map((s: any) => s.group.name)).toEqual(['Empty', 'Trip']);
  await act(async () => renderer!.root.findByType(TextField).props.onChangeText('tri'));
  list = renderer!.root.findByType(FlatList);
  expect(list.props.data).toHaveLength(1);
  const row = list.props.renderItem({ item: list.props.data[0] });
  expect(row.props.subtitle).toContain('2 members');
  expect(row.props.subtitle).toContain('You are owed Rs. 10');
  await act(async () => row.props.onPress());
  expect(mockNavigation.navigate).toHaveBeenCalledWith('GroupDetail', { groupId });
  await act(async () => renderer!.root.findByType(TextField).props.onChangeText(''));
  const emptyRow = renderer!.root.findByType(FlatList).props.data.find((s: any) => s.group.id === empty);
  expect(renderer!.root.findByType(FlatList).props.renderItem({ item: emptyRow }).props.subtitle).toContain('Settled');
  const snapshot = await readGroupSnapshot(db, groupId);
  await archiveGroup(db, groupId, snapshot.group.updated_at);
  await act(async () => { await mockData.refresh(); renderer!.update(createElement(GroupListPanel, { navigation: mockNavigation })); });
  expect(renderer!.root.findByType(FlatList).props.data.map((s: any) => s.group.id)).toEqual([empty]);
  await act(async () => secondary('Show archived groups').props.onPress());
  expect(renderer!.root.findByType(FlatList).props.data.map((s: any) => s.group.id)).toEqual([groupId]);
});

test('ordinary focus refresh preserves visible groups without native spinner, including failed reads', async () => {
  await render(GroupListPanel);
  const before = renderer!.root.findByType(FlatList).props.data.map((row: any) => row.group.id);
  let release!: (value: Group[]) => void;
  const load = jest.spyOn(repo, 'listGroups').mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  await act(async () => { mockFocused = false; renderer!.update(createElement(GroupListPanel, { navigation: mockNavigation })); });
  await act(async () => { mockFocused = true; renderer!.update(createElement(GroupListPanel, { navigation: mockNavigation })); });
  expect(renderer!.root.findByType(FlatList).props.data.map((row: any) => row.group.id)).toEqual(before);
  expect(renderer!.root.findByType(FlatList).props.refreshing).toBe(false);
  await act(async () => release(mockData.groups));
  load.mockRejectedValueOnce(new Error('read failure'));
  await act(async () => { mockData.groups = [...mockData.groups]; renderer!.update(createElement(GroupListPanel, { navigation: mockNavigation })); });
  expect(renderer!.root.findByType(FlatList).props.data.map((row: any) => row.group.id)).toEqual(before);
  expect(secondary('Retry')).toBeDefined();
  load.mockRestore();
});

test('People/Groups visibility switching retains panel snapshot and returns without a first-load message', async () => {
  await render(GroupListPanel);
  const ids = renderer!.root.findByType(FlatList).props.data.map((row: any) => row.group.id);
  await act(async () => renderer!.update(createElement(GroupListPanel, { navigation: mockNavigation, active: false })));
  expect(renderer!.root.findAllByType(FlatList).length).toBe(0);
  let release!: (groups: Group[]) => void;
  const read = jest.spyOn(repo, 'listGroups').mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  await act(async () => renderer!.update(createElement(GroupListPanel, { navigation: mockNavigation, active: true })));
  expect(renderer!.root.findByType(FlatList).props.data.map((row: any) => row.group.id)).toEqual(ids);
  expect(renderer!.root.findByType(FlatList).props.refreshing).toBe(false);
  expect(renderer!.root.findByType(FlatList).props.ListEmptyComponent.props.title).not.toBe('Loading groups...');
  await act(async () => release(mockData.groups));
  read.mockRestore();
});

test('ledger-first net settlement shows chronology/gross/direction and requires explicit offset confirmation', async () => {
  await saveSharedExpensePosting(db, { title: 'Dinner', totalAmountMinor: 600, categoryId: 'cat_expense_food', accountId: 'account_cash_default', occurredOn: addDays(todayLocal(), -1), groupId, payerIsSelf: false, payerPersonId: personId, shares: [{ name: 'You', isSelf: true, shareMinor: 300 }, { name: 'Ali', personId, isSelf: false, shareMinor: 300 }] });
  await render(GroupSettleScreen);
  expect(field('Amount being settled').props.value).toBe('7');
  expect(text().indexOf('Dinner')).toBeLessThan(text().indexOf('Hotel'));
  expect(text()).toContain('You owe Ali');
  expect(text()).toContain('Ali owes you');
  const before = await repo.listPersonEntries(db);
  const transactions = await repo.listTransactions(db);
  mockDialog.confirm.mockResolvedValueOnce(false);
  await act(async () => primary('Record Settlement').props.onPress());
  expect(await repo.listPersonEntries(db)).toEqual(before);
  expect(mockDialog.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Confirm net settlement', message: expect.stringContaining('offset Rs. 3') }));
  await act(async () => field('Note').props.onChangeText('Confirmed receipt'));
  await act(async () => primary('Record Settlement').props.onPress());
  expect((await repo.listPersonEntries(db)).filter((entry) => !entry.split_group_id)).toMatchObject([{ amount_minor: 700, note: 'Confirmed receipt' }]);
  expect(await repo.listTransactions(db)).toEqual(transactions);
  expect((await readGroupSnapshot(db, groupId)).positions.find((position) => position.personId === personId)).toMatchObject({ owedMinor: 0, oweMinor: 0 });
});

test('group detail shows payer/shares, ambiguity routes to reconciliation, archive warns and preserves history', async () => {
  await earlierCash();
  await render(GroupDetailScreen);
  expect(text()).toContain('Reconciliation needed');
  expect(text()).toContain('You from Cash');
  expect(text()).toContain('Hotel');
  await act(async () => secondary('Review money with Ali').props.onPress());
  expect(mockNavigation.navigate).toHaveBeenCalledWith('GroupReconcile', { groupId, personId, currency: 'PKR' });
  await act(async () => secondary('Archive Group').props.onPress());
  expect(mockDialog.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('open or unreconciled amounts') }));
  expect((await readGroupSnapshot(db, groupId)).group.is_archived).toBe(1);
  expect(renderer!.root.findAllByType(PrimaryButton).some((node) => node.props.title === 'Add Group Expense')).toBe(false);
  expect(text()).toContain('Hotel');
  expect(mockDialog.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Archiving does not settle balances or move any money.') }));
  expect(secondary('Review earlier money / reconciliation')).toBeUndefined();
  const before = await repo.listPersonEntries(db);
  await act(async () => primary('Restore Group').props.onPress());
  expect((await readGroupSnapshot(db, groupId)).group.is_archived).toBe(0);
  expect(await repo.listPersonEntries(db)).toEqual(before);
  expect(primary('Add Group Expense')).toBeDefined();
});

test.each([GroupEditScreen, GroupReconcileScreen, GroupSettleScreen])('archived group mutation route %p renders read-only instead of editable controls', async (Component) => {
  const snapshot = await readGroupSnapshot(db, groupId);
  await archiveGroup(db, groupId, snapshot.group.updated_at);
  await render(Component);
  expect(renderer!.root.findAllByType(TextField).length).toBe(0);
  expect(renderer!.root.findAllByType(PrimaryButton).length).toBe(0);
  expect(text()).toContain('Restore');
});

test('member multiselect and inline draft save atomically, removal keeps historical participant', async () => {
  await render(GroupEditScreen);
  await act(async () => field('Group name').props.onChangeText('Renamed Trip'));
  await act(async () => secondary('Add Member').props.onPress());
  const ali = renderer!.root.findAll((node) => node.props.accessibilityRole === 'checkbox' && node.props.accessibilityLabel === 'Ali' && typeof node.props.onPress === 'function')[0];
  expect(ali).toBeUndefined();
  await act(async () => primary('Done').props.onPress());
  await act(async () => renderer!.root.findAll((node) => node.props.accessibilityLabel === 'Remove member Ali' && typeof node.props.onPress === 'function')[0].props.onPress());
  await act(async () => field('New person name').props.onChangeText('Sam'));
  await act(async () => secondary('Add Person').props.onPress());
  expect((await repo.listPeople(db)).some((p) => p.name === 'Sam')).toBe(false);
  await act(async () => primary('Save Group').props.onPress());
  const snapshot = await readGroupSnapshot(db, groupId);
  expect(snapshot.members.map((m) => m.name).sort()).toEqual(['Sam', 'You']);
  expect(snapshot.participants.some((p) => p.person_id === personId && p.name === 'Ali')).toBe(true);
  expect(snapshot.group.name).toBe('Renamed Trip');
  expect(mockNavigation.goBack).toHaveBeenCalled();
});

test('reconciliation requires explicit source/target/amount, rejects invalid amounts before confirm and changes no money', async () => {
  const sourceId = await earlierCash(800);
  const before = await repo.listPersonEntries(db);
  const txBefore = await repo.listTransactions(db);
  await render(GroupReconcileScreen);
  expect(picker('Earlier cash payment').props.value).toBe('');
  expect(picker('Shared obligation').props.value).toBe('');
  expect(primary('Apply Existing Money (No Cash Movement)').props.disabled).toBe(true);
  await act(async () => picker('Earlier cash payment').props.setValue(sourceId));
  await act(async () => picker('Shared obligation').props.setValue(targetId));
  await act(async () => field('Amount to apply').props.onChangeText('8.001'));
  await act(async () => primary('Apply Existing Money (No Cash Movement)').props.onPress());
  expect(mockDialog.confirm).not.toHaveBeenCalled();
  expect(field('Amount to apply').props.value).toBe('8.001');
  await act(async () => field('Amount to apply').props.onChangeText('5'));
  await act(async () => primary('Apply Existing Money (No Cash Movement)').props.onPress());
  const snapshot = await readGroupSnapshot(db, groupId);
  expect(snapshot.targets[0].remaining_minor).toBe(500);
  expect(snapshot.ambiguous).toBe(true);
  expect(await repo.listPersonEntries(db)).toEqual(before);
  expect(await repo.listTransactions(db)).toEqual(txBefore);
  expect(picker('Earlier cash payment').props.value).toBe('');
});

test('explicit unrelated intent resolves a manual loan without guessing or creating cash', async () => {
  const sourceId = await earlierCash(8000, 'BORROWED_FROM');
  const before = await repo.listPersonEntries(db);
  await render(GroupReconcileScreen);
  await act(async () => picker('Earlier cash payment').props.setValue(sourceId));
  await act(async () => picker('Shared obligation').props.setValue(targetId));
  await act(async () => secondary('Remaining Money Was Unrelated to This Obligation').props.onPress());
  expect((await readGroupSnapshot(db, groupId)).ambiguous).toBe(false);
  expect(await repo.listPersonEntries(db)).toEqual(before);
  expect(await db.getAllAsync('SELECT * FROM entry_allocations;')).toEqual([]);
  const row = renderer!.root.findAllByType(ListRow).find((node) => node.props.subtitle?.includes('Marked unrelated'))!;
  await act(async () => row.props.onPress());
  expect((await readGroupSnapshot(db, groupId)).ambiguous).toBe(true);
});

test('settlement prefills full direction, permits partial, and locks duplicate submits while confirmation is pending', async () => {
  await render(GroupSettleScreen);
  const amountField = field('Amount being settled');
  expect(amountField.props.value).toBe('10');
  expect(picker('Account receiving payment').props.value).toBe('account_cash_default');
  await act(async () => amountField.props.onChangeText('4'));
  let finish!: (value: boolean) => void;
  mockDialog.confirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  let saving!: Promise<void>;
  await act(async () => { saving = primary('Record Settlement').props.onPress(); });
  expect(primary('Record Settlement').props.saving).toBe(true);
  await act(async () => primary('Record Settlement').props.onPress());
  await act(async () => { finish(true); await saving; });
  expect((await readGroupSnapshot(db, groupId)).balanceMinor).toBe(600);
  expect(await db.getAllAsync('SELECT * FROM group_settlement_requests;')).toHaveLength(1);
  expect(await repo.listPersonEntries(db)).toHaveLength(2);
  expect(mockConfirmOutflow).not.toHaveBeenCalled();
});

test('unsafe settlement is visibly disabled and archived groups stay readable', async () => {
  await earlierCash();
  await render(GroupSettleScreen);
  expect(primary('Record Settlement').props.disabled).toBe(true);
  await act(async () => secondary('Review Earlier Money').props.onPress());
  expect(mockNavigation.navigate).toHaveBeenCalledWith('GroupReconcile', { groupId, personId });
  expect(await db.getAllAsync('SELECT * FROM group_settlement_requests;')).toEqual([]);
});

test('failed settlement preserves input; post-commit refresh failure retries reads only', async () => {
  await render(GroupSettleScreen);
  sqlite.exec("CREATE TRIGGER injected BEFORE INSERT ON entry_allocations BEGIN SELECT RAISE(ABORT,'injected'); END;");
  await act(async () => primary('Record Settlement').props.onPress());
  expect(field('Amount being settled').props.value).toBe('10');
  expect(await repo.listPersonEntries(db)).toHaveLength(1);
  sqlite.exec('DROP TRIGGER injected;');
  mockData.refresh.mockRejectedValueOnce(new Error('Read failed'));
  await act(async () => primary('Record Settlement').props.onPress());
  expect(await repo.listPersonEntries(db)).toHaveLength(2);
  const failedRefresh = mockDialog.showDialog.mock.calls.find(([options]) => options.title === 'Saved, but refresh failed')![0];
  await act(async () => failedRefresh.actions.find((action: any) => action.text === 'Retry refresh').onPress());
  expect(await repo.listPersonEntries(db)).toHaveLength(2);
});

test('allocated Activity shows one source with group portions and actual global label; shared locked detail keeps verified payer', async () => {
  const snapshot = await readGroupSnapshot(db, groupId);
  const sourceId = await settleGroup(db, { requestId: 'activity', groupId, personId, accountId: 'account_cash_default', occurredOn: todayLocal(), targets: [{ targetEntryId: targetId, amountMinor: 1000 }], expectedRevision: snapshot.revision, expectedBalanceMinor: 1000 });
  await render(ActivityDetailScreen, { kind: 'person', sourceId });
  expect(text()).toContain('Payment received for shared bills');
  expect(text()).toContain('Global People label:');
  expect(text()).toContain('Received');
  expect(renderer!.root.findAllByType(ListRow)).toHaveLength(1);
  await act(async () => renderer!.root.findByType(ListRow).props.onPress());
  expect(mockNavigation.navigate).toHaveBeenCalledWith('GroupDetail', { groupId });
  await act(async () => renderer!.unmount()); renderer = undefined;
  await render(ActivityDetailScreen, { kind: 'shared', sourceId: splitId });
  expect(text()).not.toContain('Unverified older record');
  expect(text()).toContain('Who paid');
  expect(renderer!.root.findAllByType(PrimaryButton)).toHaveLength(0);
});

test('payment-out direction uses the outflow warning, cancellation saves nothing, and global-zero payment remains Given', async () => {
  await saveSharedExpensePosting(db, { title: 'Ali paid dinner', totalAmountMinor: 2000, categoryId: 'cat_expense_food', accountId: 'account_cash_default', occurredOn: todayLocal(), groupId, payerIsSelf: false, payerPersonId: personId, shares: [{ name: 'You', isSelf: true, shareMinor: 1000 }, { name: 'Ali', personId, isSelf: false, shareMinor: 1000 }] });
  await render(GroupSettleScreen);
  await act(async () => secondary('Customize settlement').props.onPress());
  await act(async () => picker('Settlement method').props.setValue('BILLS'));
  await act(async () => picker('Payment direction').props.setValue('-1'));
  mockConfirmOutflow.mockResolvedValueOnce(false);
  await act(async () => primary('Record Settlement').props.onPress());
  expect(mockConfirmOutflow).toHaveBeenCalledWith('account_cash_default', 1000);
  expect(await repo.listPersonEntries(db)).toHaveLength(2);
  await act(async () => primary('Record Settlement').props.onPress());
  const source = (await repo.listPersonEntries(db)).find((e) => !e.split_group_id)!;
  expect(source.type).toBe('GIVEN');
  expect(source.amount_minor).toBe(1000);
  expect((await readGroupSnapshot(db, groupId)).positions[0].oweMinor).toBe(0);
});

test('automatic settlement prefill is clean; user edits require the existing dirty-form confirmation', async () => {
  await render(GroupSettleScreen);
  const event = { preventDefault: jest.fn(), data: { action: { type: 'GO_BACK' } } };
  const beforeRemove = () => mockNavigation.addListener.mock.calls.filter(([name]) => name === 'beforeRemove').at(-1)![1] as unknown as (event: unknown) => void;
  await act(async () => beforeRemove()(event));
  expect(event.preventDefault).not.toHaveBeenCalled();
  await act(async () => field('Amount being settled').props.onChangeText('5'));
  mockDialog.confirm.mockResolvedValueOnce(false);
  await act(async () => beforeRemove()(event));
  expect(event.preventDefault).toHaveBeenCalled();
  expect(mockDialog.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Discard changes?' }));
  expect(mockNavigation.dispatch).not.toHaveBeenCalled();
});

/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import * as SQLite from 'expo-sqlite';
import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';
import { openAppDatabase, type AppDb } from '../database/database';
import * as repo from '../database/repositories/repositories';
import { TransactionFormScreen } from '../navigation/AppNavigator';
import { SplitScreen } from '../navigation/SplitScreen';
import { PrimaryButton, TextField } from '../components/common';
import { Picker } from '../components/forms';
import * as sharedService from '../services/sharedExpense/SharedExpenseService';
import * as transactionService from '../services/finance/TransactionService';
import { readSharedEvent } from '../services/activity/ActivityService';
import { calculateAccountBalance } from '../services/finance/FinanceService';
import type { Account, Category, Person, TransactionType } from '../types/models';

const mockNavigation = {
  addListener: jest.fn(), isFocused: () => true, canGoBack: () => true,
  goBack: jest.fn(), popTo: jest.fn(), dispatch: jest.fn(),
};
const mockDialog = { confirm: jest.fn(), showDialog: jest.fn(), showSuccess: jest.fn() };
const mockData = {
  db: null as AppDb | null, repo, refresh: jest.fn(),
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

let sqlite: DatabaseSync;
let db: AppDb;
let renderer: ReactTestRenderer | undefined;
let failOn: string | null;
let bank: string;
let person: string;
let beforeRemove: (event: { preventDefault: () => void; data: { action: object } }) => void;
const cash = 'account_cash_default';
const food = 'cat_expense_food';
const day = '2026-09-12';

beforeEach(async () => {
  jest.clearAllMocks();
  sqlite = new DatabaseSync(':memory:');
  failOn = null;
  const adapter = {
    execAsync: async (sql: string) => { sqlite.exec(sql); },
    runAsync: async (sql: string, ...params: (string | number | null)[]) => {
      if (failOn && sql.includes(failOn)) throw new Error('Disk full');
      return sqlite.prepare(sql).run(...params);
    },
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
  await repo.createAccount(db, { name: 'My bank', type: 'BANK', opening_balance_minor: 0 });
  bank = (await repo.listAccounts(db)).find((a) => a.name === 'My bank')!.id;
  person = await repo.savePerson(db, 'Ali');
  mockData.db = db;
  mockData.accounts = await repo.listAccounts(db);
  mockData.categories = await repo.listCategories(db);
  mockData.people = await repo.listPeople(db);
  mockData.allPeople = await repo.listAllPeople(db);
  mockData.refresh.mockResolvedValue(undefined);
  mockDialog.confirm.mockResolvedValue(true);
  mockNavigation.addListener.mockImplementation((_name, listener) => { beforeRemove = listener; return () => {}; });
  jest.spyOn(transactionService, 'updateTransaction');
  jest.spyOn(sharedService, 'updateSharedExpense');
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  sqlite.close();
  jest.restoreAllMocks();
});

const field = (label: string) => renderer!.root.findAllByType(TextField).find((node) => node.props.label === label)!;
async function enter(label: string, value: string) { await act(async () => field(label).props.onChangeText(value)); }
async function select(label: string, value: string) {
  await act(async () => renderer!.root.findAllByType(Picker).find((node) => node.props.label === (label === 'Paid by' ? 'Payer' : label))!.props.setValue(label === 'Paid by' && value !== 'SELF' ? `PERSON:${value}` : value));
}
async function chooseMethod(value: string) {
  await act(async () => renderer!.root.findAll((node) => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === `${value} split`)[0].props.onPress());
}
async function toggleParticipant(label: string) {
  await act(async () => renderer!.root.findByProps({ accessibilityLabel: 'Select participants' }).props.onPress());
  await act(async () => renderer!.root.findAll((node) => node.props.accessibilityRole === 'checkbox' && node.props.accessibilityLabel === label)[0].props.onPress());
  await act(async () => renderer!.root.findAllByType(PrimaryButton).find((node) => node.props.title === 'Done')!.props.onPress());
}
async function save() { await act(async () => renderer!.root.findByType(PrimaryButton).props.onPress()); }
function snapshot() {
  return JSON.stringify(['transactions', 'person_entries', 'split_groups', 'split_participants', 'people'].map((table) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()));
}
async function balance(id: string) {
  return calculateAccountBalance(mockData.accounts.find((a) => a.id === id)!, await repo.listTransactions(db), await repo.listPersonEntries(db));
}
async function ordinary(type: TransactionType = 'EXPENSE') {
  const id = await repo.saveTransaction(db, {
    type, amount_minor: 1000, account_id: cash, destination_account_id: type === 'TRANSFER' ? bank : null,
    category_id: type === 'TRANSFER' ? null : type === 'INCOME' ? 'cat_income_salary' : food,
    title: 'Original', note: 'Original note', occurred_on: day, source: 'MANUAL',
  });
  const transaction = (await repo.listTransactions(db)).find((t) => t.id === id)!;
  await act(async () => { renderer = create(createElement(TransactionFormScreen, { navigation: mockNavigation, route: { params: { transaction } } })); });
  return transaction;
}
async function shared(overrides: Partial<sharedService.SharedExpensePostingInput> = {}) {
  const plan = await sharedService.saveSharedExpensePosting(db, {
    title: 'Dinner', totalAmountMinor: 10000, categoryId: food, accountId: cash, occurredOn: day, payerIsSelf: true,
    shares: [{ name: 'You', isSelf: true, shareMinor: 4000 }, { name: 'Ali', personId: person, isSelf: false, shareMinor: 6000 }], ...overrides,
  });
  const records = await readSharedEvent(db, plan.splitGroup.id);
  mockData.people = await repo.listPeople(db);
  mockData.allPeople = await repo.listAllPeople(db);
  await act(async () => { renderer = create(createElement(SplitScreen, { navigation: mockNavigation, route: { params: { shared: records } } })); });
  return records;
}

test.each(['EXPENSE', 'INCOME', 'TRANSFER'] as const)('rendered %s editor saves corrections through real service and refreshes detail', async (type) => {
  const original = await ordinary(type);
  expect(field('Amount').props.value).toBe('10');
  expect(field('Note optional').props.value).toBe('Original note');
  await enter('Amount', '25.50');
  await enter('Description', 'Corrected');
  await enter('Date', '31-08-2026');
  await enter('Note optional', 'Corrected note');
  await select('Account', bank);
  if (type === 'TRANSFER') await select('To Account', cash);
  else if (type === 'EXPENSE') await select('Category', 'cat_expense_fuel');
  await save();
  const saved = (await repo.listTransactions(db))[0];
  expect(saved).toMatchObject({ id: original.id, type, amount_minor: 2550, title: 'Corrected', note: 'Corrected note', occurred_on: '2026-08-31', account_id: bank, destination_account_id: type === 'TRANSFER' ? cash : null });
  expect(await balance(cash)).toBe(type === 'TRANSFER' ? 2550 : 0);
  expect(await balance(bank)).toBe(type === 'INCOME' ? 2550 : -2550);
  expect(transactionService.updateTransaction).toHaveBeenCalledTimes(1);
  expect(mockNavigation.popTo).toHaveBeenCalledWith('ActivityDetail', { kind: 'transaction', sourceId: original.id });
  expect(mockData.refresh).toHaveBeenCalledTimes(1);
  expect(mockDialog.showSuccess).toHaveBeenCalledWith('Activity updated');
});

test.each(['EXPENSE', 'INCOME', 'TRANSFER'] as const)('%s failed save keeps input and can retry without losing endpoints', async (type) => {
  await ordinary(type);
  await enter('Description', 'Keep this');
  await select('Account', bank);
  if (type === 'TRANSFER') await select('To Account', cash);
  const before = snapshot();
  failOn = 'UPDATE transactions';
  await save();
  expect(snapshot()).toBe(before);
  expect(field('Description').props.value).toBe('Keep this');
  expect(mockNavigation.popTo).not.toHaveBeenCalled();
  expect(mockData.refresh).not.toHaveBeenCalled();
  expect(mockDialog.showDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not save', message: 'Disk full' }));
  failOn = null;
  await save();
  expect((await repo.listTransactions(db))[0]).toMatchObject({ title: 'Keep this', account_id: bank, destination_account_id: type === 'TRANSFER' ? cash : null });
});

test('stale ordinary record reports real service error and preserves correction', async () => {
  const original = await ordinary();
  await db.runAsync('UPDATE transactions SET updated_at = ? WHERE id = ?;', '2026-10-01T00:00:00.000Z', original.id);
  await enter('Description', 'Unsaved correction');
  const before = snapshot();
  await save();
  expect(snapshot()).toBe(before);
  expect(field('Description').props.value).toBe('Unsaved correction');
  expect(mockDialog.showDialog).toHaveBeenCalledWith(expect.objectContaining({ message: 'Activity changed. Reopen it before editing.' }));
  expect(mockNavigation.popTo).not.toHaveBeenCalled();
});

test.each(['ordinary', 'shared'])('%s actual form protects dirty navigation but not pristine navigation', async (kind) => {
  if (kind === 'ordinary') await ordinary(); else await shared();
  const event = { preventDefault: jest.fn(), data: { action: { type: 'GO_BACK' } } };
  await act(async () => beforeRemove(event));
  expect(event.preventDefault).not.toHaveBeenCalled();
  await enter('Description', 'Keep editing');
  mockDialog.confirm.mockResolvedValueOnce(false);
  await act(async () => beforeRemove(event));
  expect(event.preventDefault).toHaveBeenCalled();
  expect(mockNavigation.dispatch).not.toHaveBeenCalled();
  expect(field('Description').props.value).toBe('Keep editing');
  expect(mockDialog.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Discard changes?' }));
  await act(async () => beforeRemove(event));
  expect(mockNavigation.dispatch).toHaveBeenCalledWith(event.data.action);
});

test.each(['Smith, Jr', 'Me', 'You'])('shared edit preserves Person identity named %s independent of display names', async (name) => {
  person = await repo.savePerson(db, name);
  const original = await shared({ shares: [{ name: 'You', isSelf: true, shareMinor: 4000 }, { name, personId: person, isSelf: false, shareMinor: 6000 }] });
  const personLabel = /^(?:me|you)$/i.test(name) ? `${name} (person)` : name;
  expect(renderer!.root.findAllByType(TextField).some((node) => node.props.label === 'Participants')).toBe(false);
  expect(field('You amount').props.value).toBe('40');
  expect(field(`${personLabel} amount`).props.value).toBe('60');
  const text = renderer!.root.findAllByType(Text).map((node) => node.props.children).flat().join(' ');
  expect(text).toContain(name);
  expect(text).not.toContain(person);
  // A Person rename while editing must not rebind the saved identity by name.
  await db.runAsync('UPDATE people SET name = ? WHERE id = ?;', 'Renamed person', person);
  await enter('Description', 'Corrected title');
  await enter('You amount', '30');
  await enter(`${personLabel} amount`, '70');
  await save();
  const saved = await readSharedEvent(db, original.split.id);
  expect(saved.participants.find((p) => !p.is_self)).toMatchObject({ person_id: person, is_self: 0, share_minor: 7000 });
  expect(saved.participants.filter((p) => p.is_self)).toHaveLength(1);
  expect(saved.entries[0]).toMatchObject({ person_id: person, amount_minor: 7000 });
  expect(saved.split.title).toBe('Corrected title');
  expect(mockData.refresh).toHaveBeenCalledTimes(1);
  expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
  expect(sharedService.updateSharedExpense).toHaveBeenCalledTimes(1);
});

test.each([true, false])('one-participant modern edit supports title/date/Exact correction (self=%s)', async (isSelf) => {
  const original = await shared({ payerIsSelf: isSelf, payerPersonId: isSelf ? null : person, shares: [{ name: isSelf ? 'You' : 'Ali', isSelf, personId: isSelf ? undefined : person, shareMinor: 10000 }] });
  expect(renderer!.root.findByType(PrimaryButton).props.disabled).toBe(true);
  await enter('Description', 'Solo correction');
  expect(renderer!.root.findByType(PrimaryButton).props.disabled).toBe(false);
  await enter('Date', '31-08-2026');
  await enter('Total Amount', '125');
  await enter(`${isSelf ? 'You' : 'Ali'} amount`, '125');
  await save();
  const saved = await readSharedEvent(db, original.split.id);
  expect(saved.split).toMatchObject({ title: 'Solo correction', total_amount_minor: 12500, occurred_on: '2026-08-31' });
  expect(saved.participants).toHaveLength(1);
  expect(saved.participants[0]).toMatchObject({ is_self: Number(isSelf), person_id: isSelf ? null : person, share_minor: 12500 });
});

test.each([['Equal', ''], ['Percentage', '100'], ['Shares', '0.5']])('one-participant edit accepts valid %s without introducing a person', async (method, values) => {
  const original = await shared({ shares: [{ name: 'You', isSelf: true, shareMinor: 10000 }] });
  await chooseMethod(method);
  if (values) await enter(`You ${method.toLowerCase()}`, values);
  await save();
  expect((await readSharedEvent(db, original.split.id)).participants).toHaveLength(1);
  expect(sharedService.updateSharedExpense).toHaveBeenCalledTimes(1);
});

test.each([
  ['Exact', '100', 'nope'], ['Exact', '100', ''], ['Exact', '100', '-0'], ['Exact', '99.999', '0.001'], ['Exact', '40', '50'], ['Exact', '40', '70'],
  ['Percentage', '100', 'nope'], ['Percentage', '100', ''], ['Percentage', '100', '-0'], ['Percentage', '0x32', '50'], ['Percentage', '1e2', '1'], ['Percentage', 'Infinity', '1'], ['Percentage', '40', '50'], ['Percentage', '40', '70'],
  ['Shares', '1', 'nope'], ['Shares', '1', ''], ['Shares', '1', '-1'], ['Shares', '0', '0'], ['Shares', 'NaN', '1'],
])('%s rejects invalid per-person values %s/%s before service', async (method, selfValue, personValue) => {
  await shared();
  await chooseMethod(method);
  const suffix = method === 'Exact' ? 'amount' : method.toLowerCase();
  await enter(`You ${suffix}`, selfValue);
  await enter(`Ali ${suffix}`, personValue);
  const before = snapshot();
  expect(renderer!.root.findByType(PrimaryButton).props.disabled).toBe(true);
  // Even a retained callback cannot bypass the submit-time validation.
  await save();
  expect(sharedService.updateSharedExpense).not.toHaveBeenCalled();
  expect(snapshot()).toBe(before);
  expect(field(`You ${suffix}`).props.value).toBe(selfValue);
  expect(field(`Ali ${suffix}`).props.value).toBe(personValue);
});

test.each([['Exact', '100'], ['Percentage', '100']])('%s preserves a valid zero allocation without losing identity', async (method, selfValue) => {
  const original = await shared();
  await chooseMethod(method);
  const suffix = method === 'Exact' ? 'amount' : method.toLowerCase();
  await enter(`You ${suffix}`, selfValue);
  await enter(`Ali ${suffix}`, '0');
  await save();
  const saved = await readSharedEvent(db, original.split.id);
  expect(saved.participants.find((participant) => participant.is_self)?.share_minor).toBe(10000);
  expect(saved.participants.find((participant) => !participant.is_self)).toMatchObject({ person_id: person, share_minor: 0 });
  expect(sharedService.updateSharedExpense).toHaveBeenCalledTimes(1);
});

test('Shares rejects a zero participant weight', async () => {
  await shared();
  await chooseMethod('Shares');
  await enter('You shares', '1');
  await enter('Ali shares', '0');
  await save();
  expect(renderer!.root.findByType(PrimaryButton).props.disabled).toBe(true);
  expect(sharedService.updateSharedExpense).not.toHaveBeenCalled();
});

test.each([true, false])('shared payer changes in both directions from self=%s through existing accounting', async (payerIsSelf) => {
  const original = await shared({ payerIsSelf, payerPersonId: payerIsSelf ? null : person });
  await select('Paid by', payerIsSelf ? person : 'SELF');
  if (!payerIsSelf) await select('Paid from account', bank);
  await save();
  const saved = await readSharedEvent(db, original.split.id);
  expect(saved.split.payer_is_self).toBe(payerIsSelf ? 0 : 1);
  expect(saved.entries[0]).toMatchObject({ person_id: person, type: payerIsSelf ? 'BORROWED_FROM' : 'GIVEN', amount_minor: payerIsSelf ? 4000 : 6000 });
  expect(await balance(cash)).toBe(0);
  expect(await balance(bank)).toBe(payerIsSelf ? 0 : -10000);
});

test.each(['ordinary', 'shared'])('%s negative-balance warning cancellation never mutates and keeps input', async (kind) => {
  if (kind === 'ordinary') { await ordinary(); await enter('Amount', '200'); }
  else { await shared({ payerIsSelf: false, payerPersonId: person }); await select('Paid by', 'SELF'); }
  const before = snapshot();
  mockDialog.confirm.mockResolvedValue(false);
  await save();
  expect(mockDialog.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Cash will become negative' }));
  expect(snapshot()).toBe(before);
  expect(transactionService.updateTransaction).not.toHaveBeenCalled();
  expect(sharedService.updateSharedExpense).not.toHaveBeenCalled();
  expect(mockData.refresh).not.toHaveBeenCalled();
  expect(mockNavigation.goBack).not.toHaveBeenCalled();
  expect(mockNavigation.popTo).not.toHaveBeenCalled();
});

test('shared write failure rolls back and retains values; stale retry shows real safety error', async () => {
  const original = await shared();
  await enter('Description', 'Keep dinner');
  await enter('You amount', '20');
  await enter('Ali amount', '80');
  const before = snapshot();
  failOn = 'INSERT INTO split_participants';
  await save();
  expect(snapshot()).toBe(before);
  expect(field('Description').props.value).toBe('Keep dinner');
  expect(field('You amount').props.value).toBe('20');
  expect(field('Ali amount').props.value).toBe('80');
  expect(mockData.refresh).not.toHaveBeenCalled();
  expect(mockNavigation.goBack).not.toHaveBeenCalled();
  failOn = null;
  await db.runAsync('UPDATE split_groups SET updated_at = ? WHERE id = ?;', '2026-10-01T00:00:00.000Z', original.split.id);
  const stale = snapshot();
  await save();
  expect(snapshot()).toBe(stale);
  expect(mockDialog.showDialog).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'Activity changed. Reopen it before editing.' }));
});

test('two rendered save taps across warning commit only once', async () => {
  await ordinary();
  await enter('Amount', '200');
  let release!: (value: boolean) => void;
  mockDialog.confirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = resolve; }));
  const submit = renderer!.root.findByType(PrimaryButton).props.onPress;
  let first!: Promise<void>;
  await act(async () => { first = submit(); await submit(); });
  expect(renderer!.root.findByType(PrimaryButton).props.saving).toBe(true);
  await act(async () => { release(true); await first; });
  expect(transactionService.updateTransaction).toHaveBeenCalledTimes(1);
  expect(mockData.refresh).toHaveBeenCalledTimes(1);
});

test('two live shared-editor save taps across warning commit only once', async () => {
  await shared({ payerIsSelf: false, payerPersonId: person });
  await select('Paid by', 'SELF');
  let release!: (value: boolean) => void;
  mockDialog.confirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = resolve; }));
  const submit = renderer!.root.findByType(PrimaryButton).props.onPress;
  let first!: Promise<void>;
  await act(async () => { first = submit(); await submit(); });
  expect(renderer!.root.findByType(PrimaryButton).props.saving).toBe(true);
  await act(async () => { release(true); await first; });
  expect(sharedService.updateSharedExpense).toHaveBeenCalledTimes(1);
  expect(mockData.refresh).toHaveBeenCalledTimes(1);
});

test('shared participant correction preserves retained allocations and updates one linked event', async () => {
  const sam = await repo.savePerson(db, 'Smith, Jr');
  mockData.people = await repo.listPeople(db);
  mockData.allPeople = await repo.listAllPeople(db);
  const original = await shared();
  await toggleParticipant('Ali');
  expect(field('You amount').props.value).toBe('40');
  await toggleParticipant('Smith, Jr');
  expect(field('You amount').props.value).toBe('40');
  expect(field('Smith, Jr amount').props.value).toBe('');
  await enter('Smith, Jr amount', '60');
  await save();
  const changed = await readSharedEvent(db, original.split.id);
  expect(changed.participants.find((p) => !p.is_self)).toMatchObject({ person_id: sam, share_minor: 6000 });
  expect(changed.entries).toHaveLength(1);
  expect(changed.entries[0]).toMatchObject({ person_id: sam, amount_minor: 6000 });
  expect(changed.split.financial_event_id).toBe(original.split.financial_event_id);
  expect(await balance(cash)).toBe(-10000);
  expect((await repo.listPeople(db)).some((p) => p.id === person)).toBe(true);
});

test('removing yourself can retain a valid user-paid one-person event without personal expense', async () => {
  const original = await shared();
  await toggleParticipant('You');
  await enter('Ali amount', '100');
  await save();
  const changed = await readSharedEvent(db, original.split.id);
  expect(changed.transactions).toEqual([]);
  expect(changed.entries).toMatchObject([{ person_id: person, type: 'GIVEN', amount_minor: 10000 }]);
  expect(await balance(cash)).toBe(-10000);
});

test('removing all participants rejects stale Save callback and keeps original event', async () => {
  await shared();
  const before = snapshot();
  await toggleParticipant('You');
  await toggleParticipant('Ali');
  expect(renderer!.root.findByType(PrimaryButton).props.disabled).toBe(true);
  await save();
  expect(snapshot()).toBe(before);
  expect(sharedService.updateSharedExpense).not.toHaveBeenCalled();
  expect(mockNavigation.goBack).not.toHaveBeenCalled();
});

test('a completed edit followed by refresh failure retries reads, never the write', async () => {
  await ordinary();
  await enter('Description', 'Committed correction');
  mockData.refresh.mockRejectedValueOnce(new Error('Read failed'));
  await save();
  expect(transactionService.updateTransaction).toHaveBeenCalledTimes(1);
  expect(mockDialog.showDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'Saved, but refresh failed' }));
  const dialog = mockDialog.showDialog.mock.calls.find(([options]) => options.title === 'Saved, but refresh failed')![0];
  await act(async () => dialog.actions.find((action: { text: string }) => action.text === 'Retry refresh').onPress());
  await save();
  expect(transactionService.updateTransaction).toHaveBeenCalledTimes(1);
  expect(mockData.refresh).toHaveBeenCalledTimes(2);
  expect((await repo.listTransactions(db))[0].title).toBe('Committed correction');
});

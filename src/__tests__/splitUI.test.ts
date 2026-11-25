/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import * as SQLite from 'expo-sqlite';
import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { FlatList, Keyboard, Modal, Text, TextInput } from 'react-native';
import { openAppDatabase, type AppDb } from '../database/database';
import * as repo from '../database/repositories/repositories';
import { SplitScreen } from '../navigation/SplitScreen';
import { ActivityDetailScreen } from '../navigation/ActivityScreens';
import { GroupDetailScreen } from '../navigation/GroupScreens';
import { PersonDetailScreen } from '../navigation/AppNavigator';
import { PeopleMultiPicker } from '../components/PeopleMultiPicker';
import { KeyboardSafeScrollView } from '../components/KeyboardSafeScrollView';
import { SharedBillDetail } from '../components/SharedBillDetail';
import { calculateAccountBalance } from '../services/finance/FinanceService';
import { readPersonSnapshot } from '../services/people/PersonService';
import { calculatePersonBalance } from '../services/people/PeopleBalanceService';
import { PrimaryButton, SecondaryButton, TextField } from '../components/common';
import { Picker } from '../components/forms';
import { listActivity, readSharedEvent } from '../services/activity/ActivityService';
import { saveSharedExpensePosting } from '../services/sharedExpense/SharedExpenseService';
import type { Account, Category, Group, GroupMember, Person, PersonEntry, Transaction } from '../types/models';

const mockNavigation = { addListener: jest.fn(() => () => {}), isFocused: () => true, canGoBack: () => true, goBack: jest.fn(), dispatch: jest.fn(), navigate: jest.fn() };
const mockDialog = { confirm: jest.fn(), showDialog: jest.fn(), showSuccess: jest.fn() };
const mockData = { db: null as AppDb | null, repo, refresh: jest.fn(), accounts: [] as Account[], categories: [] as Category[], people: [] as Person[], allPeople: [] as Person[], groups: [] as Group[], groupMembers: [] as GroupMember[], transactions: [] as Transaction[], entries: [] as PersonEntry[], settings: { currency: 'PKR', week_start: 'MONDAY' } };
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('@react-navigation/native', () => ({ DefaultTheme: { colors: {} }, useNavigation: () => mockNavigation, useIsFocused: () => true }));
jest.mock('@react-navigation/stack', () => ({ createStackNavigator: () => ({}) }));
jest.mock('@react-navigation/material-top-tabs', () => ({ createMaterialTopTabNavigator: () => ({}) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../hooks/useAppData', () => ({ useAppData: () => mockData }));
jest.mock('../components/dialogs/AppDialogProvider', () => ({ useAppDialog: () => mockDialog }));

let sqlite: DatabaseSync;
let db: AppDb;
let renderer: ReactTestRenderer | undefined;
let ali: string;
const cash = 'account_cash_default';
const food = 'cat_expense_food';

beforeEach(async () => {
  jest.clearAllMocks(); sqlite = new DatabaseSync(':memory:');
  const adapter = {
    execAsync: async (sql: string) => { sqlite.exec(sql); },
    runAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).run(...params),
    getAllAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).all(...params),
    getFirstAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).get(...params) ?? null,
    withTransactionAsync: async (work: () => Promise<void>) => { sqlite.exec('BEGIN'); try { await work(); sqlite.exec('COMMIT'); } catch (error) { sqlite.exec('ROLLBACK'); throw error; } },
    withExclusiveTransactionAsync: async (work: (txn: AppDb) => Promise<void>) => adapter.withTransactionAsync(() => work(db)),
  };
  db = adapter as unknown as AppDb; jest.mocked(SQLite.openDatabaseAsync).mockResolvedValue(db); await openAppDatabase();
  ali = await repo.savePerson(db, 'Ali');
  mockData.db = db; mockData.accounts = await repo.listAccounts(db); mockData.categories = await repo.listCategories(db); mockData.people = await repo.listPeople(db); mockData.allPeople = await repo.listAllPeople(db); mockData.groups = []; mockData.groupMembers = []; mockData.refresh.mockResolvedValue(undefined); mockDialog.confirm.mockResolvedValue(true);
  mockData.entries = []; mockData.transactions = [];
});
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; sqlite.close(); jest.restoreAllMocks(); });
const render = async (params: object = {}) => act(async () => { renderer = create(createElement(SplitScreen, { navigation: mockNavigation, route: { params } })); });
const field = (label: string) => renderer!.root.findAllByType(TextField).find((node) => node.props.label === label)!;
const checkbox = (label: string) => renderer!.root.findAll((node) => node.props.accessibilityRole === 'checkbox' && node.props.accessibilityLabel === label)[0];
const radio = (label: string) => renderer!.root.findAll((node) => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === `${label} split`)[0];
async function enter(label: string, value: string) { await act(async () => field(label).props.onChangeText(value)); }
async function press(node: any) { await act(async () => node.props.onPress()); }
async function openParticipants() { await press(renderer!.root.findByProps({ accessibilityLabel: 'Select participants' })); }
async function finishParticipants() { await press(renderer!.root.findAllByType(PrimaryButton).find((node) => node.props.title === 'Done')); }
async function validCreate() { await render(); await enter('Total Amount', '100'); await openParticipants(); await press(checkbox('Ali')); await finishParticipants(); }

test('standalone selector starts with accessible self and active People only', async () => {
  const archived = await repo.savePerson(db, 'Archived'); await db.runAsync('UPDATE people SET is_archived = 1 WHERE id = ?;', archived); mockData.people = await repo.listPeople(db); mockData.allPeople = await repo.listAllPeople(db);
  await render();
  expect(renderer!.root.findByProps({ accessibilityLabel: 'Selected participant You' })).toBeTruthy();
  await openParticipants();
  expect(checkbox('You').props.accessibilityState.checked).toBe(true);
  expect(checkbox('Ali').props.accessibilityState.checked).toBe(false);
  expect(renderer!.root.findAll((node) => node.props.accessibilityLabel === 'Archived')).toHaveLength(0);
  expect(renderer!.root.findAllByType(TextField).some((node) => node.props.label === 'Participants')).toBe(false);
});

test('group selector contains only self and active current members and supports a subset', async () => {
  const outsider = await repo.savePerson(db, 'Outsider'); const groupId = await repo.createGroup(db, { name: 'Trip', personIds: [ali] });
  mockData.people = await repo.listPeople(db); mockData.allPeople = await repo.listAllPeople(db); mockData.groups = await repo.listGroups(db); mockData.groupMembers = await repo.listGroupMembers(db, groupId);
  await render({ groupId });
  await openParticipants();
  expect(checkbox('You')).toBeTruthy(); expect(checkbox('Ali')).toBeTruthy();
  expect(renderer!.root.findAll((node) => node.props.accessibilityLabel === 'Outsider')).toHaveLength(0);
  expect(renderer!.root.findAllByType(SecondaryButton).some((node) => node.props.title === 'Add someone else')).toBe(false);
  expect(outsider).toBeTruthy();
});

test('group without You defaults to current people only; other-paid bill stays group-only and historical self remains readable', async () => {
  const sam = await repo.savePerson(db, 'Sam');
  const groupId = await repo.createGroup(db, { name: 'Others', personIds: [ali, sam], includeSelf: false });
  mockData.people = await repo.listPeople(db); mockData.allPeople = await repo.listAllPeople(db); mockData.groups = await repo.listGroups(db); mockData.groupMembers = await repo.listGroupMembers(db, groupId);
  await render({ groupId });
  await openParticipants();
  expect(checkbox('You')).toBeUndefined();
  expect(checkbox('Ali').props.accessibilityState.checked).toBe(true);
  expect(checkbox('Sam').props.accessibilityState.checked).toBe(true);
  await finishParticipants();
  await enter('Total Amount', '100');
  await act(async () => renderer!.root.findAllByType(Picker).find((node) => node.props.label === 'Payer')!.props.setValue(`PERSON:${ali}`));
  await press(renderer!.root.findByType(PrimaryButton));
  expect(await listActivity(db)).toEqual([]);
  expect(await repo.listTransactions(db)).toEqual([]);
  expect(await repo.listPersonEntries(db)).toEqual([]);
  expect(await repo.listSplitGroups(db, groupId)).toHaveLength(1);
  await act(async () => renderer!.unmount()); renderer = undefined;
  const old = await saveSharedExpensePosting(db, { title: 'Earlier self participation', totalAmountMinor: 100, categoryId: food, accountId: cash, occurredOn: '2026-09-14', groupId, payerIsSelf: true, shares: [{ name: 'You', isSelf: true, shareMinor: 50 }, { name: 'Ali', personId: ali, isSelf: false, shareMinor: 50 }] });
  await render({ shared: await readSharedEvent(db, old.splitGroup.id) });
  expect(renderer!.root.findByProps({ accessibilityLabel: 'Selected participant You' })).toBeTruthy();
});

test('inline new Person remains staged until the complete split commits', async () => {
  await render(); await enter('Total Amount', '100'); await enter('New person name', 'Sam'); await press(renderer!.root.findAllByType(SecondaryButton).find((node) => node.props.title === 'Add someone else'));
  expect(await repo.listPeople(db)).toHaveLength(1);
  expect(renderer!.root.findByProps({ accessibilityLabel: 'Selected participant Sam' })).toBeTruthy();
  await press(renderer!.root.findByType(PrimaryButton));
  expect((await repo.listPeople(db)).map((person) => person.name).sort()).toEqual(['Ali', 'Sam']);
  expect(await repo.listSplitGroups(db)).toHaveLength(1);
});

test('active duplicate inline name selects the existing identity without inserting', async () => {
  await render(); await enter('New person name', ' aLI '); await press(renderer!.root.findAllByType(SecondaryButton).find((node) => node.props.title === 'Add someone else'));
  expect(renderer!.root.findByProps({ accessibilityLabel: 'Selected participant Ali' })).toBeTruthy();
  expect(await repo.listPeople(db)).toHaveLength(1);
});

test('archived duplicate warning preserves the typed name and database', async () => {
  await db.runAsync('UPDATE people SET is_archived = 1 WHERE id = ?;', ali); mockData.people = await repo.listPeople(db); mockData.allPeople = await repo.listAllPeople(db);
  await render(); await enter('New person name', 'ALI'); await press(renderer!.root.findAllByType(SecondaryButton).find((node) => node.props.title === 'Add someone else'));
  expect(mockDialog.showDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'Person is archived' }));
  expect(field('New person name').props.value).toBe('ALI');
  expect(await db.getAllAsync('SELECT id FROM people;')).toHaveLength(1);
});

test('all methods expose Sage selected accessibility and per-row fields with live preview', async () => {
  await validCreate();
  for (const method of ['Exact', 'Percentage', 'Shares']) {
    await press(radio(method));
    expect(radio(method).props.accessibilityState).toMatchObject({ selected: true, checked: true });
    expect(field(`You ${method === 'Exact' ? 'amount' : method.toLowerCase()}`)).toBeTruthy();
    expect(field(`Ali ${method === 'Exact' ? 'amount' : method.toLowerCase()}`)).toBeTruthy();
  }
  expect(renderer!.root.findAllByType(Text).map((node) => node.props.children).flat(Infinity).join(' ')).toContain('Your effect');
});

test('invalid per-row value disables save and retains every entered field', async () => {
  await validCreate(); await press(radio('Exact')); await enter('You amount', '40'); await enter('Ali amount', 'bad'); await enter('Description', 'Keep dinner');
  expect(renderer!.root.findByType(PrimaryButton).props.disabled).toBe(true);
  expect(field('You amount').props.value).toBe('40'); expect(field('Ali amount').props.value).toBe('bad'); expect(field('Description').props.value).toBe('Keep dinner');
});

test('persisted archived participant reopens as Exact history with identity locked', async () => {
  const plan = await saveSharedExpensePosting(db, { title: 'Old dinner', totalAmountMinor: 10000, categoryId: food, accountId: cash, occurredOn: '2026-09-14', payerIsSelf: true, shares: [{ name: 'You', isSelf: true, shareMinor: 4000 }, { name: 'Ali', personId: ali, isSelf: false, shareMinor: 6000 }] });
  await db.runAsync('UPDATE people SET is_archived = 1 WHERE id = ?;', ali); mockData.people = await repo.listPeople(db); mockData.allPeople = await repo.listAllPeople(db);
  await render({ shared: await readSharedEvent(db, plan.splitGroup.id) });
  expect(radio('Exact').props.accessibilityState.selected).toBe(true);
  expect(field('Ali amount').props.value).toBe('60');
  expect(renderer!.root.findByProps({ accessibilityLabel: 'Selected participant Ali' })).toBeTruthy();
  await openParticipants();
  expect(renderer!.root.findAll((node) => node.props.accessibilityRole === 'checkbox' && node.props.accessibilityLabel === 'Ali')).toHaveLength(0);
});

test('legacy equal-looking final amounts are never inferred as Equal', async () => {
  const plan = await saveSharedExpensePosting(db, { title: 'Legacy equal amounts', totalAmountMinor: 1200000, categoryId: food, accountId: cash, occurredOn: '2026-09-14', payerIsSelf: true, shares: [{ name: 'You', isSelf: true, shareMinor: 600000 }, { name: 'Ali', personId: ali, isSelf: false, shareMinor: 600000 }] });
  await render({ shared: await readSharedEvent(db, plan.splitGroup.id) });
  expect(radio('Exact').props.accessibilityState.selected).toBe(true);
  expect(radio('Equal').props.accessibilityState.selected).toBe(false);
  expect(renderer!.root.findAllByType(Text).map((n) => n.props.children).join(' ')).toContain('Legacy saved shares');
});

test('participant picker Cancel and Android back preserve committed participants', async () => {
  const dismiss = jest.spyOn(Keyboard, 'dismiss');
  await render();
  await openParticipants();
  expect(dismiss).toHaveBeenCalled();
  expect(renderer!.root.findByType(Modal).props.statusBarTranslucent).toBe(true);
  expect(renderer!.root.findByType(Modal).props.navigationBarTranslucent).toBe(true);
  await press(checkbox('Ali'));
  await press(renderer!.root.findAllByType(SecondaryButton).find((node) => node.props.title === 'Cancel'));
  expect(renderer!.root.findAll((node) => node.props.accessibilityLabel === 'Selected participant Ali')).toHaveLength(0);
  await openParticipants();
  await press(checkbox('Ali'));
  await act(async () => renderer!.root.findByType(Modal).props.onRequestClose());
  expect(renderer!.root.findAll((node) => node.props.accessibilityLabel === 'Selected participant Ali')).toHaveLength(0);
});

test.each(['Equal', 'Exact', 'Percentage', 'Shares'])('%s persists editor intent and reopens with the original definition', async (method) => {
  await validCreate();
  await enter('Total Amount', '12000');
  if (method !== 'Equal') {
    await press(radio(method));
    const suffix = method === 'Exact' ? 'amount' : method.toLowerCase();
    await enter(`You ${suffix}`, method === 'Exact' ? '6000' : method === 'Percentage' ? '50' : '1');
    await enter(`Ali ${suffix}`, method === 'Exact' ? '6000' : method === 'Percentage' ? '50' : '1');
  }
  await press(renderer!.root.findByType(PrimaryButton));
  const split = (await repo.listSplitGroups(db))[0];
  expect(JSON.parse(split.split_definition!).method).toBe(method);
  await act(async () => renderer!.unmount());
  await render({ shared: await readSharedEvent(db, split.id) });
  expect(radio(method).props.accessibilityState.selected).toBe(true);
  // Native TextInput, rather than bypassing the shared formatter.
  const input = renderer!.root.findAllByType(TextInput).find((node) => node.props.accessibilityLabel === 'Total Amount')!;
  expect(input.props.value).toBe('12,000');
  await act(async () => input.props.onChangeText('15000'));
  expect(renderer!.root.findAllByType(TextInput).find((node) => node.props.accessibilityLabel === 'Total Amount')!.props.value).toBe('15,000');
  if (method === 'Exact') {
    expect(field('You amount').props.value).toBe('6000');
    expect(renderer!.root.findByType(PrimaryButton).props.disabled).toBe(true);
  } else {
    const text = renderer!.root.findAllByType(Text).map((node) => node.props.children).flat(Infinity).join(' ');
    expect(text).toContain('Rs. 7,500');
    await press(renderer!.root.findByType(PrimaryButton));
    const updated = await readSharedEvent(db, split.id);
    expect(updated.participants.map((row) => row.share_minor)).toEqual([750000, 750000]);
    expect(JSON.parse(updated.split.split_definition!).method).toBe(method);
  }
});

// Rendered controls drive the production form and real disposable SQLite.
const text = () => renderer!.root.findAllByType(Text).map(node => node.props.children).flat(Infinity).join(' ').replace(/\s+/g, ' ');
const saveButton = () => renderer!.root.findAllByType(PrimaryButton).find(node => node.props.title === 'Confirm & Save')!;
const button = (title: string) => renderer!.root.findAllByType(SecondaryButton).find(node => node.props.title === title)!;
const mode = (title: string) => renderer!.root.findAll(node => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === title)[0];
const picker = (kind: 'participants' | 'payers') => renderer!.root.findAllByType(PeopleMultiPicker).find(node => node.props.kind === kind)!;
let atif: string; let awais: string;
async function four(params: object = {}) {
  atif = await repo.savePerson(db, 'Atif'); awais = await repo.savePerson(db, 'Awais');
  mockData.people = await repo.listPeople(db); mockData.allPeople = await repo.listAllPeople(db);
  await render(params); await enter('Total Amount', '100');
  await act(async () => picker('participants').props.onChange(['SELF', `PERSON:${ali}`, `PERSON:${atif}`, `PERSON:${awais}`]));
}
async function multiple(ids = ['SELF', `PERSON:${atif}`]) {
  await press(mode('Multiple people'));
  await act(async () => picker('payers').props.onChange(ids));
}
async function funding(paid: string, other: string) { await enter('You paid', paid); await enter('Atif paid', other); }
async function reopenLatest() {
  const split = (await repo.listSplitGroups(db))[0]; const shared = await readSharedEvent(db, split.id);
  await act(async () => renderer!.unmount()); await render({ shared }); return shared;
}

test('E01 normal single-payer Equal remains implicit, simple and without advanced fields', async () => {
  await validCreate(); expect(mode('One person').props.accessibilityState.selected).toBe(true);
  expect(field('You paid')).toBeUndefined(); expect(field('Combined / common cost')).toBeUndefined();
  expect(picker('participants')).toBeTruthy(); expect(saveButton().props.disabled).toBe(false);
});
test('E02/E03 multiple reveals contributions; returning to one removes them and uses the full bill safely', async () => {
  await four(); await multiple(); expect(field('You paid')).toBeTruthy(); expect(field('Atif paid')).toBeTruthy();
  await funding('40', '60'); await press(mode('One person'));
  expect(field('You paid')).toBeUndefined(); expect(field('Atif paid')).toBeUndefined();
  expect(text()).toContain('You pay now : Rs. 100 from Cash'); expect(saveButton().props.disabled).toBe(false);
  await press(saveButton()); expect(JSON.parse((await repo.listSplitGroups(db))[0].split_definition!).version).toBe(1);
});
test.each([['40', '50', 'Rs. 10 still needs to be assigned.'], ['40', '70', 'Payer contributions exceed the bill by Rs. 10.']])('E04/E05 contributions %s + %s show exact validation', async (self, other, message) => {
  await four(); await multiple(); await funding(self, other); expect(text()).toContain(message); expect(saveButton().props.disabled).toBe(true);
});
test('E06 exact contributions enable Save and persist contribution-based account/spending effects', async () => {
  await four(); await multiple(); await funding('40', '60'); expect(saveButton().props.disabled).toBe(false);
  await press(saveButton()); const transactions = await repo.listTransactions(db); const entries = await repo.listPersonEntries(db);
  expect(transactions).toMatchObject([{ amount_minor: 2500, cash_effect_minor: -4000 }]);
  expect(calculateAccountBalance(mockData.accounts[0], transactions, entries)).toBe(-4000);
  expect(await listActivity(db)).toHaveLength(1);
});
test('E07 positive user contribution requires an active Account', async () => {
  await four(); await multiple(); await funding('40', '60');
  await act(async () => renderer!.root.findAllByType(Picker).find(node => node.props.label === 'Paid from account')!.props.setValue('missing'));
  expect(saveButton().props.disabled).toBe(true); await press(saveButton()); expect(await repo.listSplitGroups(db)).toEqual([]);
});
test('E08 zero user payment requires no account selector or active account selection', async () => {
  await four(); await multiple(); await funding('0', '100');
  expect(renderer!.root.findAllByType(Picker).some(node => node.props.label === 'Paid from account')).toBe(false);
  mockData.accounts = []; await enter('Description', 'Zero funding'); expect(saveButton().props.disabled).toBe(false);
  await press(saveButton()); expect((await repo.listTransactions(db))[0].cash_effect_minor).toBe(0);
});
test.each(['Equal', 'Percentage', 'Shares'])('E10/E11/E12 %s has no common-cost control', async method => {
  await four(); if (method !== 'Equal') await press(radio(method)); expect(field('Combined / common cost')).toBeUndefined();
});
test.each(['one', 'multiple'])('E09 Exact exposes common cost in %s payer mode', async payerMode => {
  await four(); if (payerMode === 'multiple') await multiple(); await press(radio('Exact'));
  expect(field('Combined / common cost').props.money).toBe(true); expect(field('Combined / common cost').props.info).toContain('Use this for shared delivery, tip, drinks');
});
async function commonBill() {
  await four(); await press(radio('Exact'));
  for (const [name, value] of [['You', '10'], ['Ali', '20'], ['Atif', '30'], ['Awais', '30']]) await enter(`${name} amount`, value);
  await enter('Combined / common cost', '10');
}
test('E13/E16 Exact base + common validates and shows canonical final/common shares', async () => {
  await commonBill(); expect(saveButton().props.disabled).toBe(false);
  expect(text()).toContain('Individual subtotal: Rs. 90'); expect(text()).toContain('Combined cost: Rs. 10');
  expect(text()).toContain('Total allocated: Rs. 100 / Rs. 100'); expect(text()).toContain('Individual Rs. 10 | Common Rs. 2.50 | Total Rs. 12.50');
  await press(saveButton()); expect((await repo.listTransactions(db))[0].amount_minor).toBe(1250);
});
test.each([['9', 'under'], ['11', 'over']])('E14/E15 common %s gives %s allocation and disables Save', async (common, direction) => {
  await commonBill(); await enter('Combined / common cost', common); expect(text()).toContain(`Exact amounts are ${direction} the bill total`); expect(saveButton().props.disabled).toBe(true);
});
test.each([['10', '90', 'You will owe Rs. 15.'], ['60', '40', 'You should receive Rs. 35.'], ['25', '75', 'You are settled for this bill.'], ['0', '100', 'You will owe Rs. 25.']])('E17-E20 paid %s with consumption 25 gives the exact user preview', async (self, other, message) => {
  await four(); await multiple(); await funding(self, other); expect(text()).toContain(message); expect(text()).toContain('Your personal expense : Rs. 25');
});
test('E21 user pays without participating: no Expense, exact outflow and receivable', async () => {
  await four(); await multiple(); await funding('60', '40');
  await act(async () => picker('participants').props.onChange([`PERSON:${ali}`, `PERSON:${atif}`, `PERSON:${awais}`]));
  expect(text()).toContain('Your personal expense : Rs. 0'); expect(text()).toContain('You should receive Rs. 60.');
  await press(saveButton()); expect(await repo.listTransactions(db)).toEqual([]);
  expect(calculateAccountBalance(mockData.accounts[0], [], await repo.listPersonEntries(db))).toBe(-6000);
});
test('E22 group without user participation/payment is history-only; payers never become participants implicitly', async () => {
  atif = await repo.savePerson(db, 'Atif'); awais = await repo.savePerson(db, 'Awais');
  const groupId = await repo.createGroup(db, { name: 'Others', personIds: [ali, atif, awais], includeSelf: false });
  mockData.groups = await repo.listGroups(db); mockData.groupMembers = await repo.listGroupMembers(db, groupId); mockData.people = await repo.listPeople(db); mockData.allPeople = await repo.listAllPeople(db);
  await render({ groupId }); await enter('Total Amount', '100'); await multiple([`PERSON:${atif}`, `PERSON:${ali}`]); await enter('Atif paid', '60'); await enter('Ali paid', '40');
  expect(text()).toContain('Your personal expense : Rs. 0'); await press(saveButton());
  expect(await listActivity(db)).toEqual([]); expect(await repo.listPersonEntries(db)).toEqual([]);
  await act(async () => renderer!.unmount()); await act(async () => { renderer = create(createElement(GroupDetailScreen, { navigation: mockNavigation, route: { params: { groupId } } })); });
  expect(text()).toContain('Who paid'); expect(text()).toContain('Settlement plan'); expect(text()).toContain('Final shares');
});
test('E23 suggested routing is readable, includes third-party routes, and never records settlement cash', async () => {
  await four(); await multiple(); await funding('60', '40'); expect(text()).toMatch(/(?:Ali|Awais) pays Atif/); expect(text()).toContain('pays You');
  await press(saveButton()); expect(await db.getAllAsync('SELECT * FROM entry_allocations')).toEqual([]); expect(await db.getAllAsync('SELECT * FROM group_settlement_requests')).toEqual([]);
});
test('E24 payable customization uses exact user amount and canonical counterpart limits', async () => {
  await four(); await multiple(['SELF', `PERSON:${atif}`, `PERSON:${ali}`]); await funding('10', '40'); await enter('Ali paid', '50');
  await press(button('Customize my settlement')); await enter('Pay Atif', '5'); await enter('Pay Ali', '10');
  expect(text()).toContain('Assigned: Rs. 15 / Rs. 15'); expect(saveButton().props.disabled).toBe(false);
  await press(saveButton()); const definition = JSON.parse((await repo.listSplitGroups(db))[0].split_definition!);
  expect(definition.customUserSettlement).toEqual(expect.arrayContaining([{ identity: `PERSON:${atif}`, amountMinor: 500 }, { identity: `PERSON:${ali}`, amountMinor: 1000 }]));
});
test('E25/E33 receivable customization persists and reopens exact routing inputs', async () => {
  await four(); await multiple(); await funding('60', '40'); await press(button('Customize my settlement'));
  await enter('Ali owes you', '10'); await enter('Awais owes you', '25'); expect(saveButton().props.disabled).toBe(false);
  await press(saveButton()); await reopenLatest(); expect(field('Ali owes you').props.value).toBe('10'); expect(field('Awais owes you').props.value).toBe('25');
});
test('E26 exact custom sum with an over-limit person is rejected', async () => {
  await four(); await multiple(); await funding('60', '40'); await press(button('Customize my settlement'));
  await enter('Ali owes you', '30'); await enter('Awais owes you', '5'); expect(saveButton().props.disabled).toBe(true);
  expect(text()).toContain('without going above the amount shown for each person');
});
test('customization is absent for one possible counterparty or a zero user position', async () => {
  await validCreate(); expect(button('Customize my settlement')).toBeUndefined();
  await multiple(['SELF', `PERSON:${ali}`]); await enter('You paid', '50'); await enter('Ali paid', '50'); expect(button('Customize my settlement')).toBeUndefined();
});
test('removed payer/participant invalidates routing safely and suggested settlement can be recalculated', async () => {
  await four(); await multiple(); await funding('60', '40'); await press(button('Customize my settlement'));
  await act(async () => picker('participants').props.onChange(['SELF', `PERSON:${atif}`, `PERSON:${awais}`]));
  expect(field('Ali owes you')).toBeUndefined(); expect(saveButton().props.disabled).toBe(false);
});
test('E27-E30 shared detail shows all contributions/final shares/third-party routes; global People gets user routes only', async () => {
  await four(); await multiple(); await funding('60', '40'); await press(saveButton());
  const split = (await repo.listSplitGroups(db))[0]; const definition = JSON.parse(split.split_definition!);
  const userRoutes = definition.routes.filter((row: { from: string; to: string }) => row.from === 'SELF' || row.to === 'SELF');
  expect(await repo.listPersonEntries(db)).toHaveLength(userRoutes.length); expect((await readPersonSnapshot(db, atif)).history).toEqual([]);
  expect((await readPersonSnapshot(db, ali)).history).toHaveLength(1);
  mockData.entries = await repo.listPersonEntries(db); mockData.transactions = await repo.listTransactions(db);
  mockData.allPeople = mockData.allPeople.map(person => ({ ...person, balance_minor: calculatePersonBalance(mockData.entries.filter(entry => entry.person_id === person.id)) }));
  for (const [personId, count] of [[atif, 0], [ali, 1]] as const) {
    await act(async () => renderer!.unmount());
    await act(async () => { renderer = create(createElement(PersonDetailScreen, { navigation: mockNavigation, route: { params: { personId } } })); });
    expect(renderer!.root.findByType(FlatList).props.data).toHaveLength(count);
  }
  await act(async () => renderer!.unmount()); await act(async () => { renderer = create(createElement(ActivityDetailScreen, { navigation: mockNavigation, route: { params: { kind: 'shared', sourceId: split.id } } })); });
  for (const heading of ['Your part', 'Who paid', 'Final shares', 'Settlement plan']) expect(text()).toContain(heading);
  expect(text()).toContain('You — Rs. 60'); expect(text()).toContain('Atif — Rs. 40'); expect(text()).toMatch(/(?:Ali|Awais) pays Atif/); expect(text()).toContain('Your final share : Rs. 25');
});
test('E31 editor reopens exact payer mode and contributions; atomic edit changes actual funding', async () => {
  await four(); await multiple(); await funding('40', '60'); await press(saveButton()); await reopenLatest();
  expect(mode('Multiple people').props.accessibilityState.selected).toBe(true); expect(field('You paid').props.value).toBe('40'); expect(field('Atif paid').props.value).toBe('60');
  await funding('50', '50'); await press(saveButton()); expect((await repo.listTransactions(db))[0].cash_effect_minor).toBe(-5000); expect(await repo.listSplitGroups(db)).toHaveLength(1);
});
test('E32 Exact reopening uses source base/common values rather than final shares', async () => {
  await commonBill(); await press(saveButton()); await reopenLatest(); expect(field('You amount').props.value).toBe('10'); expect(field('Combined / common cost').props.value).toBe('10');
  expect(text()).toContain('Individual Rs. 10 | Common Rs. 2.50 | Total Rs. 12.50');
});
test('E34 legacy single-payer source retains Exact fallback and a correct atomic edit', async () => {
  const plan = await saveSharedExpensePosting(db, { title: 'Legacy', totalAmountMinor: 10000, categoryId: food, accountId: cash, occurredOn: '2026-09-14', payerIsSelf: true, shares: [{ name: 'You', isSelf: true, shareMinor: 5000 }, { name: 'Ali', personId: ali, isSelf: false, shareMinor: 5000 }] });
  await render({ shared: await readSharedEvent(db, plan.splitGroup.id) }); expect(mode('One person').props.accessibilityState.selected).toBe(true);
  await enter('You amount', '40'); await enter('Ali amount', '60'); await press(saveButton()); expect((await repo.listTransactions(db))[0].amount_minor).toBe(4000);
});
test('E35 rapid Save taps create only one complete multi-payer event', async () => {
  await four(); await multiple(); await funding('40', '60'); const save = saveButton().props.onPress;
  await act(async () => { await Promise.all([save(), save()]); }); expect(await repo.listSplitGroups(db)).toHaveLength(1); expect(await repo.listTransactions(db)).toHaveLength(1);
});
test('E36 refresh failure offers read-only retry and cannot repeat the committed write', async () => {
  await four(); await multiple(); await funding('40', '60'); mockData.refresh.mockRejectedValueOnce(new Error('refresh unavailable'));
  await press(saveButton()); expect(await repo.listSplitGroups(db)).toHaveLength(1);
  const dialog = mockDialog.showDialog.mock.calls.find(([value]) => value.title === 'Saved, but refresh failed')![0];
  await act(async () => dialog.actions.find((action: { text: string }) => action.text === 'Retry refresh').onPress()); await press(saveButton());
  expect(await repo.listSplitGroups(db)).toHaveLength(1);
});
test('E37 all new money inputs use shared formatting/caret and keyboard-safe form', async () => {
  await four(); await multiple(); await funding('60', '40'); await press(button('Customize my settlement'));
  expect(renderer!.root.findAllByType(KeyboardSafeScrollView)).toHaveLength(1);
  for (const label of ['Ali owes you', 'You paid', 'Atif paid']) {
    const input = () => renderer!.root.findAllByType(TextInput).find(node => node.props.accessibilityLabel === label)!;
    await act(async () => input().props.onChangeText('1234.50')); expect(input().props.value).toBe('1,234.50');
    await act(async () => input().props.onChangeText('0')); expect(input().props.value).toBe('0');
    await act(async () => input().props.onChangeText('')); expect(input().props.value).toBe('');
  }
  await press(radio('Exact'));
  for (const label of ['You amount', 'Combined / common cost']) {
    const input = renderer!.root.findAllByType(TextInput).find(node => node.props.accessibilityLabel === label)!;
    await act(async () => input.props.onChangeText('1234.50'));
    expect(renderer!.root.findAllByType(TextInput).find(node => node.props.accessibilityLabel === label)!.props.value).toBe('1,234.50');
  }
});
test('E38 payer picker is searchable/virtualized, uses stable IDs and Cancel/Back is staged', async () => {
  await four(); await multiple(); await press(button('Select payers'));
  expect(checkbox('You (me)')).toBeTruthy();
  await act(async () => renderer!.root.findAllByType(TextInput).find(node => node.props.accessibilityLabel === 'Search payers')!.props.onChangeText('Atif'));
  const list = renderer!.root.findByType(FlatList); expect(list.props.data).toEqual([{ id: `PERSON:${atif}`, name: 'Atif' }]); expect(list.props.keyExtractor(list.props.data[0])).toBe(`PERSON:${atif}`);
  await press(checkbox('Atif')); await press(button('Cancel')); expect(picker('payers').props.selected).toContain(`PERSON:${atif}`);
  await press(button('Select payers')); await press(checkbox('Ali')); await act(async () => renderer!.root.findByType(Modal).props.onRequestClose()); expect(picker('payers').props.selected).not.toContain(`PERSON:${ali}`);
});

test('payer-only identity stays separate from participants and reopens correctly', async () => {
  await four(); await act(async () => picker('participants').props.onChange(['SELF', `PERSON:${ali}`, `PERSON:${awais}`]));
  await multiple(); await funding('40', '60'); await press(saveButton());
  expect((await repo.listSplitParticipants(db, (await repo.listSplitGroups(db))[0].id)).some(row => row.person_id === atif)).toBe(false);
  await reopenLatest(); expect(field('Atif paid').props.value).toBe('60'); expect(picker('participants').props.selected).not.toContain(`PERSON:${atif}`);
});
test('a group excluding You can still use You as payer without creating personal consumption', async () => {
  atif = await repo.savePerson(db, 'Atif'); const groupId = await repo.createGroup(db, { name: 'Others funded by me', personIds: [ali, atif], includeSelf: false });
  mockData.groups = await repo.listGroups(db); mockData.groupMembers = await repo.listGroupMembers(db, groupId); mockData.people = await repo.listPeople(db); mockData.allPeople = await repo.listAllPeople(db);
  await render({ groupId }); await enter('Total Amount', '100'); await multiple(); await funding('60', '40');
  expect(picker('participants').props.selected).not.toContain('SELF'); await press(saveButton());
  expect(await repo.listTransactions(db)).toEqual([]); expect(await listActivity(db)).toHaveLength(1);
  expect(calculateAccountBalance(mockData.accounts[0], [], await repo.listPersonEntries(db))).toBe(-6000);
});
test('staged new participant and customized receivable resolve to a real identity in one transaction', async () => {
  await four(); await multiple(); await funding('60', '40'); await enter('New person name', 'Sam'); await press(button('Add someone else'));
  await press(button('Customize my settlement')); await enter('Sam owes you', '10'); await enter('Ali owes you', '10'); await enter('Awais owes you', '20');
  expect((await repo.listPeople(db)).some(person => person.name === 'Sam')).toBe(false); await press(saveButton());
  const sam = (await repo.listPeople(db)).find(person => person.name === 'Sam')!;
  expect(sam).toBeTruthy(); const definition = JSON.parse((await repo.listSplitGroups(db))[0].split_definition!);
  expect(definition.customUserSettlement).toContainEqual({ identity: `PERSON:${sam.id}`, amountMinor: 1000 });
  expect((await readPersonSnapshot(db, sam.id)).balanceMinor).toBe(1000);
});
test('failed multi-payer save rolls back staged people together with all shared children', async () => {
  await four(); await multiple(); await funding('60', '40'); await enter('New person name', 'Sam'); await press(button('Add someone else'));
  const run = db.runAsync.bind(db); jest.spyOn(db, 'runAsync').mockImplementation(async (sql, ...params) => { if (sql.includes('INSERT INTO transactions')) throw new Error('UI integration failure'); return run(sql, ...params); });
  await press(saveButton()); expect((await repo.listPeople(db)).some(person => person.name === 'Sam')).toBe(false); expect(await repo.listSplitGroups(db)).toEqual([]); expect(await repo.listPersonEntries(db)).toEqual([]);
  expect(field('You paid').props.value).toBe('60'); expect(mockDialog.showDialog).toHaveBeenCalledWith(expect.objectContaining({ message: 'UI integration failure' }));
});
test('negative-account projection uses actual user contribution, not the full bill', async () => {
  await db.runAsync('UPDATE accounts SET opening_balance_minor = 5000 WHERE id = ?;', cash);
  mockData.accounts = await repo.listAccounts(db); await four(); await multiple(); await funding('40', '60');
  await press(saveButton()); expect(mockDialog.confirm).not.toHaveBeenCalled(); expect(await repo.listSplitGroups(db)).toHaveLength(1);
});
test('fresh People crossing is explicitly confirmed and cancellation preserves the complete bill draft', async () => {
  await four(); await multiple(); await funding('10', '90');
  await repo.savePersonEntry(db, { person_id: atif, account_id: cash, type: 'GIVEN', amount_minor: 1000, title: 'Earlier unrelated loan', occurred_on: '2026-09-01' });
  mockDialog.confirm.mockResolvedValueOnce(false); await press(saveButton());
  expect(mockDialog.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Balance will cross zero', message: expect.stringContaining('You will owe Atif Rs. 5') }));
  expect(await repo.listSplitGroups(db)).toEqual([]); expect(field('You paid').props.value).toBe('10');
  await press(saveButton()); expect(await repo.listSplitGroups(db)).toHaveLength(1);
  expect((await readPersonSnapshot(db, atif)).balanceMinor).toBe(-500);
});

test('F payer/route detail presentation adds no database reads per bill, payer or route', async () => {
  await four(); await multiple(); await funding('60', '40'); await press(saveButton());
  const records = await readSharedEvent(db, (await repo.listSplitGroups(db))[0].id);
  await act(async () => renderer!.unmount());
  const all = jest.spyOn(db, 'getAllAsync'); const first = jest.spyOn(db, 'getFirstAsync');
  await act(async () => { renderer = create(createElement(SharedBillDetail, { records, accountName: 'Cash' })); });
  expect(text()).toContain('Who paid'); expect(text()).toContain('Settlement plan');
  expect(all).not.toHaveBeenCalled(); expect(first).not.toHaveBeenCalled();
});

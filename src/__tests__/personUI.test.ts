import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { FlatList, Keyboard, Text, TextInput } from 'react-native';
import { PersonCapsule, PersonSummary } from '../components/PersonSummary';
import { Picker } from '../components/forms';
import { ListRow, PrimaryButton, SecondaryButton, TextField } from '../components/common';
import { AccountsScreen, PeopleScreen, PersonDetailScreen, PersonEditScreen, PersonEntryFormScreen } from '../navigation/AppNavigator';
import { archivePerson, recordPeopleAction, renamePerson, restorePerson } from '../services/people/PersonService';

const mockNavigation = { addListener: jest.fn(() => () => {}), isFocused: () => true, canGoBack: () => true, goBack: jest.fn(), navigate: jest.fn(), push: jest.fn(), setParams: jest.fn(), dispatch: jest.fn() };
const mockDialog = { confirm: jest.fn(), showDialog: jest.fn(), showSuccess: jest.fn() };
const mockConfirmOutflow = jest.fn();
const person = { id: 'ali', name: 'Ali', note: 'Class friend', is_archived: 0, balance_minor: 300000, created_at: '2026-09-01', updated_at: '2026-09-12T00:00:00.000Z', deleted_at: null, sync_status: 'LOCAL' } as const;
const entry = { id: 'entry', person_id: 'ali', type: 'GIVEN', amount_minor: 300000, account_id: 'cash', title: 'Loan', occurred_on: '2026-09-12', split_group_id: null, financial_event_id: null, created_at: '2026-09-12', updated_at: '2026-09-12', deleted_at: null, sync_status: 'LOCAL' } as const;
const account = { id: 'cash', name: 'Cash', type: 'CASH', currency: 'PKR', opening_balance_minor: 0, is_archived: 0, created_at: '2026-09-01', updated_at: '2026-09-01', deleted_at: null, sync_status: 'LOCAL' } as const;
const mockRepo = { savePerson: jest.fn() };
const mockData = { db: {}, repo: mockRepo, transactions: [], people: [{ ...person }] as any[], allPeople: [{ ...person }] as any[], entries: [{ ...entry }] as any[], accounts: [{ ...account }] as any[], settings: { currency: 'PKR', week_start: 'MONDAY' }, refresh: jest.fn() };

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('@react-navigation/native', () => ({ DefaultTheme: { colors: {} }, useNavigation: () => mockNavigation, useIsFocused: () => true }));
jest.mock('@react-navigation/stack', () => ({ createStackNavigator: () => ({}) }));
jest.mock('@react-navigation/material-top-tabs', () => ({ createMaterialTopTabNavigator: () => ({}) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../hooks/useAppData', () => ({ useAppData: () => mockData }));
jest.mock('../components/dialogs/AppDialogProvider', () => ({ useAppDialog: () => mockDialog }));
jest.mock('../hooks/useConfirmOutflow', () => ({ useConfirmOutflow: () => mockConfirmOutflow, useConfirmActivityChange: () => jest.fn() }));
jest.mock('../services/people/PersonService', () => ({
  ...jest.requireActual('../services/people/PersonService'),
  archivePerson: jest.fn(),
  renamePerson: jest.fn(),
  recordPeopleAction: jest.fn(),
  restorePerson: jest.fn(),
}));

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  jest.clearAllMocks();
  mockNavigation.addListener.mockReturnValue(() => {});
  mockData.people = [{ ...person }];
  mockData.allPeople = [{ ...person }];
  mockData.entries = [{ ...entry }];
  mockData.refresh.mockResolvedValue(undefined);
  mockRepo.savePerson.mockResolvedValue('new-person');
  mockDialog.confirm.mockResolvedValue(true);
  mockConfirmOutflow.mockResolvedValue(true);
  jest.mocked(archivePerson).mockResolvedValue(undefined);
  jest.mocked(renamePerson).mockResolvedValue(undefined);
  jest.mocked(recordPeopleAction).mockResolvedValue({ id: 'settlement', type: 'RECEIVED_BACK', label: 'Received back', delta: -300000, nextBalance: 0, requiresCrossingConfirmation: false });
  jest.mocked(restorePerson).mockResolvedValue(undefined);
});

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
});

async function render(Component: any, params: Record<string, unknown> = { personId: 'ali' }) {
  await act(async () => { renderer = create(createElement(Component, { navigation: mockNavigation, route: { params } })); });
}

const secondary = (title: string) => renderer!.root.findAllByType(SecondaryButton).find((node) => node.props.title === title)!;
const field = (label: string) => renderer!.root.findAllByType(TextField).find((node) => node.props.label === label)!;

test('Person Detail shows friendly relationship, lifecycle actions, note and history', async () => {
  await render(PersonDetailScreen);
  const text = renderer!.root.findAllByType(Text).map((node) => node.props.children);
  expect(text).toContain('They owe you');
  expect(text).toContain('Class friend');
  expect(renderer!.root.findAllByType(ListRow).find((node) => node.props.title === 'Loan')).toBeTruthy();
  expect(renderer!.root.findAllByType(PrimaryButton).find((node) => node.props.title === 'Settle')).toBeTruthy();
  expect(['Give', 'Receive'].every((title) => secondary(title))).toBe(true);
  for (const label of ['Edit Person', 'Archive Person']) expect(renderer!.root.findAllByProps({ accessibilityLabel: label })[0].props.accessibilityRole).toBe('button');
});

test.each([0, 1, 20])('settled Person with %i history rows can collapse and keeps actions independent', async (rows) => {
  mockData.allPeople = [{ ...person, balance_minor: 0 }];
  mockData.entries = Array.from({ length: rows }, (_, i) => ({ ...entry, id: `entry-${i}` }));
  await render(PersonDetailScreen);
  expect(renderer!.root.findAllByType(PrimaryButton)).toHaveLength(0);
  expect(renderer!.root.findAllByType(SecondaryButton).map((n) => n.props.title)).toEqual(['Give', 'Receive']);
  const summary = () => renderer!.root.findByType(PersonSummary);
  expect(summary().props.collapsible).toBe(false);
  await act(async () => summary().props.onExpandedHeight(220));
  const parent = renderer!.root.findAllByProps({ testID: 'person-history-viewport' })[0];
  await act(async () => parent.props.onLayout({ nativeEvent: { layout: { height: 600 } } }));
  const controls = renderer!.root.findAllByProps({ testID: 'person-history-controls' })[0];
  await act(async () => controls.props.onLayout({ nativeEvent: { layout: { height: 100 } } }));
  expect(summary().props.collapsible).toBe(true);
  const list = renderer!.root.findByType(FlatList);
  expect(list.props.data).toHaveLength(rows);
  expect(list.props.contentContainerStyle.minHeight).toBeGreaterThan(600 - 220 - 100);
  expect(summary().findAllByType(SecondaryButton)).toHaveLength(0);
  expect(renderer!.root.findAllByProps({ accessibilityLabel: 'Expand Ali summary' }).length).toBeGreaterThan(0);
  const scrollTo = jest.spyOn(renderer!.root.findByType(FlatList).instance, 'scrollToOffset').mockImplementation(() => {});
  await act(async () => summary().props.scroll.setValue(200));
  await act(async () => renderer!.root.findAllByProps({ accessibilityLabel: 'Expand Ali summary' })[0].props.onPress());
  expect(scrollTo).toHaveBeenCalledWith({ offset: 0, animated: true });
  expect(renderer!.root.findAllByType(SecondaryButton).map((n) => n.props.title)).toEqual(['Give', 'Receive']);
  scrollTo.mockRestore();
});

test('Give monetary field formats native input, blocks zero, and passes integer minor units', async () => {
  await render(PersonEntryFormScreen, { personId: 'ali', action: 'GIVE' });
  const input = () => renderer!.root.findAllByType(TextInput).find((n) => n.props.accessibilityLabel === 'Amount')!;
  await act(async () => input().props.onChangeText('00'));
  await act(async () => renderer!.root.findByType(PrimaryButton).props.onPress());
  expect(recordPeopleAction).not.toHaveBeenCalled();
  expect(input().props.value).toBe('0');
  await act(async () => input().props.onChangeText('1234.50'));
  expect(input().props.value).toBe('1,234.50');
  await act(async () => renderer!.root.findByType(PrimaryButton).props.onPress());
  expect(recordPeopleAction).toHaveBeenCalledWith(mockData.db, expect.objectContaining({ amountMinor: 123450 }));
});

test('slow-release midpoint snaps through actual scroll and capsule expansion preserves fixed viewport/actions', async () => {
  jest.useFakeTimers();
  try {
    await render(PersonDetailScreen);
    await act(async () => {
      renderer!.root.findByType(PersonSummary).props.onExpandedHeight(220);
      renderer!.root.findAllByProps({ testID: 'person-history-viewport' })[0].props.onLayout({ nativeEvent: { layout: { height: 600 } } });
      renderer!.root.findAllByProps({ testID: 'person-history-controls' })[0].props.onLayout({ nativeEvent: { layout: { height: 100 } } });
    });
    const list = () => renderer!.root.findByType(FlatList);
    const capsule = () => renderer!.root.findByType(PersonCapsule);
    const distance = capsule().props.distance;
    const height = list().props.contentContainerStyle.minHeight;
    const scrollTo = jest.spyOn(list().instance, 'scrollToOffset').mockImplementation(() => {});
    await act(async () => { list().props.onScrollBeginDrag(); list().props.onScrollEndDrag({ nativeEvent: { contentOffset: { y: distance * 0.49 } } }); jest.advanceTimersByTime(80); });
    expect(scrollTo).toHaveBeenLastCalledWith({ offset: 0, animated: true });
    await act(async () => list().props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { y: 0 } } }));
    await act(async () => { list().props.onScrollBeginDrag(); list().props.onScrollEndDrag({ nativeEvent: { contentOffset: { y: distance * 0.51 } } }); jest.advanceTimersByTime(80); });
    expect(scrollTo).toHaveBeenLastCalledWith({ offset: distance, animated: true });
    await act(async () => list().props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { y: distance } } }));
    expect(capsule().props.collapsed).toBe(true);
    await act(async () => capsule().props.onExpand());
    expect(scrollTo).toHaveBeenLastCalledWith({ offset: 0, animated: true });
    await act(async () => list().props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { y: 0 } } }));
    expect(capsule().props.collapsed).toBe(false);
    expect(list().props.contentContainerStyle.minHeight).toBe(height);
    expect(renderer!.root.findAllByType(SecondaryButton).map((node) => node.props.title)).toEqual(['Give', 'Receive']);
    scrollTo.mockRestore();
  } finally { jest.useRealTimers(); }
});

test('Accounts placeholders are generic and its current balance uses canonical formatting', async () => {
  await render(AccountsScreen);
  expect(field('Account name').props.placeholder).toBe('Enter Bank Name');
  await act(async () => renderer!.root.findAllByType(Picker).find((n) => n.props.label === 'Account type')!.props.setValue('EWALLET'));
  expect(field('Account name').props.placeholder).toBe('Enter Wallet Name');
  const input = () => renderer!.root.findAllByType(TextInput).find((n) => n.props.accessibilityLabel === 'Current balance')!;
  await act(async () => input().props.onChangeText('170000'));
  expect(input().props.value).toBe('170,000');
  expect(renderer!.root.findAllByType(Text).some((n) => n.props.children === 'Total')).toBe(true);
});

test.each([
  [300000, 'BORROW'],
  [-300000, 'GIVE'],
])('Settle Balance routes balance %s to the existing %s action with a prefill', async (balance, action) => {
  mockData.allPeople = [{ ...person, balance_minor: balance }];
  await render(PersonDetailScreen);
  await act(async () => renderer!.root.findAllByType(PrimaryButton).find((node) => node.props.title === 'Settle')!.props.onPress());
  expect(mockNavigation.push).toHaveBeenCalledWith('PersonEntryForm', {
    personId: 'ali', action, settlement: true, currency: 'PKR', amountMinor: 300000, expectedBalanceMinor: balance,
  });
});

test('nonzero archive explains the remaining balance without calling the service', async () => {
  await render(PersonDetailScreen);
  await act(async () => renderer!.root.findAllByProps({ accessibilityLabel: 'Archive Person' })[0].props.onPress());
  expect(mockDialog.showDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'Settle balance first', message: expect.stringContaining('They still owe you Rs. 3,000') }));
  expect(archivePerson).not.toHaveBeenCalled();
});

test('Edit Person initializes name and note and saves without snapshot refresh overwriting input', async () => {
  await render(PersonEditScreen);
  expect(field('Person name').props.value).toBe('Ali');
  expect(field('Note optional').props.value).toBe('Class friend');
  await act(async () => field('Person name').props.onChangeText('Ali Khan'));
  await act(async () => field('Note optional').props.onChangeText('University friend'));
  await act(async () => renderer!.root.findByType(PrimaryButton).props.onPress());
  expect(renamePerson).toHaveBeenCalledWith(mockData.db, 'ali', person.updated_at, 'Ali Khan', 'University friend');
  expect(mockNavigation.goBack).toHaveBeenCalled();
});

test('partial settlement keeps editable prefill and uses the safe People action with outflow warning', async () => {
  mockData.people = [{ ...person, balance_minor: -300000 }];
  await render(PersonEntryFormScreen, { personId: 'ali', action: 'GIVE', settlement: true, amountMinor: 300000, expectedBalanceMinor: -300000 });
  expect(field('Amount').props.value).toBe('3000');
  expect(field('Date').props.value).not.toBe('');
  await act(async () => field('Amount').props.onChangeText('2000'));
  await act(async () => renderer!.root.findByType(PrimaryButton).props.onPress());
  expect(mockConfirmOutflow).toHaveBeenCalledWith('cash', 200000);
  expect(recordPeopleAction).toHaveBeenCalledWith(mockData.db, expect.objectContaining({ action: 'GIVE', amountMinor: 200000, expectedBalanceMinor: -300000 }));
});

test('archived Person Detail keeps history, removes money actions, and restores the same identity', async () => {
  mockData.allPeople = [{ ...person, balance_minor: 0, is_archived: 1 }];
  await render(PersonDetailScreen);
  expect(renderer!.root.findAllByType(Text).map((node) => node.props.children)).toContain('Archived people remain available in historical records and groups.');
  expect(renderer!.root.findAllByType(PrimaryButton)).toHaveLength(0);
  expect(renderer!.root.findAllByType(SecondaryButton).map((node) => node.props.title)).toEqual(['Restore Person']);
  expect(renderer!.root.findAllByType(ListRow)).toHaveLength(1);
  await act(async () => secondary('Restore Person').props.onPress());
  expect(restorePerson).toHaveBeenCalledWith(mockData.db, 'ali', person.updated_at);
  expect(mockData.refresh).toHaveBeenCalledTimes(1);
});

test('one-shot People action uses an active Person ID, clears its route intent, and skips archived People', async () => {
  mockData.people = [{ ...person }];
  mockData.allPeople = [{ ...person }, { ...person, id: 'archived', name: 'Archived Ali', is_archived: 1 }];
  await render(PeopleScreen, { action: 'GIVE' });
  const rows = renderer!.root.findAllByType(ListRow);
  expect(rows.map((row) => row.props.title)).toEqual(['Ali']);
  await act(async () => rows[0].props.onPress());
  expect(mockNavigation.setParams).toHaveBeenCalledWith({ action: undefined });
  expect(mockNavigation.push).toHaveBeenCalledWith('PersonEntryForm', { personId: 'ali', action: 'GIVE' });
});

test('archived People are discoverable outside a money-selection flow', async () => {
  mockData.allPeople = [{ ...person }, { ...person, id: 'archived', name: 'Archived Ali', balance_minor: 0, is_archived: 1 }];
  await render(PeopleScreen, {});
  await act(async () => secondary('Show Archived People').props.onPress());
  const archived = renderer!.root.findAllByType(ListRow).find((row) => row.props.title === 'Archived Ali')!;
  expect(archived.props.subtitle).toBe('Archived');
  await act(async () => archived.props.onPress());
  expect(mockNavigation.navigate).toHaveBeenCalledWith('PersonDetail', { personId: 'archived' });
});

test('Add person opens inline and a successful save dismisses and clears the form', async () => {
  const dismiss = jest.spyOn(Keyboard, 'dismiss');
  await render(PeopleScreen, {});
  const addButton = renderer!.root.findByProps({ accessibilityLabel: 'Add person' });
  await act(async () => addButton.props.onPress());
  expect(renderer!.root.findByProps({ accessibilityLabel: 'Add person panel' })).toBeTruthy();
  expect(field('Person name').props.autoFocus).toBe(true);
  await act(async () => field('Person name').props.onChangeText('Sam'));
  await act(async () => renderer!.root.findAllByType(PrimaryButton).find((node) => node.props.title === 'Save Person')!.props.onPress());
  expect(mockRepo.savePerson).toHaveBeenCalledWith(mockData.db, 'Sam');
  expect(mockData.refresh).toHaveBeenCalledTimes(1);
  expect(field('Person name').props.value).toBe('');
  expect(dismiss).toHaveBeenCalled();
  dismiss.mockRestore();
});

test('Add person keeps the typed name when persistence fails', async () => {
  mockRepo.savePerson.mockRejectedValueOnce(new Error('write failed'));
  await render(PeopleScreen, {});
  await act(async () => renderer!.root.findByProps({ accessibilityLabel: 'Add person' }).props.onPress());
  await act(async () => field('Person name').props.onChangeText('Keep me'));
  await act(async () => renderer!.root.findAllByType(PrimaryButton).find((node) => node.props.title === 'Save Person')!.props.onPress());
  expect(field('Person name').props.value).toBe('Keep me');
  expect(mockData.refresh).not.toHaveBeenCalled();
});

test('People list rows are cards with a person icon tinted by who owes whom', async () => {
  mockData.people = [{ ...person, id: 'a', name: 'Owes me', balance_minor: 500 }, { ...person, id: 'b', name: 'I owe', balance_minor: -300 }, { ...person, id: 'c', name: 'Settled', balance_minor: 0 }];
  mockData.allPeople = mockData.people;
  await render(PeopleScreen, {});
  const rows = renderer!.root.findAllByType(ListRow).filter((row) => ['Owes me', 'I owe', 'Settled'].includes(row.props.title));
  expect(rows.map((row) => [row.props.title, row.props.card, row.props.icon, row.props.iconTone])).toEqual([
    ['I owe', true, 'person-outline', 'negative'], ['Owes me', true, 'person-outline', 'positive'], ['Settled', true, 'person-outline', 'neutral'], // open balances first, then A-Z
  ]);
});

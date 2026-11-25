import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { FlatList, Text } from 'react-native';
import { EmptyState, ListRow, TextField } from '../components/common';
import { BarChart, compactAmount, DonutChart } from '../components/Charts';
import { Picker } from '../components/forms';
import { InsightsScreen } from '../navigation/InsightsScreen';
import { InsightsCategoryDetailScreen } from '../navigation/InsightsCategoryDetailScreen';
import { listPersonalSpendingActivity, type ActivityRow } from '../services/activity/ActivityService';
import type { Person, PersonEntry, Subscription } from '../types/models';

const mockNavigation = { goBack: jest.fn(), navigate: jest.fn() };
const record = { created_at: '', updated_at: '', deleted_at: null, sync_status: 'LOCAL' as const };
const mockData = {
  db: {},
  currentDateKey: '2026-09-17',
  settings: { currency: 'PKR', week_start: 'MONDAY' },
  accounts: [{ ...record, id: 'cash', name: 'Cash', type: 'CASH', currency: 'PKR', opening_balance_minor: 5000, is_archived: 0 }],
  categories: [{ ...record, id: 'food', name: 'Food', type: 'EXPENSE', icon: '', color_key: '', is_default: 1, is_archived: 0 }],
  transactions: [{ ...record, id: 'expense', type: 'EXPENSE', amount_minor: 1000, account_id: 'cash', destination_account_id: null, category_id: 'food', title: 'Dinner', note: null, occurred_on: '2026-09-10', source: 'MANUAL', group_id: null, financial_event_id: null }],
  allPeople: [] as Person[],
  entries: [] as PersonEntry[],
  subscriptions: [] as Subscription[],
};

jest.mock('@react-navigation/native', () => ({ useNavigation: () => mockNavigation, useIsFocused: () => true }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../hooks/useAppData', () => ({ useAppData: () => mockData }));
jest.mock('../components/dialogs/AppDialogProvider', () => ({ useAppDialog: () => ({ select: jest.fn(), showDialog: jest.fn() }) }));
jest.mock('../services/activity/ActivityService', () => ({ ...jest.requireActual('../services/activity/ActivityService'), listPersonalSpendingActivity: jest.fn() }));

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  jest.clearAllMocks();
  mockData.transactions = [{ ...record, id: 'expense', type: 'EXPENSE', amount_minor: 1000, account_id: 'cash', destination_account_id: null, category_id: 'food', title: 'Dinner', note: null, occurred_on: '2026-09-10', source: 'MANUAL', group_id: null, financial_event_id: null }];
  mockData.allPeople = [];
  mockData.entries = [];
  mockData.subscriptions = [];
  jest.mocked(listPersonalSpendingActivity).mockResolvedValue([]);
});
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; });

async function renderScreen() {
  await act(async () => { renderer = create(createElement(InsightsScreen, { navigation: mockNavigation })); });
}

function textContent() {
  return renderer!.root.findAllByType(Text).map((node) => node.props.children).flat(Infinity).filter((value) => typeof value === 'string').join(' ');
}

test('renders separate personal result, cash movement, People and net-position labels', async () => {
  await renderScreen();
  const text = textContent();
  expect(text).toContain('Personal financial result');
  expect(text).toContain('Income minus spending');
  expect(text).toContain('Account cash change');
  expect(text).toContain('Current People balances');
  expect(text).toContain('Net personal position');
  expect(text).not.toContain('Net cash change');
});

test('custom range reuses calendar fields and preserves invalid values for correction', async () => {
  await renderScreen();
  const range = renderer!.root.findAllByType(Picker).find((node) => node.props.label === 'Date range')!;
  await act(async () => range.props.setValue('CUSTOM'));
  const field = (label: string) => renderer!.root.findAllByType(TextField).find((node) => node.props.label === label)!;
  await act(async () => field('From').props.onChangeText('20-09-2026'));
  await act(async () => field('To').props.onChangeText('10-09-2026'));
  expect(field('From').props.value).toBe('20-09-2026');
  expect(field('To').props.value).toBe('10-09-2026');
  expect(renderer!.root.findAllByType(Text).some((node) => node.props.accessibilityRole === 'alert' && String(node.props.children).includes('To must be on or after From'))).toBe(true);
});

test('custom range shows one human-readable summary without the numeric duplicate', async () => {
  await renderScreen();
  await act(async () => renderer!.root.findAllByType(Picker).find((node) => node.props.label === 'Date range')!.props.setValue('CUSTOM'));
  const field = (label: string) => renderer!.root.findAllByType(TextField).find((node) => node.props.label === label)!;
  await act(async () => { field('From').props.onChangeText('07-10-2026'); field('To').props.onChangeText('07-10-2026'); });
  const text = textContent();
  expect(text).toContain('7 October 2026 to 7 October 2026');
  expect(text).not.toContain('07-10-2026 to 07-10-2026');
});

test('category bars expose exact personal amount and navigate to dedicated Activity drill-down', async () => {
  await renderScreen();
  const food = renderer!.root.findAllByType(ListRow).find((node) => node.props.title === 'Food')!;
  expect(food.props.subtitle).toBe('100% of spending');
  // Category shares are a donut with this row as its legend; the trend is a bar chart.
  expect(renderer!.root.findAllByType(DonutChart)).toHaveLength(1);
  expect(renderer!.root.findByType(BarChart).props.points).toHaveLength(6);
  expect(food.props.iconColor).toBe('#446A5A');
  await act(async () => food.props.onPress());
  expect(mockNavigation.navigate).toHaveBeenCalledWith('InsightsCategoryDetail', {
    categoryId: 'food', categoryName: 'Food', from: '2026-09-01', to: '2026-09-30', currency: 'PKR',
  });
});

test('dedicated category detail uses stable IDs and opens ordinary and shared source details', async () => {
  const ordinary = { id: 'personal:tx', kind: 'transaction', source_id: 'tx', label: 'Expense', title: 'Dinner', amount_minor: 1000, occurred_on: '2026-09-10' } as ActivityRow;
  const shared = { ...ordinary, id: 'personal:shared', kind: 'shared', source_id: 'split', label: 'Shared expense | Your share', title: 'Group dinner', amount_minor: 400 } as ActivityRow;
  jest.mocked(listPersonalSpendingActivity).mockResolvedValue([ordinary, shared]);
  await act(async () => { renderer = create(createElement(InsightsCategoryDetailScreen, {
    navigation: mockNavigation,
    route: { params: { categoryId: 'food', categoryName: 'Food', from: '2026-09-01', to: '2026-09-30' } },
  })); });
  expect(listPersonalSpendingActivity).toHaveBeenCalledWith(mockData.db, { categoryId: 'food', from: '2026-09-01', to: '2026-09-30' });
  const list = renderer!.root.findByType(FlatList);
  expect(list.props.data).toEqual([ordinary, shared]);
  await act(async () => list.props.renderItem({ item: ordinary }).props.onPress());
  await act(async () => list.props.renderItem({ item: shared }).props.onPress());
  expect(mockNavigation.navigate).toHaveBeenNthCalledWith(1, 'ActivityDetail', { kind: 'transaction', sourceId: 'tx' });
  expect(mockNavigation.navigate).toHaveBeenNthCalledWith(2, 'ActivityDetail', { kind: 'shared', sourceId: 'split' });
  expect(textContent()).toContain('September');
  expect(textContent()).toContain('2026');
});

test('empty spending keeps the independent sections visible with useful empty states', async () => {
  mockData.transactions = [];
  await renderScreen();
  expect(renderer!.root.findAllByType(EmptyState).some((node) => node.props.title === 'No personal spending in this range.')).toBe(true);
  expect(textContent()).toContain('No current People balances.');
  expect(textContent()).toContain('No active subscription commitments.');
});

test('subscription estimate is clearly reporting-only and future plans are excluded from actuals', async () => {
  mockData.transactions = [];
  mockData.subscriptions = [{ ...record, id: 'sub', name: 'Annual', amount_minor: 12000, category_id: 'food', account_id: 'cash', frequency_type: 'YEARLY', frequency_interval: 1, start_date: '2026-01-01', next_renewal_date: '2027-01-01', end_date: null, total_cycles: null, completed_cycles: 0, reminder_enabled: 0, reminder_days_before: 0, cancellation_reminder_enabled: 0, cancellation_reminder_date: null, status: 'ACTIVE', note: null }];
  await renderScreen();
  const subscription = renderer!.root.findAllByType(ListRow).find((node) => node.props.title === 'Estimated monthly subscriptions')!;
  expect(subscription.props.subtitle).toBe('1 active | Reporting estimate only');
  expect(JSON.stringify(renderer!.toJSON())).toContain('Future planned payments and subscription estimates are not included in actual income, spending or cash movement until a payment is recorded.');
});

test('chart labels use short amounts', () => {
  expect([compactAmount(95_00), compactAmount(1_250_00), compactAmount(12_345_00), compactAmount(2_500_000_00)]).toEqual(['95', '1.3k', '12k', '2.5M']);
});

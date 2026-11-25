import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { Modal, Platform, Text } from 'react-native';
import { InfoTip } from '../components/InfoTip';
import { activityIcon, categoryIcon, categoryRows } from '../utils/icons';

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

let renderer: ReactTestRenderer | undefined;
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; });

test('category icons: default names, keywords for custom names, a specific saved icon wins, generic fallback', () => {
  expect(categoryIcon({ name: 'Food', type: 'EXPENSE', icon: 'pricetag-outline' })).toBe('restaurant-outline');
  expect(categoryIcon({ name: 'Transport', type: 'EXPENSE', icon: 'pricetag-outline' })).toBe('bus-outline');
  expect(categoryIcon({ name: 'Salary', type: 'INCOME', icon: 'cash-outline' })).toBe('briefcase-outline');
  expect(categoryIcon({ name: 'Weekly groceries', type: 'EXPENSE', icon: 'pricetag-outline' })).toBe('cart-outline');
  // Custom names with no known icon fall back to the Add sheet's Expense / Income arrows.
  expect(categoryIcon({ name: 'QA Test Category', type: 'EXPENSE', icon: 'pricetag-outline' })).toBe('arrow-up-outline');
  expect(categoryIcon({ name: 'Side gigs', type: 'INCOME', icon: 'cash-outline' })).toBe('arrow-down-outline');
  expect(categoryIcon({ name: 'Hobby', type: 'EXPENSE', icon: 'color-palette-outline' })).toBe('color-palette-outline');
  expect(categoryRows([{ id: 'c', name: 'Bills', type: 'EXPENSE', icon: 'pricetag-outline' }])).toEqual([['c', 'Bills', 'receipt-outline']]);
  // Every default category has its own icon (12 expense + 6 income).
  for (const name of ['Food', 'Transport', 'Shopping', 'Bills', 'Education', 'Entertainment', 'Health', 'Fuel', 'Rent', 'Subscriptions', 'Gifts', 'Other']) expect(categoryIcon({ name, type: 'EXPENSE', icon: 'pricetag-outline' })).not.toBe('pricetag-outline');
  for (const name of ['Salary', 'Freelance', 'Business', 'Gift Received', 'Refund']) expect(categoryIcon({ name, type: 'INCOME', icon: 'cash-outline' })).not.toBe('cash-outline');
  expect(categoryIcon({ name: 'Other Income', type: 'INCOME', icon: 'cash-outline' })).toBe('cash-outline');
  expect(['Archived Dining', 'Donations', 'Gaming', 'Pet Care', 'Car Maintenance'].map((name) => categoryIcon({ name, type: 'EXPENSE', icon: 'pricetag-outline' }))).toEqual(['restaurant-outline', 'heart-outline', 'game-controller-outline', 'paw-outline', 'car-outline']);
});

test('activity icons: transfers and adjustments are neutral; expense/income tones stay subtle', () => {
  expect(activityIcon({ kind: 'transaction', type: 'TRANSFER' })).toEqual({ name: 'swap-horizontal-outline', tone: 'neutral' });
  expect(activityIcon({ kind: 'transaction', type: 'ADJUSTMENT' })).toEqual({ name: 'options-outline', tone: 'neutral' });
  expect(activityIcon({ kind: 'shared', type: 'SHARED', group_id: null })).toEqual({ name: 'people-circle-outline', tone: 'negative' });
});

test('an (i) tip stays hidden until tapped, then shows its text in a bubble and closes on an outside tap', async () => {
  await act(async () => { renderer = create(createElement(InfoTip, { text: 'Extra detail here.', label: 'Opening balance' })); });
  expect(renderer!.root.findAllByType(Modal)).toHaveLength(0);
  // The jest View mock has a no-op measureInWindow; answer it like a device would.
  const host = renderer!.root.findAll((node) => node.props.accessibilityLabel === 'About Opening balance' && !!node.instance?.measureInWindow)[0];
  jest.mocked(host.instance.measureInWindow).mockImplementation((callback: (x: number, y: number, w: number, h: number) => void) => callback(100, 200, 20, 20));
  await act(async () => renderer!.root.findByProps({ accessibilityLabel: 'About Opening balance' }).props.onPress());
  expect(renderer!.root.findAllByType(Text).map((node) => node.props.children)).toContain('Extra detail here.');
  await act(async () => renderer!.root.findByProps({ accessibilityLabel: 'Close information' }).props.onPress());
  expect(renderer!.root.findAllByType(Modal)).toHaveLength(0);
});

test('the battery hint appears only on phone brands known to stop background apps', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BackgroundReminderHint } = require('../components/ReminderControls') as typeof import('../components/ReminderControls');
  const os = Object.getOwnPropertyDescriptor(Platform, 'OS');
  const constants = Object.getOwnPropertyDescriptor(Platform, 'constants');
  const render = (maker: string) => {
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
    Object.defineProperty(Platform, 'constants', { configurable: true, get: () => ({ Manufacturer: maker, Brand: maker }) });
    return BackgroundReminderHint();
  };
  try {
    expect(render('Xiaomi')).not.toBeNull();
    expect(render('Google')).toBeNull();
  } finally {
    if (os) Object.defineProperty(Platform, 'OS', os);
    if (constants) Object.defineProperty(Platform, 'constants', constants);
  }
});

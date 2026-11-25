import { act, createElement } from 'react';
import { Modal, Text } from 'react-native';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { DateField, getCalendarMonths } from '../components/common';
import { addDays, dateKeyToInputDate, todayLocal } from '../utils/date';

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../hooks/useAppData', () => ({ useAppData: () => ({ settings: { week_start: 'MONDAY' } }) }));

let renderer: ReactTestRenderer | undefined;
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; });

const monthKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
const today = todayLocal();

async function open(value: string, props: { allowFuture?: boolean; allowPast?: boolean }) {
  const onChangeText = jest.fn();
  await act(async () => { renderer = create(createElement(DateField, { value, onChangeText, label: 'Next Date', ...props })); });
  await act(async () => renderer!.root.findByProps({ accessibilityLabel: 'Change Next Date' }).props.onPress());
  return onChangeText;
}
const nav = (label: string) => renderer!.root.findAll((node) => node.props.accessibilityLabel === label && node.props.accessibilityRole === 'button')[0];
// Pages render in order, so the first text for a day number belongs to the current month.
function greyed(day: number): boolean {
  let node = renderer!.root.findAllByType(Text).find((text) => text.props.children === day)!.parent;
  for (let depth = 0; node && depth < 4; depth++, node = node.parent) if (node.props.accessibilityState?.disabled === true) return true;
  return false;
}

test('future-only months never start before the current month', () => {
  const months = getCalendarMonths(new Date(), true, false).map(monthKey);
  expect(months[0]).toBe(today.slice(0, 7));
  expect(months.length).toBeGreaterThan(1);
  // Default behaviour (past allowed) is unchanged.
  expect(getCalendarMonths(new Date(), true).map(monthKey)[0] < today.slice(0, 7)).toBe(true);
});

test('future-only calendar disables the previous arrow and greys every past day', async () => {
  await open(dateKeyToInputDate(today), { allowFuture: true, allowPast: false });
  expect(nav('Previous month').props.disabled).toBe(true);
  expect(nav('Next month').props.disabled).toBe(false);
  const day = Number(today.slice(8));
  if (day > 1) expect(greyed(day - 1)).toBe(true);
  expect(greyed(day)).toBe(false);
});

test('an existing overdue value is kept but the calendar opens on the current month', async () => {
  const overdue = addDays(today, -200);
  const onChangeText = await open(dateKeyToInputDate(overdue), { allowFuture: true, allowPast: false });
  expect(onChangeText).not.toHaveBeenCalled();
  expect(nav('Previous month').props.disabled).toBe(true);
  const title = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  expect(renderer!.root.findAllByType(Text).some((node) => node.props.children === title)).toBe(true);
});

test('past-allowed calendars still let the user go back', async () => {
  await open(dateKeyToInputDate(today), {});
  expect(nav('Previous month').props.disabled).toBe(false);
});

test('greyed-out days sit under no pressable, so a swipe starting on them reaches the month pager', async () => {
  await open(dateKeyToInputDate(today), { allowFuture: true, allowPast: false });
  const day = Number(today.slice(8));
  if (day === 1) return;
  let node = renderer!.root.findAllByType(Text).find((text) => text.props.children === day - 1)!.parent;
  expect(greyed(day - 1)).toBe(true);
  for (; node && node.type !== Modal; node = node.parent) expect(node.props.onPress).toBeUndefined();
  // Tapping outside the card still closes the calendar.
  await act(async () => renderer!.root.findByProps({ accessibilityLabel: 'Close calendar' }).props.onPress());
  expect(renderer!.root.findAllByType(Modal)).toHaveLength(0);
});

test('today is marked and announced, the selected day is announced as selected', async () => {
  await open(dateKeyToInputDate(today), {});
  const buttons = renderer!.root.findAll((node) => typeof node.props.accessibilityLabel === 'string' && node.props.accessibilityLabel.endsWith(', today') && node.props.accessibilityRole === 'button');
  expect(buttons.length).toBeGreaterThan(0);
  expect(buttons[0].props.accessibilityState).toEqual({ selected: true });
});

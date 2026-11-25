import { act, createElement, useState } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { TextInput } from 'react-native';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ListRow, TextField } from '../components/common';
import { fittingPreviewRows, previewLayout, PREVIEW_PADDING, ResponsivePreview, setPreviewLayoutStoreForTests } from '../components/ResponsivePreview';
import { personHistoryLayout } from '../components/PersonSummary';
import { formatMoneyEdit, formatMoneyInput, moneyToMinorUnits, signedMoneyToMinorUnits } from '../utils/money';

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
jest.mock('../hooks/useAppData', () => ({ useAppData: () => ({ settings: { currency: 'PKR' } }) }));

test.each([
  ['1000', '1,000'], ['10000', '10,000'], ['100000', '100,000'], ['1234567', '1,234,567'],
  ['00', '0'], ['000', '0'], ['0005', '5'], ['05', '5'], ['000100', '100'],
  ['.', '0.'], ['0.5', '0.5'], ['10.25', '10.25'], ['1234.50', '1,234.50'], ['', ''], ['-0500', '-500'],
])('money presentation %s -> %s', (input, expected) => expect(formatMoneyInput(input)).toBe(expected));

test('typing, deleting and middle insertion preserve semantic cursor position', () => {
  expect(formatMoneyEdit('100', '1000', { start: 3, end: 3 })).toEqual({ value: '1,000', selection: { start: 5, end: 5 } });
  expect(formatMoneyEdit('1,500', '00', { start: 0, end: 3 })).toEqual({ value: '0', selection: { start: 1, end: 1 } });
  expect(formatMoneyEdit('0', '05', { start: 1, end: 1 })).toEqual({ value: '5', selection: { start: 1, end: 1 } });
  expect(formatMoneyEdit('1,234', '1,9234', { start: 2, end: 2 })).toEqual({ value: '19,234', selection: { start: 3, end: 3 } });
  expect(formatMoneyEdit('1,234', '1,34')).toEqual({ value: '134', selection: { start: 1, end: 1 } });
});

test('formatted input uses authoritative minor units and preserves precision validation', () => {
  expect(moneyToMinorUnits('1,234.50')).toBe(123450);
  expect(moneyToMinorUnits(formatMoneyInput('.5'))).toBe(50);
  expect(signedMoneyToMinorUnits('-1,234.50')).toBe(-123450);
  for (const input of ['', '0', '00', '0.00']) expect(moneyToMinorUnits(formatMoneyInput(input)) > 0).toBe(false);
  expect(moneyToMinorUnits('1.234')).toBeNaN();
});

function Field({ money = true }: { money?: boolean }) {
  const [value, setValue] = useState('');
  return createElement(TextField, { label: 'Amount', keyboardType: 'decimal-pad', money, value, onChangeText: setValue });
}
test('rendered monetary input formats and corrects cursor while ratio fields opt out', async () => {
  let view!: ReactTestRenderer;
  await act(async () => { view = create(createElement(Field)); });
  const input = () => view.root.findByType(TextInput);
  await act(async () => input().props.onChangeText('1234.50'));
  expect(input().props.value).toBe('1,234.50');
  await act(async () => input().props.onChangeText('00'));
  expect(input().props.value).toBe('0');
  expect(input().props.selection).toEqual({ start: 1, end: 1 });
  await act(async () => input().props.onChangeText('.'));
  expect(input().props.value).toBe('0.');
  await act(async () => view.unmount());
  await act(async () => { view = create(createElement(Field, { money: false })); });
  await act(async () => input().props.onChangeText('1000'));
  expect(input().props.value).toBe('1000');
  await act(async () => view.unmount());
});

test('Home fits only whole measured rows, capped at four', () => {
  expect(fittingPreviewRows(280, [70, 70, 70, 70, 70])).toBe(4);
  expect(fittingPreviewRows(279, [70, 70, 70, 70])).toBe(3);
  expect(fittingPreviewRows(150, [90, 90, 90, 90])).toBe(1);
  expect(fittingPreviewRows(280, [0, 70])).toBe(0);
});

test('rendered Home preview responds to measured room and excludes hidden rows from accessibility', async () => {
  let view!: ReactTestRenderer;
  await act(async () => { view = create(createElement(ResponsivePreview, null, ['one', 'two', 'three', 'four'])); });
  const container = () => view.root.findAllByProps({ testID: 'home-activity-preview' })[0];
  const row = (i: number) => view.root.findAllByProps({ testID: `home-preview-row-${i}` })[0];
  await act(async () => {
    container().props.onLayout({ nativeEvent: { layout: { height: 280 } } });
    for (let i = 0; i < 4; i++) row(i).props.onLayout({ nativeEvent: { layout: { height: 70 } } });
  });
  expect(row(3).props.accessibilityElementsHidden).toBe(false);
  expect(row(3).props.pointerEvents).toBe('auto');
  await act(async () => container().props.onLayout({ nativeEvent: { layout: { height: 210 } } }));
  expect(row(2).props.accessibilityElementsHidden).toBe(false);
  expect(row(3).props.accessibilityElementsHidden).toBe(true);
  expect(row(3).props.pointerEvents).toBe('none');
  await act(async () => view.unmount());
});

test.each([0, 60, 1200])('Person history content %i can reach full collapse even after the viewport grows', (history) => {
  const { collapsible, distance, minContentHeight } = personHistoryLayout(600, 258, 100);
  const expandedViewport = 600 - 258 - 100;
  const collapsedViewport = expandedViewport + distance;
  expect(collapsible).toBe(true);
  expect(Math.max(history, minContentHeight) - collapsedViewport).toBeGreaterThanOrEqual(distance);
  if (history > minContentHeight) expect(Math.max(history, minContentHeight)).toBe(history);
  expect(personHistoryLayout(0, 258, 100).collapsible).toBe(false);
});

test('Home keeps card size and shares leftover room as gaps only when cards were left out', () => {
  expect(previewLayout(256, [64, 64, 64, 64])).toEqual({ count: 4, gap: 0 });
  // 4 cards need 256; 292 leaves 36 spare but a 5th card would not fit: 9 extra after each card.
  expect(previewLayout(292, [64, 64, 64, 64, 64], 8)).toEqual({ count: 4, gap: 9 });
  // All rows already shown: no stretching of a short list.
  expect(previewLayout(600, [64, 64])).toEqual({ count: 2, gap: 0 });
  expect(previewLayout(100, [64, 64, 64], 8)).toEqual({ count: 1, gap: 36 });
  expect(previewLayout(40, [64])).toEqual({ count: 0, gap: 0 });
  expect(previewLayout(300, [64, 0])).toEqual({ count: 0, gap: 0 });
});

test('Home preview spaces whole cards, keeps their padding, and remembers the measured layout per window size', async () => {
  const saved = new Map<string, string>();
  setPreviewLayoutStoreForTests({ getItemSync: (key) => saved.get(key) ?? null, setItemAsync: async (key, value) => { saved.set(key, value); } });
  try {
    const rows = () => [1, 2, 3, 4, 5].map((id) => createElement(ListRow, { key: id, preview: true, title: `Row ${id}`, subtitle: 'Expense', onPress: () => {} }));
    let view!: ReactTestRenderer;
    await act(async () => { view = create(createElement(ResponsivePreview, { max: 8 } as Parameters<typeof ResponsivePreview>[0], rows())); });
    const row = (i: number) => view.root.findAllByProps({ testID: `home-preview-row-${i}` })[0];
    await act(async () => {
      view.root.findAllByProps({ testID: 'home-activity-preview' })[0].props.onLayout({ nativeEvent: { layout: { height: 292 } } });
      for (let i = 0; i < 5; i++) row(i).props.onLayout({ nativeEvent: { layout: { height: 64 } } });
    });
    expect(view.root.findAllByType(ListRow).map((node) => node.props.verticalPadding)).toEqual(Array(5).fill(PREVIEW_PADDING));
    expect([0, 1, 2, 3].map((i) => row(i).props.style.top)).toEqual([0, 73, 146, 219]);
    expect(row(3).props.pointerEvents).toBe('auto');
    expect(row(4).props.pointerEvents).toBe('none');
    expect(row(4).props.accessibilityElementsHidden).toBe(true);
    expect(Object.values(JSON.parse([...saved.values()][0]))).toEqual([{ available: 292, heights: [64, 64, 64, 64, 64] }]);
    await act(async () => view.unmount());
    // Next start with the same window size: laid out from the saved values before any measuring.
    await act(async () => { view = create(createElement(ResponsivePreview, { max: 8 } as Parameters<typeof ResponsivePreview>[0], rows())); });
    expect(row(3).props.pointerEvents).toBe('auto');
    expect(row(3).props.style.top).toBe(219);
    expect(row(4).props.pointerEvents).toBe('none');
    await act(async () => view.unmount());
  } finally { setPreviewLayoutStoreForTests(undefined); }
});

test('Android system bar and form layout have one keyboard-resize owner', () => {
  const app = readFileSync(resolve(__dirname, '../../App.tsx'), 'utf8');
  const forms = readFileSync(resolve(__dirname, '../components/forms.tsx'), 'utf8');
  const config = JSON.parse(readFileSync(resolve(__dirname, '../../app.json'), 'utf8'));
  expect(app).toContain('<StatusBar hidden={false} style="dark" />');
  expect(forms).toContain("enabled={Platform.OS === 'ios'}");
  expect(forms).not.toContain('automaticallyAdjustKeyboardInsets');
  expect(config.expo.android.softwareKeyboardLayoutMode).toBe('resize');
  expect(app).toContain("Appearance.setColorScheme('light')");
  expect(app).toContain('SystemUI.setBackgroundColorAsync(colors.background)');
  expect(config.expo.backgroundColor).toBe('#EEF1EA');
  expect(config.expo.android.userInterfaceStyle).toBe('light');
  expect(config.expo.plugins).toContain('expo-system-ui');
});

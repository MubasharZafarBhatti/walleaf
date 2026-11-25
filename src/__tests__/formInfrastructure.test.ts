import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { FlatList, Keyboard, Modal, ScrollView, TextInput } from 'react-native';
import { KeyboardSafeScrollView, focusScrollDelta } from '../components/KeyboardSafeScrollView';
import { TextField } from '../components/common';
import { Picker } from '../components/forms';
import { changedName, validMoneyInput } from '../utils/formValidation';

const mockDialog = { showDialog: jest.fn() };
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('@react-navigation/native', () => ({ useNavigation: () => ({ goBack: jest.fn() }) }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
jest.mock('../hooks/useAppData', () => ({ useAppData: () => ({ settings: { currency: 'PKR' } }) }));
jest.mock('../components/dialogs/AppDialogProvider', () => ({ useAppDialog: () => mockDialog }));

test('focus geometry scrolls only the obscured part in either direction', () => {
  expect(focusScrollDelta(200, 56, 100, 400)).toBe(0);
  expect(focusScrollDelta(350, 56, 100, 400)).toBe(22);
  expect(focusScrollDelta(90, 56, 100, 400)).toBe(-26);
});

test('money form gates retain zero/optional meanings and reject unsafe/invalid amounts', () => {
  expect(validMoneyInput('1,234.50')).toBe(true);
  for (const value of ['', '.', '0', '00', '-1', '1.234', '9007199254740991']) expect(validMoneyInput(value)).toBe(false);
  expect(validMoneyInput('', { optional: true })).toBe(true);
  expect(validMoneyInput('0', { allowZero: true })).toBe(true);
  expect(changedName(' Cash ', 'cash')).toBe(false);
  expect(changedName('HBL', 'Cash')).toBe(true);
});

test('keyboard room exists only while open; focus scrolling preserves refs and caller callbacks', async () => {
  jest.useFakeTimers();
  const events = new Map<string, (event?: any) => void>();
  const removals: jest.Mock[] = [];
  jest.spyOn(Keyboard, 'metrics').mockReturnValue(undefined);
  jest.spyOn(Keyboard, 'addListener').mockImplementation((name, listener) => {
    events.set(name, listener);
    const remove = jest.fn(); removals.push(remove);
    return { remove } as unknown as ReturnType<typeof Keyboard.addListener>;
  });
  const scrollTo = jest.fn();
  const onFocus = jest.fn();
  const onContentSizeChange = jest.fn();
  let fieldTop = 470;
  const externalRef = { current: null as any };
  let view!: ReactTestRenderer;
  try {
    await act(async () => {
      view = create(createElement(KeyboardSafeScrollView, { onContentSizeChange }, createElement(TextField, { ref: externalRef, label: 'Bottom note', onFocus })));
    });
    expect(!!externalRef.current).toBe(true);
    externalRef.current.measureInWindow = (callback: any) => callback(0, fieldTop, 200, 56);
    view.root.findAllByProps({ testID: 'keyboard-form-viewport' })[0].instance.measureInWindow = (callback: any) => callback(0, 100, 300, 600);
    view.root.findByType(ScrollView).instance.scrollTo = scrollTo;
    expect(view.root.findAllByProps({ testID: 'keyboard-form-spacer' })).toHaveLength(0);
    await act(async () => {
      view.root.findByType(TextInput).props.onFocus({ nativeEvent: {} });
      events.get('keyboardDidShow')!({ endCoordinates: { screenY: 500 } });
      jest.runOnlyPendingTimers();
    });
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ y: 42, animated: true });
    expect(view.root.findAllByProps({ testID: 'keyboard-form-spacer' }).length).toBeGreaterThan(0);
    // Android 15+ edge-to-edge: viewport (100..700) is not resized, keyboard top is 500,
    // so the 200px overlap is added as temporary room below the last field.
    expect(view.root.findAllByProps({ testID: 'keyboard-form-spacer' })[0].props.style).toEqual({ height: 296 });
    scrollTo.mockClear();
    fieldTop = 200;
    await act(async () => {
      view.root.findByType(ScrollView).props.onContentSizeChange(300, 900);
      jest.runOnlyPendingTimers();
    });
    expect(onContentSizeChange).toHaveBeenCalledWith(300, 900);
    expect(scrollTo).not.toHaveBeenCalled();
    await act(async () => events.get('keyboardDidHide')!());
    expect(view.root.findAllByProps({ testID: 'keyboard-form-spacer' })).toHaveLength(0);
    await act(async () => view.unmount());
    expect(removals.every((remove) => remove.mock.calls.length === 1)).toBe(true);
  } finally { jest.restoreAllMocks(); jest.useRealTimers(); }
});

test('large choices use bounded searchable stable-ID selection; Android Back does not change value', async () => {
  const select = jest.fn();
  const rows = Array.from({ length: 20 }, (_, index) => [`person-${index}`, `Person ${index}`]);
  let view!: ReactTestRenderer;
  await act(async () => { view = create(createElement(Picker, { label: 'Person', rows, value: 'person-12', setValue: select })); });
  const open = () => view.root.findAll((node) => node.props.accessibilityLabel === 'Choose Person' && !!node.props.onPress)[0];
  await act(async () => open().props.onPress());
  await act(async () => view.root.findAllByType(TextField).find((node) => node.props.accessibilityLabel === 'Search Person')!.props.onChangeText('Person 12'));
  const list = view.root.findByType(FlatList);
  expect(list.props.data).toEqual([['person-12', 'Person 12']]);
  const row = list.props.renderItem({ item: list.props.data[0] });
  expect(row.props.accessibilityState.selected).toBe(true);
  await act(async () => view.root.findByType(Modal).props.onRequestClose());
  expect(select).not.toHaveBeenCalled();
  await act(async () => open().props.onPress());
  await act(async () => row.props.onPress());
  expect(select).toHaveBeenCalledWith('person-12');
  expect(view.root.findAllByType(Modal)).toHaveLength(0);
  await act(async () => view.unmount());
});

test('small choices keep the compact Sage dialog and return IDs', async () => {
  const select = jest.fn();
  let view!: ReactTestRenderer;
  await act(async () => { view = create(createElement(Picker, { label: 'Account', rows: [['cash-id', 'Cash']], value: 'cash-id', setValue: select })); });
  await act(async () => view.root.findAll((node) => node.props.accessibilityLabel === 'Choose Account' && !!node.props.onPress)[0].props.onPress());
  mockDialog.showDialog.mock.calls.at(-1)![0].actions[0].onPress();
  expect(select).toHaveBeenCalledWith('cash-id');
  await act(async () => view.unmount());
});

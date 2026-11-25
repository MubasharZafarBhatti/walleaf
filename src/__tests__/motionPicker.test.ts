import { act, createElement, useState } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { Animated, Modal, TextInput } from 'react-native';
import { FormFocusContext } from '../components/KeyboardSafeScrollView';
import { MemberPicker } from '../components/MemberPicker';
import { PersonSummary, personHistoryLayout, personSnapOffset } from '../components/PersonSummary';
import { PrimaryButton, SecondaryButton, TextField } from '../components/common';

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
jest.mock('../hooks/useAppData', () => ({ useAppData: () => ({ settings: { currency: 'PKR' } }) }));

test('nearest-end snapping clamps top, chooses collapsed at midpoint and leaves long-history scroll alone', () => {
  expect(personSnapOffset(-20, 100)).toBe(0);
  expect(personSnapOffset(49.99, 100)).toBe(0);
  expect(personSnapOffset(50, 100)).toBe(100);
  expect(personSnapOffset(50.01, 100)).toBe(100);
  expect(personSnapOffset(1200, 100)).toBeNull();
  expect(personHistoryLayout(600, 220, 100).minContentHeight - 600).toBeGreaterThanOrEqual(146);
});

test('expanded summary stays mounted with fixed natural layout and measures only actual size changes while progress moves', async () => {
  const measured = jest.fn();
  const scroll = new Animated.Value(0);
  let view!: ReactTestRenderer;
  await act(async () => { view = create(createElement(PersonSummary, { name: 'Ali', balance: 100, amount: 'Rs. 1', given: 'Rs. 2', received: 'Rs. 1', archived: false, disabled: false, onArchive: jest.fn(), onEdit: jest.fn(), onExpand: jest.fn(), onExpandedHeight: measured, scroll, collapsible: true })); });
  const layer = () => view.root.findAll((node) => typeof node.props.onLayout === 'function')[0];
  await act(async () => { layer().props.onLayout({ nativeEvent: { layout: { height: 220 } } }); layer().props.onLayout({ nativeEvent: { layout: { height: 220 } } }); });
  expect(measured).toHaveBeenCalledTimes(1);
  const mounted = layer();
  for (let offset = 0; offset < 150; offset += 5) await act(async () => scroll.setValue(offset));
  expect(layer() === mounted).toBe(true);
  expect(measured).toHaveBeenCalledTimes(1);
  expect(layer().props.style.height).toBeUndefined();
  await act(async () => view.unmount());
});

function Members() {
  const [selected, setSelected] = useState(['SELF']);
  return createElement(MemberPicker, { rows: [{ id: 'SELF', name: 'You (me)' }, { id: 'person-ali', name: 'Ali' }, { id: 'real-you', name: 'You' }], selected, onChange: setSelected, disabled: false });
}
test('searchable member picker stages stable IDs, supports optional You, and discards Android Back drafts', async () => {
  let view!: ReactTestRenderer;
  const parentFocus = jest.fn();
  await act(async () => { view = create(createElement(FormFocusContext.Provider, { value: parentFocus }, createElement(Members))); });
  const button = (title: string) => view.root.findAllByType(SecondaryButton).find((node) => node.props.title === title)!;
  const checkbox = (label: string) => view.root.findAll((node) => node.props.accessibilityRole === 'checkbox' && node.props.accessibilityLabel === label && !!node.props.onPress)[0];
  await act(async () => button('Add Member').props.onPress());
  await act(async () => view.root.findAllByType(TextInput).find((node) => node.props.accessibilityLabel === 'Search members')!.props.onFocus({ nativeEvent: {} }));
  expect(parentFocus).not.toHaveBeenCalled();
  expect(checkbox('You (me)')).toBeUndefined();
  await act(async () => checkbox('Ali').props.onPress());
  expect(view.root.findByType(MemberPicker).props.selected).toEqual(['SELF']);
  await act(async () => view.root.findByType(Modal).props.onRequestClose());
  expect(view.root.findByType(MemberPicker).props.selected).toEqual(['SELF']);
  await act(async () => view.root.findAll((node) => node.props.accessibilityLabel === 'Remove member You (me)' && !!node.props.onPress)[0].props.onPress());
  await act(async () => button('Add Member').props.onPress());
  expect(checkbox('You (me)').props.accessibilityState.checked).toBe(false);
  await act(async () => checkbox('You (me)').props.onPress());
  await act(async () => checkbox('You (me)').props.onPress());
  await act(async () => view.root.findByType(TextField).props.onChangeText('Ali'));
  expect(checkbox('You (me)')).toBeUndefined();
  await act(async () => checkbox('Ali').props.onPress());
  await act(async () => view.root.findByType(PrimaryButton).props.onPress());
  expect(view.root.findByType(MemberPicker).props.selected).toEqual(['person-ali']);
  await act(async () => view.unmount());
});

import { act, createElement, useEffect, type ReactNode } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { Modal, ScrollView, StyleSheet, Text } from 'react-native';
import { AppDialogProvider, useAppDialog } from '../components/dialogs/AppDialogProvider';
import { colors, spacing } from '../theme';

const mockViewport = { width: 320, height: 480, scale: 1, fontScale: 1 };
const mockInsets = { top: 24, bottom: 16, left: 0, right: 0 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({ __esModule: true, default: () => mockViewport }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => mockInsets }));
jest.mock('react-native/Libraries/Modal/Modal', () => {
  const React = jest.requireActual('react');
  return { __esModule: true, default: (props: { visible: boolean; children: ReactNode }) => React.createElement('Modal', props, props.visible ? props.children : null) };
});
let view: ReactTestRenderer; let dialog: ReturnType<typeof useAppDialog>;
function Probe() { const current = useAppDialog(); useEffect(() => { dialog = current; }, [current]); return null; }
beforeEach(async () => { mockViewport.width = 320; mockViewport.height = 480; mockViewport.fontScale = 1; await act(async () => { view = create(createElement(AppDialogProvider, null, createElement(Probe))); }); });
afterEach(async () => { await act(async () => view.unmount()); });
const node = (id: string) => view.root.findAll(n => n.props.testID === id)[0];
const button = (label: string) => view.root.findAll(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];

test.each([[320, 1], [320, 2], [390, 2], [600, 1]])('reminder actions stack full-width at %i px/font scale %s with untruncated labels and correct Sage variants', async (width, fontScale) => {
  mockViewport.width = width; mockViewport.fontScale = fontScale;
  await act(async () => dialog.showDialog({ title: 'Reminders are turned off', message: 'You selected a reminder for Internet Bill. Your payment can still be saved.', actionLayout: 'stacked', actions: [{ text: 'Enable Notifications', variant: 'primary' }, { text: 'Save Without Notifications', variant: 'secondary' }] }));
  const layout = StyleSheet.flatten(node('sage-dialog-actions').props.style); expect(layout.flexDirection).toBe('column'); expect(layout.gap).toBe(spacing.sm);
  for (const label of ['Enable Notifications', 'Save Without Notifications']) {
    const action = button(label); const style = StyleSheet.flatten(action.props.style); expect(style.width).toBe('100%'); expect(style.minWidth).toBe(0); expect(style.minHeight).toBeGreaterThanOrEqual(44); expect(style.height).toBeUndefined();
    const text = action.findAllByType(Text).find(n => n.props.children === label)!; expect(text).toBeDefined(); expect(text.props.numberOfLines).toBeUndefined(); expect(text.props.allowFontScaling).not.toBe(false); expect(StyleSheet.flatten(text.props.style).textAlign).toBe('center');
  }
  expect(StyleSheet.flatten(button('Enable Notifications').props.style).backgroundColor).toBe(colors.primary); expect(StyleSheet.flatten(button('Save Without Notifications').props.style).backgroundColor).toBeUndefined();
});
test('title/message and all actions share one viewport-bounded ScrollView, including short-height/large-font content', async () => {
  mockViewport.height = 240; mockViewport.fontScale = 2.5;
  await act(async () => dialog.showDialog({ title: 'Long reminder explanation', message: 'Long explanation. '.repeat(80), actions: [{ text: 'Open Device Settings', variant: 'primary' }, { text: 'Continue Without Notifications' }] }));
  const card = StyleSheet.flatten(node('sage-dialog-card').props.style); expect(card.maxHeight).toBe(240 - mockInsets.top - mockInsets.bottom - 2 * spacing.xl); expect(card.overflow).toBe('hidden');
  const content = node('sage-dialog-content'); expect(view.root.findAllByType(ScrollView)).toHaveLength(1); expect(content.props.showsVerticalScrollIndicator).toBe(true); expect(content.props.keyboardShouldPersistTaps).toBe('handled'); expect(StyleSheet.flatten(content.props.style).flexShrink).toBe(1);
  expect(content.props.horizontal).toBe(false);
  expect(content.findAllByType(Text).some(n => n.props.children === 'Long reminder explanation')).toBe(true); expect(content.findAllByType(Text).some(n => typeof n.props.children === 'string' && n.props.children.startsWith('Long explanation.'))).toBe(true);
  expect(content.findAll(n => n.props.accessibilityLabel === 'Continue Without Notifications').length).toBeGreaterThan(0);
});
test('other two-action long-label dialogs automatically stack without requiring caller changes', async () => {
  mockViewport.width = 600;
  await act(async () => dialog.showDialog({ title: 'Permission blocked', actions: [{ text: 'Open Device Settings' }, { text: 'Continue Without Notifications' }] }));
  expect(StyleSheet.flatten(node('sage-dialog-actions').props.style).flexDirection).toBe('column');
});
test('short pairs remain compact on wide normal-font screens, with flexible bounded widths', async () => {
  mockViewport.width = 600;
  await act(async () => dialog.showDialog({ title: 'Confirm', actions: [{ text: 'Cancel' }, { text: 'Save', variant: 'primary' }] }));
  expect(StyleSheet.flatten(node('sage-dialog-actions').props.style).flexDirection).toBe('row'); expect(StyleSheet.flatten(button('Save').props.style)).toMatchObject({ flex: 1, minWidth: 0 });
});
test.each([[320, 1], [600, 2]])('short-label dialogs also stack safely for narrow/accessibility layouts (%i/%s)', async (width, fontScale) => {
  mockViewport.width = width; mockViewport.fontScale = fontScale;
  await act(async () => dialog.showDialog({ title: 'Confirm', actions: [{ text: 'Cancel' }, { text: 'Save' }] })); expect(StyleSheet.flatten(node('sage-dialog-actions').props.style).flexDirection).toBe('column');
});
test('stacked primary retains synchronous duplicate-action protection across awaited permission work', async () => {
  let resolve!: () => void; const enable = jest.fn(() => new Promise<void>(done => { resolve = done; })); const save = jest.fn();
  await act(async () => dialog.showDialog({ title: 'Reminders are turned off', actionLayout: 'stacked', actions: [{ text: 'Enable Notifications', variant: 'primary', onPress: enable }, { text: 'Save Without Notifications', onPress: save }] }));
  const press = button('Enable Notifications').props.onPress; let first!: Promise<void>;
  await act(async () => { first = press(); await press(); }); expect(enable).toHaveBeenCalledTimes(1); expect(save).not.toHaveBeenCalled(); await act(async () => { resolve(); await first; });
});
test('Android Back still cancels the scrollable warning without invoking its actions', async () => {
  const cancel = jest.fn(); const save = jest.fn();
  await act(async () => dialog.showDialog({ title: 'Reminders are turned off', onCancel: cancel, actionLayout: 'stacked', actions: [{ text: 'Save Without Notifications', onPress: save }] }));
  await act(async () => view.root.findByType(Modal).props.onRequestClose()); expect(cancel).toHaveBeenCalledTimes(1); expect(save).not.toHaveBeenCalled();
});
test('each reopened/replaced dialog remounts content so a prior scroll position cannot hide the new title', async () => {
  await act(async () => dialog.showDialog({ title: 'Same title', message: 'Long content '.repeat(80) })); const previous = node('sage-dialog-content');
  await act(async () => dialog.showDialog({ title: 'Same title', message: 'Long content '.repeat(80) })); expect(node('sage-dialog-content')).not.toBe(previous);
});

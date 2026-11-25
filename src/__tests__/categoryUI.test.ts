/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import * as SQLite from 'expo-sqlite';
import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { openAppDatabase, type AppDb } from '../database/database';
import * as repo from '../database/repositories/repositories';
import { CategoriesScreen } from '../navigation/AppNavigator';
import { ListRow, PrimaryButton, SecondaryButton, TextField } from '../components/common';
import type { Category } from '../types/models';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('@react-navigation/native', () => ({ DefaultTheme: { colors: {} }, NavigationContainer: 'NavigationContainer', useNavigation: () => ({ goBack: jest.fn() }), useIsFocused: () => true }));
jest.mock('@react-navigation/material-top-tabs', () => ({ createMaterialTopTabNavigator: () => ({ Navigator: 'Tabs', Screen: 'Tab' }) }));
jest.mock('@react-navigation/stack', () => ({ createStackNavigator: () => ({ Navigator: 'Stack', Screen: 'StackScreen' }) }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
const mockDialog = { confirm: jest.fn(), showDialog: jest.fn(), showSuccess: jest.fn() };
jest.mock('../components/dialogs/AppDialogProvider', () => ({ useAppDialog: () => mockDialog }));
const mockData = { db: null as AppDb | null, repo, categories: [] as Category[], refresh: jest.fn() };
jest.mock('../hooks/useAppData', () => ({ useAppData: () => mockData }));
jest.mock('../hooks/useSubmitGuard', () => ({ useSubmitGuard: (refresh: () => Promise<void>) => ({ saving: false, isSaving: () => false, submit: (work: () => Promise<void>) => work(), saved: async (_message: string, done: () => void) => { await refresh(); done(); } }) }));
jest.mock('../hooks/useDirtyForm', () => ({ useDirtyForm: () => ({ discard: (action: () => void) => action(), leave: (action: () => void) => action() }) }));

let sqlite: DatabaseSync;
let db: AppDb;
let renderer: ReactTestRenderer | undefined;
beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  const adapter = { execAsync: async (sql: string) => { sqlite.exec(sql); }, runAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).run(...params), getAllAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).all(...params), getFirstAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).get(...params) ?? null, withTransactionAsync: async (work: () => Promise<void>) => { sqlite.exec('BEGIN'); try { await work(); sqlite.exec('COMMIT'); } catch (error) { sqlite.exec('ROLLBACK'); throw error; } }, withExclusiveTransactionAsync: async (work: (txn: AppDb) => Promise<void>) => adapter.withTransactionAsync(() => work(db)) };
  db = adapter as unknown as AppDb; jest.mocked(SQLite.openDatabaseAsync).mockResolvedValue(db); await openAppDatabase();
  await repo.createCategory(db, { name: 'Gaming', type: 'EXPENSE' });
  mockData.db = db; mockData.categories = await repo.listCategories(db); mockData.refresh.mockImplementation(async () => { mockData.categories = await repo.listCategories(db); }); mockDialog.confirm.mockResolvedValue(true);
});
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); sqlite.close(); });

test('inline category Delete confirms in Sage, keeps the ID internally and has no archived management list', async () => {
  await act(async () => { renderer = create(createElement(CategoriesScreen)); });
  const gaming = renderer!.root.findAllByType(ListRow).find((row) => row.props.title === 'Gaming')!;
  await act(async () => gaming.props.onPress());
  expect(renderer!.root.findAllByType(TextField).some((field) => field.props.label === 'Name' && field.props.value === 'Gaming')).toBe(true);
  const categoryId = mockData.categories.find((category) => category.name === 'Gaming')!.id;
  const remove = () => renderer!.root.findAllByType(SecondaryButton).find((button) => button.props.title === 'Delete Category')!;
  mockDialog.confirm.mockResolvedValueOnce(false);
  await act(async () => remove().props.onPress());
  expect(mockData.categories.find((category) => category.id === categoryId)?.is_archived).toBe(0);
  await act(async () => remove().props.onPress());
  expect(mockDialog.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Delete category?', confirmText: 'Delete Category' }));
  expect(mockData.categories.find((category) => category.name === 'Gaming')?.is_archived).toBe(1);
  expect(renderer!.root.findAllByType(PrimaryButton).some((button) => button.props.title === 'Restore Category')).toBe(false);
  expect(renderer!.root.findAllByType(ListRow).some((row) => row.props.title === 'Gaming')).toBe(false);
  expect(mockData.categories.find((category) => category.id === categoryId)?.deleted_at).toBeNull();
  expect(JSON.stringify(renderer!.toJSON())).not.toContain('Archived Categories');
});

test('tap toggles the editor beneath its category; prefilled Rename is enabled only for a normalized change', async () => {
  await act(async () => { renderer = create(createElement(CategoriesScreen)); });
  const row = () => renderer!.root.findAllByType(ListRow).find((node) => node.props.title === 'Gaming')!;
  await act(async () => row().props.onPress());
  const wrapper = () => renderer!.root.findAllByProps({ accessibilityLabel: 'Category Gaming' })[0];
  expect(wrapper().findAllByType(TextField)[0].props.value).toBe('Gaming');
  const rename = () => renderer!.root.findAllByType(PrimaryButton).find((node) => node.props.title === 'Rename')!;
  expect(rename().props.disabled).toBe(true);
  await act(async () => wrapper().findAllByType(TextField)[0].props.onChangeText(' gaming '));
  expect(rename().props.disabled).toBe(true);
  await act(async () => wrapper().findAllByType(TextField)[0].props.onChangeText('Games'));
  expect(rename().props.disabled).toBe(false);
  const id = mockData.categories.find((category) => category.name === 'Gaming')!.id;
  await act(async () => rename().props.onPress());
  expect(mockData.categories.find((category) => category.id === id)?.name).toBe('Games');
  const renamed = () => renderer!.root.findAllByType(ListRow).find((node) => node.props.title === 'Games')!;
  await act(async () => renamed().props.onPress());
  await act(async () => renamed().props.onPress());
  expect(renderer!.root.findAllByType(PrimaryButton).some((node) => node.props.title === 'Rename')).toBe(false);
  await act(async () => renderer!.root.findAllByType(ListRow).find((node) => node.props.title === 'Other')!.props.onPress());
  expect(renderer!.root.findAllByType(SecondaryButton).some((node) => node.props.title === 'Delete Category')).toBe(false);
});

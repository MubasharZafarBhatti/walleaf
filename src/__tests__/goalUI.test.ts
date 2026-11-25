import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { GoalDetailScreen, GoalsScreen } from '../navigation/AppNavigator';
import { PrimaryButton, SecondaryButton, TextField } from '../components/common';
import { Picker } from '../components/forms';

const mockNavigation = { addListener: jest.fn(() => () => {}), isFocused: () => true, canGoBack: () => true, goBack: jest.fn(), navigate: jest.fn(), dispatch: jest.fn() };
const mockDialog = { confirm: jest.fn(), showDialog: jest.fn(), showSuccess: jest.fn() };
const account = { id: 'cash', name: 'Cash', type: 'CASH', currency: 'PKR', opening_balance_minor: 1000, is_archived: 0, created_at: '2026-09-01', updated_at: '2026-09-01', deleted_at: null, sync_status: 'LOCAL' } as const;
const goal = { id: 'goal', name: 'Laptop', target_amount_minor: 10000, initial_saved_minor: 2000, saved_minor: 2000, target_date: null, linked_account_id: 'cash', linked_account_name: 'Cash', note: null, is_archived: 0, created_at: '2026-09-01', updated_at: '2026-09-01', deleted_at: null, sync_status: 'LOCAL' };
const repo = {
  listAccounts: jest.fn(), listTransactions: jest.fn(), listPersonEntries: jest.fn(),
  saveGoal: jest.fn(), updateGoal: jest.fn(), restoreGoal: jest.fn(),
};
const mockData = {
  db: {}, repo, goals: [goal], allGoals: [goal], goalEntries: [], accounts: [account],
  settings: { currency: 'PKR', week_start: 'MONDAY' }, refresh: jest.fn(),
};

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('@react-navigation/native', () => ({ DefaultTheme: { colors: {} }, useNavigation: () => mockNavigation }));
jest.mock('@react-navigation/stack', () => ({ createStackNavigator: () => ({}) }));
jest.mock('@react-navigation/material-top-tabs', () => ({ createMaterialTopTabNavigator: () => ({}) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../hooks/useAppData', () => ({ useAppData: () => mockData }));
jest.mock('../components/dialogs/AppDialogProvider', () => ({ useAppDialog: () => mockDialog }));
jest.mock('../hooks/useConfirmOutflow', () => ({ useConfirmOutflow: () => jest.fn(), useConfirmActivityChange: () => jest.fn() }));

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  jest.clearAllMocks();
  mockNavigation.addListener.mockReturnValue(() => {});
  mockDialog.confirm.mockResolvedValue(false);
  mockData.refresh.mockResolvedValue(undefined);
  mockData.goals = [goal]; mockData.allGoals = [goal];
  repo.restoreGoal.mockResolvedValue(undefined);
  repo.listAccounts.mockResolvedValue([account]);
  repo.listTransactions.mockResolvedValue([]);
  repo.listPersonEntries.mockResolvedValue([]);
  repo.saveGoal.mockResolvedValue('new-goal');
  repo.updateGoal.mockResolvedValue(undefined);
});
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; });

const field = (label: string) => renderer!.root.findAllByType(TextField).find((node) => node.props.label === label)!;
const picker = (label: string) => renderer!.root.findAllByType(Picker).find((node) => node.props.label === label)!;
const primary = (title: string) => renderer!.root.findAllByType(PrimaryButton).find((node) => node.props.title === title)!;
const secondary = (title: string) => renderer!.root.findAllByType(SecondaryButton).find((node) => node.props.title === title)!;

test('creating an over-balance Goal can go back without writing or losing input', async () => {
  await act(async () => { renderer = create(createElement(GoalsScreen, { navigation: mockNavigation })); });
  await act(async () => renderer!.root.findByProps({ accessibilityLabel: 'Add goal' }).props.onPress());
  await act(async () => field('Name').props.onChangeText('Emergency'));
  await act(async () => field('Target Amount').props.onChangeText('100'));
  await act(async () => field('Current Saved Amount').props.onChangeText('20'));
  await act(async () => picker('Linked Account').props.setValue('cash'));
  await act(async () => primary('Save Goal').props.onPress());
  expect(mockDialog.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Savings exceed account balance', cancelText: 'Go Back', confirmText: 'Save Anyway' }));
  expect(repo.saveGoal).not.toHaveBeenCalled();
  expect(field('Current Saved Amount').props.value).toBe('20');
  mockDialog.confirm.mockResolvedValueOnce(true);
  await act(async () => primary('Save Goal').props.onPress());
  expect(repo.saveGoal).toHaveBeenCalledTimes(1);
});

test('editing an over-balance Goal re-reads authoritative data and preserves the form on Go Back', async () => {
  await act(async () => { renderer = create(createElement(GoalDetailScreen, { navigation: mockNavigation, route: { params: { goalId: 'goal' } } })); });
  await act(async () => secondary('Edit Goal').props.onPress());
  await act(async () => field('Name').props.onChangeText('Laptop Pro'));
  await act(async () => primary('Save Changes').props.onPress());
  expect(repo.listAccounts).toHaveBeenCalledWith(mockData.db);
  expect(repo.listTransactions).toHaveBeenCalledWith(mockData.db);
  expect(repo.listPersonEntries).toHaveBeenCalledWith(mockData.db);
  expect(repo.updateGoal).not.toHaveBeenCalled();
  expect(field('Name').props.value).toBe('Laptop Pro');
  mockDialog.confirm.mockResolvedValueOnce(true);
  await act(async () => primary('Save Changes').props.onPress());
  expect(repo.updateGoal).toHaveBeenCalledTimes(1);
});

test('archived Goals control is absent at zero, available when needed and disappears after last restore', async () => {
  await act(async () => { renderer = create(createElement(GoalsScreen, { navigation: mockNavigation })); });
  expect(renderer!.root.findAllByType(SecondaryButton).some((node) => node.props.title.includes('Archived Goals'))).toBe(false);
  mockData.allGoals = [{ ...goal, is_archived: 1 }]; mockData.goals = [];
  await act(async () => renderer!.update(createElement(GoalsScreen, { navigation: mockNavigation })));
  await act(async () => secondary('Show Archived Goals').props.onPress());
  expect(secondary('Hide Archived Goals')).toBeTruthy();
  mockData.allGoals = [goal]; mockData.goals = [goal];
  await act(async () => renderer!.update(createElement(GoalsScreen, { navigation: mockNavigation })));
  expect(renderer!.root.findAllByType(SecondaryButton).some((node) => node.props.title.includes('Archived Goals'))).toBe(false);
});

test('archived Goal offers guarded Restore and active controls return after refresh', async () => {
  mockData.allGoals = [{ ...goal, is_archived: 1 }];
  await act(async () => { renderer = create(createElement(GoalDetailScreen, { navigation: mockNavigation, route: { params: { goalId: 'goal' } } })); });
  expect(renderer!.root.findAllByType(SecondaryButton).some((node) => node.props.title === 'Add Money')).toBe(false);
  await act(async () => primary('Restore Goal').props.onPress());
  expect(repo.restoreGoal).toHaveBeenCalledWith(mockData.db, goal.id, goal.updated_at);
  expect(mockData.refresh).toHaveBeenCalledTimes(1);
  mockData.allGoals = [goal];
  await act(async () => renderer!.update(createElement(GoalDetailScreen, { navigation: mockNavigation, route: { params: { goalId: 'goal' } } })));
  expect(secondary('Add Money')).toBeTruthy();
  expect(secondary('Edit Goal')).toBeTruthy();
  expect(repo.saveGoal).not.toHaveBeenCalled(); expect(repo.updateGoal).not.toHaveBeenCalled();
});

test('a new Goal has no target date until one is chosen', async () => {
  await act(async () => { renderer = create(createElement(GoalsScreen, { navigation: mockNavigation })); });
  await act(async () => renderer!.root.findByProps({ accessibilityLabel: 'Add goal' }).props.onPress());
  expect(field('Target Date').props.value).toBe('');
  await act(async () => field('Name').props.onChangeText('Bike'));
  await act(async () => field('Target Amount').props.onChangeText('2000'));
  await act(async () => primary('Save Goal').props.onPress());
  expect(repo.saveGoal).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: 'Bike', target_date: null }));
});

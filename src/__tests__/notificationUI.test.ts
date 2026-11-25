import { act, createElement } from 'react';
import { Linking } from 'react-native';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { SettingsScreen } from '../navigation/AppNavigator';
import { ListRow } from '../components/common';
import type { ReminderStatus } from '../services/notifications/ReminderStatus';
import { publishReminderStatus } from '../services/notifications/ReminderStatus';
import { captureNotificationDiagnostic, clearNotificationDiagnostic } from '../services/notifications/NotificationDiagnostics';
let mockStatus: ReminderStatus = { permission: 'granted', canAskAgain: false, scheduling: 'available' };

const mockDialog = { confirm: jest.fn(), showDialog: jest.fn(), showSuccess: jest.fn() };
const mockEnable = jest.fn();
const mockDisable = jest.fn();
const mockData = {
  db: {},
  settings: {
    user_name: 'User', currency: 'PKR', week_start: 'MONDAY', budget_alert_threshold: '80',
    theme: 'SAGE', notifications_enabled: 'false', ai_enabled: 'false', setup_complete: 'true',
    budget_auto_copy_enabled: 'false',
  },
  setSetting: jest.fn(), refresh: jest.fn(), budgets: [], transactions: [],
  repo: { saveBudget: jest.fn(), setSetting: jest.fn() },
};

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('@react-navigation/native', () => ({ DefaultTheme: { colors: {} }, NavigationContainer: 'NavigationContainer', useNavigation: () => ({ goBack: jest.fn() }), useIsFocused: () => true }));
jest.mock('@react-navigation/material-top-tabs', () => ({ createMaterialTopTabNavigator: () => ({ Navigator: 'Tabs', Screen: 'Tab' }) }));
jest.mock('@react-navigation/stack', () => ({ createStackNavigator: () => ({ Navigator: 'Stack', Screen: 'StackScreen' }) }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../components/dialogs/AppDialogProvider', () => ({ useAppDialog: () => mockDialog }));
jest.mock('../hooks/useAppData', () => ({ useAppData: () => mockData }));
jest.mock('../hooks/useSubmitGuard', () => ({ useSubmitGuard: (refresh: () => Promise<void>) => ({ saving: false, isSaving: () => false, submit: (work: () => Promise<void>) => work(), saved: async () => refresh() }) }));
jest.mock('../hooks/useDirtyForm', () => ({ useDirtyForm: () => ({ discard: (action: () => void) => action(), leave: (action: () => void) => action() }) }));
jest.mock('../services/notifications/NotificationService', () => ({
  enableLocalReminders: async (...args: unknown[]) => {
    const result = await mockEnable(...args);
    jest.requireActual('../services/notifications/ReminderStatus').publishReminderStatus({ ...mockStatus, permission: result.permission });
    return result;
  },
  disableLocalReminders: (...args: unknown[]) => mockDisable(...args),
  inspectReminderPermission: async () => { jest.requireActual('../services/notifications/ReminderStatus').publishReminderStatus(mockStatus); return mockStatus; },
  queueAppReminderReconciliation: jest.fn(),
  scheduleReminderDiagnostic: jest.fn(),
}));

let renderer: ReactTestRenderer;
const navigation = { navigate: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  clearNotificationDiagnostic();
  mockData.settings.notifications_enabled = 'false';
  mockStatus = { permission: 'granted', canAskAgain: false, scheduling: 'available' };
  mockData.refresh.mockResolvedValue(undefined);
  mockEnable.mockResolvedValue({ permission: 'granted', reconciliation: { failed: [] } });
  mockDisable.mockResolvedValue({ failed: [] });
});

afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); });

async function render() {
  await act(async () => { renderer = create(createElement(SettingsScreen, { navigation })); });
  return renderer.root.findAllByType(ListRow).find((row) => row.props.title === 'Notifications')!;
}

test('Settings exposes a user-driven local reminder toggle and granted flow', async () => {
  const row = await render();
  expect(row.props.subtitle).toContain('Off');
  await act(async () => row.props.onPress());
  expect(mockEnable).toHaveBeenCalledWith(mockData.db);
  expect(mockData.refresh).toHaveBeenCalled();
});

test('Settings displays persisted On state and turns reminders off', async () => {
  mockData.settings.notifications_enabled = 'true';
  const row = await render();
  expect(row.props.subtitle).toContain('local reminders only');
  await act(async () => row.props.onPress());
  expect(mockDisable).toHaveBeenCalledWith(mockData.db);
});

test('denied permission uses a friendly Sage dialog with system settings action', async () => {
  mockEnable.mockResolvedValue({ permission: 'denied' });
  const row = await render();
  await act(async () => row.props.onPress());
  expect(mockDialog.showDialog).toHaveBeenCalledWith(expect.objectContaining({
    title: 'Notifications are blocked',
    message: expect.stringContaining('Financial features still work normally'),
    actions: expect.arrayContaining([expect.objectContaining({ text: 'Open Settings' })]),
  }));
  const options = mockDialog.showDialog.mock.calls[0][0];
  const open = options.actions.find((action: { text: string }) => action.text === 'Open Settings');
  const spy = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
  await open.onPress();
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
});

test('unavailable native support keeps Settings and financial features usable', async () => {
  mockEnable.mockResolvedValue({ permission: 'unavailable' });
  const row = await render();
  await act(async () => row.props.onPress());
  expect(mockDialog.showDialog).toHaveBeenCalledWith(expect.objectContaining({
    title: 'Reminder setup could not finish',
    message: expect.stringContaining('Financial features still work normally'),
  }));
});

test('Settings keeps local Backup actions and no longer shows a "Coming later" Cloud Backup or build label', async () => {
  await render();
  expect(JSON.stringify(renderer.toJSON())).not.toContain('Cloud Backup');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('Build:');
  expect(JSON.stringify(renderer.toJSON())).toContain('Export Backup');
  expect(JSON.stringify(renderer.toJSON())).toContain('Import / Restore Backup');
});
test('live externally revoked/restored permission updates Settings without overwriting the saved On preference', async () => {
  mockData.settings.notifications_enabled = 'true'; await render();
  await act(async () => publishReminderStatus({ permission: 'denied', canAskAgain: false, scheduling: 'unknown' }));
  expect(renderer.root.findAllByType(ListRow).find(row => row.props.title === 'Notifications')?.props.subtitle).toContain('delivery blocked');
  expect(JSON.stringify(renderer.toJSON())).toContain('Open device notification Settings');
  await act(async () => publishReminderStatus({ permission: 'granted', canAskAgain: false, scheduling: 'available' }));
  expect(renderer.root.findAllByType(ListRow).find(row => row.props.title === 'Notifications')?.props.subtitle).not.toContain('delivery blocked'); expect(mockData.settings.notifications_enabled).toBe('true');
});
test('Settings no longer shows the developer error viewer or test-reminder controls', async () => {
  captureNotificationDiagnostic('TypeError: invalid channel argument', { stage: 'channel', applicationErrorCode: 'NATIVE_API_ERROR', operation: 'setNotificationChannelAsync' });
  await render(); const output = JSON.stringify(renderer.toJSON());
  expect(output).not.toContain('Last Notification Error'); expect(output).not.toContain('Copy Notification Diagnostics'); expect(output).not.toContain('test reminder');
});

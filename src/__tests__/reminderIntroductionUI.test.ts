import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { ReminderIntroduction, ReminderPreferences } from '../components/ReminderControls';
import { SecondaryButton } from '../components/common';
import { ReminderNavigationReady } from '../navigation/ReminderNavigationContext';
import * as repo from '../database/repositories/repositories';
import { localNotificationApi } from '../services/notifications/LocalNotificationApi';
import { reminderDatabase } from './reminderFixtures';
import type { Settings } from '../types/models';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
const mockDialog = { showDialog: jest.fn(), showSuccess: jest.fn() };
let mockFocused = true;
const mockData: { db: Awaited<ReturnType<typeof reminderDatabase>>['db'] | null; ready: boolean; settings: Settings | null; refresh: () => Promise<void> } = { db: null, ready: false, settings: null, refresh: async () => {} };
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => mockFocused }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
jest.mock('../hooks/useAppData', () => ({ useAppData: () => mockData }));
jest.mock('../components/dialogs/AppDialogProvider', () => ({ useAppDialog: () => mockDialog }));
let harness: Awaited<ReturnType<typeof reminderDatabase>>; let view: ReactTestRenderer | undefined;
beforeEach(async () => {
  jest.clearAllMocks(); jest.useFakeTimers(); harness = await reminderDatabase(); mockData.db = harness.db; mockData.ready = true; mockFocused = true; await repo.setSetting(harness.db, 'setup_complete', 'true'); mockData.settings = await repo.getSettings(harness.db);
  mockData.refresh = async () => { mockData.settings = await repo.getSettings(harness.db); };
  jest.spyOn(localNotificationApi, 'getPermissionsAsync').mockResolvedValue({ granted: true, status: 'granted', canAskAgain: false } as never);
  jest.spyOn(localNotificationApi, 'requestPermissionsAsync'); jest.spyOn(localNotificationApi, 'getAllScheduledNotificationsAsync').mockResolvedValue([]); jest.spyOn(localNotificationApi, 'setNotificationChannelAsync').mockResolvedValue(null);
});
afterEach(async () => { if (view) await act(async () => view!.unmount()); view = undefined; harness.close(); jest.restoreAllMocks(); jest.useRealTimers(); });
async function render(navigationReady = true) { await act(async () => { view = create(createElement(ReminderNavigationReady.Provider, { value: navigationReady }, createElement(ReminderIntroduction))); }); await act(async () => { jest.advanceTimersByTime(20); }); }
test.each(['setup', 'database', 'navigation', 'other-tab'] as const)('introduction does not interrupt %s initialization or another tab', async stage => {
  if (stage === 'setup') mockData.settings!.setup_complete = 'false'; if (stage === 'database') mockData.ready = false; if (stage === 'other-tab') mockFocused = false;
  await render(stage !== 'navigation'); expect(mockDialog.showDialog).not.toHaveBeenCalled(); expect(localNotificationApi.requestPermissionsAsync).not.toHaveBeenCalled();
});
test.each(['Not Now', 'Enable Reminders'] as const)('%s introduction saves once after ready Home and never repeats after remount', async choice => {
  if (choice === 'Enable Reminders') {
    jest.mocked(localNotificationApi.getPermissionsAsync).mockResolvedValueOnce({ granted: false, status: 'undetermined', canAskAgain: true } as never);
    jest.mocked(localNotificationApi.requestPermissionsAsync).mockResolvedValue({ granted: true, status: 'granted', canAskAgain: false } as never);
  }
  await render(); expect(mockDialog.showDialog).toHaveBeenCalledTimes(1); const dialog = mockDialog.showDialog.mock.calls[0][0]; expect(dialog.title).toBe('Stay on top of upcoming payments');
  await act(async () => { await dialog.actions.find((action: { text: string }) => action.text === choice).onPress(); });
  expect(await repo.getSettings(harness.db)).toMatchObject({ notifications_intro_answered: 'true', notifications_enabled: choice === 'Enable Reminders' ? 'true' : 'false' });
  expect(localNotificationApi.requestPermissionsAsync).toHaveBeenCalledTimes(choice === 'Enable Reminders' ? 1 : 0);
  await act(async () => view!.unmount()); view = undefined; await render(); expect(mockDialog.showDialog).toHaveBeenCalledTimes(1);
});
test('existing On preference is preserved without another introductory prompt', async () => {
  await repo.setSetting(harness.db, 'notifications_enabled', 'true'); mockData.settings = await repo.getSettings(harness.db); await render(); expect(mockDialog.showDialog).not.toHaveBeenCalled(); expect((await repo.getSettings(harness.db)).notifications_enabled).toBe('true');
});
test('Android Back dismissing introduction is Not Now and does not request OS permission', async () => {
  await render(); await act(async () => mockDialog.showDialog.mock.calls[0][0].onCancel()); await mockData.refresh(); expect(mockData.settings?.notifications_intro_answered).toBe('true'); expect(localNotificationApi.requestPermissionsAsync).not.toHaveBeenCalled();
});
test('Settings shows no developer or test controls', async () => {
  const before = await harness.financial(); await act(async () => { view = create(createElement(ReminderPreferences)); });
  const titles = view!.root.findAllByType(SecondaryButton).map(n => n.props.title);
  expect(titles).not.toContain('Replay Notification Introduction'); expect(titles).not.toContain('Send 15-second test reminder');
  expect(JSON.stringify(view!.toJSON())).not.toContain('Notification Error'); expect(await harness.financial()).toEqual(before);
});

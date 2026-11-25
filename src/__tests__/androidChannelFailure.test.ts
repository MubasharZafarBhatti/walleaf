import { Platform } from 'react-native';
import { isRunningInExpoGo } from 'expo';
import { localNotificationApi } from '../services/notifications/LocalNotificationApi';
import { channelFailureDiagnostic, ChannelPreparationError } from '../services/notifications/ChannelDiagnostics';
import { enableLocalReminders, expoNotificationBoundary, inspectReminderPermission } from '../services/notifications/NotificationService';
import { getReminderStatusSnapshot, notificationFailure } from '../services/notifications/ReminderStatus';
import * as repo from '../database/repositories/repositories';
import { reminderDatabase } from './reminderFixtures';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('expo', () => ({ isRunningInExpoGo: jest.fn(() => true) }));
const mockManager: { setNotificationChannelAsync: jest.Mock | undefined } = { setNotificationChannelAsync: jest.fn() };
jest.mock('expo-notifications/build/NotificationChannelManager', () => ({ __esModule: true, default: mockManager }));
let harness: Awaited<ReturnType<typeof reminderDatabase>>;
const channel = () => ({ id: 'financial-reminders-alert', name: 'Financial reminders', importance: localNotificationApi.AndroidImportance.DEFAULT } as never);
const denied = { granted: false, status: 'undetermined', expires: 'never', canAskAgain: true } as const;
const granted = { granted: true, status: 'granted', expires: 'never', canAskAgain: false } as const;
beforeEach(async () => {
  jest.clearAllMocks(); jest.replaceProperty(Platform, 'OS', 'android'); jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(localNotificationApi, 'setNotificationChannelAsync').mockResolvedValue(channel());
  jest.spyOn(localNotificationApi, 'getNotificationChannelAsync').mockResolvedValue(channel());
  jest.spyOn(localNotificationApi, 'getPermissionsAsync').mockResolvedValue(denied as never);
  jest.spyOn(localNotificationApi, 'requestPermissionsAsync').mockResolvedValue(granted as never);
  jest.spyOn(localNotificationApi, 'getAllScheduledNotificationsAsync').mockResolvedValue([]);
  harness = await reminderDatabase();
});
afterEach(() => { harness.close(); jest.restoreAllMocks(); });

test('installed SDK Android wrapper passes minimal options/SDK enum to ExpoNotificationChannelManager and returns the native result', async () => {
  const api: typeof import('expo-notifications/build/setNotificationChannelAsync') = jest.requireActual('expo-notifications/build/setNotificationChannelAsync.android');
  mockManager.setNotificationChannelAsync!.mockResolvedValue(channel());
  const options = { name: 'Financial reminders', importance: localNotificationApi.AndroidImportance.DEFAULT };
  expect(options.importance).toBe(5); // SDK 57 enum, not Android's raw IMPORTANCE_DEFAULT=3.
  await expect(api.setNotificationChannelAsync('financial-reminders', options)).resolves.toEqual(channel());
  expect(mockManager.setNotificationChannelAsync).toHaveBeenCalledWith('financial-reminders', options);
});
test('installed SDK Android wrapper rejects an actually missing native channel method', async () => {
  const api: typeof import('expo-notifications/build/setNotificationChannelAsync') = jest.requireActual('expo-notifications/build/setNotificationChannelAsync.android');
  const method = mockManager.setNotificationChannelAsync; mockManager.setNotificationChannelAsync = undefined;
  try { await expect(api.setNotificationChannelAsync('financial-reminders', { name: 'Financial reminders', importance: localNotificationApi.AndroidImportance.DEFAULT })).rejects.toMatchObject({ code: 'ERR_UNAVAILABLE' }); }
  finally { mockManager.setNotificationChannelAsync = method; }
});
test('successful preparation verifies channel read-back before requesting native permission, with the default sound and vibration (user decision 2026-11-17)', async () => {
  expect(await expoNotificationBoundary.requestPermission()).toBe('granted');
  expect(localNotificationApi.setNotificationChannelAsync).toHaveBeenCalledWith('financial-reminders-alert', { name: 'Financial reminders', importance: localNotificationApi.AndroidImportance.DEFAULT, enableVibrate: true, vibrationPattern: [0, 250, 250, 250] });
  expect(localNotificationApi.getNotificationChannelAsync).toHaveBeenCalledWith('financial-reminders-alert');
  expect(jest.mocked(localNotificationApi.setNotificationChannelAsync).mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(localNotificationApi.getNotificationChannelAsync).mock.invocationCallOrder[0]);
  expect(jest.mocked(localNotificationApi.getNotificationChannelAsync).mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(localNotificationApi.requestPermissionsAsync).mock.invocationCallOrder[0]);
});
test.each([null, { id: 'wrong-channel', importance: 5 }, { id: 'financial-reminders-alert', importance: 1 }])('a missing/wrong/unusable channel %p cannot be declared ready or request permission', async value => {
  jest.mocked(localNotificationApi.getNotificationChannelAsync).mockResolvedValue(value as never);
  expect(await expoNotificationBoundary.requestPermission()).toBe('unavailable'); expect(localNotificationApi.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(getReminderStatusSnapshot().error?.code).toBe('CHANNEL_NOT_READY');
});
test('null setter result cannot falsely enable notifications when read-back is also null', async () => {
  jest.mocked(localNotificationApi.setNotificationChannelAsync).mockResolvedValue(null); jest.mocked(localNotificationApi.getNotificationChannelAsync).mockResolvedValue(null);
  const before = await harness.financial(); const result = await enableLocalReminders(harness.db);
  expect(result.permission).toBe('unavailable'); expect((await repo.getSettings(harness.db)).notifications_enabled).toBe('false'); expect(await harness.financial()).toEqual(before);
});
test('native API unavailable is distinguished from a native rejection and does not request OS permission', async () => {
  const error = Object.assign(new Error('Notifications.setNotificationChannelAsync is not available on this platform'), { code: 'ERR_UNAVAILABLE' });
  jest.mocked(localNotificationApi.setNotificationChannelAsync).mockRejectedValue(error);
  expect(await expoNotificationBoundary.requestPermission()).toBe('unavailable'); expect(getReminderStatusSnapshot().error).toMatchObject({ stage: 'native-module', code: 'ERR_UNAVAILABLE' }); expect(localNotificationApi.requestPermissionsAsync).not.toHaveBeenCalled();
});
test('ERR_UNEXPECTED retains Java exception/message/code/Expo Go host instead of losing it in a generic wrapper', async () => {
  const error = Object.assign(new Error("Call to function 'ExpoNotificationChannelManager.setNotificationChannelAsync' was rejected. Caused by: java.lang.NullPointerException: vibrationPattern must not be null"), { code: 'ERR_UNEXPECTED' });
  jest.mocked(localNotificationApi.setNotificationChannelAsync).mockRejectedValue(error);
  expect(await expoNotificationBoundary.requestPermission()).toBe('unavailable');
  expect(getReminderStatusSnapshot().error).toMatchObject({ code: 'ERR_UNEXPECTED', diagnostic: { stage: 'channel', operation: 'setNotificationChannelAsync', exceptionName: 'java.lang.NullPointerException', nativeCode: 'ERR_UNEXPECTED', expoGoHost: true, safeMessage: expect.stringContaining('vibrationPattern must not be null') } });
  expect(localNotificationApi.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(jest.mocked(console.warn).mock.calls.some(call => call[0] === '[Local reminders: channel diagnostic]' && String(call[1]).includes('NullPointerException'))).toBe(true);
});
test('read-back native rejection names the get operation, never declares success and can be retried', async () => {
  jest.mocked(localNotificationApi.getNotificationChannelAsync).mockRejectedValueOnce(Object.assign(new Error('java.lang.IllegalStateException: channel lookup failed'), { code: 'ERR_UNEXPECTED' }));
  expect(await expoNotificationBoundary.requestPermission()).toBe('unavailable'); expect(getReminderStatusSnapshot().error?.diagnostic?.operation).toBe('getNotificationChannelAsync'); expect(localNotificationApi.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(await expoNotificationBoundary.requestPermission()).toBe('granted'); expect(localNotificationApi.requestPermissionsAsync).toHaveBeenCalledTimes(1);
});
test('failed creation is retryable and a preference is enabled only after successful verification/permission', async () => {
  jest.mocked(localNotificationApi.setNotificationChannelAsync).mockRejectedValueOnce(Object.assign(new Error('java.lang.IllegalArgumentException: invalid channel property'), { code: 'ERR_UNEXPECTED' }));
  const before = await harness.financial(); expect((await enableLocalReminders(harness.db)).permission).toBe('unavailable'); expect((await repo.getSettings(harness.db)).notifications_enabled).toBe('false');
  jest.mocked(localNotificationApi.getPermissionsAsync).mockResolvedValueOnce(denied as never).mockResolvedValue(granted as never);
  expect((await enableLocalReminders(harness.db)).permission).toBe('granted'); expect((await repo.getSettings(harness.db)).notifications_enabled).toBe('true'); expect(await harness.financial()).toEqual(before);
});
test('simultaneous requests share channel preparation and request permission only once', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof localNotificationApi.setNotificationChannelAsync>>) => void;
  jest.mocked(localNotificationApi.setNotificationChannelAsync).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const one = expoNotificationBoundary.requestPermission(); const two = expoNotificationBoundary.requestPermission();
  expect(localNotificationApi.setNotificationChannelAsync).toHaveBeenCalledTimes(1); resolve(channel());
  expect(await Promise.all([one, two])).toEqual(['granted', 'granted']); expect(localNotificationApi.requestPermissionsAsync).toHaveBeenCalledTimes(1);
});
test('wrapper preserves original cause and development details through subsequent failure classification', () => {
  const cause = Object.assign(new TypeError('Invalid importance'), { code: 'ERR_CHANNEL_IMPORTANCE' }); const detail = channelFailureDiagnostic(cause, 'setNotificationChannelAsync');
  const wrapper = new ChannelPreparationError(cause, 'channel', cause.code, detail); expect(wrapper.cause).toBe(cause); expect(notificationFailure('channel', wrapper)).toMatchObject({ code: cause.code, diagnostic: { exceptionName: 'TypeError', nativeCode: cause.code } });
});
test('a native Android service rejection is not falsely classified as a missing Expo module', () => {
  expect(notificationFailure('channel', Object.assign(new Error('Android notification service is not available'), { code: 'ERR_UNEXPECTED' }))).toEqual({ stage: 'channel', code: 'ERR_UNEXPECTED' });
});
test('diagnostic redacts quotes, scope identities, URLs, credentials and financial/structured messages', () => {
  const details = channelFailureDiagnostic(new Error("java.lang.IllegalArgumentException: null value '@owner/project/channel' https://example.com/user token=secret"), 'setNotificationChannelAsync');
  expect(details?.safeMessage).toContain('null value'); expect(details?.safeMessage).not.toContain('owner'); expect(details?.safeMessage).not.toContain('example.com'); expect(details?.safeMessage).not.toContain('secret');
  expect(channelFailureDiagnostic(new Error('Account HBL user details and salary payload'), 'setNotificationChannelAsync')?.safeMessage).toBe('Native message withheld by diagnostic redaction.');
});
test('production retains cause/code but emits no detailed diagnostic or Expo Go host query', () => {
  jest.replaceProperty(globalThis as typeof globalThis & { __DEV__: boolean }, '__DEV__', false);
  const cause = Object.assign(new Error('native failure'), { code: 'ERR_UNEXPECTED' }); expect(channelFailureDiagnostic(cause, 'setNotificationChannelAsync')).toBeUndefined(); expect(isRunningInExpoGo).not.toHaveBeenCalled();
  const error = new ChannelPreparationError(cause, 'channel', cause.code); expect(notificationFailure('channel', error)).toEqual({ stage: 'channel', code: 'ERR_UNEXPECTED' }); expect(console.warn).not.toHaveBeenCalled();
});
test('successful existing permission does not request again after verified channel preparation', async () => {
  jest.mocked(localNotificationApi.getPermissionsAsync).mockResolvedValue(granted as never);
  expect(await expoNotificationBoundary.requestPermission()).toBe('granted'); expect(localNotificationApi.getNotificationChannelAsync).toHaveBeenCalled(); expect(localNotificationApi.requestPermissionsAsync).not.toHaveBeenCalled();
  expect((await inspectReminderPermission()).permission).toBe('granted');
});

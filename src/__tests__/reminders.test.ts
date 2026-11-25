import * as repo from '../database/repositories/repositories';
import { localNotificationApi } from '../services/notifications/LocalNotificationApi';
import { buildDesiredReminders, configureNotificationPresentation, disableLocalReminders, enableLocalReminders, expoNotificationBoundary, inspectReminderPermission, queueAppReminderReconciliation, reconcileAppReminders, reconcileReminders } from '../services/notifications/NotificationService';
import { getReminderStatusSnapshot, publishReminderStatus, reminderStatusText } from '../services/notifications/ReminderStatus';
import { answerReminderIntroduction, shouldIntroduceReminders } from '../services/notifications/ReminderIntroduction';
import { deleteRecordedPayment, readRecordedPaymentDeletion } from '../services/planned/RecordedPaymentService';
import { reminderDatabase, reminderNative, reminderPlan, reminderSubscription } from './reminderFixtures';
import type { NotificationPermissionsStatus } from 'expo-notifications/build/NotificationPermissions.types';
import type { Notification } from 'expo-notifications/build/Notifications.types';
import { Platform } from 'react-native';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
let harness: Awaited<ReturnType<typeof reminderDatabase>>;
const now = new Date(2026, 9, 8, 8);
beforeEach(async () => {
  jest.useFakeTimers().setSystemTime(now); jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.replaceProperty(Platform, 'OS', 'android');
  jest.spyOn(localNotificationApi, 'getNotificationChannelAsync').mockResolvedValue({ id: 'financial-reminders-alert', importance: localNotificationApi.AndroidImportance.DEFAULT } as never);
  publishReminderStatus({ permission: 'undetermined', canAskAgain: true, scheduling: 'unknown' });
  harness = await reminderDatabase();
  await repo.setSetting(harness.db, 'setup_complete', 'true');
});
afterEach(() => { harness.close(); jest.restoreAllMocks(); jest.useRealTimers(); });
function nativePermissions(permission: 'granted' | 'denied' | 'undetermined', canAskAgain = false): NotificationPermissionsStatus {
  return { status: permission, granted: permission === 'granted', expires: 'never', canAskAgain } as NotificationPermissionsStatus;
}

test.each([[false, 'true'], [true, 'false']] as const)('introduction is not eligible before ready Home/onboarding (%s/%s)', (homeReady, setup) => {
  expect(shouldIntroduceReminders({ setup_complete: setup, notifications_enabled: 'false' }, homeReady)).toBe(false);
});
test('Not Now answers once, requests no permission and preserves every financial record', async () => {
  const native = reminderNative(); const before = await harness.financial();
  await repo.setSetting(harness.db, 'setup_complete', 'true');
  expect(shouldIntroduceReminders(await repo.getSettings(harness.db), true)).toBe(true);
  await answerReminderIntroduction(harness.db, false, native.boundary); await answerReminderIntroduction(harness.db, true, native.boundary);
  expect(native.boundary.requestPermission).not.toHaveBeenCalled(); expect(shouldIntroduceReminders(await repo.getSettings(harness.db), true)).toBe(false); expect(await harness.financial()).toEqual(before);
});
test('Enable introduction persists independent answer/preference and simultaneous answers request only once', async () => {
  const native = reminderNative(); await reminderPlan(harness.db);
  await Promise.all([answerReminderIntroduction(harness.db, true, native.boundary), answerReminderIntroduction(harness.db, true, native.boundary)]);
  expect(native.boundary.requestPermission).toHaveBeenCalledTimes(1);
  expect(await repo.getSettings(harness.db)).toMatchObject({ notifications_intro_answered: 'true', notifications_enabled: 'true' }); expect(native.pending).toHaveLength(1);
});
test('existing enabled preference suppresses introduction and cannot be overridden by a late Not Now', async () => {
  await repo.setSetting(harness.db, 'notifications_enabled', 'true'); const native = reminderNative();
  expect(shouldIntroduceReminders(await repo.getSettings(harness.db), true)).toBe(false);
  await answerReminderIntroduction(harness.db, false, native.boundary); expect((await repo.getSettings(harness.db)).notifications_enabled).toBe('true'); expect(native.boundary.requestPermission).not.toHaveBeenCalled();
});
test.each([true, false])('native denied canAskAgain=%s requests only where allowed', async canAskAgain => {
  jest.spyOn(localNotificationApi, 'setNotificationChannelAsync').mockResolvedValue(null);
  jest.spyOn(localNotificationApi, 'getPermissionsAsync').mockResolvedValue(nativePermissions('denied', canAskAgain));
  const request = jest.spyOn(localNotificationApi, 'requestPermissionsAsync').mockResolvedValue(nativePermissions('granted'));
  expect(await expoNotificationBoundary.requestPermission()).toBe(canAskAgain ? 'granted' : 'denied'); expect(request).toHaveBeenCalledTimes(canAskAgain ? 1 : 0);
  expect(getReminderStatusSnapshot().canAskAgain).toBe(false);
});
test('permission granted creates channel but never asks permission again', async () => {
  const channel = jest.spyOn(localNotificationApi, 'setNotificationChannelAsync').mockResolvedValue(null);
  const permission = jest.spyOn(localNotificationApi, 'getPermissionsAsync').mockResolvedValue(nativePermissions('granted'));
  const request = jest.spyOn(localNotificationApi, 'requestPermissionsAsync');
  expect(await expoNotificationBoundary.requestPermission()).toBe('granted'); expect(channel).toHaveBeenCalled(); expect(permission).toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
});
test('an existing user-blocked Android channel is detected and requires device Settings, not another permission prompt', async () => {
  jest.spyOn(localNotificationApi, 'setNotificationChannelAsync').mockResolvedValue({ importance: localNotificationApi.AndroidImportance.NONE } as never);
  jest.mocked(localNotificationApi.getNotificationChannelAsync).mockResolvedValue({ id: 'financial-reminders-alert', importance: localNotificationApi.AndroidImportance.NONE } as never);
  const request = jest.spyOn(localNotificationApi, 'requestPermissionsAsync');
  expect(await expoNotificationBoundary.requestPermission()).toBe('unavailable'); expect(request).not.toHaveBeenCalled();
  expect(getReminderStatusSnapshot().error?.code).toBe('CHANNEL_BLOCKED'); expect(reminderStatusText(getReminderStatusSnapshot())).toContain('open device Settings');
});
test('permission status reports a blocked channel even with granted app permission and recovers after channel unblocking', async () => {
  jest.spyOn(localNotificationApi, 'getPermissionsAsync').mockResolvedValue(nativePermissions('granted'));
  const channel = jest.spyOn(localNotificationApi, 'getNotificationChannelAsync').mockResolvedValueOnce({ importance: localNotificationApi.AndroidImportance.NONE } as never).mockResolvedValue(null);
  expect(await inspectReminderPermission()).toMatchObject({ permission: 'granted', error: { stage: 'channel', code: 'CHANNEL_BLOCKED' } });
  const next = await inspectReminderPermission(); expect(next.permission).toBe('granted'); expect(next.error).toBeUndefined(); expect(channel).toHaveBeenCalledTimes(2);
});
test.each(['missing', 'query', 'request', 'channel'] as const)('native %s failure has a distinct safe diagnostic and financial records stay intact', async kind => {
  const before = await harness.financial();
  jest.spyOn(localNotificationApi, 'getPermissionsAsync').mockResolvedValue(nativePermissions('undetermined', true));
  jest.spyOn(localNotificationApi, 'setNotificationChannelAsync').mockResolvedValue(null);
  jest.spyOn(localNotificationApi, 'requestPermissionsAsync').mockResolvedValue(nativePermissions('granted'));
  if (kind === 'channel') jest.mocked(localNotificationApi.setNotificationChannelAsync).mockRejectedValue(new Error('channel failure private title/account'));
  else if (kind === 'request') jest.mocked(localNotificationApi.requestPermissionsAsync).mockRejectedValue(new Error('request failed private title/account'));
  else jest.mocked(localNotificationApi.getPermissionsAsync).mockRejectedValue(new Error(kind === 'missing' ? "Cannot find native module 'ExpoNotificationPermissionsModule'" : 'query failed private title/account'));
  expect(await expoNotificationBoundary.requestPermission()).toBe('unavailable');
  expect(getReminderStatusSnapshot().error?.stage).toBe(kind === 'missing' ? 'native-module' : kind === 'query' ? 'permission-query' : kind === 'request' ? 'permission-request' : 'channel');
  expect(JSON.stringify(jest.mocked(console.warn).mock.calls)).not.toContain('private'); expect(await harness.financial()).toEqual(before);
});
test('native permission-status failure recovers on a later query', async () => {
  const get = jest.spyOn(localNotificationApi, 'getPermissionsAsync').mockRejectedValueOnce(new Error('query transient')).mockResolvedValue(nativePermissions('granted'));
  expect((await inspectReminderPermission()).error?.stage).toBe('permission-query');
  const recovered = await inspectReminderPermission(); expect(recovered.permission).toBe('granted'); expect(recovered.error).toBeUndefined(); expect(get).toHaveBeenCalledTimes(2);
});
test.each([0, 1, 2, 3])('one selected offset %i gives one correctly named local-calendar reminder, not a countdown', async offset => {
  const plan = await reminderPlan(harness.db, { reminder_days_before: offset }); const desired = buildDesiredReminders([plan], [], now);
  expect(desired).toHaveLength(1); expect(desired[0].triggerAt).toEqual(new Date(2026, 9, 20 - offset, 9)); expect(desired[0].offset).toBe(offset);
  expect(desired[0].body).toBe(`Internet Bill is due ${offset === 0 ? 'today' : offset === 1 ? 'tomorrow' : `in ${offset} days`}.`);
});
test.each([1, 2, 3])('income and subscription offset %i use exact names and correct language', async offset => {
  const income = await reminderPlan(harness.db, { name: 'Salary', type: 'INCOME', category_id: 'cat_income_salary', reminder_days_before: offset });
  const sub = await reminderSubscription(harness.db, { reminder_days_before: offset }); const reminders = buildDesiredReminders([income], [sub], now);
  const i = reminders.find(r => r.sourceId === income.id)!; const s = reminders.find(r => r.sourceId === sub.id)!;
  expect(i.title).toContain('Expected income'); expect(i.body).toContain(`Salary is expected ${offset === 1 ? 'tomorrow' : `in ${offset} days`}`); expect(i.body).not.toContain('bill'); expect(s.body).toContain('Netflix renews');
});
test('same-name sources retain distinct IDs and payload identity through the actual local adapter', async () => {
  const a = await reminderPlan(harness.db); const b = await reminderPlan(harness.db); const reminder = buildDesiredReminders([a, b], [], now);
  expect(reminder[0].key).not.toBe(reminder[1].key);
  jest.spyOn(localNotificationApi, 'setNotificationChannelAsync').mockResolvedValue(null);
  const schedule = jest.spyOn(localNotificationApi, 'scheduleNotificationAsync').mockResolvedValue('native');
  await expoNotificationBoundary.schedule(reminder[0], 'signature');
  expect(schedule).toHaveBeenCalledWith(expect.objectContaining({ content: expect.objectContaining({ data: expect.objectContaining({ version: 2, sourceType: 'planned_payment', sourceId: reminder[0].sourceId, occurrenceDate: '2026-10-20', reminderOffset: 3 }) }) }));
});
test('Off, paused/stopped/cancelled/ended and consumed occurrences have no obsolete reminders', async () => {
  const p = await reminderPlan(harness.db); const s = await reminderSubscription(harness.db);
  for (const status of ['PAUSED', 'ENDED'] as const) expect(buildDesiredReminders([{ ...p, status }], [], now)).toEqual([]);
  for (const status of ['PAUSED', 'CANCELLED', 'ENDED'] as const) expect(buildDesiredReminders([], [{ ...s, status }], now)).toEqual([]);
  expect(buildDesiredReminders([{ ...p, deleted_at: '2026-10-08' }], [], now)).toEqual([]); expect(buildDesiredReminders([{ ...p, reminder_enabled: 0 }], [], now)).toEqual([]);
  expect(buildDesiredReminders([p], [], now, new Set([`PLANNED:${p.id}:2026-10-20`]))).toEqual([]);
});
test.each([1, 10, 15, 20, 23, 30, 60])('Daily/Every %i Days creates bounded unique scheduled-date projections without money or past floods', async n => {
  const p = await reminderPlan(harness.db, { next_due_date: '2026-10-01', recurrence_type: n === 1 ? 'DAILY' : 'EVERY_N_DAYS', recurrence_interval: n, reminder_days_before: 1 }); const before = await harness.financial();
  const desired = buildDesiredReminders([p], [], now); expect(desired.length).toBeLessThanOrEqual(48); expect(new Set(desired.map(r => r.key)).size).toBe(desired.length); expect(desired.every(r => r.triggerAt > now)).toBe(true);
  expect(await harness.financial()).toEqual(before); expect((await repo.getPlannedPayment(harness.db, p.id))?.next_due_date).toBe('2026-10-01');
});
test('month-end projection shares the saved 31 anchor and observes cycle/end limits', async () => {
  const p = await reminderPlan(harness.db, { next_due_date: '2028-01-31', recurrence_type: 'MONTHLY', reminder_days_before: 0 });
  const reminders = buildDesiredReminders([p], [], new Date(2028, 0, 30, 8)); expect(reminders.map(r => r.occurrenceDate)).toEqual(['2028-01-31', '2028-02-29']);
  expect(buildDesiredReminders([{ ...p, occurrence_limit: 1 }], [], new Date(2028, 0, 30, 8))).toHaveLength(1);
});
test('reconciliation is idempotent under concurrent calls and reserves unrelated native request capacity', async () => {
  const p = await reminderPlan(harness.db, { recurrence_type: 'DAILY' }); const native = reminderNative();
  native.pending.push(...Array.from({ length: 59 }, (_, i) => ({ identifier: `other-${i}`, content: { data: { managedBy: 'someone-else' } } })));
  const desired = buildDesiredReminders([p], [], now);
  await Promise.all([reconcileReminders(true, desired, native.boundary), reconcileReminders(true, desired, native.boundary)]);
  expect(native.boundary.schedule).toHaveBeenCalledTimes(1); expect(native.pending).toHaveLength(60); expect(native.boundary.cancel).not.toHaveBeenCalled();
});
test('name, date, offset edits replace obsolete content/signatures with only selected offsets', async () => {
  const p = await reminderPlan(harness.db); const native = reminderNative(); await reconcileReminders(true, buildDesiredReminders([p], [], now), native.boundary);
  await reconcileReminders(true, buildDesiredReminders([{ ...p, name: 'Renamed bill' }], [], now), native.boundary); expect(native.boundary.cancel).toHaveBeenCalledTimes(1); expect(native.saved.at(-1)?.body).toContain('Renamed bill');
  await reconcileReminders(true, buildDesiredReminders([{ ...p, next_due_date: '2026-10-23', reminder_days_before: 1 }], [], now), native.boundary); expect(native.pending).toHaveLength(1); expect(native.saved.at(-1)?.offset).toBe(1);
});
test('record/skip/pause/resume/delete reconcile actual persisted dates without financial writes', async () => {
  const p = await reminderPlan(harness.db, { recurrence_type: 'EVERY_N_DAYS', recurrence_interval: 23 }); const native = reminderNative(); await repo.setSetting(harness.db, 'notifications_enabled', 'true');
  await queueAppReminderReconciliation(harness.db, native.boundary, now);
  const tx = await repo.markPlannedPaymentPaid(harness.db, p.id, p.next_due_date); await queueAppReminderReconciliation(harness.db, native.boundary, now); expect(native.pending.some(r => r.identifier.includes('2026-10-20'))).toBe(false);
  await deleteRecordedPayment(harness.db, await readRecordedPaymentDeletion(harness.db, tx)); const financial = await harness.financial(); await queueAppReminderReconciliation(harness.db, native.boundary, now); expect(native.pending.some(r => r.identifier.includes('2026-10-20'))).toBe(true); expect(await harness.financial()).toEqual(financial);
  await repo.skipPlannedPayment(harness.db, p.id, p.next_due_date); let fresh = (await repo.getPlannedPayment(harness.db, p.id))!; await repo.pausePlannedPayment(harness.db, p.id, fresh.updated_at); await queueAppReminderReconciliation(harness.db, native.boundary, now); expect(native.pending).toEqual([]);
  fresh = (await repo.getPlannedPayment(harness.db, p.id))!; await repo.resumePlannedPayment(harness.db, p.id, fresh.updated_at); await queueAppReminderReconciliation(harness.db, native.boundary, now); expect(native.pending.some(r => r.identifier.includes('2026-11-12'))).toBe(true);
});
test('Subscription pay/delete/cancel and permission revoke/re-enable use persisted state, preserving money/preferences', async () => {
  const s = await reminderSubscription(harness.db); const native = reminderNative(); await enableLocalReminders(harness.db, native.boundary);
  const tx = await repo.markSubscriptionPaid(harness.db, s.id, s.next_renewal_date, s.updated_at); await reconcileAppReminders(harness.db, native.boundary, now); expect(native.pending.some(r => r.identifier.includes('2026-10-20'))).toBe(false);
  await deleteRecordedPayment(harness.db, await readRecordedPaymentDeletion(harness.db, tx)); await reconcileAppReminders(harness.db, native.boundary, now); expect(native.pending.some(r => r.identifier.includes('2026-10-20'))).toBe(true);
  const before = await harness.financial(); native.permission('denied'); await reconcileAppReminders(harness.db, native.boundary, now); expect(native.pending).toEqual([]); expect((await repo.getSettings(harness.db)).notifications_enabled).toBe('true');
  native.permission('granted'); await reconcileAppReminders(harness.db, native.boundary, now); expect(native.pending.length).toBeGreaterThan(0); expect(await harness.financial()).toEqual(before);
  await disableLocalReminders(harness.db, native.boundary); expect(native.pending).toEqual([]); expect((await repo.getSubscription(harness.db, s.id))?.reminder_days_before).toBe(3);
  const fresh = (await repo.getSubscription(harness.db, s.id))!; await repo.changeSubscriptionStatus(harness.db, s.id, fresh.updated_at, 'CANCELLED'); await enableLocalReminders(harness.db, native.boundary); expect(native.pending).toEqual([]);
});
test('native scheduling failure is visible, retryable and cannot change finances', async () => {
  const p = await reminderPlan(harness.db); const native = reminderNative(); const before = await harness.financial();
  native.boundary.schedule = jest.fn(async () => { throw new Error('schedule failed'); });
  const result = await reconcileReminders(true, buildDesiredReminders([p], [], now), native.boundary); expect(result.failed).toHaveLength(1); expect(reminderStatusText(getReminderStatusSnapshot())).toContain('retry'); expect(await harness.financial()).toEqual(before);
});
test('foreground handler presents only permitted enabled reminders without automatic navigation', async () => {
  let handler: Parameters<typeof localNotificationApi.setNotificationHandler>[0];
  jest.spyOn(localNotificationApi, 'setNotificationHandler').mockImplementation(value => { handler = value; }); configureNotificationPresentation();
  const native = reminderNative(); await reconcileReminders(true, [], native.boundary);
  const notification = { request: { content: { data: { managedBy: 'expense-tracker' } } } } as unknown as Notification;
  // Reminders alert with sound (user decision 2026-11-17); a Mark as paid receipt shows quietly.
  expect(await handler!.handleNotification(notification)).toMatchObject({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true });
  const receipt = { request: { content: { data: { managedBy: 'expense-tracker', receipt: true } } } } as unknown as Notification;
  expect(await handler!.handleNotification(receipt)).toMatchObject({ shouldShowBanner: true, shouldPlaySound: false });
  await reconcileReminders(false, [], native.boundary); expect(await handler!.handleNotification(notification)).toMatchObject({ shouldShowBanner: false, shouldShowList: false });
});
test('a scheduled reminder card alerts (sound + vibration) on the reminders channel and moves no money', async () => {
  const p = await reminderPlan(harness.db, { next_due_date: '2026-10-20', reminder_days_before: 0 }); const before = await harness.financial();
  jest.spyOn(localNotificationApi, 'setNotificationChannelAsync').mockResolvedValue(null);
  const native = jest.spyOn(localNotificationApi, 'scheduleNotificationAsync').mockResolvedValue('scheduled');
  const [reminder] = buildDesiredReminders([p], [], now);
  await expoNotificationBoundary.schedule(reminder, 'signature');
  expect(native).toHaveBeenCalledWith(expect.objectContaining({ content: expect.objectContaining({ sound: true, vibrate: [0, 250, 250, 250], data: expect.objectContaining({ sourceId: p.id, sourceType: 'planned_payment' }) }) }));
  expect(await harness.financial()).toEqual(before);
});

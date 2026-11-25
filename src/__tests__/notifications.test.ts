/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import * as SQLite from 'expo-sqlite';
import * as Notifications from 'expo-notifications';
import { openAppDatabase, type AppDb } from '../database/database';
import * as repo from '../database/repositories/repositories';
import {
  budgetThresholdCrossings,
  buildDesiredReminders,
  disableLocalReminders,
  enableLocalReminders,
  expoNotificationBoundary,
  queueAppReminderReconciliation,
  reconcileAppReminders,
  reconcileReminders,
  type ManagedReminder,
  type NotificationBoundary,
  type ReminderPermission,
} from '../services/notifications/NotificationService';
import { localNotificationApi } from '../services/notifications/LocalNotificationApi';
import type { PlannedPayment, Subscription } from '../types/models';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

let sqlite: DatabaseSync;
let db: AppDb;

beforeEach(async () => {
  jest.clearAllMocks();
  jest.useFakeTimers().setSystemTime(new Date(2027, 0, 15, 12));
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(localNotificationApi, 'getPermissionsAsync');
  jest.spyOn(localNotificationApi, 'requestPermissionsAsync');
  jest.spyOn(localNotificationApi, 'scheduleNotificationAsync');
  jest.spyOn(localNotificationApi, 'setNotificationChannelAsync').mockResolvedValue(null);
  sqlite = new DatabaseSync(':memory:');
  const adapter = {
    execAsync: async (sql: string) => { sqlite.exec(sql); },
    runAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).run(...params),
    getAllAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).all(...params),
    getFirstAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).get(...params) ?? null,
    withTransactionAsync: async (work: () => Promise<void>) => {
      sqlite.exec('BEGIN');
      try { await work(); sqlite.exec('COMMIT'); }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    withExclusiveTransactionAsync: async (work: (txn: AppDb) => Promise<void>) => adapter.withTransactionAsync(() => work(db)),
  };
  db = adapter as unknown as AppDb;
  jest.mocked(SQLite.openDatabaseAsync).mockResolvedValue(db);
  await openAppDatabase();
});

afterEach(() => { sqlite.close(); jest.restoreAllMocks(); jest.useRealTimers(); });

const base = {
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  deleted_at: null,
  sync_status: 'LOCAL' as const,
};

function plan(overrides: Partial<PlannedPayment> = {}): PlannedPayment {
  return {
    ...base, id: 'planned_1', name: 'Rent', type: 'EXPENSE', amount_minor: 10000,
    category_id: 'cat_expense_bills', account_id: 'account_cash_default',
    next_due_date: '2027-02-10', recurrence_type: 'MONTHLY', recurrence_interval: 1,
    end_date: null, occurrence_limit: null, completed_occurrences: 0,
    reminder_enabled: 1, reminder_days_before: 1, subscription_metadata: null,
    status: 'ACTIVE', note: null, ...overrides,
  };
}

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    ...base, id: 'subscription_1', name: 'Service', amount_minor: 15000,
    category_id: 'cat_expense_subscriptions', account_id: 'account_cash_default',
    frequency_type: 'MONTHLY', frequency_interval: 1, start_date: '2027-01-10',
    next_renewal_date: '2027-02-10', end_date: null, total_cycles: null,
    completed_cycles: 0, reminder_enabled: 1, reminder_days_before: 3,
    cancellation_reminder_enabled: 0, cancellation_reminder_date: null,
    status: 'ACTIVE', note: null, ...overrides,
  };
}

type Stored = { identifier: string; content: { data?: Record<string, unknown> } };

function native(permission: ReminderPermission = 'granted') {
  const stored: Stored[] = [];
  let nextPermission = permission;
  const boundary: NotificationBoundary = {
    getPermission: jest.fn(async () => nextPermission),
    requestPermission: jest.fn(async () => nextPermission),
    getScheduled: jest.fn(async () => [...stored]),
    schedule: jest.fn(async (reminder: ManagedReminder, signature: string) => {
      stored.push({
        identifier: reminder.key,
        content: { data: { managedBy: 'expense-tracker', reminderKey: reminder.key, scheduleSignature: signature } },
      });
      return reminder.key;
    }),
    cancel: jest.fn(async (identifier: string) => {
      const index = stored.findIndex((item) => item.identifier === identifier);
      if (index >= 0) stored.splice(index, 1);
    }),
  };
  return { boundary, stored, setPermission: (value: ReminderPermission) => { nextPermission = value; } };
}

const beforeAllReminders = new Date(2027, 0, 1, 12);

test('notification initialization never enters the remote push-token path', () => {
  expect(Notifications.addPushTokenListener).not.toHaveBeenCalled();
  expect(Notifications.getDevicePushTokenAsync).not.toHaveBeenCalled();
  expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
});

test('Expo permission boundary maps granted, denied and unavailable responses safely', async () => {
  const getPermissions = jest.mocked(localNotificationApi.getPermissionsAsync);
  getPermissions.mockResolvedValueOnce({ granted: true, status: 'granted' } as never);
  await expect(expoNotificationBoundary.getPermission()).resolves.toBe('granted');
  getPermissions.mockResolvedValueOnce({ granted: false, status: 'denied' } as never);
  await expect(expoNotificationBoundary.getPermission()).resolves.toBe('denied');
  getPermissions.mockRejectedValueOnce(new Error('native module missing'));
  await expect(expoNotificationBoundary.getPermission()).resolves.toBe('unavailable');
});

test('Expo boundary schedules a local reminder through the native scheduler', async () => {
  jest.mocked(localNotificationApi.scheduleNotificationAsync).mockResolvedValueOnce('native-local-id');
  const [reminder] = buildDesiredReminders([plan()], [], beforeAllReminders);

  await expect(expoNotificationBoundary.schedule(reminder, 'signature')).resolves.toBe('native-local-id');
  expect(localNotificationApi.scheduleNotificationAsync).toHaveBeenCalledWith(expect.objectContaining({
    identifier: reminder.key,
    content: expect.objectContaining({ data: expect.objectContaining({ managedBy: 'expense-tracker' }) }),
    trigger: expect.objectContaining({ date: reminder.triggerAt }),
  }));
});

test('Expo boundary returns denied without requesting another permission prompt', async () => {
  jest.mocked(localNotificationApi.getPermissionsAsync).mockResolvedValueOnce({
    granted: false,
    status: 'denied',
  } as never);

  await expect(expoNotificationBoundary.requestPermission()).resolves.toBe('denied');
  expect(localNotificationApi.requestPermissionsAsync).not.toHaveBeenCalled();
});

test('permission granted enables the master setting and reconciles eligible reminders', async () => {
  const mock = native('granted');
  await repo.savePlannedPayment(db, plan());
  const result = await enableLocalReminders(db, mock.boundary);
  expect(result.permission).toBe('granted');
  expect((await repo.getSettings(db)).notifications_enabled).toBe('true');
  expect(mock.boundary.requestPermission).toHaveBeenCalledTimes(1);
  expect(mock.stored).toHaveLength(2); // Two monthly occurrences inside the rolling horizon, one offset each.
});

test.each(['denied', 'unavailable'] as const)('%s permission leaves reminders optional and financial settings usable', async (permission) => {
  const mock = native(permission);
  await repo.setSetting(db, 'notifications_enabled', 'true');
  const result = await enableLocalReminders(db, mock.boundary);
  expect(result.permission).toBe(permission);
  expect((await repo.getSettings(db)).notifications_enabled).toBe('true'); // Keep the existing preference; native permission still gates delivery.
  await expect(repo.setSetting(db, 'currency', 'USD')).resolves.toBeUndefined();
});

test('master reminders off cancels app-managed schedules without touching other notifications', async () => {
  const mock = native();
  mock.stored.push(
    { identifier: 'managed', content: { data: { managedBy: 'expense-tracker', reminderKey: 'old' } } },
    { identifier: 'other-app-feature', content: { data: { managedBy: 'someone-else' } } },
  );
  await repo.setSetting(db, 'notifications_enabled', 'true');
  const result = await disableLocalReminders(db, mock.boundary);
  expect(result.cancelled).toBe(1);
  expect(mock.stored.map((item) => item.identifier)).toEqual(['other-app-feature']);
  expect((await repo.getSettings(db)).notifications_enabled).toBe('false');
});

test('repeated reconciliation is idempotent', async () => {
  const mock = native();
  const desired = buildDesiredReminders([plan()], [subscription()], beforeAllReminders);
  await reconcileReminders(true, desired, mock.boundary);
  await reconcileReminders(true, desired, mock.boundary);
  expect(new Set(mock.stored.map((item) => item.identifier)).size).toBe(desired.length);
  expect(mock.stored).toHaveLength(desired.length);
});

test('queued app reconciliation serializes overlapping refreshes without duplicates', async () => {
  const mock = native();
  await repo.setSetting(db, 'notifications_enabled', 'true');
  await repo.savePlannedPayment(db, plan());
  await Promise.all([
    queueAppReminderReconciliation(db, mock.boundary, beforeAllReminders),
    queueAppReminderReconciliation(db, mock.boundary, beforeAllReminders),
  ]);
  expect(mock.stored).toHaveLength(1);
});

test('planned reminder uses stable source/occurrence identity and local 9 AM', () => {
  const [reminder] = buildDesiredReminders([plan()], [], beforeAllReminders);
  expect(reminder.key).toContain('planned_due_planned_1_2027-02-10');
  expect(reminder.triggerAt).toEqual(new Date(2027, 1, 9, 9));
  expect(reminder.title).toBe('Payment due tomorrow');
  expect(reminder.body).toContain('Rent');
});

test('editing a planned occurrence cancels the old identity and schedules the new one', async () => {
  const mock = native();
  await reconcileReminders(true, buildDesiredReminders([plan()], [], beforeAllReminders), mock.boundary);
  await reconcileReminders(true, buildDesiredReminders([plan({ next_due_date: '2027-03-10' })], [], new Date(2027, 0, 15, 12)), mock.boundary);
  expect(mock.boundary.cancel).toHaveBeenCalledTimes(1);
  expect(mock.stored[0].identifier).toContain('2027-03-10');
});

test('planned pause suppresses and resume restores only the current reminder', async () => {
  const mock = native();
  await reconcileReminders(true, buildDesiredReminders([plan()], [], beforeAllReminders), mock.boundary);
  await reconcileReminders(true, buildDesiredReminders([plan({ status: 'PAUSED' })], [], beforeAllReminders), mock.boundary);
  expect(mock.stored).toEqual([]);
  await reconcileReminders(true, buildDesiredReminders([plan()], [], beforeAllReminders), mock.boundary);
  expect(mock.stored).toHaveLength(1);
});

test.each(['recorded', 'skipped'])('%s planned occurrence cannot leave a stale reminder', async () => {
  const consumed = new Set(['PLANNED:planned_1:2027-02-10']);
  expect(buildDesiredReminders([plan()], [], beforeAllReminders, consumed)).toEqual([]);
});

test('stopped, ended, invalid and stale planned dates produce no reminder', () => {
  expect(buildDesiredReminders([], [], beforeAllReminders)).toEqual([]);
  expect(buildDesiredReminders([plan({ status: 'ENDED' })], [], beforeAllReminders)).toEqual([]);
  expect(buildDesiredReminders([plan({ next_due_date: 'not-a-date' })], [], beforeAllReminders)).toEqual([]);
  expect(buildDesiredReminders([plan({ next_due_date: '2026-12-01' })], [], beforeAllReminders).every(item => item.triggerAt > beforeAllReminders)).toBe(true);
});

test('subscription reminder is derived from the active next billing occurrence', () => {
  const reminders = buildDesiredReminders([], [subscription()], beforeAllReminders);
  expect(reminders).toHaveLength(1);
  expect(reminders[0]).toMatchObject({ kind: 'SUBSCRIPTION_RENEWAL', occurrenceDate: '2027-02-10' });
  expect(reminders[0].triggerAt).toEqual(new Date(2027, 1, 7, 9));
});

test('subscription pause, cancellation and ended state suppress all future reminders', () => {
  for (const status of ['PAUSED', 'CANCELLED', 'ENDED'] as const) {
    expect(buildDesiredReminders([], [subscription({ status })], beforeAllReminders)).toEqual([]);
  }
  expect(buildDesiredReminders([], [subscription({ total_cycles: 2, completed_cycles: 2 })], beforeAllReminders)).toEqual([]);
});

test('subscription resume reconciles the retained occurrence without duplication', async () => {
  const mock = native();
  await reconcileReminders(true, buildDesiredReminders([], [subscription({ status: 'PAUSED' })], beforeAllReminders), mock.boundary);
  const desired = buildDesiredReminders([], [subscription()], beforeAllReminders);
  await reconcileReminders(true, desired, mock.boundary);
  await reconcileReminders(true, desired, mock.boundary);
  expect(mock.stored).toHaveLength(1);
});

test('explicit trial/cancellation metadata schedules a separate privacy-conscious reminder', () => {
  const reminders = buildDesiredReminders([], [subscription({
    cancellation_reminder_enabled: 1,
    cancellation_reminder_date: '2027-02-05',
  })], beforeAllReminders);
  expect(reminders.map((item) => item.kind)).toEqual(['CANCELLATION', 'SUBSCRIPTION_RENEWAL']);
  expect(reminders[0]).toMatchObject({ occurrenceDate: '2027-02-05', title: 'Trial/cancellation reminder' });
  expect(reminders[0].body).toContain('Service');
});

test('editing the explicit cancellation date reschedules its deterministic identity', async () => {
  const mock = native();
  const first = subscription({ cancellation_reminder_enabled: 1, cancellation_reminder_date: '2027-02-05', reminder_enabled: 0 });
  const edited = subscription({ cancellation_reminder_enabled: 1, cancellation_reminder_date: '2027-02-06', reminder_enabled: 0 });
  await reconcileReminders(true, buildDesiredReminders([], [first], beforeAllReminders), mock.boundary);
  await reconcileReminders(true, buildDesiredReminders([], [edited], beforeAllReminders), mock.boundary);
  expect(mock.boundary.cancel).toHaveBeenCalledTimes(1);
  expect(mock.stored[0].identifier).toContain('2027-02-06');
});

test('Mark Paid commits exactly one subscription Expense even when reminder scheduling fails afterward', async () => {
  await repo.setSetting(db, 'notifications_enabled', 'true');
  const id = await repo.saveSubscription(db, {
    name: 'Service', amount_minor: 15000, category_id: 'cat_expense_subscriptions', account_id: 'account_cash_default',
    frequency_type: 'MONTHLY', frequency_interval: 1, start_date: '2027-01-10', next_renewal_date: '2027-02-10',
    end_date: null, total_cycles: null, reminder_enabled: 1, reminder_days_before: 3,
    cancellation_reminder_enabled: 0, cancellation_reminder_date: null, note: null,
  });
  const before = (await repo.getSubscription(db, id))!;
  await repo.markSubscriptionPaid(db, id, before.next_renewal_date, before.updated_at);
  const mock = native();
  mock.boundary.schedule = jest.fn(async () => { throw new Error('native scheduler failed'); });
  const result = await reconcileAppReminders(db, mock.boundary, new Date(2027, 0, 15, 12));
  expect(result.failed).toEqual([expect.stringContaining('schedule:')]);
  expect(await repo.listTransactions(db)).toEqual([expect.objectContaining({ type: 'EXPENSE', source: 'SUBSCRIPTION' })]);
  expect(await repo.listSubscriptionPayments(db, id)).toHaveLength(1);
  expect(await repo.getSubscription(db, id)).toMatchObject({ next_renewal_date: '2027-03-10', completed_cycles: 1 });
});

test('planned recording commits exactly one transaction and next occurrence despite scheduler failure', async () => {
  await repo.setSetting(db, 'notifications_enabled', 'true');
  const id = await repo.savePlannedPayment(db, plan({ id: 'ignored' }));
  const before = (await repo.getPlannedPayment(db, id))!;
  await repo.markPlannedPaymentPaid(db, id, before.next_due_date);
  const mock = native();
  mock.boundary.schedule = jest.fn(async () => { throw new Error('native scheduler failed'); });
  await reconcileAppReminders(db, mock.boundary, beforeAllReminders);
  expect(await repo.listTransactions(db)).toEqual([expect.objectContaining({ type: 'EXPENSE', source: 'PLANNED' })]);
  expect(await repo.listPlannedPaymentOccurrences(db, id)).toHaveLength(1);
  expect(await repo.getPlannedPayment(db, id)).toMatchObject({ next_due_date: '2027-03-10', completed_occurrences: 1 });
});

test('a reminder payload contains no financial command and firing it creates no record', async () => {
  const mock = native();
  await reconcileReminders(true, buildDesiredReminders([plan()], [], beforeAllReminders), mock.boundary);
  expect(mock.stored[0].content.data).not.toHaveProperty('action');
  expect(await repo.listTransactions(db)).toEqual([]);
  expect(await repo.listPersonEntries(db)).toEqual([]);
});

test('failed stale cancellation blocks replacement to avoid duplicate identities', async () => {
  const mock = native();
  mock.stored.push({ identifier: 'old', content: { data: {
    managedBy: 'expense-tracker', reminderKey: buildDesiredReminders([plan()], [], beforeAllReminders)[0].key,
    scheduleSignature: 'stale',
  } } });
  mock.boundary.cancel = jest.fn(async () => { throw new Error('cannot cancel'); });
  const result = await reconcileReminders(true, buildDesiredReminders([plan()], [], beforeAllReminders), mock.boundary);
  expect(result.failed).toEqual(['cancel:old']);
  expect(mock.boundary.schedule).not.toHaveBeenCalled();
});

test('failed cancellation of an edited occurrence blocks its different replacement key', async () => {
  const mock = native();
  await reconcileReminders(true, buildDesiredReminders([plan()], [], beforeAllReminders), mock.boundary);
  mock.boundary.cancel = jest.fn(async () => { throw new Error('cannot cancel'); });
  const result = await reconcileReminders(
    true,
    buildDesiredReminders([plan({ next_due_date: '2027-03-10' })], [], beforeAllReminders),
    mock.boundary,
  );
  expect(result.failed).toEqual([expect.stringContaining('cancel:')]);
  expect(mock.boundary.schedule).toHaveBeenCalledTimes(1);
  expect(mock.stored).toHaveLength(1);
  expect(mock.stored[0].identifier).toContain('2027-02-10');
});

test('failed cancellation while disabling is reported and does not schedule anything', async () => {
  const mock = native();
  await reconcileReminders(true, buildDesiredReminders([plan()], [], beforeAllReminders), mock.boundary);
  mock.boundary.cancel = jest.fn(async () => { throw new Error('cannot cancel'); });
  const result = await reconcileReminders(false, [], mock.boundary);
  expect(result.failed).toEqual([expect.stringContaining('cancel:')]);
  expect(mock.boundary.schedule).toHaveBeenCalledTimes(1);
});

test('budget threshold helper detects crossings and suppresses already-claimed milestones', () => {
  expect(budgetThresholdCrossings(7900, 10100, 10000, 80)).toEqual(['WARNING', 'REACHED']);
  expect(budgetThresholdCrossings(7900, 9000, 10000, 80, new Set(['WARNING']))).toEqual([]);
  expect(budgetThresholdCrossings(9000, 9500, 10000, 80)).toEqual([]);
});

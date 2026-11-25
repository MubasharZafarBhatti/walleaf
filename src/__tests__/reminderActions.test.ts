/// <reference types="node" />
import { buildDesiredReminders, reconcileReminders, snoozeStillValid } from '../services/notifications/NotificationService';
import { createReminderTapCoordinator, parseReminderTap } from '../services/notifications/ReminderNavigation';
import {
  handleReminderAction, latestReminderAck, setReminderDatabase, subscribeReminderAcks, setReminderPaymentListener, setReminderStateStoreForTests, syncReminderDeliveries, type ReminderStateStore,
} from '../services/notifications/ReminderActions';
import { REMINDER_CATEGORY_BUTTONS, REMINDER_CATEGORY_IDS, REMINDER_SNOOZE_MS } from '../services/notifications/ReminderConstants';
import { localNotificationApi } from '../services/notifications/LocalNotificationApi';
import { reminderDatabase, reminderNative, reminderPlan } from './reminderFixtures';
import type { PlannedPayment, Subscription } from '../types/models';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('../services/notifications/LocalNotificationApi', () => ({
  localNotificationApi: {
    AndroidImportance: { NONE: 0, MIN: 1, LOW: 2, DEFAULT: 3, HIGH: 4, MAX: 5 },
    IosAuthorizationStatus: {},
    SchedulableTriggerInputTypes: { DATE: 'date' },
    scheduleNotificationAsync: jest.fn(async () => 'id'),
    getAllScheduledNotificationsAsync: jest.fn(async () => []),
    cancelScheduledNotificationAsync: jest.fn(async () => undefined),
    dismissNotificationAsync: jest.fn(async () => undefined),
    setNotificationCategoryAsync: jest.fn(async () => null),
  },
}));

function memoryStore(): ReminderStateStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItemAsync: async key => data.get(key) ?? null,
    setItemAsync: async (key, value) => { data.set(key, value); },
    removeItemAsync: async key => data.delete(key),
    getAllKeysAsync: async () => [...data.keys()],
  };
}
let kv: ReturnType<typeof memoryStore>;
beforeEach(() => { kv = memoryStore(); setReminderStateStoreForTests(kv); jest.clearAllMocks(); });
afterAll(() => setReminderStateStoreForTests(null));

const DATA = { managedBy: 'expense-tracker', reminderKey: 'expense_tracker_v2_planned_due_p1_2026-11-17_0', reminderKind: 'PLANNED_DUE', sourceId: 'p1', occurrenceDate: '2026-11-17', version: 2, sourceType: 'planned_payment', reminderOffset: 0, category: 'expense', triggerTimestamp: 1000 };
function response(action: string, identifier = 'expense_tracker_v2_planned_due_p1_2026-11-17_0', date = 1000) {
  return { actionIdentifier: action, notification: { date, request: { identifier, content: { title: 'Payment due today', body: 'Rent is due today.', data: { ...DATA } } } } };
}

test('three buttons in the requested order; income and cancellation wording', () => {
  expect(REMINDER_CATEGORY_BUTTONS.expense.map(b => b.buttonTitle)).toEqual(['Got it', 'Snooze', 'Mark as paid']);
  expect(REMINDER_CATEGORY_BUTTONS.income.map(b => b.buttonTitle)).toEqual(['Got it', 'Snooze', 'Mark as received']);
  expect(REMINDER_CATEGORY_BUTTONS.review.map(b => b.buttonTitle)).toEqual(['Got it', 'Snooze', 'Review']);
  // Got it, Snooze and Mark as paid all work without opening the app; only Review opens it.
  expect(REMINDER_CATEGORY_BUTTONS.expense.map(b => b.opensApp)).toEqual([false, false, false]);
  expect(REMINDER_CATEGORY_BUTTONS.income.map(b => b.opensApp)).toEqual([false, false, false]);
  expect(REMINDER_CATEGORY_BUTTONS.review.map(b => b.opensApp)).toEqual([false, false, true]);
});

test('buttons parse to actions; unknown buttons are rejected and never navigate', () => {
  expect(parseReminderTap(response('mark-read'))?.action).toBe('read');
  expect(parseReminderTap(response('remind-later'))?.action).toBe('later');
  expect(parseReminderTap(response('mark-paid'))?.action).toBe('paid');
  expect(parseReminderTap(response('expo.modules.notifications.actions.DEFAULT'))?.action).toBe('open');
  expect(parseReminderTap(response('dismiss'))).toBeNull();
  expect(parseReminderTap(response('constructor'))).toBeNull();
});

test('Got it, Snooze and Mark as paid never navigate; a body tap does', async () => {
  const open = jest.fn();
  const backgroundPending = jest.fn();
  const controller = createReminderTapCoordinator({ context: () => null, open, unavailable: jest.fn(), clear: jest.fn(), pending: backgroundPending });
  const pending = jest.fn();
  const watched = createReminderTapCoordinator({ context: () => null, open, unavailable: jest.fn(), clear: jest.fn(), pending });
  controller.receive(response('mark-read')); controller.receive(response('remind-later')); controller.receive(response('mark-paid'));
  expect(backgroundPending).not.toHaveBeenCalled(); // nothing queued for navigation
  watched.receive(response('expo.modules.notifications.actions.DEFAULT'));
  expect(pending).toHaveBeenCalledWith(true); // body tap queued for navigation once ready
  expect(open).not.toHaveBeenCalled();
  controller.dispose(); watched.dispose();
});

test('Mark as read records acknowledgement and clears the card exactly once', async () => {
  await handleReminderAction(response('mark-read'), 5000);
  await handleReminderAction(response('mark-read'), 6000); // replayed/double-delivered press
  expect(await latestReminderAck('planned_payment', 'p1')).toEqual({ method: 'read', at: 5000, occurrenceDate: '2026-11-17' });
  expect(localNotificationApi.dismissNotificationAsync).toHaveBeenCalledTimes(1);
  expect(localNotificationApi.scheduleNotificationAsync).not.toHaveBeenCalled();
});

test('Remind me later re-schedules the same card 3 hours later with a stable identifier', async () => {
  await handleReminderAction(response('remind-later'), 10_000);
  expect(localNotificationApi.scheduleNotificationAsync).toHaveBeenCalledWith(expect.objectContaining({
    identifier: 'expense_tracker_v2_planned_due_p1_2026-11-17_0__snooze',
    content: expect.objectContaining({
      title: 'Payment due today', categoryIdentifier: REMINDER_CATEGORY_IDS.expense,
      data: expect.objectContaining({ snoozed: true, sourceId: 'p1', occurrenceDate: '2026-11-17', triggerTimestamp: 10_000 + REMINDER_SNOOZE_MS }),
    }),
    trigger: expect.objectContaining({ date: new Date(10_000 + REMINDER_SNOOZE_MS) }),
  }));
  expect((await latestReminderAck('planned_payment', 'p1'))?.method).toBe('snoozed');
  // Snoozing the snoozed card replaces it instead of stacking duplicates.
  await handleReminderAction(response('remind-later', 'expense_tracker_v2_planned_due_p1_2026-11-17_0__snooze', 2000), 20_000);
  expect(jest.mocked(localNotificationApi.scheduleNotificationAsync).mock.calls[1][0].identifier).toBe('expense_tracker_v2_planned_due_p1_2026-11-17_0__snooze');
});

function paidResponse(plan: PlannedPayment, date = 1000) {
  const r = response('mark-paid', `expense_tracker_v2_planned_due_${plan.id}_${plan.next_due_date}_0`, date);
  Object.assign(r.notification.request.content.data, { sourceId: plan.id, occurrenceDate: plan.next_due_date });
  return r;
}
const receipt = () => jest.mocked(localNotificationApi.scheduleNotificationAsync).mock.calls.map(call => call[0]).find(item => String(item.identifier).endsWith('__receipt'));

test('Mark as paid records the due occurrence in the background and posts a receipt', async () => {
  const harness = await reminderDatabase();
  try {
    setReminderDatabase(harness.db);
    await harness.db.runAsync('UPDATE accounts SET opening_balance_minor = 7000000 WHERE id = ?;', 'account_cash_default'); // Rs 70,000
    const plan = await reminderPlan(harness.db, { amount_minor: 10000, next_due_date: '2026-11-17', recurrence_type: 'MONTHLY' });
    const refreshed = jest.fn(); setReminderPaymentListener(refreshed);
    await handleReminderAction(paidResponse(plan), 7000);
    const occurrences = await harness.db.getAllAsync<{ scheduled_date: string; outcome: string }>('SELECT scheduled_date, outcome FROM planned_payment_occurrences WHERE planned_payment_id = ?;', plan.id);
    expect(occurrences).toEqual([{ scheduled_date: '2026-11-17', outcome: 'RECORDED' }]);
    expect(await harness.db.getAllAsync('SELECT amount_minor, type, occurred_on FROM transactions WHERE source = ? AND deleted_at IS NULL;', 'PLANNED')).toEqual([{ amount_minor: 10000, type: 'EXPENSE', occurred_on: '2026-11-17' }]);
    expect((await harness.db.getFirstAsync<{ next_due_date: string }>('SELECT next_due_date FROM planned_payments WHERE id = ?;', plan.id))!.next_due_date).toBe('2026-12-17');
    expect(receipt()).toMatchObject({ content: { title: 'Payment recorded', data: expect.objectContaining({ receipt: true }) } });
    expect(receipt()!.content.categoryIdentifier).toBeUndefined(); // no buttons on a receipt
    expect(refreshed).toHaveBeenCalled();
    expect((await latestReminderAck('planned_payment', plan.id))?.method).toBe('paid');
  } finally { setReminderDatabase(null); setReminderPaymentListener(null); harness.close(); }
});

test('Mark as paid with the app fully closed (raw task payload, own database connection) records once', async () => {
  const harness = await reminderDatabase(); // openAppDatabase() now resolves to this harness
  try {
    setReminderDatabase(null); // no live app: the headless task opens its own connection
    await harness.db.runAsync('UPDATE accounts SET opening_balance_minor = 7000000 WHERE id = ?;', 'account_cash_default');
    const plan = await reminderPlan(harness.db, { amount_minor: 10000, next_due_date: '2026-11-17', recurrence_type: 'MONTHLY' });
    const live = paidResponse(plan);
    const { data, ...content } = live.notification.request.content;
    const headless = { actionIdentifier: 'mark-paid', notification: { date: live.notification.date, request: { identifier: live.notification.request.identifier, trigger: null, content: { ...content, dataString: JSON.stringify(data) } } } };
    await handleReminderAction(headless, 7000);
    await handleReminderAction(headless, 7100); // Android may deliver the press twice
    expect(await harness.db.getAllAsync('SELECT amount_minor FROM transactions WHERE source = ? AND deleted_at IS NULL;', 'PLANNED')).toEqual([{ amount_minor: 10000 }]);
    expect(receipt()).toMatchObject({ content: { title: 'Payment recorded' } });
    expect(localNotificationApi.dismissNotificationAsync).toHaveBeenCalledWith(live.notification.request.identifier);
  } finally { harness.close(); }
});

test('a second Mark as paid for the same occurrence never records twice', async () => {
  const harness = await reminderDatabase();
  try {
    setReminderDatabase(harness.db);
    await harness.db.runAsync('UPDATE accounts SET opening_balance_minor = 7000000 WHERE id = ?;', 'account_cash_default'); // Rs 70,000
    const plan = await reminderPlan(harness.db, { amount_minor: 10000, next_due_date: '2026-11-17', recurrence_type: 'MONTHLY' });
    await handleReminderAction(paidResponse(plan, 1000), 7000);
    const after = await harness.financial();
    jest.mocked(localNotificationApi.scheduleNotificationAsync).mockClear();
    await handleReminderAction(paidResponse(plan, 2000), 8000); // e.g. the snoozed copy of the same reminder
    expect(await harness.financial()).toEqual(after);
    expect(receipt()).toMatchObject({ content: { title: 'Not recorded', body: expect.stringContaining('already recorded') } });
  } finally { setReminderDatabase(null); harness.close(); }
});

test('Mark as paid refuses to overdraw an account and changes nothing', async () => {
  const harness = await reminderDatabase();
  try {
    setReminderDatabase(harness.db);
    const plan = await reminderPlan(harness.db, { amount_minor: 900_000_000, next_due_date: '2026-11-17' });
    const before = await harness.financial();
    await handleReminderAction(paidResponse(plan), 7000);
    expect(await harness.financial()).toEqual(before);
    expect(receipt()).toMatchObject({ content: { title: 'Not recorded', body: expect.stringContaining('below zero') } });
    expect((await latestReminderAck('planned_payment', plan.id))?.method).toBe('paid_failed');
  } finally { setReminderDatabase(null); harness.close(); }
});

test('Got it and Snooze never touch financial data', async () => {
  const harness = await reminderDatabase();
  try {
    setReminderDatabase(harness.db);
    const plan = await reminderPlan(harness.db, { next_due_date: '2026-11-17' });
    const before = await harness.financial();
    const read = paidResponse(plan, 3000); read.actionIdentifier = 'mark-read';
    const later = paidResponse(plan, 4000); later.actionIdentifier = 'remind-later';
    await handleReminderAction(read, 7000); await handleReminderAction(later, 8000);
    expect(await harness.financial()).toEqual(before);
  } finally { setReminderDatabase(null); harness.close(); }
});

test('a fired reminder that left the shade without any button press is recorded as swiped', async () => {
  const scheduled = [{ identifier: 'a', content: { data: { ...DATA, triggerTimestamp: 1000 } } }, { identifier: 'b', content: { data: { ...DATA, sourceId: 'p2', triggerTimestamp: 9_000_000 } } }];
  await syncReminderDeliveries(scheduled, [], 500); // both tracked while pending
  // 'a' fired and was swiped; 'b' was cancelled before firing (e.g. payment recorded early).
  await syncReminderDeliveries([], [], 2000);
  expect(await latestReminderAck('planned_payment', 'p1')).toEqual({ method: 'dismissed', at: 2000, occurrenceDate: '2026-11-17' });
  expect(await latestReminderAck('planned_payment', 'p2')).toBeNull();
});

test('a snoozed card is tracked when scheduled, so a swipe is caught without an app open in between', async () => {
  await handleReminderAction(response('remind-later'), 10_000); // snooze fires at 10_000 + 3h
  expect((await latestReminderAck('planned_payment', 'p1'))?.method).toBe('snoozed');
  // No reconcile ran while the snooze was pending; it fired and was swiped away.
  await syncReminderDeliveries([], [], 10_000 + REMINDER_SNOOZE_MS + 60_000);
  expect((await latestReminderAck('planned_payment', 'p1'))?.method).toBe('dismissed');
});

type ScheduledArg = { identifier: string; content: { data: Record<string, unknown> } };
const lastScheduled = () => (localNotificationApi.scheduleNotificationAsync as jest.Mock).mock.calls.at(-1)![0] as ScheduledArg;

test('swiping a card for an occurrence cancels its earlier Snooze, so it does not come back', async () => {
  await handleReminderAction(response('remind-later'), 10_000);
  const snooze = lastScheduled();
  const card = { identifier: 'test-card', content: { data: { ...DATA, triggerTimestamp: 20_000 } } };
  await syncReminderDeliveries([snooze, card], [], 15_000); // both pending and tracked
  await syncReminderDeliveries([snooze], [], 30_000); // the test card fired and was swiped
  expect((await latestReminderAck('planned_payment', 'p1'))?.method).toBe('dismissed');
  expect(localNotificationApi.cancelScheduledNotificationAsync).toHaveBeenCalledWith(snooze.identifier);
});

test('Got it on any card for the occurrence cancels its pending Snooze; a later Snooze is kept', async () => {
  await handleReminderAction(response('remind-later'), 10_000);
  const snooze = lastScheduled();
  (localNotificationApi.getAllScheduledNotificationsAsync as jest.Mock).mockResolvedValueOnce([snooze]);
  await handleReminderAction(response('mark-read', 'test-card', 20_000), 20_000);
  expect(localNotificationApi.cancelScheduledNotificationAsync).toHaveBeenCalledWith(snooze.identifier);
  // A swiped card that fired before the Snooze was set leaves that Snooze alone.
  (localNotificationApi.cancelScheduledNotificationAsync as jest.Mock).mockClear();
  await handleReminderAction(response('remind-later', 'other-card', 30_000), 40_000);
  const laterSnooze = lastScheduled();
  const early = { identifier: 'early', content: { data: { ...DATA, triggerTimestamp: 35_000 } } };
  await syncReminderDeliveries([laterSnooze, early], [], 34_000);
  await syncReminderDeliveries([laterSnooze], [], 50_000);
  expect(localNotificationApi.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
});

test('an open detail screen is told when a response is recorded', async () => {
  const listener = jest.fn();
  const unsubscribe = subscribeReminderAcks(listener);
  await handleReminderAction(response('mark-read'), 5_000);
  expect(listener).toHaveBeenCalled();
  unsubscribe(); listener.mockClear();
  await handleReminderAction(response('mark-read', 'second'), 6_000);
  expect(listener).not.toHaveBeenCalled();
});

test('a press with the app closed (background task payload with dataString) is handled', async () => {
  // expo-notifications passes the raw Android bundle to the task: data arrives as a JSON string.
  const headless = { actionIdentifier: 'mark-read', notification: { date: 1000, request: { identifier: 'closed-card', trigger: null, content: { title: 'Payment due today', body: 'Rent is due today.', dataString: JSON.stringify(DATA) } } } };
  expect(parseReminderTap(headless)?.target).toEqual({ sourceType: 'planned_payment', sourceId: 'p1', occurrenceDate: '2026-11-17', offset: 0 });
  await handleReminderAction(headless, 5_000);
  expect((await latestReminderAck('planned_payment', 'p1'))?.method).toBe('read');
  expect(localNotificationApi.dismissNotificationAsync).toHaveBeenCalledWith('closed-card');
  expect(parseReminderTap({ ...headless, notification: { ...headless.notification, request: { ...headless.notification.request, content: { dataString: '{not json' } } } })).toBeNull();
});

test('tapping the payment receipt keeps "Marked as paid" as the last reminder response', async () => {
  await handleReminderAction(response('mark-read'), 5_000);
  const tap = response('expo.modules.notifications.actions.DEFAULT', 'x__receipt', 6_000);
  tap.notification.request.content.data = { ...DATA, receipt: true } as typeof DATA;
  await handleReminderAction(tap, 7_000);
  expect((await latestReminderAck('planned_payment', 'p1'))?.method).toBe('read');
});

test('a snoozed card alerts again with sound and vibration; a payment receipt stays quiet', async () => {
  await handleReminderAction(response('remind-later'), 10_000);
  const snooze = (localNotificationApi.scheduleNotificationAsync as jest.Mock).mock.calls.at(-1)![0];
  expect(snooze.content).toMatchObject({ sound: true, vibrate: [0, 250, 250, 250] });
  const harness = await reminderDatabase();
  try {
    setReminderDatabase(harness.db);
    await harness.db.runAsync('UPDATE accounts SET opening_balance_minor = 7000000 WHERE id = ?;', 'account_cash_default');
    const plan = await reminderPlan(harness.db, { amount_minor: 10000, next_due_date: '2026-11-17', recurrence_type: 'MONTHLY' });
    await handleReminderAction(paidResponse(plan), 20_000);
    expect(receipt()!.content).toMatchObject({ sound: false });
    expect(receipt()!.content.vibrate).toBeUndefined();
  } finally { setReminderDatabase(null); harness.close(); }
});

test('a reminder still showing, or already handled by a button, is not marked swiped', async () => {
  await syncReminderDeliveries([{ identifier: 'a', content: { data: { ...DATA } } }], [], 500);
  await syncReminderDeliveries([], [{ request: { identifier: 'a' } }], 2000);
  expect(await latestReminderAck('planned_payment', 'p1')).toBeNull();
  await handleReminderAction(response('mark-read', 'a'), 2500);
  await syncReminderDeliveries([], [], 3000);
  expect((await latestReminderAck('planned_payment', 'p1'))?.method).toBe('read');
});

const plan = (overrides: Partial<PlannedPayment> = {}) => ({ id: 'p1', status: 'ACTIVE', reminder_enabled: 1, next_due_date: '2026-11-17', deleted_at: null, ...overrides }) as PlannedPayment;
const sub = (overrides: Partial<Subscription> = {}) => ({ id: 's1', status: 'ACTIVE', reminder_enabled: 1, next_renewal_date: '2026-11-17', cancellation_reminder_enabled: 1, cancellation_reminder_date: '2026-11-20', deleted_at: null, ...overrides }) as Subscription;

test('a snooze survives only while its occurrence is still pending', () => {
  const planned = { reminderKind: 'PLANNED_DUE', sourceId: 'p1', occurrenceDate: '2026-11-17' };
  expect(snoozeStillValid(planned, [plan()], [], new Set())).toBe(true);
  expect(snoozeStillValid(planned, [plan()], [], new Set(['PLANNED:p1:2026-11-17']))).toBe(false); // paid
  expect(snoozeStillValid(planned, [plan({ next_due_date: '2026-12-17' })], [], new Set())).toBe(false); // skipped/advanced
  expect(snoozeStillValid(planned, [plan({ status: 'PAUSED' })], [], new Set())).toBe(false);
  expect(snoozeStillValid(planned, [plan({ reminder_enabled: 0 })], [], new Set())).toBe(false);
  expect(snoozeStillValid(planned, [], [], new Set())).toBe(false); // stopped tracking
  const renewal = { reminderKind: 'SUBSCRIPTION_RENEWAL', sourceId: 's1', occurrenceDate: '2026-11-17' };
  expect(snoozeStillValid(renewal, [], [sub()], new Set())).toBe(true);
  expect(snoozeStillValid(renewal, [], [sub({ status: 'CANCELLED' })], new Set())).toBe(false);
  expect(snoozeStillValid({ reminderKind: 'CANCELLATION', sourceId: 's1', occurrenceDate: '2026-11-20' }, [], [sub()], new Set())).toBe(true);
  expect(snoozeStillValid({ reminderKind: 'CANCELLATION', sourceId: 's1', occurrenceDate: '2026-11-20' }, [], [sub({ cancellation_reminder_enabled: 0 })], new Set())).toBe(false);
});

test('reconciliation keeps a valid snooze and cancels an invalid one', async () => {
  const native = reminderNative();
  const future = Date.now() + REMINDER_SNOOZE_MS;
  native.pending.push({ identifier: 'keep__snooze', content: { data: { managedBy: 'expense-tracker', snoozed: true, sourceId: 'p1', triggerTimestamp: future } } });
  native.pending.push({ identifier: 'drop__snooze', content: { data: { managedBy: 'expense-tracker', snoozed: true, sourceId: 'p2', triggerTimestamp: future } } });
  await reconcileReminders(true, [], native.boundary, data => data.sourceId === 'p1');
  expect(native.pending.map(item => item.identifier)).toEqual(['keep__snooze']);
});

test('desired reminders choose the matching button card', async () => {
  const harness = await reminderDatabase();
  try {
    const expense = await reminderPlan(harness.db, { reminder_enabled: 1, reminder_days_before: 0 });
    const income = await reminderPlan(harness.db, { name: 'Salary', type: 'INCOME', category_id: 'cat_income_salary', reminder_enabled: 1, reminder_days_before: 0 });
    const reminders = buildDesiredReminders([expense, income], [], new Date(2026, 9, 1, 8));
    expect(reminders.find(item => item.sourceId === expense.id)?.category).toBe('expense');
    expect(reminders.find(item => item.sourceId === income.id)?.category).toBe('income');
  } finally { harness.close(); }
});

test('reminder offset wording matches the Remind me picker', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- local import keeps this file's mocks unchanged.
  const { reminderOffsetLabel } = require('../services/planned/PlannedPaymentService') as typeof import('../services/planned/PlannedPaymentService');
  expect(reminderOffsetLabel(0)).toBe('On the due date');
  expect(reminderOffsetLabel(0, 'On the renewal date')).toBe('On the renewal date');
  expect(reminderOffsetLabel(1)).toBe('1 day before');
  expect(reminderOffsetLabel(3)).toBe('3 days before');
});

import type { NotificationPermissionsStatus } from 'expo-notifications/build/NotificationPermissions.types';
import { Platform } from 'react-native';
import type { AppDb } from '../../database/database';
import * as repo from '../../database/repositories/repositories';
import type { PlannedPayment, Subscription } from '../../types/models';
import { addDays, parseDateKey } from '../../utils/date';
import { isValidDateKey } from '../planned/PlannedPaymentService';
import { advanceRecurrence } from '../../utils/recurrence';
import { decodeScheduleProvenance } from '../planned/ScheduleProvenance';
import { localNotificationApi } from './LocalNotificationApi';
import { channelFailureDiagnostic, ChannelPreparationError } from './ChannelDiagnostics';
import { getReminderStatusSnapshot, notificationFailure, publishReminderStatus, type ReminderStatus, type ReminderPermission } from './ReminderStatus';
import { REMINDER_ACCENT_COLOR, REMINDER_CATEGORY_IDS, REMINDER_CHANNEL_ID, REMINDER_MANAGER, REMINDER_VIBRATION, type ReminderCategory } from './ReminderConstants';
import { ensureReminderAlertChannel, ensureReminderCategories, syncReminderDeliveries } from './ReminderActions';
export type { ReminderPermission } from './ReminderStatus';
export { REMINDER_MANAGER } from './ReminderConstants';

const MANAGER = REMINDER_MANAGER;
const CHANNEL_ID = REMINDER_CHANNEL_ID;
// Bump when scheduled content changes so existing pending reminders are replaced.
// 4: reminders alert (sound + vibration) on the new channel; pending ones are rescheduled once.
const REMINDER_CONTENT_VERSION = 4;
export const REMINDER_HORIZON_DAYS = 60;
export const MAX_MANAGED_REMINDERS = 48;
const MAX_NATIVE_PENDING = 60; // Reserve space below iOS's 64-request limit.

export type ReminderKind = 'PLANNED_DUE' | 'SUBSCRIPTION_RENEWAL' | 'CANCELLATION';

export type ManagedReminder = {
  key: string;
  kind: ReminderKind;
  sourceId: string;
  occurrenceDate: string;
  triggerAt: Date;
  title: string;
  body: string;
  offset?: number;
  /** Which three-button card the reminder uses (defaults to expense). */
  category?: ReminderCategory;
};

type ScheduledReminder = {
  identifier: string;
  content: { data?: Record<string, unknown> };
};

export type NotificationBoundary = {
  getPermission: () => Promise<ReminderPermission>;
  requestPermission: () => Promise<ReminderPermission>;
  inspectPermission?: () => Promise<ReminderStatus>;
  getScheduled: () => Promise<ScheduledReminder[]>;
  getPresented?: () => Promise<{ request: { identifier: string } }[]>;
  schedule: (reminder: ManagedReminder, signature: string) => Promise<string>;
  cancel: (identifier: string) => Promise<void>;
};

export type ReconciliationResult = {
  permission: ReminderPermission;
  desired: number;
  kept: number;
  scheduled: number;
  cancelled: number;
  failed: string[];
};

function permissionFromExpo(status: NotificationPermissionsStatus): ReminderPermission {
  if (
    status.granted ||
    status.ios?.status === localNotificationApi.IosAuthorizationStatus.AUTHORIZED ||
    status.ios?.status === localNotificationApi.IosAuthorizationStatus.PROVISIONAL ||
    status.ios?.status === localNotificationApi.IosAuthorizationStatus.EPHEMERAL
  ) return 'granted';
  if (status.status === 'denied' || status.ios?.status === localNotificationApi.IosAuthorizationStatus.DENIED)
    return 'denied';
  return 'undetermined';
}

async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  // Android <26 has no channel API; modern/unknown Android must verify readiness.
  if (typeof Platform.Version === 'number' && Platform.Version < 26) return;
  let operation: 'setNotificationChannelAsync' | 'getNotificationChannelAsync' | 'verifyChannel' = 'setNotificationChannelAsync';
  try {
    // Default notification sound (no sound key) plus vibration; no custom audio, colours or groups.
    await ensureReminderAlertChannel();
    operation = 'getNotificationChannelAsync';
    const channel = await localNotificationApi.getNotificationChannelAsync(CHANNEL_ID);
    operation = 'verifyChannel';
    if (channel?.importance === localNotificationApi.AndroidImportance.NONE) {
      const blocked = new Error('The financial reminder channel is blocked in device Settings.') as Error & { code: string };
      blocked.code = 'CHANNEL_BLOCKED'; throw blocked;
    }
    if (!channel || channel.id !== CHANNEL_ID || ![localNotificationApi.AndroidImportance.MIN, localNotificationApi.AndroidImportance.LOW, localNotificationApi.AndroidImportance.DEFAULT, localNotificationApi.AndroidImportance.HIGH, localNotificationApi.AndroidImportance.MAX].includes(channel.importance)) {
      const missing = new Error('Channel read-back is missing or its importance is not usable.') as Error & { code: string };
      missing.code = 'CHANNEL_NOT_READY'; throw missing;
    }
  } catch (cause) {
    const failure = notificationFailure('channel', cause);
    const diagnostic = channelFailureDiagnostic(cause, operation);
    if (diagnostic) console.warn('[Local reminders: channel diagnostic]', JSON.stringify(diagnostic));
    throw new ChannelPreparationError(cause, failure!.stage === 'native-module' ? 'native-module' : 'channel', failure!.code, diagnostic);
  }
}

export async function inspectReminderPermission(): Promise<ReminderStatus> {
  try {
    const value = await localNotificationApi.getPermissionsAsync();
    const next: ReminderStatus = { permission: permissionFromExpo(value), canAskAgain: value.canAskAgain === true, scheduling: 'unknown' };
    if (Platform.OS === 'android' && next.permission === 'granted') {
      try {
        const channel = await localNotificationApi.getNotificationChannelAsync(CHANNEL_ID);
        if (channel?.importance === localNotificationApi.AndroidImportance.NONE) { next.error = { stage: 'channel', code: 'CHANNEL_BLOCKED' }; next.scheduling = 'failed'; }
      } catch (error) { next.error = notificationFailure('channel', error); next.scheduling = 'failed'; }
    }
    publishReminderStatus(next); return next;
  } catch (error) {
    const next: ReminderStatus = { permission: 'unavailable', canAskAgain: false, scheduling: 'unknown', error: notificationFailure('permission-query', error) };
    publishReminderStatus(next); return next;
  }
}
let permissionRequest: Promise<ReminderPermission> | null = null;
async function requestReminderPermission(): Promise<ReminderPermission> {
  try { await ensureAndroidChannel(); }
  catch (error) {
    publishReminderStatus({ ...getReminderStatusSnapshot(), scheduling: 'failed', error: notificationFailure('channel', error) });
    return 'unavailable';
  }
  const current = await inspectReminderPermission();
  if (current.error) return 'unavailable';
  if (current.permission === 'granted' || current.permission === 'unavailable' || !current.canAskAgain) return current.permission;
  try {
    const value = await localNotificationApi.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: false, allowSound: false } });
    const next: ReminderStatus = { permission: permissionFromExpo(value), canAskAgain: value.canAskAgain === true, scheduling: 'unknown' };
    publishReminderStatus(next); return next.permission;
  } catch (error) {
    publishReminderStatus({ ...current, error: notificationFailure('permission-request', error) });
    return 'unavailable';
  }
}

export const expoNotificationBoundary: NotificationBoundary = {
  inspectPermission: inspectReminderPermission,
  async getPermission() {
    return (await inspectReminderPermission()).permission;
  },
  requestPermission() {
    if (!permissionRequest) permissionRequest = requestReminderPermission().finally(() => { permissionRequest = null; });
    return permissionRequest;
  },
  async getScheduled() {
    return localNotificationApi.getAllScheduledNotificationsAsync();
  },
  async getPresented() {
    return localNotificationApi.getPresentedNotificationsAsync();
  },
  async schedule(reminder, signature) {
    await ensureAndroidChannel();
    if (reminder.triggerAt.getTime() <= Date.now()) throw new Error('The reminder time has already passed. It will not be delivered late.');
    const category = reminder.category ?? 'expense';
    // Buttons are optional: a category failure still delivers the plain reminder.
    const buttons = await ensureReminderCategories().then(() => true, () => false);
    return localNotificationApi.scheduleNotificationAsync({
      identifier: reminder.key,
      content: {
        title: reminder.title,
        body: reminder.body,
        sound: true,
        vibrate: REMINDER_VIBRATION,
        ...(buttons ? { categoryIdentifier: REMINDER_CATEGORY_IDS[category] } : {}),
        ...(Platform.OS === 'android' ? { color: REMINDER_ACCENT_COLOR } : {}),
        data: {
          category,
          managedBy: MANAGER,
          reminderKey: reminder.key,
          scheduleSignature: signature,
          reminderKind: reminder.kind,
          sourceId: reminder.sourceId,
          occurrenceDate: reminder.occurrenceDate,
          version: 2,
          sourceType: reminder.kind === 'PLANNED_DUE' ? 'planned_payment' : 'subscription',
          reminderOffset: reminder.offset ?? 0,
          triggerTimestamp: reminder.triggerAt.getTime(),
        },
      },
      trigger: {
        type: localNotificationApi.SchedulableTriggerInputTypes.DATE,
        date: reminder.triggerAt,
        channelId: Platform.OS === 'android' ? CHANNEL_ID : undefined,
      },
    });
  },
  cancel(identifier) {
    return localNotificationApi.cancelScheduledNotificationAsync(identifier);
  },
};

let appReminderPresentationEnabled = false;

export function configureNotificationPresentation(): void {
  try {
    localNotificationApi.setNotificationHandler({
      handleNotification: async (notification) => {
        const appManaged = notification.request.content.data?.managedBy === MANAGER;
        // Mark as paid receipts always show: they confirm a money movement the user just made.
        const show = !appManaged || notification.request.content.data?.receipt === true || (appReminderPresentationEnabled && getReminderStatusSnapshot().permission === 'granted');
        return {
          shouldShowBanner: show,
          shouldShowList: show,
          // Reminders alert even while the app is open; receipts confirm a tap and stay quiet.
          shouldPlaySound: show && appManaged && notification.request.content.data?.receipt !== true,
          shouldSetBadge: false,
        };
      },
    });
  } catch (error) {
    publishReminderStatus({ ...getReminderStatusSnapshot(), error: notificationFailure('presentation', error) });
    // Local reminders are optional; unsupported runtimes keep all financial features.
  }
}

function reminderDate(dateKey: string, daysBefore: number): Date | null {
  if (!isValidDateKey(dateKey) || !Number.isSafeInteger(daysBefore) || daysBefore < 0)
    return null;
  const date = parseDateKey(addDays(dateKey, -daysBefore));
  date.setHours(9, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function key(kind: ReminderKind, sourceId: string, occurrenceDate: string, offset: number): string {
  return `expense_tracker_v2_${kind.toLowerCase()}_${encodeURIComponent(sourceId)}_${occurrenceDate}_${offset}`;
}

function reminderCopy(name: string, kind: 'expense' | 'income' | 'subscription', offset: number) {
  const when = offset === 0 ? 'today' : offset === 1 ? 'tomorrow' : `in ${offset} days`;
  if (kind === 'income') return { title: offset === 1 ? 'Expected income tomorrow' : 'Expected income reminder', body: `${name} is expected ${when}.` };
  if (kind === 'subscription') return { title: offset === 0 ? 'Subscription renews today' : offset === 1 ? 'Subscription renews tomorrow' : offset === 2 ? 'Upcoming subscription renewal' : 'Subscription renewal coming up', body: `${name} renews ${when}.` };
  return { title: offset === 0 ? 'Payment due today' : offset === 1 ? 'Payment due tomorrow' : offset === 2 ? 'Upcoming payment' : 'Payment coming up', body: `${name} is due ${when}.` };
}

export function buildDesiredReminders(
  plannedPayments: PlannedPayment[],
  subscriptions: Subscription[],
  now = new Date(),
  consumedOccurrences = new Set<string>(),
): ManagedReminder[] {
  const desired: ManagedReminder[] = [];
  const horizon = parseDateKey(addDays(nowDateKey(now), REMINDER_HORIZON_DAYS));
  horizon.setHours(23, 59, 59, 999);
  const append = (kind: ReminderKind, id: string, name: string, income: boolean, date: string, offset: number) => {
    const triggerAt = reminderDate(date, offset);
    if (!triggerAt || triggerAt <= now || triggerAt > horizon || consumedOccurrences.has(`${kind === 'PLANNED_DUE' ? 'PLANNED' : 'SUBSCRIPTION'}:${id}:${date}`)) return;
    desired.push({ key: key(kind, id, date, offset), kind, sourceId: id, occurrenceDate: date, offset, triggerAt, category: income ? 'income' : 'expense', ...reminderCopy(name, kind === 'PLANNED_DUE' ? income ? 'income' : 'expense' : 'subscription', offset) });
  };
  const dates = (source: PlannedPayment | Subscription): string[] => {
    const planned = 'next_due_date' in source;
    const recurrence = planned ? source.recurrence_type : source.frequency_type;
    const interval = planned ? source.recurrence_interval : source.frequency_interval;
    let date = planned ? source.next_due_date : source.next_renewal_date;
    const offset = source.reminder_days_before;
    const limit = planned ? source.occurrence_limit : source.total_cycles;
    const completed = planned ? source.completed_occurrences : source.completed_cycles;
    const result: string[] = [];
    let anchor: number | undefined;
    try { anchor = source.schedule_provenance ? decodeScheduleProvenance(source.schedule_provenance).anchorDay : planned ? undefined : source.recurrence_anchor_day ?? Number(source.start_date.slice(8)); }
    catch { return result; }
    // Bounded projection only; never advance the persisted next date or claim
    // payments. Very old unresolved schedules require review rather than loops.
    for (let index = 0; index < 3660 && isValidDateKey(date); index++) {
      if (source.end_date && date > source.end_date || limit != null && completed + index >= limit) break;
      const trigger = reminderDate(date, offset);
      if (!trigger || trigger > horizon) break;
      if (trigger > now) result.push(date);
      try { const next = advanceRecurrence(date, recurrence, interval, anchor); if (!next || next <= date) break; date = next; }
      catch { break; }
    }
    return result;
  };
  for (const planned of plannedPayments) {
    if (planned.deleted_at || planned.status !== 'ACTIVE' || !planned.reminder_enabled) continue;
    for (const date of dates(planned)) append('PLANNED_DUE', planned.id, planned.name, planned.type === 'INCOME', date, planned.reminder_days_before);
  }
  for (const subscription of subscriptions) {
    const active = !subscription.deleted_at && subscription.status === 'ACTIVE';
    const ended = subscription.status === 'ENDED' ||
      !!(subscription.end_date && subscription.next_renewal_date > subscription.end_date) ||
      (subscription.total_cycles != null && subscription.completed_cycles >= subscription.total_cycles);
    if (active && !ended && subscription.reminder_enabled) for (const date of dates(subscription)) append('SUBSCRIPTION_RENEWAL', subscription.id, subscription.name, false, date, subscription.reminder_days_before);
    const cancellationDate = subscription.cancellation_reminder_date;
    const cancellationAt = cancellationDate ? reminderDate(cancellationDate, 0) : null;
    if (active && !ended && subscription.cancellation_reminder_enabled && cancellationDate && cancellationAt && cancellationAt > now && cancellationAt <= horizon) {
      desired.push({
        key: key('CANCELLATION', subscription.id, cancellationDate, 0),
        kind: 'CANCELLATION',
        sourceId: subscription.id,
        occurrenceDate: cancellationDate,
        triggerAt: cancellationAt,
        offset: 0,
        category: 'review',
        title: 'Trial/cancellation reminder',
        body: `Review the saved cancellation date for ${subscription.name}.`,
      });
    }
  }
  return desired.sort((a, b) => a.triggerAt.getTime() - b.triggerAt.getTime() || a.key.localeCompare(b.key)).slice(0, MAX_MANAGED_REMINDERS);
}

function nowDateKey(now: Date) { return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; }

function signature(reminder: ManagedReminder): string {
  return JSON.stringify([reminder.key, reminder.triggerAt.getTime(), reminder.title, reminder.body, reminder.category ?? 'expense', REMINDER_CONTENT_VERSION]);
}

function managedData(item: ScheduledReminder): Record<string, unknown> | null {
  const data = item.content.data;
  return data?.managedBy === MANAGER ? data : null;
}

async function performReconciliation(
  enabled: boolean,
  desired: ManagedReminder[],
  boundary: NotificationBoundary = expoNotificationBoundary,
  keepSnoozed: (data: Record<string, unknown>) => boolean = () => false,
): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    permission: 'unavailable', desired: enabled ? desired.length : 0,
    kept: 0, scheduled: 0, cancelled: 0, failed: [],
  };
  let scheduled: ScheduledReminder[];
  try {
    result.permission = await boundary.getPermission();
    if (boundary !== expoNotificationBoundary) publishReminderStatus({ permission: result.permission, canAskAgain: result.permission === 'undetermined', scheduling: 'unknown' });
    appReminderPresentationEnabled = enabled && result.permission === 'granted';
    if (enabled && result.permission === 'unavailable') { result.failed.push('permission-status'); return result; }
    scheduled = await boundary.getScheduled();
    if (!Array.isArray(scheduled)) throw new Error('Invalid native pending-notification response');
  } catch (error) {
    publishReminderStatus({ ...getReminderStatusSnapshot(), scheduling: 'failed', error: notificationFailure('enumerate', error) });
    appReminderPresentationEnabled = false;
    result.failed.push('notification-support');
    return result;
  }
  // Still-valid "Snooze" reminders are kept as they are; a snooze for a paid,
  // skipped, paused or disabled occurrence is cancelled.
  const keptSnoozes = new Set(scheduled.filter(item => { const data = managedData(item); return enabled && result.permission === 'granted' && data?.snoozed === true && keepSnoozed(data) && typeof data.triggerTimestamp === 'number' && data.triggerTimestamp > Date.now(); }).map(item => item.identifier));
  const capacity = Math.max(0, Math.min(MAX_MANAGED_REMINDERS - keptSnoozes.size, MAX_NATIVE_PENDING - scheduled.filter(item => !managedData(item)).length - keptSnoozes.size));
  const wanted = enabled && result.permission === 'granted'
    ? new Map(desired.filter(item => item.triggerAt.getTime() > Date.now()).slice(0, capacity).map((item) => [item.key, item]))
    : new Map<string, ManagedReminder>();
  const kept = new Set<string>();
  let staleCancellationFailed = false;
  for (const existing of scheduled) {
    const data = managedData(existing);
    if (!data) continue;
    if (keptSnoozes.has(existing.identifier)) { result.kept++; continue; }
    const reminderKey = typeof data.reminderKey === 'string' ? data.reminderKey : '';
    const wantedReminder = wanted.get(reminderKey);
    const canKeep = !!wantedReminder && !kept.has(reminderKey) &&
      data.scheduleSignature === signature(wantedReminder);
    if (canKeep) {
      kept.add(reminderKey);
      result.kept += 1;
      continue;
    }
    try {
      await boundary.cancel(existing.identifier);
      result.cancelled += 1;
    } catch (error) {
      publishReminderStatus({ ...getReminderStatusSnapshot(), scheduling: 'failed', error: notificationFailure('cancel', error) });
      result.failed.push(`cancel:${existing.identifier}`);
      staleCancellationFailed = true;
    }
  }
  for (const reminder of wanted.values()) {
    if (kept.has(reminder.key) || staleCancellationFailed) continue;
    try {
      await boundary.schedule(reminder, signature(reminder));
      result.scheduled += 1;
    } catch (error) {
      publishReminderStatus({ ...getReminderStatusSnapshot(), scheduling: 'failed', error: notificationFailure('schedule', error) });
      result.failed.push(`schedule:${reminder.key}`);
    }
  }
  if (boundary === expoNotificationBoundary && !result.failed.length && result.permission === 'granted' && getReminderStatusSnapshot().error?.code !== 'CHANNEL_BLOCKED') publishReminderStatus({ ...getReminderStatusSnapshot(), scheduling: 'available', error: undefined });
  return result;
}

let nativeTail: Promise<unknown> = Promise.resolve();
export function reconcileReminders(enabled: boolean, desired: ManagedReminder[], boundary: NotificationBoundary = expoNotificationBoundary, keepSnoozed?: (data: Record<string, unknown>) => boolean): Promise<ReconciliationResult> {
  const next = nativeTail.then(() => performReconciliation(enabled, desired, boundary, keepSnoozed));
  nativeTail = next.catch(() => undefined); return next;
}

async function consumedOccurrenceKeys(db: AppDb): Promise<Set<string>> {
  const [planned, subscriptions] = await Promise.all([
    db.getAllAsync<{ planned_payment_id: string; scheduled_date: string }>(
      'SELECT planned_payment_id, scheduled_date FROM planned_payment_occurrences;',
    ),
    db.getAllAsync<{ subscription_id: string; scheduled_date: string }>(
      'SELECT subscription_id, scheduled_date FROM subscription_payments;',
    ),
  ]);
  return new Set([
    ...planned.map((item) => `PLANNED:${item.planned_payment_id}:${item.scheduled_date}`),
    ...subscriptions.map((item) => `SUBSCRIPTION:${item.subscription_id}:${item.scheduled_date}`),
  ]);
}

export async function reconcileAppReminders(
  db: AppDb,
  boundary: NotificationBoundary = expoNotificationBoundary,
  now = new Date(),
): Promise<ReconciliationResult> {
  try {
    const [settings, planned, subscriptions, consumed] = await Promise.all([
      repo.getSettings(db),
      repo.listPlannedPayments(db),
      repo.listSubscriptions(db),
      consumedOccurrenceKeys(db),
    ]);
    const result = await reconcileReminders(
      settings.notifications_enabled === 'true',
      buildDesiredReminders(planned, subscriptions, now, consumed),
      boundary,
      data => snoozeStillValid(data, planned, subscriptions, consumed),
    );
    if (boundary.getPresented && result.permission === 'granted') {
      try { await syncReminderDeliveries(await boundary.getScheduled(), await boundary.getPresented(), now.getTime()); }
      catch (error) { notificationFailure('response', error); }
    }
    return result;
  } catch (error) {
    publishReminderStatus({ ...getReminderStatusSnapshot(), error: notificationFailure('data', error) });
    return {
      permission: 'unavailable', desired: 0, kept: 0, scheduled: 0,
      cancelled: 0, failed: ['reconciliation'],
    };
  }
}

/** A snoozed reminder stays only while its exact occurrence is still pending. */
export function snoozeStillValid(data: Record<string, unknown>, planned: PlannedPayment[], subscriptions: Subscription[], consumed: Set<string>): boolean {
  const { reminderKind: kind, sourceId: id, occurrenceDate: date } = data;
  if (typeof id !== 'string' || typeof date !== 'string' || !isValidDateKey(date)) return false;
  if (kind === 'PLANNED_DUE') {
    const plan = planned.find(item => item.id === id);
    return !!plan && !plan.deleted_at && plan.status === 'ACTIVE' && !!plan.reminder_enabled && date >= plan.next_due_date && !consumed.has(`PLANNED:${id}:${date}`);
  }
  const sub = subscriptions.find(item => item.id === id);
  if (!sub || sub.deleted_at || sub.status !== 'ACTIVE') return false;
  if (kind === 'CANCELLATION') return !!sub.cancellation_reminder_enabled && sub.cancellation_reminder_date === date;
  return kind === 'SUBSCRIPTION_RENEWAL' && !!sub.reminder_enabled && date >= sub.next_renewal_date && !consumed.has(`SUBSCRIPTION:${id}:${date}`);
}

let reconciliationTail: Promise<unknown> = Promise.resolve();

export function queueAppReminderReconciliation(
  db: AppDb,
  boundary: NotificationBoundary = expoNotificationBoundary,
  now?: Date,
): Promise<ReconciliationResult> {
  const next = reconciliationTail.then(() => reconcileAppReminders(db, boundary, now ?? new Date()));
  reconciliationTail = next.catch(() => undefined);
  return next;
}

async function performEnable(
  db: AppDb,
  boundary: NotificationBoundary = expoNotificationBoundary,
): Promise<{ permission: ReminderPermission; status?: ReminderStatus; reconciliation?: ReconciliationResult }> {
  await repo.setSetting(db, 'notifications_intro_answered', 'true');
  const previous = await repo.getSettings(db);
  const permission = await boundary.requestPermission();
  if (permission !== 'granted') {
    await repo.setSetting(db, 'notifications_enabled', previous.notifications_enabled === 'true' ? 'true' : 'false');
    // Keep the request/channel diagnostic instead of overwriting it with an
    // unrelated subsequent permission query when the request failed.
    if (permission !== 'unavailable') await queueAppReminderReconciliation(db, boundary);
    return { permission, status: getReminderStatusSnapshot() };
  }
  await repo.setSetting(db, 'notifications_enabled', 'true');
  return { permission, reconciliation: await queueAppReminderReconciliation(db, boundary) };
}

async function performDisable(
  db: AppDb,
  boundary: NotificationBoundary = expoNotificationBoundary,
): Promise<ReconciliationResult> {
  appReminderPresentationEnabled = false;
  await repo.setSetting(db, 'notifications_intro_answered', 'true');
  await repo.setSetting(db, 'notifications_enabled', 'false');
  return queueAppReminderReconciliation(db, boundary);
}

let preferenceTail: Promise<unknown> = Promise.resolve();
export function enableLocalReminders(db: AppDb, boundary: NotificationBoundary = expoNotificationBoundary) {
  const next = preferenceTail.then(() => performEnable(db, boundary)); preferenceTail = next.catch(() => undefined); return next;
}
export function disableLocalReminders(db: AppDb, boundary: NotificationBoundary = expoNotificationBoundary) {
  const next = preferenceTail.then(() => performDisable(db, boundary)); preferenceTail = next.catch(() => undefined); return next;
}

/** A contextual form check uses the same native inspection and reconciliation,
 * not a saved On flag as proof of permission or an independent scheduler. */
export async function readReminderDelivery(db: AppDb) {
  const settings = await repo.getSettings(db);
  const enabled = settings.notifications_enabled === 'true';
  const status = await inspectReminderPermission();
  if (enabled && status.permission === 'granted' && !status.error) await queueAppReminderReconciliation(db);
  return { enabled, status: getReminderStatusSnapshot() };
}

export type BudgetThresholdMilestone = 'WARNING' | 'REACHED';

export function budgetThresholdCrossings(
  previousSpent: number,
  currentSpent: number,
  budgetAmount: number,
  warningPercent: number,
  claimed: ReadonlySet<BudgetThresholdMilestone> = new Set(),
): BudgetThresholdMilestone[] {
  if (budgetAmount <= 0 || currentSpent <= previousSpent) return [];
  const warningAmount = Math.ceil((budgetAmount * warningPercent) / 100);
  const crossed = (amount: number) => previousSpent < amount && currentSpent >= amount;
  return [
    ...(!claimed.has('WARNING') && crossed(warningAmount) ? ['WARNING' as const] : []),
    ...(!claimed.has('REACHED') && crossed(budgetAmount) ? ['REACHED' as const] : []),
  ];
}

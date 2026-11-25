import { Platform } from 'react-native';
import { localNotificationApi } from './LocalNotificationApi';
import {
  REMINDER_ACCENT_COLOR, REMINDER_CATEGORY_BUTTONS, REMINDER_CATEGORY_IDS, REMINDER_CHANNEL_ID,
  LEGACY_REMINDER_CHANNEL_IDS, REMINDER_MANAGER, REMINDER_SNOOZE_MS, REMINDER_VIBRATION, type ReminderCategory,
} from './ReminderConstants';
import { parseReminderTap, type ReminderTap } from './ReminderNavigation';
import { recordPaymentFromReminder, type ReminderPaymentResult } from './ReminderPayment';
import type { AppDb } from '../../database/database';

/**
 * Reminder acknowledgement, snooze and "Mark as paid" handling. Got it, Snooze
 * and swipe never touch financial data. Mark as paid is the one action that
 * records money, through the same atomic path as the in-app Record button
 * (ReminderPayment). Reminder state itself lives in the separate expo-sqlite
 * key-value file, never in the finance database.
 */
export type ReminderAckMethod = 'read' | 'dismissed' | 'snoozed' | 'opened' | 'paid' | 'paid_failed';
export type ReminderAck = { method: ReminderAckMethod; at: number; occurrenceDate: string };
type Delivery = { occurrence: string; occurrenceDate: string; triggerAt: number };

export type ReminderStateStore = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  removeItemAsync(key: string): Promise<boolean>;
  getAllKeysAsync(): Promise<string[]>;
};
let stateStore: ReminderStateStore | null = null;
function store(): ReminderStateStore {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Lazy native load keeps unsupported runtimes and tests isolated.
  if (!stateStore) stateStore = require('expo-sqlite/kv-store').default as ReminderStateStore;
  return stateStore;
}
export function setReminderStateStoreForTests(value: ReminderStateStore | null) { stateStore = value; }

const ACK = 'reminder.ack.v1.';
const DELIVERY = 'reminder.delivery.v1.';
const HANDLED = 'reminder.handled.v1.';
const MAX_TRACKED = 200;

export function reminderOccurrenceKey(sourceType: string, sourceId: string, occurrenceDate: string) {
  return `${sourceType}:${encodeURIComponent(sourceId)}:${occurrenceDate}`;
}
function sourceTypeForKind(kind: unknown) { return kind === 'PLANNED_DUE' ? 'planned_payment' : 'subscription'; }

function parse<T>(value: string | null): T | null {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

const ackListeners = new Set<() => void>();
/** Lets an open detail screen update its "Last reminder" line as soon as a response is recorded. */
export function subscribeReminderAcks(listener: () => void): () => void {
  ackListeners.add(listener);
  return () => { ackListeners.delete(listener); };
}

export async function recordReminderAck(occurrence: string, occurrenceDate: string, method: ReminderAckMethod, at = Date.now()) {
  await store().setItemAsync(ACK + occurrence, JSON.stringify({ method, at, occurrenceDate } satisfies ReminderAck));
  for (const listener of [...ackListeners]) { try { listener(); } catch { /* A screen listener never blocks recording. */ } }
}

type ScheduledSnooze = { identifier: string; content: { data?: Record<string, unknown> } };
function snoozeOccurrence(item: ScheduledSnooze): { occurrence: string; createdAt: number } | null {
  const data = item.content.data;
  if (data?.managedBy !== REMINDER_MANAGER || data.snoozed !== true || typeof data.sourceId !== 'string' || typeof data.occurrenceDate !== 'string' || typeof data.triggerTimestamp !== 'number') return null;
  return { occurrence: reminderOccurrenceKey(sourceTypeForKind(data.reminderKind), data.sourceId, data.occurrenceDate), createdAt: data.triggerTimestamp - REMINDER_SNOOZE_MS };
}

/**
 * Acknowledging an occurrence (Got it, opening the card, or swiping it away)
 * ends it: a Snooze set earlier for the same occurrence is cancelled, so the
 * card does not come back. Only snoozes created before `before` are cancelled.
 */
async function cancelSnoozesFor(occurrence: string, before: number, scheduled?: ScheduledSnooze[]) {
  const items = scheduled ?? await localNotificationApi.getAllScheduledNotificationsAsync() as unknown as ScheduledSnooze[];
  for (const item of items) {
    const snooze = snoozeOccurrence(item);
    if (!snooze || snooze.occurrence !== occurrence || snooze.createdAt >= before) continue;
    await localNotificationApi.cancelScheduledNotificationAsync(item.identifier);
    await store().removeItemAsync(DELIVERY + item.identifier);
  }
}

/** Latest acknowledgement for any occurrence of one planned payment/subscription. */
export async function latestReminderAck(sourceType: 'planned_payment' | 'subscription', sourceId: string): Promise<ReminderAck | null> {
  const prefix = `${ACK}${sourceType}:${encodeURIComponent(sourceId)}:`;
  const keys = (await store().getAllKeysAsync()).filter(key => key.startsWith(prefix));
  let latest: ReminderAck | null = null;
  for (const key of keys) {
    const ack = parse<ReminderAck>(await store().getItemAsync(key));
    if (ack && typeof ack.at === 'number' && (!latest || ack.at > latest.at)) latest = ack;
  }
  return latest;
}

export function reminderAckLabel(method: ReminderAckMethod): string {
  return {
    read: 'Got it',
    dismissed: 'Swiped away',
    snoozed: 'Snoozed for 3 hours',
    opened: 'Opened',
    paid: 'Marked as paid',
    paid_failed: 'Mark as paid not recorded',
  }[method];
}

/** One definition of the alerting reminder channel, shared by the scheduler and the headless task. */
export function reminderChannelInput() {
  return { name: 'Financial reminders', importance: localNotificationApi.AndroidImportance.DEFAULT, enableVibrate: true, vibrationPattern: REMINDER_VIBRATION };
}
let legacyChannelsRemoved = false;
/** Creates (idempotently) the alerting channel and, once per run, removes the old silent one. */
export async function ensureReminderAlertChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await localNotificationApi.setNotificationChannelAsync(REMINDER_CHANNEL_ID, reminderChannelInput());
  if (legacyChannelsRemoved) return;
  legacyChannelsRemoved = true;
  // Best effort: a missing old channel (or API) never blocks reminders.
  for (const legacy of LEGACY_REMINDER_CHANNEL_IDS) await Promise.resolve().then(() => localNotificationApi.deleteNotificationChannelAsync(legacy)).catch(() => {});
}

let categoriesReady: Promise<void> | null = null;
/** Registers the three-button cards once per runtime; failures only drop buttons. */
export function ensureReminderCategories(): Promise<void> {
  if (!categoriesReady) {
    categoriesReady = Promise.all((Object.keys(REMINDER_CATEGORY_IDS) as ReminderCategory[]).map(category =>
      localNotificationApi.setNotificationCategoryAsync(REMINDER_CATEGORY_IDS[category], REMINDER_CATEGORY_BUTTONS[category].map(button => ({
        identifier: button.identifier,
        buttonTitle: button.buttonTitle,
        options: { opensAppToForeground: button.opensApp },
      }))),
    )).then(() => undefined).catch(error => { categoriesReady = null; throw error; });
  }
  return categoriesReady;
}

function snoozeIdentifier(identifier: string) {
  const base = identifier.endsWith('__snooze') ? identifier.slice(0, -'__snooze'.length) : identifier;
  return `${base}__snooze`;
}

async function scheduleSnooze(tap: ReminderTap, now: number) {
  const data = tap.content.data;
  const category = typeof data.category === 'string' && data.category in REMINDER_CATEGORY_IDS ? data.category as ReminderCategory : 'expense';
  const triggerAt = now + REMINDER_SNOOZE_MS;
  try { await ensureReminderCategories(); } catch { /* Snooze still delivers without buttons. */ }
  // A headless start may run before the app has prepared the channel since an update.
  try { await ensureReminderAlertChannel(); } catch { /* The channel normally exists already. */ }
  // Same identifier every time: snoozing twice (or from two runtimes) replaces, never duplicates.
  const identifier = snoozeIdentifier(tap.identifier);
  const snoozeData = { ...data, managedBy: REMINDER_MANAGER, snoozed: true, snoozeOf: data.reminderKey, triggerTimestamp: triggerAt };
  await localNotificationApi.scheduleNotificationAsync({
    identifier,
    content: {
      // The snoozed card is the same reminder coming back, so it alerts again.
      title: tap.content.title, body: tap.content.body, sound: true, vibrate: REMINDER_VIBRATION,
      categoryIdentifier: REMINDER_CATEGORY_IDS[category],
      ...(Platform.OS === 'android' ? { color: REMINDER_ACCENT_COLOR } : {}),
      data: snoozeData,
    },
    trigger: {
      type: localNotificationApi.SchedulableTriggerInputTypes.DATE,
      date: new Date(triggerAt),
      channelId: Platform.OS === 'android' ? REMINDER_CHANNEL_ID : undefined,
    },
  });
  // Best effort: tracking only feeds the "Swiped away" label, never delivery.
  try { await trackReminderDelivery(identifier, snoozeData); } catch { /* Snooze is already scheduled. */ }
}

// The live app shares its finance connection; a headless start opens its own.
let sharedDb: AppDb | null = null;
let ownDb: Promise<AppDb> | null = null;
export function setReminderDatabase(db: AppDb | null) { sharedDb = db; }
async function reminderDatabase(): Promise<AppDb> {
  if (sharedDb) return sharedDb;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Lazy: only a headless Mark as paid needs the finance database.
  if (!ownDb) ownDb = (require('../../database/database') as typeof import('../../database/database')).openSharedAppDatabase().catch(error => { ownDb = null; throw error; });
  return ownDb;
}

/** Immediate themed receipt for Mark as paid; tapping it opens that record. */
async function postPaymentReceipt(tap: ReminderTap, result: ReminderPaymentResult) {
  try { await ensureReminderAlertChannel(); } catch { /* The channel normally exists already. */ }
  await localNotificationApi.scheduleNotificationAsync({
    identifier: `${tap.identifier.replace(/__(snooze|receipt)$/, '')}__receipt`,
    content: {
      title: result.title, body: result.body, sound: false,
      ...(Platform.OS === 'android' ? { color: REMINDER_ACCENT_COLOR } : {}),
      data: { ...tap.content.data, managedBy: REMINDER_MANAGER, receipt: true, snoozed: false, diagnostic: false },
    },
    trigger: Platform.OS === 'android' ? { channelId: REMINDER_CHANNEL_ID } : null,
  });
}

const inFlight = new Set<string>();
let afterPayment: (() => void) | null = null;
/** The live app refreshes its screens after a payment recorded from a card. */
export function setReminderPaymentListener(listener: (() => void) | null) { afterPayment = listener; }

/**
 * Handles one notification response from the foreground listener or the
 * headless task. Every branch is idempotent because Android can deliver the
 * same button press to both when the app is alive in the background; the
 * finance database additionally rejects a second record of one occurrence.
 */
export async function handleReminderAction(response: unknown, now = Date.now()): Promise<ReminderTap | null> {
  const tap = parseReminderTap(response);
  if (!tap) return null;
  // A receipt only reports what happened; tapping it navigates (ReminderNavigation) but must not
  // replace "Marked as paid" with "Opened" or touch any other reminder state.
  if (tap.content.data.receipt === true) return tap;
  // One press = one effect, even when replayed (cold-start last response) or
  // delivered to both the headless task and the live listener.
  const handledKey = HANDLED + tap.key;
  if (inFlight.has(handledKey)) return tap;
  inFlight.add(handledKey);
  try {
    if (await store().getItemAsync(handledKey)) return tap;
    await store().setItemAsync(handledKey, String(now));
    const occurrence = reminderOccurrenceKey(tap.target.sourceType, tap.target.sourceId, tap.target.occurrenceDate);
    let ack = { read: 'read', later: 'snoozed', paid: 'paid', open: 'opened', review: 'opened' }[tap.action] as ReminderAckMethod;
    if (tap.action === 'later') await scheduleSnooze(tap, now);
    if (tap.action === 'paid') {
      const db = await reminderDatabase();
      const result = await recordPaymentFromReminder(db, tap.target).catch((): ReminderPaymentResult => ({ ok: false, title: 'Not recorded', body: 'The payment could not be recorded. Open the app to try again.' }));
      if (!result.ok) ack = 'paid_failed';
      await localNotificationApi.dismissNotificationAsync(tap.identifier).catch(() => {});
      await postPaymentReceipt(tap, result).catch(() => {});
      if (result.ok) {
        // Cancel this occurrence's other reminders/snoozes and schedule the next one.
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- Lazy to avoid a module cycle with NotificationService.
        const { queueAppReminderReconciliation } = require('./NotificationService') as typeof import('./NotificationService');
        await queueAppReminderReconciliation(db).catch(() => undefined);
        afterPayment?.();
      }
    }
    await recordReminderAck(occurrence, tap.target.occurrenceDate, ack, now);
    await store().removeItemAsync(DELIVERY + tap.identifier);
    // Got it / opening the card acknowledges the occurrence: an earlier Snooze must not bring it back.
    if (ack === 'read' || ack === 'opened') await cancelSnoozesFor(occurrence, now).catch(() => {});
    // Body taps auto-dismiss; button presses must clear the card explicitly.
    if (tap.action !== 'open') await localNotificationApi.dismissNotificationAsync(tap.identifier).catch(() => {});
    return tap;
  } finally { inFlight.delete(handledKey); }
}

type Scheduled = { identifier: string; content: { data?: Record<string, unknown> } };
type Presented = { request: { identifier: string } };

/**
 * Remembers a scheduled reminder so a later swipe can be detected. Called when
 * the app schedules a card outside reconciliation (Snooze, the test card): a
 * card that fires before the next app open would otherwise never be tracked.
 */
export async function trackReminderDelivery(identifier: string, data: Record<string, unknown> | null | undefined) {
  if (data?.managedBy !== REMINDER_MANAGER || typeof data.triggerTimestamp !== 'number' || typeof data.sourceId !== 'string' || typeof data.occurrenceDate !== 'string') return;
  const delivery: Delivery = { occurrence: reminderOccurrenceKey(sourceTypeForKind(data.reminderKind), data.sourceId, data.occurrenceDate), occurrenceDate: data.occurrenceDate, triggerAt: data.triggerTimestamp };
  await store().setItemAsync(DELIVERY + identifier, JSON.stringify(delivery));
}

/**
 * Android reports no swipe event to the app. A reminder that fired, left the
 * shade, and got no button/tap response was dismissed by the user (swipe or
 * Clear all), so it is recorded as "dismissed" when the app next reconciles.
 */
export async function syncReminderDeliveries(scheduled: Scheduled[], presented: Presented[], now = Date.now()) {
  const kv = store();
  const pending = new Set(scheduled.map(item => item.identifier));
  const showing = new Set(presented.map(item => item.request.identifier));
  for (const item of scheduled) await trackReminderDelivery(item.identifier, item.content.data);
  const tracked = (await kv.getAllKeysAsync()).filter(key => key.startsWith(DELIVERY));
  for (const key of tracked) {
    const identifier = key.slice(DELIVERY.length);
    if (pending.has(identifier) || showing.has(identifier)) continue;
    const delivery = parse<Delivery>(await kv.getItemAsync(key));
    await kv.removeItemAsync(key);
    // Cancelled/rescheduled before it fired: never shown, nothing to acknowledge.
    if (!delivery || delivery.triggerAt > now) continue;
    const ack = parse<ReminderAck>(await kv.getItemAsync(ACK + delivery.occurrence));
    if (!ack || ack.at < delivery.triggerAt) {
      await recordReminderAck(delivery.occurrence, delivery.occurrenceDate, 'dismissed', now);
      // A swipe is an acknowledgement: a Snooze that already existed when this card fired is cancelled.
      await cancelSnoozesFor(delivery.occurrence, delivery.triggerAt, scheduled).catch(() => {});
    }
  }
  // Bound old state so the key-value file cannot grow without limit.
  const keys = await kv.getAllKeysAsync();
  for (const [prefix, at] of [[ACK, (value: string | null) => parse<ReminderAck>(value)?.at ?? 0], [HANDLED, (value: string | null) => Number(value) || 0]] as const) {
    const group = keys.filter(key => key.startsWith(prefix));
    if (group.length <= MAX_TRACKED) continue;
    const dated = await Promise.all(group.map(async key => ({ key, at: at(await kv.getItemAsync(key)) })));
    for (const { key } of dated.sort((a, b) => a.at - b.at).slice(0, group.length - MAX_TRACKED)) await kv.removeItemAsync(key);
  }
}

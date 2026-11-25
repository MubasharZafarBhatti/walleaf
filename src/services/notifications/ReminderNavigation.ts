import type { AppDb } from '../../database/database';
import * as repo from '../../database/repositories/repositories';
import { isValidDateKey } from '../planned/PlannedPaymentService';
import { REMINDER_ACTIONS, REMINDER_MANAGER } from './ReminderConstants';

export type ReminderTarget = { sourceType: 'planned_payment' | 'subscription'; sourceId: string; occurrenceDate: string; offset: number };
/** open = body tap; read/later/paid run without opening the app; review opens it. */
export type ReminderTapAction = 'open' | 'read' | 'later' | 'paid' | 'review';
export type ReminderTap = {
  key: string; target: ReminderTarget; action: ReminderTapAction; identifier: string;
  content: { title: string; body: string; data: Record<string, unknown> };
};
const TAP_ACTIONS: Record<string, ReminderTapAction> = {
  'expo.modules.notifications.actions.DEFAULT': 'open',
  [REMINDER_ACTIONS.READ]: 'read',
  [REMINDER_ACTIONS.LATER]: 'later',
  [REMINDER_ACTIONS.PAID]: 'paid',
  [REMINDER_ACTIONS.REVIEW]: 'review',
};
/**
 * The live listener gets `content.data` as an object. A button pressed while the
 * app process is dead reaches the background task as expo-notifications' raw
 * Android bundle, where a local notification's data is the JSON string
 * `content.dataString`. Both shapes must parse, or the press does nothing.
 */
function reminderContentData(content: object): unknown {
  if ('data' in content && content.data && typeof content.data === 'object') return content.data;
  if (!('dataString' in content) || typeof content.dataString !== 'string' || content.dataString.length > 16_384) return null;
  try { return JSON.parse(content.dataString) as unknown; } catch { return null; }
}

export function parseReminderTap(response: unknown): ReminderTap | null {
  if (!response || typeof response !== 'object' || !('notification' in response) || !('actionIdentifier' in response) || typeof response.actionIdentifier !== 'string' || !Object.prototype.hasOwnProperty.call(TAP_ACTIONS, response.actionIdentifier)) return null;
  const action = TAP_ACTIONS[response.actionIdentifier];
  const notification = response.notification;
  if (!notification || typeof notification !== 'object' || !('request' in notification) || !('date' in notification) || typeof notification.date !== 'number' || !Number.isFinite(notification.date)) return null;
  const request = notification.request;
  if (!request || typeof request !== 'object' || !('identifier' in request) || typeof request.identifier !== 'string' || !request.identifier || request.identifier.length > 2048 || !('content' in request)) return null;
  const content = request.content;
  if (!content || typeof content !== 'object') return null;
  const d = reminderContentData(content);
  if (!d || typeof d !== 'object' || !('managedBy' in d) || d.managedBy !== REMINDER_MANAGER || !('reminderKind' in d) || !['PLANNED_DUE', 'SUBSCRIPTION_RENEWAL', 'CANCELLATION'].includes(String(d.reminderKind)) || !('sourceId' in d) || typeof d.sourceId !== 'string' || !d.sourceId.trim() || d.sourceId.length > 512 || !('occurrenceDate' in d) || typeof d.occurrenceDate !== 'string' || !isValidDateKey(d.occurrenceDate)) return null;
  const type = d.reminderKind === 'PLANNED_DUE' ? 'planned_payment' : 'subscription';
  const legacy = !('version' in d) && !('sourceType' in d); // Prior adapter already saved exact kind/ID/date.
  if (!legacy && (!('version' in d) || d.version !== 2 || !('sourceType' in d) || d.sourceType !== type || !('reminderOffset' in d) || typeof d.reminderOffset !== 'number' || !Number.isSafeInteger(d.reminderOffset) || d.reminderOffset < 0)) return null;
  const offset = !legacy && 'reminderOffset' in d && typeof d.reminderOffset === 'number' ? d.reminderOffset : 0;
  const text = (field: string) => field in content && typeof (content as Record<string, unknown>)[field] === 'string' ? String((content as Record<string, unknown>)[field]).slice(0, 500) : '';
  return {
    key: JSON.stringify([request.identifier, notification.date, response.actionIdentifier]),
    target: { sourceType: type, sourceId: d.sourceId, occurrenceDate: d.occurrenceDate, offset },
    action, identifier: request.identifier,
    content: { title: text('title'), body: text('body'), data: d as Record<string, unknown> },
  };
}

export function createReminderTapCoordinator(input: {
  context: () => { db: AppDb; ready: boolean } | null;
  open: (target: ReminderTarget, cold: boolean, exists: boolean, tap: ReminderTap) => void;
  unavailable: (failed: boolean) => void;
  clear: (key: string) => void;
  pending: (value: boolean) => void;
}) {
  const queue: { tap: ReminderTap; cold: boolean }[] = [];
  const seen = new Set<string>();
  let working: Promise<void> | null = null;
  let rerun = false;
  let disposed = false;
  const flush = (): Promise<void> => {
    if (working) { rerun = true; return working; }
    working = (async () => {
      while (queue.length && !disposed) {
        const context = input.context(); if (!context?.ready) break;
        const item = queue[0];
        if (await repo.getSettings(context.db).then(s => s.notifications_last_response === item.tap.key)) {
          queue.shift(); input.clear(item.tap.key); continue;
        }
        let exists = false; let failed = false;
        try { exists = !!(item.tap.target.sourceType === 'planned_payment' ? await repo.getPlannedPayment(context.db, item.tap.target.sourceId) : await repo.getSubscription(context.db, item.tap.target.sourceId)); }
        catch { failed = true; }
        if (disposed || input.context()?.db !== context.db || !input.context()?.ready) break;
        input.open(item.tap.target, item.cold, exists, item.tap);
        if (!exists) input.unavailable(failed);
        await repo.setSetting(context.db, 'notifications_last_response', item.tap.key);
        queue.shift(); input.clear(item.tap.key);
      }
    })().finally(() => {
      working = null; input.pending(queue.length > 0);
      const again = rerun; rerun = false;
      if (again && queue.length && !disposed && input.context()?.ready) void flush().catch(() => input.unavailable(true));
    });
    return working;
  };
  return {
    receive(response: unknown, cold = false) {
      const tap = parseReminderTap(response);
      // Got it / Snooze / Mark as paid run in the background (ReminderActions); only taps and Review navigate.
      if (disposed || !tap || tap.action === 'read' || tap.action === 'later' || tap.action === 'paid' || seen.has(tap.key)) return;
      seen.add(tap.key); if (seen.size > 128) seen.delete(seen.values().next().value!);
      queue.push({ tap, cold }); if (queue.length > 16) queue.shift();
      input.pending(true); void flush().catch(() => input.unavailable(true));
    },
    flush,
    dispose() { disposed = true; },
  };
}

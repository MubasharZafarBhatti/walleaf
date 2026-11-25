import { useEffect, useRef, useState } from 'react';
import { Linking } from 'react-native';
import { useAppData } from './useAppData';
import { useAppDialog } from '../components/dialogs/AppDialogProvider';
import { enableLocalReminders, readReminderDelivery } from '../services/notifications/NotificationService';
import { reminderDeliveryReady, reminderStatusText, type ReminderDelivery } from '../services/notifications/ReminderStatus';

type Options = {
  name: string; kind: 'planned_expense' | 'planned_income' | 'subscription';
  enabled: string; days: string; create?: boolean; available?: boolean; save: () => Promise<void>;
};
type Ticket = { id: number; saveWaiting: boolean; finish: (resume: boolean, save?: boolean) => void };

/** Interaction-scoped Sage orchestration only. All native state, permissions and
 * scheduling stay in the notification service. Never watch form values to auto-prompt. */
export function useReminderSelectionWarning(options: Options) {
  const { db } = useAppData();
  const dialog = useAppDialog();
  const latest = useRef(options);
  const live = useRef(true);
  const revision = useRef(0);
  const touched = useRef(false);
  const warned = useRef(-1);
  const pending = useRef<Promise<boolean> | null>(null);
  const ticket = useRef<Ticket | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (options.available !== false) latest.current = options; });
  useEffect(() => { live.current = true; return () => { live.current = false; ticket.current?.finish(false); }; }, []);

  function reset() {
    revision.current++; touched.current = false; warned.current = -1;
    ticket.current?.finish(false); pending.current = null;
  }
  function warn(id: number, fromSave: boolean): Promise<boolean> {
    if (pending.current) { if (fromSave && ticket.current) ticket.current.saveWaiting = true; return pending.current; }
    const work = (async () => {
      if (!db) return false;
      let delivery: ReminderDelivery;
      try { delivery = await readReminderDelivery(db); }
      catch { delivery = { enabled: false, status: { permission: 'unavailable', canAskAgain: false, scheduling: 'failed', error: { stage: 'data', code: 'REMINDER_STATUS_FAILED' } } }; }
      if (!live.current || id !== revision.current) return false;
      if (reminderDeliveryReady(delivery)) return true;
      warned.current = id;
      return new Promise<boolean>(resolve => {
        let finished = false; let enabling = false;
        const current: Ticket = { id, saveWaiting: fromSave, finish: (resume, save = false) => {
          if (finished) return; finished = true; if (ticket.current === current) ticket.current = null;
          resolve(resume);
          if (save && !current.saveWaiting && live.current && revision.current === id) void latest.current.save();
        } };
        ticket.current = current;
        const continueWithout = () => current.finish(true, true);
        const failure = (value: ReminderDelivery) => {
          const blockedChannel = value.status.error?.code === 'CHANNEL_BLOCKED';
          const permanent = value.status.permission === 'denied' && !value.status.canAskAgain;
          dialog.showDialog({ actionLayout: 'stacked', title: blockedChannel ? 'Reminder channel is blocked' : permanent ? 'Notifications are blocked' : 'Notifications could not be enabled',
            message: blockedChannel ? 'The Android financial reminders channel is blocked. Open your device settings to allow this channel. Your form values have been kept.' : permanent ? 'Notifications are blocked in Android settings. Open your device settings to allow payment reminders.' : `${reminderStatusText(value.status)}. Your form values have been kept. You can still save without notifications.`,
            actions: [
              ...(blockedChannel || permanent ? [{ text: 'Open Device Settings', variant: 'primary' as const, onPress: async () => {
                try { await Linking.openSettings(); }
                catch { dialog.showSuccess('Open this app’s notification permissions in device Settings.'); }
                current.finish(false);
              } }] : []),
              { text: 'Continue Without Notifications', variant: 'secondary', onPress: continueWithout },
            ], onCancel: () => current.finish(false) });
        };
        const enable = async () => {
          if (enabling || finished || !live.current || id !== revision.current) return;
          enabling = true; setBusy(true);
          try {
            const result = await enableLocalReminders(db);
            if (!live.current || id !== revision.current) { current.finish(false); return; }
            const actual = result.permission === 'granted' ? await readReminderDelivery(db) : { enabled: false, status: result.status ?? delivery.status };
            if (reminderDeliveryReady(actual)) { dialog.showSuccess('Notifications enabled'); current.finish(true); }
            else failure(actual);
          } catch { if (live.current && id === revision.current) failure({ enabled: false, status: { permission: 'unavailable', canAskAgain: false, scheduling: 'failed', error: { stage: 'data', code: 'REMINDER_ENABLE_FAILED' } } }); else current.finish(false); }
          finally { enabling = false; if (live.current) setBusy(false); }
        };
        const name = latest.current.name.trim() || (latest.current.kind === 'subscription' ? 'this subscription' : 'this planned payment');
        const income = latest.current.kind === 'planned_income';
        const unknown = delivery.status.error?.stage === 'data' || delivery.status.error?.stage === 'permission-query';
        const reason = `${!delivery.enabled && !unknown ? 'The in-app Notifications setting is Off. ' : ''}${reminderStatusText(delivery.status)}.`;
        dialog.showDialog({ actionLayout: 'stacked', title: 'Reminders are turned off', message: `You've selected ${income ? 'an expected income reminder' : 'a reminder'} for ${name}, but ${unknown ? 'notification delivery cannot currently be verified' : 'notifications are currently disabled or blocked'}. You won't receive a notification unless you enable them. Your ${latest.current.kind === 'subscription' ? 'subscription' : income ? 'planned income' : 'planned payment'} can still be saved. ${reason}`,
          actions: [{ text: 'Enable Notifications', variant: 'primary', onPress: enable }, { text: 'Save Without Notifications', variant: 'secondary', onPress: continueWithout }],
          onCancel: () => current.finish(false) });
      });
    })();
    pending.current = work;
    void work.finally(() => { if (pending.current === work) pending.current = null; }).catch(() => {});
    return work;
  }
  function select(enabled: string, days: string, immediate = true) {
    revision.current++; touched.current = enabled === '1'; warned.current = -1;
    ticket.current?.finish(false); pending.current = null;
    if (!immediate || enabled !== '1' || !/^\d+$/.test(days)) return;
    void warn(revision.current, false);
  }
  async function beforeSave() {
    if (latest.current.enabled !== '1' || (!latest.current.create && !touched.current)) return true;
    if (ticket.current) ticket.current.saveWaiting = true;
    if (pending.current) return pending.current;
    if (warned.current === revision.current) return true;
    return warn(revision.current, true);
  }
  function checkSelection() {
    if (!touched.current || latest.current.enabled !== '1' || !/^\d+$/.test(latest.current.days) || warned.current === revision.current || pending.current) return;
    void warn(revision.current, false);
  }
  return { select, checkSelection, beforeSave, reset, busy };
}

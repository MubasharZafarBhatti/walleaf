import { useContext, useEffect, useRef } from 'react';
import { Linking, Platform, Text } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useAppData } from '../hooks/useAppData';
import { useAppDialog } from './dialogs/AppDialogProvider';
import { useSubmitGuard } from '../hooks/useSubmitGuard';
import { ListRow, SecondaryButton } from './common';
import { ReminderNavigationReady } from '../navigation/ReminderNavigationContext';
import { answerReminderIntroduction, shouldIntroduceReminders } from '../services/notifications/ReminderIntroduction';
import { disableLocalReminders, enableLocalReminders, inspectReminderPermission, queueAppReminderReconciliation, readReminderDelivery } from '../services/notifications/NotificationService';
import { getReminderStatusSnapshot, reminderStatusText, useReminderStatus, reminderDeliveryReady } from '../services/notifications/ReminderStatus';
import { colors } from '../theme';
import { LabelWithInfo } from './InfoTip';

// Phone makers known to stop background apps aggressively (Xiaomi HyperOS/MIUI first).
const strictBatteryBrands: [RegExp, string][] = [
  [/xiaomi|redmi|poco/i, 'Allow Autostart, then set Battery saver to "No restrictions".'],
  [/oppo|realme|oneplus/i, 'Allow background activity and turn off "Optimise battery use" for this app.'],
  [/vivo|iqoo/i, 'Allow background activity and Autostart for this app.'],
  [/huawei|honor/i, 'In App launch, set this app to "Manage manually" and allow it to run in the background.'],
  [/samsung/i, 'Set Battery to "Unrestricted" so the app is not put to sleep.'],
];

/** One-line hint (details in an (i) tip) shown only on phones that tend to block reminders. */
export function BackgroundReminderHint() {
  if (Platform.OS !== 'android') return null;
  const constants = Platform.constants as { Manufacturer?: string; Brand?: string };
  const maker = `${constants.Manufacturer ?? ''} ${constants.Brand ?? ''}`;
  const match = strictBatteryBrands.find(([pattern]) => pattern.test(maker));
  if (!match) return null;
  return <>
    <LabelWithInfo label="Reminders arriving late?" info={`This phone may stop apps in the background to save battery, which can delay or block reminders. Open the app's settings: ${match[1]}`} textStyle={{ color: colors.muted }} />
    <SecondaryButton title="Open app settings" onPress={() => { void Linking.openSettings().catch(() => {}); }} />
  </>;
}

export function ReminderIntroduction() {
  const { db, ready, settings, refresh } = useAppData();
  const navigationReady = useContext(ReminderNavigationReady);
  const focused = useIsFocused();
  const dialog = useAppDialog();
  const shown = useRef(false);
  useEffect(() => {
    if (!db || !ready || !settings || settings.setup_complete !== 'true' || !navigationReady || !focused || shown.current) return;
    if (!shouldIntroduceReminders(settings, true)) return;
    let active = true;
    // A frame after ready Home; never interrupt the Setup form or a startup tap.
    const frame = requestAnimationFrame(() => {
      if (!active || shown.current) return;
      shown.current = true;
      const answer = async (enable: boolean) => {
        try {
          await answerReminderIntroduction(db, enable);
          await refresh();
          const delivery = await readReminderDelivery(db);
          dialog.showSuccess(enable ? reminderDeliveryReady(delivery) ? 'Reminders enabled' : `Reminders cannot be delivered. ${reminderStatusText(delivery.status)}. Change this in Settings.` : delivery.enabled ? 'Your existing reminder preference is unchanged.' : 'Reminders are off. You can enable them in Settings.');
        } catch { dialog.showSuccess('Could not save the reminder choice. Please try in Settings.'); }
      };
      dialog.showDialog({ title: 'Stay on top of upcoming payments', message: "Get reminders before your planned payments and subscriptions are due, so you know what's coming up. You can change this anytime in Settings.", actions: [
        { text: 'Enable Reminders', variant: 'primary', onPress: () => answer(true) },
        { text: 'Not Now', variant: 'secondary', onPress: () => answer(false) },
      ], onCancel: () => { void answer(false); } });
    });
    return () => { active = false; cancelAnimationFrame(frame); };
  }, [db, ready, settings, navigationReady, focused, dialog, refresh]);
  return null;
}

export function ReminderPreferences() {
  const { db, settings, refresh } = useAppData();
  const focused = useIsFocused();
  const dialog = useAppDialog();
  const form = useSubmitGuard(refresh);
  const status = useReminderStatus();
  const enabled = settings?.notifications_enabled === 'true';
  useEffect(() => { if (focused) void inspectReminderPermission(); }, [focused]);
  const enable = () => form.submit(async () => {
    if (!db) return;
    const result = await enableLocalReminders(db);
    await refresh();
    if (result.permission === 'granted') dialog.showSuccess(result.reconciliation?.failed.length ? 'Reminders enabled. Scheduling will retry later.' : 'Reminders enabled');
    else {
      const actual = result.status ?? getReminderStatusSnapshot();
      dialog.showDialog({ title: actual.permission === 'denied' ? 'Notifications are blocked' : 'Reminder setup could not finish', message: `${reminderStatusText(actual)}. Financial features still work normally.`, actions: [
        { text: 'Not Now', variant: 'secondary' },
        ...(actual.permission === 'denied' && !actual.canAskAgain || actual.error?.code === 'CHANNEL_BLOCKED' ? [{ text: 'Open Settings', variant: 'primary' as const, onPress: () => Linking.openSettings() }] : []),
      ] });
    }
  });
  const toggle = () => {
    if (!enabled) return enable();
    return form.submit(async () => {
      if (!db) return;
      const result = await disableLocalReminders(db); await refresh();
      dialog.showSuccess(result.failed.length ? 'Reminders are off. Remaining requests will be cancelled on retry.' : 'Reminders turned off');
    });
  };
  const retry = () => form.submit(async () => { if (db) await queueAppReminderReconciliation(db); });
  return <>
    <ListRow card icon={enabled ? 'notifications-outline' : 'notifications-off-outline'} title="Notifications" subtitle={`${enabled ? 'On · local reminders only' : 'Off · local reminders only'}${enabled && (status.permission !== 'granted' || status.error?.code === 'CHANNEL_BLOCKED') ? ' · delivery blocked' : ''}`} right={<Text>{enabled ? 'On' : 'Off'}</Text>} onPress={form.saving ? undefined : toggle} />
    <Text accessibilityLiveRegion="polite" style={{ color: colors.muted }}>{reminderStatusText(status)}</Text>
    {status.permission === 'denied' && !status.canAskAgain || status.error?.code === 'CHANNEL_BLOCKED' ? <SecondaryButton title="Open device notification Settings" disabled={form.saving} onPress={() => { void Linking.openSettings().catch(() => dialog.showSuccess('Open this app’s notification permissions in device Settings.')); }} /> : status.permission !== 'granted' ? <SecondaryButton title={status.permission === 'undetermined' ? 'Enable Reminders' : 'Request notification permission'} disabled={form.saving} onPress={enable} /> : null}
    <SecondaryButton title="Refresh reminder status" disabled={form.saving} onPress={retry} />
    {enabled && status.permission === 'granted' ? <BackgroundReminderHint /> : null}
  </>;
}

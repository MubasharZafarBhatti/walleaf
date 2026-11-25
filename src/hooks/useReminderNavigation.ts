import { useEffect, useRef, useState } from 'react';
import type { NavigationContainerRef, ParamListBase } from '@react-navigation/native';
import { useAppData } from './useAppData';
import { useAppDialog } from '../components/dialogs/AppDialogProvider';
import { localNotificationApi } from '../services/notifications/LocalNotificationApi';
import { createReminderTapCoordinator, parseReminderTap } from '../services/notifications/ReminderNavigation';
import { notificationFailure } from '../services/notifications/ReminderStatus';
import { handleReminderAction, setReminderDatabase, setReminderPaymentListener } from '../services/notifications/ReminderActions';

export function useReminderNavigation() {
  const { db, ready, settings, dataEpoch, refresh } = useAppData();
  const dialog = useAppDialog();
  const navigation = useRef<NavigationContainerRef<ParamListBase> | null>(null);
  const current = useRef({ db, ready, onboarded: settings?.setup_complete === 'true' });
  const everReady = useRef(false);
  const [readyEpoch, setReadyEpoch] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  // Mark as paid pressed while the app is alive reuses this connection and refreshes the screens.
  useEffect(() => { setReminderDatabase(db); return () => setReminderDatabase(null); }, [db]);
  useEffect(() => { setReminderPaymentListener(() => { void refresh().catch(() => {}); }); return () => setReminderPaymentListener(null); }, [refresh]);
  const coordinator = useRef<ReturnType<typeof createReminderTapCoordinator> | null>(null);
  useEffect(() => { current.current = { db, ready, onboarded: settings?.setup_complete === 'true' }; void coordinator.current?.flush().catch(() => {}); }, [db, ready, settings, readyEpoch]);
  useEffect(() => {
    const controller = createReminderTapCoordinator({
      context: () => current.current.db ? { db: current.current.db, ready: current.current.ready && current.current.onboarded && !!navigation.current?.isReady() } : null,
      pending: setPending,
      open: (target, cold, exists) => {
        const nav = navigation.current; if (!nav?.isReady()) return;
        const list = target.sourceType === 'planned_payment' ? 'Planned' : 'Subscriptions';
        const detail = target.sourceType === 'planned_payment' ? 'PlannedPaymentDetail' : 'SubscriptionDetail';
        const params = target.sourceType === 'planned_payment' ? { plannedPaymentId: target.sourceId } : { subscriptionId: target.sourceId };
        if (cold || !exists) nav.navigate(list);
        const active = nav.getCurrentRoute();
        if (exists && !(active?.name === detail && JSON.stringify(active.params) === JSON.stringify(params))) nav.navigate(detail, params);
      },
      unavailable: failed => dialog.showDialog({ title: 'Reminder unavailable', message: failed ? 'Could not load this reminder. Your financial data has not changed. Please open its list and try again.' : 'This payment or subscription is no longer available. You can review the remaining records in its list.' }),
      clear: key => {
        try { const last = parseReminderTap(localNotificationApi.getLastNotificationResponse()); if (last?.key === key) localNotificationApi.clearLastNotificationResponse(); }
        catch (error) { notificationFailure('response', error); }
      },
    });
    coordinator.current = controller;
    let subscription: { remove: () => void } | undefined;
    try {
      const respond = (response: unknown, cold: boolean) => {
        void handleReminderAction(response).catch(error => notificationFailure('response', error));
        controller.receive(response, cold);
      };
      subscription = localNotificationApi.addNotificationResponseReceivedListener(response => respond(response, !everReady.current));
      respond(localNotificationApi.getLastNotificationResponse(), true);
    } catch (error) { notificationFailure('response', error); }
    return () => { subscription?.remove(); controller.dispose(); coordinator.current = null; };
  }, [dialog]);
  return {
    navigationRef: (value: NavigationContainerRef<ParamListBase> | null) => { navigation.current = value; },
    introductionReady: readyEpoch === (dataEpoch ?? 0) && !pending,
    onReady: () => { everReady.current = true; setReadyEpoch(dataEpoch ?? 0); void coordinator.current?.flush().catch(() => {}); },
  };
}

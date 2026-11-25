import { act, createElement, useEffect } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import type { NavigationContainerRef, ParamListBase } from '@react-navigation/native';
import { createReminderTapCoordinator, parseReminderTap, type ReminderTarget } from '../services/notifications/ReminderNavigation';
import { localNotificationApi } from '../services/notifications/LocalNotificationApi';
import { useReminderNavigation } from '../hooks/useReminderNavigation';
import * as repo from '../database/repositories/repositories';
import { reminderDatabase, reminderPlan, reminderSubscription } from './reminderFixtures';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
const mockData: { db: Awaited<ReturnType<typeof reminderDatabase>>['db'] | null; ready: boolean; settings: { setup_complete: string }; dataEpoch: number } = { db: null, ready: false, settings: { setup_complete: 'false' }, dataEpoch: 0 };
const mockDialog = { showDialog: jest.fn() };
jest.mock('../hooks/useAppData', () => ({ useAppData: () => mockData }));
jest.mock('../components/dialogs/AppDialogProvider', () => ({ useAppDialog: () => mockDialog }));
let harness: Awaited<ReturnType<typeof reminderDatabase>>; let view: ReactTestRenderer | undefined;
beforeEach(async () => { jest.clearAllMocks(); harness = await reminderDatabase(); mockData.db = harness.db; mockData.ready = false; mockData.settings.setup_complete = 'false'; mockData.dataEpoch = 0; });
afterEach(async () => { if (view) await act(async () => view!.unmount()); view = undefined; harness.close(); jest.restoreAllMocks(); });
function response(id: string, sourceType = 'planned_payment', stamp = 100) {
  return { actionIdentifier: 'expo.modules.notifications.actions.DEFAULT', notification: { date: stamp, request: { identifier: `notification-${id}-${stamp}`, content: { data: { managedBy: 'expense-tracker', version: 2, reminderKind: sourceType === 'planned_payment' ? 'PLANNED_DUE' : 'SUBSCRIPTION_RENEWAL', sourceType, sourceId: id, occurrenceDate: '2026-10-20', reminderOffset: 3 } } } } };
}
test.each([
  null, {}, response('record', 'invalid'), { ...response('record'), actionIdentifier: 'dismiss' },
  { ...response('record'), notification: { date: 100, request: { identifier: 'test', content: { data: { managedBy: 'other' } } } } },
])('untrusted/invalid notification payload cannot navigate (%p)', value => { expect(parseReminderTap(value)).toBeNull(); });
test('parser uses structured IDs, dates, offset and version, never a display name/route', () => {
  const r = response('stable-ID'); expect(parseReminderTap(r)?.target).toEqual({ sourceType: 'planned_payment', sourceId: 'stable-ID', occurrenceDate: '2026-10-20', offset: 3 });
  r.notification.request.content.data.occurrenceDate = '2026-02-30'; expect(parseReminderTap(r)).toBeNull();
});
test('previous local adapter kind/ID/date payload safely opens its exact legacy target', () => {
  const old = { actionIdentifier: 'expo.modules.notifications.actions.DEFAULT', notification: { date: 100, request: { identifier: 'old-local-reminder', content: { data: { managedBy: 'expense-tracker', reminderKind: 'SUBSCRIPTION_RENEWAL', sourceId: 'exact-old-ID', occurrenceDate: '2026-10-20' } } } } };
  expect(parseReminderTap(old)?.target).toMatchObject({ sourceType: 'subscription', sourceId: 'exact-old-ID' });
});
test('cold/runtime duplicate waits for DB/onboarding/navigation, opens exact ID once, persists consumption and clears', async () => {
  const p = await reminderPlan(harness.db); let ready = false; const open = jest.fn(); const clear = jest.fn();
  const controller = createReminderTapCoordinator({ context: () => ({ db: harness.db, ready }), open, clear, pending: jest.fn(), unavailable: jest.fn() });
  controller.receive(response(p.id), true); controller.receive(response(p.id), false); await controller.flush(); expect(open).not.toHaveBeenCalled();
  ready = true; const before = await harness.financial(); await controller.flush(); expect(open).toHaveBeenCalledTimes(1); expect(open).toHaveBeenCalledWith(expect.objectContaining({ sourceId: p.id }), true, true, expect.objectContaining({ action: 'open' })); expect(clear).toHaveBeenCalledTimes(1); expect(await harness.financial()).toEqual(before);
  const another = createReminderTapCoordinator({ context: () => ({ db: harness.db, ready }), open, clear, pending: jest.fn(), unavailable: jest.fn() }); another.receive(response(p.id), true); await another.flush(); expect(open).toHaveBeenCalledTimes(1); controller.dispose(); another.dispose();
});
test('same-name records and multiple warm taps resolve independently without posting money', async () => {
  const a = await reminderPlan(harness.db, { name: 'Same' }); const b = await reminderPlan(harness.db, { name: 'Same' }); const s = await reminderSubscription(harness.db, { name: 'Same' });
  const open = jest.fn(); const controller = createReminderTapCoordinator({ context: () => ({ db: harness.db, ready: true }), open, clear: jest.fn(), pending: jest.fn(), unavailable: jest.fn() }); const before = await harness.financial();
  controller.receive(response(a.id)); controller.receive(response(b.id)); controller.receive(response(s.id, 'subscription')); await controller.flush();
  expect(open.mock.calls.map(call => (call[0] as ReminderTarget).sourceId)).toEqual([a.id, b.id, s.id]); expect(open.mock.calls.every(call => call[1] === false && call[2] === true)).toBe(true); expect(await harness.financial()).toEqual(before); controller.dispose();
});
test('missing/stopped target gives friendly list fallback, not another record with the same name', async () => {
  const p = await reminderPlan(harness.db); await repo.stopTrackingPlannedPayment(harness.db, p.id, p.updated_at); await reminderPlan(harness.db, { name: p.name });
  const open = jest.fn(); const unavailable = jest.fn(); const controller = createReminderTapCoordinator({ context: () => ({ db: harness.db, ready: true }), open, unavailable, clear: jest.fn(), pending: jest.fn() });
  controller.receive(response(p.id), true); await controller.flush(); expect(open).toHaveBeenCalledWith(expect.objectContaining({ sourceId: p.id }), true, false, expect.objectContaining({ action: 'open' })); expect(unavailable).toHaveBeenCalledWith(false); controller.dispose();
});

type Route = { name: string; params?: object };
let routes: Route[] = [];
const mockNav = {
  isReady: () => mockData.ready,
  getCurrentRoute: () => routes.at(-1),
  navigate: jest.fn((name: string, params?: object) => { const current = routes.at(-1); if (current?.name === name && JSON.stringify(current.params) === JSON.stringify(params)) return; routes.push({ name, params }); }),
  goBack: () => { routes.pop(); },
};
function Probe() {
  const { navigationRef, onReady } = useReminderNavigation();
  useEffect(() => { navigationRef(mockNav as unknown as NavigationContainerRef<ParamListBase>); if (mockData.ready) onReady(); }, [navigationRef, onReady]);
  return null;
}
test('actual hook installs/cleans live listener and cold launch seeds list -> exact detail -> Back', async () => {
  const s = await reminderSubscription(harness.db); routes = [{ name: 'Tabs' }]; mockNav.navigate.mockClear();
  const remove = jest.fn(); const listen = jest.spyOn(localNotificationApi, 'addNotificationResponseReceivedListener').mockReturnValue({ remove } as never);
  jest.spyOn(localNotificationApi, 'getLastNotificationResponse').mockReturnValue(response(s.id, 'subscription') as never); const clear = jest.spyOn(localNotificationApi, 'clearLastNotificationResponse').mockImplementation(() => {});
  await act(async () => { view = create(createElement(Probe)); }); expect(mockNav.navigate).not.toHaveBeenCalled();
  mockData.ready = true; mockData.settings.setup_complete = 'true'; await act(async () => { view!.update(createElement(Probe)); });
  expect(mockNav.navigate.mock.calls.map(c => c[0])).toEqual(['Subscriptions', 'SubscriptionDetail']); expect(routes.at(-1)).toEqual({ name: 'SubscriptionDetail', params: { subscriptionId: s.id } }); mockNav.goBack(); expect(routes.at(-1)?.name).toBe('Subscriptions'); expect(clear).toHaveBeenCalledTimes(1);
  expect(listen).toHaveBeenCalledTimes(1); await act(async () => view!.unmount()); view = undefined; expect(remove).toHaveBeenCalledTimes(1);
});
test('actual warm hook preserves Goals Back, ignores duplicate tap, never navigates merely on delivery', async () => {
  const p = await reminderPlan(harness.db); routes = [{ name: 'Tabs' }, { name: 'Goals' }]; mockNav.navigate.mockClear(); mockData.ready = true; mockData.settings.setup_complete = 'true';
  let listener!: Parameters<typeof localNotificationApi.addNotificationResponseReceivedListener>[0];
  jest.spyOn(localNotificationApi, 'addNotificationResponseReceivedListener').mockImplementation(fn => { listener = fn; return { remove: jest.fn() } as never; }); jest.spyOn(localNotificationApi, 'getLastNotificationResponse').mockReturnValue(null);
  await act(async () => { view = create(createElement(Probe)); }); expect(mockNav.navigate).not.toHaveBeenCalled();
  await act(async () => { listener(response(p.id) as never); listener(response(p.id) as never); });
  expect(mockNav.navigate).toHaveBeenCalledTimes(1); expect(mockNav.navigate).toHaveBeenCalledWith('PlannedPaymentDetail', { plannedPaymentId: p.id }); mockNav.goBack(); expect(routes.at(-1)?.name).toBe('Goals');
});

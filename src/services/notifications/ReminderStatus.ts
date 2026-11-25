import { useSyncExternalStore } from 'react';
import type { ChannelFailureDiagnostic } from './ChannelDiagnostics';
import { captureNotificationDiagnostic, notificationErrorField } from './NotificationDiagnostics';

export type ReminderPermission = 'granted' | 'denied' | 'undetermined' | 'unavailable';
export type ReminderStage = 'native-module' | 'permission-query' | 'permission-request' | 'channel' | 'schedule' | 'enumerate' | 'cancel' | 'response' | 'presentation' | 'data';
export type ReminderStatus = {
  permission: ReminderPermission; canAskAgain: boolean;
  scheduling: 'unknown' | 'available' | 'failed';
  error?: { stage: ReminderStage; code: string; diagnostic?: ChannelFailureDiagnostic };
};
export type ReminderDelivery = { enabled: boolean; status: ReminderStatus };
export function reminderDeliveryReady(value: ReminderDelivery): boolean {
  return value.enabled && value.status.permission === 'granted' && !value.status.error && value.status.scheduling !== 'failed';
}
let status: ReminderStatus = { permission: 'undetermined', canAskAgain: true, scheduling: 'unknown' };
const listeners = new Set<() => void>();
export function getReminderStatusSnapshot() { return status; }
export function publishReminderStatus(next: ReminderStatus) {
  if (JSON.stringify(next) === JSON.stringify(status)) return;
  status = next; listeners.forEach(listener => listener());
}
export function notificationFailure(stage: ReminderStage, error: unknown): ReminderStatus['error'] {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'NATIVE_API_ERROR';
  const originalMessage = typeof error === 'string' ? error : notificationErrorField(error, 'message');
  const message = typeof originalMessage === 'string' ? originalMessage : '';
  const missing = /Cannot find native module|native module.*(missing|unavailable)|UnavailabilityError|Notifications\.[A-Za-z]+ is not available/i.test(message) || code === 'ERR_UNAVAILABLE';
  const explicit = error && typeof error === 'object' && 'reminderStage' in error && (error.reminderStage === 'channel' || error.reminderStage === 'native-module') ? error.reminderStage : stage;
  const diagnostic = __DEV__ && error && typeof error === 'object' && 'diagnostic' in error ? error.diagnostic as ChannelFailureDiagnostic | undefined : undefined;
  const failure = { stage: missing ? 'native-module' as const : explicit, code, ...(diagnostic ? { diagnostic } : {}) };
  captureNotificationDiagnostic(error, { stage: failure.stage, originalStage: stage, applicationErrorCode: code });
  // Stage/code only: never log raw errors, source IDs, titles, dates or amounts.
  if (__DEV__) console.warn(`[Local reminders] ${failure.stage}: ${failure.code}`);
  return failure;
}
export function reminderStatusText(value: ReminderStatus): string {
  if (value.error?.stage === 'native-module') return 'Local notification module unavailable';
  if (value.error?.code === 'CHANNEL_BLOCKED') return 'Android reminder channel is blocked · open device Settings';
  if (value.error?.code === 'CHANNEL_NOT_READY') return 'Android reminder channel was not created or could not be verified';
  if (value.error?.stage === 'channel') return 'Android reminder channel could not be prepared';
  if (value.error?.stage === 'permission-query') return 'Could not read device permission. Retry status';
  if (value.error?.stage === 'permission-request') return 'Permission request could not finish. Retry';
  if (value.permission === 'denied') return value.canAskAgain ? 'Notifications not allowed yet' : 'Device permission blocked · open device Settings';
  if (value.permission === 'undetermined') return 'Device permission not requested';
  if (value.permission === 'unavailable') return 'Local reminder status unavailable · retry';
  if (value.error || value.scheduling === 'failed') return 'Device permission allowed · reminder scheduling needs a retry';
  return value.scheduling === 'available' ? 'Device permission allowed · scheduling available' : 'Device permission allowed';
}
export function useReminderStatus() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getReminderStatusSnapshot, getReminderStatusSnapshot);
}

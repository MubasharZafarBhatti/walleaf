import { addDays } from '../../utils/date';
import type { FrequencyType, Subscription } from '../../types/models';
import { advanceRecurrence } from '../../utils/recurrence';
import { getPlannedDueStatus, isValidDateKey, validatePlannedPaymentInput } from '../planned/PlannedPaymentService';

export type SubscriptionInput = Omit<Subscription, 'id' | 'created_at' | 'updated_at' | 'deleted_at' | 'sync_status' | 'completed_cycles' | 'status'>;

export function validateSubscriptionInput(input: SubscriptionInput): void {
  validatePlannedPaymentInput({ ...input, type: 'EXPENSE', next_due_date: input.next_renewal_date, recurrence_type: input.frequency_type, recurrence_interval: input.frequency_interval, occurrence_limit: input.total_cycles });
  if (!['DAILY', 'EVERY_N_DAYS', 'WEEKLY', 'MONTHLY', 'EVERY_N_MONTHS', 'YEARLY'].includes(input.frequency_type)) throw new Error('Choose a valid frequency.');
  if (!isValidDateKey(input.start_date)) throw new Error('Enter a valid start date.');
  if (input.next_renewal_date < input.start_date) throw new Error('Next billing must be on or after the start date.');
  if (input.end_date && input.end_date < input.next_renewal_date) throw new Error('Next billing must be on or before the end date.');
  if (![0, 1].includes(input.cancellation_reminder_enabled)) throw new Error('Choose a valid cancellation reminder setting.');
  if (input.cancellation_reminder_date && !isValidDateKey(input.cancellation_reminder_date)) throw new Error('Enter a valid cancellation reminder date.');
  if (input.cancellation_reminder_enabled && !input.cancellation_reminder_date) throw new Error('Choose a cancellation reminder date.');
  normalizedMonthlyCost(input);
}

// Integer half-up rounding. BigInt keeps multiplication exact near safe-integer limits.
export function normalizedMonthlyCost(input: Pick<Subscription, 'amount_minor' | 'frequency_type' | 'frequency_interval'>): number {
  if (!Number.isSafeInteger(input.amount_minor) || input.amount_minor < 0) throw new Error('Invalid subscription amount.');
  const days = input.frequency_type === 'DAILY' || input.frequency_type === 'EVERY_N_DAYS';
  const denominator = days ? 12 * (input.frequency_type === 'DAILY' ? 1 : input.frequency_interval) : input.frequency_type === 'YEARLY' || input.frequency_type === 'WEEKLY' ? 12 : input.frequency_type === 'EVERY_N_MONTHS' ? input.frequency_interval : 1;
  if (!Number.isSafeInteger(denominator) || denominator < 1) throw new Error('Invalid subscription interval.');
  const numerator = BigInt(input.amount_minor) * BigInt(days ? 365 : input.frequency_type === 'WEEKLY' ? 52 : 1);
  const divisor = BigInt(denominator);
  const result = Number((numerator * BigInt(2) + divisor) / (divisor * BigInt(2)));
  if (!Number.isSafeInteger(result)) throw new Error('Monthly cost is outside the supported range.');
  return result;
}

export function getSubscriptionDueStatus(sub: Pick<Subscription, 'status' | 'next_renewal_date' | 'end_date' | 'total_cycles' | 'completed_cycles'>, today: string) {
  if (sub.status === 'CANCELLED') return { status: 'CANCELLED', label: 'Cancelled' };
  if (sub.status === 'PAUSED') return { status: 'PAUSED', label: 'Paused' };
  if (sub.status === 'ENDED' || (sub.end_date && sub.next_renewal_date > sub.end_date) || (sub.total_cycles != null && sub.completed_cycles >= sub.total_cycles)) return { status: 'ENDED', label: 'Ended' };
  return getPlannedDueStatus({ status: 'ACTIVE', next_due_date: sub.next_renewal_date }, today);
}

export function calculateNextRenewal(
  dateKey: string,
  frequencyType: FrequencyType,
  interval = 1,
  anchorDay?: number,
): string {
  return advanceRecurrence(dateKey, frequencyType, interval, anchorDay)!;
}

export function calculateReminderDate(
  nextRenewalDate: string,
  daysBefore: number,
): string {
  return addDays(nextRenewalDate, -Math.max(0, daysBefore));
}


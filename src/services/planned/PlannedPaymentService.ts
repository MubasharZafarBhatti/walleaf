import type { PlannedPayment } from '../../types/models';
import { parseDateKey, toDateKey } from '../../utils/date';
import {
  advanceRecurrence,
  validateRecurrenceInterval,
} from '../../utils/recurrence';

export type PlannedPaymentInput = Pick<
  PlannedPayment,
  | 'name'
  | 'type'
  | 'amount_minor'
  | 'category_id'
  | 'account_id'
  | 'next_due_date'
  | 'recurrence_type'
  | 'recurrence_interval'
  | 'end_date'
  | 'occurrence_limit'
  | 'reminder_enabled'
  | 'reminder_days_before'
  | 'subscription_metadata'
  | 'note'
>;

export type PlannedDueStatus =
  | 'UPCOMING'
  | 'DUE_TODAY'
  | 'OVERDUE'
  | 'PAUSED'
  | 'ENDED';

export function isValidDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && toDateKey(parseDateKey(value)) === value;
}

export function validatePlannedPaymentInput(input: PlannedPaymentInput): void {
  if (!input.name.trim()) throw new Error('Enter a planned payment name.');
  if (input.type !== 'EXPENSE' && input.type !== 'INCOME')
    throw new Error('Choose Expense or Income.');
  if (!Number.isSafeInteger(input.amount_minor) || input.amount_minor <= 0)
    throw new Error('Enter an amount greater than zero.');
  if (!input.account_id) throw new Error('Choose an active account.');
  if (!input.category_id) throw new Error('Choose an active category.');
  if (!isValidDateKey(input.next_due_date)) throw new Error('Enter a valid next date.');
  if (!['NONE', 'DAILY', 'EVERY_N_DAYS', 'WEEKLY', 'MONTHLY', 'EVERY_N_MONTHS', 'YEARLY'].includes(input.recurrence_type))
    throw new Error('Choose a valid recurrence.');
  const intervalError = validateRecurrenceInterval(
    input.recurrence_type,
    input.recurrence_interval,
  );
  if (intervalError) throw new Error(intervalError);
  if (!Number.isSafeInteger(input.recurrence_interval) || input.recurrence_interval < 1)
    throw new Error('Choose a valid recurrence interval.');
  if (input.end_date && !isValidDateKey(input.end_date)) throw new Error('Enter a valid end date.');
  if (input.occurrence_limit != null && (!Number.isSafeInteger(input.occurrence_limit) || input.occurrence_limit < 1))
    throw new Error('Choose a valid occurrence limit.');
  if (![0, 1].includes(input.reminder_enabled)) throw new Error('Choose a valid reminder setting.');
  if (!Number.isSafeInteger(input.reminder_days_before) || input.reminder_days_before < 0)
    throw new Error('Choose valid reminder days.');
}

export function calculateNextRecurrence(
  dateKey: string,
  recurrenceType: PlannedPayment['recurrence_type'],
  interval = 1,
  anchorDay?: number,
): string | null {
  return advanceRecurrence(dateKey, recurrenceType, interval, anchorDay);
}

export function nextPlannedDueDateAfterAction(
  planned: PlannedPayment,
  anchorDay?: number,
): string | null {
  const next = calculateNextRecurrence(
    planned.next_due_date,
    planned.recurrence_type,
    planned.recurrence_interval,
    anchorDay,
  );
  if (!next) return null;
  if (!isValidDateKey(next)) throw new Error('The next occurrence is outside the supported date range.');
  if (planned.end_date && next > planned.end_date) return null;
  if (
    planned.occurrence_limit &&
    planned.completed_occurrences + 1 >= planned.occurrence_limit
  )
    return null;
  return next;
}

function dateDayNumber(dateKey: string): number {
  const [year, month, day] = dateKey.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

export function getPlannedDueStatus(
  planned: Pick<PlannedPayment, 'status' | 'next_due_date'>,
  today: string,
): { status: PlannedDueStatus; label: string } {
  if (planned.status === 'PAUSED') return { status: 'PAUSED', label: 'Paused' };
  if (planned.status === 'ENDED') return { status: 'ENDED', label: 'Ended' };
  const days = dateDayNumber(planned.next_due_date) - dateDayNumber(today);
  if (days === 0) return { status: 'DUE_TODAY', label: 'Due today' };
  if (days > 0)
    return {
      status: 'UPCOMING',
      label: days === 1 ? 'Due tomorrow' : `Due in ${days} days`,
    };
  const overdueDays = Math.abs(days);
  return {
    status: 'OVERDUE',
    label: overdueDays === 1 ? '1 day overdue' : `${overdueDays} days overdue`,
  };
}

/** "On the due date", "1 day before", "3 days before" — matches the Remind me picker wording. */
export function reminderOffsetLabel(days: number, onDay = 'On the due date'): string {
  return days === 0 ? onDay : `${days} day${days === 1 ? '' : 's'} before`;
}

export function plannedRecordActionLabel(type: PlannedPayment['type']): string {
  return type === 'INCOME' ? 'Record Income' : 'Record Expense';
}

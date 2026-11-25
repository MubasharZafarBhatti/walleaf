import type { FrequencyType, PlannedRecurrenceType } from '../types/models';
import { addDays, addMonthsNoDrift } from './date';

export function advanceRecurrence(date: string, type: PlannedRecurrenceType, interval = 1, anchorDay?: number): string | null {
  if (type === 'NONE') return null;
  if (type === 'DAILY') return addDays(date, 1);
  if (type === 'EVERY_N_DAYS') {
    const error = validateRecurrenceInterval(type, interval);
    if (error) throw new Error(error);
    return addDays(date, interval);
  }
  if (type === 'WEEKLY') return addDays(date, 7);
  return addMonthsNoDrift(date, type === 'YEARLY' ? 12 : recurrenceIntervalForSave(type, Math.trunc(interval)), anchorDay);
}

export const subscriptionFrequencyRows: [FrequencyType, string][] = [
  ['DAILY', 'Daily'],
  ['EVERY_N_DAYS', 'Every N Days'],
  ['WEEKLY', 'Weekly'],
  ['MONTHLY', 'Monthly'],
  ['EVERY_N_MONTHS', 'Every few months'],
  ['YEARLY', 'Yearly'],
];

export const plannedRecurrenceRows: [PlannedRecurrenceType, string][] = [
  ['NONE', 'None'],
  ...subscriptionFrequencyRows,
];

export function formatRecurrenceLabel(
  type: PlannedRecurrenceType,
  interval = 1,
): string {
  if (type === 'NONE') return 'None';
  if (type === 'DAILY') return 'Daily';
  if (type === 'EVERY_N_DAYS') return `Every ${interval} day${interval === 1 ? '' : 's'}`;
  if (type === 'WEEKLY') return 'Weekly';
  if (type === 'MONTHLY') return 'Monthly';
  if (type === 'YEARLY') return 'Yearly';
  return `Every ${Math.max(2, Math.trunc(interval || 0))} months`;
}

export function parseRecurrenceInterval(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  return Number(value);
}

export function validateRecurrenceInterval(
  type: PlannedRecurrenceType,
  interval: number | null,
): string | null {
  if (type === 'EVERY_N_DAYS') {
    if (interval === null || !Number.isSafeInteger(interval) || interval < 1 || interval > 3650)
      return 'Repeat every must be a whole number from 1 to 3650 days.';
    return null;
  }
  if (type !== 'EVERY_N_MONTHS') return null;
  if (!Number.isInteger(interval) || interval === null)
    return 'Repeat every must be a whole number of months.';
  if (interval < 2) return 'Repeat every must be at least 2 months.';
  return null;
}

export function recurrenceIntervalForSave(
  type: PlannedRecurrenceType,
  interval: number | null,
): number {
  return (type === 'EVERY_N_MONTHS' || type === 'EVERY_N_DAYS') && interval ? interval : 1;
}

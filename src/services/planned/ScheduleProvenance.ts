import type { PlannedRecurrenceType } from '../../types/models';
import { advanceRecurrence, validateRecurrenceInterval } from '../../utils/recurrence';
import { makeId } from '../../utils/id';
import { isValidDateKey } from './PlannedPaymentService';

export type ScheduleProvenance = {
  version: 1; revision: string; anchorDate: string; anchorDay: number; recurrence: PlannedRecurrenceType;
  interval: number; endDate: string | null; limit: number | null;
};

export function newScheduleProvenance(anchorDate: string, recurrence: PlannedRecurrenceType, interval: number, endDate?: string | null, limit?: number | null, anchorDay = Number(anchorDate.slice(8))): string {
  return JSON.stringify({ version: 1, revision: makeId('schedule'), anchorDate, anchorDay, recurrence, interval, endDate: endDate ?? null, limit: limit ?? null });
}

export function decodeScheduleProvenance(value: string): ScheduleProvenance {
  const p: ScheduleProvenance = JSON.parse(value);
  if (!p || Object.keys(p).sort().join() !== ['version', 'revision', 'anchorDate', 'anchorDay', 'recurrence', 'interval', 'endDate', 'limit'].sort().join() ||
    p.version !== 1 || typeof p.revision !== 'string' || !p.revision.trim() || typeof p.anchorDate !== 'string' || !isValidDateKey(p.anchorDate) ||
    !['NONE', 'DAILY', 'EVERY_N_DAYS', 'WEEKLY', 'MONTHLY', 'EVERY_N_MONTHS', 'YEARLY'].includes(p.recurrence) ||
    !Number.isSafeInteger(p.interval) || p.interval < 1 || validateRecurrenceInterval(p.recurrence, p.interval) ||
    !Number.isInteger(p.anchorDay) || p.anchorDay < 1 || p.anchorDay > 31 ||
    (!['EVERY_N_MONTHS', 'EVERY_N_DAYS'].includes(p.recurrence) && p.interval !== 1) ||
    (p.endDate !== null && (typeof p.endDate !== 'string' || !isValidDateKey(p.endDate))) ||
    (p.limit !== null && (!Number.isSafeInteger(p.limit) || p.limit < 1))) throw new Error('Invalid saved schedule provenance.');
  return p;
}

/** Scheduled dates, not cash dates, advance the original calendar-day anchor. */
export function advanceSavedSchedule(date: string, provenance: string): string | null {
  const p = decodeScheduleProvenance(provenance);
  return advanceRecurrence(date, p.recurrence, p.interval, p.anchorDay);
}

export function isSavedScheduleDate(date: string, p: ScheduleProvenance): boolean {
  if (!isValidDateKey(date) || date < p.anchorDate) return false;
  if (date === p.anchorDate) return true;
  if (p.recurrence === 'NONE') return false;
  const day = (value: string) => { const [y, m, d] = value.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
  if (['DAILY', 'EVERY_N_DAYS', 'WEEKLY'].includes(p.recurrence)) {
    const period = p.recurrence === 'DAILY' ? 1 : p.recurrence === 'WEEKLY' ? 7 : p.interval;
    return (day(date) - day(p.anchorDate)) % period === 0;
  }
  const months = (value: string) => Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7));
  const delta = months(date) - months(p.anchorDate);
  const period = p.recurrence === 'YEARLY' ? 12 : p.recurrence === 'EVERY_N_MONTHS' ? p.interval : 1;
  if (delta <= 0 || delta % period !== 0) return false;
  // Use the same canonical month-end calculation as posting, not a second engine.
  return advanceRecurrence(p.anchorDate, 'EVERY_N_MONTHS', delta, p.anchorDay) === date;
}

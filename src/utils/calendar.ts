export const weekdayValues = [
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
] as const;

export type WeekdayValue = (typeof weekdayValues)[number];

const weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function normalizeWeekStart(value?: string): WeekdayValue {
  return weekdayValues.includes(value as WeekdayValue)
    ? (value as WeekdayValue)
    : 'MONDAY';
}

export function getWeekdayLabels(weekStart?: string): string[] {
  const start = weekdayValues.indexOf(normalizeWeekStart(weekStart));
  return [...weekdayLabels.slice(start), ...weekdayLabels.slice(0, start)];
}

export function getFirstDateOffset(date: Date, weekStart?: string): number {
  const start = weekdayValues.indexOf(normalizeWeekStart(weekStart));
  return (date.getDay() - start + 7) % 7;
}

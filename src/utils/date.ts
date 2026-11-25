export function todayLocal(): string {
  const now = new Date();
  return toDateKey(now);
}

export function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function monthKey(dateKey = todayLocal()): string {
  return dateKey.slice(0, 7);
}

export function addDays(dateKey: string, days: number): string {
  const date = parseDateKey(dateKey);
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

export function addMonthsNoDrift(dateKey: string, months: number, anchorDay?: number): string {
  const original = parseDateKey(dateKey);
  const day = anchorDay ?? original.getDate();
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error('Invalid recurrence anchor.');
  const next = new Date(
    original.getFullYear(),
    original.getMonth() + months,
    1,
  );
  const lastDay = new Date(
    next.getFullYear(),
    next.getMonth() + 1,
    0,
  ).getDate();
  next.setDate(Math.min(day, lastDay));
  return toDateKey(next);
}

export function parseDateKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function displayDate(dateKey: string): string {
  const date = parseDateKey(dateKey);
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** "Nov 17" this year, "Mar 2, 2025" otherwise: short enough for one line in list cards. */
export function displayListDate(dateKey: string, today = todayLocal()): string {
  const date = parseDateKey(dateKey);
  return dateKey.slice(0, 4) === today.slice(0, 4)
    ? date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function displayMonthYear(dateKey = todayLocal()): string {
  const date = parseDateKey(`${dateKey.slice(0, 7)}-01`);
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function displayFullDate(dateKey = todayLocal()): string {
  const date = parseDateKey(dateKey);
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export function dateKeyToInputDate(dateKey = todayLocal()): string {
  const [year, month, day] = dateKey.split('-');
  return `${day}-${month}-${year}`;
}

export function formatDateInput(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 8);
  if (!digits) return '';

  let day = '';
  let month = '';
  let year = '';
  let index = 0;

  const firstDayDigit = digits[index];
  if (!firstDayDigit) return '';
  if ('456789'.includes(firstDayDigit)) {
    day = `0${firstDayDigit}`;
    index += 1;
  } else if (digits.length >= 2) {
    day = digits.slice(0, 2);
    index = 2;
  } else {
    return firstDayDigit;
  }

  const firstMonthDigit = digits[index];
  if (!firstMonthDigit) return `${day}-`;
  if ('23456789'.includes(firstMonthDigit)) {
    month = `0${firstMonthDigit}`;
    index += 1;
  } else if (digits.length - index >= 2) {
    month = digits.slice(index, index + 2);
    index += 2;
  } else {
    return `${day}-${firstMonthDigit}`;
  }

  const remainingYearDigits = digits.slice(index);
  year = remainingYearDigits.startsWith('20')
    ? remainingYearDigits
    : `20${remainingYearDigits}`.slice(0, 4);

  return `${day}-${month}-${year}`;
}

export function inputDateToDateKey(input: string): string | null {
  const trimmed = formatDateInput(input.trim());
  if (!trimmed) return todayLocal();
  const match = trimmed.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  const dateKey = `${year}-${month}-${day}`;
  const parsed = parseDateKey(dateKey);
  return toDateKey(parsed) === dateKey ? dateKey : null;
}

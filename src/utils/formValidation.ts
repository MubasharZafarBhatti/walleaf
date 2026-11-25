import { moneyToMinorUnits } from './money';

export function validMoneyInput(value: string, { allowZero = false, optional = false } = {}) {
  if (optional && !value.trim()) return true;
  const minor = moneyToMinorUnits(value);
  return Number.isSafeInteger(minor) && (allowZero ? minor >= 0 : minor > 0);
}

export function changedName(value: string, original: string) {
  return !!value.trim() && value.trim().toLowerCase() !== original.trim().toLowerCase();
}

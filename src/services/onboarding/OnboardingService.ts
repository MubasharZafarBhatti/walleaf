import { moneyToMinorUnits } from '../../utils/money';
import { currencyRows } from '../../utils/currency';

export type SetupValidationInput = {
  name: string;
  currency: string;
  startingCash: string;
  monthlyPlan: string;
};

export type SetupValidationResult =
  | {
      ok: true;
      name: string;
      startingCashMinor: number;
      monthlyPlanMinor: number | null;
    }
  | { ok: false; message: string };

export function validateSetupInput(
  input: SetupValidationInput,
): SetupValidationResult {
  const name = input.name.trim();
  if (!name) return { ok: false, message: 'Enter your name to continue.' };
  if (!currencyRows.some(([code]) => code === input.currency))
    return { ok: false, message: 'Choose a valid currency.' };
  const startingCashMinor = input.startingCash.trim()
    ? moneyToMinorUnits(input.startingCash)
    : 0;
  const monthlyPlanMinor = input.monthlyPlan.trim()
    ? moneyToMinorUnits(input.monthlyPlan)
    : null;
  if (!Number.isSafeInteger(startingCashMinor) || startingCashMinor < 0)
    return { ok: false, message: 'Enter a valid starting cash balance.' };
  if (
    monthlyPlanMinor !== null &&
    (!Number.isSafeInteger(monthlyPlanMinor) || monthlyPlanMinor <= 0)
  )
    return { ok: false, message: 'Enter a valid monthly spending plan.' };
  return { ok: true, name, startingCashMinor, monthlyPlanMinor };
}

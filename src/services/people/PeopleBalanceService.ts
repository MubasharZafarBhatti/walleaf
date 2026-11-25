import type { PersonEntry, PersonEntryType } from '../../types/models';
import { formatMoney } from '../../utils/money';

export type VisiblePeopleAction = 'GIVE' | 'BORROW';

export function peopleActionLabel(balanceMinor: number, action: VisiblePeopleAction): string {
  return action === 'GIVE' ? 'Give' : 'Receive';
}

export function peopleEntryDisplayLabel(type: PersonEntryType): string {
  if (type === 'GIVEN' || type === 'PAID_BACK') return 'Given';
  if (type === 'BORROWED_FROM' || type === 'RECEIVED_BACK') return 'Received';
  return 'Adjustment';
}

export function personEntryDelta(
  type: PersonEntryType,
  amountMinor: number,
): number {
  switch (type) {
    case 'GIVEN':
    case 'PAID_BACK':
      return amountMinor;
    case 'RECEIVED_BACK':
    case 'BORROWED_FROM':
      return -amountMinor;
    case 'ADJUSTMENT':
      return amountMinor;
  }
}

export function calculatePersonBalance(
  entries: Pick<PersonEntry, 'type' | 'amount_minor'>[],
): number {
  return entries.reduce(
    (sum, entry) => sum + personEntryDelta(entry.type, entry.amount_minor),
    0,
  );
}

export function balanceStatus(balanceMinor: number, name = 'them'): string {
  if (balanceMinor > 0) return `${name} owes you`;
  if (balanceMinor < 0) return `You owe ${name}`;
  return 'Settled';
}

export function detectBalanceCrossing(
  currentBalance: number,
  delta: number,
): number | null {
  const next = currentBalance + delta;
  if (currentBalance === 0 || next === 0) return null;
  return Math.sign(currentBalance) !== Math.sign(next) ? next : null;
}

export function resolvePeopleAction(
  currentBalance: number,
  action: VisiblePeopleAction,
  amountMinor: number,
): {
  type: PersonEntryType;
  label: string;
  delta: number;
  nextBalance: number;
  requiresCrossingConfirmation: boolean;
} {
  const givesToPerson = action === 'GIVE';
  let type: PersonEntryType;
  let label: string;

  if (givesToPerson) {
    type = currentBalance < 0 ? 'PAID_BACK' : 'GIVEN';
    label = currentBalance < 0 ? 'Paid back' : 'You gave';
  } else {
    type = currentBalance > 0 ? 'RECEIVED_BACK' : 'BORROWED_FROM';
    label = currentBalance > 0 ? 'Received back' : 'You borrowed';
  }

  const delta = personEntryDelta(type, amountMinor);
  return {
    type,
    label,
    delta,
    nextBalance: currentBalance + delta,
    requiresCrossingConfirmation:
      detectBalanceCrossing(currentBalance, delta) !== null,
  };
}

export function buildBalanceCrossingMessage(
  personName: string,
  currentBalance: number,
  action: VisiblePeopleAction,
  amountMinor: number,
  currency?: string,
): string {
  const currentAmount = formatMoney(Math.abs(currentBalance), currency);
  const actionAmount = formatMoney(amountMinor, currency);
  const nextBalance =
    currentBalance + (action === 'GIVE' ? amountMinor : -amountMinor);
  const nextAmount = formatMoney(Math.abs(nextBalance), currency);
  if (currentBalance > 0 && action === 'BORROW') {
    return `${personName} currently owes you ${currentAmount}.\n\nReceiving ${actionAmount} from ${personName} will settle that amount and leave you owing ${personName} ${nextAmount}.`;
  }
  if (currentBalance < 0 && action === 'GIVE') {
    return `You currently owe ${personName} ${currentAmount}.\n\nGiving ${actionAmount} will settle that amount and leave ${personName} owing you ${nextAmount}.`;
  }
  return 'This action will settle the current balance and switch who owes whom.';
}

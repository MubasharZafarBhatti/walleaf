import type { PersonEntry, Transaction } from '../../types/models';
import { moneyToMinorUnits } from '../../utils/money';

export type SplitShare = {
  name: string;
  isSelf: boolean;
  shareMinor: number;
  personId?: string;
};

export type SplitMethod = 'Equal' | 'Exact' | 'Percentage' | 'Shares';

export type SplitParticipantInput = {
  key: string;
  name: string;
  isSelf: boolean;
  personId?: string;
};

export type SplitCalculationResult = {
  ok: boolean;
  error: string | null;
  shares: SplitShare[];
  allocatedMinor: number;
  remainingMinor: number;
  enteredTotal: string;
};

function parseDecimal(value: string): { units: bigint; scale: number } | null {
  const clean = value.trim();
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(clean)) return null;
  const [whole = '0', decimal = ''] = clean.split('.');
  const units = BigInt(`${whole || '0'}${decimal}`);
  return units <= BigInt(Number.MAX_SAFE_INTEGER) ? { units, scale: decimal.length } : null;
}

function weightedShares(totalMinor: number, weights: bigint[]): number[] {
  const totalWeight = weights.reduce((sum, value) => sum + value, 0n);
  let allocated = 0;
  return weights.map((weight, index) => {
    const share = index === weights.length - 1
      ? totalMinor - allocated
      : Number((BigInt(totalMinor) * weight) / totalWeight);
    allocated += share;
    return share;
  });
}

/** One deterministic result is used by both the form preview and persistence. */
export function calculateSplit(input: {
  totalMinor: number;
  method: SplitMethod;
  participants: SplitParticipantInput[];
  values: Record<string, string>;
  minimumParticipants?: number;
  commonCostMinor?: number;
}): SplitCalculationResult {
  const { totalMinor, method, participants, values } = input;
  const minimum = input.minimumParticipants ?? 2;
  const invalid = (error: string, enteredTotal = '0', allocatedMinor = 0): SplitCalculationResult => ({
    ok: false, error, shares: [], allocatedMinor, remainingMinor: totalMinor - allocatedMinor, enteredTotal,
  });
  if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0)
    return invalid('Enter a total amount greater than zero.');
  const common = input.commonCostMinor ?? 0;
  if (!Number.isSafeInteger(common) || common < 0 || (method !== 'Exact' && common !== 0)) return invalid('Common cost must be a nonnegative minor-unit amount for Exact split.');
  if (participants.length < minimum)
    return invalid(`Choose at least ${minimum} participant${minimum === 1 ? '' : 's'}.`);
  const identities = participants.map((participant) => participant.isSelf ? 'SELF' : participant.personId ?? participant.key);
  if (new Set(identities).size !== identities.length || participants.some((participant) => !participant.name.trim()))
    return invalid('Choose each participant once, including yourself.');

  if (method === 'Equal') {
    const shares = splitEvenly(totalMinor, participants);
    return { ok: true, error: null, shares, allocatedMinor: totalMinor, remainingMinor: 0, enteredTotal: String(participants.length) };
  }

  if (method === 'Exact') {
    const parsed = participants.map((participant) => moneyStringToMinor(values[participant.key] ?? ''));
    if (parsed.some((value) => value === null)) return invalid('Enter a valid amount for every participant.');
    const amounts = parsed as number[];
    const allocatedMinor = amounts.reduce((sum, value) => sum + value, common);
    if (!Number.isSafeInteger(allocatedMinor)) return invalid('The allocated total is outside the supported range.');
    if (allocatedMinor !== totalMinor)
      return invalid(allocatedMinor < totalMinor ? 'Exact amounts are under the bill total.' : 'Exact amounts are over the bill total.', String(allocatedMinor), allocatedMinor);
    const commonShares = distributeRemainder(common, participants.length);
    const shares = participants.map((participant, index) => ({ name: participant.name, isSelf: participant.isSelf, personId: participant.personId, shareMinor: amounts[index] + commonShares[index] }));
    return { ok: true, error: null, shares, allocatedMinor, remainingMinor: 0, enteredTotal: String(allocatedMinor) };
  }

  const parsed = participants.map((participant) => parseDecimal(values[participant.key] ?? ''));
  if (parsed.some((value) => value === null))
    return invalid(`Enter a valid ${method === 'Percentage' ? 'percentage' : 'share'} for every participant.`);
  const decimals = parsed as { units: bigint; scale: number }[];
  const maxScale = Math.max(...decimals.map((value) => value.scale));
  const weights = decimals.map((value) => value.units * (10n ** BigInt(maxScale - value.scale)));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0n);
  const displayTotal = decimalUnitsToString(totalWeight, maxScale);
  if (method === 'Shares' && weights.some((value) => value <= 0n))
    return invalid('Every selected participant needs shares greater than zero.', displayTotal);
  if (totalWeight <= 0n)
    return invalid(method === 'Percentage' ? 'Percentage total must be 100%.' : 'Total shares must be greater than zero.', displayTotal);
  if (method === 'Percentage') {
    const target = 100n * (10n ** BigInt(maxScale));
    if (totalWeight !== target)
      return invalid(totalWeight < target ? 'Percentages are under 100%.' : 'Percentages are over 100%.', displayTotal);
  }
  const amounts = weightedShares(totalMinor, weights);
  const shares = participants.map((participant, index) => ({ name: participant.name, isSelf: participant.isSelf, personId: participant.personId, shareMinor: amounts[index] }));
  return { ok: true, error: null, shares, allocatedMinor: totalMinor, remainingMinor: 0, enteredTotal: displayTotal };
}

function moneyStringToMinor(value: string): number | null {
  const amount = moneyToMinorUnits(value);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
}

function decimalUnitsToString(units: bigint, scale: number): string {
  if (!scale) return String(units);
  const digits = units.toString().padStart(scale + 1, '0');
  const value = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return value.replace(/0+$/, '').replace(/\.$/, '');
}

export function distributeRemainder(
  totalMinor: number,
  participantCount: number,
): number[] {
  if (participantCount <= 0) return [];
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0 || !Number.isSafeInteger(participantCount)) throw new Error('Invalid minor-unit allocation.');
  const base = Number(BigInt(totalMinor) / BigInt(participantCount));
  const remainder = Number(BigInt(totalMinor) % BigInt(participantCount));
  return Array.from(
    { length: participantCount },
    (_, index) => base + (index < remainder ? 1 : 0),
  );
}

export function splitEvenly(
  totalMinor: number,
  participants: { name: string; isSelf?: boolean; personId?: string }[],
): SplitShare[] {
  const shares = distributeRemainder(totalMinor, participants.length);
  return participants.map((participant, index) => ({
    name: participant.name,
    isSelf: Boolean(participant.isSelf),
    personId: participant.personId,
    shareMinor: shares[index],
  }));
}

export function validateCustomSplit(
  totalMinor: number,
  shares: Pick<SplitShare, 'shareMinor'>[],
): boolean {
  return (
    shares.length >= 2 &&
    shares.every((share) => share.shareMinor >= 0) &&
    shares.reduce((sum, share) => sum + share.shareMinor, 0) === totalMinor
  );
}

export function splitByExactAmounts(
  totalMinor: number,
  participants: {
    name: string;
    isSelf?: boolean;
    personId?: string;
    shareMinor: number;
  }[],
): SplitShare[] {
  const shares = participants.map((participant) => ({
    name: participant.name,
    isSelf: Boolean(participant.isSelf),
    personId: participant.personId,
    shareMinor: participant.shareMinor,
  }));
  if (!validateCustomSplit(totalMinor, shares)) return [];
  return shares;
}

export function splitByPercentage(
  totalMinor: number,
  participants: {
    name: string;
    isSelf?: boolean;
    personId?: string;
    percentage: number;
  }[],
): SplitShare[] {
  const totalPercentage = participants.reduce(
    (sum, participant) => sum + participant.percentage,
    0,
  );
  if (
    participants.length < 2 ||
    totalPercentage !== 100 ||
    participants.some((participant) => participant.percentage < 0)
  )
    return [];
  let allocated = 0;
  const shares = participants.map((participant, index) => {
    const shareMinor =
      index === participants.length - 1
        ? totalMinor - allocated
        : Math.floor((totalMinor * participant.percentage) / 100);
    allocated += shareMinor;
    return {
      name: participant.name,
      isSelf: Boolean(participant.isSelf),
      personId: participant.personId,
      shareMinor,
    };
  });
  return shares;
}

export function splitByShares(
  totalMinor: number,
  participants: {
    name: string;
    isSelf?: boolean;
    personId?: string;
    shares: number;
  }[],
): SplitShare[] {
  const totalShares = participants.reduce(
    (sum, participant) => sum + participant.shares,
    0,
  );
  if (
    participants.length < 2 ||
    totalShares <= 0 ||
    participants.some((participant) => participant.shares < 0)
  )
    return [];
  let allocated = 0;
  return participants.map((participant, index) => {
    const shareMinor =
      index === participants.length - 1
        ? totalMinor - allocated
        : Math.floor((totalMinor * participant.shares) / totalShares);
    allocated += shareMinor;
    return {
      name: participant.name,
      isSelf: Boolean(participant.isSelf),
      personId: participant.personId,
      shareMinor,
    };
  });
}

export function calculateOwnShare(shares: SplitShare[]): number {
  return shares
    .filter((share) => share.isSelf)
    .reduce((sum, share) => sum + share.shareMinor, 0);
}

export function calculateOtherShares(shares: SplitShare[]): SplitShare[] {
  return shares.filter((share) => !share.isSelf);
}

export function validateSplitAccounting(
  totalMinor: number,
  ownExpense: Pick<Transaction, 'amount_minor'>,
  peopleEntries: Pick<PersonEntry, 'amount_minor'>[],
): boolean {
  return (
    ownExpense.amount_minor +
      peopleEntries.reduce((sum, entry) => sum + entry.amount_minor, 0) ===
    totalMinor
  );
}

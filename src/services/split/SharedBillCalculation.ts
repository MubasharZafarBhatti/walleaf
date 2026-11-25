import { calculateSplit, distributeRemainder, type SplitMethod, type SplitParticipantInput } from './SplitService';

export type Contribution = { identity: string; paidMinor: number };
export type SettlementRoute = { from: string; to: string; amountMinor: number };
export type UserAllocation = { identity: string; amountMinor: number };
export type BillPosition = { identity: string; shareMinor: number; paidMinor: number; netMinor: number };
export const selfIdentity = 'SELF';
export const personIdentity = (id: string) => `PERSON:${id}`;
export function stableIdentity(participant: Pick<SplitParticipantInput, 'isSelf' | 'personId'>) {
  if (typeof participant.isSelf !== 'boolean') throw new Error('Invalid self identity marker.');
  if (participant.isSelf) { if (participant.personId) throw new Error('Self cannot reference a Person.'); return selfIdentity; }
  if (!participant.personId?.trim()) throw new Error('A shared participant must have a stable Person ID.');
  return personIdentity(participant.personId);
}
export function validateIdentity(identity: string) {
  if (identity !== selfIdentity && (!identity.startsWith('PERSON:') || !identity.slice(7).trim())) throw new Error('Invalid stable shared identity.');
}
export function exactSum(values: number[]) {
  if (values.some((value) => !Number.isSafeInteger(value))) throw new Error('Invalid minor-unit amount.');
  const sum = values.reduce((sum, value) => sum + BigInt(value), 0n);
  if (sum > BigInt(Number.MAX_SAFE_INTEGER) || sum < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount is outside the supported range.');
  return Number(sum);
}
const compareId = (a: string, b: string) => a === b ? 0 : a < b ? -1 : 1;

export function routeSettlements(positions: BillPosition[], custom?: UserAllocation[]): SettlementRoute[] {
  if (new Set(positions.map((position) => position.identity)).size !== positions.length) throw new Error('Duplicate shared identity.');
  for (const position of positions) {
    validateIdentity(position.identity);
    if (![position.shareMinor, position.paidMinor].every((amount) => Number.isSafeInteger(amount) && amount >= 0) || position.netMinor !== position.paidMinor - position.shareMinor) throw new Error('Invalid shared position.');
  }
  if (exactSum(positions.map((position) => position.netMinor)) !== 0) throw new Error('Shared positions must sum to zero.');
  const remaining = new Map(positions.map((position) => [position.identity, position.netMinor]));
  const routes: SettlementRoute[] = [];
  if (custom !== undefined) {
    const userNet = remaining.get(selfIdentity) ?? 0;
    if (new Set(custom.map((row) => row.identity)).size !== custom.length) throw new Error('Choose each settlement counterparty once.');
    if (exactSum(custom.map((row) => row.amountMinor)) !== Math.abs(userNet)) throw new Error('Custom allocations must equal your exact settlement position.');
    for (const row of [...custom].sort((a, b) => compareId(a.identity, b.identity))) {
      validateIdentity(row.identity);
      const capacity = remaining.get(row.identity);
      if (row.identity === selfIdentity || capacity === undefined || !capacity || Math.sign(capacity) === Math.sign(userNet) || !Number.isSafeInteger(row.amountMinor) || row.amountMinor < 0 || row.amountMinor > Math.abs(capacity)) throw new Error('Custom allocation exceeds a valid counterparty capacity.');
      if (!row.amountMinor) continue;
      routes.push({ from: userNet < 0 ? selfIdentity : row.identity, to: userNet < 0 ? row.identity : selfIdentity, amountMinor: row.amountMinor });
      remaining.set(row.identity, capacity + (userNet < 0 ? -row.amountMinor : row.amountMinor));
    }
    remaining.set(selfIdentity, 0);
  }
  const ordered = (credit: boolean) => [...remaining].filter(([, amount]) => credit ? amount > 0 : amount < 0)
    .sort(([a, av], [b, bv]) => Math.abs(bv) - Math.abs(av) || compareId(a, b))
    .map(([identity, amount]) => ({ identity, amount: Math.abs(amount) }));
  const creditors = ordered(true); const debtors = ordered(false);
  let creditor = 0;
  for (const debtor of debtors) while (debtor.amount > 0 && creditor < creditors.length) {
    const next = creditors[creditor];
    const amountMinor = Math.min(debtor.amount, next.amount);
    routes.push({ from: debtor.identity, to: next.identity, amountMinor });
    debtor.amount -= amountMinor; next.amount -= amountMinor;
    if (!next.amount) creditor++;
  }
  if (debtors.some((row) => row.amount) || creditors.some((row) => row.amount)) throw new Error('Settlement routing did not preserve the total.');
  return routes;
}

/** Canonical consumption math delegates to calculateSplit; funding is independent. */
export function calculateSharedBill(input: {
  totalMinor: number; method: SplitMethod; participants: SplitParticipantInput[]; values: Record<string, string>;
  commonCostMinor?: number; payers: Contribution[]; customUserSettlement?: UserAllocation[];
}) {
  const identities = input.participants.map(stableIdentity);
  if (new Set(identities).size !== identities.length) throw new Error('Choose each participant once.');
  const commonCostMinor = input.commonCostMinor ?? 0;
  const split = calculateSplit({ ...input, minimumParticipants: 1, commonCostMinor });
  if (!split.ok) throw new Error(split.error ?? 'Invalid consumption split.');
  if (!input.payers.length || new Set(input.payers.map((payer) => payer.identity)).size !== input.payers.length) throw new Error('Choose each payer once.');
  for (const payer of input.payers) {
    validateIdentity(payer.identity);
    if (!Number.isSafeInteger(payer.paidMinor) || payer.paidMinor < 0) throw new Error('Payer contributions must be nonnegative minor-unit amounts.');
  }
  const paidTotal = exactSum(input.payers.map((payer) => payer.paidMinor));
  if (paidTotal !== input.totalMinor) throw new Error(paidTotal < input.totalMinor ? 'Payer contributions are below the bill total.' : 'Payer contributions exceed the bill total.');
  const all = [...new Set([...identities, ...input.payers.map((payer) => payer.identity)])].sort(compareId);
  const positions = all.map((identity) => {
    const shareMinor = split.shares[identities.indexOf(identity)]?.shareMinor ?? 0;
    const paidMinor = input.payers.find((payer) => payer.identity === identity)?.paidMinor ?? 0;
    return { identity, shareMinor, paidMinor, netMinor: paidMinor - shareMinor };
  });
  const user = positions.find((position) => position.identity === selfIdentity);
  const commonAllocations = distributeRemainder(commonCostMinor, identities.length);
  return { shares: split.shares, commonAllocations, positions, routes: routeSettlements(positions, input.customUserSettlement),
    userShareMinor: user?.shareMinor ?? 0, userPaidMinor: user?.paidMinor ?? 0, userNetMinor: user?.netMinor ?? 0 };
}

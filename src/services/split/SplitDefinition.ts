import { calculateSplit, type SplitMethod } from './SplitService';
import type { PersonEntryType, SplitParticipant } from '../../types/models';
import { calculateSharedBill, personIdentity, selfIdentity, stableIdentity, type Contribution, type SettlementRoute, type UserAllocation } from './SharedBillCalculation';
import { resolvePeopleAction } from '../people/PeopleBalanceService';

export type SplitEditorInput = { method: SplitMethod; values: string[]; commonCostMinor?: number };
type Definition = { version: 1; method: SplitMethod; participants: { identity: string; value: string }[] };
type Share = { isSelf: boolean; personId?: string | null; name: string; shareMinor: number };

export function encodeSplitDefinition(totalMinor: number, shares: Share[], editor?: SplitEditorInput): string | null {
  if (!editor) return null;
  if (editor.commonCostMinor) throw new Error('Common cost requires the complete shared bill definition.');
  if (!['Equal', 'Exact', 'Percentage', 'Shares'].includes(editor.method) || editor.values.length !== shares.length || editor.values.some((v) => typeof v !== 'string' || v.length > 256)) throw new Error('Invalid split editor definition.');
  if (editor.method === 'Equal' && editor.values.some((value) => value !== '')) throw new Error('Equal split definitions cannot contain participant values.');
  const participants = shares.map((share, index) => ({ key: String(index), name: share.name, isSelf: share.isSelf, personId: share.personId ?? undefined }));
  const result = calculateSplit({ totalMinor, method: editor.method, participants, values: Object.fromEntries(editor.values.map((v, i) => [String(i), v])), minimumParticipants: 1 });
  if (!result.ok || result.shares.some((share, index) => share.shareMinor !== shares[index].shareMinor)) throw new Error('Split definition does not match the saved shares.');
  return JSON.stringify({ version: 1, method: editor.method, participants: shares.map((share, index) => ({ identity: share.isSelf ? 'SELF' : `PERSON:${share.personId ?? index}`, value: editor.method === 'Equal' ? '' : editor.values[index].replace(/,/g, '') })) } satisfies Definition);
}

/** Validate intent against canonical math, never infer a method from amounts. */
export function decodeSplitDefinition(text: string | null | undefined, totalMinor: number, rows: SplitParticipant[]) {
  if (text == null) return null;
  const value = JSON.parse(text) as Definition;
  if ((value as unknown as { version: number })?.version === 2) {
    const definition = decodeSharedDefinition(text, totalMinor, rows);
    const ordered = definition.participants.map((item) => rows.find((row) => (row.is_self ? selfIdentity : personIdentity(row.person_id!)) === item.identity)!);
    return { ...definition, participants: ordered, values: Object.fromEntries(definition.participants.map((item) => [item.identity, item.value])) };
  }
  if (!value || Object.keys(value).sort().join() !== 'method,participants,version' || value.version !== 1 || !Array.isArray(value.participants) || value.participants.length !== rows.length) throw new Error('Invalid split editor definition.');
  const identities = new Set<string>();
  const ordered = value.participants.map((item) => {
    if (!item || Object.keys(item).sort().join() !== 'identity,value' || typeof item.identity !== 'string' || typeof item.value !== 'string' || identities.has(item.identity)) throw new Error('Invalid split participant definition.');
    identities.add(item.identity);
    const row = rows.find((p) => (p.is_self ? 'SELF' : `PERSON:${p.person_id}`) === item.identity);
    if (!row) throw new Error('Split definition references an unavailable participant.');
    return row;
  });
  const editor = { method: value.method, values: value.participants.map((p) => p.value) };
  encodeSplitDefinition(totalMinor, ordered.map((p) => ({ name: p.name, isSelf: p.is_self === 1, personId: p.person_id, shareMinor: p.share_minor })), editor);
  return { method: value.method, participants: ordered, values: Object.fromEntries(value.participants.map((p) => [p.identity, p.value])) };
}

export type SharedDefinition = {
  version: 2; method: SplitMethod; commonCostMinor: number;
  participants: { identity: string; value: string; shareMinor: number }[];
  payers: Contribution[]; routes: SettlementRoute[]; customUserSettlement: UserAllocation[] | null;
  classifications: { identity: string; balanceBeforeMinor: number; type: PersonEntryType }[];
};
export function userRoutes(routes: SettlementRoute[]) {
  return routes.filter((route) => route.from === selfIdentity || route.to === selfIdentity).map((route) => ({
    identity: route.from === selfIdentity ? route.to : route.from,
    action: route.to === selfIdentity ? 'GIVE' as const : 'BORROW' as const,
    amountMinor: route.amountMinor,
  }));
}
export function createSharedDefinition(totalMinor: number, shares: Share[], editor: SplitEditorInput, payers: Contribution[], customUserSettlement?: UserAllocation[], balances: Record<string, number> = {}) {
  if (!['Equal', 'Exact', 'Percentage', 'Shares'].includes(editor.method) || editor.values.length !== shares.length || editor.values.some((value) => typeof value !== 'string' || value.length > 256) || (editor.method === 'Equal' && editor.values.some((value) => value !== ''))) throw new Error('Invalid shared split inputs.');
  const participants = shares.map((share) => ({ ...share, key: stableIdentity({ ...share, personId: share.personId ?? undefined }), personId: share.personId ?? undefined }));
  const result = calculateSharedBill({ totalMinor, method: editor.method, participants, values: Object.fromEntries(participants.map((participant, index) => [participant.key, editor.values[index]])), commonCostMinor: editor.commonCostMinor ?? 0, payers, customUserSettlement });
  if (result.shares.some((share, index) => share.shareMinor !== shares[index].shareMinor)) throw new Error('Consumption inputs do not match final saved shares.');
  const definition: SharedDefinition = { version: 2, method: editor.method, commonCostMinor: editor.commonCostMinor ?? 0,
    participants: participants.map((participant, index) => ({ identity: participant.key, value: editor.method === 'Equal' ? '' : editor.values[index].replace(/,/g, ''), shareMinor: result.shares[index].shareMinor })),
    payers: payers.map((payer) => ({ ...payer })), routes: result.routes,
    customUserSettlement: customUserSettlement?.map((row) => ({ ...row })) ?? null,
    classifications: userRoutes(result.routes).map((route) => {
      const balanceBeforeMinor = balances[route.identity] ?? 0;
      if (!Number.isSafeInteger(balanceBeforeMinor)) throw new Error('Invalid People classification basis.');
      const resolved = resolvePeopleAction(balanceBeforeMinor, route.action, route.amountMinor);
      if (!Number.isSafeInteger(resolved.nextBalance)) throw new Error('People classification is outside the supported range.');
      return { identity: route.identity, balanceBeforeMinor, type: resolved.type };
    }),
  };
  return { definition, result };
}
function keys(value: unknown, expected: string): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== expected) throw new Error('Invalid shared metadata fields.');
}
export function decodeSharedDefinition(text: string, totalMinor: number, rows: SplitParticipant[]): SharedDefinition {
  const value = JSON.parse(text) as SharedDefinition;
  keys(value, 'classifications,commonCostMinor,customUserSettlement,method,participants,payers,routes,version');
  if (!Number.isSafeInteger(value.commonCostMinor) || value.commonCostMinor < 0) throw new Error('Invalid shared common cost metadata.');
  if (value.version !== 2 || !Array.isArray(value.participants) || value.participants.length !== rows.length || !Array.isArray(value.payers) || !Array.isArray(value.routes) || !Array.isArray(value.classifications) || (value.customUserSettlement !== null && !Array.isArray(value.customUserSettlement))) throw new Error('Invalid shared metadata.');
  const identities = new Set<string>();
  const shares = value.participants.map((item) => {
    keys(item, 'identity,shareMinor,value');
    if (typeof item.identity !== 'string' || typeof item.value !== 'string' || identities.has(item.identity)) throw new Error('Invalid shared participant.');
    identities.add(item.identity);
    const row = rows.find((row) => (row.is_self ? selfIdentity : personIdentity(row.person_id!)) === item.identity);
    if (!row || row.share_minor !== item.shareMinor) throw new Error('Shared metadata references stale final shares.');
    return { name: row.name, isSelf: row.is_self === 1, personId: row.person_id, shareMinor: row.share_minor };
  });
  for (const payer of value.payers) { keys(payer, 'identity,paidMinor'); if (typeof payer.identity !== 'string') throw new Error('Invalid payer identity.'); }
  for (const route of value.routes) keys(route, 'amountMinor,from,to');
  for (const allocation of value.customUserSettlement ?? []) keys(allocation, 'amountMinor,identity');
  const balances: Record<string, number> = {};
  for (const classification of value.classifications) {
    keys(classification, 'balanceBeforeMinor,identity,type');
    if (typeof classification.identity !== 'string' || Object.hasOwn(balances, classification.identity) || !Number.isSafeInteger(classification.balanceBeforeMinor)) throw new Error('Invalid People classification metadata.');
    balances[classification.identity] = classification.balanceBeforeMinor;
  }
  const { definition } = createSharedDefinition(totalMinor, shares, { method: value.method, values: value.participants.map((item) => item.value), commonCostMinor: value.commonCostMinor }, value.payers, value.customUserSettlement ?? undefined, balances);
  if (JSON.stringify(definition.routes) !== JSON.stringify(value.routes) || JSON.stringify(definition.classifications) !== JSON.stringify(value.classifications)) throw new Error('Shared settlement or classification metadata does not match canonical math.');
  return value;
}

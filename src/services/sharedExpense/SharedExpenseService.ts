import type { AppDb } from '../../database/database';
import { makeId, nowIso } from '../../utils/id';
import type { PersonEntryType, TransactionSource } from '../../types/models';
import { isActivityDate, legacyReadOnlyMessage, readSharedEvent, type SharedEventRecords } from '../activity/ActivityService';
import { createSharedDefinition, decodeSharedDefinition, decodeSplitDefinition, encodeSplitDefinition, userRoutes, type SharedDefinition, type SplitEditorInput } from '../split/SplitDefinition';
import { exactSum, personIdentity, selfIdentity, type Contribution, type UserAllocation } from '../split/SharedBillCalculation';
import { calculatePersonBalance, resolvePeopleAction } from '../people/PeopleBalanceService';
import { minorUnitsToMoney } from '../../utils/money';

export type SharedExpenseShareInput = {
  name: string;
  personId?: string | null;
  isSelf: boolean;
  shareMinor: number;
  participantId?: string;
};

export type SharedExpensePostingInput = {
  splitGroupId?: string;
  financialEventId?: string;
  title: string;
  totalAmountMinor: number;
  categoryId: string;
  accountId: string;
  occurredOn: string;
  groupId?: string | null;
  payerPersonId?: string | null;
  payerName?: string;
  payerIsSelf: boolean;
  shares: SharedExpenseShareInput[];
  editor?: SplitEditorInput;
  personalTransactionId?: string;
  personEntryIds?: Record<string, string>;
  payers?: Contribution[];
  customUserSettlement?: UserAllocation[];
  crossingConfirmations?: Record<string, number>;
  peopleBalances?: Record<string, number>; // Prepared from the authoritative ledger in the transaction.
  peopleNames?: Record<string, string>;
};

export type SharedExpensePostingPlan = {
  splitGroup: {
    id: string;
    title: string;
    total_amount_minor: number;
    category_id: string;
    account_id: string;
    occurred_on: string;
    group_id?: string | null;
    financial_event_id: string;
    payer_person_id?: string | null;
    payer_name: string;
    payer_is_self: boolean;
    split_definition: string | null;
  };
  participants: {
    id: string;
    split_group_id: string;
    person_id?: string | null;
    name: string;
    is_self: boolean;
    share_minor: number;
  }[];
  personalExpenseTransaction?: {
    cash_effect_minor?: number | null;
    id: string;
    type: 'EXPENSE';
    amount_minor: number;
    account_id: string;
    category_id: string;
    title: string;
    note: string;
    occurred_on: string;
    source: TransactionSource;
    group_id: string;
    financial_event_id: string;
  };
  personEntries: {
    cash_effect_minor?: number | null;
    id: string;
    person_id: string;
    type: PersonEntryType;
    amount_minor: number;
    account_id: string;
    title: string;
    note: string;
    occurred_on: string;
    split_group_id: string;
    financial_event_id: string;
  }[];
  userShareMinor: number;
  accountCashOutflowMinor: number;
  personalExpenseMinor: number;
  definition?: SharedDefinition;
  crossings?: { personId: string; balanceBeforeMinor: number; amountMinor: number; action: 'GIVE' | 'BORROW'; nextBalanceMinor: number }[];
};

function stableSuffix(value: string, index: number): string {
  const clean = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return clean || `row_${index + 1}`;
}

export function buildSharedExpensePostingPlan(
  input: SharedExpensePostingInput,
): SharedExpensePostingPlan {
  if (input.payers !== undefined || (input.editor?.commonCostMinor ?? 0) !== 0) return buildModernSharedPlan(input);
  if (!Number.isSafeInteger(input.totalAmountMinor) || input.totalAmountMinor <= 0) throw new Error('Shared expense total must be positive.');
  if (!input.shares.length) throw new Error('Shared expense needs participants.');
  const shareTotal = input.shares.reduce((sum, share) => sum + share.shareMinor, 0);
  if (shareTotal !== input.totalAmountMinor)
    throw new Error('Participant shares must equal the shared expense total.');
  if (input.shares.some((share) => !Number.isSafeInteger(share.shareMinor) || share.shareMinor < 0))
    throw new Error('Participant shares cannot be negative.');
  const keys = input.shares.map((share) => share.isSelf ? 'SELF' : share.personId || share.name.trim().toLowerCase());
  if (new Set(keys).size !== keys.length || input.shares.some((share) => !share.name.trim() || (share.isSelf && share.personId)))
    throw new Error('Choose each participant once, including yourself.');
  if (!input.payerIsSelf && !input.payerPersonId)
    throw new Error('A non-user payer must reference a Person.');

  const splitGroupId = input.splitGroupId ?? makeId('split');
  const financialEventId = input.financialEventId ?? makeId('event');
  const payerName = input.payerIsSelf ? 'You' : (input.payerName ?? 'Person');
  const userShareMinor = input.shares
    .filter((share) => share.isSelf)
    .reduce((sum, share) => sum + share.shareMinor, 0);
  const personEntries: SharedExpensePostingPlan['personEntries'] = [];

  if (input.payerIsSelf) {
    for (const [index, share] of input.shares.entries()) {
      if (share.isSelf || !share.personId || share.shareMinor === 0) continue;
      const key = share.personId ?? stableSuffix(share.name, index);
      personEntries.push({
        id: input.personEntryIds?.[key] ?? makeId('entry'),
        person_id: share.personId,
        type: 'GIVEN',
        amount_minor: share.shareMinor,
        account_id: input.accountId,
        title: input.title,
        note: 'Shared expense paid by you',
        occurred_on: input.occurredOn,
        split_group_id: splitGroupId,
        financial_event_id: financialEventId,
      });
    }
  } else if (userShareMinor > 0 && input.payerPersonId) {
    personEntries.push({
      id: input.personEntryIds?.[input.payerPersonId] ?? makeId('entry'),
      person_id: input.payerPersonId,
      type: 'BORROWED_FROM',
      amount_minor: userShareMinor,
      account_id: input.accountId,
      title: input.title,
      note: `Your share from a shared expense paid by ${payerName}`,
      occurred_on: input.occurredOn,
      split_group_id: splitGroupId,
      financial_event_id: financialEventId,
    });
  }

  return {
    splitGroup: {
      id: splitGroupId,
      title: input.title,
      total_amount_minor: input.totalAmountMinor,
      category_id: input.categoryId,
      account_id: input.accountId,
      occurred_on: input.occurredOn,
      group_id: input.groupId ?? null,
      financial_event_id: financialEventId,
      payer_person_id: input.payerIsSelf ? null : input.payerPersonId,
      payer_name: payerName,
      payer_is_self: input.payerIsSelf,
      split_definition: encodeSplitDefinition(input.totalAmountMinor, input.shares, input.editor),
    },
    participants: input.shares.map((share, index) => ({
      id:
        share.participantId ??
        (input.splitGroupId
          ? `${splitGroupId}_${stableSuffix(share.personId ?? share.name, index)}`
          : makeId('participant')),
      split_group_id: splitGroupId,
      person_id: share.personId ?? null,
      name: share.isSelf ? 'You' : share.name,
      is_self: share.isSelf,
      share_minor: share.shareMinor,
    })),
    personalExpenseTransaction:
      userShareMinor > 0
        ? {
            id: input.personalTransactionId ?? makeId('tx'),
            type: 'EXPENSE',
            amount_minor: userShareMinor,
            account_id: input.accountId,
            category_id: input.categoryId,
            title: input.title,
            note: input.payerIsSelf
              ? 'Your share of a shared expense you paid.'
              : `Your share of a shared expense paid by ${payerName}.`,
            occurred_on: input.occurredOn,
            source: 'SPLIT',
            group_id: splitGroupId,
            financial_event_id: financialEventId,
          }
        : undefined,
    personEntries,
    userShareMinor,
    accountCashOutflowMinor: input.payerIsSelf ? input.totalAmountMinor : 0,
    personalExpenseMinor: userShareMinor,
  };
}

function buildModernSharedPlan(input: SharedExpensePostingInput): SharedExpensePostingPlan {
  const editor = input.editor ?? { method: 'Exact' as const, values: input.shares.map((share) => minorUnitsToMoney(share.shareMinor)) };
  const payers = input.payers ?? [{ identity: input.payerIsSelf ? selfIdentity : personIdentity(input.payerPersonId ?? ''), paidMinor: input.totalAmountMinor }];
  const { definition, result } = createSharedDefinition(input.totalAmountMinor, input.shares, editor, payers, input.customUserSettlement, input.peopleBalances);
  const primary = result.userPaidMinor > 0 ? selfIdentity : [...payers].sort((a, b) => b.paidMinor - a.paidMinor || (a.identity < b.identity ? -1 : 1))[0].identity;
  const payerIsSelf = primary === selfIdentity;
  const payerPersonId = payerIsSelf ? null : primary.slice(7);
  const payerName = payerIsSelf ? 'You' : input.peopleNames?.[primary] ?? input.shares.find((share) => share.personId === payerPersonId)?.name ?? input.payerName ?? 'Person';
  const splitGroupId = input.splitGroupId ?? makeId('split');
  const eventId = input.financialEventId ?? makeId('event');
  const crossings: NonNullable<SharedExpensePostingPlan['crossings']> = [];
  const entries = userRoutes(result.routes).map((route) => {
    const classification = definition.classifications.find((item) => item.identity === route.identity)!;
    const resolved = resolvePeopleAction(classification.balanceBeforeMinor, route.action, route.amountMinor);
    if (!Number.isSafeInteger(resolved.nextBalance)) throw new Error('People balance is outside the supported range.');
    const personId = route.identity.slice(7);
    if (resolved.requiresCrossingConfirmation) crossings.push({ personId, balanceBeforeMinor: classification.balanceBeforeMinor, action: route.action, amountMinor: route.amountMinor, nextBalanceMinor: resolved.nextBalance });
    return { id: input.personEntryIds?.[personId] ?? makeId('entry'), person_id: personId, type: resolved.type, amount_minor: route.amountMinor,
      account_id: input.accountId, title: input.title, note: route.action === 'GIVE' ? 'Your bill-specific receivable' : 'Your bill-specific payable', occurred_on: input.occurredOn,
      split_group_id: splitGroupId, financial_event_id: eventId, cash_effect_minor: result.userShareMinor === 0 ? -route.amountMinor : 0 };
  });
  // A zero-share user can only be a creditor (or settled); its receivable
  // funding effects sum exactly to paid. Otherwise the one recognition owns cash.
  if (result.userShareMinor === 0 && exactSum(entries.map((entry) => -entry.cash_effect_minor)) !== result.userPaidMinor) throw new Error('Shared funding effects do not match the user contribution.');
  return {
    splitGroup: { id: splitGroupId, title: input.title, total_amount_minor: input.totalAmountMinor, category_id: input.categoryId, account_id: input.accountId,
      occurred_on: input.occurredOn, group_id: input.groupId ?? null, financial_event_id: eventId, payer_person_id: payerPersonId, payer_name: payerName, payer_is_self: payerIsSelf, split_definition: JSON.stringify(definition) },
    participants: input.shares.map((share) => ({ id: share.participantId ?? makeId('participant'), split_group_id: splitGroupId, person_id: share.isSelf ? null : share.personId, name: share.isSelf ? 'You' : share.name, is_self: share.isSelf, share_minor: share.shareMinor })),
    personalExpenseTransaction: result.userShareMinor > 0 ? { id: input.personalTransactionId ?? makeId('tx'), type: 'EXPENSE', amount_minor: result.userShareMinor,
      account_id: input.accountId, category_id: input.categoryId, title: input.title, note: 'Your final consumption share; funding is recorded separately.', occurred_on: input.occurredOn,
      source: 'SPLIT', group_id: splitGroupId, financial_event_id: eventId, cash_effect_minor: -result.userPaidMinor } : undefined,
    personEntries: entries, userShareMinor: result.userShareMinor, personalExpenseMinor: result.userShareMinor, accountCashOutflowMinor: result.userPaidMinor, definition, crossings,
  };
}

export async function persistSharedExpensePostingPlan(
  db: AppDb,
  plan: SharedExpensePostingPlan,
): Promise<void> {
  const ts = nowIso();
  await db.runAsync(
    'INSERT INTO split_groups (id, title, total_amount_minor, category_id, account_id, occurred_on, group_id, financial_event_id, payer_person_id, payer_name, payer_is_self, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);',
    plan.splitGroup.id,
    plan.splitGroup.title,
    plan.splitGroup.total_amount_minor,
    plan.splitGroup.category_id,
    plan.splitGroup.account_id,
    plan.splitGroup.occurred_on,
    plan.splitGroup.group_id ?? null,
    plan.splitGroup.financial_event_id,
    plan.splitGroup.payer_person_id ?? null,
    plan.splitGroup.payer_name,
    plan.splitGroup.payer_is_self ? 1 : 0,
    ts,
    ts,
    'LOCAL',
  );
  await db.runAsync('UPDATE split_groups SET split_definition = ? WHERE id = ?;', plan.splitGroup.split_definition, plan.splitGroup.id);
  for (const participant of plan.participants)
    await db.runAsync(
      'INSERT INTO split_participants (id, split_group_id, person_id, name, is_self, share_minor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?);',
      participant.id,
      participant.split_group_id,
      participant.person_id ?? null,
      participant.name,
      participant.is_self ? 1 : 0,
      participant.share_minor,
      ts,
    );
  if (plan.personalExpenseTransaction)
    await db.runAsync(
      'INSERT INTO transactions (id, type, amount_minor, account_id, destination_account_id, category_id, title, note, occurred_on, source, group_id, financial_event_id, created_at, updated_at, sync_status, cash_effect_minor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);',
      plan.personalExpenseTransaction.id,
      plan.personalExpenseTransaction.type,
      plan.personalExpenseTransaction.amount_minor,
      plan.personalExpenseTransaction.account_id,
      null,
      plan.personalExpenseTransaction.category_id,
      plan.personalExpenseTransaction.title,
      plan.personalExpenseTransaction.note,
      plan.personalExpenseTransaction.occurred_on,
      plan.personalExpenseTransaction.source,
      plan.personalExpenseTransaction.group_id,
      plan.personalExpenseTransaction.financial_event_id,
      ts,
      ts,
      'LOCAL',
      plan.personalExpenseTransaction.cash_effect_minor ?? null,
    );
  for (const entry of plan.personEntries)
    await db.runAsync(
      'INSERT INTO person_entries (id, person_id, type, amount_minor, account_id, title, note, occurred_on, split_group_id, financial_event_id, created_at, updated_at, sync_status, cash_effect_minor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);',
      entry.id,
      entry.person_id,
      entry.type,
      entry.amount_minor,
      entry.account_id,
      entry.title,
      entry.note,
      entry.occurred_on,
      entry.split_group_id,
      entry.financial_event_id,
      ts,
      ts,
      'LOCAL',
      entry.cash_effect_minor ?? null,
    );
}

export async function saveSharedExpensePosting(
  db: AppDb,
  input: SharedExpensePostingInput,
): Promise<SharedExpensePostingPlan> {
  let plan!: SharedExpensePostingPlan;
  await db.withExclusiveTransactionAsync(async (txn) => {
    plan = buildSharedExpensePostingPlan(await prepareSharedInput(txn, input));
    const event = plan.splitGroup.financial_event_id;
    if (await txn.getFirstAsync('SELECT id FROM split_groups WHERE financial_event_id = ? UNION ALL SELECT id FROM transactions WHERE financial_event_id = ? UNION ALL SELECT id FROM person_entries WHERE financial_event_id = ? LIMIT 1;', event, event, event))
      throw new Error('This shared activity has already been saved.');
    await persistSharedExpensePostingPlan(txn, plan);
  });
  return plan;
}

async function prepareSharedInput(db: AppDb, input: SharedExpensePostingInput, persistedPersonIds = new Set<string>()): Promise<SharedExpensePostingInput> {
  const modern = input.payers !== undefined || (input.editor?.commonCostMinor ?? 0) !== 0;
  if (!modern) buildSharedExpensePostingPlan(input);
  if (!input.title.trim() || !isActivityDate(input.occurredOn)) throw new Error('Enter a title and valid date.');
  const paid = modern ? input.payers?.find((payer) => payer.identity === selfIdentity)?.paidMinor ?? (input.payerIsSelf && input.payers === undefined ? input.totalAmountMinor : 0) : input.payerIsSelf ? input.totalAmountMinor : 0;
  const accountId = modern && !input.accountId && paid === 0 ? 'account_cash_default' : input.accountId;
  if (!await db.getFirstAsync(`SELECT id FROM accounts WHERE id = ? AND deleted_at IS NULL ${!modern || paid > 0 ? 'AND is_archived = 0' : ''};`, accountId)) throw new Error('Choose an active account.');
  if (!await db.getFirstAsync("SELECT id FROM categories WHERE id = ? AND type = 'EXPENSE' AND deleted_at IS NULL AND is_archived = 0;", input.categoryId)) throw new Error('Choose an expense category.');
  if (input.groupId && !await db.getFirstAsync('SELECT id FROM groups WHERE id = ? AND deleted_at IS NULL AND is_archived = 0;', input.groupId)) throw new Error('Group is unavailable or archived.');
  const shares: SharedExpenseShareInput[] = [];
  for (const share of input.shares) {
    if (typeof share.isSelf !== 'boolean' || (share.isSelf && share.personId)) throw new Error('Invalid self/Person reference.');
    if (share.isSelf) { shares.push({ ...share, personId: null }); continue; }
    let person = share.personId
      ? await db.getFirstAsync<{ id: string; name: string; is_archived: number }>('SELECT id, name, is_archived FROM people WHERE id = ? AND deleted_at IS NULL;', share.personId)
      : await db.getFirstAsync<{ id: string; name: string }>('SELECT id, name FROM people WHERE lower(name) = lower(?) AND deleted_at IS NULL AND is_archived = 0;', share.name.trim());
    if (person && 'is_archived' in person && person.is_archived && !persistedPersonIds.has(person.id)) throw new Error('Participant is archived.');
    if (!person && share.personId) throw new Error('Participant is unavailable.');
    if (!person) {
      const archived = await db.getFirstAsync('SELECT id FROM people WHERE lower(trim(name)) = lower(?) AND deleted_at IS NULL AND is_archived = 1;', share.name.trim());
      if (archived) throw new Error('A person with this name is archived.');
      person = { id: makeId('person'), name: share.name.trim() };
      await db.runAsync('INSERT INTO people (id, name, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?);', person.id, person.name, nowIso(), nowIso(), 'LOCAL');
    }
    shares.push({ ...share, personId: person.id, name: person.name });
  }
  if (modern) {
    const payers = input.payers ?? [{ identity: input.payerIsSelf ? selfIdentity : personIdentity(input.payerPersonId ?? ''), paidMinor: input.totalAmountMinor }];
    const names: Record<string, string> = {};
    for (const payer of payers) if (payer.identity !== selfIdentity) {
      const personId = payer.identity.startsWith('PERSON:') ? payer.identity.slice(7) : '';
      const person = await db.getFirstAsync<{ name: string; is_archived: number }>('SELECT name, is_archived FROM people WHERE id = ? AND deleted_at IS NULL;', personId);
      if (!person || (person.is_archived && !persistedPersonIds.has(personId))) throw new Error('Choose an available active payer.');
      names[payer.identity] = person.name;
    }
    // People balances are matched only in the currency of the bill's account.
    const ledger = await db.getAllAsync<import('../../types/models').PersonEntry>('SELECT * FROM person_entries WHERE deleted_at IS NULL AND (split_group_id IS NULL OR split_group_id <> ?) AND account_id IN (SELECT id FROM accounts WHERE currency IS (SELECT currency FROM accounts WHERE id = ?));', input.splitGroupId ?? '', accountId);
    const balances: Record<string, number> = {};
    for (const personId of new Set(shares.flatMap((share) => share.personId ? [share.personId] : []).concat(payers.filter((payer) => payer.identity !== selfIdentity).map((payer) => payer.identity.slice(7))))) balances[personIdentity(personId)] = calculatePersonBalance(ledger.filter((entry) => entry.person_id === personId));
    const prepared = { ...input, title: input.title.trim(), accountId, shares, payers, peopleBalances: balances, peopleNames: names };
    const plan = buildSharedExpensePostingPlan(prepared);
    for (const crossing of plan.crossings ?? []) if (input.crossingConfirmations?.[crossing.personId] !== crossing.balanceBeforeMinor) throw new Error(`Confirm the People balance crossing for ${crossing.personId} at ${crossing.balanceBeforeMinor} minor units.`);
    return prepared;
  }
  const payer = input.payerIsSelf ? null : await db.getFirstAsync<{ name: string; is_archived: number }>('SELECT name, is_archived FROM people WHERE id = ? AND deleted_at IS NULL;', input.payerPersonId ?? null);
  if (payer?.is_archived && !persistedPersonIds.has(input.payerPersonId!)) throw new Error('The payer is archived.');
  if (!input.payerIsSelf && !payer) throw new Error('Choose who paid.');
  return { ...input, title: input.title.trim(), shares, payerName: payer?.name ?? 'You' };
}

export async function sharedReadOnlyReason(db: AppDb, records: SharedEventRecords): Promise<string | null> {
  const { split: s } = records;
  if (await db.getFirstAsync('SELECT 1 FROM person_entries e WHERE e.split_group_id = ? AND (EXISTS (SELECT 1 FROM entry_allocations a WHERE a.target_entry_id = e.id OR a.source_entry_id = e.id) OR EXISTS (SELECT 1 FROM allocation_exclusions x WHERE x.target_entry_id = e.id)) LIMIT 1;', s.id)) return 'This shared expense has reconciled payments. Its original amounts and participants must be preserved.';
  if (s.group_id && await db.getFirstAsync('SELECT 1 FROM groups WHERE id = ? AND is_archived = 1;', s.group_id)) return 'This group is archived. Historical expenses are read-only.';
  return sharedIntegrityReason(db, records);
}

// Financial validity is independent of whether a valid event is now locked by allocations/archive.
export async function sharedIntegrityReason(db: AppDb, records: SharedEventRecords): Promise<string | null> {
  const { split: s, participants, transactions, entries } = records;
  if (!s.financial_event_id || !participants.length || ![0, 1].includes(s.payer_is_self)) return legacyReadOnlyMessage;
  const siblings = await db.getAllAsync<{ id: string }>('SELECT id FROM split_groups WHERE financial_event_id = ?;', s.financial_event_id);
  if (siblings.length !== 1) return legacyReadOnlyMessage;
  if (transactions.some((t) => t.deleted_at || t.source !== 'SPLIT' || (t.group_id && t.group_id !== s.id) || t.financial_event_id !== s.financial_event_id) || entries.some((e) => e.deleted_at || e.split_group_id !== s.id || e.financial_event_id !== s.financial_event_id)) return legacyReadOnlyMessage;
  try {
    const input = reopenSharedExpenseInput(records);
    const plan = buildSharedExpensePostingPlan(input);
    if (participants.some((p) => ![0, 1].includes(p.is_self) || (!p.is_self && !p.person_id)) || (s.payer_is_self === 1 && s.payer_person_id)) return legacyReadOnlyMessage;
    if (transactions.length !== (plan.personalExpenseTransaction ? 1 : 0) || entries.length !== plan.personEntries.length) return legacyReadOnlyMessage;
    if (transactions.some((t) => t.type !== 'EXPENSE' || t.destination_account_id || t.amount_minor !== plan.userShareMinor || t.account_id !== s.account_id || t.category_id !== s.category_id || t.occurred_on !== s.occurred_on)) return legacyReadOnlyMessage;
    if (transactions.some((t) => (t.cash_effect_minor ?? null) !== (plan.personalExpenseTransaction?.cash_effect_minor ?? null))) return legacyReadOnlyMessage;
    if (s.payer_is_self !== (plan.splitGroup.payer_is_self ? 1 : 0) || (s.payer_person_id ?? null) !== (plan.splitGroup.payer_person_id ?? null)) return legacyReadOnlyMessage;
    if (plan.personEntries.some((expected) => entries.filter((e) => e.person_id === expected.person_id && e.type === expected.type && e.amount_minor === expected.amount_minor && e.account_id === s.account_id && e.occurred_on === s.occurred_on && (e.cash_effect_minor ?? null) === (expected.cash_effect_minor ?? null)).length !== 1)) return legacyReadOnlyMessage;
    return null;
  } catch { return legacyReadOnlyMessage; }
}

/** Rebuilds the full form input of a saved shared expense for editing; stable IDs, never names. */
export function reopenSharedExpenseInput(records: SharedEventRecords): SharedExpensePostingInput {
  const { split, participants } = records;
  const decoded = decodeSplitDefinition(split.split_definition, split.total_amount_minor, participants);
  const ordered = decoded?.participants ?? participants;
  const input: SharedExpensePostingInput = { splitGroupId: split.id, financialEventId: split.financial_event_id ?? undefined,
    title: split.title, totalAmountMinor: split.total_amount_minor, categoryId: split.category_id, accountId: split.account_id, occurredOn: split.occurred_on,
    groupId: split.group_id, payerIsSelf: split.payer_is_self === 1, payerPersonId: split.payer_person_id, payerName: split.payer_name,
    shares: ordered.map((row) => ({ name: row.name, isSelf: row.is_self === 1, personId: row.person_id, shareMinor: row.share_minor, participantId: row.id })) };
  if (split.split_definition && JSON.parse(split.split_definition).version === 2) {
    const definition = decodeSharedDefinition(split.split_definition, split.total_amount_minor, participants);
    return { ...input, editor: { method: definition.method, values: definition.participants.map((row) => row.value), commonCostMinor: definition.commonCostMinor },
      payers: definition.payers, customUserSettlement: definition.customUserSettlement ?? undefined,
      peopleBalances: Object.fromEntries(definition.classifications.map((row) => [row.identity, row.balanceBeforeMinor])) };
  }
  // Integrity remains independent of unknown legacy editor intent.
  return decoded ? { ...input, editor: { method: decoded.method, values: ordered.map((row) => decoded.values[row.is_self ? selfIdentity : personIdentity(row.person_id!)]) } } : input;
}

/**
 * An expense another person paid for you in full. It is a shared bill with you
 * as the only participant: the whole amount is your spending, no account money
 * moves, and the person's balance changes by the amount in the bill's currency.
 */
export function paidByPersonExpenseInput(input: {
  personId: string; personName: string; amountMinor: number; categoryId: string;
  accountId: string; title: string; occurredOn: string;
}): SharedExpensePostingInput {
  return {
    title: input.title, totalAmountMinor: input.amountMinor, categoryId: input.categoryId, accountId: input.accountId,
    occurredOn: input.occurredOn, groupId: null, payerIsSelf: false, payerPersonId: input.personId, payerName: input.personName,
    shares: [{ name: 'You', isSelf: true, shareMinor: input.amountMinor }],
    editor: { method: 'Equal', values: [''], commonCostMinor: 0 },
    payers: [{ identity: personIdentity(input.personId), paidMinor: input.amountMinor }],
  };
}

export async function previewSharedExpensePosting(db: AppDb, input: SharedExpensePostingInput) {
  const ledger = await db.getAllAsync<import('../../types/models').PersonEntry>('SELECT * FROM person_entries WHERE deleted_at IS NULL AND (split_group_id IS NULL OR split_group_id <> ?) AND account_id IN (SELECT id FROM accounts WHERE currency IS (SELECT currency FROM accounts WHERE id = ?));', input.splitGroupId ?? '', input.accountId);
  const personIds = new Set(input.shares.flatMap((share) => share.personId ? [share.personId] : []).concat((input.payers ?? []).filter((payer) => payer.identity !== selfIdentity).map((payer) => payer.identity.slice(7))));
  return buildSharedExpensePostingPlan({ ...input, peopleBalances: Object.fromEntries([...personIds].map((id) => [personIdentity(id), calculatePersonBalance(ledger.filter((entry) => entry.person_id === id))])) });
}

async function removeSharedRecords(db: AppDb, records: SharedEventRecords) {
  // Remove the recognition and its cash-neutralizing debt in the SAME transaction.
  for (const tx of records.transactions) await db.runAsync('DELETE FROM transactions WHERE id = ?;', tx.id);
  for (const entry of records.entries) await db.runAsync('DELETE FROM person_entries WHERE id = ?;', entry.id);
  for (const participant of records.participants) await db.runAsync('DELETE FROM split_participants WHERE id = ?;', participant.id);
  await db.runAsync('DELETE FROM split_groups WHERE id = ?;', records.split.id);
}

export async function updateSharedExpense(db: AppDb, id: string, expectedUpdatedAt: string, input: SharedExpensePostingInput): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    const records = await readSharedEvent(txn, id);
    if (records.split.updated_at !== expectedUpdatedAt) throw new Error('Activity changed. Reopen it before editing.');
    const reason = await sharedReadOnlyReason(txn, records);
    if (reason) throw new Error(reason);
    const oldDefinition = records.split.split_definition ? JSON.parse(records.split.split_definition) : null;
    if (oldDefinition?.version === 2 && input.payers === undefined) throw new Error('Reopen with the saved payer contributions before editing this shared bill.');
    const persistedPersonIds = new Set(records.participants.flatMap((participant) => participant.person_id ? [participant.person_id] : []));
    if (oldDefinition?.version === 2) for (const payer of oldDefinition.payers as Contribution[]) if (payer.identity !== selfIdentity) persistedPersonIds.add(payer.identity.slice(7));
    if (records.split.payer_person_id) persistedPersonIds.add(records.split.payer_person_id);
    const prepared = await prepareSharedInput(txn, { ...input, splitGroupId: id, groupId: records.split.group_id }, persistedPersonIds);
    const plan = buildSharedExpensePostingPlan({ ...prepared, splitGroupId: id, financialEventId: records.split.financial_event_id!, personalTransactionId: makeId('tx'), personEntryIds: undefined, shares: prepared.shares.map((s) => ({ ...s, participantId: makeId('participant') })) });
    await removeSharedRecords(txn, records);
    await persistSharedExpensePostingPlan(txn, plan);
    // Non-demo participant IDs adopt the complete event through demo cleanup's reference graph.
    await txn.runAsync('UPDATE split_groups SET created_at = ?, updated_at = ? WHERE id = ?;', records.split.created_at, new Date(Math.max(Date.now(), Date.parse(expectedUpdatedAt) + 1)).toISOString(), id);
  });
}

export async function deleteSharedExpense(db: AppDb, id: string, expectedUpdatedAt: string): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    const records = await readSharedEvent(txn, id);
    if (records.split.updated_at !== expectedUpdatedAt) throw new Error('Activity changed. Reopen it before deleting.');
    const reason = await sharedReadOnlyReason(txn, records);
    if (reason) throw new Error(reason);
    await removeSharedRecords(txn, records);
  });
}

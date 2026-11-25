import type { AppDb } from '../../database/database';
import type { Group, GroupMember, PersonEntry, SplitGroup, SplitParticipant } from '../../types/models';
import { calculatePersonBalance, resolvePeopleAction } from '../people/PeopleBalanceService';
import { recordPeopleActionInTransaction } from '../people/PersonService';
import { calculateAccountBalance } from '../finance/FinanceService';
import { isActivityDate, readSharedEvent } from '../activity/ActivityService';
import { sharedIntegrityReason } from '../sharedExpense/SharedExpenseService';
import { makeId, nowIso } from '../../utils/id';
import * as repo from '../../database/repositories/repositories';
import { orderCurrencies } from '../currency/CurrencyScope';

export type AllocationTarget = PersonEntry & { group_id: string | null; expense_title: string; direction: number; remaining_minor: number };
export type AllocationSource = PersonEntry & { account_name: string; cash_direction: number; available_minor: number };
export type AllocationCandidate = { source: AllocationSource; target: AllocationTarget };
export type GroupPosition = { personId: string; name: string; balanceMinor: number; owedMinor: number; oweMinor: number; ambiguous: boolean };
export type GroupSnapshot = {
  group: Group; members: (GroupMember & { name: string })[];
  expenses: (SplitGroup & { account_name: string; category_name: string })[];
  participants: SplitParticipant[]; targets: AllocationTarget[]; candidates: AllocationCandidate[];
  exclusions: { source_entry_id: string; target_entry_id: string; source_title: string; target_title: string }[];
  history: (PersonEntry & { allocated_minor: number; person_name: string })[];
  offsets: { id: string; person_id: string; person_name: string; source_title: string; target_title: string; amount_minor: number; created_at: string; occurred_on: string; note: string | null }[];
  positions: GroupPosition[]; balanceMinor: number; ambiguous: boolean; invalidHistory: boolean; revision: string;
  /** Currencies of the group's bills, main currency first. Every amount above is in `currency`. */
  currencies: string[]; currency: string;
};

function safeSum(values: number[]) {
  return values.reduce((sum, value) => {
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(sum + value)) throw new Error('Amount is outside the supported range.');
    return sum + value;
  }, 0);
}

export function groupPositionLabel(snapshot: Pick<GroupSnapshot, 'ambiguous' | 'balanceMinor' | 'targets'>): string {
  if (snapshot.ambiguous) return 'Reconciliation needed';
  if (snapshot.balanceMinor > 0) return 'You are owed';
  if (snapshot.balanceMinor < 0) return 'You owe';
  return snapshot.targets.some((target) => target.remaining_minor > 0) ? 'Net zero; open amounts in both directions' : 'Settled';
}

/**
 * A group's bills, debts and payments in one currency (amounts in different
 * currencies never add up or cancel out). Without a currency: the group's first.
 */
export async function readGroupSnapshot(db: AppDb, groupId: string, currency?: string): Promise<GroupSnapshot> {
  const group = await db.getFirstAsync<Group>('SELECT * FROM groups WHERE id = ? AND deleted_at IS NULL;', groupId);
  if (!group) throw new Error('Group is unavailable.');
  const currencyOf = new Map((await db.getAllAsync<{ id: string; currency: string }>('SELECT id, currency FROM accounts;')).map((row) => [row.id, row.currency]));
  const main = await repo.mainCurrency(db);
  const allExpenses = await db.getAllAsync<{ account_id: string }>('SELECT account_id FROM split_groups WHERE group_id = ? AND deleted_at IS NULL;', groupId);
  const currencies = orderCurrencies(allExpenses.map((row) => currencyOf.get(row.account_id) ?? main), main);
  const selected = currency ?? currencies[0] ?? main;
  const inCurrency = (accountId: string) => (currencyOf.get(accountId) ?? main) === selected;
  const members = await db.getAllAsync<GroupSnapshot['members'][number]>("SELECT m.*, CASE WHEN m.is_self = 1 THEN 'You' ELSE coalesce(p.name,'Unavailable person') END name FROM group_members m LEFT JOIN people p ON p.id = m.person_id WHERE m.group_id = ? ORDER BY m.is_self DESC, name;", groupId);
  const allExpenseRows = await db.getAllAsync<GroupSnapshot['expenses'][number]>("SELECT s.*, coalesce(person.name,s.payer_name) payer_name, coalesce(a.name,'Unavailable account') account_name, coalesce(c.name,'Category') category_name FROM split_groups s LEFT JOIN people person ON person.id = s.payer_person_id LEFT JOIN accounts a ON a.id = s.account_id LEFT JOIN categories c ON c.id = s.category_id WHERE s.group_id = ? AND s.deleted_at IS NULL ORDER BY s.occurred_on DESC, s.id;", groupId);
  const expenses = allExpenseRows.filter((expense) => inCurrency(expense.account_id));
  const allParticipants = await db.getAllAsync<SplitParticipant>('SELECT p.*, coalesce(person.name,p.name) name FROM split_participants p LEFT JOIN people person ON person.id = p.person_id JOIN split_groups s ON s.id = p.split_group_id WHERE s.group_id = ? AND s.deleted_at IS NULL ORDER BY p.created_at, p.id;', groupId);
  const participants = allParticipants.filter((participant) => expenses.some((expense) => expense.id === participant.split_group_id));
  const allTargets = await db.getAllAsync<AllocationTarget>('SELECT * FROM allocation_targets WHERE group_id = ? ORDER BY id;', groupId);
  const raw = await db.getAllAsync<{ id: string }>('SELECT e.id FROM person_entries e JOIN split_groups s ON s.id = e.split_group_id WHERE s.group_id = ? AND s.deleted_at IS NULL AND e.deleted_at IS NULL;', groupId);
  let invalidHistory = raw.some((row) => !allTargets.some((target) => target.id === row.id));
  for (const expense of allExpenseRows) if (await sharedIntegrityReason(db, await readSharedEvent(db, expense.id))) invalidHistory = true;
  const targets = allTargets.filter((target) => inCurrency(target.account_id));
  const sources = (await db.getAllAsync<AllocationSource>('SELECT * FROM allocation_sources WHERE split_group_id IS NULL AND available_minor > 0 ORDER BY occurred_on, id;')).filter((source) => inCurrency(source.account_id));
  const exclusions = await db.getAllAsync<GroupSnapshot['exclusions'][number]>('SELECT x.*, source.title source_title, target.title target_title FROM allocation_exclusions x JOIN person_entries source ON source.id = x.source_entry_id JOIN allocation_targets target ON target.id = x.target_entry_id WHERE target.group_id = ? AND (SELECT currency FROM accounts WHERE id = target.account_id) IS ?;', groupId, selected);
  const candidates = targets.flatMap((target) => target.remaining_minor <= 0 ? [] : sources.filter((source) => source.person_id === target.person_id && source.cash_direction === target.direction && !exclusions.some((x) => x.source_entry_id === source.id && x.target_entry_id === target.id)).map((source) => ({ source, target })));
  const names = await repo.listAllPeople(db);
  const positions = [...new Set([...targets.map((t) => t.person_id), ...members.flatMap((m) => m.person_id ? [m.person_id] : [])])].map((personId) => {
    const own = targets.filter((t) => t.person_id === personId);
    const owedMinor = safeSum(own.filter((t) => t.direction > 0).map((t) => t.remaining_minor));
    const oweMinor = safeSum(own.filter((t) => t.direction < 0).map((t) => t.remaining_minor));
    return { personId, name: names.find((p) => p.id === personId)?.name ?? 'Unavailable person', owedMinor, oweMinor, balanceMinor: safeSum([owedMinor, -oweMinor]), ambiguous: invalidHistory || candidates.some((c) => c.target.person_id === personId) };
  });
  const history = (await db.getAllAsync<GroupSnapshot['history'][number]>('SELECT source.*, sum(a.amount_minor) allocated_minor, p.name person_name FROM entry_allocations a JOIN person_entries source ON source.id = a.source_entry_id JOIN allocation_targets target ON target.id = a.target_entry_id JOIN people p ON p.id = source.person_id WHERE target.group_id = ? AND source.split_group_id IS NULL GROUP BY source.id ORDER BY source.occurred_on DESC, source.created_at DESC;', groupId)).filter((entry) => inCurrency(entry.account_id));
  const offsets = await db.getAllAsync<GroupSnapshot['offsets'][number]>(`SELECT a.id, a.amount_minor, a.created_at, source.person_id, p.name person_name, source.expense_title source_title, target.expense_title target_title,
    coalesce(json_extract(request.request_json, '$.occurredOn'), substr(a.created_at,1,10)) occurred_on, json_extract(request.request_json, '$.note') note
    FROM entry_allocations a JOIN allocation_targets source ON source.id = a.source_entry_id JOIN allocation_targets target ON target.id = a.target_entry_id JOIN people p ON p.id = source.person_id
    LEFT JOIN group_settlement_requests request ON EXISTS (SELECT 1 FROM json_each(request.request_json, '$.offsets') item WHERE a.id = request.id || '_offset_' || item.key)
    WHERE target.group_id = ? AND (SELECT currency FROM accounts WHERE id = target.account_id) IS ? ORDER BY occurred_on, a.created_at, a.id;`, groupId, selected);
  return { group, members, expenses, participants, targets, candidates, exclusions, history, offsets, positions, invalidHistory, currencies: currencies.length ? currencies : [selected], currency: selected,
    ambiguous: invalidHistory || candidates.length > 0, balanceMinor: safeSum(positions.map((p) => p.balanceMinor)),
    revision: JSON.stringify([selected, group.updated_at, targets.map((t) => [t.id, t.remaining_minor]), candidates.map((c) => [c.source.id, c.source.available_minor, c.target.id]), invalidHistory]),
  };
}

export function groupPersonLedger(snapshot: GroupSnapshot, personId: string) {
  const name = snapshot.positions.find((position) => position.personId === personId)?.name ?? 'this person';
  const obligations = snapshot.targets.filter((target) => target.person_id === personId).map((target) => ({
    id: target.id, title: target.expense_title, occurredOn: target.occurred_on, createdAt: target.created_at,
    description: target.direction > 0 ? `You paid for ${name}` : `${name} paid for you`,
    direction: target.direction > 0 ? `${name} owes you` : `You owe ${name}`,
    deltaMinor: target.direction * target.amount_minor, remainingMinor: target.remaining_minor, offsetMinor: 0, note: target.note ?? null,
  }));
  const payments = snapshot.history.filter((entry) => entry.person_id === personId).map((entry) => {
    const sent = ['GIVEN', 'PAID_BACK'].includes(entry.type);
    return { id: entry.id, title: sent ? 'Payment sent' : 'Payment received', occurredOn: entry.occurred_on, createdAt: entry.created_at,
      description: sent ? `You paid ${name}` : `${name} paid you`, direction: 'Recorded group payment', deltaMinor: sent ? entry.allocated_minor : -entry.allocated_minor, remainingMinor: null, offsetMinor: 0, note: entry.note ?? null };
  });
  const offsets = snapshot.offsets.filter((offset) => offset.person_id === personId).map((offset) => ({
    id: offset.id, title: 'Confirmed offset', occurredOn: offset.occurred_on, createdAt: offset.created_at,
    description: `${offset.source_title} against ${offset.target_title}`, direction: 'No money moved', deltaMinor: 0, remainingMinor: null, offsetMinor: offset.amount_minor, note: offset.note,
  }));
  return [...obligations, ...payments, ...offsets].sort((a, b) => a.occurredOn.localeCompare(b.occurredOn) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export async function reconcileAllocation(db: AppDb, input: { id: string; sourceEntryId: string; targetEntryId: string; amountMinor: number }): Promise<void> {
  if (!input.id.trim() || !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new Error('Enter an amount greater than zero.');
  await db.withExclusiveTransactionAsync(async (txn) => {
    await requireActiveTargetGroup(txn, input.targetEntryId);
    const existing = await txn.getFirstAsync<{ source_entry_id: string; target_entry_id: string; amount_minor: number }>('SELECT * FROM entry_allocations WHERE id = ?;', input.id);
    if (existing) {
      if (existing.source_entry_id !== input.sourceEntryId || existing.target_entry_id !== input.targetEntryId || existing.amount_minor !== input.amountMinor) throw new Error('This request was already used for different details.');
      return;
    }
    const target = await txn.getFirstAsync<AllocationTarget>('SELECT * FROM allocation_targets WHERE id = ?;', input.targetEntryId);
    if (!target || await sharedIntegrityReason(txn, await readSharedEvent(txn, target.split_group_id!))) throw new Error('This shared obligation has invalid links and cannot be reconciled.');
    const source = await txn.getFirstAsync<AllocationSource>('SELECT * FROM allocation_sources WHERE id = ?;', input.sourceEntryId);
    if (source?.split_group_id) throw new Error('Use an explicitly confirmed net settlement to offset obligations.');
    await txn.runAsync('INSERT INTO entry_allocations (id, source_entry_id, target_entry_id, amount_minor, created_at) VALUES (?, ?, ?, ?, ?);', input.id, input.sourceEntryId, input.targetEntryId, input.amountMinor, nowIso());
  });
}

export async function setAllocationUnrelated(db: AppDb, sourceEntryId: string, targetEntryId: string, unrelated: boolean): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    await requireActiveTargetGroup(txn, targetEntryId);
    if (unrelated) {
      if (await txn.getFirstAsync('SELECT 1 FROM allocation_exclusions WHERE source_entry_id = ? AND target_entry_id = ?;', sourceEntryId, targetEntryId)) return;
      await txn.runAsync('INSERT INTO allocation_exclusions (source_entry_id, target_entry_id, created_at) VALUES (?, ?, ?);', sourceEntryId, targetEntryId, nowIso());
    } else await txn.runAsync('DELETE FROM allocation_exclusions WHERE source_entry_id = ? AND target_entry_id = ?;', sourceEntryId, targetEntryId);
  });
}

async function requireActiveTargetGroup(db: AppDb, targetId: string): Promise<void> {
  const group = await db.getFirstAsync<{ is_archived: number }>('SELECT g.is_archived FROM person_entries e JOIN split_groups s ON s.id = e.split_group_id JOIN groups g ON g.id = s.group_id WHERE e.id = ?;', targetId);
  if (group?.is_archived) throw new Error('This group is archived. Restore it before changing reconciliation.');
}

export type GroupSettlementInput = {
  requestId: string; groupId: string; personId: string; accountId: string; occurredOn: string;
  targets: { targetEntryId: string; amountMinor: number }[];
  expectedRevision: string; expectedBalanceMinor: number; crossingConfirmed?: boolean;
  offsets?: { sourceEntryId: string; targetEntryId: string; amountMinor: number }[];
  nettingConfirmed?: boolean;
  note?: string;
};

/** Only routing existing group obligations; classification/cash stays in People. */
export function buildGroupNetSettlement(targets: AllocationTarget[], personId: string, cashMinor: number) {
  if (targets.some((target) => target.person_id === personId && (!Number.isSafeInteger(target.remaining_minor) || target.remaining_minor < 0 || ![1, -1].includes(target.direction)))) throw new Error('Invalid group obligation amount or direction.');
  const ordered = targets.filter((target) => target.person_id === personId && target.remaining_minor > 0)
    .sort((a, b) => a.occurred_on.localeCompare(b.occurred_on) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    .map((target) => ({ ...target }));
  const owed = ordered.filter((target) => target.direction === 1);
  const owe = ordered.filter((target) => target.direction === -1);
  const owedMinor = safeSum(owed.map((target) => target.remaining_minor));
  const oweMinor = safeSum(owe.map((target) => target.remaining_minor));
  const netMinor = safeSum([owedMinor, -oweMinor]);
  if (!Number.isSafeInteger(cashMinor) || cashMinor < 0 || cashMinor > Math.abs(netMinor)) throw new Error('Choose an amount within the net balance.');
  const offsets: NonNullable<GroupSettlementInput['offsets']> = [];
  const sources = netMinor >= 0 ? owe : owed;
  const destinations = netMinor >= 0 ? owed : owe;
  let destination = 0;
  for (const source of sources) while (source.remaining_minor > 0 && destination < destinations.length) {
    const target = destinations[destination];
    const amountMinor = Math.min(source.remaining_minor, target.remaining_minor);
    if (amountMinor) offsets.push({ sourceEntryId: source.id, targetEntryId: target.id, amountMinor });
    source.remaining_minor -= amountMinor; target.remaining_minor -= amountMinor;
    if (!target.remaining_minor) destination++;
  }
  let remainingCash = cashMinor;
  const cashTargets = destinations.flatMap((target) => {
    const amountMinor = Math.min(remainingCash, target.remaining_minor);
    remainingCash -= amountMinor;
    return amountMinor ? [{ targetEntryId: target.id, amountMinor }] : [];
  });
  return { targets: cashTargets, offsets, owedMinor, oweMinor, netMinor, offsetMinor: Math.min(owedMinor, oweMinor), cashMinor };
}

export async function settleGroup(db: AppDb, input: GroupSettlementInput): Promise<string> {
  const offsets = input.offsets ?? [];
  if (!input.requestId.trim() || !isActivityDate(input.occurredOn) || (!input.targets.length && !offsets.length) || input.targets.some((t) => !Number.isSafeInteger(t.amountMinor) || t.amountMinor <= 0) || new Set(input.targets.map((t) => t.targetEntryId)).size !== input.targets.length || offsets.some((t) => !Number.isSafeInteger(t.amountMinor) || t.amountMinor <= 0) || new Set(offsets.map((t) => `${t.sourceEntryId}:${t.targetEntryId}`)).size !== offsets.length) throw new Error('Choose obligations and valid positive amounts.');
  if (offsets.length && input.nettingConfirmed !== true) throw new Error('Confirm the offset explicitly before settling.');
  const amountMinor = safeSum(input.targets.map((t) => t.amountMinor));
  const requestJson = JSON.stringify(input);
  let sourceId = '';
  await db.withExclusiveTransactionAsync(async (txn) => {
    const existing = await txn.getFirstAsync<{ source_entry_id: string; request_json: string }>('SELECT * FROM group_settlement_requests WHERE id = ?;', input.requestId);
    if (existing) {
      if (existing.request_json !== requestJson) throw new Error('This request was already used for different details.');
      sourceId = existing.source_entry_id;
      return;
    }
    // A payment settles only bills in its account's currency. A pure offset has no account.
    const account = await txn.getFirstAsync<{ currency: string }>('SELECT currency FROM accounts WHERE id = ?;', input.accountId);
    const snapshot = await readGroupSnapshot(txn, input.groupId, account?.currency);
    if (snapshot.group.is_archived) throw new Error('This group is archived.');
    if (snapshot.revision !== input.expectedRevision) throw new Error('Group balance changed. Reopen the settlement.');
    const position = snapshot.positions.find((p) => p.personId === input.personId);
    if (!position || position.ambiguous) throw new Error('Reconciliation needed. Review earlier money before recording another payment.');
    const available = new Map(snapshot.targets.filter((target) => target.person_id === input.personId).map((target) => [target.id, target.remaining_minor]));
    for (const offset of offsets) {
      const source = snapshot.targets.find((target) => target.id === offset.sourceEntryId && target.person_id === input.personId);
      const target = snapshot.targets.find((target) => target.id === offset.targetEntryId && target.person_id === input.personId);
      if (!source || !target || source.direction !== -target.direction || offset.amountMinor > available.get(source.id)! || offset.amountMinor > available.get(target.id)!) throw new Error('Offset exceeds the remaining group obligations.');
      available.set(source.id, available.get(source.id)! - offset.amountMinor); available.set(target.id, available.get(target.id)! - offset.amountMinor);
    }
    const selected = input.targets.map((choice) => {
      const target = snapshot.targets.find((t) => t.id === choice.targetEntryId && t.person_id === input.personId);
      if (!target || choice.amountMinor > available.get(target.id)!) throw new Error('Amount exceeds the remaining obligation.');
      return target;
    });
    if (selected.some((t) => t.direction !== selected[0].direction)) throw new Error('Settle one cash direction at a time.');
    const action = (selected[0]?.direction ?? 1) > 0 ? 'BORROW' : 'GIVE';
    const entries = await repo.listPersonEntries(txn);
    if (entries.some((entry) => entry.person_id === input.personId && (!Number.isSafeInteger(entry.amount_minor) || (entry.type !== 'ADJUSTMENT' && entry.amount_minor <= 0)))) throw new Error('This person has invalid historical amounts. No new payment was recorded.');
    const currencyOf = new Map((await txn.getAllAsync<{ id: string; currency: string }>('SELECT id, currency FROM accounts;')).map((a) => [a.id, a.currency]));
    const balance = calculatePersonBalance(entries.filter((e) => e.person_id === input.personId && currencyOf.get(e.account_id) === snapshot.currency));
    if (!Number.isSafeInteger(balance) || balance !== input.expectedBalanceMinor) throw new Error('Person balance changed. Reopen the settlement.');
    const resolved = resolvePeopleAction(balance, action, amountMinor);
    if (!Number.isSafeInteger(resolved.nextBalance)) throw new Error('Balance is outside the supported range.');
    if (resolved.requiresCrossingConfirmation && !input.crossingConfirmed) throw new Error('Confirm the change in who owes whom.');
    for (const [index, offset] of offsets.entries()) await txn.runAsync('INSERT INTO entry_allocations (id, source_entry_id, target_entry_id, amount_minor, created_at) VALUES (?, ?, ?, ?, ?);', `${input.requestId}_offset_${index}`, offset.sourceEntryId, offset.targetEntryId, offset.amountMinor, nowIso());
    if (amountMinor > 0) {
      const source = await recordPeopleActionInTransaction(txn, { personId: input.personId, accountId: input.accountId, action, amountMinor, occurredOn: input.occurredOn, expectedBalanceMinor: balance, title: `${selected[0].direction > 0 ? 'Received for' : 'Paid for'} ${snapshot.group.name}`, note: input.note });
      sourceId = source.id;
    } else {
      // Metadata-only request links to a fully consumed offset source, never a
      // manufactured zero cash row. UNIQUE(source_entry_id) remains meaningful.
      sourceId = offsets.find((offset) => available.get(offset.sourceEntryId) === 0)?.sourceEntryId ?? '';
      if (!sourceId) throw new Error('A zero-cash offset must fully reconcile an opposing source obligation.');
    }
    for (const target of input.targets) await txn.runAsync('INSERT INTO entry_allocations (id, source_entry_id, target_entry_id, amount_minor, created_at) VALUES (?, ?, ?, ?, ?);', makeId('allocation'), sourceId, target.targetEntryId, target.amountMinor, nowIso());
    await txn.runAsync('INSERT INTO group_settlement_requests (id, request_json, group_id, source_entry_id, created_at) VALUES (?, ?, ?, ?, ?);', input.requestId, requestJson, input.groupId, sourceId, nowIso());
    if (amountMinor > 0) {
      const account = (await repo.listAccounts(txn)).find((a) => a.id === input.accountId)!;
      const accountBalance = calculateAccountBalance(account, await repo.listTransactions(txn), await repo.listPersonEntries(txn));
      if (!Number.isSafeInteger(accountBalance)) throw new Error('Account balance is outside the supported range.');
    }
  });
  return sourceId;
}

export async function saveGroupDetails(db: AppDb, input: { id?: string; expectedUpdatedAt?: string; name: string; personIds: string[]; includeSelf?: boolean; newNames?: string[] }): Promise<string> {
  if (!input.name.trim()) throw new Error('Enter a group name.');
  if (new Set(input.personIds).size !== input.personIds.length) throw new Error('Choose each person once.');
  if (input.includeSelf !== undefined && typeof input.includeSelf !== 'boolean') throw new Error('Choose whether You are a member.');
  const id = input.id ?? makeId('group');
  await db.withExclusiveTransactionAsync(async (txn) => {
    if (input.id) {
      const existing = await txn.getFirstAsync<Group>('SELECT * FROM groups WHERE id = ? AND deleted_at IS NULL;', id);
      if (!existing || existing.is_archived || existing.updated_at !== input.expectedUpdatedAt) throw new Error('Group changed or is archived. Reopen it.');
    }
    const ids = [...input.personIds];
    for (const name of input.newNames ?? []) {
      if (!name.trim()) throw new Error('Enter a person name.');
      const existing = await txn.getFirstAsync<{ id: string; is_archived: number }>('SELECT id, is_archived FROM people WHERE lower(trim(name)) = lower(?) AND deleted_at IS NULL;', name.trim());
      if (existing?.is_archived) throw new Error('A person with this name is archived.');
      const personId = existing?.id ?? makeId('person');
      if (!existing) await txn.runAsync('INSERT INTO people (id, name, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?);', personId, name.trim(), nowIso(), nowIso(), 'LOCAL');
      if (ids.includes(personId)) throw new Error('Choose each person once.');
      ids.push(personId);
    }
    for (const personId of ids) if (!await txn.getFirstAsync('SELECT id FROM people WHERE id = ? AND deleted_at IS NULL AND is_archived = 0;', personId)) {
      // Existing archived members may be retained, but cannot be added to a new group.
      if (!input.id || !await txn.getFirstAsync('SELECT m.id FROM group_members m JOIN people p ON p.id = m.person_id WHERE m.group_id = ? AND m.person_id = ? AND p.deleted_at IS NULL;', id, personId)) throw new Error('Choose an active person.');
    }
    const timestamp = new Date(Math.max(Date.now(), Date.parse(input.expectedUpdatedAt ?? '') + 1 || 0)).toISOString();
    if (input.id) {
      await txn.runAsync('UPDATE groups SET name = ?, user_managed = 1, updated_at = ? WHERE id = ?;', input.name.trim(), timestamp, id);
    } else await txn.runAsync('INSERT INTO groups (id, name, user_managed, created_at, updated_at, sync_status) VALUES (?, ?, 1, ?, ?, ?);', id, input.name.trim(), timestamp, timestamp, 'LOCAL');
    const current = await txn.getAllAsync<GroupMember>('SELECT * FROM group_members WHERE group_id = ?;', id);
    for (const member of current) if (member.is_self ? input.includeSelf === false : !ids.includes(member.person_id!)) await txn.runAsync('DELETE FROM group_members WHERE id = ?;', member.id);
    if (input.includeSelf !== false && !current.some((member) => member.is_self)) await txn.runAsync('INSERT INTO group_members (id, group_id, person_id, is_self, created_at) VALUES (?, ?, NULL, 1, ?);', makeId('member'), id, timestamp);
    for (const personId of ids) if (!current.some((member) => member.person_id === personId && !member.is_self)) await txn.runAsync('INSERT INTO group_members (id, group_id, person_id, is_self, created_at) VALUES (?, ?, ?, 0, ?);', makeId('member'), id, personId, timestamp);
  });
  return id;
}

export async function archiveGroup(db: AppDb, id: string, expectedUpdatedAt: string): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    const group = await txn.getFirstAsync<Group>('SELECT * FROM groups WHERE id = ? AND deleted_at IS NULL;', id);
    if (!group || group.is_archived || group.updated_at !== expectedUpdatedAt) throw new Error('Group changed. Reopen it before archiving.');
    await txn.runAsync('UPDATE groups SET is_archived = 1, user_managed = 1, updated_at = ? WHERE id = ?;', new Date(Math.max(Date.now(), Date.parse(expectedUpdatedAt) + 1)).toISOString(), id);
  });
}

export async function restoreGroup(db: AppDb, id: string, expectedUpdatedAt: string): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    const group = await txn.getFirstAsync<Group>('SELECT * FROM groups WHERE id = ? AND deleted_at IS NULL;', id);
    if (!group || group.updated_at !== expectedUpdatedAt) throw new Error('Group changed. Reopen it before restoring.');
    if (!group.is_archived) throw new Error('This group is already active.');
    await txn.runAsync('UPDATE groups SET is_archived = 0, user_managed = 1, updated_at = ?, sync_status = ? WHERE id = ?;', new Date(Math.max(Date.now(), Date.parse(expectedUpdatedAt) + 1)).toISOString(), 'LOCAL', id);
  });
}

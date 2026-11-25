import type { AppDb } from '../../database/database';
import type { Account, GoalEntry, PersonEntry, SplitParticipant, Transaction } from '../../types/models';
import { decodeSharedDefinition, decodeSplitDefinition } from '../split/SplitDefinition';
import { calculateAccountBalance, personEntryAccountEffect, transactionAccountEffect } from '../finance/FinanceService';
import { calculatePersonBalance, personEntryDelta } from '../people/PeopleBalanceService';
import { calculateGoalSaved } from '../goals/GoalService';
import { readSharedEvent } from '../activity/ActivityService';
import { sharedIntegrityReason } from '../sharedExpense/SharedExpenseService';
import { decodeScheduleProvenance, isSavedScheduleDate } from '../planned/ScheduleProvenance';
import { currencyRows } from '../../utils/currency';
import { BACKUP_TABLES, invalid, object, validDate, type Backup, type BackupRow, type BackupTable } from './BackupFormat';

function safeComposition(values: number[]) {
  let positive = 0n;
  let negative = 0n;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) invalid('financial calculation exceeds supported range.');
    if (value >= 0) positive += BigInt(value); else negative -= BigInt(value);
  }
  // Bound intermediate sums too, regardless of the UI's chronological order.
  if (positive > BigInt(Number.MAX_SAFE_INTEGER) || negative > BigInt(Number.MAX_SAFE_INTEGER)) invalid('financial totals exceed the exact calculation range.');
}

/** Final-state checks, also executed on an isolated staging database BEFORE any
 * destructive target write. Archived references remain legitimate history.
 * No current schedule amount/account/category is compared with an old payment:
 * future edits intentionally preserve the original transaction's values.
 */
export async function validateBackupState(db: AppDb, backup: Backup): Promise<void> {
  const data = backup.data;
  const lookup = Object.fromEntries(BACKUP_TABLES.map((table) => [table, new Map(data[table].map((row) => [row.id, row]))])) as Record<BackupTable, Map<string | number | null, BackupRow>>;
  const cash = lookup.accounts.get('account_cash_default');
  if (!cash || cash.deleted_at || cash.type !== 'CASH' || !data.accounts.some((a) => !a.deleted_at && a.is_archived === 0)) invalid('the protected Cash identity or all active accounts are missing.');
  for (const [id, type] of [['cat_expense_other', 'EXPENSE'], ['cat_income_other_income', 'INCOME']]) {
    const fallback = lookup.categories.get(id);
    if (!fallback || fallback.deleted_at || fallback.is_archived !== 0 || fallback.type !== type) invalid('a protected fallback category is missing or archived.');
  }
  const references: [BackupTable, string, BackupTable][] = [
    ['group_members', 'group_id', 'groups'], ['group_members', 'person_id', 'people'],
    ['budgets', 'category_id', 'categories'], ['goals', 'linked_account_id', 'accounts'], ['goal_entries', 'goal_id', 'goals'],
    ['planned_payments', 'category_id', 'categories'], ['planned_payments', 'account_id', 'accounts'],
    ['subscriptions', 'category_id', 'categories'], ['subscriptions', 'account_id', 'accounts'],
    ['split_groups', 'category_id', 'categories'], ['split_groups', 'account_id', 'accounts'],
    ['split_groups', 'group_id', 'groups'], ['split_groups', 'payer_person_id', 'people'],
    ['split_participants', 'split_group_id', 'split_groups'], ['split_participants', 'person_id', 'people'],
    ['transactions', 'account_id', 'accounts'], ['transactions', 'destination_account_id', 'accounts'],
    ['transactions', 'category_id', 'categories'], ['transactions', 'group_id', 'split_groups'],
    ['person_entries', 'person_id', 'people'], ['person_entries', 'account_id', 'accounts'], ['person_entries', 'split_group_id', 'split_groups'],
    ['planned_payment_occurrences', 'planned_payment_id', 'planned_payments'], ['planned_payment_occurrences', 'transaction_id', 'transactions'],
    ['subscription_payments', 'subscription_id', 'subscriptions'], ['subscription_payments', 'transaction_id', 'transactions'],
    ['entry_allocations', 'source_entry_id', 'person_entries'], ['entry_allocations', 'target_entry_id', 'person_entries'],
    ['allocation_exclusions', 'source_entry_id', 'person_entries'], ['allocation_exclusions', 'target_entry_id', 'person_entries'],
    ['group_settlement_requests', 'source_entry_id', 'person_entries'], ['group_settlement_requests', 'group_id', 'groups'],
  ];
  for (const [table, field, parent] of references) for (const row of data[table]) {
    if (row[field] !== null && !lookup[parent].has(row[field])) invalid(`${table}.${field} references a missing record.`);
    if (row[field] !== null && !row.deleted_at && ['transactions', 'person_entries', 'split_groups', 'budgets', 'goal_entries'].includes(table) && lookup[parent].get(row[field])?.deleted_at) invalid(`${table} references a removed financial parent.`);
  }
  for (const table of ['accounts', 'categories', 'people', 'groups', 'goals', 'planned_payments', 'subscriptions'] as const) {
    for (const row of data[table]) if (!String(row.name).trim()) invalid(`${table} has an empty name.`);
  }
  for (const table of ['transactions', 'person_entries', 'split_groups'] as const) {
    for (const row of data[table]) if (!String(row.title).trim()) invalid(`${table} has an empty title.`);
  }
  const currencies: string[] = currencyRows.map(([code]) => code);
  for (const account of data.accounts) if (!currencies.includes(String(account.currency))) invalid('unsupported account currency.');
  // Every record takes the currency of its account; nothing is converted.
  const accountCurrency = new Map(data.accounts.map((account) => [account.id, String(account.currency)]));
  for (const row of [...data.budgets, ...data.goals]) if (!currencies.includes(String(row.currency))) invalid('unsupported plan or goal currency.');
  for (const goal of data.goals) if (goal.linked_account_id !== null && accountCurrency.get(goal.linked_account_id) !== goal.currency) invalid('a goal does not match the currency of its account.');
  for (const tx of data.transactions) {
    const betweenCurrencies = tx.type === 'TRANSFER' && accountCurrency.get(tx.account_id) !== accountCurrency.get(tx.destination_account_id);
    if (betweenCurrencies ? tx.destination_amount_minor === null : tx.destination_amount_minor !== null) invalid('a move between accounts has an invalid amount received.');
  }
  const entryCurrency = new Map(data.person_entries.map((entry) => [entry.id, accountCurrency.get(entry.account_id)]));
  for (const row of [...data.entry_allocations, ...data.allocation_exclusions]) if (entryCurrency.get(row.source_entry_id) !== entryCurrency.get(row.target_entry_id)) invalid('a payment is matched to a bill in another currency.');
  for (const schedule of [...data.planned_payments, ...data.subscriptions]) {
    const frequency = schedule.frequency_type ?? schedule.recurrence_type;
    const interval = Number(schedule.frequency_interval ?? schedule.recurrence_interval);
    if (frequency === 'EVERY_N_DAYS' ? interval < 1 || interval > 3650 : frequency === 'EVERY_N_MONTHS' ? interval < 2 : interval !== 1) invalid('invalid recurrence interval.');
    const limit = schedule.total_cycles ?? schedule.occurrence_limit;
    const completed = Number(schedule.completed_cycles ?? schedule.completed_occurrences);
    if (limit !== null && limit !== undefined && completed > Number(limit)) invalid('completed occurrences exceed their limit.');
    if (schedule.schedule_provenance !== null) {
      try {
        const p = decodeScheduleProvenance(String(schedule.schedule_provenance));
        if (p.recurrence !== frequency || p.interval !== interval || p.endDate !== schedule.end_date || p.limit !== (limit ?? null) || !isSavedScheduleDate(String(schedule.next_due_date ?? schedule.next_renewal_date), p)) invalid('schedule provenance differs from tracking.');
      } catch { invalid('invalid schedule provenance.'); }
    }
  }
  for (const row of [...data.planned_payment_occurrences, ...data.subscription_payments]) if (row.schedule_provenance !== null) {
    try {
      const p = decodeScheduleProvenance(String(row.schedule_provenance));
      if (!isSavedScheduleDate(String(row.scheduled_date), p)) invalid('occurrence differs from its saved schedule.');
      const parent = row.planned_payment_id ? lookup.planned_payments.get(row.planned_payment_id) : lookup.subscriptions.get(row.subscription_id);
      if (parent?.schedule_provenance) {
        const current = decodeScheduleProvenance(String(parent.schedule_provenance));
        if (current.revision === p.revision && String(parent.schedule_provenance) !== row.schedule_provenance) invalid('conflicting schedule revision.');
      }
    } catch { invalid('invalid occurrence provenance.'); }
  }
  const categoryType = (id: BackupRow[string], expected: string) => {
    if (!id || lookup.categories.get(id)?.type !== expected) invalid('category type does not match its financial record.');
  };
  for (const row of data.transactions) {
    if (['EXPENSE', 'INCOME'].includes(String(row.type))) categoryType(row.category_id, String(row.type));
    if (row.type === 'TRANSFER' && (!row.destination_account_id || row.destination_account_id === row.account_id || row.category_id !== null)) invalid('invalid transfer endpoints.');
    if (row.type !== 'TRANSFER' && row.destination_account_id !== null) invalid('unexpected transfer destination.');
    if (row.type === 'ADJUSTMENT' && row.category_id !== null) invalid('account adjustment cannot consume a category.');
    if (row.source === 'SPLIT' && (!row.group_id || lookup.split_groups.get(row.group_id)?.financial_event_id !== row.financial_event_id)) invalid('invalid shared transaction source.');
    if (row.source !== 'SPLIT' && row.group_id !== null) invalid('unexpected shared transaction link.');
    if (row.source === 'SUBSCRIPTION' && row.type !== 'EXPENSE') invalid('Subscription history must reference real Expenses.');
  }
  for (const row of data.budgets) if (row.category_id !== null) categoryType(row.category_id, 'EXPENSE');
  for (const row of data.planned_payments) categoryType(row.category_id, String(row.type));
  for (const row of [...data.subscriptions, ...data.split_groups]) categoryType(row.category_id, 'EXPENSE');
  for (const table of ['group_members', 'split_participants'] as const) {
    const identities = new Set<string>();
    for (const row of data[table]) {
      if ((row.is_self === 1) !== (row.person_id === null)) invalid('invalid self/Person identity.');
      const identity = JSON.stringify([row.group_id ?? row.split_group_id, row.is_self ? 'SELF' : row.person_id]);
      if (identities.has(identity)) invalid('duplicate member or participant.');
      identities.add(identity);
    }
  }
  for (const split of data.split_groups) {
    const participants = data.split_participants.filter((p) => p.split_group_id === split.id);
    try { decodeSplitDefinition(split.split_definition as string | null, Number(split.total_amount_minor), participants as unknown as SplitParticipant[]); }
    catch { invalid('invalid shared expense method metadata.'); }
    if (split.split_definition && JSON.parse(String(split.split_definition)).version === 2) {
      if (backup.schemaVersion < 12) invalid('legacy backup cannot contain modern shared accounting.');
      const definition = decodeSharedDefinition(String(split.split_definition), Number(split.total_amount_minor), participants as unknown as SplitParticipant[]);
      for (const payer of definition.payers) if (payer.identity !== 'SELF' && (!lookup.people.has(payer.identity.slice(7)) || lookup.people.get(payer.identity.slice(7))?.deleted_at)) invalid('shared payer references an unavailable Person.');
    }
    if (!participants.length || participants.reduce((sum, p) => sum + BigInt(p.share_minor!), 0n) !== BigInt(split.total_amount_minor!) || ((split.payer_is_self === 1) !== (split.payer_person_id === null))) invalid('invalid shared payer or participant total.');
    // Ambiguous legacy shared links are rejected, never guessed or repaired.
    if (!split.deleted_at && await sharedIntegrityReason(db, await readSharedEvent(db, String(split.id)))) invalid('a shared expense has incomplete or inconsistent financial links.');
  }
  for (const row of data.transactions) if (row.cash_effect_minor !== null && (row.source !== 'SPLIT' || row.group_id === null)) invalid('unexpected transaction cash override.');
  for (const row of data.person_entries) if (row.cash_effect_minor !== null && row.split_group_id === null) invalid('unexpected People cash override.');
  const eventOwners = new Set<string>();
  const eventParents = [...data.split_groups, ...data.transactions.filter((t) => t.source !== 'SPLIT'), ...data.person_entries.filter((e) => e.split_group_id === null)];
  for (const parent of eventParents) if (parent.financial_event_id !== null) {
    const event = String(parent.financial_event_id);
    if (eventOwners.has(event)) invalid('multiple independent records claim the same financial event.');
    eventOwners.add(event);
  }
  const linkedTransactions = new Set<string>();
  for (const occurrence of data.planned_payment_occurrences) {
    if (occurrence.outcome === 'SKIPPED') {
      if (occurrence.transaction_id !== null) invalid('a skipped occurrence has a transaction.');
      continue;
    }
    const transaction = lookup.transactions.get(occurrence.transaction_id);
    const plan = lookup.planned_payments.get(occurrence.planned_payment_id)!;
    if (!transaction || transaction.source !== 'PLANNED' || transaction.financial_event_id !== occurrence.id || transaction.type !== plan.type || transaction.occurred_on !== occurrence.scheduled_date) invalid('invalid Planned Payment source link.');
    if (linkedTransactions.has(String(transaction.id))) invalid('duplicate financial occurrence link.');
    linkedTransactions.add(String(transaction.id));
  }
  for (const payment of data.subscription_payments) {
    const transaction = lookup.transactions.get(payment.transaction_id);
    // Actual cash date and scheduled occurrence are independent (early/late payments).
    // Both dates are validated; the immutable transaction/event link proves identity.
    if (!transaction || transaction.source !== 'SUBSCRIPTION' || transaction.type !== 'EXPENSE' || transaction.financial_event_id !== payment.id || !validDate(transaction.occurred_on) || !validDate(payment.scheduled_date) || transaction.group_id !== null) invalid('invalid historical Subscription Expense/event link.');
    if (linkedTransactions.has(String(transaction.id))) invalid('duplicate financial occurrence link.');
    linkedTransactions.add(String(transaction.id));
  }
  for (const row of data.transactions) if (row.source === 'PLANNED' && !row.deleted_at && !linkedTransactions.has(String(row.id))) invalid('missing Planned Payment occurrence.');
  for (const plan of data.planned_payments) {
    // A planned-payment Skip consumes a key, but does not increment completed_occurrences.
    if (data.planned_payment_occurrences.filter((o) => o.planned_payment_id === plan.id && o.outcome === 'RECORDED').length > Number(plan.completed_occurrences)) invalid('Planned Payment count is inconsistent with history.');
  }
  for (const subscription of data.subscriptions) {
    if (data.subscription_payments.filter((p) => p.subscription_id === subscription.id).length > Number(subscription.completed_cycles)) invalid('Subscription count is inconsistent with history.');
  }
  // Original views retain fully allocated sources/targets. Unlike insertion
  // checks, final exclusions need not still have remaining funds available.
  const sources = new Map((await db.getAllAsync<BackupRow>('SELECT * FROM allocation_sources')).map((row) => [row.id, row]));
  const targets = new Map((await db.getAllAsync<BackupRow>('SELECT * FROM allocation_targets')).map((row) => [row.id, row]));
  const sharedOffsetIds = new Set<string>();
  for (const row of [...data.entry_allocations, ...data.allocation_exclusions]) {
    const source = sources.get(row.source_entry_id);
    const target = targets.get(row.target_entry_id);
    if (!source || !target || source.person_id !== target.person_id || source.cash_direction !== target.direction || source.id === target.id) invalid('invalid allocation/reconciliation source or target.');
    if (Number(source.available_minor) < 0 || Number(target.remaining_minor) < 0) invalid('allocation exceeds its source or obligation.');
    if (source.split_group_id !== null) {
      if (backup.schemaVersion < 11 || !('id' in row)) invalid('unsupported obligation offset or unrelated choice.');
      if (targets.get(source.id)?.group_id !== target.group_id || target.group_id === null) invalid('offset crosses group history.');
      sharedOffsetIds.add(String(row.id));
    }
  }
  for (const request of data.group_settlement_requests) {
    let parsed: Record<string, unknown>;
    try { parsed = object(JSON.parse(String(request.request_json))); } catch { invalid('invalid settlement request.'); }
    if (Object.keys(parsed).some((key) => !['requestId', 'groupId', 'personId', 'accountId', 'occurredOn', 'targets', 'expectedRevision', 'expectedBalanceMinor', 'crossingConfirmed', 'offsets', 'nettingConfirmed', 'note'].includes(key)) || ('crossingConfirmed' in parsed && typeof parsed.crossingConfirmed !== 'boolean') || ('nettingConfirmed' in parsed && typeof parsed.nettingConfirmed !== 'boolean') || ('note' in parsed && typeof parsed.note !== 'string')) invalid('unsupported settlement request fields.');
    if (backup.schemaVersion < 11 && ('offsets' in parsed || 'nettingConfirmed' in parsed || 'note' in parsed)) invalid('legacy settlement has unsupported metadata.');
    const source = sources.get(request.source_entry_id);
    const offsetOnly = source?.split_group_id != null;
    if (!source || parsed.requestId !== request.id || parsed.groupId !== request.group_id || parsed.personId !== source.person_id || !validDate(parsed.occurredOn) || typeof parsed.accountId !== 'string' || (!offsetOnly && (parsed.accountId !== source.account_id || parsed.occurredOn !== source.occurred_on)) || !Array.isArray(parsed.targets) || (!offsetOnly && !parsed.targets.length) || typeof parsed.expectedRevision !== 'string' || !Number.isSafeInteger(parsed.expectedBalanceMinor)) invalid('inconsistent settlement request identity.');
    if ('offsets' in parsed && !Array.isArray(parsed.offsets)) invalid('invalid settlement offsets.');
    const offsets = (parsed.offsets ?? []) as unknown[];
    if (offsets.length && parsed.nettingConfirmed !== true) invalid('unconfirmed settlement offset.');
    const seenOffsets = new Set<string>();
    for (const [index, raw] of offsets.entries()) {
      const offset = object(raw);
      if (Object.keys(offset).sort().join() !== 'amountMinor,sourceEntryId,targetEntryId' || typeof offset.sourceEntryId !== 'string' || typeof offset.targetEntryId !== 'string' || !Number.isSafeInteger(offset.amountMinor) || Number(offset.amountMinor) <= 0) invalid('invalid settlement offset fields.');
      const pair = `${offset.sourceEntryId}:${offset.targetEntryId}`;
      if (seenOffsets.has(pair)) invalid('duplicate settlement offset.');
      seenOffsets.add(pair);
      const allocationId = `${request.id}_offset_${index}`;
      const allocation = data.entry_allocations.find((row) => row.id === allocationId);
      if (!allocation || allocation.source_entry_id !== offset.sourceEntryId || allocation.target_entry_id !== offset.targetEntryId || allocation.amount_minor !== offset.amountMinor || targets.get(offset.sourceEntryId)?.group_id !== request.group_id || targets.get(offset.targetEntryId)?.group_id !== request.group_id || targets.get(offset.sourceEntryId)?.person_id !== parsed.personId || !sharedOffsetIds.delete(allocationId)) invalid('settlement offsets do not match their group-linked allocations.');
    }
    if (offsetOnly && (!offsets.length || parsed.targets.length || Number(source.available_minor) !== 0 || !offsets.some((raw) => object(raw).sourceEntryId === source.id))) invalid('invalid zero-cash settlement source.');
    const allocations = data.entry_allocations.filter((a) => a.source_entry_id === request.source_entry_id);
    const seen = new Set<string>();
    let total = 0;
    for (const raw of parsed.targets as unknown[]) {
      const target = object(raw);
      if (Object.keys(target).sort().join() !== 'amountMinor,targetEntryId') invalid('invalid settlement target fields.');
      if (typeof target.targetEntryId !== 'string' || seen.has(target.targetEntryId) || !Number.isSafeInteger(target.amountMinor) || Number(target.amountMinor) <= 0) invalid('invalid settlement request target.');
      seen.add(target.targetEntryId);
      if (targets.get(target.targetEntryId)?.group_id !== request.group_id || allocations.filter((a) => a.target_entry_id === target.targetEntryId && a.amount_minor === target.amountMinor).length !== 1) invalid('settlement request does not match its allocations.');
      total += Number(target.amountMinor);
      if (!Number.isSafeInteger(total)) invalid('settlement total exceeds supported range.');
    }
    if (!offsetOnly && (allocations.length !== seen.size || total !== source.amount_minor)) invalid('settlement request amount mismatch.');
  }
  if (sharedOffsetIds.size) invalid('an obligation offset has no explicit settlement request.');
  const transactions = data.transactions as unknown as Transaction[];
  const entries = data.person_entries as unknown as PersonEntry[];
  for (const account of data.accounts as unknown as Account[]) {
    safeComposition([account.opening_balance_minor, ...transactions.map((tx) => transactionAccountEffect(tx, account.id, entries)), ...entries.map((entry) => personEntryAccountEffect(entry, account.id))]);
    if (!Number.isSafeInteger(calculateAccountBalance(account, transactions, entries))) invalid('account balance exceeds supported range.');
  }
  for (const person of data.people) {
    const own = entries.filter((e) => e.person_id === person.id && !e.deleted_at);
    safeComposition(own.map((e) => personEntryDelta(e.type, e.amount_minor)));
    if (!Number.isSafeInteger(calculatePersonBalance(own))) invalid('People balance exceeds supported range.');
  }
  for (const goal of data.goals) {
    const history = data.goal_entries.filter((e) => e.goal_id === goal.id && !e.deleted_at) as unknown as GoalEntry[];
    safeComposition([Number(goal.initial_saved_minor), ...history.map((entry) => calculateGoalSaved(0, [entry]))]);
    const saved = calculateGoalSaved(Number(goal.initial_saved_minor), history);
    if (!Number.isSafeInteger(saved) || saved < 0) invalid('invalid Goal savings history.');
  }
  const settings = new Map(data.app_settings.map((r) => [r.key, r.value]));
  const supportedSettings = ['user_name', 'currency', 'week_start', 'budget_alert_threshold', 'theme', 'notifications_enabled', 'notifications_intro_answered', 'ai_enabled', 'setup_complete', 'senior_demo_seeded', 'budget_auto_copy_enabled', 'budget_auto_copy_processed_month', 'default_account_id', 'activity_sort_order'];
  for (const key of settings.keys()) if (!supportedSettings.includes(String(key))) invalid('unsupported preference metadata.');
  if (settings.has('activity_sort_order') && !['DATE', 'CREATED'].includes(String(settings.get('activity_sort_order')))) invalid('invalid activity order preference.');
  // A default account that is not in the backup is harmless (the app falls back to Cash) but would be a dangling reference.
  if (settings.has('default_account_id') && !data.accounts.some((account) => account.id === settings.get('default_account_id'))) invalid('default account is not part of this backup.');
  if (settings.has('budget_auto_copy_processed_month') && !validDate(`${settings.get('budget_auto_copy_processed_month')}-01`)) invalid('invalid Spending Plan processing month.');
  for (const key of ['user_name', 'currency', 'week_start', 'budget_alert_threshold', 'theme', 'notifications_enabled', 'ai_enabled', 'setup_complete']) if (!settings.has(key)) invalid(`missing ${key} setting.`);
  if (!currencies.includes(String(settings.get('currency'))) || !['MONDAY', 'SUNDAY'].includes(String(settings.get('week_start'))) || settings.get('theme') !== 'Sage') invalid('unsupported settings.');
  for (const key of ['notifications_enabled', 'notifications_intro_answered', 'ai_enabled', 'setup_complete', 'budget_auto_copy_enabled', 'senior_demo_seeded']) if (settings.has(key) && !['true', 'false'].includes(String(settings.get(key)))) invalid('invalid preference.');
  const threshold = Number(settings.get('budget_alert_threshold'));
  if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > 100) invalid('invalid Spending Plan threshold.');
  if (await db.getFirstAsync('PRAGMA foreign_key_check')) invalid('foreign-key validation failed.');
  const integrity = await db.getFirstAsync<{ integrity_check: string }>('PRAGMA integrity_check');
  if (integrity?.integrity_check !== 'ok') invalid('database integrity validation failed.');
}

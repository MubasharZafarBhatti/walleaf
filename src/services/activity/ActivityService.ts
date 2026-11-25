import type { AppDb } from '../../database/database';
import type { PersonEntry, SplitGroup, SplitParticipant, Transaction } from '../../types/models';
import { parseDateKey, toDateKey, todayLocal } from '../../utils/date';

export type ActivityType = 'ALL' | 'EXPENSE' | 'INCOME' | 'TRANSFER' | 'ADJUSTMENT' | 'PEOPLE' | 'SHARED';
export type ActivityRange = 'ALL' | 'THIS_MONTH' | 'LAST_MONTH' | 'LAST_3_MONTHS' | 'LAST_6_MONTHS' | 'THIS_YEAR' | 'CUSTOM';
/** DATE: newest activity date first (default). CREATED: most recently recorded first. */
export type ActivityOrder = 'DATE' | 'CREATED';
export function activityOrderSetting(value: string | null | undefined): ActivityOrder { return value === 'CREATED' ? 'CREATED' : 'DATE'; }
export type ActivityFilters = { activityId?: string; type?: ActivityType; range?: ActivityRange; from?: string; to?: string; query?: string; accountId?: string; currency?: string; categoryId?: string; personId?: string; groupId?: string; limit?: number; order?: ActivityOrder };
export type ActivityRow = { id: string; kind: 'transaction' | 'person' | 'shared'; source_id: string; source: Transaction['source'] | 'PEOPLE'; type: ActivityType; title: string; note: string | null; amount_minor: number; occurred_on: string; created_at: string; account_id: string; destination_account_id: string | null; category_id: string | null; person_id: string | null; group_id: string | null; account_name: string; destination_name: string; category_name: string; person_name: string; group_name: string; label: string; account_cash_minor?: number | null; currency: string; destination_currency: string; destination_amount_minor?: number | null };

export function activityDisplayLabel(row: Pick<ActivityRow, 'kind' | 'label'>): string {
  if (row.kind !== 'person') return row.label;
  if (row.label === 'You gave' || row.label === 'Paid back') return 'Given';
  if (row.label === 'You borrowed' || row.label === 'Received back') return 'Received';
  return row.label;
}

export function activitySubtitle(row: Pick<ActivityRow, 'kind' | 'label' | 'type' | 'account_name' | 'note' | 'person_name' | 'occurred_on'>, dateLabel: string): string {
  if (row.type === 'ADJUSTMENT') return [row.account_name, row.note?.trim(), dateLabel].filter(Boolean).join(' · ');
  return [activityDisplayLabel(row), row.person_name, dateLabel].filter(Boolean).join(' · ');
}
export const legacyReadOnlyMessage = 'This older activity has missing or conflicting links. It is read-only so that changing it cannot affect unrelated money records.';
export const subscriptionReadOnlyMessage = 'This subscription-sourced transaction is read-only. Edit future subscription tracking separately; recorded expenses and payment history stay unchanged.';
export const plannedReadOnlyMessage = 'This transaction records a planned payment occurrence. Edit the future plan separately; recorded financial history stays unchanged.';
export const adjustmentReadOnlyMessage = 'Balance adjustments are read-only history. Record a new adjustment from Account Detail if the balance needs another correction.';

export function activityDateBounds(filters: ActivityFilters, today = todayLocal()): { from?: string; to?: string } {
  const date = parseDateKey(today);
  const year = date.getFullYear();
  const month = date.getMonth();
  const key = (y: number, m: number, d: number) => toDateKey(new Date(y, m, d));
  switch (filters.range) {
    case 'THIS_MONTH': return { from: key(year, month, 1), to: key(year, month + 1, 0) };
    case 'LAST_MONTH': return { from: key(year, month - 1, 1), to: key(year, month, 0) };
    case 'LAST_3_MONTHS': return { from: key(year, month - 2, 1), to: key(year, month + 1, 0) };
    case 'LAST_6_MONTHS': return { from: key(year, month - 5, 1), to: key(year, month + 1, 0) };
    case 'THIS_YEAR': return { from: key(year, 0, 1), to: key(year, 11, 31) };
    case 'CUSTOM':
      if (!filters.from || !filters.to || !isActivityDate(filters.from) || !isActivityDate(filters.to) || filters.to < filters.from) throw new Error('Choose a valid From and To date. To must be on or after From.');
      return { from: filters.from, to: filters.to };
    default: return {};
  }
}

export async function listPersonalSpendingActivity(
  db: AppDb,
  filters: Pick<ActivityFilters, 'from' | 'to' | 'categoryId' | 'currency'>,
): Promise<ActivityRow[]> {
  const bounds = activityDateBounds({ ...filters, range: 'CUSTOM' });
  if (!filters.categoryId) throw new Error('Choose a spending category.');
  return db.getAllAsync<ActivityRow>(`SELECT
    'personal:' || t.id id,
    CASE WHEN s.id IS NULL THEN 'transaction' ELSE 'shared' END kind,
    coalesce(s.id, t.id) source_id,
    t.source,
    'EXPENSE' type,
    t.title,
    t.note,
    t.amount_minor,
    t.occurred_on,
    t.created_at,
    t.account_id,
    t.destination_account_id,
    t.category_id,
    NULL person_id,
    s.group_id,
    coalesce(a.currency, 'PKR') currency,
    '' destination_currency,
    coalesce(a.name, 'Unavailable account') account_name,
    '' destination_name,
    coalesce(c.name, 'Unavailable category') category_name,
    '' person_name,
    coalesce(g.name, '') group_name,
    CASE WHEN s.id IS NULL THEN 'Expense' ELSE 'Shared expense | Your share' END label
  FROM transactions t
  LEFT JOIN split_groups s ON s.id = (
    SELECT CASE WHEN count(*) = 1 THEN min(linked.id) END
    FROM split_groups linked
    WHERE linked.deleted_at IS NULL AND (linked.id = t.group_id OR (t.financial_event_id IS NOT NULL AND linked.financial_event_id = t.financial_event_id))
  )
  LEFT JOIN accounts a ON a.id = t.account_id
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN groups g ON g.id = s.group_id
  WHERE t.deleted_at IS NULL AND t.type = 'EXPENSE' AND t.category_id = ?
    AND t.occurred_on >= ? AND t.occurred_on <= ?${filters.currency ? ' AND a.currency = ?' : ''}
  ORDER BY t.occurred_on DESC, t.created_at DESC, t.id;`, filters.categoryId, bounds.from!, bounds.to!, ...(filters.currency ? [filters.currency] : []));
}

export function isActivityDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && toDateKey(parseDateKey(value)) === value;
}

// Only explicit links suppress child rows. A persistent group is never an event link.
export async function listActivity(db: AppDb, filters: ActivityFilters = {}): Promise<ActivityRow[]> {
  const bounds = activityDateBounds(filters);
  if (filters.limit != null && (!Number.isSafeInteger(filters.limit) || filters.limit <= 0))
    throw new Error('Choose a valid activity limit.');
  const clauses: string[] = [];
  // Personal feeds exclude third-party-only bills. Explicit ID reads still open
  // the same record from Group history; no financial source is removed.
  if (!filters.activityId) clauses.push("(a.kind <> 'shared' OR EXISTS (SELECT 1 FROM split_groups s WHERE s.id = a.source_id AND (s.payer_is_self = 1 OR EXISTS (SELECT 1 FROM split_participants sp WHERE sp.split_group_id = s.id AND sp.is_self = 1))))");
  const params: (string | number)[] = [];
  for (const [column, value] of [['id', filters.activityId], ['type', filters.type === 'ALL' ? undefined : filters.type], ['category_id', filters.categoryId]] as const) {
    if (value) { clauses.push(`a.${column} = ?`); params.push(value); }
  }
  if (filters.groupId) {
    clauses.push("(a.group_id = ? OR (a.kind = 'person' AND EXISTS (SELECT 1 FROM entry_allocations al JOIN allocation_targets target ON target.id = al.target_entry_id WHERE al.source_entry_id = a.source_id AND target.group_id = ?)))");
    params.push(filters.groupId, filters.groupId);
  }
  if (bounds.from) { clauses.push('a.occurred_on >= ?'); params.push(bounds.from); }
  if (bounds.to) { clauses.push('a.occurred_on <= ?'); params.push(bounds.to); }
  if (filters.currency) { clauses.push('(cur.currency = ? OR dest.currency = ?)'); params.push(filters.currency, filters.currency); }
  if (filters.accountId) { clauses.push('(a.account_id = ? OR a.destination_account_id = ?)'); params.push(filters.accountId, filters.accountId); }
  if (filters.personId) {
    clauses.push("(a.person_id = ? OR (a.kind = 'shared' AND EXISTS (SELECT 1 FROM split_participants sp WHERE sp.split_group_id = a.source_id AND sp.person_id = ?)))");
    params.push(filters.personId, filters.personId);
  }
  if (filters.query?.trim()) {
    clauses.push("(instr(lower(a.title || ' ' || coalesce(a.note,'') || ' ' || coalesce(c.name,'') || ' ' || coalesce(ac.name,'') || ' ' || coalesce(dest.name,'') || ' ' || coalesce(p.name,'') || ' ' || coalesce(g.name,'') || ' ' || CASE WHEN a.kind = 'shared' THEN coalesce((SELECT group_concat(coalesce(person.name, sp.name), ' ') FROM split_participants sp LEFT JOIN people person ON person.id = sp.person_id WHERE sp.split_group_id = a.source_id),'') ELSE '' END), lower(?)) > 0 OR (a.kind = 'person' AND EXISTS (SELECT 1 FROM entry_allocations al JOIN allocation_targets target ON target.id = al.target_entry_id LEFT JOIN groups ag ON ag.id = target.group_id WHERE al.source_entry_id = a.source_id AND instr(lower(coalesce(ag.name,'') || ' ' || target.expense_title), lower(?)) > 0)))");
    params.push(filters.query.trim(), filters.query.trim());
  }
  return db.getAllAsync<ActivityRow>(`WITH activity AS (
    SELECT 'transaction:' || t.id id, 'transaction' kind, t.id source_id, t.source, t.type, t.title, t.note, t.amount_minor, t.occurred_on, t.created_at, t.account_id, t.destination_account_id, t.category_id, NULL person_id, NULL group_id, t.account_id currency_account_id, t.destination_amount_minor,
      CASE t.type WHEN 'TRANSFER' THEN 'Move Money' WHEN 'INCOME' THEN 'Income' WHEN 'EXPENSE' THEN 'Expense' WHEN 'ADJUSTMENT' THEN 'Balance adjustment' ELSE 'Activity' END label
    FROM transactions t WHERE t.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM split_groups s WHERE s.deleted_at IS NULL AND (t.group_id = s.id OR (t.financial_event_id IS NOT NULL AND t.financial_event_id = s.financial_event_id)))
    UNION ALL
    SELECT 'person:' || e.id, 'person', e.id, 'PEOPLE', 'PEOPLE', e.title, e.note, e.amount_minor, e.occurred_on, e.created_at, e.account_id, NULL, NULL, e.person_id, NULL, e.account_id, NULL,
      CASE WHEN EXISTS (SELECT 1 FROM entry_allocations al WHERE al.source_entry_id = e.id) THEN CASE WHEN e.type IN ('GIVEN','PAID_BACK') THEN 'Payment sent for shared bills' ELSE 'Payment received for shared bills' END ELSE CASE e.type WHEN 'GIVEN' THEN 'You gave' WHEN 'BORROWED_FROM' THEN 'You borrowed' WHEN 'PAID_BACK' THEN 'Paid back' WHEN 'RECEIVED_BACK' THEN 'Received back' ELSE 'Adjustment' END END
    FROM person_entries e WHERE e.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM split_groups s WHERE s.deleted_at IS NULL AND (e.split_group_id = s.id OR (e.financial_event_id IS NOT NULL AND e.financial_event_id = s.financial_event_id)))
    UNION ALL
    SELECT 'shared:' || s.id, 'shared', s.id, 'SPLIT', 'SHARED', s.title, NULL, s.total_amount_minor, s.occurred_on, s.created_at, CASE WHEN s.payer_is_self = 1 THEN s.account_id ELSE NULL END, NULL, s.category_id, s.payer_person_id, s.group_id, s.account_id, NULL, 'Shared expense'
    FROM split_groups s WHERE s.deleted_at IS NULL
   ) SELECT a.*, CASE WHEN a.kind = 'shared' THEN (SELECT CASE WHEN json_extract(s.split_definition,'$.version') = 2 THEN coalesce((SELECT json_extract(payer.value,'$.paidMinor') FROM json_each(s.split_definition,'$.payers') payer WHERE json_extract(payer.value,'$.identity') = 'SELF'),0) ELSE CASE WHEN s.payer_is_self = 1 THEN s.total_amount_minor ELSE 0 END END FROM split_groups s WHERE s.id = a.source_id) ELSE NULL END account_cash_minor,
     coalesce(cur.currency,'PKR') currency, coalesce(dest.currency,'') destination_currency,
     coalesce(ac.name,'Unavailable account') account_name, coalesce(dest.name,'') destination_name, coalesce(c.name,'') category_name, coalesce(p.name,'') person_name, coalesce(g.name,'') group_name
  FROM activity a LEFT JOIN accounts cur ON cur.id = a.currency_account_id LEFT JOIN accounts ac ON ac.id = a.account_id LEFT JOIN accounts dest ON dest.id = a.destination_account_id LEFT JOIN categories c ON c.id = a.category_id LEFT JOIN people p ON p.id = a.person_id LEFT JOIN groups g ON g.id = a.group_id
   ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
   ORDER BY ${filters.order === 'CREATED' ? '' : 'a.occurred_on DESC, '}CASE WHEN trim(a.created_at) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN julianday(a.created_at) END DESC,
     a.id ASC ${filters.limit ? 'LIMIT ?' : ''};`, ...params, ...(filters.limit ? [filters.limit] : []));
}

export type SharedEventRecords = { split: SplitGroup; participants: SplitParticipant[]; transactions: Transaction[]; entries: PersonEntry[] };

export type PaymentAllocationDetail = { id: string; amount_minor: number; expense_title: string; group_id: string | null; group_name: string; occurred_on: string };
export async function readPaymentAllocations(db: AppDb, sourceId: string): Promise<PaymentAllocationDetail[]> {
  return db.getAllAsync('SELECT a.id, a.amount_minor, target.expense_title, target.group_id, coalesce(g.name,\'Standalone shared expense\') group_name, target.occurred_on FROM entry_allocations a JOIN allocation_targets target ON target.id = a.target_entry_id LEFT JOIN groups g ON g.id = target.group_id WHERE a.source_entry_id = ? ORDER BY a.created_at, a.id;', sourceId);
}

export async function readSharedEvent(db: AppDb, id: string): Promise<SharedEventRecords> {
  const split = await db.getFirstAsync<SplitGroup>('SELECT s.*, coalesce(p.name, s.payer_name) payer_name FROM split_groups s LEFT JOIN people p ON p.id = s.payer_person_id WHERE s.id = ? AND s.deleted_at IS NULL;', id);
  if (!split) throw new Error('Activity no longer exists.');
  const participants = await db.getAllAsync<SplitParticipant>('SELECT s.*, coalesce(p.name, s.name) name FROM split_participants s LEFT JOIN people p ON p.id = s.person_id WHERE s.split_group_id = ? ORDER BY s.created_at, s.id;', id);
  const transactions = await db.getAllAsync<Transaction>('SELECT * FROM transactions WHERE group_id = ? OR financial_event_id = ?;', id, split.financial_event_id ?? null);
  const entries = await db.getAllAsync<PersonEntry>('SELECT * FROM person_entries WHERE split_group_id = ? OR financial_event_id = ?;', id, split.financial_event_id ?? null);
  return { split, participants, transactions, entries };
}

export async function ordinaryReadOnlyReason(db: AppDb, tx: Transaction): Promise<string | null> {
  // Occurrence-backed transactions stay read-only so schedule history cannot be rewritten.
  if (tx.source === 'PLANNED') {
    const occurrence = await db.getFirstAsync(
      'SELECT id FROM planned_payment_occurrences WHERE transaction_id = ? AND id = ?;',
      tx.id,
      tx.financial_event_id ?? null,
    );
    return occurrence ? plannedReadOnlyMessage : legacyReadOnlyMessage;
  }
  if (tx.source === 'SUBSCRIPTION') return subscriptionReadOnlyMessage;
  if (tx.type === 'ADJUSTMENT') return adjustmentReadOnlyMessage;
  if (tx.deleted_at || tx.source !== 'MANUAL' || tx.group_id != null || !['EXPENSE', 'INCOME', 'TRANSFER'].includes(tx.type)) return legacyReadOnlyMessage;
  if (tx.financial_event_id != null) {
    const linked = await db.getFirstAsync(`SELECT id FROM split_groups WHERE financial_event_id = ? UNION ALL SELECT id FROM person_entries WHERE financial_event_id = ? UNION ALL SELECT id FROM transactions WHERE financial_event_id = ? AND id <> ? LIMIT 1;`, tx.financial_event_id, tx.financial_event_id, tx.financial_event_id, tx.id);
    if (linked) return legacyReadOnlyMessage;
  }
  return null;
}

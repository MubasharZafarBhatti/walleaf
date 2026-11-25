import type { AppDb } from '../../database/database';
import type { PlannedPayment, Subscription, Transaction } from '../../types/models';
import { isValidDateKey } from './PlannedPaymentService';
import { advanceSavedSchedule, decodeScheduleProvenance, isSavedScheduleDate } from './ScheduleProvenance';

type Link = { id: string; parent_id: string; scheduled_date: string; schedule_provenance: string | null };
export type RecordedPaymentDeletion = {
  transaction: Transaction; source: 'PLANNED' | 'SUBSCRIPTION'; sourceId: string;
  scheduledDate: string; nextDate: string; scheduleRestored: boolean; explanation: string;
  parentVersion: string; occurrenceId: string;
};

/** Exact durable links only. Legacy unlinked financial rows are never assigned a parent. */
export async function readRecordedPaymentDeletion(db: AppDb, transactionId: string): Promise<RecordedPaymentDeletion> {
  const t = await db.getFirstAsync<Transaction>('SELECT * FROM transactions WHERE id = ? AND deleted_at IS NULL;', transactionId);
  if (!t || !['PLANNED', 'SUBSCRIPTION'].includes(t.source) || !['EXPENSE', 'INCOME'].includes(t.type) || t.group_id != null || t.cash_effect_minor != null || !t.financial_event_id)
    throw new Error('This payment does not have a safe recorded-occurrence link.');
  const planned = t.source === 'PLANNED';
  if (!planned && t.type !== 'EXPENSE') throw new Error('Invalid subscription expense link.');
  if (!Number.isSafeInteger(t.amount_minor) || t.amount_minor <= 0 || !isValidDateKey(t.occurred_on)) throw new Error('The original payment has invalid financial data. No records were changed.');
  const table = planned ? 'planned_payment_occurrences' : 'subscription_payments';
  const parentField = planned ? 'planned_payment_id' : 'subscription_id';
  const link = await db.getFirstAsync<Link>(`SELECT id, ${parentField} parent_id, scheduled_date, schedule_provenance FROM ${table} WHERE transaction_id = ? AND id = ? ${planned ? "AND outcome = 'RECORDED'" : ''};`, t.id, t.financial_event_id);
  if (!link || !isValidDateKey(link.scheduled_date)) throw new Error('The recorded occurrence is unavailable. Reopen this transaction.');
  if (await db.getFirstAsync('SELECT id FROM person_entries WHERE financial_event_id = ? UNION ALL SELECT id FROM split_groups WHERE financial_event_id = ? UNION ALL SELECT id FROM transactions WHERE financial_event_id = ? AND id <> ? LIMIT 1;', t.financial_event_id, t.financial_event_id, t.financial_event_id, t.id)) throw new Error('This financial event has other linked records and cannot be deleted as a payment.');
  const parent = await db.getFirstAsync<PlannedPayment & Subscription>(`SELECT * FROM ${planned ? 'planned_payments' : 'subscriptions'} WHERE id = ?;`, link.parent_id);
  if (!parent) throw new Error('The original tracking record is unavailable.');
  if (planned && (t.type !== parent.type || t.occurred_on !== link.scheduled_date)) throw new Error('The recorded Planned payment has conflicting financial links.');
  const currentDate = planned ? parent.next_due_date : parent.next_renewal_date;
  const history = await db.getAllAsync<Link>(`SELECT id, ${parentField} parent_id, scheduled_date, schedule_provenance FROM ${table} WHERE ${parentField} = ? AND id <> ? ORDER BY scheduled_date DESC, id;`, link.parent_id, link.id);
  let nextDate = currentDate;
  let scheduleRestored = false;
  if (link.schedule_provenance && link.schedule_provenance === parent.schedule_provenance) {
    const p = decodeScheduleProvenance(link.schedule_provenance);
    if (!isSavedScheduleDate(link.scheduled_date, p) || !isSavedScheduleDate(currentDate, p) || history.some(h => h.schedule_provenance === link.schedule_provenance && !isSavedScheduleDate(h.scheduled_date, p))) throw new Error('The recorded dates do not match the saved schedule.');
    const recurrence = planned ? parent.recurrence_type : parent.frequency_type;
    const interval = planned ? parent.recurrence_interval : parent.frequency_interval;
    if (p.recurrence !== recurrence || p.interval !== interval || p.endDate !== (parent.end_date ?? null) || p.limit !== ((planned ? parent.occurrence_limit : parent.total_cycles) ?? null)) throw new Error('The saved schedule no longer matches its provenance.');
    // Different/legacy revisions cannot be retroactively reconstructed. Do not
    // move back across later history from such a revision or consume it twice.
    if (!history.some(h => h.schedule_provenance !== link.schedule_provenance && h.scheduled_date >= link.scheduled_date)) {
      const surviving = history.filter(h => h.schedule_provenance === link.schedule_provenance);
      const latest = surviving[0];
      const candidate = latest ? advanceSavedSchedule(latest.scheduled_date, link.schedule_provenance) ?? latest.scheduled_date : p.anchorDate;
      if (!isValidDateKey(candidate)) throw new Error('The rebuilt schedule is outside the supported date range.');
      if (!history.some(h => h.scheduled_date === candidate)) { nextDate = candidate; scheduleRestored = true; }
    }
  }
  return {
    transaction: t, source: planned ? 'PLANNED' : 'SUBSCRIPTION', sourceId: link.parent_id,
    scheduledDate: link.scheduled_date, nextDate, scheduleRestored,
    explanation: scheduleRestored
      ? 'Its occurrence history will be removed and the next date rebuilt from the saved schedule and remaining history. Tracking status will stay unchanged.'
      : 'Its occurrence history will be removed. The current next date will be kept because the original schedule is unavailable or has since changed. Review the tracking detail before recording again. Tracking status will stay unchanged.',
    parentVersion: parent.updated_at, occurrenceId: link.id,
  };
}

/** Financial reversal is the removal of the exact real Expense/Income from the
 * authoritative ledger, not a second compensating income or expense. */
export async function deleteRecordedPayment(db: AppDb, expected: RecordedPaymentDeletion): Promise<void> {
  await db.withExclusiveTransactionAsync(async txn => {
    const current = await readRecordedPaymentDeletion(txn, expected.transaction.id);
    if (current.transaction.updated_at !== expected.transaction.updated_at || current.parentVersion !== expected.parentVersion || current.occurrenceId !== expected.occurrenceId || current.nextDate !== expected.nextDate || current.scheduleRestored !== expected.scheduleRestored)
      throw new Error('This payment or schedule changed. Reopen it before deleting.');
    const planned = current.source === 'PLANNED';
    const table = planned ? 'planned_payment_occurrences' : 'subscription_payments';
    const parentTable = planned ? 'planned_payments' : 'subscriptions';
    const count = planned ? 'completed_occurrences' : 'completed_cycles';
    const date = planned ? 'next_due_date' : 'next_renewal_date';
    const parent = await txn.getFirstAsync<{ completed: number }>(`SELECT ${count} completed FROM ${parentTable} WHERE id = ?;`, current.sourceId);
    if (!parent || parent.completed < 1) throw new Error('The recorded payment count is inconsistent. No records were changed.');
    const version = new Date(Math.max(Date.now(), Date.parse(current.parentVersion) + 1, Date.parse(current.transaction.updated_at) + 1)).toISOString();
    await txn.runAsync(`DELETE FROM ${table} WHERE id = ?;`, current.occurrenceId);
    await txn.runAsync('UPDATE transactions SET deleted_at = ?, updated_at = ?, sync_status = \'LOCAL\' WHERE id = ?;', version, version, current.transaction.id);
    await txn.runAsync(`UPDATE ${parentTable} SET ${count} = ${count} - 1, ${date} = ?, updated_at = ?, sync_status = 'LOCAL' ${planned ? '' : ', user_managed = 1'} WHERE id = ?;`, current.nextDate, version, current.sourceId);
  });
}

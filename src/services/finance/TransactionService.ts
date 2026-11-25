import type { AppDb } from '../../database/database';
import type { Transaction } from '../../types/models';
import { makeId } from '../../utils/id';
import { isActivityDate, ordinaryReadOnlyReason } from '../activity/ActivityService';
import { receivedAmountFor } from '../../database/repositories/repositories';

export type TransactionEdit = Pick<Transaction, 'amount_minor' | 'account_id' | 'destination_account_id' | 'category_id' | 'title' | 'note' | 'occurred_on'> & Partial<Pick<Transaction, 'destination_amount_minor'>>;

export async function readOrdinaryTransaction(db: AppDb, id: string): Promise<Transaction> {
  const tx = await db.getFirstAsync<Transaction>('SELECT * FROM transactions WHERE id = ? AND deleted_at IS NULL;', id);
  if (!tx) throw new Error('Activity no longer exists.');
  const reason = await ordinaryReadOnlyReason(db, tx);
  if (reason) throw new Error(reason);
  return tx;
}

export async function updateTransaction(db: AppDb, id: string, expectedUpdatedAt: string, input: TransactionEdit): Promise<string> {
  let resultId = id;
  await db.withExclusiveTransactionAsync(async (txn) => {
    const old = await readOrdinaryTransaction(txn, id);
    if (old.updated_at !== expectedUpdatedAt) throw new Error('Activity changed. Reopen it before editing.');
    if (!Number.isSafeInteger(input.amount_minor) || input.amount_minor <= 0 || !input.title.trim() || !isActivityDate(input.occurred_on)) throw new Error('Enter a title, valid date and positive amount.');
    const accountIds = old.type === 'TRANSFER' ? [input.account_id, input.destination_account_id] : [input.account_id];
    if (old.type === 'TRANSFER' && (!input.destination_account_id || input.account_id === input.destination_account_id)) throw new Error('Choose different accounts.');
    for (const accountId of accountIds) if (!await txn.getFirstAsync('SELECT id FROM accounts WHERE id = ? AND deleted_at IS NULL AND is_archived = 0;', accountId ?? null)) throw new Error('Choose an active account.');
    if (old.type !== 'TRANSFER' && !await txn.getFirstAsync('SELECT id FROM categories WHERE id = ? AND type = ? AND deleted_at IS NULL AND is_archived = 0;', input.category_id ?? null, old.type)) throw new Error('Choose a matching category.');
    // No persisted occurrence references exist yet; the gate must be extended in phases 11/12.
    const received = await receivedAmountFor(txn, { type: old.type, account_id: input.account_id, destination_account_id: input.destination_account_id, destination_amount_minor: input.destination_amount_minor ?? null });
    resultId = id.startsWith('demo_') ? makeId('tx') : id;
    await txn.runAsync('UPDATE transactions SET id = ?, amount_minor = ?, account_id = ?, destination_account_id = ?, destination_amount_minor = ?, category_id = ?, title = ?, note = ?, occurred_on = ?, updated_at = ?, sync_status = ? WHERE id = ?;', resultId, input.amount_minor, input.account_id, old.type === 'TRANSFER' ? input.destination_account_id! : null, received, old.type === 'TRANSFER' ? null : input.category_id!, input.title.trim(), input.note ?? null, input.occurred_on, new Date(Math.max(Date.now(), Date.parse(expectedUpdatedAt) + 1)).toISOString(), 'LOCAL', id);
  });
  return resultId;
}

export async function deleteTransaction(db: AppDb, id: string, expectedUpdatedAt: string): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    const old = await readOrdinaryTransaction(txn, id);
    if (old.updated_at !== expectedUpdatedAt) throw new Error('Activity changed. Reopen it before deleting.');
    await txn.runAsync('DELETE FROM transactions WHERE id = ?;', id);
  });
}

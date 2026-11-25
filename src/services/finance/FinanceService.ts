import type { Account, PersonEntry, Transaction } from '../../types/models';
import { personEntryDelta } from '../people/PeopleBalanceService';

export function projectAccountOutflow(
  account: Account, transactions: Transaction[], peopleEntries: PersonEntry[], outflowMinor: number,
) {
  if (!Number.isSafeInteger(outflowMinor) || outflowMinor < 0)
    throw new Error('Enter a valid payment amount.');
  const currentBalanceMinor = calculateAccountBalance(account, transactions, peopleEntries);
  const resultingBalanceMinor = currentBalanceMinor - outflowMinor;
  if (!Number.isSafeInteger(resultingBalanceMinor)) throw new Error('Balance is outside the supported range.');
  return { currentBalanceMinor, resultingBalanceMinor, needsConfirmation: outflowMinor > 0 && resultingBalanceMinor < 0 };
}

export function calculateAccountBalance(
  account: Account,
  transactions: Transaction[],
  peopleEntries: PersonEntry[],
): number {
  const txTotal = transactions
    .filter((tx) => !tx.deleted_at)
    .reduce((sum, tx) => sum + transactionAccountEffect(tx, account.id, peopleEntries), 0);
  const peopleTotal = peopleEntries
    .reduce((sum, entry) => sum + personEntryAccountEffect(entry, account.id), 0);
  return account.opening_balance_minor + txTotal + peopleTotal;
}

function isOtherPersonPaidSharedExpense(tx: Transaction, peopleEntries: PersonEntry[]): boolean {
  return tx.source === 'SPLIT' && peopleEntries.some(
    (entry) =>
      !entry.deleted_at &&
      entry.financial_event_id &&
      entry.financial_event_id === tx.financial_event_id &&
      entry.split_group_id &&
      entry.type === 'BORROWED_FROM',
  );
}

export function transactionAccountEffect(
  tx: Transaction,
  accountId: string,
  peopleEntries: PersonEntry[],
): number {
  if (tx.deleted_at) return 0;
  if (tx.source === 'SPLIT' && tx.cash_effect_minor != null) return tx.account_id === accountId ? tx.cash_effect_minor : 0;
  if (tx.type === 'INCOME' && tx.account_id === accountId) return tx.amount_minor;
  if (tx.type === 'EXPENSE' && tx.account_id === accountId)
    return isOtherPersonPaidSharedExpense(tx, peopleEntries) ? 0 : -tx.amount_minor;
  if (tx.type === 'TRANSFER') {
    let effect = 0;
    if (tx.account_id === accountId) effect -= tx.amount_minor;
    if (tx.destination_account_id === accountId) effect += tx.destination_amount_minor ?? tx.amount_minor;
    return effect;
  }
  if (tx.type === 'ADJUSTMENT' && tx.account_id === accountId) return tx.amount_minor;
  return 0;
}

export function personEntryAccountEffect(entry: PersonEntry, accountId: string): number {
  if (!entry.deleted_at && entry.account_id === accountId && entry.split_group_id && entry.cash_effect_minor != null) return entry.cash_effect_minor;
  if (
    entry.deleted_at ||
    entry.account_id !== accountId ||
    (entry.split_group_id && entry.type === 'BORROWED_FROM')
  ) return 0;
  return -personEntryDelta(entry.type, entry.amount_minor);
}

export function calculateTotalAccountCashChange(
  transactions: Transaction[],
  peopleEntries: PersonEntry[],
  from: string,
  to: string,
  /** One currency's accounts: a move between currencies then counts as money leaving or arriving. */
  accountIds?: ReadonlySet<string>,
): number {
  const transactionTotal = transactions
    .filter((tx) => !tx.deleted_at && tx.occurred_on >= from && tx.occurred_on <= to)
    .reduce((sum, tx) => {
      let effect = 0;
      if (tx.type === 'TRANSFER' && accountIds)
        effect = (tx.destination_account_id && accountIds.has(tx.destination_account_id) ? tx.destination_amount_minor ?? tx.amount_minor : 0) - (accountIds.has(tx.account_id) ? tx.amount_minor : 0);
      else if (tx.source === 'SPLIT' && tx.cash_effect_minor != null) effect = tx.cash_effect_minor;
      else if (tx.type === 'INCOME') effect = tx.amount_minor;
      else if (tx.type === 'EXPENSE') effect = isOtherPersonPaidSharedExpense(tx, peopleEntries) ? 0 : -tx.amount_minor;
      else if (tx.type === 'ADJUSTMENT') effect = tx.amount_minor;
      const next = sum + effect;
      if (!Number.isSafeInteger(next)) throw new Error('Account cash change is outside the supported range.');
      return next;
    }, 0);
  return peopleEntries
    .filter((entry) => !entry.deleted_at && entry.occurred_on >= from && entry.occurred_on <= to)
    .reduce((sum, entry) => {
      const effect = personEntryAccountEffect(entry, entry.account_id);
      const next = sum + effect;
      if (!Number.isSafeInteger(next)) throw new Error('Account cash change is outside the supported range.');
      return next;
    }, transactionTotal);
}

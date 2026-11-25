import type { AppDb } from '../../database/database';
import type { Account, AccountType, PersonEntry, Settings, Transaction } from '../../types/models';
import { makeId, nowIso } from '../../utils/id';
import { todayLocal } from '../../utils/date';
import { calculateAccountBalance } from '../finance/FinanceService';
import { listActivity, type ActivityRow } from '../activity/ActivityService';
import { currencyRows } from '../../utils/currency';

export const accountTypeRows: [AccountType, string][] = [
  ['CASH', 'Cash'],
  ['BANK', 'Bank'],
  ['EWALLET', 'E-wallet'],
  ['OTHER', 'Other'],
];

export function formatAccountType(type: string): string {
  return accountTypeRows.find(([value]) => value === type)?.[1] ?? type;
}

export function hasActiveAccountNamed(
  accounts: Pick<Account, 'name' | 'deleted_at'>[],
  name: string,
): boolean {
  const cleanName = name.trim().toLowerCase();
  return accounts.some(
    (account) => !account.deleted_at && account.name.trim().toLowerCase() === cleanName,
  );
}

/**
 * Account preselected for a new entry: the user's chosen default while it is
 * still an active account, otherwise Cash, otherwise the first account.
 */
export function defaultAccountId(
  accounts: readonly Pick<Account, 'id' | 'type'>[],
  settings?: Pick<Settings, 'default_account_id'> | null,
): string | undefined {
  const saved = settings?.default_account_id;
  if (saved && accounts.some((account) => account.id === saved)) return saved;
  return (accounts.find((account) => account.type === 'CASH') ?? accounts[0])?.id;
}

export function defaultAccountNameForType(type: AccountType): string {
  return type === 'CASH' ? 'Cash' : '';
}

export type AccountSnapshot = {
  account: Account;
  currentBalanceMinor: number;
  activity: ActivityRow[];
};

export function accountTotalsByCurrency(accounts: Account[], transactions: Transaction[], entries: PersonEntry[]) {
  const totals = new Map<string, number>();
  for (const account of accounts) {
    if (account.deleted_at || account.is_archived) continue;
    const total = (totals.get(account.currency) ?? 0) + calculateAccountBalance(account, transactions, entries);
    if (!Number.isSafeInteger(total)) throw new Error('Money total is outside the supported range.');
    totals.set(account.currency, total);
  }
  return [...totals].map(([currency, amountMinor]) => ({ currency, amountMinor }));
}

export function accountActivityEffect(row: ActivityRow, accountId: string): number {
  if (row.type === 'ADJUSTMENT') return row.amount_minor;
  if (row.type === 'INCOME') return row.amount_minor;
  if (row.type === 'SHARED') return -(row.account_cash_minor ?? row.amount_minor);
  if (row.type === 'EXPENSE') return -row.amount_minor;
  if (row.type === 'TRANSFER')
    return row.destination_account_id === accountId ? row.destination_amount_minor ?? row.amount_minor : -row.amount_minor;
  if (row.type === 'PEOPLE')
    return row.label === 'You borrowed' || row.label === 'Received back' || row.label === 'Payment received for shared bills'
      ? row.amount_minor
      : -row.amount_minor;
  return 0;
}

export class AccountArchiveError extends Error {
  constructor(message: string, readonly balanceMinor?: number) {
    super(message);
    this.name = 'AccountArchiveError';
  }
}

async function readExistingAccount(db: AppDb, id: string): Promise<Account> {
  const account = await db.getFirstAsync<Account>(
    'SELECT * FROM accounts WHERE id = ? AND deleted_at IS NULL;',
    id,
  );
  if (!account) throw new Error('Account no longer exists.');
  return account;
}

export async function readAccountSnapshot(db: AppDb, id: string): Promise<AccountSnapshot> {
  const account = await readExistingAccount(db, id);
  const [transactions, entries, activity] = await Promise.all([
    db.getAllAsync<Transaction>('SELECT * FROM transactions WHERE deleted_at IS NULL;'),
    db.getAllAsync<PersonEntry>('SELECT * FROM person_entries WHERE deleted_at IS NULL;'),
    listActivity(db, { accountId: id, limit: 20 }),
  ]);
  return {
    account,
    currentBalanceMinor: calculateAccountBalance(account, transactions, entries),
    activity,
  };
}

/** True once anything uses the account: then its currency is fixed, so its history keeps its meaning. */
export async function accountHasRecords(db: AppDb, id: string): Promise<boolean> {
  return !!await db.getFirstAsync(`SELECT 1 FROM transactions WHERE account_id = ?1 OR destination_account_id = ?1
    UNION ALL SELECT 1 FROM person_entries WHERE account_id = ?1 UNION ALL SELECT 1 FROM split_groups WHERE account_id = ?1
    UNION ALL SELECT 1 FROM subscriptions WHERE account_id = ?1 UNION ALL SELECT 1 FROM planned_payments WHERE account_id = ?1
    UNION ALL SELECT 1 FROM goals WHERE linked_account_id = ?1 LIMIT 1;`, id);
}

/** Renames an account and, while it has no records, changes its currency. */
export async function renameAccount(
  db: AppDb,
  id: string,
  expectedUpdatedAt: string,
  name: string,
  currency?: string,
): Promise<void> {
  const cleanName = name.trim();
  if (!cleanName) throw new Error('Enter an account name.');
  await db.withExclusiveTransactionAsync(async (txn) => {
    const account = await readExistingAccount(txn, id);
    if (account.is_archived) throw new Error('Archived accounts cannot be edited.');
    if (account.updated_at !== expectedUpdatedAt)
      throw new Error('Account changed. Reopen it before editing.');
    const nextCurrency = currency ?? account.currency;
    if (!currencyRows.some(([code]) => code === nextCurrency)) throw new Error('Choose a valid currency.');
    if (nextCurrency !== account.currency && await accountHasRecords(txn, id))
      throw new Error('This account already has records, so its currency stays the same. Add a new account for another currency.');
    const duplicate = await txn.getFirstAsync(
      'SELECT id FROM accounts WHERE id <> ? AND deleted_at IS NULL AND is_archived = 0 AND lower(trim(name)) = lower(?) AND currency = ? LIMIT 1;',
      id,
      cleanName,
      nextCurrency,
    );
    if (duplicate) throw new Error('ACCOUNT_NAME_EXISTS');
    await txn.runAsync(
      'UPDATE accounts SET name = ?, currency = ?, updated_at = ?, sync_status = ? WHERE id = ?;',
      cleanName,
      nextCurrency,
      new Date(Math.max(Date.now(), Date.parse(expectedUpdatedAt) + 1)).toISOString(),
      'LOCAL',
      id,
    );
  });
}

export async function adjustAccountBalance(
  db: AppDb,
  id: string,
  actualBalanceMinor: number,
  reason = '',
): Promise<{ previousBalanceMinor: number; adjustmentMinor: number; actualBalanceMinor: number }> {
  if (!Number.isSafeInteger(actualBalanceMinor))
    throw new Error('Enter a valid actual balance.');
  let result = { previousBalanceMinor: 0, adjustmentMinor: 0, actualBalanceMinor };
  await db.withExclusiveTransactionAsync(async (txn) => {
    const account = await readExistingAccount(txn, id);
    if (account.is_archived) throw new Error('Archived accounts cannot be adjusted.');
    const [transactions, entries] = await Promise.all([
      txn.getAllAsync<Transaction>('SELECT * FROM transactions WHERE deleted_at IS NULL;'),
      txn.getAllAsync<PersonEntry>('SELECT * FROM person_entries WHERE deleted_at IS NULL;'),
    ]);
    const previousBalanceMinor = calculateAccountBalance(account, transactions, entries);
    const adjustmentMinor = actualBalanceMinor - previousBalanceMinor;
    if (!Number.isSafeInteger(adjustmentMinor))
      throw new Error('Balance is outside the supported range.');
    if (adjustmentMinor === 0)
      throw new Error('The actual balance already matches this account.');
    const timestamp = nowIso();
    await txn.runAsync(
      'INSERT INTO transactions (id, type, amount_minor, account_id, destination_account_id, category_id, title, note, occurred_on, source, group_id, financial_event_id, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?, ?);',
      makeId('adjustment'),
      'ADJUSTMENT',
      adjustmentMinor,
      id,
      'Balance adjustment',
      reason.trim() || null,
      todayLocal(),
      'MANUAL',
      timestamp,
      timestamp,
      'LOCAL',
    );
    result = { previousBalanceMinor, adjustmentMinor, actualBalanceMinor };
  });
  return result;
}

export async function archiveAccount(
  db: AppDb,
  id: string,
  expectedUpdatedAt: string,
): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    const account = await readExistingAccount(txn, id);
    if (account.is_archived) throw new Error('This account is already archived.');
    if (account.updated_at !== expectedUpdatedAt)
      throw new Error('Account changed. Reopen it before archiving.');
    const [transactions, entries, activeCount, schedule] = await Promise.all([
      txn.getAllAsync<Transaction>('SELECT * FROM transactions WHERE deleted_at IS NULL;'),
      txn.getAllAsync<PersonEntry>('SELECT * FROM person_entries WHERE deleted_at IS NULL;'),
      txn.getFirstAsync<{ count: number }>('SELECT COUNT(*) count FROM accounts WHERE deleted_at IS NULL AND is_archived = 0;'),
      txn.getFirstAsync(
        "SELECT id FROM planned_payments WHERE deleted_at IS NULL AND status = 'ACTIVE' AND account_id = ? UNION ALL SELECT id FROM subscriptions WHERE deleted_at IS NULL AND status = 'ACTIVE' AND account_id = ? LIMIT 1;",
        id,
        id,
      ),
    ]);
    const balanceMinor = calculateAccountBalance(account, transactions, entries);
    if (balanceMinor !== 0)
      throw new AccountArchiveError('Move the money or adjust the balance before archiving.', balanceMinor);
    if ((activeCount?.count ?? 0) <= 1)
      throw new AccountArchiveError('Keep at least one active account. Default Cash cannot be archived when it is the only active account.');
    if (schedule)
      throw new AccountArchiveError('This account is used by an active planned payment or subscription. Reassign it before archiving.');
    await txn.runAsync(
      'UPDATE accounts SET is_archived = 1, updated_at = ?, sync_status = ? WHERE id = ?;',
      new Date(Math.max(Date.now(), Date.parse(expectedUpdatedAt) + 1)).toISOString(),
      'LOCAL',
      id,
    );
  });
}

export async function listArchivedAccounts(db: AppDb): Promise<Account[]> {
  return db.getAllAsync<Account>('SELECT * FROM accounts WHERE deleted_at IS NULL AND is_archived = 1 ORDER BY name, id;');
}

/** Reactivate the original metadata only; all opening/history/cash values stay. */
export async function restoreAccount(db: AppDb, id: string, expectedUpdatedAt: string): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    const account = await readExistingAccount(txn, id);
    if (account.updated_at !== expectedUpdatedAt) throw new Error('Account changed. Reopen it before restoring.');
    if (!account.is_archived) throw new Error('This account is already active.');
    if (await txn.getFirstAsync('SELECT id FROM accounts WHERE id <> ? AND deleted_at IS NULL AND is_archived = 0 AND lower(trim(name)) = lower(trim(?)) LIMIT 1;', id, account.name)) throw new Error('ACCOUNT_NAME_EXISTS');
    await txn.runAsync('UPDATE accounts SET is_archived = 0, updated_at = ?, sync_status = ? WHERE id = ?;', new Date(Math.max(Date.now(), Date.parse(expectedUpdatedAt) + 1)).toISOString(), 'LOCAL', id);
  });
}

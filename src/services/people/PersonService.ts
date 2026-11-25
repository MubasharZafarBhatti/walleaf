import type { AppDb } from '../../database/database';
import type { Person, PersonEntry } from '../../types/models';
import { todayLocal } from '../../utils/date';
import { makeId, nowIso } from '../../utils/id';
import { calculatePersonBalance, peopleEntryDisplayLabel, resolvePeopleAction, type VisiblePeopleAction } from './PeopleBalanceService';
import { personBalancesByCurrency } from '../currency/CurrencyScope';
import { mainCurrency } from '../../database/repositories/repositories';

export type PersonSnapshot = {
  person: Person;
  balanceMinor: number;
  history: PersonEntry[];
};

export class PersonArchiveError extends Error {
  constructor(message: string, readonly balanceMinor?: number, readonly currency?: string) {
    super(message);
    this.name = 'PersonArchiveError';
  }
}

async function readExistingPerson(db: AppDb, id: string): Promise<Person> {
  const person = await db.getFirstAsync<Person>(
    'SELECT * FROM people WHERE id = ? AND deleted_at IS NULL;',
    id,
  );
  if (!person) throw new Error('Person no longer exists.');
  return person;
}

async function accountCurrencies(db: AppDb): Promise<Map<string, string>> {
  return new Map((await db.getAllAsync<{ id: string; currency: string }>('SELECT id, currency FROM accounts;')).map((row) => [row.id, row.currency]));
}

/** A person's history and balance. Money in different currencies never adds up, so a balance is for one currency. */
async function readPersonBalance(db: AppDb, id: string, currency?: string): Promise<{ history: PersonEntry[]; balanceMinor: number }> {
  const history = await db.getAllAsync<PersonEntry>(
    'SELECT * FROM person_entries WHERE person_id = ? AND deleted_at IS NULL ORDER BY occurred_on DESC, created_at DESC;',
    id,
  );
  if (!currency) return { history, balanceMinor: calculatePersonBalance(history) };
  const currencies = await accountCurrencies(db);
  return { history, balanceMinor: calculatePersonBalance(history.filter((entry) => currencies.get(entry.account_id) === currency)) };
}

/** With a currency, the balance is that currency's; history always lists everything. */
export async function readPersonSnapshot(db: AppDb, id: string, currency?: string): Promise<PersonSnapshot> {
  const person = await readExistingPerson(db, id);
  const { history, balanceMinor } = await readPersonBalance(db, id, currency);
  return { person, balanceMinor, history };
}

export async function renamePerson(
  db: AppDb,
  id: string,
  expectedUpdatedAt: string,
  name: string,
  note = '',
): Promise<void> {
  const cleanName = name.trim();
  if (!cleanName) throw new Error('Enter a person name.');
  await db.withExclusiveTransactionAsync(async (txn) => {
    const person = await readExistingPerson(txn, id);
    if (person.is_archived) throw new Error('Archived people cannot be edited.');
    if (person.updated_at !== expectedUpdatedAt)
      throw new Error('Person changed. Reopen them before editing.');
    const duplicate = await txn.getFirstAsync(
      'SELECT id FROM people WHERE id <> ? AND deleted_at IS NULL AND lower(trim(name)) = lower(?) LIMIT 1;',
      id,
      cleanName,
    );
    if (duplicate) throw new Error('PERSON_NAME_EXISTS');
    const timestamp = new Date(Math.max(Date.now(), Date.parse(expectedUpdatedAt) + 1)).toISOString();
    await txn.runAsync(
      'UPDATE people SET name = ?, note = ?, updated_at = ?, sync_status = ? WHERE id = ?;',
      cleanName,
      note.trim() || null,
      timestamp,
      'LOCAL',
      id,
    );
  });
}

export async function archivePerson(db: AppDb, id: string, expectedUpdatedAt: string): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    const person = await readExistingPerson(txn, id);
    if (person.is_archived) throw new Error('This person is already archived.');
    if (person.updated_at !== expectedUpdatedAt)
      throw new Error('Person changed. Reopen them before archiving.');
    // Every currency must be settled; a debt in one currency never cancels another.
    const { history } = await readPersonBalance(txn, id);
    const open = personBalancesByCurrency(history, await accountCurrencies(txn), await mainCurrency(txn))[0];
    if (open)
      throw new PersonArchiveError('Settle this balance before archiving.', open.amountMinor, open.currency);
    await txn.runAsync(
      'UPDATE people SET is_archived = 1, updated_at = ?, sync_status = ? WHERE id = ?;',
      new Date(Math.max(Date.now(), Date.parse(expectedUpdatedAt) + 1)).toISOString(),
      'LOCAL',
      id,
    );
  });
}

export async function restorePerson(db: AppDb, id: string, expectedUpdatedAt: string): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    const person = await readExistingPerson(txn, id);
    if (!person.is_archived) throw new Error('This person is already active.');
    if (person.updated_at !== expectedUpdatedAt)
      throw new Error('Person changed. Reopen them before restoring.');
    const duplicate = await txn.getFirstAsync(
      'SELECT id FROM people WHERE id <> ? AND deleted_at IS NULL AND is_archived = 0 AND lower(trim(name)) = lower(?) LIMIT 1;',
      id,
      person.name.trim(),
    );
    if (duplicate) throw new Error('PERSON_NAME_EXISTS');
    await txn.runAsync(
      'UPDATE people SET is_archived = 0, updated_at = ?, sync_status = ? WHERE id = ?;',
      new Date(Math.max(Date.now(), Date.parse(expectedUpdatedAt) + 1)).toISOString(),
      'LOCAL',
      id,
    );
  });
}

export type RecordPeopleActionInput = {
  personId: string;
  action: VisiblePeopleAction;
  amountMinor: number;
  accountId: string;
  occurredOn?: string;
  title?: string;
  note?: string;
  expectedBalanceMinor: number;
};

export async function recordPeopleAction(db: AppDb, input: RecordPeopleActionInput) {
  let result!: ReturnType<typeof resolvePeopleAction> & { id: string };
  await db.withExclusiveTransactionAsync(async (txn) => {
    result = await recordPeopleActionInTransaction(txn, input);
  });
  return result;
}

// Caller owns the transaction so group allocation and this single cash entry commit together.
export async function recordPeopleActionInTransaction(txn: AppDb, input: RecordPeopleActionInput) {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
    throw new Error('Enter an amount greater than zero.');
  const occurredOn = input.occurredOn ?? todayLocal();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredOn)) throw new Error('Enter a valid date.');
    const person = await readExistingPerson(txn, input.personId);
    if (person.is_archived) throw new Error('This person is archived.');
    const account = await txn.getFirstAsync<{ currency: string }>('SELECT currency FROM accounts WHERE id = ? AND deleted_at IS NULL AND is_archived = 0;', input.accountId);
    if (!account) throw new Error('Choose an active account.');
    // Given/borrowed money is matched against the balance in the account's currency.
    const { balanceMinor } = await readPersonBalance(txn, person.id, account.currency);
    if (balanceMinor !== input.expectedBalanceMinor)
      throw new Error('This balance changed. Reopen the person before recording money.');
    const resolved = resolvePeopleAction(balanceMinor, input.action, input.amountMinor);
    const id = makeId('entry');
    const timestamp = nowIso();
    await txn.runAsync(
      'INSERT INTO person_entries (id, person_id, type, amount_minor, account_id, title, note, occurred_on, split_group_id, financial_event_id, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?);',
      id,
      person.id,
      resolved.type,
      input.amountMinor,
      input.accountId,
      input.title?.trim() || peopleEntryDisplayLabel(resolved.type),
      input.note?.trim() || null,
      occurredOn,
      timestamp,
      timestamp,
      'LOCAL',
    );
    return { ...resolved, id };
}

/**
 * Plain Give/Receive entries can be edited or deleted. Entries that belong to a
 * split/group bill or to reconciliation (applied to shared bills) stay
 * read-only: those links are immutable and other balances depend on them.
 */
export async function personEntryReadOnlyReason(db: AppDb, entry: PersonEntry): Promise<string | null> {
  if (entry.deleted_at) return 'This People record was deleted.';
  if (entry.split_group_id || entry.financial_event_id || entry.cash_effect_minor != null || entry.type === 'ADJUSTMENT')
    return 'This record belongs to a shared or group bill. Edit or delete it from that bill so every share stays correct.';
  const reconciled = await db.getFirstAsync(
    'SELECT 1 FROM entry_allocations WHERE source_entry_id = ? OR target_entry_id = ? UNION ALL SELECT 1 FROM allocation_exclusions WHERE source_entry_id = ? OR target_entry_id = ? LIMIT 1;',
    entry.id, entry.id, entry.id, entry.id,
  );
  if (reconciled) return 'This payment is applied to shared bills, so it is kept read-only to protect those settled balances.';
  const person = await db.getFirstAsync<Person>('SELECT * FROM people WHERE id = ?;', entry.person_id);
  if (!person || person.deleted_at) return 'This person no longer exists.';
  if (person.is_archived) return 'This person is archived. Restore them to change their history.';
  return null;
}

async function readEditablePersonEntry(txn: AppDb, id: string, expectedUpdatedAt: string): Promise<PersonEntry> {
  const entry = await txn.getFirstAsync<PersonEntry>('SELECT * FROM person_entries WHERE id = ?;', id);
  if (!entry || entry.deleted_at) throw new Error('This People record no longer exists.');
  if (entry.updated_at !== expectedUpdatedAt) throw new Error('This People record changed. Reopen it before saving.');
  const reason = await personEntryReadOnlyReason(txn, entry);
  if (reason) throw new Error(reason);
  return entry;
}

function nextVersion(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}

export type UpdatePersonEntryInput = { amountMinor: number; accountId: string; occurredOn: string; title: string; note?: string | null };

/** Edits one plain People entry atomically. The Given/Received direction is fixed. */
export async function updatePersonEntry(db: AppDb, id: string, expectedUpdatedAt: string, input: UpdatePersonEntryInput): Promise<void> {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new Error('Enter an amount greater than zero.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.occurredOn)) throw new Error('Enter a valid date.');
  await db.withExclusiveTransactionAsync(async (txn) => {
    const entry = await readEditablePersonEntry(txn, id, expectedUpdatedAt);
    // Keeping the original (possibly now archived) account is allowed; switching needs an active one.
    if (input.accountId !== entry.account_id && !await txn.getFirstAsync('SELECT id FROM accounts WHERE id = ? AND deleted_at IS NULL AND is_archived = 0;', input.accountId))
      throw new Error('Choose an active account.');
    const currencies = await accountCurrencies(txn);
    if (currencies.get(input.accountId) !== currencies.get(entry.account_id))
      throw new Error('Choose an account in the same currency. Record money in another currency as a new entry.');
    await txn.runAsync(
      'UPDATE person_entries SET amount_minor = ?, account_id = ?, occurred_on = ?, title = ?, note = ?, updated_at = ?, sync_status = ? WHERE id = ?;',
      input.amountMinor, input.accountId, input.occurredOn,
      input.title.trim() || peopleEntryDisplayLabel(entry.type),
      input.note?.trim() || null,
      nextVersion(entry.updated_at), 'LOCAL', id,
    );
  });
}

/** Removes one plain People entry: its account cash and the person's balance revert together. */
export async function deletePersonEntry(db: AppDb, id: string, expectedUpdatedAt: string): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    const entry = await readEditablePersonEntry(txn, id, expectedUpdatedAt);
    const version = nextVersion(entry.updated_at);
    await txn.runAsync('UPDATE person_entries SET deleted_at = ?, updated_at = ?, sync_status = ? WHERE id = ?;', version, version, 'LOCAL', id);
  });
}

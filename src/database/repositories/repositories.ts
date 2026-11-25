import type { AppDb } from '../database';
import { accountCurrencyLock } from '../migration14';
import { makeId, nowIso } from '../database';
import type {
  Account,
  Budget,
  Category,
  Goal,
  GoalEntry,
  Group,
  GroupMember,
  Person,
  PersonEntry,
  PlannedPayment,
  PlannedPaymentOccurrence,
  Settings,
  SplitParticipant,
  SplitGroup,
  Subscription,
  SubscriptionPayment,
  Transaction,
} from '../../types/models';
import { saveSharedExpensePosting } from '../../services/sharedExpense/SharedExpenseService';
import { accountTypeRows } from '../../services/accounts/AccountService';
import { validateSetupInput, type SetupValidationInput } from '../../services/onboarding/OnboardingService';
import { currencyRows } from '../../utils/currency';
import { calculateNextRenewal, getSubscriptionDueStatus, validateSubscriptionInput, type SubscriptionInput } from '../../services/subscriptions/SubscriptionService';
import { monthKey, todayLocal } from '../../utils/date';
import { decodeScheduleProvenance, newScheduleProvenance } from '../../services/planned/ScheduleProvenance';
import {
  isValidDateKey,
  nextPlannedDueDateAfterAction,
  validatePlannedPaymentInput,
  type PlannedPaymentInput,
} from '../../services/planned/PlannedPaymentService';

type Table =
  | 'accounts'
  | 'categories'
  | 'transactions'
  | 'budgets'
  | 'people'
  | 'person_entries'
  | 'subscriptions'
  | 'goals'
  | 'planned_payments'
  | 'groups';
const active = 'deleted_at IS NULL';

async function requireActiveAccount(db: AppDb, id: string | null | undefined): Promise<void> {
  if (!id || !await db.getFirstAsync('SELECT id FROM accounts WHERE id = ? AND deleted_at IS NULL AND is_archived = 0;', id))
    throw new Error('Choose an active account.');
}

/**
 * A move between accounts in different currencies records the exact amount that
 * arrived (after any exchange fee); nothing is converted. Same currency: one amount.
 */
export async function receivedAmountFor(
  db: AppDb,
  input: Pick<Transaction, 'type' | 'account_id' | 'destination_account_id' | 'destination_amount_minor'>,
): Promise<number | null> {
  if (input.type !== 'TRANSFER') return null;
  const from = await db.getFirstAsync<{ currency: string }>('SELECT currency FROM accounts WHERE id = ?;', input.account_id);
  const to = await db.getFirstAsync<{ currency: string }>('SELECT currency FROM accounts WHERE id = ?;', input.destination_account_id ?? null);
  if (!from || !to || from.currency === to.currency) return null;
  const received = input.destination_amount_minor;
  if (received == null || !Number.isSafeInteger(received) || received <= 0) throw new Error('Enter the amount that arrived.');
  return received;
}

/**
 * While everything is in one currency, changing it in Settings relabels all of
 * it, as before multiple currencies existed: amounts are never converted. Returns
 * false (and changes nothing) once anything uses another currency.
 */
export async function relabelOnlyCurrency(db: AppDb, to: string): Promise<boolean> {
  if (!currencyRows.some(([code]) => code === to)) throw new Error('Choose a valid currency.');
  let relabelled = false;
  await db.withExclusiveTransactionAsync(async (txn) => {
    const from = await mainCurrency(txn);
    if (await txn.getFirstAsync('SELECT 1 FROM accounts WHERE currency <> ? UNION ALL SELECT 1 FROM budgets WHERE currency <> ? UNION ALL SELECT 1 FROM goals WHERE currency <> ? LIMIT 1;', from, from, from)) return;
    // The lock that keeps a used account's currency is lifted only for this one relabel.
    await txn.execAsync('DROP TRIGGER IF EXISTS account_currency_locked;');
    await txn.runAsync('UPDATE accounts SET currency = ?;', to);
    await txn.runAsync('UPDATE budgets SET currency = ?;', to);
    await txn.runAsync('UPDATE goals SET currency = ?;', to);
    await txn.runAsync("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('currency', ?);", to);
    await txn.execAsync(accountCurrencyLock);
    relabelled = true;
  });
  return relabelled;
}

/** The currency chosen in Settings: new accounts start with it and it is shown first. */
export async function mainCurrency(db: AppDb): Promise<string> {
  return (await db.getFirstAsync<{ value: string }>("SELECT value FROM app_settings WHERE key = 'currency';"))?.value ?? 'PKR';
}

async function requireActivePerson(db: AppDb, id: string | null | undefined): Promise<void> {
  if (!id || !await db.getFirstAsync('SELECT id FROM people WHERE id = ? AND deleted_at IS NULL AND is_archived = 0;', id))
    throw new Error('Choose an active person.');
}

async function requireActiveCategory(db: AppDb, id: string | null | undefined, type: 'EXPENSE' | 'INCOME'): Promise<void> {
  if (!id || !await db.getFirstAsync('SELECT id FROM categories WHERE id = ? AND type = ? AND deleted_at IS NULL AND is_archived = 0;', id, type))
    throw new Error(`Choose an active ${type.toLowerCase()} category.`);
}

/** Every account's currency, archived and removed ones included, so old records keep theirs. */
export async function listAccountCurrencies(db: AppDb): Promise<{ id: string; currency: string }[]> {
  return db.getAllAsync('SELECT id, currency FROM accounts;');
}

export async function listAccounts(db: AppDb): Promise<Account[]> {
  return db.getAllAsync(
    `SELECT * FROM accounts WHERE ${active} AND is_archived = 0 ORDER BY name;`,
  );
}
export async function listCategories(
  db: AppDb,
  type?: string,
): Promise<Category[]> {
  return db.getAllAsync(
    `SELECT * FROM categories WHERE ${active} ${type ? 'AND type = ?' : ''} ORDER BY is_default DESC, name;`,
    ...(type ? [type] : []),
  );
}
export async function listTransactions(db: AppDb): Promise<Transaction[]> {
  return db.getAllAsync(
    `SELECT * FROM transactions WHERE ${active} ORDER BY occurred_on DESC, created_at DESC;`,
  );
}
export async function listBudgets(db: AppDb, month: string): Promise<Budget[]> {
  return db.getAllAsync(
    `SELECT * FROM budgets WHERE ${active} AND month_key = ? ORDER BY category_id IS NOT NULL, category_id;`,
    month,
  );
}
export async function listPeople(db: AppDb): Promise<Person[]> {
  return db.getAllAsync(
    `SELECT * FROM people WHERE ${active} AND is_archived = 0 ORDER BY name;`,
  );
}
export async function listAllPeople(db: AppDb): Promise<Person[]> {
  return db.getAllAsync(
    `SELECT * FROM people WHERE ${active} ORDER BY name;`,
  );
}
export async function listPersonEntries(
  db: AppDb,
  personId?: string,
): Promise<PersonEntry[]> {
  return db.getAllAsync(
    `SELECT * FROM person_entries WHERE ${active} ${personId ? 'AND person_id = ?' : ''} ORDER BY occurred_on DESC, created_at DESC;`,
    ...(personId ? [personId] : []),
  );
}
export async function listSubscriptions(db: AppDb): Promise<Subscription[]> {
  return db.getAllAsync(
    `SELECT * FROM subscriptions WHERE ${active} ORDER BY next_renewal_date;`,
  );
}
export async function listSplitParticipants(
  db: AppDb,
  splitGroupId: string,
): Promise<SplitParticipant[]> {
  return db.getAllAsync(
    'SELECT s.*, coalesce(p.name, s.name) name FROM split_participants s LEFT JOIN people p ON p.id = s.person_id WHERE s.split_group_id = ? ORDER BY s.created_at;',
    splitGroupId,
  );
}
export async function listSplitGroups(
  db: AppDb,
  groupId?: string,
): Promise<SplitGroup[]> {
  return db.getAllAsync(
    `SELECT s.*, coalesce(p.name, s.payer_name) payer_name FROM split_groups s LEFT JOIN people p ON p.id = s.payer_person_id WHERE s.${active} ${groupId ? 'AND s.group_id = ?' : ''} ORDER BY s.occurred_on DESC, s.created_at DESC;`,
    ...(groupId ? [groupId] : []),
  );
}
export async function listGoals(db: AppDb, includeArchived = false): Promise<Goal[]> {
  return db.getAllAsync(
    `SELECT g.*, a.name AS linked_account_name FROM goals g LEFT JOIN accounts a ON a.id = g.linked_account_id WHERE g.${active} ${includeArchived ? '' : 'AND g.is_archived = 0'} ORDER BY g.is_archived, g.target_date IS NULL, g.target_date, g.name;`,
  );
}
export async function listGoalEntries(
  db: AppDb,
  goalId?: string,
): Promise<GoalEntry[]> {
  return db.getAllAsync(
    `SELECT * FROM goal_entries WHERE ${active} ${goalId ? 'AND goal_id = ?' : ''} ORDER BY occurred_on DESC, created_at DESC;`,
    ...(goalId ? [goalId] : []),
  );
}
export async function listGroups(db: AppDb, includeArchived = false): Promise<Group[]> {
  return db.getAllAsync(
    `SELECT g.*, COUNT(gm.id) as member_count FROM groups g LEFT JOIN group_members gm ON gm.group_id = g.id WHERE g.${active} ${includeArchived ? '' : 'AND g.is_archived = 0'} GROUP BY g.id ORDER BY g.name;`,
  );
}
export async function listGroupMembers(
  db: AppDb,
  groupId?: string,
): Promise<GroupMember[]> {
  return db.getAllAsync(
    `SELECT * FROM group_members ${groupId ? 'WHERE group_id = ?' : ''} ORDER BY created_at;`,
    ...(groupId ? [groupId] : []),
  );
}
export async function listPlannedPayments(
  db: AppDb,
): Promise<PlannedPayment[]> {
  return db.getAllAsync(
    `SELECT p.*, a.name AS account_name FROM planned_payments p LEFT JOIN accounts a ON a.id = p.account_id WHERE p.${active} ORDER BY CASE p.status WHEN 'ACTIVE' THEN 0 WHEN 'PAUSED' THEN 1 ELSE 2 END, p.next_due_date, p.name;`,
  );
}

export async function getPlannedPayment(
  db: AppDb,
  id: string,
): Promise<PlannedPayment | null> {
  return db.getFirstAsync(
    `SELECT * FROM planned_payments WHERE ${active} AND id = ?;`,
    id,
  );
}

export async function listPlannedPaymentOccurrences(
  db: AppDb,
  plannedPaymentId: string,
): Promise<PlannedPaymentOccurrence[]> {
  return db.getAllAsync(
    `SELECT o.*, t.deleted_at AS transaction_deleted_at,
       t.amount_minor AS transaction_amount_minor,
       t.type AS transaction_type,
       t.title AS transaction_title
     FROM planned_payment_occurrences o
     LEFT JOIN transactions t ON t.id = o.transaction_id
     WHERE o.planned_payment_id = ?
     ORDER BY o.scheduled_date DESC, o.created_at DESC;`,
    plannedPaymentId,
  );
}

export async function getSettings(db: AppDb): Promise<Settings> {
  const rows = await db.getAllAsync<{ key: keyof Settings; value: string }>(
    'SELECT key, value FROM app_settings;',
  );
  return rows.reduce(
    (settings, row) => ({ ...settings, [row.key]: row.value }),
    {} as Settings,
  );
}

export async function setSetting(
  db: AppDb,
  key: keyof Settings,
  value: string,
): Promise<void> {
  await db.runAsync(
    'INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?);',
    key,
    value,
  );
}

export async function createAccount(
  db: AppDb,
  input: {
    name: string;
    type: string;
    opening_balance_minor: number;
    currency?: string;
  },
): Promise<void> {
  const cleanName = input.name.trim();
  if (!cleanName) throw new Error('Enter an account name.');
  if (!accountTypeRows.some(([type]) => type === input.type))
    throw new Error('Choose a valid account type.');
  if (!Number.isSafeInteger(input.opening_balance_minor) || input.opening_balance_minor < 0)
    throw new Error('Enter a valid opening balance.');
  const currency = input.currency ?? await mainCurrency(db);
  if (!currencyRows.some(([code]) => code === currency))
    throw new Error('Choose a valid currency.');
  await db.withExclusiveTransactionAsync(async (txn) => {
    // The same name is fine in another currency ("Cash" in Rs. and "Cash" in $).
    const duplicate = await txn.getFirstAsync(
      'SELECT id FROM accounts WHERE deleted_at IS NULL AND is_archived = 0 AND lower(trim(name)) = lower(?) AND currency = ? LIMIT 1;',
      cleanName,
      currency,
    );
    if (duplicate) throw new Error('ACCOUNT_NAME_EXISTS');
    const ts = nowIso();
    await txn.runAsync(
      'INSERT INTO accounts (id, name, type, currency, opening_balance_minor, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?);',
      makeId('account'), cleanName, input.type, currency,
      input.opening_balance_minor, ts, ts, 'LOCAL',
    );
  });
}

export async function createCategory(
  db: AppDb,
  input: { name: string; type: string; icon?: string; color_key?: string },
): Promise<void> {
  const name = input.name.trim();
  if (!name) throw new Error('Enter a category name.');
  if (input.type !== 'EXPENSE' && input.type !== 'INCOME') throw new Error('Choose a valid category type.');
  await db.withExclusiveTransactionAsync(async (txn) => {
    const duplicate = await txn.getFirstAsync('SELECT id FROM categories WHERE deleted_at IS NULL AND lower(trim(name)) = lower(?) AND type = ? LIMIT 1;', name, input.type);
    if (duplicate) throw new Error('CATEGORY_NAME_EXISTS');
    const ts = nowIso();
    await txn.runAsync(
    'INSERT INTO categories (id, name, type, icon, color_key, is_default, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);',
    makeId('category'),
    name,
    input.type,
    input.icon ?? 'pricetag-outline',
    input.color_key ?? 'primary',
    0,
    ts,
    ts,
    'LOCAL',
  );
  });
}

export async function renameCategory(db: AppDb, id: string, expectedUpdatedAt: string, name: string): Promise<void> {
  const cleanName = name.trim();
  if (!cleanName) throw new Error('Enter a category name.');
  await db.withExclusiveTransactionAsync(async (txn) => {
    const category = await txn.getFirstAsync<Category>('SELECT * FROM categories WHERE id = ? AND deleted_at IS NULL;', id);
    if (!category) throw new Error('Category is unavailable.');
    if (category.updated_at !== expectedUpdatedAt) throw new Error('Category changed. Reopen it before editing.');
    if (category.id === 'cat_expense_other' || category.id === 'cat_income_other_income') throw new Error('The fallback category name must stay available.');
    const duplicate = await txn.getFirstAsync('SELECT id FROM categories WHERE id <> ? AND deleted_at IS NULL AND type = ? AND lower(trim(name)) = lower(?) LIMIT 1;', id, category.type, cleanName);
    if (duplicate) throw new Error('CATEGORY_NAME_EXISTS');
    await txn.runAsync('UPDATE categories SET name = ?, updated_at = ?, sync_status = ? WHERE id = ?;', cleanName, new Date(Math.max(Date.now(), Date.parse(expectedUpdatedAt) + 1)).toISOString(), 'LOCAL', id);
  });
}

export async function archiveCategory(db: AppDb, id: string, expectedUpdatedAt: string): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    const category = await txn.getFirstAsync<Category>('SELECT * FROM categories WHERE id = ? AND deleted_at IS NULL;', id);
    if (!category) throw new Error('Category is unavailable.');
    if (category.updated_at !== expectedUpdatedAt) throw new Error('Category changed. Reopen it before deleting.');
    if (category.is_archived) return;
    if (category.id === 'cat_expense_other' || category.id === 'cat_income_other_income') throw new Error('Keep the Other fallback category active.');
    const dependency = await txn.getFirstAsync<{ name: string; kind: string }>("SELECT name, 'planned payment' kind FROM planned_payments WHERE category_id = ? AND status = 'ACTIVE' AND deleted_at IS NULL UNION ALL SELECT name, 'subscription' kind FROM subscriptions WHERE category_id = ? AND status = 'ACTIVE' AND deleted_at IS NULL LIMIT 1;", id, id);
    if (dependency) throw new Error(`This category is used by the active ${dependency.kind} \"${dependency.name}\". Edit that future definition to choose another category before deleting this one.`);
    await txn.runAsync('UPDATE categories SET is_archived = 1, updated_at = ?, sync_status = ? WHERE id = ?;', new Date(Math.max(Date.now(), Date.parse(expectedUpdatedAt) + 1)).toISOString(), 'LOCAL', id);
  });
}

/** User-facing deletion is metadata-only, including categories without history. */
export async function deleteCategory(db: AppDb, id: string, expectedUpdatedAt: string): Promise<void> {
  await archiveCategory(db, id, expectedUpdatedAt);
}

export async function restoreCategory(db: AppDb, id: string, expectedUpdatedAt: string): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    const category = await txn.getFirstAsync<Category>('SELECT * FROM categories WHERE id = ? AND deleted_at IS NULL;', id);
    if (!category) throw new Error('Category is unavailable.');
    if (category.updated_at !== expectedUpdatedAt) throw new Error('Category changed. Reopen it before restoring.');
    const duplicate = await txn.getFirstAsync('SELECT id FROM categories WHERE id <> ? AND deleted_at IS NULL AND is_archived = 0 AND type = ? AND lower(trim(name)) = lower(?) LIMIT 1;', id, category.type, category.name);
    if (duplicate) throw new Error('CATEGORY_NAME_EXISTS');
    await txn.runAsync('UPDATE categories SET is_archived = 0, updated_at = ?, sync_status = ? WHERE id = ?;', nowIso(), 'LOCAL', id);
  });
}

export async function saveTransaction(
  db: AppDb,
  input: Omit<
    Transaction,
    'id' | 'created_at' | 'updated_at' | 'deleted_at' | 'sync_status'
  >,
): Promise<string> {
  if (input.cash_effect_minor != null) throw new Error('Shared cash effects must be posted through SharedExpenseService.');
  if (input.type === 'ADJUSTMENT')
    throw new Error('Use Adjust Balance to record a balance correction.');
  await requireActiveAccount(db, input.account_id);
  if (input.type === 'TRANSFER') {
    await requireActiveAccount(db, input.destination_account_id);
    if (input.destination_account_id === input.account_id)
      throw new Error('Choose different accounts.');
  }
  const destinationAmount = await receivedAmountFor(db, input);
  if (input.type === 'EXPENSE' || input.type === 'INCOME') await requireActiveCategory(db, input.category_id, input.type);
  const id = makeId('tx');
  const ts = nowIso();
  await db.runAsync(
    'INSERT INTO transactions (id, type, amount_minor, account_id, destination_account_id, destination_amount_minor, category_id, title, note, occurred_on, source, group_id, financial_event_id, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);',
    id,
    input.type,
    input.amount_minor,
    input.account_id,
    input.destination_account_id ?? null,
    destinationAmount,
    input.category_id ?? null,
    input.title.trim(),
    input.note ?? null,
    input.occurred_on,
    input.source,
    input.group_id ?? null,
    input.financial_event_id ?? null,
    ts,
    ts,
    'LOCAL',
  );
  return id;
}

export async function savePerson(
  db: AppDb,
  name: string,
  note = '',
): Promise<string> {
  const cleanName = name.trim();
  if (!cleanName) throw new Error('Enter a person name.');
  let id = '';
  await db.withExclusiveTransactionAsync(async (txn) => {
    const existing = await txn.getFirstAsync<{ id: string; is_archived: number }>(
      'SELECT id, is_archived FROM people WHERE lower(trim(name)) = lower(?) AND deleted_at IS NULL LIMIT 1;',
      cleanName,
    );
    if (existing?.is_archived) throw new Error('A person with this name is archived.');
    if (existing) { id = existing.id; return; }
    id = makeId('person');
    const ts = nowIso();
    await txn.runAsync(
      'INSERT INTO people (id, name, note, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?, ?);',
      id,
      cleanName,
      note.trim() || null,
      ts,
      ts,
      'LOCAL',
    );
  });
  return id;
}
export async function savePersonEntry(
  db: AppDb,
  input: Omit<
    PersonEntry,
    'id' | 'created_at' | 'updated_at' | 'deleted_at' | 'sync_status'
  >,
): Promise<string> {
  await requireActiveAccount(db, input.account_id);
  await requireActivePerson(db, input.person_id);
  const id = makeId('entry');
  const ts = nowIso();
  await db.runAsync(
    'INSERT INTO person_entries (id, person_id, type, amount_minor, account_id, title, note, occurred_on, split_group_id, financial_event_id, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);',
    id,
    input.person_id,
    input.type,
    input.amount_minor,
    input.account_id,
    input.title.trim(),
    input.note ?? null,
    input.occurred_on,
    input.split_group_id ?? null,
    input.financial_event_id ?? null,
    ts,
    ts,
    'LOCAL',
  );
  return id;
}
export async function saveBudget(
  db: AppDb,
  input: {
    month_key: string;
    category_id?: string | null;
    amount_minor: number;
    /** Each currency has its own plan; the main currency when not given. */
    currency?: string;
  },
): Promise<void> {
  const currency = input.currency ?? await mainCurrency(db);
  if (!currencyRows.some(([code]) => code === currency)) throw new Error('Choose a valid currency.');
  const ts = nowIso();
  await db.runAsync(
    "INSERT OR REPLACE INTO budgets (id, month_key, category_id, amount_minor, currency, created_at, updated_at, sync_status, ownership) VALUES (COALESCE((SELECT id FROM budgets WHERE month_key = ? AND ifnull(category_id, ?) = ifnull(?, ?) AND currency = ? AND deleted_at IS NULL), ?), ?, ?, ?, ?, ?, ?, ?, 'USER');",
    input.month_key,
    'TOTAL',
    input.category_id ?? null,
    'TOTAL',
    currency,
    makeId('budget'),
    input.month_key,
    input.category_id ?? null,
    input.amount_minor,
    currency,
    ts,
    ts,
    'LOCAL',
  );
}
export async function completeSetup(db: AppDb, input: SetupValidationInput): Promise<void> {
  const validation = validateSetupInput(input);
  if (!validation.ok) throw new Error(validation.message);
  await db.withExclusiveTransactionAsync(async (txn) => {
    // A retry after a successful commit (but failed refresh) must not reset balances.
    const settings = await getSettings(txn);
    if (settings.setup_complete === 'true') return;
    const ts = nowIso();
    await txn.runAsync(
      'INSERT INTO accounts (id, name, type, currency, opening_balance_minor, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type, currency = excluded.currency, opening_balance_minor = excluded.opening_balance_minor, is_archived = 0, deleted_at = NULL, updated_at = excluded.updated_at, sync_status = excluded.sync_status;',
      'account_cash_default', 'Cash', 'CASH', input.currency,
      validation.startingCashMinor, ts, ts, 'LOCAL',
    );
    await setSetting(txn, 'user_name', validation.name);
    await setSetting(txn, 'currency', input.currency);
    if (validation.monthlyPlanMinor !== null)
      await saveBudget(txn, {
        month_key: monthKey(todayLocal()),
        amount_minor: validation.monthlyPlanMinor,
      });
    await setSetting(txn, 'setup_complete', 'true');
  });
}
export async function saveSubscription(
  db: AppDb,
  input: SubscriptionInput,
  options: { recordToday?: boolean } = {},
): Promise<string> {
  validateSubscriptionInput(input);
  const paymentDate = todayLocal();
  if (options.recordToday && (input.start_date !== paymentDate || input.next_renewal_date !== paymentDate)) throw new Error('Record Today requires a subscription starting today. Check the start date again.');
  const id = makeId('sub');
  const ts = nowIso();
  await db.withExclusiveTransactionAsync(async (txn) => {
  await requireActiveAccount(txn, input.account_id);
  await requireActiveCategory(txn, input.category_id, 'EXPENSE');
  await txn.runAsync(
    'INSERT INTO subscriptions (id, name, amount_minor, category_id, account_id, frequency_type, frequency_interval, start_date, next_renewal_date, end_date, total_cycles, completed_cycles, reminder_enabled, reminder_days_before, cancellation_reminder_enabled, cancellation_reminder_date, status, note, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);',
    id,
    input.name.trim(),
    input.amount_minor,
    input.category_id,
    input.account_id,
    input.frequency_type,
    input.frequency_interval,
    input.start_date,
    input.next_renewal_date,
    input.end_date ?? null,
    input.total_cycles ?? null,
    0,
    input.reminder_enabled,
    input.reminder_days_before,
    input.cancellation_reminder_enabled,
    input.cancellation_reminder_date ?? null,
    'ACTIVE',
    input.note ?? null,
    ts,
    ts,
    'LOCAL',
  );
  await txn.runAsync('UPDATE subscriptions SET recurrence_anchor_day = ?, schedule_provenance = ? WHERE id = ?;', Number(input.start_date.slice(8)), newScheduleProvenance(input.next_renewal_date, input.frequency_type, input.frequency_interval, input.end_date, input.total_cycles, Number(input.start_date.slice(8))), id);
  if (options.recordToday) await recordSubscriptionPayment(txn, id, paymentDate, ts, paymentDate);
  });
  return id;
}
export async function getSubscription(db: AppDb, id: string) {
  return db.getFirstAsync<Subscription & { account_name: string | null; category_name: string | null }>(
    'SELECT s.*, a.name account_name, c.name category_name FROM subscriptions s LEFT JOIN accounts a ON a.id = s.account_id LEFT JOIN categories c ON c.id = s.category_id WHERE s.id = ? AND s.deleted_at IS NULL;', id,
  );
}

export async function listSubscriptionPayments(db: AppDb, id: string): Promise<SubscriptionPayment[]> {
  return db.getAllAsync<SubscriptionPayment>(
    `SELECT p.*, t.title transaction_title, t.amount_minor transaction_amount_minor, t.occurred_on transaction_date,
      CASE WHEN t.id IS NOT NULL AND t.deleted_at IS NULL THEN 1 ELSE 0 END transaction_available,
      a.name account_name, c.name category_name
     FROM subscription_payments p LEFT JOIN transactions t ON t.id = p.transaction_id AND t.financial_event_id = p.id AND t.source = 'SUBSCRIPTION' AND t.type = 'EXPENSE'
     LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN categories c ON c.id = t.category_id
     WHERE p.subscription_id = ? ORDER BY p.scheduled_date DESC, p.id;`, id,
  );
}

function nextSubscriptionVersion(sub: Subscription): string {
  return new Date(Math.max(Date.now(), Date.parse(sub.updated_at) + 1)).toISOString();
}

export async function markSubscriptionPaid(db: AppDb, id: string, scheduledDate: string, expectedUpdatedAt: string, paymentDate = todayLocal()): Promise<string> {
  let transactionId = '';
  await db.withExclusiveTransactionAsync(async (txn) => {
    transactionId = await recordSubscriptionPayment(txn, id, scheduledDate, expectedUpdatedAt, paymentDate);
  });
  return transactionId;
}

// The caller owns the transaction, including creation + an optional first payment.
// scheduledDate consumes one occurrence; paymentDate is when real cash moved.
async function recordSubscriptionPayment(txn: AppDb, id: string, scheduledDate: string, expectedUpdatedAt: string, paymentDate: string): Promise<string> {
    if (!isValidDateKey(paymentDate) || paymentDate > todayLocal()) throw new Error('Payment date must be today or an earlier valid date.');
    const sub = await getSubscription(txn, id);
    if (!sub) throw new Error('Subscription no longer exists.');
    if (await txn.getFirstAsync('SELECT id FROM subscription_payments WHERE subscription_id = ? AND scheduled_date = ?;', id, scheduledDate)) throw new Error('This subscription occurrence was already paid.');
    if (sub.updated_at !== expectedUpdatedAt || sub.next_renewal_date !== scheduledDate) throw new Error('Subscription changed. Reopen it before recording payment.');
    if (sub.status !== 'ACTIVE' || getSubscriptionDueStatus(sub, todayLocal()).status === 'ENDED') throw new Error('Only active subscriptions can be paid.');
    validateSubscriptionInput(sub);
    // For legacy definitions the original start date is the saved billing anchor.
    // No old financial records are inferred or backfilled.
    const anchor = sub.recurrence_anchor_day ?? Number(sub.start_date.slice(8));
    const next = calculateNextRenewal(scheduledDate, sub.frequency_type, sub.frequency_interval, anchor);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next) || next <= scheduledDate) throw new Error('The next renewal is outside the supported date range.');
    const ended = (sub.end_date && next > sub.end_date) || (sub.total_cycles != null && sub.completed_cycles + 1 >= sub.total_cycles);
    const paymentId = makeId('subscription_payment');
    const transactionId = await saveTransaction(txn, {
      type: 'EXPENSE', amount_minor: sub.amount_minor, account_id: sub.account_id,
      category_id: sub.category_id, title: sub.name, note: sub.note,
      occurred_on: paymentDate, source: 'SUBSCRIPTION', financial_event_id: paymentId,
    });
    await txn.runAsync('INSERT INTO subscription_payments (id, subscription_id, scheduled_date, transaction_id, created_at, schedule_provenance) VALUES (?, ?, ?, ?, ?, ?);', paymentId, id, scheduledDate, transactionId, nowIso(), sub.schedule_provenance ?? null);
    await txn.runAsync('UPDATE subscriptions SET completed_cycles = completed_cycles + 1, next_renewal_date = ?, recurrence_anchor_day = ?, status = ?, updated_at = ?, sync_status = ? WHERE id = ?;', ended ? scheduledDate : next, anchor, ended ? 'ENDED' : 'ACTIVE', nextSubscriptionVersion(sub), 'LOCAL', id);
    return transactionId;
}

export async function updateSubscription(db: AppDb, id: string, expectedUpdatedAt: string, input: SubscriptionInput): Promise<void> {
  validateSubscriptionInput(input);
  await db.withExclusiveTransactionAsync(async (txn) => {
    const sub = await getSubscription(txn, id);
    if (!sub || sub.updated_at !== expectedUpdatedAt) throw new Error('Subscription changed. Reopen it before editing.');
    if (!['ACTIVE', 'PAUSED'].includes(sub.status)) throw new Error('This subscription has no future tracking to edit.');
    await requireActiveAccount(txn, input.account_id);
    await requireActiveCategory(txn, input.category_id, 'EXPENSE');
    if (input.start_date !== sub.start_date) throw new Error('The original start date is kept for history. Edit the next billing date instead.');
    if (input.total_cycles != null && input.total_cycles <= sub.completed_cycles) throw new Error('The cycle limit must leave a future payment.');
    if (await txn.getFirstAsync('SELECT id FROM subscription_payments WHERE subscription_id = ? AND scheduled_date = ?;', id, input.next_renewal_date)) throw new Error('That occurrence was already paid. Choose a future billing date.');
    const anchor = input.next_renewal_date !== sub.next_renewal_date ? Number(input.next_renewal_date.slice(8)) : sub.recurrence_anchor_day ?? Number(sub.start_date.slice(8));
    const scheduleChanged = input.next_renewal_date !== sub.next_renewal_date || input.frequency_type !== sub.frequency_type || input.frequency_interval !== sub.frequency_interval || (input.end_date ?? null) !== (sub.end_date ?? null) || (input.total_cycles ?? null) !== (sub.total_cycles ?? null);
    if (scheduleChanged) await txn.runAsync('UPDATE subscriptions SET schedule_provenance = ? WHERE id = ?;', newScheduleProvenance(input.next_renewal_date, input.frequency_type, input.frequency_interval, input.end_date, input.total_cycles, anchor), id);
    await txn.runAsync(`UPDATE subscriptions SET name = ?, amount_minor = ?, category_id = ?, account_id = ?, frequency_type = ?, frequency_interval = ?, next_renewal_date = ?, recurrence_anchor_day = ?, end_date = ?, total_cycles = ?, reminder_enabled = ?, reminder_days_before = ?, cancellation_reminder_enabled = ?, cancellation_reminder_date = ?, note = ?, updated_at = ?, sync_status = 'LOCAL', user_managed = 1 WHERE id = ?;`,
      input.name.trim(), input.amount_minor, input.category_id, input.account_id, input.frequency_type, input.frequency_interval, input.next_renewal_date, anchor, input.end_date ?? null, input.total_cycles ?? null, input.reminder_enabled, input.reminder_days_before, input.cancellation_reminder_enabled, input.cancellation_reminder_date ?? null, input.note?.trim() || null, nextSubscriptionVersion(sub), id);
  });
}

export async function changeSubscriptionStatus(db: AppDb, id: string, expectedUpdatedAt: string, status: 'ACTIVE' | 'PAUSED' | 'CANCELLED'): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    const sub = await getSubscription(txn, id);
    if (!sub || sub.updated_at !== expectedUpdatedAt) throw new Error('Subscription changed. Reopen it before continuing.');
    if (status === 'ACTIVE' ? sub.status !== 'PAUSED' : !['ACTIVE', 'PAUSED'].includes(sub.status)) throw new Error('This subscription status cannot be changed.');
    if (status === 'ACTIVE') {
      await requireActiveAccount(txn, sub.account_id);
      await requireActiveCategory(txn, sub.category_id, 'EXPENSE');
    }
    await txn.runAsync("UPDATE subscriptions SET status = ?, updated_at = ?, sync_status = 'LOCAL', user_managed = 1 WHERE id = ?;", status, nextSubscriptionVersion(sub), id);
  });
}

export async function softDelete(
  db: AppDb,
  table: Table,
  id: string,
): Promise<void> {
  if (table === 'transactions' || table === 'person_entries')
    throw new Error('Financial records must be changed through their complete activity.');
  if (table === 'groups') throw new Error('Use Archive Group to preserve historical expenses and members.');
  if (table === 'subscriptions') throw new Error('Use Cancel Tracking to preserve subscription history.');
  await db.runAsync(
    `UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE id = ?;`,
    nowIso(),
    nowIso(),
    id,
  );
}

export async function saveGoal(
  db: AppDb,
  input: {
    name: string;
    target_amount_minor: number;
    initial_saved_minor: number;
    target_date?: string | null;
    linked_account_id?: string | null;
    note?: string | null;
    /** Used when no account is linked; a linked account decides the currency. */
    currency?: string;
  },
): Promise<string> {
  if (!input.name.trim()) throw new Error('Enter a goal name.');
  if (!Number.isSafeInteger(input.target_amount_minor) || input.target_amount_minor <= 0)
    throw new Error('Enter a target amount greater than zero.');
  if (!Number.isSafeInteger(input.initial_saved_minor) || input.initial_saved_minor < 0)
    throw new Error('Enter a valid saved amount.');
  if (input.linked_account_id) await requireActiveAccount(db, input.linked_account_id);
  const linked = input.linked_account_id ? await db.getFirstAsync<{ currency: string }>('SELECT currency FROM accounts WHERE id = ?;', input.linked_account_id) : null;
  const currency = linked?.currency ?? input.currency ?? await mainCurrency(db);
  if (!currencyRows.some(([code]) => code === currency)) throw new Error('Choose a valid currency.');
  const id = makeId('goal');
  const ts = nowIso();
  await db.runAsync(
    'INSERT INTO goals (id, name, target_amount_minor, initial_saved_minor, target_date, linked_account_id, note, currency, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);',
    id,
    input.name.trim(),
    input.target_amount_minor,
    input.initial_saved_minor,
    input.target_date ?? null,
    input.linked_account_id ?? null,
    input.note ?? null,
    currency,
    ts,
    ts,
    'LOCAL',
  );
  return id;
}
export async function saveGoalEntry(
  db: AppDb,
  input: {
    goal_id: string;
    type: GoalEntry['type'];
    amount_minor: number;
    occurred_on: string;
    note?: string | null;
  },
): Promise<string> {
  const id = makeId('goal_entry');
  if (input.type !== 'ADD' && input.type !== 'WITHDRAW') throw new Error('Choose whether to add or withdraw money.');
  if (!Number.isSafeInteger(input.amount_minor) || input.amount_minor <= 0) throw new Error('Enter an amount greater than zero.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.occurred_on)) throw new Error('Enter a valid date.');
  await db.withExclusiveTransactionAsync(async (txn) => {
    const goal = await txn.getFirstAsync<Goal>('SELECT * FROM goals WHERE id = ? AND deleted_at IS NULL;', input.goal_id);
    if (!goal) throw new Error('Goal no longer exists.');
    if (goal.is_archived) throw new Error('Archived goals cannot be changed.');
    const entries = await txn.getAllAsync<GoalEntry>('SELECT * FROM goal_entries WHERE goal_id = ? AND deleted_at IS NULL;', goal.id);
    const savedMinor = goal.initial_saved_minor + entries.reduce((total, entry) => total + (entry.type === 'WITHDRAW' ? -entry.amount_minor : entry.amount_minor), 0);
    if (input.type === 'WITHDRAW' && input.amount_minor > savedMinor) throw new Error(`You can withdraw up to ${savedMinor} minor units currently tracked in this goal.`);
    const ts = nowIso();
    await txn.runAsync(
      'INSERT INTO goal_entries (id, goal_id, type, amount_minor, occurred_on, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?);',
      id, input.goal_id, input.type, input.amount_minor, input.occurred_on, input.note?.trim() || null, ts, ts,
    );
  });
  return id;
}

export async function updateGoal(db: AppDb, id: string, expectedUpdatedAt: string, input: Pick<Goal, 'name' | 'target_amount_minor' | 'target_date' | 'linked_account_id' | 'note'>): Promise<void> {
  const name = input.name.trim();
  if (!name) throw new Error('Enter a goal name.');
  if (!Number.isSafeInteger(input.target_amount_minor) || input.target_amount_minor <= 0) throw new Error('Enter a target amount greater than zero.');
  await db.withExclusiveTransactionAsync(async (txn) => {
    const goal = await txn.getFirstAsync<Goal>('SELECT * FROM goals WHERE id = ? AND deleted_at IS NULL;', id);
    if (!goal) throw new Error('Goal no longer exists.');
    if (goal.is_archived) throw new Error('Archived goals cannot be edited.');
    if (goal.updated_at !== expectedUpdatedAt) throw new Error('Goal changed. Reopen it before editing.');
    if (input.linked_account_id) await requireActiveAccount(txn, input.linked_account_id);
    if (input.linked_account_id && (await txn.getFirstAsync<{ currency: string }>('SELECT currency FROM accounts WHERE id = ?;', input.linked_account_id))?.currency !== goal.currency)
      throw new Error("Link an account that uses the goal's currency.");
    const entries = await txn.getAllAsync<GoalEntry>('SELECT * FROM goal_entries WHERE goal_id = ? AND deleted_at IS NULL;', id);
    const savedMinor = goal.initial_saved_minor + entries.reduce((total, entry) => total + (entry.type === 'WITHDRAW' ? -entry.amount_minor : entry.amount_minor), 0);
    if (input.target_amount_minor < savedMinor) throw new Error('The target cannot be lower than the amount already saved.');
    await txn.runAsync(
      'UPDATE goals SET name = ?, target_amount_minor = ?, target_date = ?, linked_account_id = ?, note = ?, updated_at = ?, sync_status = ? WHERE id = ?;',
      name, input.target_amount_minor, input.target_date ?? null, input.linked_account_id ?? null, input.note?.trim() || null,
      new Date(Math.max(Date.now(), Date.parse(goal.updated_at) + 1)).toISOString(), 'LOCAL', id,
    );
  });
}

export async function archiveGoal(db: AppDb, id: string, expectedUpdatedAt: string): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    const goal = await txn.getFirstAsync<Goal>('SELECT * FROM goals WHERE id = ? AND deleted_at IS NULL;', id);
    if (!goal) throw new Error('Goal no longer exists.');
    if (goal.is_archived) return;
    if (goal.updated_at !== expectedUpdatedAt) throw new Error('Goal changed. Reopen it before archiving.');
    await txn.runAsync('UPDATE goals SET is_archived = 1, updated_at = ?, sync_status = ? WHERE id = ?;', new Date(Math.max(Date.now(), Date.parse(goal.updated_at) + 1)).toISOString(), 'LOCAL', id);
  });
}

export async function restoreGoal(db: AppDb, id: string, expectedUpdatedAt: string): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    const goal = await txn.getFirstAsync<Goal>('SELECT * FROM goals WHERE id = ? AND deleted_at IS NULL;', id);
    if (!goal) throw new Error('Goal no longer exists.');
    if (goal.updated_at !== expectedUpdatedAt) throw new Error('Goal changed. Reopen it before restoring.');
    if (!goal.is_archived) throw new Error('This goal is already active.');
    // Reference accounts may be archived; restoring tracking moves no money.
    await txn.runAsync('UPDATE goals SET is_archived = 0, updated_at = ?, sync_status = ? WHERE id = ?;', new Date(Math.max(Date.now(), Date.parse(goal.updated_at) + 1)).toISOString(), 'LOCAL', id);
  });
}

export async function deleteEmptyGoal(db: AppDb, id: string, expectedUpdatedAt: string): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    const goal = await txn.getFirstAsync<Goal>('SELECT * FROM goals WHERE id = ? AND deleted_at IS NULL;', id);
    if (!goal) throw new Error('Goal no longer exists.');
    if (goal.updated_at !== expectedUpdatedAt) throw new Error('Goal changed. Reopen it before deleting.');
    const history = await txn.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM goal_entries WHERE goal_id = ? AND deleted_at IS NULL;', id);
    if ((history?.count ?? 0) > 0 || goal.initial_saved_minor > 0) throw new Error('Goals with saved money or history must be archived to preserve their record.');
    await txn.runAsync('UPDATE goals SET deleted_at = ?, updated_at = ? WHERE id = ?;', nowIso(), nowIso(), id);
  });
}
export async function createGroup(
  db: AppDb,
  input: {
    name: string;
    description?: string;
    personIds: string[];
    includeSelf?: boolean;
  },
): Promise<string> {
  const id = makeId('group');
  const ts = nowIso();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      'INSERT INTO groups (id, name, description, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?, ?);',
      id,
      input.name.trim(),
      input.description?.trim() || null,
      ts,
      ts,
      'LOCAL',
    );
    if (input.includeSelf ?? true)
      await db.runAsync(
        'INSERT INTO group_members (id, group_id, person_id, is_self, created_at) VALUES (?, ?, ?, ?, ?);',
        makeId('group_member'),
        id,
        null,
        1,
        ts,
      );
    for (const personId of input.personIds)
      await db.runAsync(
        'INSERT INTO group_members (id, group_id, person_id, is_self, created_at) VALUES (?, ?, ?, ?, ?);',
        makeId('group_member'),
        id,
        personId,
        0,
        ts,
      );
  });
  return id;
}
export async function savePlannedPayment(
  db: AppDb,
  input: PlannedPaymentInput,
): Promise<string> {
  validatePlannedPaymentInput(input);
  await requireActiveAccount(db, input.account_id);
  await requireActiveCategory(db, input.category_id, input.type);
  const id = makeId('planned');
  const ts = nowIso();
  await db.runAsync(
    'INSERT INTO planned_payments (id, name, type, amount_minor, category_id, account_id, next_due_date, recurrence_type, recurrence_interval, end_date, occurrence_limit, completed_occurrences, reminder_enabled, reminder_days_before, subscription_metadata, status, note, created_at, updated_at, sync_status, schedule_provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);',
    id,
    input.name.trim(),
    input.type,
    input.amount_minor,
    input.category_id,
    input.account_id,
    input.next_due_date,
    input.recurrence_type,
    input.recurrence_interval,
    input.end_date ?? null,
    input.occurrence_limit ?? null,
    0,
    input.reminder_enabled,
    input.reminder_days_before,
    input.subscription_metadata ?? null,
    'ACTIVE',
    input.note ?? null,
    ts,
    ts,
    'LOCAL',
    newScheduleProvenance(input.next_due_date, input.recurrence_type, input.recurrence_interval, input.end_date, input.occurrence_limit),
  );
  return id;
}
export async function markPlannedPaymentPaid(
  db: AppDb,
  plannedPaymentId: string,
  scheduledDate: string,
): Promise<string> {
  let transactionId = '';
  await db.withExclusiveTransactionAsync(async (txn) => {
    const planned = await txn.getFirstAsync<PlannedPayment>(
      'SELECT * FROM planned_payments WHERE id = ? AND deleted_at IS NULL;',
      plannedPaymentId,
    );
    if (!planned) throw new Error('Planned payment no longer exists.');
    const existing = await txn.getFirstAsync(
      'SELECT id FROM planned_payment_occurrences WHERE planned_payment_id = ? AND scheduled_date = ?;',
      plannedPaymentId,
      scheduledDate,
    );
    if (existing) throw new Error('This scheduled occurrence was already handled.');
    if (planned.status !== 'ACTIVE') throw new Error('Only active planned payments can be recorded.');
    if (planned.next_due_date !== scheduledDate)
      throw new Error('This occurrence changed. Reopen the planned payment.');
    await requireActiveAccount(txn, planned.account_id);
    await requireActiveCategory(txn, planned.category_id, planned.type);
    const nextDueDate = nextPlannedDueDateAfterAction(planned, planned.schedule_provenance ? decodeScheduleProvenance(planned.schedule_provenance).anchorDay : undefined);
    const occurrenceId = makeId('planned_occurrence');
    transactionId = await saveTransaction(txn, {
      type: planned.type,
      amount_minor: planned.amount_minor,
      account_id: planned.account_id,
      destination_account_id: null,
      category_id: planned.category_id,
      title: planned.name,
      note: planned.note,
      occurred_on: scheduledDate,
      source: 'PLANNED',
      financial_event_id: occurrenceId,
    });
    await txn.runAsync(
      'INSERT INTO planned_payment_occurrences (id, planned_payment_id, scheduled_date, outcome, transaction_id, created_at, schedule_provenance) VALUES (?, ?, ?, ?, ?, ?, ?);',
      occurrenceId,
      planned.id,
      scheduledDate,
      'RECORDED',
      transactionId,
      nowIso(),
      planned.schedule_provenance ?? null,
    );
    await txn.runAsync(
      'UPDATE planned_payments SET completed_occurrences = completed_occurrences + 1, next_due_date = COALESCE(?, next_due_date), status = CASE WHEN ? IS NULL THEN ? ELSE status END, updated_at = ? WHERE id = ?;',
      nextDueDate,
      nextDueDate,
      'ENDED',
      nowIso(),
      planned.id,
    );
  });
  return transactionId;
}
export async function skipPlannedPayment(
  db: AppDb,
  plannedPaymentId: string,
  scheduledDate: string,
): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    const planned = await txn.getFirstAsync<PlannedPayment>(
      'SELECT * FROM planned_payments WHERE id = ? AND deleted_at IS NULL;',
      plannedPaymentId,
    );
    if (!planned) throw new Error('Planned payment no longer exists.');
    const existing = await txn.getFirstAsync(
      'SELECT id FROM planned_payment_occurrences WHERE planned_payment_id = ? AND scheduled_date = ?;',
      plannedPaymentId,
      scheduledDate,
    );
    if (existing) throw new Error('This scheduled occurrence was already handled.');
    if (planned.status !== 'ACTIVE') throw new Error('Only active planned payments can be skipped.');
    if (planned.next_due_date !== scheduledDate)
      throw new Error('This occurrence changed. Reopen the planned payment.');
    const nextDueDate = nextPlannedDueDateAfterAction(planned, planned.schedule_provenance ? decodeScheduleProvenance(planned.schedule_provenance).anchorDay : undefined);
    await txn.runAsync(
      'INSERT INTO planned_payment_occurrences (id, planned_payment_id, scheduled_date, outcome, transaction_id, created_at, schedule_provenance) VALUES (?, ?, ?, ?, NULL, ?, ?);',
      makeId('planned_occurrence'),
      planned.id,
      scheduledDate,
      'SKIPPED',
      nowIso(),
      planned.schedule_provenance ?? null,
    );
    await txn.runAsync(
      'UPDATE planned_payments SET next_due_date = COALESCE(?, next_due_date), status = CASE WHEN ? IS NULL THEN ? ELSE status END, updated_at = ? WHERE id = ?;',
      nextDueDate,
      nextDueDate,
      'ENDED',
      nowIso(),
      planned.id,
    );
  });
}

export async function updatePlannedPayment(
  db: AppDb,
  id: string,
  expectedUpdatedAt: string,
  input: PlannedPaymentInput,
): Promise<void> {
  validatePlannedPaymentInput(input);
  await db.withExclusiveTransactionAsync(async (txn) => {
    const planned = await txn.getFirstAsync<PlannedPayment>(
      'SELECT * FROM planned_payments WHERE id = ? AND deleted_at IS NULL;',
      id,
    );
    if (!planned) throw new Error('Planned payment no longer exists.');
    if (planned.updated_at !== expectedUpdatedAt)
      throw new Error('Planned payment changed. Reopen it before editing.');
    if (planned.status === 'ENDED') throw new Error('Ended planned payments have no future schedule to edit.');
    const history = await txn.getFirstAsync<{ count: number }>(
      "SELECT COUNT(*) AS count FROM planned_payment_occurrences WHERE planned_payment_id = ? AND outcome = 'RECORDED';",
      id,
    );
    if ((history?.count ?? 0) > 0 && input.type !== planned.type)
      throw new Error('Type cannot change after occurrence history has been recorded.');
    if (input.next_due_date !== planned.next_due_date && await txn.getFirstAsync('SELECT id FROM planned_payment_occurrences WHERE planned_payment_id = ? AND scheduled_date = ?;', id, input.next_due_date)) throw new Error('That scheduled date was already handled. Review the payment history or choose another date.');
    await requireActiveAccount(txn, input.account_id);
    await requireActiveCategory(txn, input.category_id, input.type);
    const scheduleChanged = input.next_due_date !== planned.next_due_date || input.recurrence_type !== planned.recurrence_type || input.recurrence_interval !== planned.recurrence_interval || (input.end_date ?? null) !== (planned.end_date ?? null) || (input.occurrence_limit ?? null) !== (planned.occurrence_limit ?? null);
    const anchorDay = input.next_due_date !== planned.next_due_date ? Number(input.next_due_date.slice(8)) : planned.schedule_provenance ? decodeScheduleProvenance(planned.schedule_provenance).anchorDay : Number(planned.next_due_date.slice(8));
    if (scheduleChanged) await txn.runAsync('UPDATE planned_payments SET schedule_provenance = ? WHERE id = ?;', newScheduleProvenance(input.next_due_date, input.recurrence_type, input.recurrence_interval, input.end_date, input.occurrence_limit, anchorDay), id);
    await txn.runAsync(
      `UPDATE planned_payments SET name = ?, type = ?, amount_minor = ?, category_id = ?, account_id = ?, next_due_date = ?, recurrence_type = ?, recurrence_interval = ?, end_date = ?, occurrence_limit = ?, reminder_enabled = ?, reminder_days_before = ?, subscription_metadata = ?, note = ?, updated_at = ?, sync_status = 'LOCAL' WHERE id = ?;`,
      input.name.trim(), input.type, input.amount_minor, input.category_id,
      input.account_id, input.next_due_date, input.recurrence_type,
      input.recurrence_interval, input.end_date ?? null,
      input.occurrence_limit ?? null, input.reminder_enabled,
      input.reminder_days_before, input.subscription_metadata ?? null,
      input.note?.trim() || null,
      new Date(Math.max(Date.now(), Date.parse(planned.updated_at) + 1)).toISOString(),
      id,
    );
  });
}

export async function pausePlannedPayment(
  db: AppDb,
  id: string,
  expectedUpdatedAt: string,
): Promise<void> {
  await changePlannedPaymentStatus(db, id, expectedUpdatedAt, 'ACTIVE', 'PAUSED');
}

export async function resumePlannedPayment(
  db: AppDb,
  id: string,
  expectedUpdatedAt: string,
): Promise<void> {
  await changePlannedPaymentStatus(db, id, expectedUpdatedAt, 'PAUSED', 'ACTIVE');
}

async function changePlannedPaymentStatus(
  db: AppDb,
  id: string,
  expectedUpdatedAt: string,
  from: PlannedPayment['status'],
  to: PlannedPayment['status'],
): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    const planned = await txn.getFirstAsync<PlannedPayment>(
      'SELECT * FROM planned_payments WHERE id = ? AND deleted_at IS NULL;',
      id,
    );
    if (!planned) throw new Error('Planned payment no longer exists.');
    if (planned.updated_at !== expectedUpdatedAt)
      throw new Error('Planned payment changed. Reopen it before continuing.');
    if (planned.status !== from) throw new Error(`This planned payment is already ${planned.status.toLowerCase()}.`);
    if (to === 'ACTIVE') {
      await requireActiveAccount(txn, planned.account_id);
      await requireActiveCategory(txn, planned.category_id, planned.type);
    }
    await txn.runAsync(
      "UPDATE planned_payments SET status = ?, updated_at = ?, sync_status = 'LOCAL' WHERE id = ?;",
      to,
      new Date(Math.max(Date.now(), Date.parse(planned.updated_at) + 1)).toISOString(),
      id,
    );
  });
}

export async function stopTrackingPlannedPayment(
  db: AppDb,
  id: string,
  expectedUpdatedAt: string,
): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    const planned = await txn.getFirstAsync<PlannedPayment>(
      'SELECT * FROM planned_payments WHERE id = ? AND deleted_at IS NULL;',
      id,
    );
    if (!planned) throw new Error('Planned payment no longer exists.');
    if (planned.updated_at !== expectedUpdatedAt)
      throw new Error('Planned payment changed. Reopen it before stopping tracking.');
    const timestamp = nowIso();
    await txn.runAsync(
      "UPDATE planned_payments SET status = 'ENDED', deleted_at = ?, updated_at = ?, sync_status = 'LOCAL' WHERE id = ?;",
      timestamp,
      timestamp,
      id,
    );
  });
}

export async function saveSplit(
  db: AppDb,
  input: {
    title: string;
    total_amount_minor: number;
    category_id: string;
    account_id: string;
    occurred_on: string;
    group_id?: string | null;
    payer_person_id?: string | null;
    payer_name?: string;
    payer_is_self?: boolean;
    editor?: import('../../services/split/SplitDefinition').SplitEditorInput;
    shares: {
      name: string;
      personId?: string;
      isSelf: boolean;
      shareMinor: number;
    }[];
  },
): Promise<void> {
  await saveSharedExpensePosting(db, {
    title: input.title,
    totalAmountMinor: input.total_amount_minor,
    categoryId: input.category_id,
    accountId: input.account_id,
    occurredOn: input.occurred_on,
    groupId: input.group_id ?? null,
    payerPersonId: input.payer_person_id ?? null,
    payerName: input.payer_name,
    payerIsSelf: input.payer_is_self !== false,
    editor: input.editor,
    shares: input.shares.map((share) => ({
      name: share.name,
      personId: share.personId ?? null,
      isSelf: share.isSelf,
      shareMinor: share.shareMinor,
    })),
  });
}

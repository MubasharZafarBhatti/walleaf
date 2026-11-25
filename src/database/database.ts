import * as SQLite from 'expo-sqlite';
import { makeId, nowIso } from '../utils/id';
import { migration6 } from './migration6';
import { migration7 } from './migration7';
import { migration8 } from './migration8';
import { migration9 } from './migration9';
import { migration10 } from './migration10';
import { migration11 } from './migration11';
import { migration12 } from './migration12';
import { migration13 } from './migration13';
import { migration14 } from './migration14';

export type AppDb = SQLite.SQLiteDatabase;

const expenseCategories = [
  'Food',
  'Transport',
  'Shopping',
  'Bills',
  'Education',
  'Entertainment',
  'Health',
  'Fuel',
  'Rent',
  'Subscriptions',
  'Gifts',
  'Other',
];
const incomeCategories = [
  'Salary',
  'Freelance',
  'Business',
  'Gift Received',
  'Refund',
  'Other Income',
];

let sharedDatabase: Promise<AppDb> | null = null;

/**
 * The app's one finance connection for this JS runtime. Use this from the live
 * app and from headless reminder actions; openAppDatabase stays a fresh open.
 *
 * Android can unmount and remount the React tree inside the same runtime (leave
 * with Back, open again). expo-sqlite then returns its cached native connection
 * to the new mount, but closes that connection when the previous mount's JS
 * handle is garbage-collected, so the next open got an already-closed database
 * and the app stayed on "Loading your finances...". Keeping one handle for the
 * runtime's lifetime means it is never collected and never closed underneath us.
 */
export function openSharedAppDatabase(): Promise<AppDb> {
  sharedDatabase ??= openAppDatabase().catch((error) => {
    sharedDatabase = null;
    throw error;
  });
  return sharedDatabase;
}

export async function openAppDatabase(): Promise<AppDb> {
  const db = await SQLite.openDatabaseAsync('expense_tracker.db');
  await db.execAsync('PRAGMA foreign_keys = ON;');
  await runMigrations(db);
  return db;
}

async function runMigrations(db: AppDb): Promise<void> {
  await db.execAsync(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL);',
  );
  const row = await db.getFirstAsync<{ version: number }>(
    'SELECT MAX(version) as version FROM schema_migrations;',
  );
  if ((row?.version ?? 0) < 1) {
    await db.withTransactionAsync(async () => {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, currency TEXT NOT NULL, opening_balance_minor INTEGER NOT NULL DEFAULT 0, is_archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, sync_status TEXT NOT NULL DEFAULT 'LOCAL');
        CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, icon TEXT NOT NULL, color_key TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0, is_archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, sync_status TEXT NOT NULL DEFAULT 'LOCAL');
        CREATE UNIQUE INDEX IF NOT EXISTS categories_name_type_unique ON categories (lower(name), type) WHERE deleted_at IS NULL;
        CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY NOT NULL, type TEXT NOT NULL, amount_minor INTEGER NOT NULL, account_id TEXT NOT NULL, destination_account_id TEXT, category_id TEXT, title TEXT NOT NULL, note TEXT, occurred_on TEXT NOT NULL, source TEXT NOT NULL, group_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, sync_status TEXT NOT NULL DEFAULT 'LOCAL');
        CREATE TABLE IF NOT EXISTS budgets (id TEXT PRIMARY KEY NOT NULL, month_key TEXT NOT NULL, category_id TEXT, amount_minor INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, sync_status TEXT NOT NULL DEFAULT 'LOCAL');
        CREATE UNIQUE INDEX IF NOT EXISTS budgets_month_category_unique ON budgets (month_key, ifnull(category_id, 'TOTAL')) WHERE deleted_at IS NULL;
        CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, note TEXT, is_archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, sync_status TEXT NOT NULL DEFAULT 'LOCAL');
        CREATE UNIQUE INDEX IF NOT EXISTS people_name_unique ON people (lower(name)) WHERE deleted_at IS NULL;
        CREATE TABLE IF NOT EXISTS person_entries (id TEXT PRIMARY KEY NOT NULL, person_id TEXT NOT NULL, type TEXT NOT NULL, amount_minor INTEGER NOT NULL, account_id TEXT NOT NULL, title TEXT NOT NULL, note TEXT, occurred_on TEXT NOT NULL, split_group_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, sync_status TEXT NOT NULL DEFAULT 'LOCAL');
        CREATE TABLE IF NOT EXISTS split_groups (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, total_amount_minor INTEGER NOT NULL, category_id TEXT NOT NULL, account_id TEXT NOT NULL, occurred_on TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, sync_status TEXT NOT NULL DEFAULT 'LOCAL');
        CREATE TABLE IF NOT EXISTS split_participants (id TEXT PRIMARY KEY NOT NULL, split_group_id TEXT NOT NULL, person_id TEXT, name TEXT NOT NULL, is_self INTEGER NOT NULL, share_minor INTEGER NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, amount_minor INTEGER NOT NULL, category_id TEXT NOT NULL, account_id TEXT NOT NULL, frequency_type TEXT NOT NULL, frequency_interval INTEGER NOT NULL DEFAULT 1, start_date TEXT NOT NULL, next_renewal_date TEXT NOT NULL, end_date TEXT, total_cycles INTEGER, completed_cycles INTEGER NOT NULL DEFAULT 0, reminder_enabled INTEGER NOT NULL DEFAULT 0, reminder_days_before INTEGER NOT NULL DEFAULT 3, cancellation_reminder_enabled INTEGER NOT NULL DEFAULT 0, cancellation_reminder_date TEXT, status TEXT NOT NULL DEFAULT 'ACTIVE', note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, sync_status TEXT NOT NULL DEFAULT 'LOCAL');
        CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      `);
      await seedDefaults(db);
      await db.runAsync(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?);',
        1,
        nowIso(),
      );
    });
  }
  if ((row?.version ?? 0) < 2) {
    await db.withTransactionAsync(async () => {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, target_amount_minor INTEGER NOT NULL, initial_saved_minor INTEGER NOT NULL DEFAULT 0, target_date TEXT, linked_account_id TEXT, note TEXT, is_archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, sync_status TEXT NOT NULL DEFAULT 'LOCAL');
        CREATE TABLE IF NOT EXISTS goal_entries (id TEXT PRIMARY KEY NOT NULL, goal_id TEXT NOT NULL, type TEXT NOT NULL, amount_minor INTEGER NOT NULL, occurred_on TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
        CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, sync_status TEXT NOT NULL DEFAULT 'LOCAL');
        CREATE TABLE IF NOT EXISTS group_members (id TEXT PRIMARY KEY NOT NULL, group_id TEXT NOT NULL, person_id TEXT, is_self INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS planned_payments (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, amount_minor INTEGER NOT NULL, category_id TEXT NOT NULL, account_id TEXT NOT NULL, next_due_date TEXT NOT NULL, recurrence_type TEXT NOT NULL DEFAULT 'NONE', recurrence_interval INTEGER NOT NULL DEFAULT 1, end_date TEXT, occurrence_limit INTEGER, completed_occurrences INTEGER NOT NULL DEFAULT 0, reminder_enabled INTEGER NOT NULL DEFAULT 0, reminder_days_before INTEGER NOT NULL DEFAULT 3, subscription_metadata TEXT, status TEXT NOT NULL DEFAULT 'ACTIVE', note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, sync_status TEXT NOT NULL DEFAULT 'LOCAL');
        CREATE INDEX IF NOT EXISTS idx_transactions_occurred_on ON transactions (occurred_on);
        CREATE INDEX IF NOT EXISTS idx_transactions_category_date ON transactions (category_id, occurred_on);
        CREATE INDEX IF NOT EXISTS idx_transactions_account_date ON transactions (account_id, occurred_on);
        CREATE INDEX IF NOT EXISTS idx_person_entries_person_date ON person_entries (person_id, occurred_on);
        CREATE INDEX IF NOT EXISTS idx_people_name ON people (name);
        CREATE INDEX IF NOT EXISTS idx_goals_target_date ON goals (target_date);
        CREATE INDEX IF NOT EXISTS idx_planned_next_due ON planned_payments (next_due_date);
      `);
      await db.runAsync(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?);',
        2,
        nowIso(),
      );
    });
  }
  if ((row?.version ?? 0) < 3) {
    await db.withTransactionAsync(async () => {
      const txColumns = await db.getAllAsync<{ name: string }>(
        'PRAGMA table_info(transactions);',
      );
      const entryColumns = await db.getAllAsync<{ name: string }>(
        'PRAGMA table_info(person_entries);',
      );
      const splitColumns = await db.getAllAsync<{ name: string }>(
        'PRAGMA table_info(split_groups);',
      );
      if (!txColumns.some((column) => column.name === 'financial_event_id'))
        await db.execAsync(
          'ALTER TABLE transactions ADD COLUMN financial_event_id TEXT;',
        );
      if (!entryColumns.some((column) => column.name === 'financial_event_id'))
        await db.execAsync(
          'ALTER TABLE person_entries ADD COLUMN financial_event_id TEXT;',
        );
      if (!splitColumns.some((column) => column.name === 'financial_event_id'))
        await db.execAsync(
          'ALTER TABLE split_groups ADD COLUMN financial_event_id TEXT;',
        );
      if (!splitColumns.some((column) => column.name === 'group_id'))
        await db.execAsync(
          'ALTER TABLE split_groups ADD COLUMN group_id TEXT;',
        );
      await db.execAsync(`
        CREATE INDEX IF NOT EXISTS idx_transactions_event ON transactions (financial_event_id);
        CREATE INDEX IF NOT EXISTS idx_person_entries_event ON person_entries (financial_event_id);
        CREATE INDEX IF NOT EXISTS idx_split_groups_group_date ON split_groups (group_id, occurred_on);
      `);
      await db.runAsync(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?);',
        3,
        nowIso(),
      );
    });
  }
  if ((row?.version ?? 0) < 4) {
    await db.withTransactionAsync(async () => {
      const splitColumns = await db.getAllAsync<{ name: string }>(
        'PRAGMA table_info(split_groups);',
      );
      if (!splitColumns.some((column) => column.name === 'payer_person_id'))
        await db.execAsync(
          'ALTER TABLE split_groups ADD COLUMN payer_person_id TEXT;',
        );
      if (!splitColumns.some((column) => column.name === 'payer_name'))
        await db.execAsync(
          "ALTER TABLE split_groups ADD COLUMN payer_name TEXT NOT NULL DEFAULT 'You';",
        );
      if (!splitColumns.some((column) => column.name === 'payer_is_self'))
        await db.execAsync(
          'ALTER TABLE split_groups ADD COLUMN payer_is_self INTEGER NOT NULL DEFAULT 1;',
        );
      await db.execAsync(
        'CREATE INDEX IF NOT EXISTS idx_split_groups_payer ON split_groups (payer_person_id);',
      );
      await db.runAsync(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?);',
        4,
        nowIso(),
      );
    });
  }
  if ((row?.version ?? 0) < 5) {
    await db.withTransactionAsync(async () => {
      // Legacy demo IDs may already contain user edits; protect every existing budget.
      await db.execAsync(
        "ALTER TABLE budgets ADD COLUMN ownership TEXT NOT NULL DEFAULT 'USER' CHECK (ownership IN ('USER', 'DEMO'));",
      );
      await db.runAsync(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?);',
        5,
        nowIso(),
      );
    });
  }
  if ((row?.version ?? 0) < 6) {
    await db.withTransactionAsync(async () => {
      await db.execAsync(migration6);
      await db.runAsync('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?);', 6, nowIso());
    });
  }
  if ((row?.version ?? 0) < 7) {
    await db.withTransactionAsync(async () => {
      await db.execAsync(migration7);
      await db.runAsync(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?);',
        7,
        nowIso(),
      );
    });
  }
  if ((row?.version ?? 0) < 8) {
    await db.withTransactionAsync(async () => {
      await db.execAsync(migration8);
      await db.runAsync('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?);', 8, nowIso());
    });
  }
  if ((row?.version ?? 0) < 9) {
    await db.withTransactionAsync(async () => {
      await db.execAsync(migration9);
      await db.runAsync('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?);', 9, nowIso());
    });
  }
  if ((row?.version ?? 0) < 10) {
    await db.withTransactionAsync(async () => {
      await db.execAsync(migration10);
      await db.runAsync('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?);', 10, nowIso());
    });
  }
  if ((row?.version ?? 0) < 11) {
    await db.withTransactionAsync(async () => {
      await db.execAsync(migration11);
      await db.runAsync('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?);', 11, nowIso());
    });
  }
  if ((row?.version ?? 0) < 12) {
    await db.withTransactionAsync(async () => {
      await db.execAsync(migration12);
      await db.runAsync('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?);', 12, nowIso());
    });
  }
  if ((row?.version ?? 0) < 13) {
    await db.withTransactionAsync(async () => {
      await db.execAsync(migration13);
      await db.runAsync('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?);', 13, nowIso());
    });
  }
  if ((row?.version ?? 0) < 14) {
    await db.withTransactionAsync(async () => {
      await db.execAsync(migration14);
      await db.runAsync('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?);', 14, nowIso());
    });
  }
}

async function seedDefaults(db: AppDb): Promise<void> {
  const timestamp = nowIso();
  await db.runAsync(
    'INSERT OR IGNORE INTO accounts (id, name, type, currency, opening_balance_minor, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?);',
    'account_cash_default',
    'Cash',
    'CASH',
    'PKR',
    0,
    timestamp,
    timestamp,
    'LOCAL',
  );
  for (const name of expenseCategories)
    await db.runAsync(
      'INSERT OR IGNORE INTO categories (id, name, type, icon, color_key, is_default, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);',
      `cat_expense_${name.toLowerCase().replace(/\s+/g, '_')}`,
      name,
      'EXPENSE',
      'pricetag-outline',
      'primary',
      1,
      timestamp,
      timestamp,
      'LOCAL',
    );
  for (const name of incomeCategories)
    await db.runAsync(
      'INSERT OR IGNORE INTO categories (id, name, type, icon, color_key, is_default, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);',
      `cat_income_${name.toLowerCase().replace(/\s+/g, '_')}`,
      name,
      'INCOME',
      'cash-outline',
      'positive',
      1,
      timestamp,
      timestamp,
      'LOCAL',
    );
  const defaults = {
    user_name: '',
    currency: 'PKR',
    week_start: 'MONDAY',
    budget_alert_threshold: '80',
    theme: 'Sage',
    notifications_enabled: 'false',
    ai_enabled: 'false',
    setup_complete: 'false',
  };
  for (const [key, value] of Object.entries(defaults))
    await db.runAsync(
      'INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?);',
      key,
      value,
    );
}

export { makeId, nowIso };

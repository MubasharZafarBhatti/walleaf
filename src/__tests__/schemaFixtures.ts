import type { AppDb } from '../database/database';
import { migration6 } from '../database/migration6';
import { migration11 } from '../database/migration11';
import { migration12 } from '../database/migration12';
import { migration14 } from '../database/migration14';
import type { Backup } from '../services/backup/BackupFormat';

/** Disposable test databases only: reconstruct the exact schema-13 boundary (one currency). */
export async function removeMigration14ForFixture(db: AppDb) {
  for (const match of migration14.matchAll(/CREATE TRIGGER (\w+)/g)) await db.execAsync(`DROP TRIGGER IF EXISTS ${match[1]};`);
  await db.execAsync(`DROP INDEX IF EXISTS budgets_month_category_currency_unique;
    ALTER TABLE budgets DROP COLUMN currency;
    CREATE UNIQUE INDEX IF NOT EXISTS budgets_month_category_unique ON budgets (month_key, ifnull(category_id, 'TOTAL')) WHERE deleted_at IS NULL;
    ALTER TABLE goals DROP COLUMN currency;
    ALTER TABLE transactions DROP COLUMN destination_amount_minor;
    DELETE FROM schema_migrations WHERE version = 14;`);
}

export async function removeMigration13ForFixture(db: AppDb) {
  await removeMigration14ForFixture(db);
  for (const table of ['planned_payments', 'subscriptions', 'planned_payment_occurrences', 'subscription_payments']) await db.execAsync(`ALTER TABLE ${table} DROP COLUMN schedule_provenance;`);
  await db.execAsync('DELETE FROM schema_migrations WHERE version = 13;');
}

/** A backup written before multiple currencies: no plan/goal currency, no amount received. */
export function stripCurrenciesForFixture(backup: Backup) {
  for (const row of [...backup.data.budgets, ...backup.data.goals]) delete row.currency;
  for (const row of backup.data.transactions) delete row.destination_amount_minor;
}

export function stripScheduleProvenanceForFixture(backup: Backup) {
  stripCurrenciesForFixture(backup);
  for (const table of ['planned_payments', 'subscriptions', 'planned_payment_occurrences', 'subscription_payments'] as const) for (const row of backup.data[table]) delete row.schedule_provenance;
}

/** Disposable test databases only: reconstruct the exact schema-11 boundary. */
export async function removeMigration12ForFixture(db: AppDb) {
  await removeMigration13ForFixture(db);
  for (const match of migration12.matchAll(/CREATE TRIGGER (\w+)/g)) await db.execAsync(`DROP TRIGGER IF EXISTS ${match[1]};`);
  await db.execAsync(`DROP VIEW allocation_sources; DROP VIEW allocation_targets;
    ${migration11.slice(migration11.indexOf('CREATE VIEW allocation_targets'), migration11.indexOf('CREATE TRIGGER allocation_offset_guard'))}
    ALTER TABLE transactions DROP COLUMN cash_effect_minor;
    ALTER TABLE person_entries DROP COLUMN cash_effect_minor;
    DELETE FROM schema_migrations WHERE version = 12;`);
}

/** Disposable test databases only: reconstruct the exact pre-11 view boundary. */
export async function removeMigration11ForFixture(db: AppDb) {
  await removeMigration12ForFixture(db);
  for (const match of migration11.matchAll(/CREATE TRIGGER (\w+)/g)) await db.execAsync(`DROP TRIGGER IF EXISTS ${match[1]};`);
  await db.execAsync(`DROP VIEW allocation_sources; DROP VIEW allocation_targets;
    ${migration6.slice(migration6.indexOf('CREATE VIEW allocation_sources'), migration6.indexOf('CREATE TRIGGER allocation_insert_guard'))}
    DELETE FROM schema_migrations WHERE version = 11;`);
}

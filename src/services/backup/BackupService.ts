import * as SQLite from 'expo-sqlite';
import type { AppDb } from '../../database/database';
import { migration6 } from '../../database/migration6';
import { migration8 } from '../../database/migration8';
import { migration11 } from '../../database/migration11';
import { BACKUP_APP, BACKUP_SCHEMA_VERSION, BACKUP_TABLES, BACKUP_VERSION, MAX_BACKUP_BYTES, backupPreview, backupTextBytes, invalid, parseBackup, type Backup, type BackupColumn, type BackupColumns, type BackupRow } from './BackupFormat';
import { validateBackupState } from './BackupValidation';

type SchemaRow = { type: string; name: string; tbl_name: string; sql: string | null };
const suspended = ['allocation_no_delete', 'settlement_no_delete', 'exclusion_insert_guard', 'subscription_payment_source', 'allocation_offset_guard'] as const;
// Reviewed definitions are compiled application code, never file-provided SQL.
const expectedTriggers = new Map([...migration6.split(/(?=CREATE TRIGGER )/), ...migration8.split(/(?=CREATE TRIGGER )/), ...migration11.split(/(?=CREATE TRIGGER )/)]
  .filter((sql) => sql.startsWith('CREATE TRIGGER '))
  .map((sql) => [sql.split(/\s+/)[2], sql.trim().replace(/;$/, '')]));

export type BackupDependencies = {
  open: (staging: boolean) => Promise<AppDb>;
  now: () => string;
};
const defaults: BackupDependencies = {
  open: (staging) => SQLite.openDatabaseAsync(staging ? ':memory:' : 'expense_tracker.db', { useNewConnection: true }),
  now: () => new Date().toISOString(),
};

/** No screen knows table SQL. No migration/default-seeding runs during restore.
 * Every target write uses ONE private connection, configured before BEGIN.
 */
export class BackupService {
  constructor(private readonly dependencies: BackupDependencies = defaults) {}

  private async schema(db: AppDb) {
    const versions = await db.getAllAsync<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version');
    if (versions.map((v) => v.version).join() !== '1,2,3,4,5,6,7,8,9,10,11,12,13,14') invalid('unsupported current database schema.');
    const schema = await db.getAllAsync<SchemaRow>("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
    const tables = schema.filter((s) => s.type === 'table').map((s) => s.name).sort();
    if (tables.join() !== [...BACKUP_TABLES, 'schema_migrations'].sort().join()) invalid('current database contains unsupported tables.');
    for (const name of suspended) {
      const actual = schema.find((s) => s.type === 'trigger' && s.name === name)?.sql;
      if (!actual || actual !== expectedTriggers.get(name)) invalid(`protected trigger ${name} differs from this app version.`);
    }
    const columns = {} as BackupColumns;
    for (const table of BACKUP_TABLES) columns[table] = await db.getAllAsync<BackupColumn>(`PRAGMA table_info("${table}")`);
    return { schema, columns };
  }

  private async read(db: AppDb, columns: BackupColumns, createdAt = this.dependencies.now()): Promise<Backup> {
    const data = {} as Backup['data'];
    for (const table of BACKUP_TABLES) {
      const order = columns[table].filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => `"${c.name}"`).join(',');
      const filter = table === 'app_settings' ? " WHERE key NOT IN ('local_backup_restored', 'notifications_last_response')" : '';
      data[table] = await db.getAllAsync<BackupRow>(`SELECT * FROM "${table}"${filter} ORDER BY ${order}`);
    }
    return { app: BACKUP_APP, backupVersion: BACKUP_VERSION, schemaVersion: BACKUP_SCHEMA_VERSION, appVersion: '1.1.0', createdAt, data };
  }

  private async insert(db: AppDb, backup: Backup, columns: BackupColumns) {
    for (const table of BACKUP_TABLES) {
      const fields = columns[table].map((c) => c.name);
      const sql = `INSERT INTO "${table}" (${fields.map((c) => `"${c}"`).join(',')}) VALUES (${fields.map(() => '?').join(',')})`;
      for (const row of backup.data[table]) await db.runAsync(sql, ...fields.map((field) => row[field]));
    }
  }

  /** Read transaction provides a coherent snapshot. No settings, timestamps,
   * recurrence, notifications, migration metadata or financial rows are written.
   */
  async export(): Promise<string> {
    const db = await this.dependencies.open(false);
    let transaction = false;
    try {
      await db.execAsync('BEGIN'); transaction = true;
      const { columns } = await this.schema(db);
      const backup = await this.read(db, columns);
      await db.execAsync('COMMIT'); transaction = false;
      const text = JSON.stringify(backup, null, 2);
      if (backupTextBytes(text) > MAX_BACKUP_BYTES || BACKUP_TABLES.reduce((count, table) => count + backup.data[table].length, 0) > 100000) invalid('this dataset exceeds the supported backup size (25 MB / 100,000 records).');
      return text;
    } finally {
      try { if (transaction) await db.execAsync('ROLLBACK'); }
      finally { await db.closeAsync(); }
    }
  }

  /** Staging executes trusted schema SQL with untrusted VALUES bound separately.
   * This does not write to the user's database, even for malformed input.
   */
  private async validate(text: string, schema: SchemaRow[], columns: BackupColumns) {
    const backup = parseBackup(text, columns);
    const staging = await this.dependencies.open(true);
    try {
      await staging.execAsync('PRAGMA foreign_keys = ON');
      if ((await staging.getFirstAsync<{ foreign_keys: number }>('PRAGMA foreign_keys'))?.foreign_keys !== 1) invalid('foreign keys could not be enabled.');
      for (const type of ['table', 'index', 'view', 'trigger']) for (const row of schema) {
        if (row.type === type && row.sql && row.tbl_name !== 'schema_migrations' && !(suspended as readonly string[]).includes(row.name)) await staging.execAsync(row.sql);
      }
      await this.insert(staging, backup, columns);
      await validateBackupState(staging, backup);
      return backup;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('This backup')) throw error;
      invalid('records violate database uniqueness or financial integrity rules.');
    } finally { await staging.closeAsync(); }
  }

  async preview(text: string) {
    const source = await this.dependencies.open(false);
    try {
      const { schema, columns } = await this.schema(source);
      return backupPreview(await this.validate(text, schema, columns));
    } finally { await source.closeAsync(); }
  }

  /** Caller must hold the tested app-access pause until this promise settles.
   * onSafetyBackup stores an optional private local safety JSON before deletion.
   * No OS notification operation or app refresh is inside this transaction.
   */
  async restore(text: string, onSafetyBackup: (json: string) => Promise<void>): Promise<void> {
    const db = await this.dependencies.open(false);
    let transaction = false;
    let committed = false;
    try {
      await db.execAsync('PRAGMA foreign_keys = ON');
      if ((await db.getFirstAsync<{ foreign_keys: number }>('PRAGMA foreign_keys'))?.foreign_keys !== 1) invalid('foreign keys could not be enabled.');
      const expected = await this.schema(db);
      const backup = await this.validate(text, expected.schema, expected.columns);
      await db.execAsync('BEGIN EXCLUSIVE'); transaction = true;
      const previousIntroduction = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_settings WHERE key = 'notifications_intro_answered'");
      const current = await this.schema(db);
      if (JSON.stringify(current) !== JSON.stringify(expected)) invalid('database schema changed during validation.');
      await onSafetyBackup(JSON.stringify(await this.read(db, current.columns), null, 2));
      for (const name of suspended) await db.execAsync(`DROP TRIGGER "${name}"`);
      for (const table of [...BACKUP_TABLES].reverse()) await db.runAsync(`DELETE FROM "${table}"`);
      await this.insert(db, backup, current.columns);
      const restored = await this.read(db, current.columns, backup.createdAt);
      // Canonical round-trip check includes ownership, timestamps, archives and
      // all source IDs. It is independent of derived financial validation.
      const canonical = (value: Backup) => JSON.stringify(BACKUP_TABLES.map((table) => value.data[table]
        .map((row) => JSON.stringify(current.columns[table].map((c) => row[c.name]))).sort()));
      if (canonical(restored) !== canonical(backup)) invalid('restored data does not match the selected backup.');
      await validateBackupState(db, restored);
      for (const name of suspended) await db.execAsync(expectedTriggers.get(name)!);
      const final = await this.schema(db);
      if (JSON.stringify(final) !== JSON.stringify(current)) invalid('database protections were not restored exactly.');
      if ((await db.getFirstAsync<{ foreign_keys: number }>('PRAGMA foreign_keys'))?.foreign_keys !== 1 || await db.getFirstAsync('PRAGMA foreign_key_check')) invalid('final foreign-key check failed.');
      // Device-local bootstrap marker, not financial ownership or backup data.
      // Prevent first-launch Senior Demo seeding over a restored real backup.
      await db.runAsync("INSERT INTO app_settings (key, value) VALUES ('local_backup_restored', 'true')");
      // Restoring an older compatible backup must not repeatedly ask a device
      // whose owner already answered. Explicit backed-up preferences still win.
      if (previousIntroduction?.value === 'true' && !backup.data.app_settings.some(row => row.key === 'notifications_intro_answered')) await db.runAsync("INSERT INTO app_settings (key, value) VALUES ('notifications_intro_answered', 'true')");
      await db.execAsync('COMMIT'); transaction = false;
      committed = true;
    } finally {
      try { if (transaction) await db.execAsync('ROLLBACK'); }
      finally {
        try { await db.closeAsync(); }
        catch (error) { if (!committed) throw error; }
      }
    }
  }
}

export const backupService = new BackupService();

/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import * as SQLite from 'expo-sqlite';
import { openAppDatabase, type AppDb } from '../database/database';
import { migration11 } from '../database/migration11';
import { migration12 } from '../database/migration12';
import { BACKUP_TABLES } from '../services/backup/BackupFormat';
import * as repo from '../database/repositories/repositories';
import { calculateAccountBalance } from '../services/finance/FinanceService';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
let sqlite: DatabaseSync; let db: AppDb; let failVersion: number | undefined;
let boundary: unknown; let transactionNumber: number;
function snapshot() {
  const tables = sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return { schema: sqlite.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),
    data: tables.map(row => ({ name: row.name, rows: sqlite.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all() })) };
}
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:'); failVersion = undefined; boundary = undefined; transactionNumber = 0;
  const adapter = {
    execAsync: async (sql: string) => { sqlite.exec(sql); },
    runAsync: async (sql: string, ...params: (string | number | null)[]) => {
      if (sql.includes('INSERT INTO schema_migrations') && params[0] === failVersion) throw new Error(`Migration ${failVersion} interrupted after DDL`);
      return sqlite.prepare(sql).run(...params);
    },
    getAllAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).all(...params),
    getFirstAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).get(...params) ?? null,
    withTransactionAsync: async (work: () => Promise<void>) => {
      transactionNumber++;
      if (transactionNumber === failVersion && failVersion > 1) {
        // An original-schema manual financial row exists before the upgrade.
        sqlite.prepare('INSERT INTO transactions (id,type,amount_minor,account_id,category_id,title,occurred_on,source,created_at,updated_at,sync_status) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
          .run('F-existing-expense', 'EXPENSE', 12345, 'account_cash_default', 'cat_expense_food', 'Original financial history', '2026-09-01', 'MANUAL', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'LOCAL');
      }
      const before = snapshot(); sqlite.exec('BEGIN');
      try { await work(); sqlite.exec('COMMIT'); } catch (error) { sqlite.exec('ROLLBACK'); boundary = before; throw error; }
    },
  };
  db = adapter as unknown as AppDb; jest.mocked(SQLite.openDatabaseAsync).mockResolvedValue(db);
});
afterEach(() => { expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]); sqlite.close(); });

test('fresh 1–14 chain installs complete schema/protections and reopening changes no row or schema', async () => {
  await openAppDatabase();
  expect(sqlite.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual(Array.from({ length: 14 }, (_, index) => ({ version: index + 1 })));
  expect(sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name)).toEqual([...BACKUP_TABLES, 'schema_migrations'].sort());
  for (const sql of [migration11, migration12]) for (const match of sql.matchAll(/CREATE TRIGGER (\w+)/g)) expect(sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name=?").get(match[1])).toEqual({ name: match[1] });
  for (const name of ['allocation_sources', 'allocation_targets']) expect(sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='view' AND name=?").get(name)).toEqual({ name });
  for (const table of ['transactions', 'person_entries']) expect(sqlite.prepare(`PRAGMA table_info(${table})`).all()).toContainEqual(expect.objectContaining({ name: 'cash_effect_minor', type: 'INTEGER', notnull: 0 }));
  expect(sqlite.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 }); expect(sqlite.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  const before = snapshot(); await openAppDatabase(); expect(snapshot()).toEqual(before);
});

test.each(Array.from({ length: 14 }, (_, index) => index + 1))('migration %i failure rolls back exact boundary; retry safely completes the immutable chain', async version => {
  failVersion = version;
  await expect(openAppDatabase()).rejects.toThrow(`Migration ${version} interrupted after DDL`);
  expect(snapshot()).toEqual(boundary);
  const oldVersions = sqlite.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  expect(oldVersions.map(row => row.version)).toEqual(Array.from({ length: version - 1 }, (_, index) => index + 1));
  failVersion = undefined; await openAppDatabase();
  expect(sqlite.prepare('SELECT * FROM schema_migrations WHERE version < ? ORDER BY version').all(version)).toEqual(oldVersions);
  expect(sqlite.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toHaveLength(14);
  if (version > 1) {
    const transactions = await repo.listTransactions(db);
    expect(transactions).toMatchObject([{ id: 'F-existing-expense', amount_minor: 12345, cash_effect_minor: null, occurred_on: '2026-09-01', created_at: '2026-09-01T00:00:00.000Z' }]);
    expect(calculateAccountBalance((await repo.listAccounts(db))[0], transactions, [])).toBe(-12345);
  }
  const complete = snapshot(); await openAppDatabase(); expect(snapshot()).toEqual(complete);
});

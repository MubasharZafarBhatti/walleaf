/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import * as SQLite from 'expo-sqlite';
import { openAppDatabase, type AppDb } from '../database/database';
import { migration9 } from '../database/migration9';
import * as repo from '../database/repositories/repositories';
import { loadComprehensiveDemoData } from './fixtures/demoData';
import { BACKUP_TABLES } from '../services/backup/BackupFormat';
import { listActivity } from '../services/activity/ActivityService';
import { calculateAccountBalance } from '../services/finance/FinanceService';
import { buildInsightsSnapshot } from '../services/insights/InsightsService';
import { calculatePersonBalance } from '../services/people/PeopleBalanceService';
import { removeMigration11ForFixture } from './schemaFixtures';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

const indexNames = [
  'idx_split_groups_event',
  'idx_split_participants_split_person',
  'idx_person_entries_split',
  'idx_group_members_group_created',
  'idx_allocation_exclusions_target',
  'idx_subscriptions_active_renewal',
  'idx_goal_entries_goal_date',
] as const;

let sqlite: DatabaseSync;
let db: AppDb;

function adapter(database: DatabaseSync): AppDb {
  const transaction = async (work: () => Promise<void>) => {
    database.exec('BEGIN');
    try { await work(); database.exec('COMMIT'); } catch (error) { database.exec('ROLLBACK'); throw error; }
  };
  const result = {
    execAsync: async (sql: string) => { database.exec(sql); },
    runAsync: async (sql: string, ...params: (string | number | null)[]) => database.prepare(sql).run(...params),
    getAllAsync: async (sql: string, ...params: (string | number | null)[]) => database.prepare(sql).all(...params),
    getFirstAsync: async (sql: string, ...params: (string | number | null)[]) => database.prepare(sql).get(...params) ?? null,
    withTransactionAsync: transaction,
    withExclusiveTransactionAsync: async (work: (txn: AppDb) => Promise<void>) => transaction(() => work(result as unknown as AppDb)),
  };
  return result as unknown as AppDb;
}

async function plan(sql: string, ...params: (string | number | null)[]) {
  const rows = await db.getAllAsync<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params);
  return rows.map((row) => row.detail).join('\n');
}

async function domainRows() {
  return Object.fromEntries(await Promise.all(BACKUP_TABLES.map(async (table) => [table, await db.getAllAsync(`SELECT * FROM "${table}" ORDER BY rowid`)])));
}

async function financialResults() {
  const [accounts, categories, transactions, people, entries, subscriptions] = await Promise.all([
    repo.listAccounts(db), repo.listCategories(db), repo.listTransactions(db), repo.listAllPeople(db), repo.listPersonEntries(db), repo.listSubscriptions(db),
  ]);
  return {
    accountBalances: accounts.map((account) => [account.id, calculateAccountBalance(account, transactions, entries)]),
    peopleBalances: people.map((person) => [person.id, calculatePersonBalance(entries.filter((entry) => entry.person_id === person.id))]),
    activity: await listActivity(db, { range: 'LAST_3_MONTHS', accountId: 'account_cash_default' }),
    insights: buildInsightsSnapshot({ selection: { range: 'LAST_3_MONTHS' }, trendMonths: 6, today: '2026-09-16', accounts, categories, transactions, people, peopleEntries: entries, subscriptions }),
  };
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  db = adapter(sqlite);
  jest.mocked(SQLite.openDatabaseAsync).mockResolvedValue(db);
  await openAppDatabase();
  await loadComprehensiveDemoData(db);
});

afterEach(() => sqlite.close());

test('migration 9 preserves every domain row and financial read result while upgrading schema 8 once', async () => {
  const rows = await domainRows();
  const results = await financialResults();
  await removeMigration11ForFixture(db);
  for (const name of indexNames) await db.execAsync(`DROP INDEX "${name}"`);
  await db.execAsync('ALTER TABLE split_groups DROP COLUMN split_definition');
  await db.runAsync('DELETE FROM schema_migrations WHERE version >= 9');
  expect((await db.getFirstAsync<{ version: number }>('SELECT MAX(version) version FROM schema_migrations'))?.version).toBe(8);

  await openAppDatabase();
  expect((await db.getFirstAsync<{ version: number }>('SELECT MAX(version) version FROM schema_migrations'))?.version).toBe(14);
  expect(await domainRows()).toEqual(rows);
  expect(await financialResults()).toEqual(results);
  await openAppDatabase();
  expect(await db.getAllAsync('SELECT version FROM schema_migrations WHERE version = 9')).toEqual([{ version: 9 }]);
});

test('audited query plans replace relationship and schedule scans with the intended indexes', async () => {
  for (const name of indexNames) await db.execAsync(`DROP INDEX "${name}"`);
  const queries = [
    ['idx_split_groups_event', 'SELECT id FROM split_groups WHERE financial_event_id = ?', ['event']],
    ['idx_split_participants_split_person', 'SELECT id FROM split_participants WHERE split_group_id = ? AND person_id = ?', ['split', 'person']],
    ['idx_person_entries_split', 'SELECT id FROM person_entries WHERE split_group_id = ? OR financial_event_id = ?', ['split', 'event']],
    ['idx_group_members_group_created', 'SELECT * FROM group_members WHERE group_id = ? ORDER BY created_at', ['group']],
    ['idx_allocation_exclusions_target', 'SELECT source_entry_id FROM allocation_exclusions WHERE target_entry_id = ?', ['entry']],
    ['idx_subscriptions_active_renewal', 'SELECT * FROM subscriptions WHERE deleted_at IS NULL ORDER BY next_renewal_date', []],
    ['idx_goal_entries_goal_date', 'SELECT * FROM goal_entries WHERE deleted_at IS NULL AND goal_id = ? ORDER BY occurred_on DESC, created_at DESC', ['goal']],
  ] as const;
  const before = await Promise.all(queries.map(([, sql, params]) => plan(sql, ...params)));
  expect(before.every((detail, index) => !detail.includes(queries[index][0]))).toBe(true);

  await db.execAsync(migration9);
  const after = await Promise.all(queries.map(([, sql, params]) => plan(sql, ...params)));
  queries.forEach(([name], index) => expect(after[index]).toContain(name));
});

test('migration 9 installs exact non-redundant index definitions and rolls back atomically', async () => {
  const installed = await db.getAllAsync<{ name: string; tbl_name: string; sql: string }>(`SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'index' AND name IN (${indexNames.map(() => '?').join(',')}) ORDER BY name`, ...indexNames);
  expect(installed.map((row) => row.name)).toEqual([...indexNames].sort());
  for (const name of indexNames) {
    const table = installed.find((row) => row.name === name)!.tbl_name;
    const columns = (await db.getAllAsync<{ name: string }>(`PRAGMA index_info("${name}")`)).map((row) => row.name);
    const duplicates = await db.getAllAsync<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? AND name <> ? AND sql IS NOT NULL", table, name);
    for (const other of duplicates) {
      const otherColumns = (await db.getAllAsync<{ name: string }>(`PRAGMA index_info("${other.name}")`)).map((row) => row.name);
      expect(otherColumns).not.toEqual(columns);
    }
  }

  const isolated = new DatabaseSync(':memory:');
  try {
    isolated.exec('CREATE TABLE split_groups(financial_event_id); CREATE TABLE split_participants(split_group_id, person_id, is_self); CREATE TABLE person_entries(split_group_id); CREATE TABLE group_members(group_id, created_at); CREATE TABLE allocation_exclusions(target_entry_id, source_entry_id); CREATE TABLE subscriptions(next_renewal_date, deleted_at); CREATE TABLE goal_entries(goal_id, occurred_on, created_at); BEGIN;');
    expect(() => isolated.exec(`${migration9} SELECT * FROM missing_phase19_table;`)).toThrow();
    isolated.exec('ROLLBACK');
    expect(isolated.prepare("SELECT name FROM sqlite_schema WHERE type = 'index'").all()).toEqual([]);
  } finally { isolated.close(); }
});

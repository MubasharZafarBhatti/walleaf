/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import type { AppDb } from '../database/database';

type Modules = { SQLite: { openDatabaseAsync: jest.Mock }; database: typeof import('../database/database') };
/** A fresh module registry = a fresh JS runtime with no cached handle yet. */
function freshRuntime(): Modules {
  jest.resetModules();
  /* eslint-disable @typescript-eslint/no-require-imports */
  return { SQLite: require('expo-sqlite'), database: require('../database/database') };
  /* eslint-enable @typescript-eslint/no-require-imports */
}

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

function adapter(): AppDb {
  const sqlite = new DatabaseSync(':memory:');
  const result = {
    execAsync: async (sql: string) => { sqlite.exec(sql); },
    runAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).run(...params),
    getAllAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).all(...params),
    getFirstAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).get(...params) ?? null,
    withTransactionAsync: async (work: () => Promise<void>) => {
      sqlite.exec('BEGIN');
      try { await work(); sqlite.exec('COMMIT'); } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    withExclusiveTransactionAsync: async (work: (txn: AppDb) => Promise<void>) => result.withTransactionAsync(() => work(result as unknown as AppDb)),
  };
  return result as unknown as AppDb;
}

// Leaving the app with Back and opening it again remounts the React tree in the
// same JS runtime. A second native open handed expo-sqlite's cached connection
// to the new mount and the old JS handle's garbage collection then closed it,
// leaving the app on "Loading your finances...". The live app must reuse one handle.
test('the live app gets the same finance connection on every mount of one runtime', async () => {
  const { SQLite, database: { openSharedAppDatabase } } = freshRuntime();
  const db = adapter();
  SQLite.openDatabaseAsync.mockResolvedValue(db);
  const first = await openSharedAppDatabase();
  const second = await openSharedAppDatabase();
  const third = await openSharedAppDatabase();
  expect(first).toBe(db);
  expect(second).toBe(first);
  expect(third).toBe(first);
  expect(SQLite.openDatabaseAsync).toHaveBeenCalledTimes(1);
});

test('a failed open is not cached, so the next mount can try again', async () => {
  const { SQLite, database: { openSharedAppDatabase } } = freshRuntime();
  const db = adapter();
  SQLite.openDatabaseAsync.mockRejectedValueOnce(new Error('disk busy')).mockResolvedValue(db);
  await expect(openSharedAppDatabase()).rejects.toThrow('disk busy');
  await expect(openSharedAppDatabase()).resolves.toBe(db);
  expect(SQLite.openDatabaseAsync).toHaveBeenCalledTimes(2);
});

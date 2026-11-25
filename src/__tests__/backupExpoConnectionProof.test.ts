/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteDatabase, openDatabaseAsync } from '../../node_modules/expo-sqlite/src/SQLiteDatabase';
import ExpoSQLite from '../../node_modules/expo-sqlite/src/ExpoSQLite';
import { migration6 } from '../database/migration6';

type Transport = {
  sqlite: DatabaseSync;
  calls: string[];
  closed: boolean;
  initAsync: () => Promise<void>;
  execAsync: (sql: string) => Promise<void>;
  closeAsync: () => Promise<void>;
};
const mockConnections: Transport[] = [];

// Execute the INSTALLED Expo JS transaction method, including its separate
// Transaction.createAsync connection. Only the native transport is replaced.
// Node enables foreign keys by default; Expo Android's inspected default build
// does not. Explicitly model that native default rather than inherit Node's.
jest.mock('../../node_modules/expo-sqlite/src/ExpoSQLite', () => ({
  __esModule: true,
  default: {
    ensureDatabasePathExistsAsync: jest.fn().mockResolvedValue(undefined),
    NativeDatabase: jest.fn().mockImplementation((path: string) => {
      const { DatabaseSync: NodeDatabase } = jest.requireActual<typeof import('node:sqlite')>('node:sqlite');
      const sqlite = new NodeDatabase(path, { enableForeignKeyConstraints: false });
      const transport: Transport = {
        sqlite, calls: [], closed: false,
        initAsync: async () => {},
        execAsync: async (sql: string) => { transport.calls.push(sql); sqlite.exec(sql); },
        closeAsync: async () => { sqlite.close(); transport.closed = true; },
      };
      mockConnections.push(transport);
      return transport;
    }),
  },
}));
jest.mock('../../node_modules/expo-sqlite/src/SQLiteDevToolsClient', () => ({
  registerDatabaseForDevToolsAsync: jest.fn(), unregisterDatabaseForDevToolsAsync: jest.fn(),
}));
jest.mock('../../node_modules/expo-sqlite/src/pathUtils', () => ({
  createDatabasePath: (name: string, directory: string) => jest.requireActual<typeof import('node:path')>('node:path').join(directory, name),
}));

let directory: string;
let db: SQLiteDatabase;
let main: Transport;
let triggerSql: string;

beforeEach(async () => {
  mockConnections.length = 0;
  directory = mkdtempSync(join(tmpdir(), 'opencode', 'backup-expo-proof-'));
  const path = join(directory, 'disposable.db');
  const native = new ExpoSQLite.NativeDatabase(path, {});
  main = mockConnections[0];
  db = new SQLiteDatabase(path, {}, native);
  await db.execAsync('PRAGMA foreign_keys = ON');
  await db.execAsync(`
    CREATE TABLE proof_parent (id TEXT PRIMARY KEY);
    CREATE TABLE entry_allocations (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES proof_parent(id), amount_minor INTEGER);
    INSERT INTO proof_parent VALUES ('parent');
    INSERT INTO entry_allocations VALUES ('original', 'parent', 500);
  `);
  const definition = migration6.match(/CREATE TRIGGER allocation_no_delete[^\n]+/);
  if (!definition) throw new Error('Protected production trigger definition missing');
  await db.execAsync(definition[0]);
  triggerSql = main.sqlite.prepare("SELECT sql FROM sqlite_schema WHERE name = 'allocation_no_delete'").get()!.sql as string;
});

afterEach(() => {
  for (const connection of mockConnections) if (!connection.closed) connection.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

test('installed Expo exclusive API rolls back transactional DROP and partial replacement on its separate connection', async () => {
  const before = main.sqlite.prepare('SELECT * FROM entry_allocations').all();
  await expect(db.withExclusiveTransactionAsync(async (txn) => {
    expect(txn).not.toBe(db);
    await txn.execAsync('DROP TRIGGER allocation_no_delete; DELETE FROM entry_allocations;');
    await txn.execAsync("INSERT INTO entry_allocations VALUES ('replacement', 'parent', 250)");
    throw new Error('forced rollback');
  })).rejects.toThrow('forced rollback');
  expect(mockConnections[1].calls).toEqual([
    'BEGIN', 'DROP TRIGGER allocation_no_delete; DELETE FROM entry_allocations;',
    "INSERT INTO entry_allocations VALUES ('replacement', 'parent', 250)", 'ROLLBACK',
  ]);
  expect(mockConnections[1].closed).toBe(true);
  expect(main.sqlite.prepare('SELECT * FROM entry_allocations').all()).toEqual(before);
  expect(main.sqlite.prepare("SELECT sql FROM sqlite_schema WHERE name = 'allocation_no_delete'").get()).toEqual({ sql: triggerSql });
  await expect(db.execAsync('DELETE FROM entry_allocations')).rejects.toThrow('Allocations are immutable');
});

test('SAFETY BLOCKER: app connection foreign keys do not carry into Expo exclusive callback and cannot be enabled after BEGIN', async () => {
  expect(main.sqlite.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  const before = main.sqlite.prepare('SELECT * FROM entry_allocations').all();
  await expect(db.withExclusiveTransactionAsync(async (txn) => {
    const connection = mockConnections[1];
    expect(connection.calls).toEqual(['BEGIN']);
    expect(connection.sqlite.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 0 });
    await txn.execAsync('PRAGMA foreign_keys = ON');
    // SQLite explicitly ignores this pragma while a transaction is active.
    expect(connection.sqlite.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 0 });
    throw new Error('Restore blocked: transaction foreign keys are not enabled');
  })).rejects.toThrow('Restore blocked: transaction foreign keys are not enabled');
  expect(mockConnections[1].calls).toEqual(['BEGIN', 'PRAGMA foreign_keys = ON', 'ROLLBACK']);
  expect(main.sqlite.prepare('SELECT * FROM entry_allocations').all()).toEqual(before);
  expect(main.sqlite.prepare("SELECT sql FROM sqlite_schema WHERE name = 'allocation_no_delete'").get()).toEqual({ sql: triggerSql });
  expect(main.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

// Deliberately do not call withExclusiveTransactionAsync on this handle: that
// would open yet another unconfigured connection. BEGIN and all work use it.
async function dedicatedConnection() {
  const dedicated = await openDatabaseAsync('disposable.db', { useNewConnection: true }, directory);
  const transport = mockConnections[mockConnections.length - 1];
  await dedicated.execAsync('PRAGMA foreign_keys = ON');
  expect(transport.sqlite.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  await dedicated.execAsync('BEGIN EXCLUSIVE');
  expect(transport.calls).toEqual(['PRAGMA foreign_keys = ON', 'BEGIN EXCLUSIVE']);
  return { dedicated, transport };
}

test.each(['DELETE', 'WAL'])('dedicated connection retains foreign keys, excludes competing writes and commits protected replacement (%s journal)', async (journal) => {
  await db.execAsync(`PRAGMA journal_mode = ${journal}; PRAGMA busy_timeout = 0`);
  const { dedicated, transport } = await dedicatedConnection();
  try {
    await dedicated.execAsync('DROP TRIGGER allocation_no_delete; DELETE FROM entry_allocations');
    await expect(dedicated.execAsync("INSERT INTO entry_allocations VALUES ('dangling', 'missing', 100)"))
      .rejects.toThrow('FOREIGN KEY constraint failed');
    await expect(db.execAsync("INSERT INTO proof_parent VALUES ('competing')"))
      .rejects.toThrow(/locked/);
    await dedicated.execAsync("INSERT INTO entry_allocations VALUES ('replacement', 'parent', 250)");
    await dedicated.execAsync(triggerSql);
    expect(transport.sqlite.prepare("SELECT sql FROM sqlite_schema WHERE name = 'allocation_no_delete'").get()).toEqual({ sql: triggerSql });
    await expect(dedicated.execAsync('DELETE FROM entry_allocations')).rejects.toThrow('Allocations are immutable');
    expect(transport.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    await dedicated.execAsync('COMMIT');
    expect(main.sqlite.prepare('SELECT * FROM entry_allocations').all()).toEqual([{ id: 'replacement', parent_id: 'parent', amount_minor: 250 }]);
    expect(main.sqlite.prepare("SELECT * FROM proof_parent WHERE id = 'competing'").all()).toEqual([]);
    expect(transport.sqlite.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    await expect(dedicated.execAsync("INSERT INTO entry_allocations VALUES ('bad', 'missing', 1)"))
      .rejects.toThrow('FOREIGN KEY constraint failed');
    await expect(db.execAsync('DELETE FROM entry_allocations')).rejects.toThrow('Allocations are immutable');
  } finally {
    if (transport.sqlite.isTransaction) await dedicated.execAsync('ROLLBACK');
    await dedicated.closeAsync();
  }
  expect(transport.closed).toBe(true);
});

test.each(['after deletion', 'after insertion', 'trigger recreation', 'final validation', 'before commit'])(
  'dedicated connection rollback preserves data, exact trigger and foreign keys: %s', async (stage) => {
    const beforeData = main.sqlite.prepare('SELECT * FROM entry_allocations').all();
    const beforeSchema = main.sqlite.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY type, name').all();
    const { dedicated, transport } = await dedicatedConnection();
    try {
      await expect((async () => {
        try {
          await dedicated.execAsync('DROP TRIGGER allocation_no_delete; DELETE FROM entry_allocations');
          if (stage === 'after deletion') throw new Error(stage);
          await dedicated.execAsync("INSERT INTO entry_allocations VALUES ('replacement', 'parent', 250)");
          if (stage === 'after insertion') throw new Error(stage);
          if (stage === 'trigger recreation') await dedicated.execAsync('CREATE TRIGGER invalid syntax');
          await dedicated.execAsync(triggerSql);
          if (stage === 'final validation') throw new Error(stage);
          expect(transport.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
          throw new Error('before commit');
        } catch (error) {
          await dedicated.execAsync('ROLLBACK');
          throw error;
        }
      })()).rejects.toThrow();
      expect(main.sqlite.prepare('SELECT * FROM entry_allocations').all()).toEqual(beforeData);
      expect(main.sqlite.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY type, name').all()).toEqual(beforeSchema);
      expect(transport.sqlite.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      await expect(dedicated.execAsync('DELETE FROM entry_allocations')).rejects.toThrow('Allocations are immutable');
      await expect(dedicated.execAsync("INSERT INTO entry_allocations VALUES ('bad', 'missing', 1)"))
        .rejects.toThrow('FOREIGN KEY constraint failed');
    } finally { await dedicated.closeAsync(); }
    expect(transport.closed).toBe(true);
  },
);

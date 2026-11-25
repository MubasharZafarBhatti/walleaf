/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import * as SQLite from 'expo-sqlite';
import { openAppDatabase, type AppDb } from '../database/database';
import * as repo from '../database/repositories/repositories';
import { saveSharedExpensePosting } from '../services/sharedExpense/SharedExpenseService';
import { reconcileAllocation } from '../services/groups/GroupService';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

// This is the existing integration-test architecture: real SQLite and production
// migrations/services, with only Expo's native transport replaced. It does not
// claim to execute an Android/iOS bridge or prove native connection defaults.
let sqlite: DatabaseSync;
let db: AppDb;
let originalTrigger: string;
const triggerName = 'allocation_no_delete';

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  const transaction = async (work: () => Promise<void>) => {
    sqlite.exec('BEGIN EXCLUSIVE');
    try { await work(); sqlite.exec('COMMIT'); }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  };
  db = {
    execAsync: async (sql: string) => { sqlite.exec(sql); },
    runAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).run(...params),
    getAllAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).all(...params),
    getFirstAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).get(...params) ?? null,
    withTransactionAsync: transaction,
    withExclusiveTransactionAsync: async (work: (txn: AppDb) => Promise<void>) => transaction(() => work(db)),
  } as unknown as AppDb;
  jest.mocked(SQLite.openDatabaseAsync).mockResolvedValue(db);
  await openAppDatabase();
  const personId = await repo.savePerson(db, 'Proof Person');
  const bill = await saveSharedExpensePosting(db, {
    title: 'Proof bill', totalAmountMinor: 2000, categoryId: 'cat_expense_food',
    accountId: 'account_cash_default', occurredOn: '2026-09-16', payerIsSelf: true,
    shares: [{ name: 'You', isSelf: true, shareMinor: 1000 },
      { name: 'Proof Person', personId, isSelf: false, shareMinor: 1000 }],
  });
  const sourceId = await repo.savePersonEntry(db, {
    person_id: personId, type: 'RECEIVED_BACK', amount_minor: 1000,
    account_id: 'account_cash_default', title: 'Proof repayment', occurred_on: '2026-09-16',
  });
  await reconcileAllocation(db, {
    id: 'proof_allocation', sourceEntryId: sourceId,
    targetEntryId: bill.personEntries[0].id, amountMinor: 500,
  });
  originalTrigger = (await db.getFirstAsync<{ sql: string }>(
    "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?", triggerName,
  ))!.sql;
});

afterEach(() => { sqlite.close(); });

async function snapshot() {
  const tables = await db.getAllAsync<{ name: string }>(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return {
    schema: await db.getAllAsync('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name'),
    data: await Promise.all(tables.map(async ({ name }) => ({
      name, rows: await db.getAllAsync(`SELECT * FROM "${name}" ORDER BY rowid`),
    }))),
  };
}

async function assertProtected(txn: AppDb) {
  expect(await txn.getFirstAsync("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?", triggerName))
    .toEqual({ sql: originalTrigger });
  await expect(txn.runAsync('DELETE FROM entry_allocations WHERE id = ?', 'proof_allocation'))
    .rejects.toThrow('Allocations are immutable');
  expect(await txn.getFirstAsync('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
  expect(await txn.getAllAsync('PRAGMA foreign_key_check')).toEqual([]);
}

test.each(['after deletion', 'after replacement', 'trigger recreation', 'final validation', 'before commit'])(
  'transactional schema/data rollback restores exact rows and trigger: %s', async (stage) => {
    const before = await snapshot();
    const row = (await db.getFirstAsync<Record<string, string | number>>('SELECT * FROM entry_allocations'))!;
    await expect(db.withExclusiveTransactionAsync(async (txn) => {
      await txn.execAsync(`DROP TRIGGER ${triggerName}`);
      await txn.runAsync('DELETE FROM entry_allocations');
      if (stage === 'after deletion') throw new Error(stage);
      await txn.runAsync('UPDATE accounts SET opening_balance_minor = 12345 WHERE id = ?', 'account_cash_default');
      await txn.runAsync('INSERT INTO entry_allocations (id, source_entry_id, target_entry_id, amount_minor, created_at) VALUES (?, ?, ?, ?, ?)',
        row.id, row.source_entry_id, row.target_entry_id, 250, row.created_at);
      if (stage === 'after replacement') throw new Error(stage);
      if (stage === 'trigger recreation') await txn.execAsync('CREATE TRIGGER invalid syntax');
      await txn.execAsync(originalTrigger);
      await assertProtected(txn);
      throw new Error(stage);
    })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    await assertProtected(db);
  },
);

test('successful replacement recreates exact protected trigger before commit and remains protected afterward', async () => {
  await db.withExclusiveTransactionAsync(async (txn) => {
    const row = (await txn.getFirstAsync<Record<string, string | number>>('SELECT * FROM entry_allocations'))!;
    expect(await txn.getFirstAsync('SELECT sql FROM sqlite_schema WHERE name = ?', triggerName)).toEqual({ sql: originalTrigger });
    await txn.execAsync(`DROP TRIGGER ${triggerName}`);
    await txn.runAsync('DELETE FROM entry_allocations');
    await txn.runAsync('INSERT INTO entry_allocations (id, source_entry_id, target_entry_id, amount_minor, created_at) VALUES (?, ?, ?, ?, ?)',
      row.id, row.source_entry_id, row.target_entry_id, 250, row.created_at);
    await txn.execAsync(originalTrigger);
    await assertProtected(txn);
  });
  expect(await db.getFirstAsync('SELECT amount_minor FROM entry_allocations WHERE id = ?', 'proof_allocation'))
    .toEqual({ amount_minor: 250 });
  await assertProtected(db);
});

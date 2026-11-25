/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import * as SQLite from 'expo-sqlite';
import { openAppDatabase, type AppDb } from '../database/database';
import * as repo from '../database/repositories/repositories';
import { calculateAccountBalance } from '../services/finance/FinanceService';
import { readPersonSnapshot } from '../services/people/PersonService';
import { readGroupSnapshot, setAllocationUnrelated, settleGroup } from '../services/groups/GroupService';
import { saveSharedExpensePosting } from '../services/sharedExpense/SharedExpenseService';
import { todayLocal } from '../utils/date';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

let sqlite: DatabaseSync;
let db: AppDb;

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  const adapter = {
    execAsync: async (sql: string) => { sqlite.exec(sql); },
    runAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).run(...params),
    getAllAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).all(...params),
    getFirstAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).get(...params) ?? null,
    withTransactionAsync: async (work: () => Promise<void>) => {
      sqlite.exec('BEGIN');
      try { await work(); sqlite.exec('COMMIT'); }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    withExclusiveTransactionAsync: async (work: (txn: AppDb) => Promise<void>) => adapter.withTransactionAsync(() => work(db)),
  };
  db = adapter as unknown as AppDb;
  jest.mocked(SQLite.openDatabaseAsync).mockResolvedValue(db);
  await openAppDatabase();
});

afterEach(() => sqlite.close());

test.each([
  { selfPaid: true, manualType: 'BORROWED_FROM' as const, action: 'BORROW' as const, resultType: 'BORROWED_FROM', globalBefore: -300000, globalAfter: -800000, cashDelta: 500000, amountMinor: 500000 },
  { selfPaid: false, manualType: 'GIVEN' as const, action: 'GIVE' as const, resultType: 'GIVEN', globalBefore: 300000, globalAfter: 800000, cashDelta: -500000, amountMinor: 500000 },
  { selfPaid: true, manualType: 'BORROWED_FROM' as const, action: 'BORROW' as const, resultType: 'BORROWED_FROM', globalBefore: -300000, globalAfter: -500000, cashDelta: 200000, amountMinor: 200000 },
  { selfPaid: false, manualType: 'GIVEN' as const, action: 'GIVE' as const, resultType: 'GIVEN', globalBefore: 300000, globalAfter: 500000, cashDelta: -200000, amountMinor: 200000 },
])('approved cash-direction allocation preserves global classification when selfPaid=$selfPaid amount=$amountMinor', async (scenario) => {
  const cash = (await repo.listAccounts(db))[0];
  const personId = await repo.savePerson(db, 'Ali');
  const timestamp = '2026-09-13T00:00:00.000Z';
  await db.runAsync('INSERT INTO groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?);', 'trip', 'Trip', timestamp, timestamp);
  const plan = await saveSharedExpensePosting(db, {
    title: 'Group bill', totalAmountMinor: 1000000,
    categoryId: 'cat_expense_food', accountId: cash.id, occurredOn: todayLocal(),
    groupId: 'trip', payerIsSelf: scenario.selfPaid,
    payerPersonId: scenario.selfPaid ? null : personId,
    shares: [
      { name: 'You', isSelf: true, shareMinor: 500000 },
      { name: 'Ali', personId, isSelf: false, shareMinor: 500000 },
    ],
  });
  const manualId = await repo.savePersonEntry(db, {
    person_id: personId, type: scenario.manualType, amount_minor: 800000,
    account_id: cash.id, title: 'Unrelated manual obligation', occurred_on: todayLocal(),
  });
  const before = await readPersonSnapshot(db, personId);
  expect(before.balanceMinor).toBe(scenario.globalBefore);
  expect(before.history).toHaveLength(2);
  expect(before.history.every((entry) => !['PAID_BACK', 'RECEIVED_BACK'].includes(entry.type))).toBe(true);
  const transactionsBefore = await repo.listTransactions(db);
  const cashBefore = calculateAccountBalance(cash, transactionsBefore, before.history);
  const manualBefore = before.history.find((entry) => entry.id === manualId);

  const unresolved = await readGroupSnapshot(db, 'trip');
  expect(unresolved.ambiguous).toBe(true);
  await expect(settleGroup(db, { requestId: 'blocked', groupId: 'trip', personId, accountId: cash.id, occurredOn: todayLocal(), targets: [{ targetEntryId: plan.personEntries[0].id, amountMinor: 500000 }], expectedRevision: unresolved.revision, expectedBalanceMinor: before.balanceMinor })).rejects.toThrow('Reconciliation needed');
  await setAllocationUnrelated(db, manualId, plan.personEntries[0].id, true);
  const reconciled = await readGroupSnapshot(db, 'trip');
  expect(reconciled.ambiguous).toBe(false);
  const input = { requestId: 'accepted', groupId: 'trip', personId, accountId: cash.id, occurredOn: todayLocal(), targets: [{ targetEntryId: plan.personEntries[0].id, amountMinor: scenario.amountMinor }], expectedRevision: reconciled.revision, expectedBalanceMinor: before.balanceMinor };
  const movementId = await settleGroup(db, input);
  expect(await settleGroup(db, input)).toBe(movementId);
  const movement = (await readPersonSnapshot(db, personId)).history.find((entry) => entry.id === movementId)!;
  expect(movement.type).toBe(scenario.resultType);
  expect(['PAID_BACK', 'RECEIVED_BACK']).not.toContain(movement.type);
  const after = await readPersonSnapshot(db, personId);
  expect(after.balanceMinor).toBe(scenario.globalAfter);
  expect(after.history.find((entry) => entry.id === manualId)).toEqual(manualBefore);
  expect(after.history.find((entry) => entry.id === plan.personEntries[0].id)).toEqual(
    before.history.find((entry) => entry.id === plan.personEntries[0].id),
  );
  expect(await repo.listTransactions(db)).toEqual(transactionsBefore);
  expect(calculateAccountBalance(cash, transactionsBefore, after.history) - cashBefore).toBe(scenario.cashDelta);
  const remaining = 500000 - scenario.amountMinor;
  expect((await readGroupSnapshot(db, 'trip')).balanceMinor).toBe(remaining === 0 ? 0 : scenario.selfPaid ? remaining : -remaining);
  expect(after.history).toHaveLength(3);
  expect(await db.getAllAsync('SELECT * FROM allocation_targets WHERE id = ?;', movementId)).toEqual([]);
});

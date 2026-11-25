/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import * as SQLite from 'expo-sqlite';
import { openAppDatabase, type AppDb } from '../database/database';
import * as repo from '../database/repositories/repositories';
import {
  calculateGoalProgress,
  calculateGoalSaved,
  getGoalStatus,
} from '../services/goals/GoalService';
import { calculateAccountBalance } from '../services/finance/FinanceService';
import { getMonthlyExpenseTotal } from '../services/budget/BudgetService';
import type { Account, Goal } from '../types/models';
import { monthKey, todayLocal } from '../utils/date';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

let sqlite: DatabaseSync;
let db: AppDb;
let cash: Account;
let goal: Goal;

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  const adapter = {
    execAsync: async (sql: string) => { sqlite.exec(sql); },
    runAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).run(...params),
    getAllAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).all(...params),
    getFirstAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).get(...params) ?? null,
    withTransactionAsync: async (work: () => Promise<void>) => { sqlite.exec('BEGIN'); try { await work(); sqlite.exec('COMMIT'); } catch (error) { sqlite.exec('ROLLBACK'); throw error; } },
    withExclusiveTransactionAsync: async (work: (txn: AppDb) => Promise<void>) => adapter.withTransactionAsync(() => work(db)),
  };
  db = adapter as unknown as AppDb;
  jest.mocked(SQLite.openDatabaseAsync).mockResolvedValue(db);
  await openAppDatabase();
  cash = (await repo.listAccounts(db))[0];
  const id = await repo.saveGoal(db, { name: 'Laptop', target_amount_minor: 1000000, initial_saved_minor: 200000, target_date: '2027-01-01', linked_account_id: cash.id, note: 'Work machine' });
  goal = await db.getFirstAsync<Goal>('SELECT * FROM goals WHERE id = ?;', id) as Goal;
});

afterEach(() => sqlite.close());

async function saved() {
  return calculateGoalSaved(goal.initial_saved_minor, await repo.listGoalEntries(db, goal.id));
}

test('Goal Detail data derives saved, remaining progress, target date and in-progress status', async () => {
  expect(await saved()).toBe(200000);
  expect(calculateGoalProgress(goal.target_amount_minor, await saved())).toBe(20);
  expect(getGoalStatus(goal, await saved(), '2026-09-15')).toBe('IN_PROGRESS');
});

test('rename, target and target-date edits preserve stable identity and historical entries', async () => {
  await repo.saveGoalEntry(db, { goal_id: goal.id, type: 'ADD', amount_minor: 100000, occurred_on: todayLocal(), note: 'September saving' });
  await repo.updateGoal(db, goal.id, goal.updated_at, { name: 'New laptop', target_amount_minor: 1200000, target_date: '2027-06-01', linked_account_id: cash.id, note: 'Updated note' });
  const changed = await db.getFirstAsync<Goal>('SELECT * FROM goals WHERE id = ?;', goal.id) as Goal;
  expect(changed).toMatchObject({ id: goal.id, name: 'New laptop', target_amount_minor: 1200000, target_date: '2027-06-01', note: 'Updated note' });
  expect(await repo.listGoalEntries(db, goal.id)).toMatchObject([{ type: 'ADD', amount_minor: 100000, note: 'September saving' }]);
});

test('target cannot silently fall below the amount already saved', async () => {
  await expect(repo.updateGoal(db, goal.id, goal.updated_at, { name: goal.name, target_amount_minor: 199999, target_date: goal.target_date, linked_account_id: cash.id, note: goal.note })).rejects.toThrow('lower than the amount already saved');
  expect((await db.getFirstAsync<Goal>('SELECT * FROM goals WHERE id = ?;', goal.id))?.target_amount_minor).toBe(1000000);
});

test('allocation adds tracked savings without an Expense, Income, account or Spending Plan effect', async () => {
  const balanceBefore = calculateAccountBalance(cash, await repo.listTransactions(db), await repo.listPersonEntries(db));
  await repo.saveGoalEntry(db, { goal_id: goal.id, type: 'ADD', amount_minor: 300000, occurred_on: todayLocal(), note: 'Bonus saved' });
  expect(await saved()).toBe(500000);
  expect(await repo.listTransactions(db)).toEqual([]);
  expect(calculateAccountBalance(cash, await repo.listTransactions(db), await repo.listPersonEntries(db))).toBe(balanceBefore);
  expect(getMonthlyExpenseTotal(await repo.listTransactions(db), monthKey(todayLocal()))).toBe(0);
});

test('partial and full withdrawals append readable history without Income or Expense effects', async () => {
  // Same-day history sorts by created_at; do not rely on wall-clock execution
  // taking more than one millisecond between the two SQLite writes.
  jest.useFakeTimers({ now: new Date('2026-09-15T12:00:00.000Z') });
  try {
  await repo.saveGoalEntry(db, { goal_id: goal.id, type: 'WITHDRAW', amount_minor: 50000, occurred_on: todayLocal(), note: 'Released for repair' });
  expect(await saved()).toBe(150000);
  jest.advanceTimersByTime(1);
  await repo.saveGoalEntry(db, { goal_id: goal.id, type: 'WITHDRAW', amount_minor: 150000, occurred_on: todayLocal() });
  expect(await saved()).toBe(0);
  expect(await repo.listGoalEntries(db, goal.id)).toMatchObject([{ type: 'WITHDRAW', amount_minor: 150000 }, { type: 'WITHDRAW', amount_minor: 50000, note: 'Released for repair' }]);
  expect(await repo.listTransactions(db)).toEqual([]);
  } finally { jest.useRealTimers(); }
});

test('withdrawal larger than currently saved is rejected atomically', async () => {
  await expect(repo.saveGoalEntry(db, { goal_id: goal.id, type: 'WITHDRAW', amount_minor: 200001, occurred_on: todayLocal() })).rejects.toThrow('currently tracked');
  expect(await saved()).toBe(200000);
  expect(await repo.listGoalEntries(db, goal.id)).toEqual([]);
});

test('completed and needs-attention statuses derive again after target edits', async () => {
  await repo.saveGoalEntry(db, { goal_id: goal.id, type: 'ADD', amount_minor: 800000, occurred_on: todayLocal() });
  expect(getGoalStatus(goal, await saved(), '2026-09-15')).toBe('COMPLETED');
  const current = await db.getFirstAsync<Goal>('SELECT * FROM goals WHERE id = ?;', goal.id) as Goal;
  await repo.updateGoal(db, goal.id, current.updated_at, { name: goal.name, target_amount_minor: 1500000, target_date: '2026-01-01', linked_account_id: cash.id, note: goal.note });
  const edited = await db.getFirstAsync<Goal>('SELECT * FROM goals WHERE id = ?;', goal.id) as Goal;
  expect(getGoalStatus(edited, await saved(), '2026-09-15')).toBe('NEEDS_ATTENTION');
});

test('archive retains history, hides normal lists and prevents new goal activity', async () => {
  await repo.saveGoalEntry(db, { goal_id: goal.id, type: 'ADD', amount_minor: 1000, occurred_on: todayLocal() });
  await repo.archiveGoal(db, goal.id, goal.updated_at);
  expect((await repo.listGoals(db)).map((item) => item.id)).not.toContain(goal.id);
  expect((await repo.listGoals(db, true)).find((item) => item.id === goal.id)?.is_archived).toBe(1);
  expect(await repo.listGoalEntries(db, goal.id)).toHaveLength(1);
  await expect(repo.saveGoalEntry(db, { goal_id: goal.id, type: 'ADD', amount_minor: 1, occurred_on: todayLocal() })).rejects.toThrow('Archived goals');
});

test.each([1000, 800000])('restore retains the same goal and history, restores derived status and moves no money (%i saved entry)', async (amount) => {
  await repo.saveGoalEntry(db, { goal_id: goal.id, type: 'ADD', amount_minor: amount, occurred_on: todayLocal(), note: 'Keep this history' });
  await repo.archiveGoal(db, goal.id, goal.updated_at);
  const archived = (await db.getFirstAsync<Goal>('SELECT * FROM goals WHERE id = ?;', goal.id))!;
  const entries = await repo.listGoalEntries(db, goal.id);
  const transactions = await repo.listTransactions(db);
  const people = await repo.listPersonEntries(db);
  const accounts = await db.getAllAsync('SELECT * FROM accounts');
  const budgets = await db.getAllAsync('SELECT * FROM budgets');
  // Even an archived reference account is kept as historical metadata.
  await db.runAsync('UPDATE accounts SET is_archived = 1 WHERE id = ?;', cash.id);
  const historicalAccounts = await db.getAllAsync('SELECT * FROM accounts');
  await repo.restoreGoal(db, goal.id, archived.updated_at);
  const restored = (await db.getFirstAsync<Goal>('SELECT * FROM goals WHERE id = ?;', goal.id))!;
  expect(restored).toEqual({ ...archived, is_archived: 0, updated_at: restored.updated_at });
  expect(restored.updated_at > archived.updated_at).toBe(true);
  expect(getGoalStatus(restored, await saved(), '2026-09-15')).toBe(amount === 800000 ? 'COMPLETED' : 'IN_PROGRESS');
  expect(await repo.listGoalEntries(db, goal.id)).toEqual(entries);
  expect(await repo.listTransactions(db)).toEqual(transactions);
  expect(await repo.listPersonEntries(db)).toEqual(people);
  expect(await db.getAllAsync('SELECT * FROM accounts')).toEqual(historicalAccounts);
  expect(accounts).toHaveLength(historicalAccounts.length);
  expect(await db.getAllAsync('SELECT * FROM budgets')).toEqual(budgets);
  expect((await repo.listGoals(db)).map((row) => row.id)).toContain(goal.id);
  await expect(repo.restoreGoal(db, goal.id, archived.updated_at)).rejects.toThrow('changed');
});

test('failed restore metadata write rolls back without losing the archived goal/history', async () => {
  await repo.archiveGoal(db, goal.id, goal.updated_at);
  const before = await db.getFirstAsync<Goal>('SELECT * FROM goals WHERE id = ?;', goal.id);
  const write = jest.spyOn(db, 'runAsync').mockRejectedValueOnce(new Error('restore failed'));
  await expect(repo.restoreGoal(db, goal.id, before!.updated_at)).rejects.toThrow('restore failed');
  write.mockRestore();
  expect(await db.getFirstAsync('SELECT * FROM goals WHERE id = ?;', goal.id)).toEqual(before);
  expect(await repo.listTransactions(db)).toEqual([]);
});

test('only an empty zero-saved goal can be hard deleted', async () => {
  const id = await repo.saveGoal(db, { name: 'Empty', target_amount_minor: 1000, initial_saved_minor: 0 });
  const empty = await db.getFirstAsync<Goal>('SELECT * FROM goals WHERE id = ?;', id) as Goal;
  await repo.deleteEmptyGoal(db, id, empty.updated_at);
  expect(await db.getFirstAsync('SELECT * FROM goals WHERE id = ? AND deleted_at IS NULL;', id)).toBeNull();
  await expect(repo.deleteEmptyGoal(db, goal.id, goal.updated_at)).rejects.toThrow('saved money or history');
});

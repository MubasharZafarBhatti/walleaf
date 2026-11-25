/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import * as SQLite from 'expo-sqlite';
import { openAppDatabase, type AppDb } from '../database/database';
import * as repo from '../database/repositories/repositories';
import {
  calculateCategoryPersonalSpending,
  getDailyAllowanceState,
  getMonthlyExpenseTotal,
  getThreeMonthCategorySuggestion,
  shiftMonthKey,
} from '../services/budget/BudgetService';
import {
  autoCopyCurrentMonthOnce,
  previousMeaningfulPlanMonth,
  planMonthNavigation,
  copyPreviousMonthPlan,
  createCategoryBudget,
  previewCopyPreviousMonth,
  removeCategoryBudget,
  updateCategoryBudget,
} from '../services/budget/SpendingPlanService';
import { buildSharedExpensePostingPlan } from '../services/sharedExpense/SharedExpenseService';
import type { Budget, Transaction } from '../types/models';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

type Value = string | number | null;
let sqlite: DatabaseSync;
let db: AppDb;

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  const adapter = {
    execAsync: async (sql: string) => { sqlite.exec(sql); },
    runAsync: async (sql: string, ...params: Value[]) => sqlite.prepare(sql).run(...params),
    getAllAsync: async (sql: string, ...params: Value[]) => sqlite.prepare(sql).all(...params),
    getFirstAsync: async (sql: string, ...params: Value[]) => sqlite.prepare(sql).get(...params) ?? null,
    withTransactionAsync: async (work: () => Promise<void>) => {
      sqlite.exec('BEGIN');
      try { await work(); sqlite.exec('COMMIT'); }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    withExclusiveTransactionAsync: async (work: (txn: AppDb) => Promise<void>) => {
      sqlite.exec('BEGIN EXCLUSIVE');
      try { await work(adapter as unknown as AppDb); sqlite.exec('COMMIT'); }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  jest.mocked(SQLite.openDatabaseAsync).mockResolvedValue(adapter as unknown as SQLite.SQLiteDatabase);
  db = await openAppDatabase();
});

afterEach(() => sqlite.close());

test('meaningful history skips empty months, uses personal Expense authority and never creates plans', async () => {
  const previous = async (selected = '2026-10') => previousMeaningfulPlanMonth(db, selected, '2026-10', await repo.listTransactions(db));
  expect(await previous()).toBeNull();
  await addExpense('income', 'cat_income_salary', 1000, '2026-09-01', 'INCOME');
  await addExpense('transfer', 'cat_expense_food', 1000, '2026-09-01', 'TRANSFER');
  const person = await repo.savePerson(db, 'Ali');
  await repo.savePersonEntry(db, { person_id: person, account_id: 'account_cash_default', type: 'GIVEN', amount_minor: 1000, title: 'Given', occurred_on: '2026-09-01' });
  expect(await previous()).toBeNull();
  await repo.saveBudget(db, { month_key: '2025-12', amount_minor: 1000 });
  expect(await previous()).toBe('2025-12');
  await addExpense('personal', 'cat_expense_food', 1, '2026-02-28');
  expect(await previous()).toBe('2026-02');
  expect(await previous('2026-02')).toBe('2025-12');
  expect(await previous('2025-12')).toBeNull();
  expect(await previous('2026-11')).toBe('2026-10');
  expect(await planMonthNavigation(db, '2026-02', '2026-10', await repo.listTransactions(db))).toEqual({ previous: '2025-12', next: '2026-10' });
  expect(await repo.listBudgets(db, '2026-10')).toEqual([]);
});

test('deliberately removed USER category plans remain meaningful history', async () => {
  await createCategoryBudget(db, { month: '2026-08', categoryId: 'cat_expense_food', amountMinor: 1000 });
  const budget = (await repo.listBudgets(db, '2026-08'))[0];
  await removeCategoryBudget(db, budget.id, budget.updated_at);
  expect(await previousMeaningfulPlanMonth(db, '2026-10', '2026-10', [])).toBe('2026-08');
});

function activeBudgets(month: string): Budget[] {
  return sqlite.prepare('SELECT * FROM budgets WHERE month_key = ? AND deleted_at IS NULL ORDER BY category_id IS NOT NULL, category_id').all(month) as unknown as Budget[];
}

async function addExpense(id: string, categoryId: string, amountMinor: number, occurredOn: string, type = 'EXPENSE') {
  await db.runAsync(
    "INSERT INTO transactions (id, type, amount_minor, account_id, category_id, title, occurred_on, source, created_at, updated_at, sync_status) VALUES (?, ?, ?, 'account_cash_default', ?, 'History', ?, 'MANUAL', 't', 't', 'LOCAL');",
    id, type, amountMinor, categoryId, occurredOn,
  );
}

test('month navigation uses calendar-safe year and leap-month transitions', () => {
  expect(shiftMonthKey('2026-01', -1)).toBe('2025-12');
  expect(shiftMonthKey('2026-12', 1)).toBe('2027-01');
  expect(shiftMonthKey('2024-02', 1)).toBe('2024-03');
  expect(() => shiftMonthKey('2026-13', 1)).toThrow('Invalid spending plan month');
});

test('category budget create, same-amount edit adoption, and removal preserve ownership safely', async () => {
  await createCategoryBudget(db, { month: '2026-09', categoryId: 'cat_expense_food', amountMinor: 120000 });
  let budget = activeBudgets('2026-09')[0];
  expect(budget).toMatchObject({ category_id: 'cat_expense_food', amount_minor: 120000, ownership: 'USER' });
  await db.runAsync("UPDATE budgets SET ownership = 'DEMO' WHERE id = ?", budget.id);
  budget = activeBudgets('2026-09')[0];
  await updateCategoryBudget(db, { id: budget.id, expectedUpdatedAt: budget.updated_at, amountMinor: 120000 });
  budget = activeBudgets('2026-09')[0];
  expect(budget).toMatchObject({ amount_minor: 120000, ownership: 'USER' });
  await removeCategoryBudget(db, budget.id, budget.updated_at);
  expect(activeBudgets('2026-09')).toEqual([]);
  expect(sqlite.prepare('SELECT ownership, deleted_at FROM budgets WHERE id = ?').get(budget.id)).toMatchObject({ ownership: 'USER', deleted_at: expect.any(String) });
});

test('duplicate active month/category budget is rejected without replacing the first row', async () => {
  await createCategoryBudget(db, { month: '2026-09', categoryId: 'cat_expense_food', amountMinor: 100 });
  const before = activeBudgets('2026-09');
  await expect(createCategoryBudget(db, { month: '2026-09', categoryId: 'cat_expense_food', amountMinor: 200 })).rejects.toThrow('already has a budget');
  expect(activeBudgets('2026-09')).toEqual(before);
});

test('archived categories cannot receive new budgets but existing history stays readable', async () => {
  const category = (await repo.listCategories(db, 'EXPENSE')).find((row) => row.id === 'cat_expense_food')!;
  await createCategoryBudget(db, { month: '2026-08', categoryId: category.id, amountMinor: 5000 });
  await repo.archiveCategory(db, category.id, category.updated_at);
  await expect(createCategoryBudget(db, { month: '2026-09', categoryId: category.id, amountMinor: 5000 })).rejects.toThrow('active expense category');
  expect((await repo.listBudgets(db, '2026-08'))[0].category_id).toBe(category.id);
  expect((await repo.listCategories(db, 'EXPENSE')).find((row) => row.id === category.id)?.name).toBe('Food');
});

test('copy previous month copies total/category amounts only and makes user-owned rows', async () => {
  await repo.saveBudget(db, { month_key: '2026-08', amount_minor: 900000 });
  await createCategoryBudget(db, { month: '2026-08', categoryId: 'cat_expense_food', amountMinor: 300000 });
  await addExpense('history', 'cat_expense_food', 125000, '2026-08-10');
  const beforeTransactions = await repo.listTransactions(db);
  const result = await copyPreviousMonthPlan(db, '2026-09');
  expect(result.copyCount).toBe(2);
  expect(activeBudgets('2026-09').map((row) => [row.category_id, row.amount_minor, row.ownership])).toEqual([
    [null, 900000, 'USER'], ['cat_expense_food', 300000, 'USER'],
  ]);
  expect(await repo.listTransactions(db)).toEqual(beforeTransactions);
});

test('copy merge keeps destination decisions and skips archived source categories', async () => {
  await repo.saveBudget(db, { month_key: '2026-08', amount_minor: 900000 });
  await createCategoryBudget(db, { month: '2026-08', categoryId: 'cat_expense_food', amountMinor: 300000 });
  await createCategoryBudget(db, { month: '2026-08', categoryId: 'cat_expense_fuel', amountMinor: 100000 });
  await repo.saveBudget(db, { month_key: '2026-09', amount_minor: 700000 });
  const food = (await repo.listCategories(db, 'EXPENSE')).find((row) => row.id === 'cat_expense_food')!;
  await repo.archiveCategory(db, food.id, food.updated_at);
  const preview = await previewCopyPreviousMonth(db, '2026-09');
  expect(preview.items.map((row) => [row.label, row.status])).toEqual([
    ['Total Spending Plan', 'conflict'], ['Food', 'archived'], ['Fuel', 'copy'],
  ]);
  await copyPreviousMonthPlan(db, '2026-09');
  expect(activeBudgets('2026-09').map((row) => [row.category_id, row.amount_minor])).toEqual([
    [null, 700000], ['cat_expense_fuel', 100000],
  ]);
});

test('a removed destination category is treated as a decision and is not recreated by copy', async () => {
  await createCategoryBudget(db, { month: '2026-08', categoryId: 'cat_expense_food', amountMinor: 300000 });
  await createCategoryBudget(db, { month: '2026-09', categoryId: 'cat_expense_food', amountMinor: 100000 });
  const destination = activeBudgets('2026-09')[0];
  await removeCategoryBudget(db, destination.id, destination.updated_at);
  const preview = await copyPreviousMonthPlan(db, '2026-09');
  expect(preview.items[0].status).toBe('conflict');
  expect(activeBudgets('2026-09')).toEqual([]);
});

test('multi-row copy rolls back atomically when a later insert fails', async () => {
  await repo.saveBudget(db, { month_key: '2026-08', amount_minor: 900000 });
  await createCategoryBudget(db, { month: '2026-08', categoryId: 'cat_expense_food', amountMinor: 300000 });
  sqlite.exec("CREATE TRIGGER fail_plan_copy BEFORE INSERT ON budgets WHEN NEW.month_key = '2026-09' AND NEW.category_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'copy failure'); END;");
  await expect(copyPreviousMonthPlan(db, '2026-09')).rejects.toThrow('copy failure');
  expect(activeBudgets('2026-09')).toEqual([]);
});

test('auto-copy is off by default', async () => {
  await repo.saveBudget(db, { month_key: '2026-08', amount_minor: 900000 });
  expect(await autoCopyCurrentMonthOnce(db, '2026-09')).toBe('disabled');
  expect(activeBudgets('2026-09')).toEqual([]);
});

test('auto-copy runs once and persistent marker prevents recreation after deletion', async () => {
  await repo.saveBudget(db, { month_key: '2026-08', amount_minor: 900000 });
  await createCategoryBudget(db, { month: '2026-08', categoryId: 'cat_expense_food', amountMinor: 300000 });
  await repo.setSetting(db, 'budget_auto_copy_enabled', 'true');
  expect(await autoCopyCurrentMonthOnce(db, '2026-09')).toBe('copied');
  const copied = activeBudgets('2026-09');
  expect(copied).toHaveLength(2);
  await removeCategoryBudget(db, copied[1].id, copied[1].updated_at);
  expect(await autoCopyCurrentMonthOnce(db, '2026-09')).toBe('already-processed');
  expect(activeBudgets('2026-09')).toHaveLength(1);
  expect((await repo.getSettings(db)).budget_auto_copy_processed_month).toBe('2026-09');
});

test('auto-copy never overwrites an existing manual plan and still marks the month processed', async () => {
  await repo.saveBudget(db, { month_key: '2026-08', amount_minor: 900000 });
  await repo.saveBudget(db, { month_key: '2026-09', amount_minor: 123000 });
  await repo.setSetting(db, 'budget_auto_copy_enabled', 'true');
  expect(await autoCopyCurrentMonthOnce(db, '2026-09')).toBe('destination-not-empty');
  expect(activeBudgets('2026-09')[0].amount_minor).toBe(123000);
  expect(await autoCopyCurrentMonthOnce(db, '2026-09')).toBe('already-processed');
});

test('daily allowance distinguishes available, exhausted, overspent, historical, future, and no-plan states', () => {
  expect(getDailyAllowanceState(3100, 0, '2026-09', '2026-09-01')).toEqual({ kind: 'available', allowanceMinor: 103, daysRemaining: 30 });
  expect(getDailyAllowanceState(1000, 1000, '2026-09', '2026-09-30').kind).toBe('exhausted');
  expect(getDailyAllowanceState(1000, 1200, '2026-09', '2026-09-30')).toMatchObject({ kind: 'overspent', overMinor: 200 });
  expect(getDailyAllowanceState(1000, 0, '2026-08', '2026-09-01').kind).toBe('historical');
  expect(getDailyAllowanceState(1000, 0, '2026-10', '2026-09-01').kind).toBe('future');
  expect(getDailyAllowanceState(null, 0, '2026-09', '2026-09-01').kind).toBe('no-plan');
});

test('three-month suggestion is deterministic, includes zero months, and can be ignored', async () => {
  await addExpense('a', 'cat_expense_food', 300, '2026-06-01');
  await addExpense('b', 'cat_expense_food', 600, '2026-08-01');
  const transactions = await repo.listTransactions(db);
  const before = JSON.stringify(transactions);
  const first = getThreeMonthCategorySuggestion(transactions, 'cat_expense_food', '2026-09', '2026-09-15');
  const second = getThreeMonthCategorySuggestion([...transactions].reverse(), 'cat_expense_food', '2026-09', '2026-09-15');
  expect(first).toEqual({ months: ['2026-06', '2026-07', '2026-08'], monthlySpendingMinor: [300, 0, 600], averageMinor: 300, hasHistory: true });
  expect(second).toEqual(first);
  expect(JSON.stringify(transactions)).toBe(before);
  expect(activeBudgets('2026-09')).toEqual([]);
});

test('future-plan suggestions use only the latest three complete months', async () => {
  await addExpense('june', 'cat_expense_food', 300, '2026-06-01');
  await addExpense('july', 'cat_expense_food', 600, '2026-07-01');
  await addExpense('aug', 'cat_expense_food', 900, '2026-08-01');
  await addExpense('partial', 'cat_expense_food', 90000, '2026-09-01');
  expect(getThreeMonthCategorySuggestion(await repo.listTransactions(db), 'cat_expense_food', '2026-10', '2026-09-15')).toMatchObject({
    months: ['2026-06', '2026-07', '2026-08'], averageMinor: 600,
  });
});

test('suggestion and Home/Spending Plan totals use only personal Expense rows including shared personal share', async () => {
  await addExpense('expense', 'cat_expense_food', 300, '2026-08-01');
  await addExpense('income', 'cat_expense_food', 50000, '2026-08-02', 'INCOME');
  const shared = buildSharedExpensePostingPlan({
    title: 'Shared dinner', totalAmountMinor: 900, categoryId: 'cat_expense_food', accountId: 'account_cash_default', occurredOn: '2026-08-03', payerIsSelf: true,
    shares: [{ name: 'You', isSelf: true, shareMinor: 300 }, { name: 'Ali', personId: 'person_ali', isSelf: false, shareMinor: 600 }],
  });
  const personal = shared.personalExpenseTransaction!;
  await db.runAsync(
    "INSERT INTO transactions (id, type, amount_minor, account_id, category_id, title, occurred_on, source, financial_event_id, created_at, updated_at, sync_status) VALUES ('shared', 'EXPENSE', ?, 'account_cash_default', ?, 'Shared dinner', '2026-08-03', 'SPLIT', ?, 't', 't', 'LOCAL');",
    personal.amount_minor, personal.category_id, personal.financial_event_id,
  );
  const transactions = await repo.listTransactions(db) as Transaction[];
  expect(calculateCategoryPersonalSpending(transactions, '2026-08', 'cat_expense_food')).toBe(600);
  expect(getMonthlyExpenseTotal(transactions, '2026-08')).toBe(600);
  expect(getThreeMonthCategorySuggestion(transactions, 'cat_expense_food', '2026-09', '2026-09-15').averageMinor).toBe(200);
});

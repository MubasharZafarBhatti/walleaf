/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import * as SQLite from 'expo-sqlite';
import { openAppDatabase, type AppDb } from '../database/database';
import * as repo from '../database/repositories/repositories';
import { listActivity, listPersonalSpendingActivity } from '../services/activity/ActivityService';
import { readGroupSnapshot } from '../services/groups/GroupService';
import { saveSharedExpensePosting } from '../services/sharedExpense/SharedExpenseService';
import type { Category } from '../types/models';
import { addDays, todayLocal } from '../utils/date';

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
    withTransactionAsync: async (work: () => Promise<void>) => { sqlite.exec('BEGIN'); try { await work(); sqlite.exec('COMMIT'); } catch (error) { sqlite.exec('ROLLBACK'); throw error; } },
    withExclusiveTransactionAsync: async (work: (txn: AppDb) => Promise<void>) => adapter.withTransactionAsync(() => work(db)),
  };
  db = adapter as unknown as AppDb;
  jest.mocked(SQLite.openDatabaseAsync).mockResolvedValue(db);
  await openAppDatabase();
});
afterEach(() => sqlite.close());

test('Delete Category retains identity/history/plan and archived category spending while excluding all new choices', async () => {
  await repo.createCategory(db, { name: 'Delete meals', type: 'EXPENSE' });
  const category = (await repo.listCategories(db)).find((row) => row.name === 'Delete meals')!;
  const date = todayLocal();
  await repo.saveTransaction(db, { type: 'EXPENSE', amount_minor: 1200, account_id: 'account_cash_default', category_id: category.id, title: 'Old meal', occurred_on: date, source: 'MANUAL' });
  await repo.saveBudget(db, { month_key: date.slice(0, 7), category_id: category.id, amount_minor: 5000 });
  const transactions = await repo.listTransactions(db);
  const plans = await repo.listBudgets(db, date.slice(0, 7));
  await repo.deleteCategory(db, category.id, category.updated_at);
  expect((await repo.listCategories(db)).find((row) => row.id === category.id)).toMatchObject({ name: 'Delete meals', is_archived: 1, deleted_at: null });
  expect(await repo.listTransactions(db)).toEqual(transactions);
  expect(await repo.listBudgets(db, date.slice(0, 7))).toEqual(plans);
  expect(await listPersonalSpendingActivity(db, { categoryId: category.id, from: date, to: date })).toMatchObject([{ category_name: 'Delete meals', amount_minor: 1200 }]);
  const other = (await repo.listCategories(db)).find((row) => row.id === 'cat_expense_other')!;
  const incomeOther = (await repo.listCategories(db)).find((row) => row.id === 'cat_income_other_income')!;
  await expect(repo.deleteCategory(db, other.id, other.updated_at)).rejects.toThrow('fallback');
  await expect(repo.deleteCategory(db, incomeOther.id, incomeOther.updated_at)).rejects.toThrow('fallback');
});

test.each(['planned', 'subscription'])('active future %s prevents category deletion until its definition is reassigned', async (kind) => {
  await repo.createCategory(db, { name: 'Future meals', type: 'EXPENSE' });
  const category = (await repo.listCategories(db)).find((row) => row.name === 'Future meals')!;
  const date = addDays(todayLocal(), 30);
  let id: string;
  if (kind === 'planned') id = await repo.savePlannedPayment(db, { name: 'Future bill', type: 'EXPENSE', amount_minor: 1000, category_id: category.id, account_id: 'account_cash_default', next_due_date: date, recurrence_type: 'NONE', recurrence_interval: 1, reminder_enabled: 0, reminder_days_before: 0 });
  else id = await repo.saveSubscription(db, { name: 'Future renewal', amount_minor: 1000, category_id: category.id, account_id: 'account_cash_default', start_date: todayLocal(), next_renewal_date: date, frequency_type: 'MONTHLY', frequency_interval: 1, reminder_enabled: 0, reminder_days_before: 0, cancellation_reminder_enabled: 0 });
  await expect(repo.deleteCategory(db, category.id, category.updated_at)).rejects.toThrow('Edit that future definition');
  expect((await repo.listCategories(db)).find((row) => row.id === category.id)).toEqual(category);
  expect(await repo.listTransactions(db)).toEqual([]);
  if (kind === 'planned') {
    const plan = (await repo.getPlannedPayment(db, id))!;
    await repo.updatePlannedPayment(db, id, plan.updated_at, { ...plan, category_id: 'cat_expense_other' });
  } else {
    const sub = (await repo.getSubscription(db, id))!;
    await repo.updateSubscription(db, id, sub.updated_at, { ...sub, category_id: 'cat_expense_other' });
  }
  await repo.deleteCategory(db, category.id, category.updated_at);
  expect((await repo.listCategories(db)).find((row) => row.id === category.id)?.is_archived).toBe(1);
});

test('rename and archive preserve category identity and historical Activity display', async () => {
  await repo.createCategory(db, { name: 'Dining', type: 'EXPENSE' });
  let category = (await repo.listCategories(db, 'EXPENSE')).find((row) => row.name === 'Dining')!;
  await repo.saveTransaction(db, { type: 'EXPENSE', amount_minor: 1200, account_id: 'account_cash_default', category_id: category.id, title: 'Lunch', occurred_on: todayLocal(), source: 'MANUAL' });
  await repo.renameCategory(db, category.id, category.updated_at, 'Meals');
  category = await db.getFirstAsync<Category>('SELECT * FROM categories WHERE id = ?;', category.id) as Category;
  await repo.archiveCategory(db, category.id, category.updated_at);
  expect((await repo.listCategories(db)).some((row) => row.id === category.id && !row.is_archived)).toBe(false);
  expect(await listActivity(db)).toMatchObject([{ category_id: category.id, category_name: 'Meals' }]);
  await expect(repo.saveTransaction(db, { type: 'EXPENSE', amount_minor: 100, account_id: 'account_cash_default', category_id: category.id, title: 'Stale category', occurred_on: todayLocal(), source: 'MANUAL' })).rejects.toThrow('active expense category');
});

test('case-insensitive names are reserved across archive and fallback categories remain active', async () => {
  await repo.createCategory(db, { name: 'Dining', type: 'EXPENSE' });
  const dining = (await repo.listCategories(db)).find((row) => row.name === 'Dining')!;
  await repo.archiveCategory(db, dining.id, dining.updated_at);
  await expect(repo.createCategory(db, { name: ' dining ', type: 'EXPENSE' })).rejects.toThrow('CATEGORY_NAME_EXISTS');
  const other = await db.getFirstAsync<Category>('SELECT * FROM categories WHERE id = ?;', 'cat_expense_other') as Category;
  const incomeOther = await db.getFirstAsync<Category>('SELECT * FROM categories WHERE id = ?;', 'cat_income_other_income') as Category;
  await expect(repo.archiveCategory(db, other.id, other.updated_at)).rejects.toThrow('fallback');
  await expect(repo.archiveCategory(db, incomeOther.id, incomeOther.updated_at)).rejects.toThrow('fallback');
});

test('restore detects an active conflict and rolls back its archived state', async () => {
  await repo.createCategory(db, { name: 'Dining', type: 'EXPENSE' });
  const dining = (await repo.listCategories(db)).find((row) => row.name === 'Dining')!;
  await repo.archiveCategory(db, dining.id, dining.updated_at);
  const archived = await db.getFirstAsync<Category>('SELECT * FROM categories WHERE id = ?;', dining.id) as Category;
  await db.runAsync("UPDATE categories SET name = 'Dining 2' WHERE id = ?;", dining.id);
  await db.execAsync('DROP INDEX categories_name_type_unique;');
  await repo.createCategory(db, { name: 'Dining', type: 'EXPENSE' });
  await db.runAsync("UPDATE categories SET name = 'Dining' WHERE id = ?;", dining.id);
  await expect(repo.restoreCategory(db, dining.id, archived.updated_at)).rejects.toThrow('CATEGORY_NAME_EXISTS');
  expect((await db.getFirstAsync<Category>('SELECT * FROM categories WHERE id = ?;', dining.id))?.is_archived).toBe(1);
});

test('archiving preserves shared Group and Budget history while stale financial writes are rejected', async () => {
  await repo.createCategory(db, { name: 'Trip meals', type: 'EXPENSE' });
  const category = (await repo.listCategories(db)).find((row) => row.name === 'Trip meals')!;
  const personId = await repo.savePerson(db, 'Ali');
  const groupId = await repo.createGroup(db, { name: 'Trip', personIds: [personId] });
  await repo.saveBudget(db, { month_key: todayLocal().slice(0, 7), category_id: category.id, amount_minor: 3000 });
  await saveSharedExpensePosting(db, { title: 'Trip dinner', totalAmountMinor: 2000, categoryId: category.id, accountId: 'account_cash_default', occurredOn: todayLocal(), groupId, payerIsSelf: true, shares: [{ name: 'You', isSelf: true, shareMinor: 1000 }, { name: 'Ali', personId, isSelf: false, shareMinor: 1000 }] });
  await repo.archiveCategory(db, category.id, category.updated_at);
  expect((await readGroupSnapshot(db, groupId)).expenses).toMatchObject([{ category_id: category.id, category_name: 'Trip meals' }]);
  expect(await repo.listBudgets(db, todayLocal().slice(0, 7))).toMatchObject([{ category_id: category.id, amount_minor: 3000 }]);
  const before = await db.getAllAsync('SELECT * FROM split_groups;');
  await expect(saveSharedExpensePosting(db, { title: 'Stale trip dinner', totalAmountMinor: 2000, categoryId: category.id, accountId: 'account_cash_default', occurredOn: todayLocal(), payerIsSelf: true, shares: [{ name: 'You', isSelf: true, shareMinor: 1000 }, { name: 'Ali', personId, isSelf: false, shareMinor: 1000 }] })).rejects.toThrow('expense category');
  expect(await db.getAllAsync('SELECT * FROM split_groups;')).toEqual(before);
});

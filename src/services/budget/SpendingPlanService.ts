import type { AppDb } from '../../database/database';
import { makeId, nowIso } from '../../database/database';
import type { Budget, Transaction } from '../../types/models';
import { mainCurrency } from '../../database/repositories/repositories';
import { isPersonalSpendingTransaction, shiftMonthKey } from './BudgetService';

/** Includes deliberate USER removals; browsing never creates a decision. */
export async function previousMeaningfulPlanMonth(db: AppDb, selected: string, current: string, transactions: Transaction[]): Promise<string | null> {
  return (await planMonthNavigation(db, selected, current, transactions)).previous;
}

export async function planMonthNavigation(db: AppDb, selected: string, current: string, transactions: Transaction[]) {
  const plans = await db.getAllAsync<{ month_key: string }>("SELECT DISTINCT month_key FROM budgets WHERE month_key < ? AND (deleted_at IS NULL OR ownership = 'USER');", current);
  const months = [...plans.map((row) => row.month_key), ...transactions.filter(isPersonalSpendingTransaction).map((row) => row.occurred_on.slice(0, 7))];
  return {
    previous: selected > current ? current : months.filter((month) => month < selected).sort().at(-1) ?? null,
    next: selected < current ? months.filter((month) => month > selected && month < current).sort()[0] ?? current : selected === current ? shiftMonthKey(current, 1) : null,
  };
}

type CategoryRow = { id: string; name: string; type: string; is_archived: number; deleted_at?: string | null };

export type CopyPlanItem = {
  categoryId: string | null;
  currency: string;
  label: string;
  amountMinor: number;
  status: 'copy' | 'conflict' | 'archived';
};

export type CopyPlanPreview = {
  sourceMonth: string;
  targetMonth: string;
  items: CopyPlanItem[];
  copyCount: number;
  conflictCount: number;
  archivedCount: number;
};

function validateAmount(amountMinor: number): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0)
    throw new Error('Enter an amount greater than zero.');
}

/** Each currency's plan is copied on its own; without a currency, every currency's plan. */
async function readCopyPreview(db: AppDb, targetMonth: string, currency?: string): Promise<CopyPlanPreview> {
  const sourceMonth = shiftMonthKey(targetMonth, -1);
  const source = (await db.getAllAsync<Budget>(
    'SELECT * FROM budgets WHERE month_key = ? AND deleted_at IS NULL ORDER BY category_id IS NOT NULL, category_id;',
    sourceMonth,
  )).filter((budget) => !currency || budget.currency === currency);
  const destination = await db.getAllAsync<Pick<Budget, 'category_id' | 'deleted_at' | 'ownership' | 'currency'>>(
    'SELECT category_id, deleted_at, ownership, currency FROM budgets WHERE month_key = ?;',
    targetMonth,
  );
  const categories = await db.getAllAsync<CategoryRow>(
    "SELECT id, name, type, is_archived, deleted_at FROM categories WHERE type = 'EXPENSE';",
  );
  const items = source.map<CopyPlanItem>((budget) => {
    const category = budget.category_id ? categories.find((row) => row.id === budget.category_id) : null;
    const unavailable = !!budget.category_id && (!category || category.deleted_at || category.is_archived || category.type !== 'EXPENSE');
    const conflict = destination.some((row) => (row.category_id ?? null) === (budget.category_id ?? null) && row.currency === budget.currency);
    return {
      categoryId: budget.category_id ?? null,
      currency: budget.currency,
      label: category?.name ?? (budget.category_id ? 'Unavailable category' : 'Total Spending Plan'),
      amountMinor: budget.amount_minor,
      status: unavailable ? 'archived' : conflict ? 'conflict' : 'copy',
    };
  });
  return {
    sourceMonth,
    targetMonth,
    items,
    copyCount: items.filter((item) => item.status === 'copy').length,
    conflictCount: items.filter((item) => item.status === 'conflict').length,
    archivedCount: items.filter((item) => item.status === 'archived').length,
  };
}

export async function previewCopyPreviousMonth(db: AppDb, targetMonth: string, currency?: string): Promise<CopyPlanPreview> {
  return readCopyPreview(db, targetMonth, currency);
}

async function insertUserBudget(db: AppDb, month: string, categoryId: string | null, amountMinor: number, currency: string): Promise<void> {
  validateAmount(amountMinor);
  const ts = nowIso();
  await db.runAsync(
    "INSERT INTO budgets (id, month_key, category_id, amount_minor, currency, created_at, updated_at, sync_status, ownership) VALUES (?, ?, ?, ?, ?, ?, ?, 'LOCAL', 'USER');",
    makeId('budget'), month, categoryId, amountMinor, currency, ts, ts,
  );
}

export async function copyPreviousMonthPlan(db: AppDb, targetMonth: string, currency?: string): Promise<CopyPlanPreview> {
  let result!: CopyPlanPreview;
  await db.withExclusiveTransactionAsync(async (txn) => {
    result = await readCopyPreview(txn, targetMonth, currency);
    for (const item of result.items.filter((row) => row.status === 'copy'))
      await insertUserBudget(txn, targetMonth, item.categoryId, item.amountMinor, item.currency);
  });
  return result;
}

export async function createCategoryBudget(
  db: AppDb,
  input: { month: string; categoryId: string; amountMinor: number; currency?: string },
): Promise<void> {
  validateAmount(input.amountMinor);
  shiftMonthKey(input.month, 0);
  await db.withExclusiveTransactionAsync(async (txn) => {
    const currency = input.currency ?? await mainCurrency(txn);
    const category = await txn.getFirstAsync<CategoryRow>(
      "SELECT id, name, type, is_archived, deleted_at FROM categories WHERE id = ? AND type = 'EXPENSE' AND is_archived = 0 AND deleted_at IS NULL;",
      input.categoryId,
    );
    if (!category) throw new Error('Choose an active expense category.');
    const existing = await txn.getFirstAsync(
      'SELECT id FROM budgets WHERE month_key = ? AND category_id = ? AND currency = ? AND deleted_at IS NULL;',
      input.month, input.categoryId, currency,
    );
    if (existing) throw new Error('This category already has a budget for this month.');
    await insertUserBudget(txn, input.month, input.categoryId, input.amountMinor, currency);
  });
}

export async function updateCategoryBudget(
  db: AppDb,
  input: { id: string; expectedUpdatedAt: string; amountMinor: number },
): Promise<void> {
  validateAmount(input.amountMinor);
  await db.withExclusiveTransactionAsync(async (txn) => {
    const budget = await txn.getFirstAsync<Budget>('SELECT * FROM budgets WHERE id = ? AND category_id IS NOT NULL AND deleted_at IS NULL;', input.id);
    if (!budget) throw new Error('Category budget is unavailable.');
    if (budget.updated_at !== input.expectedUpdatedAt) throw new Error('Category budget changed. Reopen it before editing.');
    await txn.runAsync(
      "UPDATE budgets SET amount_minor = ?, ownership = 'USER', updated_at = ?, sync_status = 'LOCAL' WHERE id = ?;",
      input.amountMinor, nowIso(), input.id,
    );
  });
}

export async function removeCategoryBudget(db: AppDb, id: string, expectedUpdatedAt: string): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    const budget = await txn.getFirstAsync<Budget>('SELECT * FROM budgets WHERE id = ? AND category_id IS NOT NULL AND deleted_at IS NULL;', id);
    if (!budget) throw new Error('Category budget is unavailable.');
    if (budget.updated_at !== expectedUpdatedAt) throw new Error('Category budget changed. Reopen it before removing.');
    const ts = nowIso();
    await txn.runAsync(
      "UPDATE budgets SET ownership = 'USER', deleted_at = ?, updated_at = ?, sync_status = 'LOCAL' WHERE id = ?;",
      ts, ts, id,
    );
  });
}

export type AutoCopyResult = 'disabled' | 'already-processed' | 'destination-not-empty' | 'no-source' | 'copied';

export async function autoCopyCurrentMonthOnce(db: AppDb, currentMonth: string): Promise<AutoCopyResult> {
  let result: AutoCopyResult = 'disabled';
  await db.withExclusiveTransactionAsync(async (txn) => {
    const enabled = await txn.getFirstAsync<{ value: string }>("SELECT value FROM app_settings WHERE key = 'budget_auto_copy_enabled';");
    if (enabled?.value !== 'true') return;
    const processed = await txn.getFirstAsync<{ value: string }>("SELECT value FROM app_settings WHERE key = 'budget_auto_copy_processed_month';");
    if (processed?.value === currentMonth) { result = 'already-processed'; return; }
    const destination = await txn.getFirstAsync('SELECT id FROM budgets WHERE month_key = ? LIMIT 1;', currentMonth);
    if (destination) result = 'destination-not-empty';
    else {
      const preview = await readCopyPreview(txn, currentMonth);
      if (!preview.copyCount) result = 'no-source';
      else {
        for (const item of preview.items.filter((row) => row.status === 'copy'))
          await insertUserBudget(txn, currentMonth, item.categoryId, item.amountMinor, item.currency);
        result = 'copied';
      }
    }
    await txn.runAsync(
      "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('budget_auto_copy_processed_month', ?);",
      currentMonth,
    );
  });
  return result;
}

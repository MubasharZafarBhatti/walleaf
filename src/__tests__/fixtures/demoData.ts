// Sample data used only by tests (moved out of the app on 18 Nov 2026).
import type { AppDb } from '../../database/database';
import { nowIso } from '../../database/database';
import { addDays, addMonthsNoDrift, monthKey, todayLocal } from '../../utils/date';
import {
  buildSharedExpensePostingPlan,
  persistSharedExpensePostingPlan,
  type SharedExpensePostingInput,
} from '../../services/sharedExpense/SharedExpenseService';
import { splitByPercentage, splitByShares, splitEvenly } from '../../services/split/SplitService';
import {
  validateDemoGroupRows,
  type DemoGroupValidationGroup,
  type DemoGroupValidationMember,
  type DemoGroupValidationParticipant,
  type DemoGroupValidationSplit,
} from './demoValidation';

type CategoryRow = { id: string };
type ExistingRow = { id: string };


const demoPrefix = 'demo_*';
const demoTables = ['accounts', 'categories', 'transactions', 'budgets', 'people', 'person_entries', 'split_groups', 'split_participants', 'subscriptions', 'goals', 'goal_entries', 'groups', 'group_members', 'planned_payments', 'planned_payment_occurrences', 'subscription_payments'] as const;
type DemoTable = typeof demoTables[number];
type DemoRow = { id: string; [column: string]: unknown };

function isDemoOwned(table: DemoTable, row: DemoRow): boolean {
  if ((table === 'groups' || table === 'subscriptions') && row.user_managed === 1) return false;
  return table === 'budgets' ? row.ownership === 'DEMO' : row.id.startsWith('demo_');
}

function minor(amount: number): number {
  return amount * 100;
}

async function clearDemoDataInTransaction(db: AppDb): Promise<Set<string>> {
  const rows = new Map<string, { table: DemoTable; row: DemoRow }>();
  const edges = new Map<string, Set<string>>();
  const events = new Map<string, string[]>();
  const key = (table: string, id: unknown) => `${table}:${id}`;
  const link = (from: string, to: string) => {
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from)!.add(to);
  };
  for (const table of demoTables) {
    for (const row of await db.getAllAsync<DemoRow>(`SELECT * FROM ${table};`)) {
      const child = key(table, row.id);
      rows.set(child, { table, row });
      if (table === 'split_groups' && typeof row.split_definition === 'string') {
        const definition = JSON.parse(row.split_definition) as { version: number; payers?: { identity: string }[] };
        if (definition.version === 2) for (const payer of definition.payers ?? []) if (payer.identity.startsWith('PERSON:')) link(child, key('people', payer.identity.slice(7)));
      }
      for (const [column, parents] of Object.entries({
        account_id: ['accounts'], destination_account_id: ['accounts'], linked_account_id: ['accounts'],
        category_id: ['categories'], person_id: ['people'], payer_person_id: ['people'],
        group_id: ['groups', 'split_groups'], split_group_id: ['split_groups'], goal_id: ['goals'],
        planned_payment_id: ['planned_payments'], transaction_id: ['transactions'], subscription_id: ['subscriptions'],
      })) {
        if (row[column] == null) continue;
        for (const parent of parents) {
          const parentKey = key(parent, row[column]);
          link(child, parentKey);
          // Retain complete scenarios, not partial accounting or edited membership lists.
          if (['groups', 'split_groups', 'goals'].includes(parent)) link(parentKey, child);
        }
      }
      if (typeof row.financial_event_id === 'string') {
        const siblings = events.get(row.financial_event_id) ?? [];
        siblings.push(child);
        events.set(row.financial_event_id, siblings);
      }
    }
  }
  for (const siblings of events.values()) {
    for (const sibling of siblings) {
      link(siblings[0], sibling);
      link(sibling, siblings[0]);
    }
  }
  // Retaining a user's group must also retain historical cash that still needs
  // explicit review. Deleting those candidates would silently erase ambiguity.
  // This is a retention edge only, never an inferred allocation.
  for (const pair of await db.getAllAsync<{ target_id: string; source_id: string }>('SELECT target.id target_id, source.id source_id FROM allocation_targets target JOIN allocation_sources source ON source.person_id = target.person_id AND source.cash_direction = target.direction WHERE source.split_group_id IS NULL AND target.remaining_minor > 0 AND source.available_minor > 0;')) {
    link(key('person_entries', pair.target_id), key('person_entries', pair.source_id));
  }
  // Include soft-deleted real rows: they can still be restored by the user.
  const pending = [...rows].filter(([, { table, row }]) => !isDemoOwned(table, row)).map(([id]) => id);
  // Reconciliation is user metadata even when both original entries came from a demo.
  for (const row of await db.getAllAsync<{ source_entry_id: string; target_entry_id: string }>('SELECT source_entry_id, target_entry_id FROM entry_allocations UNION SELECT source_entry_id, target_entry_id FROM allocation_exclusions;')) {
    pending.push(key('person_entries', row.source_entry_id), key('person_entries', row.target_entry_id));
  }
  for (const row of await db.getAllAsync<{ group_id: string; source_entry_id: string }>('SELECT group_id, source_entry_id FROM group_settlement_requests;')) pending.push(key('groups', row.group_id), key('person_entries', row.source_entry_id));
  const retained = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (retained.has(id)) continue;
    retained.add(id);
    pending.push(...(edges.get(id) ?? []));
  }
  for (const table of ['subscription_payments', 'planned_payment_occurrences', 'split_participants', 'person_entries', 'transactions', 'group_members', 'goal_entries', 'split_groups', 'groups', 'goals', 'planned_payments', 'subscriptions', 'budgets', 'people', 'categories', 'accounts']) {
    for (const [id, item] of rows) {
      if (item.table === table && isDemoOwned(item.table, item.row) && !retained.has(id))
        await db.runAsync(`DELETE FROM ${table} WHERE id = ?;`, item.row.id);
    }
  }
  return retained;
}

export async function validateComprehensiveDemoData(db: AppDb): Promise<string[]> {
  const [groups, members, splitGroups, participants] = await Promise.all([
    db.getAllAsync<DemoGroupValidationGroup>(
      "SELECT id, name, user_managed FROM groups WHERE id GLOB 'demo_group_*' AND deleted_at IS NULL;",
    ),
    db.getAllAsync<DemoGroupValidationMember>(
      "SELECT group_id, person_id, is_self FROM group_members WHERE group_id GLOB 'demo_group_*';",
    ),
    db.getAllAsync<DemoGroupValidationSplit>(
      "SELECT id, title, total_amount_minor, group_id, payer_person_id, payer_is_self FROM split_groups WHERE group_id GLOB 'demo_group_*' AND deleted_at IS NULL;",
    ),
    db.getAllAsync<DemoGroupValidationParticipant>(
      "SELECT id, split_group_id, person_id, is_self, share_minor FROM split_participants WHERE split_group_id IN (SELECT id FROM split_groups WHERE group_id GLOB 'demo_group_*' AND deleted_at IS NULL);",
    ),
  ]);
  const errors = validateDemoGroupRows({ groups, members, splitGroups, participants });
  const scalarChecks: readonly [string, string, readonly (string | number)[]][] = [
    ['demo rows have unique IDs per table', `SELECT 'duplicate ID' AS issue FROM (SELECT id FROM transactions WHERE id GLOB 'demo_*' GROUP BY id HAVING count(*) > 1 UNION ALL SELECT id FROM person_entries WHERE id GLOB 'demo_*' GROUP BY id HAVING count(*) > 1 UNION ALL SELECT id FROM split_groups WHERE id GLOB 'demo_*' GROUP BY id HAVING count(*) > 1)`, []],
    ['all demo financial dates are valid', `SELECT 'invalid date' AS issue FROM (SELECT occurred_on AS value FROM transactions WHERE id GLOB 'demo_*' UNION ALL SELECT occurred_on FROM person_entries WHERE id GLOB 'demo_*' UNION ALL SELECT occurred_on FROM goal_entries WHERE id GLOB 'demo_*' UNION ALL SELECT next_due_date FROM planned_payments WHERE id GLOB 'demo_*' UNION ALL SELECT next_renewal_date FROM subscriptions WHERE id GLOB 'demo_*') WHERE value NOT GLOB '????-??-??' OR date(value) IS NULL`, []],
    ['demo records have valid account/category/person references', `SELECT 'invalid reference' AS issue FROM (SELECT t.id FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN categories c ON c.id = t.category_id WHERE t.id GLOB 'demo_*' AND (a.id IS NULL OR (t.category_id IS NOT NULL AND c.id IS NULL)) UNION ALL SELECT e.id FROM person_entries e LEFT JOIN accounts a ON a.id = e.account_id LEFT JOIN people p ON p.id = e.person_id WHERE e.id GLOB 'demo_*' AND (a.id IS NULL OR p.id IS NULL) UNION ALL SELECT p.id FROM planned_payments p LEFT JOIN accounts a ON a.id = p.account_id LEFT JOIN categories c ON c.id = p.category_id WHERE p.id GLOB 'demo_*' AND (a.id IS NULL OR c.id IS NULL) UNION ALL SELECT s.id FROM subscriptions s LEFT JOIN accounts a ON a.id = s.account_id LEFT JOIN categories c ON c.id = s.category_id WHERE s.id GLOB 'demo_*' AND (a.id IS NULL OR c.id IS NULL))`, []],
    ['demo transactions use real classifications', `SELECT 'invalid transaction classification' AS issue FROM transactions WHERE id GLOB 'demo_*' AND type NOT IN ('EXPENSE', 'INCOME')`, []],
    ['demo schedules have valid recurrence metadata', `SELECT 'invalid planned recurrence' AS issue FROM planned_payments WHERE id GLOB 'demo_*' AND (recurrence_type NOT IN ('NONE', 'WEEKLY', 'MONTHLY', 'YEARLY', 'EVERY_N_MONTHS') OR recurrence_interval < 1) UNION ALL SELECT 'invalid subscription recurrence' FROM subscriptions WHERE id GLOB 'demo_*' AND (frequency_type NOT IN ('WEEKLY', 'MONTHLY', 'YEARLY', 'EVERY_N_MONTHS') OR frequency_interval < 1)`, []],
    ['demo occurrence links are valid', `SELECT 'invalid planned occurrence' AS issue FROM planned_payment_occurrences o LEFT JOIN planned_payments p ON p.id = o.planned_payment_id LEFT JOIN transactions t ON t.id = o.transaction_id WHERE o.id GLOB 'demo_*' AND (p.id IS NULL OR (o.outcome = 'RECORDED' AND (t.id IS NULL OR t.source != 'PLANNED'))) UNION ALL SELECT 'invalid subscription payment' FROM subscription_payments p LEFT JOIN subscriptions s ON s.id = p.subscription_id LEFT JOIN transactions t ON t.id = p.transaction_id WHERE p.id GLOB 'demo_*' AND (s.id IS NULL OR t.id IS NULL OR t.source != 'SUBSCRIPTION' OR t.type != 'EXPENSE')`, []],
  ];
  for (const [, sql, params] of scalarChecks) {
    const rows = await db.getAllAsync<{ issue: string }>(sql, ...params);
    errors.push(...rows.map((row) => row.issue));
  }
  return errors;
}

async function assertComprehensiveDemoData(db: AppDb): Promise<void> {
  const errors = await validateComprehensiveDemoData(db);
  if (errors.length) throw new Error(`Invalid comprehensive demo data: ${errors.join('; ')}`);
}

async function categoryId(
  db: AppDb,
  name: string,
  type: 'EXPENSE' | 'INCOME',
): Promise<string> {
  const row = await db.getFirstAsync<CategoryRow>(
    'SELECT id FROM categories WHERE lower(name) = lower(?) AND type = ? AND deleted_at IS NULL LIMIT 1;',
    name,
    type,
  );
  if (!row) throw new Error(`Missing category ${name}`);
  return row.id;
}

async function ensureDemoCategory(
  db: AppDb,
  id: string,
  name: string,
): Promise<string> {
  if (await db.getFirstAsync<ExistingRow>('SELECT id FROM categories WHERE id = ?;', id)) return id;
  const existing = await db.getFirstAsync<CategoryRow>(
    'SELECT id FROM categories WHERE lower(name) = lower(?) AND type = ? AND deleted_at IS NULL LIMIT 1;',
    name,
    'EXPENSE',
  );
  if (existing) return existing.id;
  const ts = nowIso();
  await db.runAsync(
    'INSERT INTO categories (id, name, type, icon, color_key, is_default, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);',
    id,
    name,
    'EXPENSE',
    'pricetag-outline',
    'primary',
    0,
    ts,
    ts,
    'LOCAL',
  );
  return id;
}

async function ensurePerson(db: AppDb, id: string, name: string): Promise<string> {
  if (await db.getFirstAsync<ExistingRow>('SELECT id FROM people WHERE id = ?;', id)) return id;
  const existing = await db.getFirstAsync<ExistingRow>(
    'SELECT id FROM people WHERE lower(name) = lower(?) AND deleted_at IS NULL LIMIT 1;',
    name,
  );
  if (existing) return existing.id;
  const ts = nowIso();
  await db.runAsync(
    'INSERT INTO people (id, name, note, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?, ?);',
    id,
    name,
    'Created by development demo loader',
    ts,
    ts,
    'LOCAL',
  );
  return id;
}

async function insertTransaction(
  db: AppDb,
  id: string,
  type: 'EXPENSE' | 'INCOME',
  amount: number,
  accountId: string,
  categoryIdValue: string | null,
  title: string,
  occurredOn: string,
  destinationAccountId: string | null = null,
  source = 'MANUAL',
  groupId: string | null = null,
  eventId: string | null = null,
): Promise<void> {
  const ts = nowIso();
  await db.runAsync(
    'INSERT INTO transactions (id, type, amount_minor, account_id, destination_account_id, category_id, title, note, occurred_on, source, group_id, financial_event_id, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);',
    id,
    type,
    amount,
    accountId,
    destinationAccountId,
    categoryIdValue,
    title,
    'Development demo data',
    occurredOn,
    source,
    groupId,
    eventId,
    ts,
    ts,
    'LOCAL',
  );
}

async function insertPersonEntry(
  db: AppDb,
  id: string,
  personId: string,
  type: string,
  amount: number,
  accountId: string,
  title: string,
  occurredOn: string,
  splitGroupId: string | null = null,
  eventId: string | null = null,
): Promise<void> {
  const ts = nowIso();
  await db.runAsync(
    'INSERT INTO person_entries (id, person_id, type, amount_minor, account_id, title, note, occurred_on, split_group_id, financial_event_id, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);',
    id,
    personId,
    type,
    amount,
    accountId,
    title,
    'Development demo data',
    occurredOn,
    splitGroupId,
    eventId,
    ts,
    ts,
    'LOCAL',
  );
}

async function insertDemoSharedExpense(
  db: AppDb,
  input: SharedExpensePostingInput,
): Promise<void> {
  await persistSharedExpensePostingPlan(db, buildSharedExpensePostingPlan(input));
}

export async function countDemoRecords(db: AppDb): Promise<number> {
  // Includes legacy parents retained for real references, not just removable rows.
  let count = 0;
  for (const table of demoTables) {
    const row = await db.getFirstAsync<{ total: number }>(
      `SELECT COUNT(*) as total FROM ${table} WHERE ${table === 'budgets' ? 'ownership = ?' : 'id GLOB ?'};`,
      table === 'budgets' ? 'DEMO' : demoPrefix,
    );
    count += row?.total ?? 0;
  }
  return count;
}

export async function clearDemoData(db: AppDb): Promise<number> {
  let removed = 0;
  await db.withTransactionAsync(async () => {
    const before = await countDemoRecords(db);
    await clearDemoDataInTransaction(db);
    removed = before - await countDemoRecords(db);
  });
  return removed;
}

export async function loadComprehensiveDemoData(db: AppDb): Promise<void> {
  const today = todayLocal();
  const currentMonth = monthKey(today);
  const previousMonth = monthKey(addMonthsNoDrift(`${currentMonth}-01`, -1));
  const ts = nowIso();

  await db.withTransactionAsync(async () => {
    const cash = await db.getFirstAsync<ExistingRow>(
      "SELECT id FROM accounts WHERE id = 'account_cash_default' AND type = 'CASH' AND deleted_at IS NULL;",
    );
    if (!cash) throw new Error('The default Cash account is required to load demo data.');
    const retained = await clearDemoDataInTransaction(db);
    const originalDb = db;
    // Only the loader's inserts are intercepted; retained rows are never replaced.
    db = new Proxy(originalDb, {
      get(target, property) {
        if (property === 'runAsync') return async (sql: string, ...params: (string | number | null)[]) => {
          if (sql.startsWith('UPDATE split_groups SET split_definition') && retained.has(`split_groups:${params[params.length - 1]}`)) return { changes: 0, lastInsertRowId: 0 };
          const insert = /^INSERT INTO (\w+) \(([^)]+)\)/.exec(sql);
          if (insert) {
            const columns = insert[2].split(',').map(column => column.trim());
            const table = insert[1];
            const id = params[columns.indexOf('id')];
            const protectedParent = ['group_id', 'split_group_id', 'goal_id'].some(column => {
              const value = params[columns.indexOf(column)];
              return value != null && ['groups', 'split_groups', 'goals'].some(parent => retained.has(`${parent}:${value}`));
            });
            if (retained.has(`${table}:${id}`) || protectedParent) {
              // Propagate skipped parents to subsequent SharedExpenseService child inserts.
              retained.add(`${table}:${id}`);
              return { changes: 0, lastInsertRowId: 0 };
            }
          }
          return originalDb.runAsync(sql, ...params);
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await ensureDemoCategory(db, 'demo_cat_pet_care', 'Pet Care');
    await ensureDemoCategory(db, 'demo_cat_gaming', 'Gaming');
    const carMaintenance = await ensureDemoCategory(
      db,
      'demo_cat_car_maintenance',
      'Car Maintenance',
    );
    await ensureDemoCategory(db, 'demo_cat_donations', 'Donations');
    const archivedDining = await ensureDemoCategory(db, 'demo_cat_archived_dining', 'Archived Dining');
    // A same-named real category is reusable for normal demo references, but must
    // never be archived merely to create a demo history example.
    if (archivedDining === 'demo_cat_archived_dining')
      await db.runAsync('UPDATE categories SET is_archived = 1 WHERE id = ?;', archivedDining);

    const food = await categoryId(db, 'Food', 'EXPENSE');
    const fuel = await categoryId(db, 'Fuel', 'EXPENSE');
    const education = await categoryId(db, 'Education', 'EXPENSE');
    const shopping = await categoryId(db, 'Shopping', 'EXPENSE');
    const bills = await categoryId(db, 'Bills', 'EXPENSE');
    const health = await categoryId(db, 'Health', 'EXPENSE');
    const entertainment = await categoryId(db, 'Entertainment', 'EXPENSE');
    const gifts = await categoryId(db, 'Gifts', 'EXPENSE');
    const salary = await categoryId(db, 'Salary', 'INCOME');
    const freelance = await categoryId(db, 'Freelance', 'INCOME');
    const refund = await categoryId(db, 'Refund', 'INCOME');

    const expenseRows = [
      ['demo_tx_food_001', minor(2600), 'account_cash_default', food, 'Dinner at Cheezious', today],
      ['demo_tx_fuel_001', minor(5000), 'account_cash_default', fuel, 'Fuel at Shell', addDays(today, -1)],
      ['demo_tx_education_001', minor(4200), 'account_cash_default', education, 'University Books', addDays(today, -3)],
      ['demo_tx_shopping_001', minor(11000), 'account_cash_default', shopping, 'Daraz Order', `${currentMonth}-05`],
      ['demo_tx_bills_001', minor(7600), 'account_cash_default', bills, 'Electricity Bill', `${currentMonth}-08`],
      ['demo_tx_health_001', minor(1800), 'account_cash_default', health, 'Medicine', `${currentMonth}-09`],
      ['demo_tx_entertainment_001', minor(3500), 'account_cash_default', entertainment, 'Movie', `${currentMonth}-10`],
      ['demo_tx_gift_001', minor(2500), 'account_cash_default', gifts, 'Gift', `${currentMonth}-11`],
      ['demo_tx_prev_food_001', minor(9000), 'account_cash_default', food, 'Previous Cheezious Dinner', `${previousMonth}-05`],
      ['demo_tx_prev_fuel_001', minor(6500), 'account_cash_default', fuel, 'Previous Shell Fuel', `${previousMonth}-12`],
       ['demo_tx_prev_bills_001', minor(8200), 'account_cash_default', bills, 'Previous Electricity Bill', `${previousMonth}-17`],
       ['demo_tx_archived_dining_001', minor(2200), 'account_cash_default', archivedDining, 'Archived restaurant receipt', addDays(today, -20)],
    ] as const;
    for (const row of expenseRows)
      await insertTransaction(db, row[0], 'EXPENSE', row[1], row[2], row[3], row[4], row[5]);

    await insertTransaction(db, 'demo_tx_salary_001', 'INCOME', minor(120000), 'account_cash_default', salary, 'Salary', `${currentMonth}-01`);
    await insertTransaction(db, 'demo_tx_freelance_001', 'INCOME', minor(28000), 'account_cash_default', freelance, 'Freelance Payment', addDays(today, -2));
    await insertTransaction(db, 'demo_tx_refund_001', 'INCOME', minor(2500), 'account_cash_default', refund, 'Refund', `${currentMonth}-06`);
    await insertTransaction(db, 'demo_tx_prev_salary_001', 'INCOME', minor(110000), 'account_cash_default', salary, 'Previous Salary', `${previousMonth}-01`);

    const people = {
      ali: await ensurePerson(db, 'demo_person_ali', 'Ali'),
      hamza: await ensurePerson(db, 'demo_person_hamza', 'Hamza'),
      ammar: await ensurePerson(db, 'demo_person_ammar', 'Ammar'),
      awais: await ensurePerson(db, 'demo_person_awais', 'Awais'),
      atif: await ensurePerson(db, 'demo_person_atif', 'Atif'),
      shahbaz: await ensurePerson(db, 'demo_person_shahbaz', 'Shahbaz'),
      muazzam: await ensurePerson(db, 'demo_person_muazzam', 'Muazzam'),
      mehroz: await ensurePerson(db, 'demo_person_mehroz', 'Mehroz'),
    };
    await insertPersonEntry(db, 'demo_entry_ali_001', people.ali, 'GIVEN', minor(5000), 'account_cash_default', 'University books', addDays(today, -7));
    await insertPersonEntry(db, 'demo_entry_ali_002', people.ali, 'RECEIVED_BACK', minor(2000), 'account_cash_default', 'Fuel contribution', addDays(today, -2));
    await insertPersonEntry(db, 'demo_entry_hamza_001', people.hamza, 'BORROWED_FROM', minor(8000), 'account_cash_default', 'Short-term cash', addDays(today, -9));
    await insertPersonEntry(db, 'demo_entry_hamza_002', people.hamza, 'PAID_BACK', minor(3000), 'account_cash_default', 'Partial repayment', addDays(today, -1));
    await insertPersonEntry(db, 'demo_entry_ammar_001', people.ammar, 'GIVEN', minor(2000), 'account_cash_default', 'Lunch advance', addDays(today, -6));
    await insertPersonEntry(db, 'demo_entry_ammar_002', people.ammar, 'RECEIVED_BACK', minor(2000), 'account_cash_default', 'Lunch returned', addDays(today, -5));

    const realTotalBudget = await db.getFirstAsync<ExistingRow>(
      "SELECT id FROM budgets WHERE month_key = ? AND category_id IS NULL AND deleted_at IS NULL AND ownership = 'USER' LIMIT 1;",
      currentMonth,
    );
    if (!realTotalBudget)
      await db.runAsync(
        "INSERT INTO budgets (id, month_key, category_id, amount_minor, created_at, updated_at, sync_status, ownership) VALUES (?, ?, ?, ?, ?, ?, ?, 'DEMO');",
        'demo_budget_total_current',
        currentMonth,
        null,
        minor(50000),
        ts,
        ts,
        'LOCAL',
      );
    for (const [id, catId, amount] of [
      ['demo_budget_food', food, minor(9000)],
      ['demo_budget_fuel', fuel, minor(8000)],
      ['demo_budget_shopping', shopping, minor(12000)],
      ['demo_budget_entertainment', entertainment, minor(3000)],
    ] as const) {
      const existing = await db.getFirstAsync<ExistingRow>(
        'SELECT id FROM budgets WHERE month_key = ? AND category_id = ? AND deleted_at IS NULL LIMIT 1;',
        currentMonth,
        catId,
      );
      if (!existing)
        await db.runAsync(
          "INSERT INTO budgets (id, month_key, category_id, amount_minor, created_at, updated_at, sync_status, ownership) VALUES (?, ?, ?, ?, ?, ?, ?, 'DEMO');",
          id,
          currentMonth,
          catId,
          amount,
          ts,
          ts,
          'LOCAL',
        );
    }

    for (const [id, name, target, saved, targetDate] of [
      ['demo_goal_laptop', 'Laptop', minor(150000), minor(60000), addMonthsNoDrift(today, 6)],
      ['demo_goal_emergency', 'Emergency Fund', minor(100000), minor(70000), null],
      ['demo_goal_trip', 'Trip', minor(80000), minor(20000), addMonthsNoDrift(today, 3)],
    ] as const) {
      await db.runAsync(
        'INSERT INTO goals (id, name, target_amount_minor, initial_saved_minor, target_date, linked_account_id, note, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);',
        id,
        name,
        target,
        saved,
        targetDate,
        'account_cash_default',
        'Development demo goal',
        ts,
        ts,
        'LOCAL',
      );
    }
    await db.runAsync('INSERT INTO goal_entries (id, goal_id, type, amount_minor, occurred_on, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?);', 'demo_goal_entry_laptop_001', 'demo_goal_laptop', 'ADD', minor(10000), addDays(today, -15), 'Added money', ts, ts);
    await db.runAsync('INSERT INTO goal_entries (id, goal_id, type, amount_minor, occurred_on, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?);', 'demo_goal_entry_trip_001', 'demo_goal_trip', 'WITHDRAW', minor(3000), addDays(today, -8), 'Withdrawn money', ts, ts);

    for (const [id, name, description] of [
      ['demo_group_murree_trip', 'Murree Trip', 'Shared travel expenses'],
      ['demo_group_university', 'University Friends', 'Mostly settled expenses'],
    ] as const) {
      await db.runAsync('INSERT INTO groups (id, name, description, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?, ?);', id, name, description, ts, ts, 'LOCAL');
      await db.runAsync('INSERT INTO group_members (id, group_id, person_id, is_self, created_at) VALUES (?, ?, ?, ?, ?);', `${id}_self`, id, null, 1, ts);
    }
    for (const [suffix, groupId, personId] of [
      ['ali', 'demo_group_murree_trip', people.ali],
      ['awais', 'demo_group_murree_trip', people.awais],
      ['atif', 'demo_group_murree_trip', people.atif],
      ['shahbaz', 'demo_group_murree_trip', people.shahbaz],
      ['muazzam', 'demo_group_university', people.muazzam],
      ['mehroz', 'demo_group_university', people.mehroz],
      ['ammar_uni', 'demo_group_university', people.ammar],
    ] as const) {
      await db.runAsync('INSERT INTO group_members (id, group_id, person_id, is_self, created_at) VALUES (?, ?, ?, ?, ?);', `demo_group_member_${suffix}`, groupId, personId, 0, ts);
    }

    const murreeHotelDate = addDays(today, -10);
    await insertDemoSharedExpense(db, {
      splitGroupId: 'demo_split_murree_hotel',
      financialEventId: 'demo_event_murree_hotel',
      title: 'Murree Hotel',
      totalAmountMinor: minor(25000),
      categoryId: bills,
      accountId: 'account_cash_default',
      occurredOn: murreeHotelDate,
      groupId: 'demo_group_murree_trip',
      payerPersonId: null,
      payerName: 'You',
      payerIsSelf: true,
      personalTransactionId: 'demo_tx_split_murree_hotel_own',
      personEntryIds: {
        [people.ali]: 'demo_entry_split_murree_hotel_ali',
        [people.awais]: 'demo_entry_split_murree_hotel_awais',
        [people.atif]: 'demo_entry_split_murree_hotel_atif',
        [people.shahbaz]: 'demo_entry_split_murree_hotel_shahbaz',
      },
      shares: splitEvenly(minor(25000), [
        { name: 'You', isSelf: true },
        { name: 'Ali', personId: people.ali },
        { name: 'Awais', personId: people.awais },
        { name: 'Atif', personId: people.atif },
        { name: 'Shahbaz', personId: people.shahbaz },
      ]),
    });

    await insertDemoSharedExpense(db, {
      splitGroupId: 'demo_split_standalone_weekend',
      financialEventId: 'demo_event_standalone_weekend',
      title: 'Weekend Board Games',
      totalAmountMinor: minor(10000),
      categoryId: entertainment,
      accountId: 'account_cash_default',
      occurredOn: addDays(today, -4),
      groupId: null,
      payerPersonId: null,
      payerName: 'You',
      payerIsSelf: true,
      personalTransactionId: 'demo_tx_split_standalone_weekend_own',
      personEntryIds: {
        [people.ali]: 'demo_entry_split_standalone_ali',
        [people.awais]: 'demo_entry_split_standalone_awais',
        [people.atif]: 'demo_entry_split_standalone_atif',
        [people.shahbaz]: 'demo_entry_split_standalone_shahbaz',
        [people.muazzam]: 'demo_entry_split_standalone_muazzam',
        [people.mehroz]: 'demo_entry_split_standalone_mehroz',
      },
      shares: splitEvenly(minor(10000), [
        { name: 'You', isSelf: true },
        { name: 'Ali', personId: people.ali },
        { name: 'Awais', personId: people.awais },
        { name: 'Atif', personId: people.atif },
        { name: 'Shahbaz', personId: people.shahbaz },
        { name: 'Muazzam', personId: people.muazzam },
        { name: 'Mehroz', personId: people.mehroz },
      ]),
    });

    const murreeDinnerDate = addDays(today, -9);
    await insertDemoSharedExpense(db, {
      splitGroupId: 'demo_split_murree_dinner',
      financialEventId: 'demo_event_murree_dinner',
      title: 'Murree Dinner',
      totalAmountMinor: minor(12000),
      categoryId: food,
      accountId: 'account_cash_default',
      occurredOn: murreeDinnerDate,
      groupId: 'demo_group_murree_trip',
      payerPersonId: people.awais,
      payerName: 'Awais',
      payerIsSelf: false,
      personalTransactionId: 'demo_tx_split_murree_dinner_own',
      personEntryIds: { [people.awais]: 'demo_entry_split_murree_dinner_awais' },
      shares: splitEvenly(minor(12000), [
        { name: 'You', isSelf: true },
        { name: 'Ali', personId: people.ali },
        { name: 'Awais', personId: people.awais },
        { name: 'Atif', personId: people.atif },
        { name: 'Shahbaz', personId: people.shahbaz },
      ]),
    });

    const murreeFuelDate = addDays(today, -8);
    await insertDemoSharedExpense(db, {
      splitGroupId: 'demo_split_murree_fuel',
      financialEventId: 'demo_event_murree_fuel',
      title: 'Murree Fuel',
      totalAmountMinor: minor(9000),
      categoryId: fuel,
      accountId: 'account_cash_default',
      occurredOn: murreeFuelDate,
      groupId: 'demo_group_murree_trip',
      payerPersonId: people.atif,
      payerName: 'Atif',
      payerIsSelf: false,
      personalTransactionId: 'demo_tx_split_murree_fuel_own',
      personEntryIds: { [people.atif]: 'demo_entry_split_murree_fuel_atif' },
      shares: splitByShares(minor(9000), [
        { name: 'You', isSelf: true, shares: 1 },
        { name: 'Atif', personId: people.atif, shares: 2 },
        { name: 'Shahbaz', personId: people.shahbaz, shares: 1 },
      ]),
    });

    const murreeSnacksDate = addDays(today, -7);
    await insertDemoSharedExpense(db, {
      splitGroupId: 'demo_split_murree_snacks',
      financialEventId: 'demo_event_murree_snacks',
      title: 'Tea & Snacks',
      totalAmountMinor: minor(3000),
      categoryId: food,
      accountId: 'account_cash_default',
      occurredOn: murreeSnacksDate,
      groupId: 'demo_group_murree_trip',
      payerPersonId: null,
      payerName: 'You',
      payerIsSelf: true,
      personalTransactionId: 'demo_tx_split_murree_snacks_own',
      personEntryIds: {
        [people.ali]: 'demo_entry_split_murree_snacks_ali',
        [people.shahbaz]: 'demo_entry_split_murree_snacks_shahbaz',
      },
      shares: splitEvenly(minor(3000), [
        { name: 'You', isSelf: true },
        { name: 'Ali', personId: people.ali },
        { name: 'Shahbaz', personId: people.shahbaz },
      ]),
    });

    const uniBooksDate = addDays(today, -5);
    await insertDemoSharedExpense(db, {
      splitGroupId: 'demo_split_uni_books',
      financialEventId: 'demo_event_uni_books',
      title: 'Printing and Books',
      totalAmountMinor: minor(4800),
      categoryId: education,
      accountId: 'account_cash_default',
      occurredOn: uniBooksDate,
      groupId: 'demo_group_university',
      payerPersonId: null,
      payerName: 'You',
      payerIsSelf: true,
      personalTransactionId: 'demo_tx_split_uni_books_own',
      personEntryIds: {
        [people.muazzam]: 'demo_entry_split_uni_books_muazzam',
        [people.mehroz]: 'demo_entry_split_uni_books_mehroz',
        [people.ammar]: 'demo_entry_split_uni_books_ammar',
      },
      shares: splitEvenly(minor(4800), [
        { name: 'You', isSelf: true },
        { name: 'Muazzam', personId: people.muazzam },
        { name: 'Mehroz', personId: people.mehroz },
        { name: 'Ammar', personId: people.ammar },
      ]),
    });

    const uniLunchDate = addDays(today, -3);
    await insertDemoSharedExpense(db, {
      splitGroupId: 'demo_split_uni_lunch',
      financialEventId: 'demo_event_uni_lunch',
      title: 'University Lunch',
      totalAmountMinor: minor(6000),
      categoryId: food,
      accountId: 'account_cash_default',
      occurredOn: uniLunchDate,
      groupId: 'demo_group_university',
      payerPersonId: people.mehroz,
      payerName: 'Mehroz',
      payerIsSelf: false,
      personalTransactionId: 'demo_tx_split_uni_lunch_own',
      personEntryIds: { [people.mehroz]: 'demo_entry_split_uni_lunch_mehroz' },
      shares: splitByPercentage(minor(6000), [
        { name: 'You', isSelf: true, percentage: 25 },
        { name: 'Muazzam', personId: people.muazzam, percentage: 25 },
        { name: 'Mehroz', personId: people.mehroz, percentage: 25 },
        { name: 'Ammar', personId: people.ammar, percentage: 25 },
      ]),
    });

    for (const [id, name, type, amount, category, account, due, recurrence] of [
      ['demo_planned_internet', 'Internet Bill', 'EXPENSE', minor(3500), bills, 'account_cash_default', today, 'MONTHLY'],
      ['demo_planned_rent', 'Rent', 'EXPENSE', minor(25000), bills, 'account_cash_default', addMonthsNoDrift(today, 1), 'MONTHLY'],
      ['demo_planned_university', 'University Fee', 'EXPENSE', minor(15000), education, 'account_cash_default', addDays(today, 7), 'NONE'],
      ['demo_planned_salary', 'Salary', 'INCOME', minor(120000), salary, 'account_cash_default', addDays(today, 10), 'MONTHLY'],
      ['demo_planned_car', 'Car Maintenance', 'EXPENSE', minor(12000), carMaintenance, 'account_cash_default', addDays(today, 21), 'NONE'],
    ] as const) {
      await db.runAsync('INSERT INTO planned_payments (id, name, type, amount_minor, category_id, account_id, next_due_date, recurrence_type, recurrence_interval, reminder_enabled, reminder_days_before, subscription_metadata, status, note, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);', id, name, type, amount, category, account, due, recurrence, 1, 1, 3, null, 'ACTIVE', 'Development demo planned payment', ts, ts, 'LOCAL');
    }

    for (const [id, name, amount, frequency, interval, renewal, cancelReminder] of [
      ['demo_sub_netflix', 'Netflix', minor(1500), 'MONTHLY', 1, addDays(today, 4), null],
      ['demo_sub_gym', 'Gym Membership', minor(4000), 'MONTHLY', 1, addDays(today, 12), null],
      ['demo_sub_internet', 'Internet Package', minor(9000), 'EVERY_N_MONTHS', 3, addMonthsNoDrift(today, 1), null],
      ['demo_sub_software', 'Annual Software', minor(18000), 'YEARLY', 1, addMonthsNoDrift(today, 3), null],
      ['demo_sub_trial', 'Trial Service', minor(2500), 'MONTHLY', 1, addDays(today, 6), addDays(today, 4)],
    ] as const) {
      await db.runAsync('INSERT INTO subscriptions (id, name, amount_minor, category_id, account_id, frequency_type, frequency_interval, start_date, next_renewal_date, end_date, total_cycles, completed_cycles, reminder_enabled, reminder_days_before, cancellation_reminder_enabled, cancellation_reminder_date, status, note, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);', id, name, amount, entertainment, 'account_cash_default', frequency, interval, addMonthsNoDrift(today, -2), renewal, null, null, 0, 1, 3, cancelReminder ? 1 : 0, cancelReminder, 'ACTIVE', 'Development demo subscription', ts, ts, 'LOCAL');
    }

    const priorInternetDate = addMonthsNoDrift(today, -1);
    await insertTransaction(db, 'demo_tx_planned_internet_recorded_001', 'EXPENSE', minor(3500), 'account_cash_default', bills, 'Internet Bill', priorInternetDate, null, 'PLANNED', null, 'demo_planned_occurrence_internet_001');
    await db.runAsync("INSERT INTO planned_payment_occurrences (id, planned_payment_id, scheduled_date, outcome, transaction_id, created_at) VALUES (?, ?, ?, 'RECORDED', ?, ?);", 'demo_planned_occurrence_internet_001', 'demo_planned_internet', priorInternetDate, 'demo_tx_planned_internet_recorded_001', ts);
    await db.runAsync('UPDATE planned_payments SET completed_occurrences = 1 WHERE id = ?;', 'demo_planned_internet');

    const priorNetflixDate = addMonthsNoDrift(today, -1);
    await db.runAsync('UPDATE subscriptions SET next_renewal_date = ? WHERE id = ?;', priorNetflixDate, 'demo_sub_netflix');
    await insertTransaction(db, 'demo_tx_sub_netflix_paid_001', 'EXPENSE', minor(1500), 'account_cash_default', entertainment, 'Netflix', priorNetflixDate, null, 'SUBSCRIPTION', null, 'demo_sub_payment_netflix_001');
    await db.runAsync('INSERT INTO subscription_payments (id, subscription_id, scheduled_date, transaction_id, created_at) VALUES (?, ?, ?, ?, ?);', 'demo_sub_payment_netflix_001', 'demo_sub_netflix', priorNetflixDate, 'demo_tx_sub_netflix_paid_001', ts);
    await db.runAsync('UPDATE subscriptions SET next_renewal_date = ?, completed_cycles = 1 WHERE id = ?;', addDays(today, 4), 'demo_sub_netflix');

    // Exact fixture membership is no longer applicable once a user extends a group.
    if (!retained.has('groups:demo_group_murree_trip') && !retained.has('groups:demo_group_university'))
      await assertComprehensiveDemoData(db);
  });
}

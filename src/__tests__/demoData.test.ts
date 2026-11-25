import { openDatabaseAsync } from 'expo-sqlite';
import { openAppDatabase, type AppDb } from '../database/database';
import { removeMigration12ForFixture } from './schemaFixtures';
import { saveBudget } from '../database/repositories/repositories';
import { clearDemoData, countDemoRecords, loadComprehensiveDemoData, validateComprehensiveDemoData } from './fixtures/demoData';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

// Real SQLite and production migrations, with only Expo's native transport replaced.
// This does not simulate native bridge scheduling or concurrent connections.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Load the Node builtin through Jest without a native Expo dependency.
const { DatabaseSync } = require('node:sqlite');
type Value = string | number | null;
type Row = Record<string, Value>;
let sqlite: InstanceType<typeof DatabaseSync>;
let db: AppDb;

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  const adapter = {
    execAsync: async (sql: string) => { sqlite.exec(sql); },
    runAsync: async (sql: string, ...params: Value[]) => sqlite.prepare(sql).run(...params),
    getAllAsync: async (sql: string, ...params: Value[]) => sqlite.prepare(sql).all(...params),
    getFirstAsync: async (sql: string, ...params: Value[]) => sqlite.prepare(sql).get(...params) ?? null,
    withTransactionAsync: async (task: () => Promise<void>) => {
      sqlite.exec('BEGIN');
      try {
        await task();
        sqlite.exec('COMMIT');
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  (openDatabaseAsync as jest.Mock).mockResolvedValue(adapter);
  db = await openAppDatabase();
});

afterEach(() => {
  try {
    // Older production tables lack FKs; check logical references as well as new FKs.
    const data = snapshot();
    for (const values of Object.values(data)) {
      for (const row of values) {
        for (const [column, parents] of Object.entries({
          account_id: ['accounts'], destination_account_id: ['accounts'], linked_account_id: ['accounts'],
          category_id: ['categories'], person_id: ['people'], payer_person_id: ['people'],
          group_id: ['groups', 'split_groups'], split_group_id: ['split_groups'], goal_id: ['goals'],
          source_entry_id: ['person_entries'], target_entry_id: ['person_entries'],
        })) {
          if (row[column] != null) expect(parents.some(parent => data[parent].some(candidate => candidate.id === row[column]))).toBe(true);
        }
      }
    }
  } finally {
    sqlite.close();
  }
});

function rows(table: string): Row[] {
  return sqlite.prepare(`SELECT * FROM ${table} ORDER BY ${table === 'allocation_exclusions' ? 'source_entry_id, target_entry_id' : 'id'}`).all();
}

function snapshot() {
  const tables: { name: string }[] = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'app_settings' AND name != 'schema_migrations' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [name, rows(name)]));
}

function clone(table: string, sourceId: string, id: string, changes: Row = {}) {
  const source = sqlite.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(sourceId);
  const row = { ...source, id, ...changes };
  sqlite.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
}

function legacyAccount(id = 'demo_account_bank') {
  clone('accounts', 'account_cash_default', id, { name: 'Meezan Bank', type: 'BANK', opening_balance_minor: 9500000 });
}

test('Cash-only loader is idempotent and clear counts literal demo IDs only', async () => {
  clone('accounts', 'account_cash_default', 'demoXmanual', { name: 'Easypaisa', type: 'EWALLET' });
  const before = snapshot();
  await loadComprehensiveDemoData(db);
  const first = snapshot();
  expect(rows('accounts')).toEqual(before.accounts);
  for (const table of ['transactions', 'person_entries', 'split_groups', 'subscriptions', 'planned_payments']) {
    expect(new Set(rows(table).map(row => row.account_id))).toEqual(new Set(['account_cash_default']));
  }
  expect(new Set(rows('goals').map(row => row.linked_account_id))).toEqual(new Set(['account_cash_default']));
  expect(rows('transactions').some(row => row.type === 'TRANSFER' || row.destination_account_id != null)).toBe(false);
  await loadComprehensiveDemoData(db);
  // Timestamps can change; every other persisted field must be stable.
  const withoutTimes = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => ['created_at', 'updated_at'].includes(key) ? undefined : item));
  expect(withoutTimes(snapshot())).toEqual(withoutTimes(first));
  const count = await countDemoRecords(db);
  expect(count).toBeGreaterThan(100);
  expect(await clearDemoData(db)).toBe(count);
  expect(await countDemoRecords(db)).toBe(0);
  expect(snapshot()).toEqual(before);
  expect(await clearDemoData(db)).toBe(0);
});

test('detailed groups preserve personal shares, lending and borrowing accounting', async () => {
  await loadComprehensiveDemoData(db);
  expect(await validateComprehensiveDemoData(db)).toEqual([]);
  expect(rows('groups')).toHaveLength(2);
  expect(rows('group_members')).toHaveLength(9);
  expect(rows('split_groups')).toHaveLength(7);
  for (const split of rows('split_groups')) {
    const participants = rows('split_participants').filter(row => row.split_group_id === split.id);
    const own = participants.filter(row => row.is_self).reduce((sum, row) => sum + Number(row.share_minor), 0);
    expect(participants.reduce((sum, row) => sum + Number(row.share_minor), 0)).toBe(split.total_amount_minor);
    const transactions = rows('transactions').filter(row => row.financial_event_id === split.financial_event_id);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({ amount_minor: own, source: 'SPLIT', group_id: split.id });
    const entries = rows('person_entries').filter(row => row.split_group_id === split.id);
    expect(entries.reduce((sum, row) => sum + Number(row.amount_minor), 0)).toBe(split.payer_is_self ? Number(split.total_amount_minor) - own : own);
    expect(new Set(entries.map(row => row.type))).toEqual(new Set([split.payer_is_self ? 'GIVEN' : 'BORROWED_FROM']));
    if (!split.payer_is_self) expect(entries[0].person_id).toBe(split.payer_person_id);
  }
  const standalone = rows('split_groups').find(row => row.id === 'demo_split_standalone_weekend')!;
  expect(standalone.group_id).toBeNull();
  expect(rows('split_participants').filter(row => row.split_group_id === standalone.id)).toHaveLength(7);
  expect(rows('categories').find(row => row.id === 'demo_cat_archived_dining')).toMatchObject({ is_archived: 1 });
  expect(rows('planned_payment_occurrences')).toContainEqual(expect.objectContaining({ id: 'demo_planned_occurrence_internet_001', outcome: 'RECORDED', transaction_id: 'demo_tx_planned_internet_recorded_001' }));
  expect(rows('subscription_payments')).toContainEqual(expect.objectContaining({ id: 'demo_sub_payment_netflix_001', transaction_id: 'demo_tx_sub_netflix_paid_001' }));
});

test('comprehensive validation rejects corrupted cross-feature demo references', async () => {
  await loadComprehensiveDemoData(db);
  await db.runAsync("UPDATE transactions SET account_id = 'missing_account' WHERE id = 'demo_tx_food_001'");
  await db.runAsync("UPDATE planned_payments SET recurrence_interval = 0 WHERE id = 'demo_planned_rent'");
  await db.runAsync("UPDATE transactions SET source = 'MANUAL' WHERE id = 'demo_tx_sub_netflix_paid_001'");
  expect(await validateComprehensiveDemoData(db)).toEqual(expect.arrayContaining([
    'invalid reference',
    'invalid planned recurrence',
    'invalid subscription payment',
  ]));
  await db.runAsync("UPDATE transactions SET account_id = 'account_cash_default' WHERE id = 'demo_tx_food_001'");
  await db.runAsync("UPDATE planned_payments SET recurrence_interval = 1 WHERE id = 'demo_planned_rent'");
  await db.runAsync("UPDATE transactions SET source = 'SUBSCRIPTION' WHERE id = 'demo_tx_sub_netflix_paid_001'");
});

test('unreferenced legacy bank, wallet and transfer are removed on reset', async () => {
  await loadComprehensiveDemoData(db);
  legacyAccount();
  legacyAccount('demo_account_easypaisa');
  clone('transactions', 'demo_tx_salary_001', 'demo_tx_transfer_001', { type: 'TRANSFER', account_id: 'demo_account_bank', destination_account_id: 'demo_account_easypaisa' });
  await loadComprehensiveDemoData(db);
  expect(rows('accounts').map(row => row.id)).toEqual(['account_cash_default']);
  expect(rows('transactions').some(row => row.type === 'TRANSFER')).toBe(false);
});

test.each([
  ['transactions', 'demo_tx_food_001', 'account_id'],
  ['transactions', 'demo_tx_food_001', 'destination_account_id'],
  ['person_entries', 'demo_entry_ali_001', 'account_id'],
  ['split_groups', 'demo_split_murree_hotel', 'account_id'],
  ['subscriptions', 'demo_sub_netflix', 'account_id'],
  ['planned_payments', 'demo_planned_rent', 'account_id'],
  ['goals', 'demo_goal_laptop', 'linked_account_id'],
])('retains legacy account referenced by real %s.%s (%s), including soft deletion', async (table, sourceId, column) => {
  await loadComprehensiveDemoData(db);
  legacyAccount();
  clone(table, sourceId, 'manual_record', { [column]: 'demo_account_bank', deleted_at: '2026-01-01' });
  const manual = rows(table).find(row => row.id === 'manual_record');
  const account = rows('accounts').find(row => row.id === 'demo_account_bank');
  await clearDemoData(db);
  expect(rows('accounts')).toContainEqual(account);
  expect(rows(table)).toContainEqual(manual);
  await loadComprehensiveDemoData(db);
  expect(rows('accounts')).toContainEqual(account);
  expect(rows(table)).toContainEqual(manual);
});

test('manual names, budgets, renamed parents and extended scenarios survive clear and repeated reset', async () => {
  await loadComprehensiveDemoData(db);
  // Convert matching names to manual IDs before the next load.
  await clearDemoData(db);
  clone('categories', 'cat_expense_food', 'manual_pet', { name: 'Pet Care' });
  await db.runAsync("INSERT INTO people (id, name, created_at, updated_at) VALUES ('manual_ali', 'Ali', 'old', 'old')");
  await loadComprehensiveDemoData(db);
  expect(rows('people').some(row => row.id === 'demo_person_ali')).toBe(false);
  expect(rows('categories').some(row => row.id === 'demo_cat_pet_care')).toBe(false);
  clone('budgets', 'demo_budget_total_current', 'demoXbudget', { month_key: '2000-01', ownership: 'USER' });
  await db.runAsync("DELETE FROM budgets WHERE id = 'demo_budget_total_current'");
  await db.runAsync("UPDATE budgets SET month_key = ?, amount_minor = 123 WHERE id = 'demoXbudget'", rows('budgets').find(row => row.id === 'demo_budget_food')!.month_key);
  clone('group_members', 'demo_group_member_awais', 'manual_member', { person_id: 'manual_ali' });
  clone('goal_entries', 'demo_goal_entry_laptop_001', 'manual_goal_entry');
  clone('person_entries', 'demo_entry_hamza_001', 'manual_person_entry');
  clone('transactions', 'demo_tx_food_001', 'manual_category_tx', { category_id: 'demo_cat_gaming' });
  await db.runAsync("UPDATE people SET name = 'Renamed Hamza' WHERE id = 'demo_person_hamza'");
  await db.runAsync("UPDATE categories SET name = 'Renamed Gaming' WHERE id = 'demo_cat_gaming'");
  await db.runAsync("UPDATE groups SET name = 'My Trip' WHERE id = 'demo_group_murree_trip'");
  await db.runAsync("UPDATE goals SET name = 'My Laptop', target_amount_minor = 12345 WHERE id = 'demo_goal_laptop'");
  const before = snapshot();
  const count = await countDemoRecords(db);
  const removed = await clearDemoData(db);
  expect(await countDemoRecords(db)).toBe(count - removed);
  expect(removed).toBeGreaterThan(0);
  expect(await countDemoRecords(db)).toBeGreaterThan(0);
  for (let i = 0; i < 2; i++) {
    await loadComprehensiveDemoData(db);
    for (const [table, values] of Object.entries(before)) {
      for (const row of values.filter(row => !String(row.id).startsWith('demo_'))) expect(rows(table)).toContainEqual(row);
    }
    for (const [table, id] of [['people', 'demo_person_hamza'], ['categories', 'demo_cat_gaming'], ['groups', 'demo_group_murree_trip'], ['goals', 'demo_goal_laptop']]) {
      expect(rows(table).find(row => row.id === id)).toEqual(before[table].find(row => row.id === id));
    }
    expect(rows('budgets').some(row => row.id === 'demo_budget_total_current')).toBe(false);
  }
});

test.each(['load', 'clear'])('%s rolls back all earlier writes on a SQLite error', async operation => {
  await loadComprehensiveDemoData(db);
  legacyAccount();
  const before = snapshot();
  sqlite.exec(operation === 'load'
    ? "CREATE TRIGGER fail_demo BEFORE INSERT ON subscriptions BEGIN SELECT RAISE(ABORT, 'injected failure'); END"
    : "CREATE TRIGGER fail_demo BEFORE DELETE ON accounts BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  await expect(operation === 'load' ? loadComprehensiveDemoData(db) : clearDemoData(db)).rejects.toThrow('injected failure');
  expect(snapshot()).toEqual(before);
});

test('reset does not recreate removed expenses or orphan children in an extended group', async () => {
  await loadComprehensiveDemoData(db);
  clone('group_members', 'demo_group_member_awais', 'manual_membership');
  await db.runAsync("DELETE FROM split_participants WHERE split_group_id = 'demo_split_murree_hotel'");
  await db.runAsync("DELETE FROM person_entries WHERE split_group_id = 'demo_split_murree_hotel'");
  await db.runAsync("DELETE FROM transactions WHERE group_id = 'demo_split_murree_hotel'");
  await db.runAsync("DELETE FROM split_groups WHERE id = 'demo_split_murree_hotel'");
  const before = snapshot();
  await loadComprehensiveDemoData(db);
  for (const table of ['split_participants', 'person_entries', 'transactions', 'split_groups']) {
    expect(rows(table).filter(row => String(row.id).includes('murree'))).toEqual(before[table].filter(row => String(row.id).includes('murree')));
  }
});

test('missing Cash aborts without deleting existing demo data or adding dangling references', async () => {
  await loadComprehensiveDemoData(db);
  await db.runAsync("UPDATE accounts SET deleted_at = '2026-01-01' WHERE id = 'account_cash_default'");
  const before = snapshot();
  await expect(loadComprehensiveDemoData(db)).rejects.toThrow('default Cash account');
  expect(snapshot()).toEqual(before);
});

test('a real event-linked record retains the complete legacy posting and its parents', async () => {
  await loadComprehensiveDemoData(db);
  legacyAccount();
  await db.runAsync("UPDATE split_groups SET account_id = 'demo_account_bank' WHERE id = 'demo_split_murree_hotel'");
  clone('transactions', 'demo_tx_food_001', 'manual_event_tx', { financial_event_id: 'demo_event_murree_hotel', group_id: null });
  const before = snapshot();
  await clearDemoData(db);
  for (const table of ['split_groups', 'split_participants', 'person_entries', 'transactions']) {
    for (const row of before[table].filter(row => String(row.id).includes('murree_hotel') || row.id === 'manual_event_tx')) {
      expect(rows(table)).toContainEqual(row);
    }
  }
  expect(rows('accounts')).toContainEqual(before.accounts.find(row => row.id === 'demo_account_bank'));
  await loadComprehensiveDemoData(db);
  expect(rows('split_groups').find(row => row.id === 'demo_split_murree_hotel')).toEqual(before.split_groups.find(row => row.id === 'demo_split_murree_hotel'));
});

test.each(
  ['demo_budget_total_current', 'demo_budget_food'].flatMap(id =>
    [false, true].flatMap(changed => ['clear', 'reset'].map(operation => ({ id, changed, operation })))),
)('manual save protects $id (changed=$changed) through $operation', async ({ id, changed, operation }) => {
  await loadComprehensiveDemoData(db);
  const original = rows('budgets').find(row => row.id === id)!;
  expect(original.ownership).toBe('DEMO');
  const beforeCount = await countDemoRecords(db);
  const accounting = snapshot();
  await saveBudget(db, {
    month_key: String(original.month_key), category_id: original.category_id as string | null,
    amount_minor: Number(original.amount_minor) + (changed ? 123 : 0),
  });
  const saved = rows('budgets').find(row => row.id === id)!;
  expect(saved).toMatchObject({ id, ownership: 'USER', amount_minor: Number(original.amount_minor) + (changed ? 123 : 0) });
  expect(rows('budgets')).toHaveLength(5);
  expect(await countDemoRecords(db)).toBe(beforeCount - 1);
  for (const [table, values] of Object.entries(accounting)) {
    if (table !== 'budgets') expect(rows(table)).toEqual(values);
  }
  for (let i = 0; i < 2; i++) {
    if (operation === 'clear') await clearDemoData(db);
    else await loadComprehensiveDemoData(db);
    expect(rows('budgets')).toContainEqual(saved);
    expect(rows('budgets').filter(row => row.month_key === saved.month_key && row.category_id === saved.category_id)).toEqual([saved]);
  }
});

test('protected demo-ID category budgets retain their demo category, including soft-deleted plans', async () => {
  await loadComprehensiveDemoData(db);
  clone('budgets', 'demo_budget_food', 'demo_budget_pet', { category_id: 'demo_cat_pet_care', ownership: 'USER', deleted_at: '2026-01-01' });
  const budget = rows('budgets').find(row => row.id === 'demo_budget_pet');
  const category = rows('categories').find(row => row.id === 'demo_cat_pet_care');
  await clearDemoData(db);
  expect(rows('budgets')).toEqual([budget]);
  expect(rows('categories')).toContainEqual(category);
  expect(await countDemoRecords(db)).toBe(1);
  await loadComprehensiveDemoData(db);
  expect(rows('budgets')).toContainEqual(budget);
  expect(rows('categories')).toContainEqual(category);
});

test('fresh demo budgets are removable and ownership, not ID, controls budget counts', async () => {
  await loadComprehensiveDemoData(db);
  expect(rows('budgets')).toHaveLength(5);
  expect(rows('budgets').every(row => row.ownership === 'DEMO')).toBe(true);
  const count = await countDemoRecords(db);
  await db.runAsync("UPDATE budgets SET id = 'ordinary_id' WHERE id = 'demo_budget_food'");
  expect(await countDemoRecords(db)).toBe(count);
  expect(await clearDemoData(db)).toBe(count);
  expect(rows('budgets')).toEqual([]);
  expect(await countDemoRecords(db)).toBe(0);
});

test('new manual plans default to USER and survive clear/reset without a demo duplicate', async () => {
  await loadComprehensiveDemoData(db);
  const month = String(rows('budgets')[0].month_key);
  await clearDemoData(db);
  await saveBudget(db, { month_key: month, amount_minor: 12345 });
  const saved = rows('budgets')[0];
  expect(saved.ownership).toBe('USER');
  await loadComprehensiveDemoData(db);
  expect(rows('budgets').filter(row => row.category_id === null)).toEqual([saved]);
  await clearDemoData(db);
  expect(rows('budgets')).toEqual([saved]);
});

test('failed manual adoption leaves both demo amount and ownership unchanged', async () => {
  await loadComprehensiveDemoData(db);
  const before = snapshot();
  sqlite.exec("CREATE TRIGGER fail_budget BEFORE INSERT ON budgets WHEN NEW.ownership = 'USER' BEGIN SELECT RAISE(ABORT, 'adoption failure'); END");
  await expect(saveBudget(db, { month_key: String(rows('budgets')[0].month_key), amount_minor: 123 })).rejects.toThrow('adoption failure');
  expect(snapshot()).toEqual(before);
});

test('migration 5 preserves every legacy row and ID/amount, protects old demo IDs, and reinitializes idempotently', async () => {
  await loadComprehensiveDemoData(db);
  clone('budgets', 'demo_budget_food', 'manual_old', { month_key: '2000-01', amount_minor: 789 });
  clone('budgets', 'demo_budget_food', 'demo_budget_deleted', { deleted_at: '2026-01-01', amount_minor: 456 });
  // Reconstruct schema 4 in this disposable in-memory fixture only.
  await removeMigration12ForFixture(db);
  for (const row of sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()) sqlite.exec(`DROP TRIGGER ${row.name};`);
  sqlite.exec('ALTER TABLE split_groups DROP COLUMN split_definition; DROP TABLE subscription_payments; ALTER TABLE subscriptions DROP COLUMN recurrence_anchor_day; ALTER TABLE subscriptions DROP COLUMN user_managed; DROP TABLE planned_payment_occurrences; DROP VIEW allocation_sources; DROP VIEW allocation_targets; DROP TABLE entry_allocations; DROP TABLE allocation_exclusions; DROP TABLE group_settlement_requests; ALTER TABLE groups DROP COLUMN is_archived; ALTER TABLE groups DROP COLUMN user_managed; ALTER TABLE budgets DROP COLUMN ownership; DELETE FROM schema_migrations WHERE version >= 5;');
  const legacy = snapshot();
  await openAppDatabase();
  legacy.transactions = legacy.transactions.map(row => ({ ...row, cash_effect_minor: null }));
  legacy.person_entries = legacy.person_entries.map(row => ({ ...row, cash_effect_minor: null }));
  legacy.planned_payments = legacy.planned_payments.map(row => ({ ...row, schedule_provenance: null }));
  legacy.subscriptions = legacy.subscriptions.map(row => ({ ...row, schedule_provenance: null }));
  expect(snapshot()).toEqual({ ...legacy, split_groups: legacy.split_groups.map(row => ({ ...row, split_definition: null })), budgets: legacy.budgets.map(row => ({ ...row, ownership: 'USER', currency: 'PKR' })), goals: legacy.goals.map(row => ({ ...row, currency: 'PKR' })), transactions: legacy.transactions.map(row => ({ ...row, destination_amount_minor: null })), groups: legacy.groups.map(row => ({ ...row, is_archived: 0, user_managed: 0 })), subscriptions: legacy.subscriptions.map(row => ({ ...row, recurrence_anchor_day: null, user_managed: 0 })), entry_allocations: [], allocation_exclusions: [], group_settlement_requests: [], planned_payment_occurrences: [], subscription_payments: [] });
  const migrated = snapshot();
  const versions = await db.getAllAsync('SELECT * FROM schema_migrations ORDER BY version');
  expect(versions).toHaveLength(14);
  await openAppDatabase();
  expect(snapshot()).toEqual(migrated);
  expect(await db.getAllAsync('SELECT * FROM schema_migrations ORDER BY version')).toEqual(versions);
  expect(() => sqlite.exec("UPDATE budgets SET ownership = 'INVALID'")).toThrow();
  expect(() => sqlite.exec('UPDATE budgets SET ownership = NULL')).toThrow();
  await clearDemoData(db);
  expect(rows('budgets')).toEqual(migrated.budgets);
  await loadComprehensiveDemoData(db);
  expect(rows('budgets')).toEqual(migrated.budgets);
});

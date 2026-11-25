/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import * as SQLite from 'expo-sqlite';
import { openAppDatabase, type AppDb } from '../database/database';
import { removeMigration12ForFixture } from './schemaFixtures';
import * as repo from '../database/repositories/repositories';
import { archiveGroup, buildGroupNetSettlement, groupPositionLabel, readGroupSnapshot, reconcileAllocation, restoreGroup, saveGroupDetails, setAllocationUnrelated, settleGroup, type GroupSettlementInput } from '../services/groups/GroupService';
import { saveSharedExpensePosting, deleteSharedExpense, updateSharedExpense } from '../services/sharedExpense/SharedExpenseService';
import { calculateAccountBalance } from '../services/finance/FinanceService';
import { calculatePersonBalance } from '../services/people/PeopleBalanceService';
import { listActivity } from '../services/activity/ActivityService';
import { accountActivityEffect } from '../services/accounts/AccountService';
import { clearDemoData, loadComprehensiveDemoData } from './fixtures/demoData';
import { todayLocal } from '../utils/date';
import type { PersonEntryType } from '../types/models';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
let sqlite: DatabaseSync;
let db: AppDb;
let personId: string;
let groupId: string;
let counter: number;
const cashId = 'account_cash_default';

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  counter = 0;
  const adapter = {
    execAsync: async (sql: string) => { sqlite.exec(sql); },
    runAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).run(...params),
    getAllAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).all(...params),
    getFirstAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).get(...params) ?? null,
    withTransactionAsync: async (work: () => Promise<void>) => {
      sqlite.exec('BEGIN');
      try { await work(); sqlite.exec('COMMIT'); } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    withExclusiveTransactionAsync: async (work: (txn: AppDb) => Promise<void>) => adapter.withTransactionAsync(() => work(db)),
  };
  db = adapter as unknown as AppDb;
  jest.mocked(SQLite.openDatabaseAsync).mockResolvedValue(db);
  await openAppDatabase();
  personId = await repo.savePerson(db, 'Ali');
  groupId = await saveGroupDetails(db, { name: 'Trip', personIds: [personId] });
});
afterEach(() => { expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]); sqlite.close(); });

async function bill(selfPaid = true, amount = 1000, group: string | null = groupId, person = personId) {
  return saveSharedExpensePosting(db, {
    title: `Bill ${++counter}`, totalAmountMinor: amount * 2, categoryId: 'cat_expense_food', accountId: cashId, occurredOn: todayLocal(), groupId: group,
    payerIsSelf: selfPaid, payerPersonId: selfPaid ? null : person,
    shares: [{ name: 'You', isSelf: true, shareMinor: amount }, { name: 'Person', personId: person, isSelf: false, shareMinor: amount }],
  });
}
async function cash(type: PersonEntryType, amount = 1000, person = personId) {
  return repo.savePersonEntry(db, { person_id: person, type, amount_minor: amount, account_id: cashId, title: 'Earlier cash', occurred_on: todayLocal() });
}
async function money() {
  const entries = await repo.listPersonEntries(db);
  const transactions = await repo.listTransactions(db);
  return { entries, transactions, budgets: await db.getAllAsync('SELECT * FROM budgets ORDER BY id;'), accounts: (await repo.listAccounts(db)).map((account) => ({ id: account.id, balance: calculateAccountBalance(account, transactions, entries) })), global: calculatePersonBalance(entries.filter((e) => e.person_id === personId)) };
}
async function settlement(targetEntryId: string, amountMinor = 1000, overrides: Partial<GroupSettlementInput> = {}): Promise<GroupSettlementInput> {
  const snapshot = await readGroupSnapshot(db, groupId);
  return { requestId: `request_${++counter}`, groupId, personId, accountId: cashId, occurredOn: todayLocal(), targets: [{ targetEntryId, amountMinor }], expectedRevision: snapshot.revision, expectedBalanceMinor: (await money()).global, ...overrides };
}
async function allocate(sourceEntryId: string, targetEntryId: string, amountMinor = 1000, id = `allocation_${++counter}`) {
  return reconcileAllocation(db, { id, sourceEntryId, targetEntryId, amountMinor });
}

test('optional self membership preserves retained member IDs and all earlier bill participants', async () => {
  const expense = await bill();
  const before = await readGroupSnapshot(db, groupId);
  await saveGroupDetails(db, { id: groupId, expectedUpdatedAt: before.group.updated_at, name: 'Others', personIds: [personId], includeSelf: false });
  const after = await readGroupSnapshot(db, groupId);
  expect(after.members.map((member) => member.person_id)).toEqual([personId]);
  expect(after.members[0].id).toBe(before.members.find((member) => !member.is_self)!.id);
  expect(after.participants.filter((row) => row.split_group_id === expense.splitGroup.id)).toEqual(before.participants);
  await saveGroupDetails(db, { id: groupId, expectedUpdatedAt: after.group.updated_at, name: 'Together', personIds: [personId], includeSelf: true });
  expect((await readGroupSnapshot(db, groupId)).members.filter((member) => member.person_id === personId)).toHaveLength(1);
  const others = await saveGroupDetails(db, { name: 'No You', personIds: [personId], includeSelf: false });
  expect((await readGroupSnapshot(db, others)).members.some((member) => member.is_self)).toBe(false);
});

test('explicit gross 12,250 vs 5,000 net settlement moves only 7,250 and preserves unrelated opposite global money', async () => {
  const unrelated = await cash('BORROWED_FROM', 800000);
  await bill(true, 500000); await bill(true, 225000); await bill(false, 500000); await bill(true, 500000);
  let snapshot = await readGroupSnapshot(db, groupId);
  for (const target of snapshot.targets.filter((target) => target.direction === 1)) await setAllocationUnrelated(db, unrelated, target.id, true);
  snapshot = await readGroupSnapshot(db, groupId);
  const before = await money();
  const plan = buildGroupNetSettlement(snapshot.targets, personId, 725000);
  expect(plan).toMatchObject({ owedMinor: 1225000, oweMinor: 500000, netMinor: 725000, offsetMinor: 500000 });
  expect(buildGroupNetSettlement([...snapshot.targets].reverse(), personId, 725000)).toEqual(plan);
  const input = { requestId: 'net-request', groupId, personId, accountId: cashId, occurredOn: todayLocal(), targets: plan.targets, offsets: plan.offsets, nettingConfirmed: true, expectedRevision: snapshot.revision, expectedBalanceMinor: before.global, note: 'Confirmed net receipt' };
  const sourceId = await settleGroup(db, input);
  const after = await money();
  expect(after.accounts[0].balance - before.accounts[0].balance).toBe(725000);
  expect(after.global).toBe(-800000);
  expect(after.transactions).toEqual(before.transactions);
  expect(after.entries.find((entry) => entry.id === sourceId)).toMatchObject({ type: 'BORROWED_FROM', amount_minor: 725000, note: 'Confirmed net receipt' });
  expect((await readGroupSnapshot(db, groupId)).positions.find((position) => position.personId === personId)).toMatchObject({ owedMinor: 0, oweMinor: 0 });
  expect((await readGroupSnapshot(db, groupId)).history).toHaveLength(1);
  expect(await settleGroup(db, input)).toBe(sourceId);
  expect(await money()).toEqual(after);
});

test('zero net explicitly offsets equal group obligations without creating any People/account/Activity cash record', async () => {
  await bill(true, 5000); await bill(false, 5000);
  const snapshot = await readGroupSnapshot(db, groupId);
  const before = await money();
  const activity = await listActivity(db);
  const plan = buildGroupNetSettlement(snapshot.targets, personId, 0);
  await settleGroup(db, { requestId: 'zero-net', groupId, personId, accountId: '', occurredOn: todayLocal(), targets: [], offsets: plan.offsets, nettingConfirmed: true, expectedRevision: snapshot.revision, expectedBalanceMinor: before.global });
  expect(await money()).toEqual(before);
  expect(await listActivity(db)).toEqual(activity);
  const after = await readGroupSnapshot(db, groupId);
  expect(after.positions.find((position) => position.personId === personId)).toMatchObject({ owedMinor: 0, oweMinor: 0 });
  expect(after.history).toEqual([]);
  expect(after.offsets).toHaveLength(1);
});

test('negative net payment preserves an unrelated receivable and moves only the actual cash through normal Given classification', async () => {
  const unrelated = await cash('GIVEN', 8000);
  await bill(true, 3000); await bill(false, 10000);
  let snapshot = await readGroupSnapshot(db, groupId);
  for (const target of snapshot.targets.filter((target) => target.direction < 0)) await setAllocationUnrelated(db, unrelated, target.id, true);
  snapshot = await readGroupSnapshot(db, groupId);
  const before = await money();
  const plan = buildGroupNetSettlement(snapshot.targets, personId, 7000);
  const source = await settleGroup(db, { requestId: 'net-out', groupId, personId, accountId: cashId, occurredOn: todayLocal(), targets: plan.targets, offsets: plan.offsets, nettingConfirmed: true, expectedRevision: snapshot.revision, expectedBalanceMinor: before.global });
  const after = await money();
  expect(after.accounts[0].balance - before.accounts[0].balance).toBe(-7000);
  expect(after.global).toBe(8000);
  expect(after.transactions).toEqual(before.transactions);
  expect(after.entries.find((entry) => entry.id === source)).toMatchObject({ type: 'GIVEN', amount_minor: 7000 });
  expect((await readGroupSnapshot(db, groupId)).positions.find((position) => position.personId === personId)).toMatchObject({ owedMinor: 0, oweMinor: 0 });
});

test('offset SQLite guard rejects cross-group links/cumulative reuse and protects source-side participants', async () => {
  const owed = await bill(true, 10000); const owe = await bill(false, 3000);
  const otherGroup = await saveGroupDetails(db, { name: 'Other', personIds: [personId] });
  const other = await bill(true, 10000, otherGroup);
  await expect(db.runAsync('INSERT INTO entry_allocations (id, source_entry_id, target_entry_id, amount_minor, created_at) VALUES (?, ?, ?, ?, ?);', 'cross-offset', owe.personEntries[0].id, other.personEntries[0].id, 100, new Date().toISOString())).rejects.toThrow('offset');
  const snapshot = await readGroupSnapshot(db, groupId);
  const plan = buildGroupNetSettlement(snapshot.targets, personId, 0);
  await settleGroup(db, { requestId: 'offset-only', groupId, personId, accountId: '', occurredOn: todayLocal(), targets: [], offsets: plan.offsets, nettingConfirmed: true, expectedRevision: snapshot.revision, expectedBalanceMinor: (await money()).global });
  await expect(db.runAsync('INSERT INTO entry_allocations (id, source_entry_id, target_entry_id, amount_minor, created_at) VALUES (?, ?, ?, ?, ?);', 'repeat-offset', owe.personEntries[0].id, owed.personEntries[0].id, 1, new Date().toISOString())).rejects.toThrow();
  await expect(db.runAsync('UPDATE split_participants SET share_minor = share_minor + 1 WHERE split_group_id = ?;', owe.splitGroup.id)).rejects.toThrow('Offset participants');
});

test.each(['INSERT INTO entry_allocations', 'INSERT INTO person_entries', 'INSERT INTO group_settlement_requests'])('net settlement %s failure rolls back offsets and actual cash together', async (failure) => {
  await bill(true, 10000); await bill(false, 3000);
  const snapshot = await readGroupSnapshot(db, groupId);
  const before = await money();
  const plan = buildGroupNetSettlement(snapshot.targets, personId, 7000);
  const run = db.runAsync.bind(db);
  const spy = jest.spyOn(db, 'runAsync').mockImplementation(async (sql, ...params) => { if (sql.includes(failure)) throw new Error('Injected net write failure'); return run(sql, ...params); });
  await expect(settleGroup(db, { requestId: 'net-failure', groupId, personId, accountId: cashId, occurredOn: todayLocal(), targets: plan.targets, offsets: plan.offsets, nettingConfirmed: true, expectedRevision: snapshot.revision, expectedBalanceMinor: before.global })).rejects.toThrow('Injected');
  spy.mockRestore();
  expect(await money()).toEqual(before);
  expect(await db.getAllAsync('SELECT * FROM entry_allocations')).toEqual([]);
  expect(await db.getAllAsync('SELECT * FROM group_settlement_requests')).toEqual([]);
});

test('offset confirmation/caps and original source/target mutation locks are enforced', async () => {
  const owed = await bill(true, 10000); const owe = await bill(false, 3000);
  const snapshot = await readGroupSnapshot(db, groupId);
  const plan = buildGroupNetSettlement(snapshot.targets, personId, 2000);
  const input = { requestId: 'partial-net', groupId, personId, accountId: cashId, occurredOn: todayLocal(), targets: plan.targets, offsets: plan.offsets, expectedRevision: snapshot.revision, expectedBalanceMinor: (await money()).global };
  await expect(settleGroup(db, input)).rejects.toThrow('Confirm');
  await expect(settleGroup(db, { ...input, nettingConfirmed: true, offsets: plan.offsets.map((offset) => ({ ...offset, amountMinor: 3001 })) })).rejects.toThrow('exceeds');
  await settleGroup(db, { ...input, nettingConfirmed: true });
  expect((await readGroupSnapshot(db, groupId)).positions.find((position) => position.personId === personId)).toMatchObject({ owedMinor: 5000, oweMinor: 0 });
  for (const expense of [owed, owe]) await expect(deleteSharedExpense(db, expense.splitGroup.id, (await readGroupSnapshot(db, groupId)).expenses.find((row) => row.id === expense.splitGroup.id)!.updated_at)).rejects.toThrow('reconciled');
});

test('group restore preserves stable group/member/bill/allocation identities and every financial effect', async () => {
  const plan = await bill();
  const sourceId = await cash('RECEIVED_BACK', 300);
  await allocate(sourceId, plan.personEntries[0].id, 200);
  await setAllocationUnrelated(db, sourceId, plan.personEntries[0].id, true);
  const before = await money();
  const snapshot = await readGroupSnapshot(db, groupId);
  const metadata = await db.getAllAsync('SELECT * FROM entry_allocations;');
  const exclusions = await db.getAllAsync('SELECT * FROM allocation_exclusions;');
  await archiveGroup(db, groupId, snapshot.group.updated_at);
  const archived = await readGroupSnapshot(db, groupId);
  await restoreGroup(db, groupId, archived.group.updated_at);
  const restored = await readGroupSnapshot(db, groupId);
  expect(restored.group.id).toBe(groupId);
  expect(restored.group.is_archived).toBe(0);
  expect(restored.members).toEqual(snapshot.members);
  expect(restored.expenses).toEqual(snapshot.expenses);
  expect(restored.participants).toEqual(snapshot.participants);
  expect(restored.positions).toEqual(snapshot.positions);
  expect(await money()).toEqual(before);
  expect(await db.getAllAsync('SELECT * FROM entry_allocations;')).toEqual(metadata);
  expect(await db.getAllAsync('SELECT * FROM allocation_exclusions;')).toEqual(exclusions);
  expect((await repo.listGroups(db)).map((row) => row.id)).toContain(groupId);
  await expect(restoreGroup(db, groupId, archived.group.updated_at)).rejects.toThrow('changed');
});

test('archived group blocks stale reconciliation, exclusion add/remove and financial settlement atomically', async () => {
  const plan = await bill();
  const targetId = plan.personEntries[0].id;
  const sourceId = await cash('RECEIVED_BACK', 300);
  await setAllocationUnrelated(db, sourceId, targetId, true);
  const snapshot = await readGroupSnapshot(db, groupId);
  await archiveGroup(db, groupId, snapshot.group.updated_at);
  const before = await money();
  const exclusions = await db.getAllAsync('SELECT * FROM allocation_exclusions;');
  await expect(allocate(sourceId, targetId, 100)).rejects.toThrow('archived');
  await expect(setAllocationUnrelated(db, sourceId, targetId, true)).rejects.toThrow('archived');
  await expect(setAllocationUnrelated(db, sourceId, targetId, false)).rejects.toThrow('archived');
  await expect(settleGroup(db, await settlement(targetId, 100))).rejects.toThrow('archived');
  expect(await money()).toEqual(before);
  expect(await db.getAllAsync('SELECT * FROM allocation_exclusions;')).toEqual(exclusions);
  expect(await db.getAllAsync('SELECT * FROM entry_allocations;')).toEqual([]);
  const archived = await readGroupSnapshot(db, groupId);
  const write = jest.spyOn(db, 'runAsync').mockRejectedValueOnce(new Error('Injected restore failure'));
  await expect(restoreGroup(db, groupId, archived.group.updated_at)).rejects.toThrow('Injected');
  write.mockRestore();
  expect((await readGroupSnapshot(db, groupId)).group).toEqual(archived.group);
  expect(await money()).toEqual(before);
});

test('migration 6 retains historical values and migrations 1-5, never guesses allocations, and reopens idempotently', async () => {
  const plan = await bill();
  await cash('RECEIVED_BACK', 500);
  const before = await money();
  // Reconstruct the exact schema-5 boundary in a disposable DB; never touch a device DB.
  await removeMigration12ForFixture(db);
  for (const row of sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()) sqlite.exec(`DROP TRIGGER ${row.name};`);
  sqlite.exec('ALTER TABLE split_groups DROP COLUMN split_definition; DROP TABLE subscription_payments; ALTER TABLE subscriptions DROP COLUMN recurrence_anchor_day; ALTER TABLE subscriptions DROP COLUMN user_managed; DROP TABLE planned_payment_occurrences; DROP VIEW allocation_sources; DROP VIEW allocation_targets; DROP TABLE entry_allocations; DROP TABLE allocation_exclusions; DROP TABLE group_settlement_requests; ALTER TABLE groups DROP COLUMN is_archived; ALTER TABLE groups DROP COLUMN user_managed; DELETE FROM schema_migrations WHERE version >= 6;');
  const oldVersions = await db.getAllAsync('SELECT * FROM schema_migrations ORDER BY version;');
  const oldGroups = await db.getAllAsync('SELECT * FROM groups ORDER BY id;');
  const oldSplits = await repo.listSplitGroups(db);
  const originalExec = db.execAsync.bind(db);
  const failingMigration = jest.spyOn(db, 'execAsync').mockImplementation(async (sql) => {
    if (sql.includes('ALTER TABLE groups ADD COLUMN is_archived')) {
      sqlite.exec('ALTER TABLE groups ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0;');
      throw new Error('migration interrupted');
    }
    await originalExec(sql);
  });
  await expect(openAppDatabase()).rejects.toThrow('migration interrupted');
  expect(await db.getAllAsync('SELECT * FROM groups ORDER BY id;')).toEqual(oldGroups);
  expect(await db.getAllAsync('SELECT * FROM schema_migrations ORDER BY version;')).toEqual(oldVersions);
  failingMigration.mockRestore();
  await openAppDatabase();
  expect(await money()).toEqual(before);
  expect(await repo.listSplitGroups(db)).toEqual(oldSplits.map((split) => ({ ...split, split_definition: null })));
  expect(await db.getAllAsync('SELECT * FROM groups ORDER BY id;')).toEqual(oldGroups.map((g: any) => ({ ...g, is_archived: 0, user_managed: 0 })));
  expect(await db.getAllAsync('SELECT * FROM schema_migrations WHERE version <= 5 ORDER BY version;')).toEqual(oldVersions);
  expect(await db.getAllAsync('SELECT * FROM entry_allocations;')).toEqual([]);
  expect(await db.getAllAsync('SELECT * FROM allocation_exclusions;')).toEqual([]);
  const snapshot = await readGroupSnapshot(db, groupId);
  expect(snapshot.targets[0]).toMatchObject({ id: plan.personEntries[0].id, remaining_minor: 1000 });
  expect(snapshot.ambiguous).toBe(true);
  await openAppDatabase();
  expect(await readGroupSnapshot(db, groupId)).toEqual(snapshot);
  expect(await db.getAllAsync('SELECT * FROM schema_migrations;')).toHaveLength(14);
});

test.each([
  ['GIVEN', false], ['PAID_BACK', false], ['BORROWED_FROM', true], ['RECEIVED_BACK', true],
] as const)('%s real cash is eligible by direction, not label; reconciliation is metadata-only', async (type, selfPaid) => {
  const target = (await bill(selfPaid)).personEntries[0].id;
  const source = await cash(type);
  const before = await money();
  expect((await readGroupSnapshot(db, groupId)).ambiguous).toBe(true);
  await allocate(source, target);
  expect(await money()).toEqual(before);
  const snapshot = await readGroupSnapshot(db, groupId);
  expect(groupPositionLabel(snapshot)).toBe('Settled');
  expect(snapshot.history).toHaveLength(1);
  expect(snapshot.history[0]).toMatchObject({ id: source, allocated_minor: 1000, type });
  expect(await db.getAllAsync('SELECT * FROM allocation_targets WHERE id = ?;', source)).toEqual([]);
  const activity = (await listActivity(db)).filter((a) => a.source_id === source);
  expect(activity).toHaveLength(1);
  expect(accountActivityEffect(activity[0], cashId)).toBe(selfPaid ? 1000 : -1000);
  expect((await listActivity(db, { groupId })).filter((a) => a.source_id === source)).toHaveLength(1);
});

test.each(['GIVEN', 'PAID_BACK', 'BORROWED_FROM', 'RECEIVED_BACK'] as const)('%s rejects incompatible direction', async (type) => {
  const target = (await bill(['GIVEN', 'PAID_BACK'].includes(type))).personEntries[0].id;
  const source = await cash(type);
  await expect(allocate(source, target)).rejects.toThrow('Invalid allocation');
});

test.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN])('invalid allocation amount %s is rejected by service and SQLite', async (amount) => {
  const target = (await bill()).personEntries[0].id;
  const source = await cash('RECEIVED_BACK');
  await expect(allocate(source, target, amount)).rejects.toThrow();
  expect(() => sqlite.prepare('INSERT INTO entry_allocations VALUES (?, ?, ?, ?, ?)').run('bad', source, target, amount, 'now')).toThrow();
});

test('source and target caps hold across partial, multiple-source, multiple-target and multiple-group allocations', async () => {
  const target1 = (await bill()).personEntries[0].id;
  const otherGroup = await saveGroupDetails(db, { name: 'Other', personIds: [personId] });
  const target2 = (await bill(true, 1000, otherGroup)).personEntries[0].id;
  const source1 = await cash('RECEIVED_BACK', 1500);
  const source2 = await cash('BORROWED_FROM', 600);
  const before = await money();
  await allocate(source1, target1, 600);
  expect((await readGroupSnapshot(db, groupId)).targets[0].remaining_minor).toBe(400);
  expect((await readGroupSnapshot(db, groupId)).ambiguous).toBe(true);
  await allocate(source2, target1, 400);
  await expect(allocate(source2, target1, 1)).rejects.toThrow();
  await allocate(source1, target2, 900);
  await expect(allocate(source1, target2, 1)).rejects.toThrow();
  await allocate(source2, target2, 100);
  expect(await money()).toEqual(before);
  expect(groupPositionLabel(await readGroupSnapshot(db, groupId))).toBe('Settled');
  expect(groupPositionLabel(await readGroupSnapshot(db, otherGroup))).toBe('Settled');
  expect((await listActivity(db)).filter((a) => a.source_id === source1)).toHaveLength(1);
});

test('invalid, deleted, wrong-person, shared and adjustment sources cannot allocate', async () => {
  const plan = await bill();
  const target = plan.personEntries[0].id;
  const other = await repo.savePerson(db, 'Sam');
  const otherSource = await cash('RECEIVED_BACK', 1000, other);
  const adjustment = await cash('ADJUSTMENT');
  const sharedSource = (await bill(false)).personEntries[0].id;
  const deletedSource = await cash('RECEIVED_BACK');
  await db.runAsync('UPDATE person_entries SET deleted_at = ? WHERE id = ?;', 'now', deletedSource);
  for (const source of ['missing', otherSource, adjustment, sharedSource, deletedSource, target]) await expect(allocate(source, target)).rejects.toThrow();
  const source = await cash('RECEIVED_BACK');
  await expect(allocate(source, 'missing')).rejects.toThrow();
  await expect(allocate(source, adjustment)).rejects.toThrow();
  await db.runAsync('UPDATE person_entries SET deleted_at = ? WHERE id = ?;', 'now', target);
  await expect(allocate(source, target)).rejects.toThrow();
});

test('historical ambiguity blocks new settlement; explicit exclusions resolve only the chosen pair and are reversible', async () => {
  const target1 = (await bill()).personEntries[0].id;
  const target2 = (await bill()).personEntries[0].id;
  const source = await cash('BORROWED_FROM', 8000);
  const before = await money();
  await expect(settleGroup(db, await settlement(target1))).rejects.toThrow('Reconciliation needed');
  await setAllocationUnrelated(db, source, target1, true);
  expect((await readGroupSnapshot(db, groupId)).candidates.map((c) => c.target.id)).toEqual([target2]);
  await setAllocationUnrelated(db, source, target2, true);
  expect((await readGroupSnapshot(db, groupId)).ambiguous).toBe(false);
  expect(await money()).toEqual(before);
  await setAllocationUnrelated(db, source, target1, false);
  expect((await readGroupSnapshot(db, groupId)).ambiguous).toBe(true);
  await allocate(source, target1, 500);
  expect((await readGroupSnapshot(db, groupId)).ambiguous).toBe(true);
  expect((await readGroupSnapshot(db, groupId)).targets.find((t) => t.id === target1)?.remaining_minor).toBe(500);
});

test.each([true, false])('full/partial group settlement selfPaid=%s moves selected account/global balance once and leaves unrelated history alone', async (selfPaid) => {
  const target = (await bill(selfPaid, 1000)).personEntries[0].id;
  const otherGroup = await saveGroupDetails(db, { name: 'Other', personIds: [personId] });
  await bill(selfPaid, 400, otherGroup);
  await cash(selfPaid ? 'GIVEN' : 'BORROWED_FROM', 300);
  await repo.createAccount(db, { name: 'Bank', type: 'BANK', opening_balance_minor: 5000 });
  const accountId = (await repo.listAccounts(db)).find((a) => a.name === 'Bank')!.id;
  const before = await money();
  const otherBefore = await readGroupSnapshot(db, otherGroup);
  expect(groupPositionLabel(await readGroupSnapshot(db, groupId))).toBe(selfPaid ? 'You are owed' : 'You owe');
  const input = await settlement(target, 400, { accountId });
  const first = await settleGroup(db, input);
  expect(await settleGroup(db, input)).toBe(first);
  await openAppDatabase();
  expect(await settleGroup(db, input)).toBe(first);
  await expect(settleGroup(db, { ...input, targets: [{ targetEntryId: target, amountMinor: 300 }] })).rejects.toThrow('different details');
  expect((await readGroupSnapshot(db, groupId)).balanceMinor).toBe(selfPaid ? 600 : -600);
  await settleGroup(db, await settlement(target, 600, { accountId }));
  const after = await money();
  expect(after.global - before.global).toBe(selfPaid ? -1000 : 1000);
  expect(after.accounts.find((a) => a.id === accountId)!.balance - before.accounts.find((a) => a.id === accountId)!.balance).toBe(selfPaid ? 1000 : -1000);
  expect(after.accounts.find((a) => a.id === cashId)).toEqual(before.accounts.find((a) => a.id === cashId));
  expect(after.transactions).toEqual(before.transactions);
  expect(after.budgets).toEqual(before.budgets);
  expect(after.entries.filter((e) => before.entries.some((old) => old.id === e.id))).toEqual(before.entries);
  expect(after.entries).toHaveLength(before.entries.length + 2);
  expect(await readGroupSnapshot(db, otherGroup)).toEqual(otherBefore);
  expect(groupPositionLabel(await readGroupSnapshot(db, groupId))).toBe('Settled');
});

test('one payment can settle explicitly selected multiple obligations; mixed directions and stale/over-cap requests reject', async () => {
  const first = (await bill()).personEntries[0].id;
  const second = (await bill()).personEntries[0].id;
  const opposite = (await bill(false)).personEntries[0].id;
  const before = await money();
  await expect(settleGroup(db, await settlement(first, 1001))).rejects.toThrow('exceeds');
  await expect(settleGroup(db, await settlement(first, 1000, { targets: [{ targetEntryId: first, amountMinor: 1000 }, { targetEntryId: opposite, amountMinor: 1000 }] }))).rejects.toThrow('one cash direction');
  expect(await money()).toEqual(before);
  const input = await settlement(first, 1000, { targets: [{ targetEntryId: first, amountMinor: 1000 }, { targetEntryId: second, amountMinor: 1000 }], crossingConfirmed: true });
  const id = await settleGroup(db, input);
  expect(await db.getAllAsync('SELECT * FROM entry_allocations WHERE source_entry_id = ?;', id)).toHaveLength(2);
  await expect(settleGroup(db, { ...input, requestId: 'stale' })).rejects.toThrow('changed');
  expect((await readGroupSnapshot(db, groupId)).balanceMinor).toBe(-1000);
});

test('net zero with opposing open bills is not mislabeled settled; no third-party balances are invented', async () => {
  await bill(true);
  await bill(false);
  const snapshot = await readGroupSnapshot(db, groupId);
  expect(snapshot.balanceMinor).toBe(0);
  expect(groupPositionLabel(snapshot)).toBe('Net zero; open amounts in both directions');
  expect(snapshot.positions).toHaveLength(1);
  expect(snapshot.positions[0]).toMatchObject({ personId, owedMinor: 1000, oweMinor: 1000 });
  const sam = await repo.savePerson(db, 'Sam');
  await saveSharedExpensePosting(db, { title: 'They shared without you', totalAmountMinor: 1000, categoryId: 'cat_expense_food', accountId: cashId, occurredOn: todayLocal(), groupId, payerIsSelf: false, payerPersonId: sam, shares: [{ name: 'Ali', personId, isSelf: false, shareMinor: 1000 }] });
  expect((await readGroupSnapshot(db, groupId)).positions).toEqual(snapshot.positions);
});

test.each(['person_entries', 'entry_allocations', 'group_settlement_requests'])('SQLite failure at %s rolls back the complete new settlement', async (table) => {
  const target = (await bill()).personEntries[0].id;
  const before = await money();
  const input = await settlement(target);
  sqlite.exec(`CREATE TRIGGER injected BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected'); END;`);
  await expect(settleGroup(db, input)).rejects.toThrow('injected');
  expect(await money()).toEqual(before);
  expect(await db.getAllAsync('SELECT * FROM entry_allocations;')).toEqual([]);
  expect(await db.getAllAsync('SELECT * FROM group_settlement_requests;')).toEqual([]);
  sqlite.exec('DROP TRIGGER injected;');
  await settleGroup(db, input);
  expect(groupPositionLabel(await readGroupSnapshot(db, groupId))).toBe('Settled');
});

test('allocated shared edits/deletes and source/target mutation cannot invalidate metadata', async () => {
  const plan = await bill();
  const target = plan.personEntries[0].id;
  const source = await cash('RECEIVED_BACK');
  await allocate(source, target, 500);
  const before = await money();
  const split = (await repo.listSplitGroups(db))[0];
  await expect(deleteSharedExpense(db, split.id, split.updated_at)).rejects.toThrow('reconciled');
  await expect(updateSharedExpense(db, split.id, split.updated_at, { title: 'Changed', totalAmountMinor: 2000, categoryId: split.category_id, accountId: cashId, occurredOn: todayLocal(), payerIsSelf: true, shares: [{ name: 'You', isSelf: true, shareMinor: 1000 }, { name: 'Ali', personId, isSelf: false, shareMinor: 1000 }] })).rejects.toThrow('reconciled');
  for (const id of [source, target]) {
    expect(() => sqlite.prepare('UPDATE person_entries SET amount_minor = 1 WHERE id = ?').run(id)).toThrow();
    expect(() => sqlite.prepare("UPDATE person_entries SET deleted_at = 'now' WHERE id = ?").run(id)).toThrow();
    expect(() => sqlite.prepare('DELETE FROM person_entries WHERE id = ?').run(id)).toThrow();
  }
  expect(() => sqlite.exec('UPDATE entry_allocations SET amount_minor = 1')).toThrow();
  expect(() => sqlite.exec('DELETE FROM entry_allocations')).toThrow();
  expect(() => sqlite.prepare('DELETE FROM split_participants WHERE split_group_id = ?').run(split.id)).toThrow();
  expect(await money()).toEqual(before);
});

test('unallocated shared mutations coexist safely and keep standalone cash metadata unguessed', async () => {
  const plan = await bill();
  const source = await cash('RECEIVED_BACK', 500);
  const split = (await repo.listSplitGroups(db))[0];
  await deleteSharedExpense(db, split.id, split.updated_at);
  expect((await repo.listPersonEntries(db)).map((e) => e.id)).toEqual([source]);
  expect(await db.getAllAsync('SELECT * FROM entry_allocations;')).toEqual([]);
  expect(await db.getAllAsync('SELECT * FROM allocation_targets WHERE id = ?;', plan.personEntries[0].id)).toEqual([]);
  const standalone = (await bill(true, 500, null)).personEntries[0].id;
  await allocate(source, standalone, 500);
  expect((await readGroupSnapshot(db, groupId)).targets).toEqual([]);
});

test('rename, member removal, inline creation and archive preserve historical identities and money', async () => {
  await bill();
  const before = await money();
  const snapshot = await readGroupSnapshot(db, groupId);
  await saveGroupDetails(db, { id: groupId, expectedUpdatedAt: snapshot.group.updated_at, name: 'Renamed', personIds: [], newNames: ['Sam'] });
  const changed = await readGroupSnapshot(db, groupId);
  expect(changed.group.name).toBe('Renamed');
  expect(changed.members.map((m) => m.name).sort()).toEqual(['Sam', 'You']);
  expect(changed.participants).toEqual(snapshot.participants);
  expect(changed.positions.find((p) => p.personId === personId)?.owedMinor).toBe(1000);
  expect(await money()).toEqual(before);
  await expect(saveGroupDetails(db, { id: groupId, expectedUpdatedAt: snapshot.group.updated_at, name: 'Stale', personIds: [] })).rejects.toThrow('changed');
  await archiveGroup(db, groupId, changed.group.updated_at);
  expect(await repo.listGroups(db)).toEqual([]);
  expect(await repo.listGroups(db, true)).toHaveLength(1);
  expect((await readGroupSnapshot(db, groupId)).expenses).toEqual(snapshot.expenses);
  await expect(bill()).rejects.toThrow('archived');
  await expect(settleGroup(db, await settlement(snapshot.targets[0].id))).rejects.toThrow('archived');
  expect(await money()).toEqual(before);
});

test('duplicate/invalid members reject and failed group creation rolls back inline People', async () => {
  await expect(saveGroupDetails(db, { name: 'Duplicate', personIds: [personId, personId] })).rejects.toThrow('once');
  const before = await repo.listAllPeople(db);
  await expect(saveGroupDetails(db, { name: 'Invalid', personIds: ['missing'], newNames: ['Must roll back'] })).rejects.toThrow('active person');
  expect(await repo.listAllPeople(db)).toEqual(before);
  await expect(saveGroupDetails(db, { name: 'Duplicate names', personIds: [], newNames: ['New', 'new'] })).rejects.toThrow('once');
  expect(await repo.listAllPeople(db)).toEqual(before);
});

test('demo clear/reset retains allocation-linked complete events and user-managed membership/archive', async () => {
  await loadComprehensiveDemoData(db);
  const demo = await readGroupSnapshot(db, 'demo_group_murree_trip');
  const target = demo.targets.find((t) => t.person_id === personId && t.direction === 1)!;
  const source = await cash('BORROWED_FROM', 100);
  await allocate(source, target.id, 100);
  await saveGroupDetails(db, { id: demo.group.id, expectedUpdatedAt: demo.group.updated_at, name: 'My renamed trip', personIds: [] });
  const changed = await readGroupSnapshot(db, demo.group.id);
  await archiveGroup(db, demo.group.id, changed.group.updated_at);
  const before = await readGroupSnapshot(db, demo.group.id);
  await clearDemoData(db);
  expect(await readGroupSnapshot(db, demo.group.id)).toEqual(before);
  await loadComprehensiveDemoData(db);
  expect(await readGroupSnapshot(db, demo.group.id)).toEqual(before);
  expect(await db.getAllAsync('SELECT * FROM entry_allocations WHERE target_entry_id = ?;', target.id)).toHaveLength(1);
});

test('metadata reconciliation idempotency rejects key reuse with changed contents', async () => {
  const target = (await bill()).personEntries[0].id;
  const source = await cash('RECEIVED_BACK');
  await allocate(source, target, 500, 'stable');
  await allocate(source, target, 500, 'stable');
  await expect(allocate(source, target, 400, 'stable')).rejects.toThrow('different details');
  expect(await db.getAllAsync('SELECT * FROM entry_allocations;')).toHaveLength(1);
});

test.each(['groups', 'people', 'accounts'])('reconciled %s cannot be deleted or hidden behind allocation metadata', async (table) => {
  const target = (await bill()).personEntries[0].id;
  const source = await cash('RECEIVED_BACK');
  await allocate(source, target);
  const id = table === 'groups' ? groupId : table === 'people' ? personId : cashId;
  expect(() => sqlite.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id)).toThrow();
  expect(() => sqlite.prepare(`UPDATE ${table} SET deleted_at = 'now' WHERE id = ?`).run(id)).toThrow();
  expect(groupPositionLabel(await readGroupSnapshot(db, groupId))).toBe('Settled');
});

test('missing original obligations or conflicting shared event links are shown as invalid, never settled by guessing', async () => {
  const plan = await bill();
  await db.runAsync('DELETE FROM person_entries WHERE id = ?;', plan.personEntries[0].id);
  const snapshot = await readGroupSnapshot(db, groupId);
  expect(snapshot.invalidHistory).toBe(true);
  expect(groupPositionLabel(snapshot)).toBe('Reconciliation needed');
  await expect(settleGroup(db, await settlement(plan.personEntries[0].id))).rejects.toThrow('Reconciliation needed');
});

test('shared event-linked cash is not an independent source, and archived account history can reconcile without new cash', async () => {
  const plan = await bill();
  const source = await cash('RECEIVED_BACK');
  await db.runAsync('UPDATE person_entries SET financial_event_id = ? WHERE id = ?;', plan.splitGroup.financial_event_id, source);
  await expect(allocate(source, plan.personEntries[0].id)).rejects.toThrow();
  await db.runAsync('UPDATE person_entries SET financial_event_id = NULL WHERE id = ?;', source);
  await db.runAsync('UPDATE accounts SET is_archived = 1 WHERE id = ?;', cashId);
  await allocate(source, plan.personEntries[0].id);
  expect(groupPositionLabel(await readGroupSnapshot(db, groupId))).toBe('Settled');
});

test('new settlement rejects missing/archived account, archived Person, wrong Person and invalid date without cash', async () => {
  const target = (await bill()).personEntries[0].id;
  const input = await settlement(target);
  const before = await money();
  await expect(settleGroup(db, { ...input, accountId: 'missing' })).rejects.toThrow('active account');
  await expect(settleGroup(db, { ...input, occurredOn: '2026-02-31' })).rejects.toThrow('valid');
  await expect(settleGroup(db, { ...input, personId: 'missing' })).rejects.toThrow();
  await db.runAsync('UPDATE accounts SET is_archived = 1 WHERE id = ?;', cashId);
  await expect(settleGroup(db, input)).rejects.toThrow('active account');
  await db.runAsync('UPDATE accounts SET is_archived = 0 WHERE id = ?;', cashId);
  await db.runAsync('UPDATE people SET is_archived = 1 WHERE id = ?;', personId);
  await expect(settleGroup(db, input)).rejects.toThrow('archived');
  await db.runAsync('UPDATE people SET is_archived = 0 WHERE id = ?;', personId);
  expect(await money()).toEqual(before);
});

test('crossing global zero requires explicit confirmation while retaining original repayment classification', async () => {
  const target = (await bill(true, 1000)).personEntries[0].id;
  const loan = await cash('BORROWED_FROM', 500);
  await setAllocationUnrelated(db, loan, target, true);
  const before = await money();
  const input = await settlement(target);
  await expect(settleGroup(db, input)).rejects.toThrow('Confirm');
  expect(await money()).toEqual(before);
  const source = await settleGroup(db, { ...input, crossingConfirmed: true });
  expect((await repo.listPersonEntries(db)).find((e) => e.id === source)?.type).toBe('RECEIVED_BACK');
  expect((await money()).global).toBe(-500);
});

test('invalid historical cash amounts cannot hide behind an integer global sum', async () => {
  const target = (await bill()).personEntries[0].id;
  await cash('GIVEN', 0.5);
  await cash('GIVEN', 0.5);
  const before = await money();
  expect(before.global).toBe(1001);
  await expect(settleGroup(db, await settlement(target))).rejects.toThrow('invalid historical amounts');
  expect(await money()).toEqual(before);
});

test('exclusion-only reconciliation retains demo sources, original obligations and remaining ambiguity across clear/reset', async () => {
  await loadComprehensiveDemoData(db);
  const demoId = 'demo_group_murree_trip';
  const target = (await readGroupSnapshot(db, demoId)).targets.find((t) => t.person_id === personId && t.expense_title === 'Murree Hotel')!;
  await setAllocationUnrelated(db, 'demo_entry_ali_002', target.id, true);
  const before = await readGroupSnapshot(db, demoId);
  expect(before.ambiguous).toBe(true); // Snacks are a separate unresolved obligation.
  await clearDemoData(db);
  expect(await readGroupSnapshot(db, demoId)).toEqual(before);
  await loadComprehensiveDemoData(db);
  expect(await readGroupSnapshot(db, demoId)).toEqual(before);
  expect(await db.getAllAsync('SELECT * FROM entry_allocations;')).toEqual([]);
});

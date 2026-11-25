/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as SQLite from 'expo-sqlite';
import { openAppDatabase, type AppDb } from '../database/database';
import { clearDemoData, loadComprehensiveDemoData } from './fixtures/demoData';
import * as repo from '../database/repositories/repositories';
import { BackupService } from '../services/backup/BackupService';
import { BACKUP_TABLES, type Backup } from '../services/backup/BackupFormat';
import { archiveGroup, buildGroupNetSettlement, readGroupSnapshot, reconcileAllocation, restoreGroup, saveGroupDetails, setAllocationUnrelated, settleGroup } from '../services/groups/GroupService';
import { archiveAccount, listArchivedAccounts, restoreAccount } from '../services/accounts/AccountService';
import { calculateAccountBalance } from '../services/finance/FinanceService';
import { calculatePersonBalance } from '../services/people/PeopleBalanceService';
import { coordinateRestore } from '../services/backup/RestoreCoordinator';
import { calculateSplit, type SplitMethod } from '../services/split/SplitService';
import { decodeSplitDefinition } from '../services/split/SplitDefinition';
import { readSharedEvent, type SharedEventRecords } from '../services/activity/ActivityService';
import { todayLocal, addDays } from '../utils/date';
import { removeMigration11ForFixture, removeMigration12ForFixture, stripScheduleProvenanceForFixture } from './schemaFixtures';
import { deleteSharedExpense, reopenSharedExpenseInput, saveSharedExpensePosting, updateSharedExpense } from '../services/sharedExpense/SharedExpenseService';
import { calculateSharedBill } from '../services/split/SharedBillCalculation';
import { queueAppReminderReconciliation } from '../services/notifications/NotificationService';
import { reminderNative, reminderPlan } from './reminderFixtures';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
let directory: string;
let main: DatabaseSync;
let db: AppDb;
let service: BackupService;
let failure: ((sql: string) => boolean) | undefined;
const clock = () => '2026-09-16T12:00:00.000Z';
function adapter(sqlite: DatabaseSync, inject = false): AppDb {
  const exec = async (sql: string) => { if (inject && failure?.(sql)) throw new Error('injected restore failure'); sqlite.exec(sql); };
  const transaction = async (work: () => Promise<void>) => {
    sqlite.exec('BEGIN');
    try { await work(); sqlite.exec('COMMIT'); } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  };
  const result = {
    execAsync: exec,
    runAsync: async (sql: string, ...params: (string | number | null)[]) => { if (inject && failure?.(sql)) throw new Error('injected restore failure'); return sqlite.prepare(sql).run(...params); },
    getAllAsync: async (sql: string, ...params: (string | number | null)[]) => { if (inject && failure?.(sql)) throw new Error('injected restore failure'); return sqlite.prepare(sql).all(...params); },
    getFirstAsync: async (sql: string, ...params: (string | number | null)[]) => { if (inject && failure?.(sql)) throw new Error('injected restore failure'); return sqlite.prepare(sql).get(...params) ?? null; },
    closeAsync: async () => { sqlite.close(); },
    withTransactionAsync: transaction,
    withExclusiveTransactionAsync: async (work: (txn: AppDb) => Promise<void>) => transaction(() => work(result as unknown as AppDb)),
  };
  return result as unknown as AppDb;
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'opencode', 'backup-integration-'));
  const path = join(directory, 'data.db');
  main = new DatabaseSync(path);
  db = adapter(main);
  failure = undefined;
  jest.mocked(SQLite.openDatabaseAsync).mockResolvedValue(db);
  await openAppDatabase();
  await loadComprehensiveDemoData(db);
  const planned = (await repo.listPlannedPayments(db))[0];
  await repo.markPlannedPaymentPaid(db, planned.id, planned.next_due_date);
  const subscription = (await repo.listSubscriptions(db)).find((s) => s.status === 'ACTIVE')!;
  await repo.markSubscriptionPaid(db, subscription.id, subscription.next_renewal_date, subscription.updated_at);
  const target = (await db.getAllAsync<{ id: string; person_id: string; group_id: string }>('SELECT * FROM allocation_targets WHERE direction = 1 AND group_id IS NOT NULL'))[0];
  const source = await repo.savePersonEntry(db, { person_id: target.person_id, account_id: 'account_cash_default', type: 'RECEIVED_BACK', amount_minor: 100, title: 'Backup partial receipt', occurred_on: '2026-09-16' });
  await reconcileAllocation(db, { id: 'backup_allocation', sourceEntryId: source, targetEntryId: target.id, amountMinor: 25 });
  await setAllocationUnrelated(db, source, target.id, true);
  const settlementSource = await repo.savePersonEntry(db, { person_id: target.person_id, account_id: 'account_cash_default', type: 'RECEIVED_BACK', amount_minor: 20, title: 'Backup group receipt', occurred_on: '2026-09-16' });
  await reconcileAllocation(db, { id: 'backup_settlement_allocation', sourceEntryId: settlementSource, targetEntryId: target.id, amountMinor: 20 });
  await db.runAsync('INSERT INTO group_settlement_requests (id, request_json, group_id, source_entry_id, created_at) VALUES (?, ?, ?, ?, ?)',
    'backup_request', JSON.stringify({ requestId: 'backup_request', groupId: target.group_id, personId: target.person_id, accountId: 'account_cash_default', occurredOn: '2026-09-16', expectedRevision: 'historical snapshot', expectedBalanceMinor: 0, targets: [{ targetEntryId: target.id, amountMinor: 20 }] }), target.group_id, settlementSource, clock());
  await db.runAsync("UPDATE people SET is_archived = 1 WHERE id = ?", target.person_id);
  await db.runAsync("UPDATE budgets SET ownership = 'USER' WHERE id = (SELECT id FROM budgets LIMIT 1)");
  service = new BackupService({ now: clock, open: async (staging) => adapter(new DatabaseSync(staging ? ':memory:' : path, { enableForeignKeyConstraints: false }), !staging) });
});
afterEach(() => { main.close(); rmSync(directory, { recursive: true, force: true }); });

async function modernFixture(method: SplitMethod = 'Exact', commonCostMinor = 2000, userPaid = 2000) {
  const ids = [];
  for (const name of ['F payer', 'F participant', 'F other participant']) ids.push(await repo.savePerson(db, name));
  const participants = [{ key: 'SELF', name: 'You', isSelf: true }, ...ids.map((id, index) => ({ key: `PERSON:${id}`, personId: id, name: ['F payer', 'F participant', 'F other participant'][index], isSelf: false }))];
  const common = method === 'Exact' ? commonCostMinor : 0;
  const values = participants.map((_row, index) => method === 'Exact' ? String((12000 - common) / 400 + (index === 0 ? -1 : index === 1 ? 1 : 0)) : method === 'Percentage' ? '25' : method === 'Shares' ? '1' : '');
  const payers = [{ identity: 'SELF', paidMinor: userPaid }, { identity: `PERSON:${ids[0]}`, paidMinor: 12000 - userPaid }];
  const result = calculateSharedBill({ totalMinor: 12000, method, participants, values: Object.fromEntries(participants.map((row, index) => [row.key, values[index]])), commonCostMinor: common, payers });
  const plan = await saveSharedExpensePosting(db, { title: 'F modern compatibility', totalAmountMinor: 12000, categoryId: 'cat_expense_food', accountId: 'account_cash_default', occurredOn: todayLocal(), payerIsSelf: true, shares: result.shares, payers, editor: { method, values, commonCostMinor: common } });
  return { plan, ids, participants };
}

const corruptModern: [string, (definition: any) => void][] = [
  ['under-funded contributions', definition => { definition.payers[0].paidMinor--; }],
  ['over-funded contributions', definition => { definition.payers[0].paidMinor++; }],
  ['malformed payer identity', definition => { definition.payers[0].identity = 'You'; }],
  ['duplicate payer', definition => { definition.payers[1].identity = definition.payers[0].identity; }],
  ['negative contribution', definition => { definition.payers[0].paidMinor = -1; definition.payers[1].paidMinor = 12001; }],
  ['fractional common cost', definition => { definition.commonCostMinor = 0.5; }],
  ['negative common cost', definition => { definition.commonCostMinor = -1; }],
  ['text common cost', definition => { definition.commonCostMinor = '2000'; }],
  ['inconsistent Exact source', definition => { definition.participants[0].value = '26'; }],
  ['missing participant identity', definition => { definition.participants[0].identity = 'PERSON:missing'; }],
  ['duplicate participant identity', definition => { definition.participants[1].identity = definition.participants[0].identity; }],
  ['invalid participant order', definition => { const identities = definition.participants.map((row: { identity: string }) => row.identity).reverse(); definition.participants.forEach((row: { identity: string }, index: number) => { row.identity = identities[index]; }); }],
  ['invalid route direction', definition => { [definition.routes[0].from, definition.routes[0].to] = [definition.routes[0].to, definition.routes[0].from]; }],
  ['route to missing identity', definition => { definition.routes[0].to = 'PERSON:missing'; }],
  ['inconsistent route total', definition => { definition.routes[0].amountMinor++; }],
  ['custom route exceeds capacity', definition => { definition.customUserSettlement = [{ identity: definition.participants[2].identity, amountMinor: 3500 }, { identity: definition.participants[3].identity, amountMinor: 600 }]; }],
  ['unsupported shared metadata version', definition => { definition.version = 3; }],
];
test.each(corruptModern)('F malformed %s fails staging before replacement and leaves exact schema/data intact', async (_name, corrupt) => {
  const { plan } = await modernFixture('Exact', 2000, _name === 'custom route exceeds capacity' ? 7000 : 2000);
  const backup = JSON.parse(await service.export()) as Backup;
  const split = backup.data.split_groups.find(row => row.id === plan.splitGroup.id)!;
  const definition = JSON.parse(String(split.split_definition));
  corrupt(definition); split.split_definition = JSON.stringify(definition);
  const selected = JSON.stringify(backup); const before = await snapshot(); const safety = jest.fn();
  await expect(service.preview(selected)).rejects.toThrow();
  await expect(service.restore(selected, safety)).rejects.toThrow();
  expect(safety).not.toHaveBeenCalled(); expect(await snapshot()).toEqual(before);
  expect(JSON.stringify(backup)).toBe(selected);
});

test.each([null, false])('F malformed zero common cost %s is rejected rather than normalized silently', async common => {
  const { plan } = await modernFixture('Equal', 0); const backup = JSON.parse(await service.export()) as Backup;
  const split = backup.data.split_groups.find(row => row.id === plan.splitGroup.id)!;
  const definition = JSON.parse(String(split.split_definition)); definition.commonCostMinor = common; split.split_definition = JSON.stringify(definition);
  const before = await snapshot(); const safety = jest.fn();
  await expect(service.restore(JSON.stringify(backup), safety)).rejects.toThrow();
  expect(safety).not.toHaveBeenCalled(); expect(await snapshot()).toEqual(before);
});

test.each(['Equal', 'Exact', 'Percentage', 'Shares'] as SplitMethod[])('F modern %s source/shares/contributions/routes survive exact export/restore', async method => {
  const { plan } = await modernFixture(method); const before = await readSharedEvent(db, plan.splitGroup.id); const text = await service.export();
  await service.preview(text); await service.restore(text, async () => {});
  expect(await service.export()).toBe(text); expect(await readSharedEvent(db, plan.splitGroup.id)).toEqual(before);
});

test('F modern custom/common bill plus confirmed offset/payment and archived Group round-trips complete original history', async () => {
  const { ids, participants } = await modernFixture();
  const groupId = await saveGroupDetails(db, { name: 'F custom offset archive', personIds: ids });
  const first = await saveSharedExpensePosting(db, { title: 'F custom common', totalAmountMinor: 12000, categoryId: 'cat_expense_food', accountId: 'account_cash_default', occurredOn: todayLocal(), groupId, payerIsSelf: true,
    shares: participants.map(row => ({ ...row, shareMinor: 3000 })), payers: [{ identity: 'SELF', paidMinor: 7000 }, { identity: `PERSON:${ids[0]}`, paidMinor: 5000 }], editor: { method: 'Exact', values: ['20', '20', '20', '20'], commonCostMinor: 4000 },
    customUserSettlement: [{ identity: `PERSON:${ids[1]}`, amountMinor: 1000 }, { identity: `PERSON:${ids[2]}`, amountMinor: 3000 }] });
  await saveSharedExpensePosting(db, { title: 'F opposite modern', totalAmountMinor: 12000, categoryId: 'cat_expense_food', accountId: '', occurredOn: todayLocal(), groupId, payerIsSelf: false,
    shares: participants.map(row => ({ ...row, shareMinor: 3000 })), payers: [{ identity: `PERSON:${ids[1]}`, paidMinor: 12000 }], editor: { method: 'Equal', values: ['', '', '', ''] }, crossingConfirmations: { [ids[1]]: 1000 } });
  const snapshot = await readGroupSnapshot(db, groupId); const net = buildGroupNetSettlement(snapshot.targets, ids[1], 2000);
  await settleGroup(db, { requestId: 'F modern offset', groupId, personId: ids[1], accountId: 'account_cash_default', occurredOn: todayLocal(), targets: net.targets, offsets: net.offsets, nettingConfirmed: true, expectedRevision: snapshot.revision, expectedBalanceMinor: -2000 });
  await archiveGroup(db, groupId, snapshot.group.updated_at);
  const before = await readGroupSnapshot(db, groupId); const original = await readSharedEvent(db, first.splitGroup.id); const text = await service.export();
  await service.preview(text); await service.restore(text, async () => {});
  expect(await service.export()).toBe(text); expect(await readGroupSnapshot(db, groupId)).toEqual(before); expect(canonicalSharedRows(await readSharedEvent(db, first.splitGroup.id))).toEqual(canonicalSharedRows(original));
  expect(before.invalidHistory).toBe(false); expect(before.offsets).toHaveLength(1);
});

test.each([8, 9, 10, 11, 12] as const)('F schema-%i legacy shared history imports unchanged, safely reopens, edits and deletes only its own event', async schemaVersion => {
  const personId = await repo.savePerson(db, 'F legacy source');
  const groupId = await saveGroupDetails(db, { name: 'F legacy group', personIds: [personId] });
  const plan = await saveSharedExpensePosting(db, { title: 'F original legacy', totalAmountMinor: 12000, categoryId: 'cat_expense_food', accountId: 'account_cash_default', occurredOn: '2026-09-01', groupId, payerIsSelf: true,
    shares: [{ name: 'You', isSelf: true, shareMinor: 3000 }, { name: 'F legacy source', personId, isSelf: false, shareMinor: 9000 }], editor: { method: 'Percentage', values: ['25', '75'] } });
  const original = await readSharedEvent(db, plan.splitGroup.id); const backup = JSON.parse(await service.export()) as Backup; backup.schemaVersion = schemaVersion;
  stripScheduleProvenanceForFixture(backup);
  if (schemaVersion < 12) for (const row of [...backup.data.transactions, ...backup.data.person_entries]) delete row.cash_effect_minor;
  if (schemaVersion < 10) for (const row of backup.data.split_groups) delete row.split_definition;
  await service.preview(JSON.stringify(backup)); await service.restore(JSON.stringify(backup), async () => {});
  const imported = await readSharedEvent(db, plan.splitGroup.id);
  expect(imported).toEqual({ ...original, split: { ...original.split, split_definition: schemaVersion < 10 ? null : original.split.split_definition } });
  const input = reopenSharedExpenseInput(imported);
  expect(input.payers).toBeUndefined(); expect(input.customUserSettlement).toBeUndefined(); expect(input.editor?.commonCostMinor ?? 0).toBe(0);
  expect(input.editor?.method ?? 'Exact').toBe(schemaVersion < 10 ? 'Exact' : 'Percentage');
  const unrelated = (await repo.listPersonEntries(db)).filter(row => row.split_group_id !== imported.split.id);
  await updateSharedExpense(db, imported.split.id, imported.split.updated_at, { ...input, title: 'F legitimate edit' });
  const edited = await readSharedEvent(db, imported.split.id);
  expect(edited.split.created_at).toBe(original.split.created_at);
  expect(edited.participants.find(row => row.is_self)?.share_minor).toBe(3000);
  expect(edited.participants.find(row => row.person_id === personId)?.share_minor).toBe(9000);
  expect(edited.transactions[0].amount_minor).toBe(3000);
  await archiveGroup(db, groupId, (await readGroupSnapshot(db, groupId)).group.updated_at);
  const locked = await snapshot(); await expect(deleteSharedExpense(db, edited.split.id, edited.split.updated_at)).rejects.toThrow('archived'); expect(await snapshot()).toEqual(locked);
  await restoreGroup(db, groupId, (await readGroupSnapshot(db, groupId)).group.updated_at);
  await deleteSharedExpense(db, edited.split.id, edited.split.updated_at);
  expect((await repo.listPersonEntries(db)).filter(row => row.split_group_id !== imported.split.id)).toEqual(unrelated);
  expect((await repo.listSplitGroups(db)).some(row => row.id === imported.split.id)).toBe(false);
});

function canonicalSharedRows(records: SharedEventRecords) {
  const ordered = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
  return { ...records, participants: ordered(records.participants), entries: ordered(records.entries), transactions: ordered(records.transactions) };
}

test.each([[0, true], [2000, true], [8000, true], [5000, false]])('schema-12 multi-payer paid %i/self consumption %s restores exact financial rows and source inputs', async (paid, includeSelf) => {
  const personId = await repo.savePerson(db, 'Modern backup payer');
  const shares = [...(includeSelf ? [{ name: 'You', isSelf: true, shareMinor: 6000 }] : []), { name: 'Modern backup payer', personId, isSelf: false, shareMinor: includeSelf ? 6000 : 12000 }];
  const plan = await saveSharedExpensePosting(db, { title: 'Modern round trip', totalAmountMinor: 12000, categoryId: 'cat_expense_food', accountId: paid ? 'account_cash_default' : '', occurredOn: todayLocal(), payerIsSelf: paid > 0, shares,
    payers: [{ identity: 'SELF', paidMinor: paid }, { identity: `PERSON:${personId}`, paidMinor: 12000 - paid }], editor: { method: 'Exact', values: includeSelf ? ['50', '50'] : ['100'], commonCostMinor: 2000 } });
  const before = await readSharedEvent(db, plan.splitGroup.id);
  const text = await service.export();
  await service.preview(text);
  await service.restore(text, async () => {});
  expect(await service.export()).toBe(text);
  expect(await readSharedEvent(db, plan.splitGroup.id)).toEqual(before);
  for (const corrupt of ['cash', 'route', 'payer', 'classification'] as const) {
    const backup = JSON.parse(text) as Backup;
    const split = backup.data.split_groups.find(row => row.id === plan.splitGroup.id)!;
    const definition = JSON.parse(String(split.split_definition));
    if (corrupt === 'cash') {
      const row = backup.data.transactions.find(row => row.group_id === split.id) ?? backup.data.person_entries.find(row => row.split_group_id === split.id)!;
      row.cash_effect_minor = -1;
    } else if (corrupt === 'route') definition.routes[0].amountMinor++;
    else if (corrupt === 'payer') definition.payers[1].identity = 'PERSON:missing';
    else definition.classifications[0].type = 'INVALID';
    split.split_definition = JSON.stringify(definition);
    const rows = await snapshotRows(); const safety = jest.fn();
    await expect(service.restore(JSON.stringify(backup), safety)).rejects.toThrow();
    expect(safety).not.toHaveBeenCalled(); expect(await snapshotRows()).toEqual(rows);
  }
});

test('migration 12 preserves exact legacy rows, null cash semantics, views and rollback on failure', async () => {
  const rows = await snapshotRows();
  await removeMigration12ForFixture(db);
  const before = await snapshot(); const run = db.runAsync.bind(db);
  const fail = jest.spyOn(db, 'runAsync').mockImplementation(async (sql, ...params) => { if (sql.includes('INSERT INTO schema_migrations') && params[0] === 12) throw new Error('migration 12 failure'); return run(sql, ...params); });
  await expect(openAppDatabase()).rejects.toThrow('migration 12 failure'); fail.mockRestore();
  expect(await snapshot()).toEqual(before);
  await openAppDatabase(); expect(await snapshotRows()).toEqual(rows);
  await openAppDatabase(); expect(await db.getAllAsync('SELECT version FROM schema_migrations WHERE version = 12')).toEqual([{ version: 12 }]);
});

test('schema-11 backup normalizes only missing cash fields and preserves all historical accounting', async () => {
  const current = JSON.parse(await service.export()) as Backup; const rows = await snapshotRows();
  current.schemaVersion = 11;
  stripScheduleProvenanceForFixture(current);
  for (const row of [...current.data.transactions, ...current.data.person_entries]) delete row.cash_effect_minor;
  await service.restore(JSON.stringify(current), async () => {});
  const restored = await snapshotRows();
  const settingsIndex = BACKUP_TABLES.indexOf('app_settings');
  expect(restored[settingsIndex]).toContainEqual({ key: 'local_backup_restored', value: 'true' });
  restored[settingsIndex] = restored[settingsIndex].filter(row => (row as { key?: string }).key !== 'local_backup_restored');
  expect(restored).toEqual(rows);
});

test.each([0, 7000])('confirmed offset plus %i real cash survives archive/backup/restore with exact metadata', async (cashMinor) => {
  const personId = await repo.savePerson(db, 'Net backup person');
  const groupId = await saveGroupDetails(db, { name: 'Net backup group', personIds: [personId], includeSelf: false });
  for (const [selfPaid, share] of [[true, cashMinor ? 10000 : 3000], [false, 3000]] as const) await repo.saveSplit(db, { title: selfPaid ? 'Hotel' : 'Dinner', total_amount_minor: share * 2, category_id: 'cat_expense_food', account_id: 'account_cash_default', occurred_on: todayLocal(), group_id: groupId, payer_is_self: selfPaid, payer_person_id: selfPaid ? null : personId, shares: [{ name: 'You', isSelf: true, shareMinor: share }, { name: 'Net backup person', personId, isSelf: false, shareMinor: share }] });
  const snapshot = await readGroupSnapshot(db, groupId);
  const plan = buildGroupNetSettlement(snapshot.targets, personId, cashMinor);
  await settleGroup(db, { requestId: 'net-backup-request', groupId, personId, accountId: cashMinor ? 'account_cash_default' : '', occurredOn: todayLocal(), targets: plan.targets, offsets: plan.offsets, nettingConfirmed: true, expectedRevision: snapshot.revision, expectedBalanceMinor: cashMinor, note: 'Explicit offset' });
  await archiveGroup(db, groupId, snapshot.group.updated_at);
  const before = await readGroupSnapshot(db, groupId);
  const text = await service.export();
  await service.preview(text);
  await service.restore(text, async () => {});
  expect(await service.export()).toBe(text);
  expect(await readGroupSnapshot(db, groupId)).toEqual(before);
  const malformed = JSON.parse(text) as Backup;
  const request = malformed.data.group_settlement_requests.find((row) => row.id === 'net-backup-request')!;
  const definition = JSON.parse(String(request.request_json)); definition.offsets[0].amountMinor++;
  request.request_json = JSON.stringify(definition);
  const state = await snapshotRows();
  const safety = jest.fn();
  await expect(service.restore(JSON.stringify(malformed), safety)).rejects.toThrow('offset');
  expect(safety).not.toHaveBeenCalled();
  expect(await snapshotRows()).toEqual(state);
});

async function snapshotRows() {
  return Promise.all(BACKUP_TABLES.map(async (table) => {
    const columns = await db.getAllAsync<{ name: string; pk: number }>(`PRAGMA table_info(${table})`);
    const order = columns.filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => `"${column.name}"`).join(',');
    return db.getAllAsync(`SELECT * FROM ${table} ORDER BY ${order}`);
  }));
}

test('schema-10 backup remains compatible; migration 11 upgrades exact rows and rolls back its views/guards on failure', async () => {
  const legacy = JSON.parse(await service.export()) as Backup;
  legacy.schemaVersion = 10;
  stripScheduleProvenanceForFixture(legacy);
  for (const row of [...legacy.data.transactions, ...legacy.data.person_entries]) delete row.cash_effect_minor;
  await service.preview(JSON.stringify(legacy));
  await service.restore(JSON.stringify(legacy), async () => {});
  const rows = await snapshotRows();
  await removeMigration11ForFixture(db);
  const before = await snapshot();
  const run = db.runAsync.bind(db);
  const fail = jest.spyOn(db, 'runAsync').mockImplementation(async (sql, ...params) => { if (sql.includes('INSERT INTO schema_migrations') && params[0] === 11) throw new Error('migration 11 failure'); return run(sql, ...params); });
  await expect(openAppDatabase()).rejects.toThrow('migration 11 failure');
  fail.mockRestore();
  expect(await snapshot()).toEqual(before);
  await openAppDatabase();
  expect(await snapshotRows()).toEqual(rows);
  await openAppDatabase();
  expect(await db.getAllAsync('SELECT version FROM schema_migrations WHERE version = 11')).toEqual([{ version: 11 }]);
});

test('metadata lifecycle round-trips deleted category history and same-ID restored accounts/groups', async () => {
  await repo.createCategory(db, { name: 'Deleted historical meal', type: 'EXPENSE' });
  const category = (await repo.listCategories(db)).find((row) => row.name === 'Deleted historical meal')!;
  await repo.saveTransaction(db, { type: 'EXPENSE', amount_minor: 100, account_id: 'account_cash_default', category_id: category.id, title: 'Preserved meal', occurred_on: todayLocal(), source: 'MANUAL' });
  await repo.deleteCategory(db, category.id, category.updated_at);
  await repo.createAccount(db, { name: 'Restore round trip', type: 'BANK', opening_balance_minor: 0 });
  const account = (await repo.listAccounts(db)).find((row) => row.name === 'Restore round trip')!;
  await archiveAccount(db, account.id, account.updated_at);
  await restoreAccount(db, account.id, (await listArchivedAccounts(db)).find((row) => row.id === account.id)!.updated_at);
  const group = (await repo.listGroups(db))[0];
  await archiveGroup(db, group.id, group.updated_at);
  await restoreGroup(db, group.id, (await readGroupSnapshot(db, group.id)).group.updated_at);
  const text = await service.export();
  await service.preview(text);
  await service.restore(text, async () => {});
  expect(await service.export()).toBe(text);
  expect((await repo.listCategories(db)).find((row) => row.id === category.id)).toMatchObject({ is_archived: 1, deleted_at: null });
  expect((await repo.listTransactions(db)).find((row) => row.title === 'Preserved meal')?.category_id).toBe(category.id);
  expect((await repo.listAccounts(db)).some((row) => row.id === account.id)).toBe(true);
  expect((await repo.listGroups(db)).some((row) => row.id === group.id)).toBe(true);
});

test.each(['Equal', 'Exact', 'Percentage', 'Shares'] as SplitMethod[])('schema-10 %s definition survives exact backup/restore round trip', async (method) => {
  const personId = await repo.savePerson(db, 'Method fixture');
  const participants = [{ key: 'SELF', name: 'You', isSelf: true }, { key: `PERSON:${personId}`, name: 'Method fixture', personId, isSelf: false }];
  const values = method === 'Exact' ? ['60', '60'] : method === 'Percentage' ? ['25', '75'] : method === 'Shares' ? ['1', '3'] : ['', ''];
  const shares = calculateSplit({ totalMinor: 12000, method, participants, values: Object.fromEntries(participants.map((p, i) => [p.key, values[i]])) }).shares;
  await repo.saveSplit(db, { title: 'Method round trip', total_amount_minor: 12000, category_id: 'cat_expense_food', account_id: 'account_cash_default', occurred_on: '2026-09-16', shares, editor: { method, values } });
  const split = (await repo.listSplitGroups(db)).find((s) => s.title === 'Method round trip')!;
  const before = await readSharedEvent(db, split.id);
  const text = await service.export();
  await service.preview(text);
  await service.restore(text, async () => {});
  expect(await readSharedEvent(db, split.id)).toEqual(before);
  const definition = decodeSplitDefinition(before.split.split_definition, 12000, before.participants)!;
  expect(definition.method).toBe(method);
  expect(Object.values(definition.values)).toEqual(values);
});

test('invalid method metadata is rejected before restore changes any user rows', async () => {
  const backup = JSON.parse(await service.export()) as Backup;
  backup.data.split_groups[0].split_definition = JSON.stringify({ version: 1, method: 'Equal', participants: [] });
  const before = await snapshot();
  await expect(service.restore(JSON.stringify(backup), async () => {})).rejects.toThrow('method metadata');
  expect(await snapshot()).toEqual(before);
});

test('early subscription payment retains independent actual/scheduled dates through validated restore', async () => {
  const today = todayLocal();
  const scheduled = addDays(today, 30);
  const id = await repo.saveSubscription(db, { name: 'Early payment round trip', amount_minor: 50000, category_id: 'cat_expense_subscriptions', account_id: 'account_cash_default', start_date: today, next_renewal_date: scheduled, frequency_type: 'MONTHLY', frequency_interval: 1, reminder_enabled: 0, reminder_days_before: 3, cancellation_reminder_enabled: 0 });
  const sub = (await repo.getSubscription(db, id))!;
  await repo.markSubscriptionPaid(db, id, scheduled, sub.updated_at);
  const before = await repo.listSubscriptionPayments(db, id);
  expect(before).toEqual([expect.objectContaining({ transaction_date: today, scheduled_date: scheduled })]);
  const text = await service.export();
  await service.preview(text);
  await service.restore(text, async () => {});
  expect(await repo.listSubscriptionPayments(db, id)).toEqual(before);
  expect(await service.export()).toBe(text);
  const invalid = JSON.parse(text) as Backup;
  invalid.data.transactions.find((row) => row.id === before[0].transaction_id)!.financial_event_id = 'wrong-event';
  const original = await snapshot();
  await expect(service.restore(JSON.stringify(invalid), async () => {})).rejects.toThrow();
  expect(await snapshot()).toEqual(original);
});

test('Equal metadata with an unused invalid value fails staging and preserves the original database', async () => {
  const personId = await repo.savePerson(db, 'Equal metadata fixture');
  await repo.saveSplit(db, { title: 'Equal metadata fixture', total_amount_minor: 12000, category_id: 'cat_expense_food', account_id: 'account_cash_default', occurred_on: '2026-09-16', shares: [{ name: 'You', isSelf: true, shareMinor: 6000 }, { name: 'Equal metadata fixture', isSelf: false, personId, shareMinor: 6000 }], editor: { method: 'Equal', values: ['', ''] } });
  const backup = JSON.parse(await service.export()) as Backup;
  const split = backup.data.split_groups.find((row) => row.title === 'Equal metadata fixture')!;
  const definition = JSON.parse(String(split.split_definition));
  definition.participants[1].value = '-1';
  split.split_definition = JSON.stringify(definition);
  const before = await snapshot();
  const safety = jest.fn();
  await expect(service.restore(JSON.stringify(backup), safety)).rejects.toThrow('method metadata');
  expect(safety).not.toHaveBeenCalled();
  expect(await snapshot()).toEqual(before);
});

test('migration 10 preserves schema-9 rows and leaves legacy intent unknown on repeated open', async () => {
  const rows = await db.getAllAsync('SELECT * FROM split_groups ORDER BY id');
  await removeMigration11ForFixture(db);
  await db.execAsync('ALTER TABLE split_groups DROP COLUMN split_definition; DELETE FROM schema_migrations WHERE version = 10;');
  await openAppDatabase();
  expect(await db.getAllAsync('SELECT * FROM split_groups ORDER BY id')).toEqual(rows);
  await openAppDatabase();
  expect(await db.getAllAsync('SELECT version FROM schema_migrations WHERE version = 10')).toEqual([{ version: 10 }]);
});

test('migration-10 failure rolls back the new column and migration record together', async () => {
  await removeMigration11ForFixture(db);
  await db.execAsync('ALTER TABLE split_groups DROP COLUMN split_definition; DELETE FROM schema_migrations WHERE version = 10;');
  const before = await snapshot();
  const insert = jest.spyOn(db, 'runAsync').mockRejectedValueOnce(new Error('migration record failure'));
  await expect(openAppDatabase()).rejects.toThrow('migration record failure');
  insert.mockRestore();
  expect(await snapshot()).toEqual(before);
  await openAppDatabase();
  expect(await db.getFirstAsync('SELECT MAX(version) version FROM schema_migrations')).toEqual({ version: 14 });
});
async function snapshot() {
  return {
    schema: await db.getAllAsync('SELECT type, name, sql FROM sqlite_schema ORDER BY type, name'),
    rows: await Promise.all([...BACKUP_TABLES, 'schema_migrations'].map(async (table) => ({ table, rows: await db.getAllAsync(`SELECT * FROM "${table}" ORDER BY rowid`) }))),
  };
}

test('versioned deterministic JSON export includes every domain table and changes no row or schema', async () => {
  const before = await snapshot();
  const text = await service.export();
  expect(await service.export()).toBe(text);
  const backup: Backup = JSON.parse(text);
  expect(backup.backupVersion).toBe(1);
  expect(backup.schemaVersion).toBe(14);
  expect(Object.keys(backup.data)).toEqual([...BACKUP_TABLES]);
  expect(backup.data.entry_allocations[0].amount_minor).toBe(25);
  expect(backup.data.planned_payment_occurrences).toHaveLength(2);
  expect(backup.data.subscription_payments).toHaveLength(2);
  expect(backup.data.goal_entries.length).toBeGreaterThan(0);
  expect(await snapshot()).toEqual(before);
});

test('reminder consent round-trips; native response cache is excluded and older backups do not re-prompt answered devices', async () => {
  await repo.setSetting(db, 'notifications_intro_answered', 'true'); await repo.setSetting(db, 'notifications_last_response', 'device-local-native-tap');
  const saved = JSON.parse(await service.export()) as Backup;
  expect(saved.data.app_settings).toContainEqual({ key: 'notifications_intro_answered', value: 'true' }); expect(saved.data.app_settings.some(row => row.key === 'notifications_last_response')).toBe(false);
  await service.preview(JSON.stringify(saved));
  const legacy = { ...saved, data: { ...saved.data, app_settings: saved.data.app_settings.filter(row => row.key !== 'notifications_intro_answered') } };
  await service.restore(JSON.stringify(legacy), async () => {}); expect((await repo.getSettings(db)).notifications_intro_answered).toBe('true');
  saved.data.app_settings.find(row => row.key === 'notifications_intro_answered')!.value = 'invalid'; const before = await snapshot(); const safety = jest.fn();
  await expect(service.restore(JSON.stringify(saved), safety)).rejects.toThrow('preference'); expect(safety).not.toHaveBeenCalled(); expect(await snapshot()).toEqual(before);
});
test('preferences the app writes itself (default account, activity order) export, preview and restore without being rejected', async () => {
  const cash = await db.getFirstAsync<{ id: string }>("SELECT id FROM accounts WHERE type = 'CASH' AND deleted_at IS NULL");
  await repo.setSetting(db, 'default_account_id', cash!.id); await repo.setSetting(db, 'activity_sort_order', 'CREATED');
  const saved = JSON.parse(await service.export()) as Backup;
  expect(saved.data.app_settings).toContainEqual({ key: 'default_account_id', value: cash!.id });
  expect(saved.data.app_settings).toContainEqual({ key: 'activity_sort_order', value: 'CREATED' });
  await service.preview(JSON.stringify(saved));
  await service.restore(JSON.stringify(saved), async () => {});
  const restored = await repo.getSettings(db);
  expect(restored.default_account_id).toBe(cash!.id); expect(restored.activity_sort_order).toBe('CREATED');
  const dangling = JSON.parse(JSON.stringify(saved)) as Backup; dangling.data.app_settings.find(row => row.key === 'default_account_id')!.value = 'missing-account';
  await expect(service.preview(JSON.stringify(dangling))).rejects.toThrow('default account');
  const badOrder = JSON.parse(JSON.stringify(saved)) as Backup; badOrder.data.app_settings.find(row => row.key === 'activity_sort_order')!.value = 'SIDEWAYS';
  await expect(service.preview(JSON.stringify(badOrder))).rejects.toThrow('activity order');
});
test('backup restoration reconciles new native reminders from restored actual dates with no duplicate financial posting', async () => {
  const date = addDays(todayLocal(), 10); const p = await reminderPlan(db, { next_due_date: date }); await repo.setSetting(db, 'notifications_enabled', 'true');
  const text = await service.export(); const native = reminderNative(); await queueAppReminderReconciliation(db, native.boundary);
  await repo.updatePlannedPayment(db, p.id, p.updated_at, { ...p, next_due_date: addDays(date, 10) }); await queueAppReminderReconciliation(db, native.boundary);
  const result = await coordinateRestore({ pause: async () => ({ release: () => {} }), write: () => service.restore(text, async () => {}), refresh: async () => {}, reconcile: async () => (await queueAppReminderReconciliation(db, native.boundary)).failed.length === 0 });
  expect(result.committed).toBe(true); expect(native.pending.some(item => item.identifier.includes(date))).toBe(true); expect(native.pending.some(item => item.identifier.includes(addDays(date, 10)) && item.identifier.includes(p.id))).toBe(false);
  const before = await snapshotRows(); await queueAppReminderReconciliation(db, native.boundary); expect(await snapshotRows()).toEqual(before);
});

test.each([8, 9])('Backup Format 1 restores schema-%s with unknown legacy split intent', async (schemaVersion) => {
  const current = JSON.parse(await service.export()) as Backup;
  for (const row of current.data.split_groups) delete row.split_definition;
  stripScheduleProvenanceForFixture(current);
  for (const row of [...current.data.transactions, ...current.data.person_entries]) delete row.cash_effect_minor;
  const schema8 = JSON.stringify({ ...current, schemaVersion });
  expect((await service.preview(schema8)).compatibility).toBe('Compatible with this app');
  await repo.savePerson(db, 'Removed by compatible restore');
  await service.restore(schema8, async () => {});
  expect((await repo.listAllPeople(db)).some((person) => person.name === 'Removed by compatible restore')).toBe(false);
  const restored = JSON.parse(await service.export()) as Backup;
  expect(restored.schemaVersion).toBe(14);
  expect(restored.data.split_groups.every((row) => row.split_definition === null)).toBe(true);
});

test('validated preview is read-only and counts all records', async () => {
  const text = await service.export();
  const before = await snapshot();
  const preview = await service.preview(text);
  const backup: Backup = JSON.parse(text);
  for (const table of BACKUP_TABLES) expect(preview.counts[table]).toBe(backup.data[table].length);
  expect(preview.replacement).toBe(true);
  expect(await snapshot()).toEqual(before);
});

test('full replacement preserves exact IDs, money, goals, ownership and occurrence history', async () => {
  const text = await service.export();
  const transactions = await repo.listTransactions(db);
  const entries = await repo.listPersonEntries(db);
  const balances = (await repo.listAccounts(db)).map((account) => calculateAccountBalance(account, transactions, entries));
  const peopleBalances = (await repo.listAllPeople(db)).map((person) => [person.id, calculatePersonBalance(entries.filter((e) => e.person_id === person.id))]);
  await repo.savePerson(db, 'Must disappear after restore');
  const before = await snapshot();
  const safety = jest.fn().mockResolvedValue(undefined);
  await service.restore(text, safety);
  expect(await service.export()).toBe(text);
  expect(safety).toHaveBeenCalledTimes(1);
  expect(JSON.parse(safety.mock.calls[0][0]).data.people.some((p: { name: string }) => p.name === 'Must disappear after restore')).toBe(true);
  expect((await snapshot()).schema).toEqual(before.schema);
  await expect(db.runAsync('DELETE FROM entry_allocations')).rejects.toThrow('immutable');
  await expect(db.runAsync('DELETE FROM group_settlement_requests')).rejects.toThrow('immutable');
  const restoredEntries = await repo.listPersonEntries(db);
  const restoredTransactions = await repo.listTransactions(db);
  expect((await repo.listAccounts(db)).map((account) => calculateAccountBalance(account, restoredTransactions, restoredEntries))).toEqual(balances);
  expect((await repo.listAllPeople(db)).map((person) => [person.id, calculatePersonBalance(restoredEntries.filter((e) => e.person_id === person.id))])).toEqual(peopleBalances);
  expect(await db.getFirstAsync("SELECT value FROM app_settings WHERE key = 'local_backup_restored'")).toEqual({ value: 'true' });
});

test.each(['ACTIVE', 'PAUSED', 'CANCELLED'])('historical payment restores against advanced %s final subscription without replay', async (status) => {
  await db.runAsync('UPDATE subscriptions SET status = ? WHERE id IN (SELECT subscription_id FROM subscription_payments)', status);
  const text = await service.export();
  await service.restore(text, async () => {});
  expect(await service.export()).toBe(text);
});

test('restored USER Spending Plan remains protected from Demo Clear', async () => {
  const before = await db.getAllAsync("SELECT * FROM budgets WHERE ownership = 'USER' ORDER BY id");
  expect(before.length).toBeGreaterThan(0);
  await service.restore(await service.export(), async () => {});
  await clearDemoData(db);
  expect(await db.getAllAsync("SELECT * FROM budgets WHERE ownership = 'USER' ORDER BY id")).toEqual(before);
});

test('multiple historical Subscription payments and Planned skips survive exact round-trip', async () => {
  const payment = (await repo.listSubscriptions(db)).find((s) => s.status === 'ACTIVE' && s.completed_cycles > 0)!;
  await repo.markSubscriptionPaid(db, payment.id, payment.next_renewal_date, payment.updated_at);
  const planned = (await repo.listPlannedPayments(db)).find((p) => p.status === 'ACTIVE')!;
  await repo.skipPlannedPayment(db, planned.id, planned.next_due_date);
  const text = await service.export();
  await service.restore(text, async () => {});
  expect(await service.export()).toBe(text);
  expect(JSON.parse(text).data.subscription_payments).toHaveLength(3);
  expect(JSON.parse(text).data.planned_payment_occurrences.some((o: { outcome: string }) => o.outcome === 'SKIPPED')).toBe(true);
});

test('notification failure after a real replacement cannot undo committed SQLite data', async () => {
  const text = await service.export();
  await repo.savePerson(db, 'Post-backup record');
  const result = await coordinateRestore({
    pause: async () => ({ release: () => {} }),
    write: () => service.restore(text, async () => {}),
    refresh: async () => { expect(await service.export()).toBe(text); },
    reconcile: async () => { throw new Error('OS scheduler unavailable'); },
  });
  expect(result).toEqual({ committed: true, refreshFailed: false, notificationsFailed: true });
  expect(await service.export()).toBe(text);
});

test('safety-copy failure aborts before deletion and preserves exact original state', async () => {
  const text = await service.export();
  const before = await snapshot();
  await expect(service.restore(text, async () => { throw new Error('file creation failed'); })).rejects.toThrow('file creation failed');
  expect(await snapshot()).toEqual(before);
});

test('restored exclusion and subscription posting guards still reject ordinary invalid writes', async () => {
  const text = await service.export();
  await service.restore(text, async () => {});
  await expect(db.runAsync('INSERT INTO allocation_exclusions VALUES (?, ?, ?)', 'missing_source', 'missing_target', clock())).rejects.toThrow('Invalid reconciliation choice');
  const payment = (await db.getFirstAsync<{ subscription_id: string; scheduled_date: string }>('SELECT * FROM subscription_payments'))!;
  const sub = (await repo.listSubscriptions(db)).find((s) => s.id === payment.subscription_id)!;
  const transaction = await repo.saveTransaction(db, { type: 'EXPENSE', amount_minor: 100, account_id: sub.account_id, category_id: sub.category_id, title: 'Posting guard probe', occurred_on: payment.scheduled_date, source: 'SUBSCRIPTION', financial_event_id: 'ordinary_probe' });
  await expect(db.runAsync('INSERT INTO subscription_payments (id, subscription_id, scheduled_date, transaction_id, created_at) VALUES (?, ?, ?, ?, ?)', 'ordinary_probe', sub.id, payment.scheduled_date, transaction, clock())).rejects.toThrow('Invalid subscription payment source');
});

test.each([
  ['unsupported version', (b: Backup) => { (b as unknown as { backupVersion: number }).backupVersion = 2; }],
  ['missing table', (b: Backup) => { delete (b.data as Partial<Backup['data']>).accounts; }],
  ['missing field', (b: Backup) => { delete b.data.accounts[0].name; }],
  ['duplicate ID', (b: Backup) => { b.data.accounts.push({ ...b.data.accounts[0] }); }],
  ['dangling account', (b: Backup) => { b.data.transactions[0].account_id = 'missing'; }],
  ['fractional money', (b: Backup) => { b.data.transactions[0].amount_minor = 0.1; }],
  ['unsafe money', (b: Backup) => { b.data.transactions[0].amount_minor = Number.MAX_SAFE_INTEGER + 1; }],
  ['negative expense', (b: Backup) => { b.data.transactions[0].amount_minor = -100; }],
  ['invalid enum', (b: Backup) => { b.data.accounts[0].type = 'FAKE'; }],
  ['invalid date', (b: Backup) => { b.data.transactions[0].occurred_on = '2026-02-30'; }],
  ['wrong event', (b: Backup) => { b.data.subscription_payments[0].id = 'wrong_event'; }],
  ['allocation cap', (b: Backup) => { b.data.entry_allocations[0].amount_minor = 999999999; }],
  ['dangling allocation', (b: Backup) => { b.data.entry_allocations[0].source_entry_id = 'missing'; }],
  ['invalid ownership', (b: Backup) => { b.data.budgets[0].ownership = 'UNKNOWN'; }],
  ['wrong settlement target', (b: Backup) => { b.data.group_settlement_requests[0].request_json = '{}'; }],
  ['duplicate occurrence', (b: Backup) => { b.data.planned_payment_occurrences.push({ ...b.data.planned_payment_occurrences[0], id: 'duplicate_occurrence' }); }],
  ['missing Goal', (b: Backup) => { b.data.goal_entries[0].goal_id = 'missing_goal'; }],
  ['out-of-range derived balance', (b: Backup) => { b.data.accounts[0].opening_balance_minor = Number.MAX_SAFE_INTEGER; }],
  ['archived fallback category', (b: Backup) => { b.data.categories.find((c) => c.id === 'cat_expense_other')!.is_archived = 1; }],
  ['conflicting financial event', (b: Backup) => {
    const ordinary = b.data.transactions.filter((t) => t.source === 'MANUAL');
    ordinary[0].financial_event_id = 'duplicate_explicit_event';
    ordinary[1].financial_event_id = 'duplicate_explicit_event';
  }],
] as const)('rejects %s before any destructive target write', async (_name, mutate) => {
  const backup: Backup = JSON.parse(await service.export());
  mutate(backup);
  const before = await snapshot();
  const safety = jest.fn();
  await expect(service.restore(JSON.stringify(backup), safety)).rejects.toThrow('cannot be restored');
  expect(safety).not.toHaveBeenCalled();
  expect(await snapshot()).toEqual(before);
});

test('invalid JSON is rejected without writes', async () => {
  const before = await snapshot();
  await expect(service.preview('{invalid')).rejects.toThrow('not valid JSON');
  expect(await snapshot()).toEqual(before);
});

test.each([
  'DELETE FROM "subscription_payments"', 'INSERT INTO "accounts"', 'INSERT INTO "categories"',
  'INSERT INTO "transactions"', 'INSERT INTO "people"', 'INSERT INTO "groups"',
  'INSERT INTO "planned_payment_occurrences"', 'INSERT INTO "subscription_payments"',
  'INSERT INTO "group_settlement_requests"',
  'CREATE TRIGGER allocation_no_delete', 'PRAGMA integrity_check', 'COMMIT',
])('failure at %s rolls back original rows AND exact schema', async (stage) => {
  const text = await service.export();
  await repo.savePerson(db, 'Original user data');
  const before = await snapshot();
  failure = (sql) => sql.startsWith(stage);
  await expect(service.restore(text, async () => {})).rejects.toThrow('injected');
  failure = undefined;
  expect(await snapshot()).toEqual(before);
  await expect(db.runAsync('DELETE FROM entry_allocations')).rejects.toThrow('immutable');
});

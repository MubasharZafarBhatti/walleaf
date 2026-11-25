/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import * as SQLite from 'expo-sqlite';
import { openAppDatabase, type AppDb } from '../database/database';
import * as repo from '../database/repositories/repositories';
import { calculateSplit, type SplitMethod, type SplitParticipantInput } from '../services/split/SplitService';
import { buildSharedExpensePostingPlan, saveSharedExpensePosting, sharedReadOnlyReason } from '../services/sharedExpense/SharedExpenseService';
import { readSharedEvent } from '../services/activity/ActivityService';
import { reconcileAllocation } from '../services/groups/GroupService';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

const participants: SplitParticipantInput[] = [
  { key: 'SELF', name: 'You', isSelf: true },
  { key: 'ali', name: 'Ali', isSelf: false, personId: 'ali' },
];
const valuesByMethod: Record<SplitMethod, Record<string, string>> = {
  Equal: {}, Exact: { SELF: '40', ali: '60' }, Percentage: { SELF: '40', ali: '60' }, Shares: { SELF: '2', ali: '3' },
};

test.each(['Equal', 'Exact', 'Percentage', 'Shares'] as SplitMethod[])('%s produces deterministic integer shares with an exact total', (method) => {
  const result = calculateSplit({ totalMinor: 10000, method, participants, values: valuesByMethod[method] });
  expect(result.ok).toBe(true);
  expect(result.shares.map((share) => share.shareMinor)).toEqual(method === 'Equal' ? [5000, 5000] : [4000, 6000]);
  expect(result.shares.reduce((sum, share) => sum + share.shareMinor, 0)).toBe(10000);
});

test.each([
  ['nonpositive total', () => [calculateSplit({ totalMinor: 0, method: 'Equal' as const, participants, values: {} }), calculateSplit({ totalMinor: -1, method: 'Equal' as const, participants, values: {} })]],
  ['zero participants', () => [calculateSplit({ totalMinor: 100, method: 'Equal' as const, participants: [], values: {} })]],
  ['duplicate identity', () => [calculateSplit({ totalMinor: 100, method: 'Equal' as const, participants: [participants[0], { ...participants[0], key: 'other-self' }], values: {} })]],
  ['malformed or negative exact', () => [calculateSplit({ totalMinor: 10000, method: 'Exact' as const, participants, values: { SELF: 'nope', ali: '100' } }), calculateSplit({ totalMinor: 10000, method: 'Exact' as const, participants, values: { SELF: '-1', ali: '101' } })]],
  ['exact under', () => [calculateSplit({ totalMinor: 10000, method: 'Exact' as const, participants, values: { SELF: '40', ali: '59' } })]],
  ['exact over', () => [calculateSplit({ totalMinor: 10000, method: 'Exact' as const, participants, values: { SELF: '40', ali: '61' } })]],
  ['percentage under', () => [calculateSplit({ totalMinor: 10000, method: 'Percentage' as const, participants, values: { SELF: '40', ali: '59.99' } })]],
  ['percentage over', () => [calculateSplit({ totalMinor: 10000, method: 'Percentage' as const, participants, values: { SELF: '40', ali: '60.01' } })]],
  ['zero or negative shares', () => [calculateSplit({ totalMinor: 10000, method: 'Shares' as const, participants, values: { SELF: '0', ali: '1' } }), calculateSplit({ totalMinor: 10000, method: 'Shares' as const, participants, values: { SELF: '-1', ali: '2' } })]],
  ['unsafe value', () => [calculateSplit({ totalMinor: 10000, method: 'Shares' as const, participants, values: { SELF: '99999999999999999', ali: '1' } })]],
] as const)('strict validation rejects %s', (_label, build) => {
  for (const result of build()) { expect(result.ok).toBe(false); expect(result.error).toBeTruthy(); expect(result.shares).toEqual([]); }
});

test('identity-backed names keep commas, Me, and You distinct from self', () => {
  const rows = [{ key: 'SELF', name: 'You', isSelf: true }, { key: 'me-person', name: 'Me', isSelf: false, personId: 'me' }, { key: 'you-person', name: 'You', isSelf: false, personId: 'you' }, { key: 'comma', name: 'Smith, Jr', isSelf: false, personId: 'comma' }];
  const result = calculateSplit({ totalMinor: 400, method: 'Equal', participants: rows, values: {} });
  expect(result.shares.map((share) => [share.name, share.isSelf, share.personId])).toEqual([['You', true, undefined], ['Me', false, 'me'], ['You', false, 'you'], ['Smith, Jr', false, 'comma']]);
});

test('PKR 10,000 divided by seven assigns all 1,000,000 minor units', () => {
  const rows = ['You', 'Muazzam', 'Mehroz', 'Ammar', 'Awais', 'Atif', 'Shahbaz'].map((name, index) => ({ key: String(index), name, isSelf: index === 0, personId: index ? String(index) : undefined }));
  const result = calculateSplit({ totalMinor: 1_000_000, method: 'Equal', participants: rows, values: {} });
  expect(result.shares.map((share) => share.shareMinor)).toEqual([142858, 142857, 142857, 142857, 142857, 142857, 142857]);
  expect(result.shares.reduce((sum, share) => sum + share.shareMinor, 0)).toBe(1_000_000);
});

test.each([
  ['standalone user paid Equal', 'Equal', true, null],
  ['standalone Ali paid Exact', 'Exact', false, null],
  ['group user paid Percentage', 'Percentage', true, 'group'],
  ['group Ali paid Shares', 'Shares', false, 'group'],
] as const)('%s preview shares deep-equal persisted-plan inputs and accounting', (_label, method, payerIsSelf, groupId) => {
  const result = calculateSplit({ totalMinor: 10000, method, participants, values: valuesByMethod[method] });
  const plan = buildSharedExpensePostingPlan({ title: 'Dinner', totalAmountMinor: 10000, categoryId: 'food', accountId: 'cash', occurredOn: '2026-09-14', groupId, payerIsSelf, payerPersonId: payerIsSelf ? null : 'ali', payerName: 'Ali', shares: result.shares });
  expect(plan.participants.map(({ name, is_self, person_id, share_minor }) => ({ name, isSelf: !!is_self, personId: person_id ?? undefined, shareMinor: share_minor }))).toEqual(result.shares);
  expect(plan.accountCashOutflowMinor).toBe(payerIsSelf ? 10000 : 0);
  expect(plan.personalExpenseMinor).toBe(result.shares[0].shareMinor);
  expect(plan.personEntries.reduce((sum, entry) => sum + entry.amount_minor, 0)).toBe(payerIsSelf ? result.shares[1].shareMinor : result.shares[0].shareMinor);
});

let sqlite: DatabaseSync;
let db: AppDb;
let failOn: string | null;
let ali: string;
const cash = 'account_cash_default';
const food = 'cat_expense_food';

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:'); failOn = null;
  const adapter = {
    execAsync: async (sql: string) => { sqlite.exec(sql); },
    runAsync: async (sql: string, ...params: (string | number | null)[]) => { if (failOn && sql.includes(failOn)) throw new Error('Injected failure'); return sqlite.prepare(sql).run(...params); },
    getAllAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).all(...params),
    getFirstAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).get(...params) ?? null,
    withTransactionAsync: async (work: () => Promise<void>) => { sqlite.exec('BEGIN'); try { await work(); sqlite.exec('COMMIT'); } catch (error) { sqlite.exec('ROLLBACK'); throw error; } },
    withExclusiveTransactionAsync: async (work: (txn: AppDb) => Promise<void>) => adapter.withTransactionAsync(() => work(db)),
  };
  db = adapter as unknown as AppDb;
  jest.mocked(SQLite.openDatabaseAsync).mockResolvedValue(db);
  await openAppDatabase(); ali = await repo.savePerson(db, 'Ali');
});
afterEach(() => sqlite?.close());
const posting = (name = 'ALI') => ({ title: 'Dinner', totalAmountMinor: 10000, categoryId: food, accountId: cash, occurredOn: '2026-09-14', payerIsSelf: true, shares: [{ name: 'You', isSelf: true, shareMinor: 4000 }, { name, isSelf: false, shareMinor: 6000 }] });

test('case-insensitive active inline identity is reused instead of duplicated', async () => {
  const plan = await saveSharedExpensePosting(db, posting());
  expect(await repo.listPeople(db)).toHaveLength(1);
  expect(plan.participants.find((participant) => !participant.is_self)?.person_id).toBe(ali);
});

test('case-insensitive archived inline identity is rejected and never recreated', async () => {
  await db.runAsync('UPDATE people SET is_archived = 1 WHERE id = ?;', ali);
  await expect(saveSharedExpensePosting(db, posting('aLi'))).rejects.toThrow('archived');
  expect(await db.getAllAsync('SELECT id FROM people;')).toHaveLength(1);
  expect(await repo.listSplitGroups(db)).toEqual([]);
});

test('staged Person and every shared row roll back together on late failure', async () => {
  failOn = 'INSERT INTO person_entries';
  await expect(saveSharedExpensePosting(db, posting('New person'))).rejects.toThrow('Injected');
  expect(await db.getAllAsync('SELECT id FROM people;')).toHaveLength(1);
  expect(await repo.listSplitGroups(db)).toEqual([]);
  expect(await repo.listPersonEntries(db)).toEqual([]);
});

test('migration 6 exposes the obligation target and allocation locks shared editing', async () => {
  const groupId = await repo.createGroup(db, { name: 'Trip', personIds: [ali] });
  const plan = await saveSharedExpensePosting(db, { ...posting(), groupId, shares: [{ name: 'You', isSelf: true, shareMinor: 4000 }, { name: 'Ali', personId: ali, isSelf: false, shareMinor: 6000 }] });
  const sourceId = await repo.savePersonEntry(db, { person_id: ali, type: 'RECEIVED_BACK', amount_minor: 6000, account_id: cash, title: 'Paid', occurred_on: '2026-09-14' });
  const target = await db.getFirstAsync<{ id: string }>('SELECT id FROM allocation_targets WHERE split_group_id = ?;', plan.splitGroup.id);
  expect(target?.id).toBe(plan.personEntries[0].id);
  await reconcileAllocation(db, { id: 'phase7-allocation', sourceEntryId: sourceId, targetEntryId: target!.id, amountMinor: 6000 });
  expect(await sharedReadOnlyReason(db, await readSharedEvent(db, plan.splitGroup.id))).toContain('reconciled payments');
});

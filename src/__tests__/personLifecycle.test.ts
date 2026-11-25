/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import * as SQLite from 'expo-sqlite';
import { openAppDatabase, type AppDb } from '../database/database';
import * as repo from '../database/repositories/repositories';
import { listActivity } from '../services/activity/ActivityService';
import { getMonthlyExpenseTotal } from '../services/budget/BudgetService';
import { calculateAccountBalance } from '../services/finance/FinanceService';
import { archivePerson, readPersonSnapshot, recordPeopleAction, renamePerson, restorePerson } from '../services/people/PersonService';
import type { Account, Person } from '../types/models';
import { monthKey, todayLocal } from '../utils/date';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

let sqlite: DatabaseSync;
let db: AppDb;
let cash: Account;
let ali: Person;

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
  cash = (await repo.listAccounts(db))[0];
  const id = await repo.savePerson(db, 'Ali', 'Class friend');
  ali = (await repo.listPeople(db)).find((person) => person.id === id)!;
});

afterEach(() => sqlite.close());

test('renaming then creating another Ali never reassigns history or rewrites descriptions', async () => {
  await addEntry('GIVEN', 5000, 'Loan to Ali');
  const before = await repo.listPersonEntries(db);
  await renamePerson(db, ali.id, ali.updated_at, 'Ali Khan');
  const newAli = await repo.savePerson(db, 'Ali');
  expect(newAli).not.toBe(ali.id);
  expect(await repo.listPersonEntries(db)).toEqual(before);
  expect(await listActivity(db, { personId: ali.id })).toEqual([expect.objectContaining({ person_id: ali.id, person_name: 'Ali Khan', title: 'Loan to Ali' })]);
  expect(await listActivity(db, { personId: newAli })).toEqual([]);
});

async function addEntry(type: 'GIVEN' | 'RECEIVED_BACK' | 'BORROWED_FROM' | 'PAID_BACK', amount: number, title: string = type) {
  return repo.savePersonEntry(db, {
    person_id: ali.id,
    type,
    amount_minor: amount,
    account_id: cash.id,
    title,
    occurred_on: todayLocal(),
  });
}

async function cashBalance() {
  return calculateAccountBalance(cash, await repo.listTransactions(db), await repo.listPersonEntries(db));
}

test('person rename and note edit preserve Give and repayment history', async () => {
  await addEntry('GIVEN', 500000, 'Loan');
  await addEntry('RECEIVED_BACK', 200000, 'Returned');
  await renamePerson(db, ali.id, ali.updated_at, '  Ali Khan  ', '  University friend  ');
  const snapshot = await readPersonSnapshot(db, ali.id);
  expect(snapshot.person).toMatchObject({ id: ali.id, name: 'Ali Khan', note: 'University friend' });
  expect(snapshot.balanceMinor).toBe(300000);
  expect(snapshot.history.map((entry) => entry.title).sort()).toEqual(['Loan', 'Returned']);
  expect(await listActivity(db, { personId: ali.id })).toEqual(expect.arrayContaining([
    expect.objectContaining({ person_name: 'Ali Khan', label: 'You gave' }),
    expect.objectContaining({ person_name: 'Ali Khan', label: 'Received back' }),
  ]));
});

test('duplicate active person names are rejected case-insensitively', async () => {
  const samId = await repo.savePerson(db, 'Sam');
  const sam = (await repo.listPeople(db)).find((person) => person.id === samId)!;
  await expect(renamePerson(db, sam.id, sam.updated_at, ' aLI ')).rejects.toThrow('PERSON_NAME_EXISTS');
  expect((await readPersonSnapshot(db, sam.id)).person.name).toBe('Sam');
});

test('rename preserves and refreshes Split payer, participant and Group member references', async () => {
  const timestamp = '2026-09-13T00:00:00.000Z';
  await db.runAsync('INSERT INTO groups (id, name, description, created_at, updated_at, sync_status) VALUES (?, ?, NULL, ?, ?, ?);', 'group', 'Trip', timestamp, timestamp, 'LOCAL');
  await db.runAsync('INSERT INTO group_members (id, group_id, person_id, is_self, created_at) VALUES (?, ?, ?, 0, ?);', 'member', 'group', ali.id, timestamp);
  await db.runAsync('INSERT INTO split_groups (id, title, total_amount_minor, category_id, account_id, occurred_on, created_at, updated_at, sync_status, group_id, payer_person_id, payer_name, payer_is_self) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0);', 'split', 'Dinner', 1000, 'cat_expense_food', cash.id, todayLocal(), timestamp, timestamp, 'LOCAL', 'group', ali.id, 'Ali');
  await db.runAsync('INSERT INTO split_participants (id, split_group_id, person_id, name, is_self, share_minor, created_at) VALUES (?, ?, ?, ?, 0, ?, ?);', 'participant', 'split', ali.id, 'Ali', 1000, timestamp);
  await renamePerson(db, ali.id, ali.updated_at, 'Ali Khan');
  expect(await db.getFirstAsync('SELECT person_id FROM group_members WHERE id = ?;', 'member')).toMatchObject({ person_id: ali.id });
  expect(await db.getFirstAsync('SELECT payer_person_id, payer_name FROM split_groups WHERE id = ?;', 'split')).toMatchObject({ payer_person_id: ali.id, payer_name: 'Ali' });
  expect(await db.getFirstAsync('SELECT person_id, name FROM split_participants WHERE id = ?;', 'participant')).toMatchObject({ person_id: ali.id, name: 'Ali' });
  expect((await repo.listSplitGroups(db))[0]).toMatchObject({ payer_person_id: ali.id, payer_name: 'Ali Khan' });
  expect((await repo.listSplitParticipants(db, 'split'))[0]).toMatchObject({ person_id: ali.id, name: 'Ali Khan' });
  const secondAli = await repo.savePerson(db, 'Ali');
  expect(await listActivity(db, { query: 'Ali Khan' })).toEqual([]);
  expect(await listActivity(db, { activityId: 'shared:split', query: 'Ali Khan' })).toEqual([expect.objectContaining({ source_id: 'split', person_id: ali.id, person_name: 'Ali Khan' })]);
  expect(await listActivity(db, { personId: secondAli })).toEqual([]);
});

test('zero-balance archive is metadata-only, leaves history readable and hides active selectors', async () => {
  await addEntry('GIVEN', 1000, 'Given');
  await addEntry('RECEIVED_BACK', 1000, 'Received');
  await archivePerson(db, ali.id, ali.updated_at);
  expect((await repo.listPeople(db)).map((person) => person.id)).not.toContain(ali.id);
  expect(await repo.listAllPeople(db)).toEqual(expect.arrayContaining([expect.objectContaining({ id: ali.id, is_archived: 1 })]));
  const snapshot = await readPersonSnapshot(db, ali.id);
  expect(snapshot.balanceMinor).toBe(0);
  expect(snapshot.history).toHaveLength(2);
  expect(await listActivity(db, { personId: ali.id })).toHaveLength(2);
});

test('restore reactivates the same stable Person without changing history or creating financial activity', async () => {
  await addEntry('GIVEN', 1000, 'Given');
  await addEntry('RECEIVED_BACK', 1000, 'Received');
  await archivePerson(db, ali.id, ali.updated_at);
  const archived = (await readPersonSnapshot(db, ali.id)).person;
  const activityBefore = await listActivity(db, { personId: ali.id });
  await restorePerson(db, ali.id, archived.updated_at);
  const restored = await readPersonSnapshot(db, ali.id);
  expect(restored.person).toMatchObject({ id: ali.id, is_archived: 0 });
  expect(restored.person.updated_at > archived.updated_at).toBe(true);
  expect(restored.history.map((row) => row.id)).toEqual(expect.arrayContaining(activityBefore.map((row) => row.source_id)));
  expect(await listActivity(db, { personId: ali.id })).toHaveLength(activityBefore.length);
  expect((await repo.listPeople(db)).map((row) => row.id)).toContain(ali.id);
  expect(await repo.listTransactions(db)).toEqual([]);
});

test('archived names stay reserved for rename and stale restore attempts fail closed', async () => {
  await archivePerson(db, ali.id, ali.updated_at);
  const archived = (await readPersonSnapshot(db, ali.id)).person;
  const samId = await repo.savePerson(db, 'Sam');
  const sam = (await repo.listPeople(db)).find((row) => row.id === samId)!;
  await expect(renamePerson(db, sam.id, sam.updated_at, ' aLI ')).rejects.toThrow('PERSON_NAME_EXISTS');
  await restorePerson(db, ali.id, archived.updated_at);
  await expect(restorePerson(db, ali.id, archived.updated_at)).rejects.toThrow();
});

test.each([
  ['GIVEN' as const, 2500],
  ['BORROWED_FROM' as const, -2500],
])('nonzero global balance from %s cannot be archived', async (type, expectedBalance) => {
  await addEntry(type, 2500);
  await expect(archivePerson(db, ali.id, ali.updated_at)).rejects.toMatchObject({ balanceMinor: expectedBalance });
  expect((await readPersonSnapshot(db, ali.id)).person.is_archived).toBe(0);
});

test('full positive settlement records Received back, increases account and creates no transaction or Budget effect', async () => {
  await addEntry('GIVEN', 300000);
  const result = await recordPeopleAction(db, { personId: ali.id, action: 'BORROW', amountMinor: 300000, accountId: cash.id, occurredOn: todayLocal(), expectedBalanceMinor: 300000 });
  expect(result).toMatchObject({ type: 'RECEIVED_BACK', nextBalance: 0 });
  expect((await readPersonSnapshot(db, ali.id)).balanceMinor).toBe(0);
  expect(await cashBalance()).toBe(0);
  expect(await repo.listTransactions(db)).toEqual([]);
  expect(getMonthlyExpenseTotal(await repo.listTransactions(db), monthKey(todayLocal()))).toBe(0);
});

test('full negative settlement records Paid back and decreases the selected account', async () => {
  await addEntry('BORROWED_FROM', 300000);
  expect(await cashBalance()).toBe(300000);
  const result = await recordPeopleAction(db, { personId: ali.id, action: 'GIVE', amountMinor: 300000, accountId: cash.id, expectedBalanceMinor: -300000 });
  expect(result).toMatchObject({ type: 'PAID_BACK', nextBalance: 0 });
  expect((await readPersonSnapshot(db, ali.id)).balanceMinor).toBe(0);
  expect(await cashBalance()).toBe(0);
  expect(await repo.listTransactions(db)).toEqual([]);
});

test('partial positive settlement changes only the chosen account and remaining global balance', async () => {
  await addEntry('GIVEN', 500000);
  await recordPeopleAction(db, { personId: ali.id, action: 'BORROW', amountMinor: 200000, accountId: cash.id, expectedBalanceMinor: 500000 });
  expect((await readPersonSnapshot(db, ali.id)).balanceMinor).toBe(300000);
  expect(await cashBalance()).toBe(-300000);
});

test('partial negative settlement changes only the chosen account and remaining global balance', async () => {
  await addEntry('BORROWED_FROM', 500000);
  await recordPeopleAction(db, { personId: ali.id, action: 'GIVE', amountMinor: 200000, accountId: cash.id, expectedBalanceMinor: -500000 });
  expect((await readPersonSnapshot(db, ali.id)).balanceMinor).toBe(-300000);
  expect(await cashBalance()).toBe(300000);
});

test('global settlement includes shared obligations already present in the authoritative ledger', async () => {
  await addEntry('GIVEN', 400000, 'Shared expense obligation');
  await addEntry('BORROWED_FROM', 100000, 'Other obligation');
  expect((await readPersonSnapshot(db, ali.id)).balanceMinor).toBe(300000);
  await recordPeopleAction(db, { personId: ali.id, action: 'BORROW', amountMinor: 300000, accountId: cash.id, expectedBalanceMinor: 300000 });
  expect((await readPersonSnapshot(db, ali.id)).balanceMinor).toBe(0);
});

test('over-settlement keeps the existing balance-crossing classification and result', async () => {
  await addEntry('GIVEN', 100000);
  const result = await recordPeopleAction(db, { personId: ali.id, action: 'BORROW', amountMinor: 150000, accountId: cash.id, expectedBalanceMinor: 100000 });
  expect(result).toMatchObject({ type: 'RECEIVED_BACK', nextBalance: -50000, requiresCrossingConfirmation: true });
});

test('stale duplicate settlement and archived-person writes are rejected', async () => {
  await addEntry('GIVEN', 100000);
  const input = { personId: ali.id, action: 'BORROW' as const, amountMinor: 100000, accountId: cash.id, expectedBalanceMinor: 100000 };
  await recordPeopleAction(db, input);
  await expect(recordPeopleAction(db, input)).rejects.toThrow('balance changed');
  const current = (await readPersonSnapshot(db, ali.id)).person;
  await archivePerson(db, ali.id, current.updated_at);
  await expect(repo.savePersonEntry(db, { person_id: ali.id, type: 'GIVEN', amount_minor: 100, account_id: cash.id, title: 'Stale', occurred_on: todayLocal() })).rejects.toThrow('active person');
});

/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import * as SQLite from 'expo-sqlite';
import { openAppDatabase, type AppDb } from '../database/database';
import * as repo from '../database/repositories/repositories';
import { calculateSharedBill, personIdentity } from '../services/split/SharedBillCalculation';
import { decodeSharedDefinition } from '../services/split/SplitDefinition';
import { deleteSharedExpense, previewSharedExpensePosting, reopenSharedExpenseInput, saveSharedExpensePosting, sharedIntegrityReason, updateSharedExpense, type SharedExpensePostingInput } from '../services/sharedExpense/SharedExpenseService';
import { listActivity, readSharedEvent } from '../services/activity/ActivityService';
import { calculateAccountBalance, calculateTotalAccountCashChange } from '../services/finance/FinanceService';
import { calculatePersonBalance } from '../services/people/PeopleBalanceService';
import { getMonthlyExpenseTotal } from '../services/budget/BudgetService';
import { buildGroupNetSettlement, readGroupSnapshot, settleGroup } from '../services/groups/GroupService';
import { accountActivityEffect } from '../services/accounts/AccountService';
import { todayLocal } from '../utils/date';
import type { SplitMethod } from '../services/split/SplitService';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
let sqlite: DatabaseSync; let db: AppDb; let people: string[]; let groupId: string; let failOn: string | null;
const cash = 'account_cash_default';
beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:'); failOn = null;
  const adapter = {
    execAsync: async (sql: string) => { sqlite.exec(sql); },
    runAsync: async (sql: string, ...params: (string | number | null)[]) => { if (failOn && sql.includes(failOn)) throw new Error('Injected D failure'); return sqlite.prepare(sql).run(...params); },
    getAllAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).all(...params),
    getFirstAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).get(...params) ?? null,
    withTransactionAsync: async (work: () => Promise<void>) => { sqlite.exec('BEGIN'); try { await work(); sqlite.exec('COMMIT'); } catch (error) { sqlite.exec('ROLLBACK'); throw error; } },
    withExclusiveTransactionAsync: async (work: (txn: AppDb) => Promise<void>) => adapter.withTransactionAsync(() => work(db)),
  };
  db = adapter as unknown as AppDb; jest.mocked(SQLite.openDatabaseAsync).mockResolvedValue(db); await openAppDatabase();
  people = []; for (const name of ['Atif', 'Ali', 'Awais']) people.push(await repo.savePerson(db, name));
  groupId = await repo.createGroup(db, { name: 'D group', personIds: people });
});
afterEach(() => { expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]); sqlite.close(); });
function input(paid = 200000, method: SplitMethod = 'Equal', self = true): SharedExpensePostingInput {
  const participants = [...(self ? [{ key: 'SELF', name: 'You', isSelf: true }] : []), ...people.map((personId, index) => ({ key: personIdentity(personId), name: ['Atif', 'Ali', 'Awais'][index], personId, isSelf: false }))];
  const totalMinor = 1200000;
  const values = Object.fromEntries(participants.map((participant) => [participant.key, method === 'Exact' ? self ? '3000' : '4000' : method === 'Percentage' ? '25' : '1']));
  const payers = [{ identity: 'SELF', paidMinor: paid }, { identity: personIdentity(people[0]), paidMinor: totalMinor - paid }];
  const result = calculateSharedBill({ totalMinor, method, participants, values, payers });
  return { title: 'D bill', totalAmountMinor: totalMinor, categoryId: 'cat_expense_food', accountId: paid ? cash : '', occurredOn: todayLocal(), groupId, payerIsSelf: paid > 0,
    shares: result.shares, payers, editor: { method, values: participants.map((participant) => method === 'Equal' ? '' : values[participant.key]) } };
}
async function effects() {
  const account = (await repo.listAccounts(db)).find((row) => row.id === cash)!;
  const transactions = await repo.listTransactions(db); const entries = await repo.listPersonEntries(db);
  return { balance: calculateAccountBalance(account, transactions, entries), cashChange: calculateTotalAccountCashChange(transactions, entries, '2000-01-01', '2099-12-31'),
    spent: getMonthlyExpenseTotal(transactions, todayLocal().slice(0, 7)), people: calculatePersonBalance(entries), transactions, entries };
}
function state() { return JSON.stringify(['accounts', 'people', 'split_groups', 'split_participants', 'transactions', 'person_entries', 'entry_allocations', 'group_settlement_requests'].map((table) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all())); }

test.each([[200000, -100000], [800000, 500000], [300000, 0], [0, -300000]])('paid %i: final user spending 300,000, actual funding and People net %i remain separate', async (paid, net) => {
  const plan = await saveSharedExpensePosting(db, input(paid));
  expect(await effects()).toMatchObject({ spent: 300000, balance: paid ? -paid : 0, cashChange: paid ? -paid : 0, people: net });
  expect(plan.accountCashOutflowMinor).toBe(paid);
  const records = await readSharedEvent(db, plan.splitGroup.id);
  expect(await sharedIntegrityReason(db, records)).toBeNull();
  expect((await readGroupSnapshot(db, groupId)).invalidHistory).toBe(false);
  if (net === 0) expect(records.entries).toEqual([]);
  if (paid) expect(accountActivityEffect((await listActivity(db))[0], cash)).toBe(-paid);
});
test.each(['Percentage', 'Shares'] as const)('%s multi-payer service uses consumption only for Expense', async (method) => {
  await saveSharedExpensePosting(db, input(800000, method));
  expect(await effects()).toMatchObject({ spent: 300000, balance: -800000, people: 500000 });
});
test.each([0, 500000])('user absent, contributes %i: no Expense; funding/user routes or group-only metadata are exact', async (paid) => {
  const plan = await saveSharedExpensePosting(db, input(paid, 'Equal', false));
  expect(await effects()).toMatchObject({ spent: 0, balance: paid ? -paid : 0, people: paid });
  expect((await repo.listTransactions(db))).toEqual([]);
  expect((await listActivity(db))).toHaveLength(paid ? 1 : 0);
  expect(plan.definition!.routes.some((route) => route.from !== 'SELF' && route.to !== 'SELF')).toBe(true);
  expect(await sharedIntegrityReason(db, await readSharedEvent(db, plan.splitGroup.id))).toBeNull();
});
test('Exact restaurant bases/common and multi-payer metadata round-trip reconstruct every source input', async () => {
  const base = input(); const values = ['1200', '800', '1000', '1600'];
  const participants = base.shares.map((share) => ({ name: share.name, personId: share.personId ?? undefined, isSelf: share.isSelf, key: share.isSelf ? 'SELF' : personIdentity(share.personId!) }));
  const payers = [{ identity: 'SELF', paidMinor: 200000 }, { identity: personIdentity(people[0]), paidMinor: 360000 }];
  const result = calculateSharedBill({ totalMinor: 560000, method: 'Exact', participants, values: Object.fromEntries(participants.map((participant, index) => [participant.key, values[index]])), commonCostMinor: 100000, payers });
  const plan = await saveSharedExpensePosting(db, { ...base, totalAmountMinor: 560000, shares: result.shares, payers, editor: { method: 'Exact', values, commonCostMinor: 100000 } });
  expect(await effects()).toMatchObject({ balance: -200000, spent: 145000, people: 55000 });
  const records = await readSharedEvent(db, plan.splitGroup.id);
  const definition = decodeSharedDefinition(records.split.split_definition!, 560000, records.participants);
  expect(definition).toMatchObject({ commonCostMinor: 100000, method: 'Exact', payers, routes: result.routes });
  const reopened = reopenSharedExpenseInput(records);
  expect(reopened.editor).toEqual({ method: 'Exact', values, commonCostMinor: 100000 });
  expect(reopened.shares.map((share) => share.shareMinor)).toEqual([145000, 105000, 125000, 185000]);
  expect(records.entries).toHaveLength(result.routes.filter((route) => route.to === 'SELF' || route.from === 'SELF').length);
});

test.each(['payable', 'receivable'] as const)('custom %s routing persists exactly and never posts third-party routes globally', async (direction) => {
  const base = input(direction === 'payable' ? 100000 : 700000);
  const payers = direction === 'payable' ? [{ identity: 'SELF', paidMinor: 100000 }, { identity: personIdentity(people[0]), paidMinor: 500000 }, { identity: personIdentity(people[1]), paidMinor: 600000 }] : [{ identity: 'SELF', paidMinor: 700000 }, { identity: personIdentity(people[0]), paidMinor: 500000 }];
  const custom = direction === 'payable' ? [{ identity: personIdentity(people[0]), amountMinor: 50000 }, { identity: personIdentity(people[1]), amountMinor: 150000 }] : [{ identity: personIdentity(people[1]), amountMinor: 150000 }, { identity: personIdentity(people[2]), amountMinor: 250000 }];
  const plan = await saveSharedExpensePosting(db, { ...base, payers, customUserSettlement: custom });
  const records = await readSharedEvent(db, plan.splitGroup.id);
  expect(reopenSharedExpenseInput(records).customUserSettlement).toEqual(custom);
  expect(records.entries).toHaveLength(custom.length);
  expect(records.entries.map((entry) => entry.person_id).sort()).toEqual(custom.map((row) => row.identity.slice(7)).sort());
  expect(records.entries.reduce((sum, entry) => sum + entry.amount_minor, 0)).toBe(direction === 'payable' ? 200000 : 400000);
  expect(plan.definition!.routes.some((route) => route.from !== 'SELF' && route.to !== 'SELF')).toBe(true);
});

test('zero contribution needs no active funding selection; positive contribution requires an active account', async () => {
  await repo.createAccount(db, { name: 'Other active', type: 'BANK', opening_balance_minor: 0 });
  await db.runAsync('UPDATE accounts SET is_archived = 1 WHERE id = ?;', cash);
  const zero = await saveSharedExpensePosting(db, input(0));
  expect(zero.accountCashOutflowMinor).toBe(0);
  const before = state();
  await expect(saveSharedExpensePosting(db, input(200000))).rejects.toThrow('active account');
  expect(state()).toBe(before);
});

test.each(['DELETE FROM transactions', 'DELETE FROM person_entries', 'DELETE FROM split_participants', 'DELETE FROM split_groups'])('delete %s failure rolls back exact modern event and unrelated ledger', async (sql) => {
  const plan = await saveSharedExpensePosting(db, input()); const records = await readSharedEvent(db, plan.splitGroup.id); const before = state(); failOn = sql;
  await expect(deleteSharedExpense(db, records.split.id, records.split.updated_at)).rejects.toThrow('Injected');
  expect(state()).toBe(before);
});
test('fresh opposite People balance delegates classification/crossing, rejects stale confirmation and keeps original route', async () => {
  const deficit = input(200000); const atif = people[0];
  await repo.savePersonEntry(db, { person_id: atif, type: 'GIVEN', amount_minor: 50000, account_id: cash, title: 'Unrelated older loan', occurred_on: todayLocal() });
  const before = state();
  const preview = await previewSharedExpensePosting(db, deficit);
  expect(preview.crossings).toMatchObject([{ personId: atif, balanceBeforeMinor: 50000, action: 'BORROW', amountMinor: 100000 }]);
  await expect(saveSharedExpensePosting(db, deficit)).rejects.toThrow('crossing');
  expect(state()).toBe(before);
  await expect(saveSharedExpensePosting(db, { ...deficit, crossingConfirmations: { [atif]: 49999 } })).rejects.toThrow('crossing');
  const plan = await saveSharedExpensePosting(db, { ...deficit, crossingConfirmations: { [atif]: 50000 } });
  expect(plan.personEntries).toMatchObject([{ type: 'RECEIVED_BACK', cash_effect_minor: 0, amount_minor: 100000 }]);
  expect(plan.definition!.routes).toContainEqual({ from: 'SELF', to: personIdentity(atif), amountMinor: 100000 });
  expect((await readGroupSnapshot(db, groupId)).positions.find((row) => row.personId === atif)).toMatchObject({ oweMinor: 100000 });
});
test('multi-payer edit/delete recalculates all effects atomically and retains unrelated repayment/history', async () => {
  const plan = await saveSharedExpensePosting(db, input(800000));
  await repo.savePersonEntry(db, { person_id: people[0], type: 'BORROWED_FROM', amount_minor: 100, account_id: cash, title: 'Unrelated receipt', occurred_on: todayLocal() });
  const unrelated = (await repo.listPersonEntries(db)).find((entry) => !entry.split_group_id)!;
  const records = await readSharedEvent(db, plan.splitGroup.id);
  await updateSharedExpense(db, records.split.id, records.split.updated_at, input(200000));
  expect(await effects()).toMatchObject({ spent: 300000, balance: -199900, people: -100100 });
  const updated = await readSharedEvent(db, records.split.id);
  expect(updated.split.created_at).toBe(records.split.created_at);
  await deleteSharedExpense(db, updated.split.id, updated.split.updated_at);
  expect(await effects()).toMatchObject({ spent: 0, balance: 100, people: -100 });
  expect(await repo.listPersonEntries(db)).toEqual([unrelated]);
});
test.each(['INSERT INTO split_groups', 'UPDATE split_groups', 'INSERT INTO split_participants', 'INSERT INTO transactions', 'INSERT INTO person_entries'])('create %s failure rolls back the complete modern mutation', async (sql) => {
  const before = state(); failOn = sql;
  await expect(saveSharedExpensePosting(db, input())).rejects.toThrow('Injected');
  expect(state()).toBe(before);
});
test.each(['DELETE FROM transactions', 'DELETE FROM person_entries', 'DELETE FROM split_participants', 'DELETE FROM split_groups', 'INSERT INTO person_entries'])('edit %s failure restores exact original records', async (sql) => {
  const plan = await saveSharedExpensePosting(db, input()); const records = await readSharedEvent(db, plan.splitGroup.id); const before = state(); failOn = sql;
  await expect(updateSharedExpense(db, records.split.id, records.split.updated_at, input(800000))).rejects.toThrow('Injected');
  expect(state()).toBe(before);
});
test('migration-11 confirmed offset semantics/locks also work for modern classified shared routes', async () => {
  const first = await saveSharedExpensePosting(db, input(800000));
  await saveSharedExpensePosting(db, { ...input(0), crossingConfirmations: { [people[1]]: 200000 }, payers: [{ identity: 'SELF', paidMinor: 0 }, { identity: personIdentity(people[1]), paidMinor: 1200000 }] });
  const snapshot = await readGroupSnapshot(db, groupId);
  const personId = people[1];
  const position = snapshot.positions.find((row) => row.personId === personId)!;
  const net = buildGroupNetSettlement(snapshot.targets, personId, Math.abs(position.balanceMinor));
  expect(net.offsets).toHaveLength(1);
  await settleGroup(db, { requestId: 'modern-net', groupId, personId, accountId: cash, occurredOn: todayLocal(), targets: net.targets, offsets: net.offsets, nettingConfirmed: true, expectedRevision: snapshot.revision, expectedBalanceMinor: calculatePersonBalance((await repo.listPersonEntries(db)).filter((entry) => entry.person_id === personId)) });
  expect((await readGroupSnapshot(db, groupId)).positions.find((row) => row.personId === personId)).toMatchObject({ owedMinor: 0, oweMinor: 0 });
  await expect(deleteSharedExpense(db, first.splitGroup.id, (await readSharedEvent(db, first.splitGroup.id)).split.updated_at)).rejects.toThrow('reconciled');
});

test('single-payer Exact common cost and legacy single-payer reopen/edit preserve accounting', async () => {
  const legacy = input(1200000, 'Exact'); delete legacy.payers;
  const plan = await saveSharedExpensePosting(db, legacy);
  const records = await readSharedEvent(db, plan.splitGroup.id);
  expect(JSON.parse(records.split.split_definition!).version).toBe(1);
  const reopened = reopenSharedExpenseInput(records);
  expect(reopened.editor).toEqual({ method: 'Exact', values: ['3000', '3000', '3000', '3000'] });
  await updateSharedExpense(db, records.split.id, records.split.updated_at, reopened);
  expect(await effects()).toMatchObject({ spent: 300000, balance: -1200000, people: 900000 });
  const updated = await readSharedEvent(db, records.split.id);
  await deleteSharedExpense(db, updated.split.id, updated.split.updated_at);
  const common = input(1200000, 'Exact'); delete common.payers;
  common.editor = { method: 'Exact', values: ['2500', '2500', '2500', '2500'], commonCostMinor: 200000 };
  const modern = await saveSharedExpensePosting(db, common);
  expect(modern.definition!.payers).toEqual([{ identity: 'SELF', paidMinor: 1200000 }]);
  expect(await effects()).toMatchObject({ spent: 300000, balance: -1200000, people: 900000 });
});

test('stale or unavailable payer/participant edits fail without changing the original event', async () => {
  const plan = await saveSharedExpensePosting(db, input()); const records = await readSharedEvent(db, plan.splitGroup.id);
  for (const changed of [
    { ...input(), payers: [{ identity: 'PERSON:missing', paidMinor: 1200000 }] },
    { ...input(), shares: input().shares.map((row, index) => index === 1 ? { ...row, personId: 'missing' } : row) },
    { ...input(), payers: [{ identity: 'SELF', paidMinor: 1200001 }] },
    { ...input(), customUserSettlement: [{ identity: personIdentity(people[1]), amountMinor: 100000 }] },
  ]) {
    const before = state(); await expect(updateSharedExpense(db, records.split.id, records.split.updated_at, changed)).rejects.toThrow(); expect(state()).toBe(before);
  }
  const before = state();
  await expect(updateSharedExpense(db, records.split.id, 'stale', input())).rejects.toThrow('changed'); expect(state()).toBe(before);
});

test('cash metadata cannot bypass shared service ownership or SQL cash/route guards', async () => {
  const plan = await saveSharedExpensePosting(db, input()); const records = await readSharedEvent(db, plan.splitGroup.id); const before = state();
  await expect(db.runAsync('UPDATE transactions SET cash_effect_minor = -1 WHERE id = ?;', records.transactions[0].id)).rejects.toThrow('cash effect');
  await expect(db.runAsync('UPDATE person_entries SET cash_effect_minor = -1 WHERE id = ?;', records.entries[0].id)).rejects.toThrow('cash effect');
  await expect(repo.saveTransaction(db, { type: 'EXPENSE', source: 'MANUAL', amount_minor: 1, account_id: cash, category_id: 'cat_expense_food', title: 'Invalid override', occurred_on: todayLocal(), cash_effect_minor: -1 })).rejects.toThrow();
  expect(state()).toBe(before);
});

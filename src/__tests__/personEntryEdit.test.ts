/// <reference types="node" />
import * as repo from '../database/repositories/repositories';
import { readAccountSnapshot } from '../services/accounts/AccountService';
import { deletePersonEntry, personEntryReadOnlyReason, readPersonSnapshot, recordPeopleAction, updatePersonEntry } from '../services/people/PersonService';
import type { PersonEntry } from '../types/models';
import { reminderDatabase } from './reminderFixtures';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

const CASH = 'account_cash_default';
async function setup() {
  const harness = await reminderDatabase();
  const awais = await repo.savePerson(harness.db, 'Awais');
  const cashBefore = (await readAccountSnapshot(harness.db, CASH)).currentBalanceMinor;
  const { id } = await recordPeopleAction(harness.db, { personId: awais, action: 'GIVE', amountMinor: 500000, accountId: CASH, occurredOn: '2026-11-16', title: 'Given', expectedBalanceMinor: 0 });
  const entry = async () => (await harness.db.getFirstAsync<PersonEntry>('SELECT * FROM person_entries WHERE id = ?;', id))!;
  const state = async () => ({ cash: (await readAccountSnapshot(harness.db, CASH)).currentBalanceMinor, balance: (await readPersonSnapshot(harness.db, awais)).balanceMinor });
  return { ...harness, awais, id, entry, state, cashBefore };
}

test('a plain Give record is editable and its edit moves cash and balance together', async () => {
  const t = await setup();
  try {
    expect(await t.state()).toEqual({ cash: t.cashBefore - 500000, balance: 500000 });
    expect(await personEntryReadOnlyReason(t.db, await t.entry())).toBeNull();
    await updatePersonEntry(t.db, t.id, (await t.entry()).updated_at, { amountMinor: 300000, accountId: CASH, occurredOn: '2026-11-15', title: 'Lunch loan', note: null });
    expect(await t.state()).toEqual({ cash: t.cashBefore - 300000, balance: 300000 });
    expect(await t.entry()).toMatchObject({ amount_minor: 300000, occurred_on: '2026-11-15', title: 'Lunch loan', type: 'GIVEN' });
  } finally { t.close(); }
});

test('delete restores the account and the person balance, keeping the row for history', async () => {
  const t = await setup();
  try {
    await deletePersonEntry(t.db, t.id, (await t.entry()).updated_at);
    expect(await t.state()).toEqual({ cash: t.cashBefore, balance: 0 });
    expect((await t.entry()).deleted_at).toBeTruthy();
    expect(await repo.listPersonEntries(t.db, t.awais)).toEqual([]);
  } finally { t.close(); }
});

test('a stale screen cannot overwrite or delete a changed record', async () => {
  const t = await setup();
  try {
    const stale = (await t.entry()).updated_at;
    await updatePersonEntry(t.db, t.id, stale, { amountMinor: 400000, accountId: CASH, occurredOn: '2026-11-16', title: 'Given' });
    await expect(updatePersonEntry(t.db, t.id, stale, { amountMinor: 1, accountId: CASH, occurredOn: '2026-11-16', title: 'x' })).rejects.toThrow('changed');
    await expect(deletePersonEntry(t.db, t.id, stale)).rejects.toThrow('changed');
    expect(await t.state()).toEqual({ cash: t.cashBefore - 400000, balance: 400000 });
  } finally { t.close(); }
});

test('invalid input changes nothing (atomic)', async () => {
  const t = await setup();
  try {
    const before = await t.financial();
    const version = (await t.entry()).updated_at;
    await expect(updatePersonEntry(t.db, t.id, version, { amountMinor: 0, accountId: CASH, occurredOn: '2026-11-16', title: '' })).rejects.toThrow('greater than zero');
    await expect(updatePersonEntry(t.db, t.id, version, { amountMinor: 100, accountId: 'missing', occurredOn: '2026-11-16', title: '' })).rejects.toThrow('active account');
    await expect(updatePersonEntry(t.db, t.id, version, { amountMinor: 100, accountId: CASH, occurredOn: '16-11-2026', title: '' })).rejects.toThrow('valid date');
    expect(await t.financial()).toEqual(before);
  } finally { t.close(); }
});

test('shared/group-linked and archived-person records stay read-only', async () => {
  const t = await setup();
  try {
    await t.db.runAsync('UPDATE person_entries SET financial_event_id = ? WHERE id = ?;', 'event_shared', t.id);
    expect(await personEntryReadOnlyReason(t.db, await t.entry())).toMatch(/shared or group bill/);
    await expect(deletePersonEntry(t.db, t.id, (await t.entry()).updated_at)).rejects.toThrow(/shared or group bill/);
    await t.db.runAsync('UPDATE person_entries SET financial_event_id = NULL WHERE id = ?;', t.id);
    await t.db.runAsync('UPDATE people SET is_archived = 1 WHERE id = ?;', t.awais);
    expect(await personEntryReadOnlyReason(t.db, await t.entry())).toMatch(/archived/);
    expect(await t.state()).toEqual({ cash: t.cashBefore - 500000, balance: 500000 });
  } finally { t.close(); }
});

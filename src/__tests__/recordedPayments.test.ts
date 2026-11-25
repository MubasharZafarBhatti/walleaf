/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import * as SQLite from 'expo-sqlite';
import { openAppDatabase, type AppDb } from '../database/database';
import * as repo from '../database/repositories/repositories';
import { deleteRecordedPayment, readRecordedPaymentDeletion } from '../services/planned/RecordedPaymentService';
import { advanceRecurrence, formatRecurrenceLabel, parseRecurrenceInterval, validateRecurrenceInterval } from '../utils/recurrence';
import { normalizedMonthlyCost } from '../services/subscriptions/SubscriptionService';
import { decodeScheduleProvenance } from '../services/planned/ScheduleProvenance';
import { calculateAccountBalance } from '../services/finance/FinanceService';
import { buildInsightsSnapshot } from '../services/insights/InsightsService';
import { listActivity } from '../services/activity/ActivityService';
import { BackupService } from '../services/backup/BackupService';
import { BACKUP_TABLES, type Backup } from '../services/backup/BackupFormat';
import { removeMigration13ForFixture, stripScheduleProvenanceForFixture } from './schemaFixtures';
import type { PlannedPayment, PlannedRecurrenceType, Subscription } from '../types/models';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
let sql: DatabaseSync; let db: AppDb; let service: BackupService;
function adapter(native: DatabaseSync, close = false): AppDb {
  const a = {
    execAsync: async (s: string) => { native.exec(s); },
    runAsync: async (s: string, ...args: (string | number | null)[]) => native.prepare(s).run(...args),
    getAllAsync: async (s: string, ...args: (string | number | null)[]) => native.prepare(s).all(...args),
    getFirstAsync: async (s: string, ...args: (string | number | null)[]) => native.prepare(s).get(...args) ?? null,
    closeAsync: async () => { if (close) native.close(); },
    withTransactionAsync: async (work: () => Promise<void>) => { native.exec('BEGIN'); try { await work(); native.exec('COMMIT'); } catch (e) { native.exec('ROLLBACK'); throw e; } },
    withExclusiveTransactionAsync: async (work: (t: AppDb) => Promise<void>) => a.withTransactionAsync(() => work(a as unknown as AppDb)),
  };
  return a as unknown as AppDb;
}
beforeEach(async () => {
  jest.useFakeTimers().setSystemTime(new Date(2026, 9, 8, 12));
  sql = new DatabaseSync(':memory:'); db = adapter(sql);
  jest.mocked(SQLite.openDatabaseAsync).mockResolvedValue(db); await openAppDatabase();
  await db.runAsync('UPDATE accounts SET opening_balance_minor = 100000;');
  service = new BackupService({ open: async staging => staging ? adapter(new DatabaseSync(':memory:'), true) : db, now: () => '2026-10-08T12:00:00.000Z' });
});
afterEach(() => { jest.restoreAllMocks(); sql.close(); jest.useRealTimers(); });

type Kind = 'expense' | 'income' | 'subscription';
async function create(kind: Kind, recurrence: PlannedRecurrenceType = 'MONTHLY', interval = 1, date = '2026-10-08') {
  if (kind === 'subscription') return repo.saveSubscription(db, { name: 'Netflix', amount_minor: 50000, category_id: 'cat_expense_subscriptions', account_id: 'account_cash_default', frequency_type: recurrence as Subscription['frequency_type'], frequency_interval: interval, start_date: date, next_renewal_date: date, reminder_enabled: 0, reminder_days_before: 3, cancellation_reminder_enabled: 0, cancellation_reminder_date: null, end_date: null, total_cycles: null, note: null });
  return repo.savePlannedPayment(db, { name: 'Planned Clean Test', type: kind === 'income' ? 'INCOME' : 'EXPENSE', amount_minor: 20000, category_id: kind === 'income' ? 'cat_income_salary' : 'cat_expense_bills', account_id: 'account_cash_default', next_due_date: date, recurrence_type: recurrence, recurrence_interval: interval, reminder_enabled: 0, reminder_days_before: 3, end_date: null, occurrence_limit: null, note: null });
}
async function parent(kind: Kind, id: string) { return (kind === 'subscription' ? await repo.getSubscription(db, id) : await repo.getPlannedPayment(db, id))!; }
function next(p: PlannedPayment | Subscription) { return 'next_due_date' in p ? p.next_due_date : p.next_renewal_date; }
async function record(kind: Kind, id: string) {
  const p = await parent(kind, id);
  return kind === 'subscription' ? repo.markSubscriptionPaid(db, id, next(p), p.updated_at) : repo.markPlannedPaymentPaid(db, id, next(p));
}
async function balance() { return calculateAccountBalance((await repo.listAccounts(db))[0], await repo.listTransactions(db), await repo.listPersonEntries(db)); }
async function snapshot() { return Promise.all(BACKUP_TABLES.map(t => db.getAllAsync(`SELECT * FROM ${t} ORDER BY rowid;`))); }
async function report() { return buildInsightsSnapshot({ selection: { range: 'CUSTOM', from: '2026-10-01', to: '2026-12-31' }, trendMonths: 3, today: '2026-10-08', accounts: await repo.listAccounts(db), categories: await repo.listCategories(db), transactions: await repo.listTransactions(db), people: [], peopleEntries: [], subscriptions: await repo.listSubscriptions(db) }); }

test.each(['expense', 'income', 'subscription'] as const)('%s only recorded occurrence deletes exact money/history and reopens original date', async kind => {
  const id = await create(kind); const original = await parent(kind, id); const tx = await record(kind, id);
  expect(next(await parent(kind, id))).toBe('2026-11-08');
  expect(await balance()).toBe(kind === 'income' ? 120000 : kind === 'subscription' ? 50000 : 80000);
  const before = await report(); expect(kind === 'income' ? before.incomeMinor : before.personalSpendingMinor).toBe(kind === 'subscription' ? 50000 : 20000);
  await deleteRecordedPayment(db, await readRecordedPaymentDeletion(db, tx));
  expect(await balance()).toBe(100000); expect(next(await parent(kind, id))).toBe('2026-10-08');
  expect((await parent(kind, id)).schedule_provenance).toBe(original.schedule_provenance);
  expect(await repo.listTransactions(db)).toEqual([]); expect(await listActivity(db)).toEqual([]);
  const after = await report(); expect(after.incomeMinor).toBe(0); expect(after.personalSpendingMinor).toBe(0);
  expect(kind === 'subscription' ? await repo.listSubscriptionPayments(db, id) : await repo.listPlannedPaymentOccurrences(db, id)).toEqual([]);
  await service.preview(await service.export()); // Deleted transaction tombstone is compatible.
  const again = await record(kind, id); expect(again).not.toBe(tx); expect(await repo.listTransactions(db)).toHaveLength(1);
});

test.each(['expense', 'income', 'subscription'] as const)('%s older deletion preserves later payment then latest deletion rebuilds surviving history', async kind => {
  const id = await create(kind); const first = await record(kind, id); const second = await record(kind, id);
  const later = (await repo.listTransactions(db)).find(t => t.id === second);
  await deleteRecordedPayment(db, await readRecordedPaymentDeletion(db, first));
  expect(next(await parent(kind, id))).toBe('2026-12-08'); expect((await repo.listTransactions(db))[0]).toEqual(later);
  await deleteRecordedPayment(db, await readRecordedPaymentDeletion(db, second));
  expect(next(await parent(kind, id))).toBe('2026-10-08'); expect(await balance()).toBe(100000);
});

test('later skipped occurrence survives older deletion and keeps next date advanced', async () => {
  const id = await create('expense'); const tx = await record('expense', id); await repo.skipPlannedPayment(db, id, '2026-11-08');
  const skipped = (await repo.listPlannedPaymentOccurrences(db, id))[0];
  await deleteRecordedPayment(db, await readRecordedPaymentDeletion(db, tx));
  expect(next(await parent('expense', id))).toBe('2026-12-08'); expect(await repo.listPlannedPaymentOccurrences(db, id)).toEqual([skipped]);
  expect((await parent('expense', id) as PlannedPayment).completed_occurrences).toBe(0);
});

test.each(['expense', 'subscription'] as const)('%s prospective amount/name/account edit does not change the original reversal or anchor', async kind => {
  const id = await create(kind); const tx = await record(kind, id); const p = await parent(kind, id);
  await repo.createAccount(db, { name: 'Other account', type: 'BANK', currency: 'PKR', opening_balance_minor: 30000 }); const account = (await repo.listAccounts(db)).find(a => a.name === 'Other account')!;
  if (kind === 'subscription') await repo.updateSubscription(db, id, p.updated_at, { ...p as Subscription, name: 'Renamed service', amount_minor: 90000, account_id: account.id });
  else await repo.updatePlannedPayment(db, id, p.updated_at, { ...p as PlannedPayment, name: 'Renamed plan', amount_minor: 90000, account_id: account.id });
  await deleteRecordedPayment(db, await readRecordedPaymentDeletion(db, tx));
  const cash = (await repo.listAccounts(db)).find(a => a.id === 'account_cash_default')!;
  expect(calculateAccountBalance(cash, await repo.listTransactions(db), [])).toBe(100000); expect(calculateAccountBalance(account, await repo.listTransactions(db), [])).toBe(30000);
  expect(await parent(kind, id)).toMatchObject({ amount_minor: 90000, account_id: account.id, schedule_provenance: p.schedule_provenance }); expect(next(await parent(kind, id))).toBe('2026-10-08');
});
test('Planned one-time occurrence remains ended after deletion, with restored date but no silent restart', async () => {
  const id = await create('income', 'NONE'); const tx = await record('income', id); expect((await parent('income', id)).status).toBe('ENDED');
  await deleteRecordedPayment(db, await readRecordedPaymentDeletion(db, tx)); expect(await parent('income', id)).toMatchObject({ status: 'ENDED', completed_occurrences: 0, next_due_date: '2026-10-08' });
  await expect(record('income', id)).rejects.toThrow('Only active');
});
test('day recurrence real subscription November 6 occurrence deletion reopens November 6, not actual cash date', async () => {
  const id = await create('subscription', 'MONTHLY', 1, '2026-11-06'); const tx = await record('subscription', id);
  expect(next(await parent('subscription', id))).toBe('2026-12-06'); expect((await repo.listTransactions(db))[0].occurred_on).toBe('2026-10-08');
  await deleteRecordedPayment(db, await readRecordedPaymentDeletion(db, tx)); expect(next(await parent('subscription', id))).toBe('2026-11-06');
});
test('unlinked, conflicting or corrupt Planned source fails closed and preserves all rows', async () => {
  const id = await create('expense'); const tx = await record('expense', id);
  await db.runAsync("UPDATE transactions SET occurred_on = '2026-10-09' WHERE id = ?;", tx); const before = await snapshot();
  await expect(readRecordedPaymentDeletion(db, tx)).rejects.toThrow('conflicting'); expect(await snapshot()).toEqual(before);
});

test.each(['expense', 'subscription'] as const)('%s latest deletion returns to date after surviving earlier payment', async kind => {
  const id = await create(kind); const first = await record(kind, id); const last = await record(kind, id);
  await deleteRecordedPayment(db, await readRecordedPaymentDeletion(db, last));
  expect(next(await parent(kind, id))).toBe('2026-11-08'); expect((await repo.listTransactions(db))[0].id).toBe(first);
});

test.each([['expense', 'PAUSED'], ['expense', 'ENDED'], ['subscription', 'PAUSED'], ['subscription', 'CANCELLED'], ['subscription', 'ENDED']] as const)('%s deletion retains %s tracking intent', async (kind, status) => {
  const id = await create(kind); const tx = await record(kind, id);
  await db.runAsync(`UPDATE ${kind === 'subscription' ? 'subscriptions' : 'planned_payments'} SET status = ? WHERE id = ?;`, status, id);
  await deleteRecordedPayment(db, await readRecordedPaymentDeletion(db, tx));
  expect((await parent(kind, id)).status).toBe(status); expect(next(await parent(kind, id))).toBe('2026-10-08'); expect(await balance()).toBe(100000);
});
test('stopped Planned template stays stopped when its recorded transaction is deleted', async () => {
  const id = await create('expense'); const tx = await record('expense', id); const p = await parent('expense', id);
  await repo.stopTrackingPlannedPayment(db, id, p.updated_at);
  const stopped = await db.getFirstAsync<{ deleted_at: string }>('SELECT deleted_at FROM planned_payments WHERE id = ?;', id);
  await deleteRecordedPayment(db, await readRecordedPaymentDeletion(db, tx));
  expect(await db.getFirstAsync('SELECT deleted_at FROM planned_payments WHERE id = ?;', id)).toEqual(stopped); expect(await repo.listPlannedPayments(db)).toEqual([]);
});

test.each(['expense', 'subscription'] as const)('%s legacy null provenance reverses finance without guessing date', async kind => {
  const id = await create(kind); await db.runAsync(`UPDATE ${kind === 'subscription' ? 'subscriptions' : 'planned_payments'} SET schedule_provenance = NULL WHERE id = ?;`, id);
  const tx = await record(kind, id); const p = await parent(kind, id); const deletion = await readRecordedPaymentDeletion(db, tx);
  expect(deletion.scheduleRestored).toBe(false); expect(deletion.explanation).toContain('current next date will be kept');
  await deleteRecordedPayment(db, deletion); expect(next(await parent(kind, id))).toBe(next(p)); expect(await balance()).toBe(100000);
});
test.each(['expense', 'subscription'] as const)('%s explicit future schedule edit prevents deletion rewinding across revisions', async kind => {
  const id = await create(kind); const tx = await record(kind, id); const p = await parent(kind, id);
  if (kind === 'subscription') await repo.updateSubscription(db, id, p.updated_at, { ...p as Subscription, next_renewal_date: '2026-12-23', frequency_type: 'EVERY_N_DAYS', frequency_interval: 23 });
  else await repo.updatePlannedPayment(db, id, p.updated_at, { ...p as PlannedPayment, next_due_date: '2026-12-23', recurrence_type: 'EVERY_N_DAYS', recurrence_interval: 23 });
  const updated = await parent(kind, id); const deletion = await readRecordedPaymentDeletion(db, tx); expect(deletion.scheduleRestored).toBe(false);
  await deleteRecordedPayment(db, deletion); expect(next(await parent(kind, id))).toBe('2026-12-23'); expect((await parent(kind, id)).schedule_provenance).toBe(updated.schedule_provenance);
});
test.each(['expense', 'income', 'subscription'] as const)('%s duplicate posting/deletion and stale confirmation cannot change records', async kind => {
  const id = await create(kind); const p = await parent(kind, id); const tx = await record(kind, id);
  await expect(kind === 'subscription' ? repo.markSubscriptionPaid(db, id, next(p), p.updated_at) : repo.markPlannedPaymentPaid(db, id, next(p))).rejects.toThrow(/already/);
  const deletion = await readRecordedPaymentDeletion(db, tx); await record(kind, id); const before = await snapshot();
  await expect(deleteRecordedPayment(db, deletion)).rejects.toThrow('changed'); expect(await snapshot()).toEqual(before);
  const fresh = await readRecordedPaymentDeletion(db, tx); await deleteRecordedPayment(db, fresh); const after = await snapshot();
  await expect(deleteRecordedPayment(db, fresh)).rejects.toThrow(); expect(await snapshot()).toEqual(after);
});
test.each(['expense', 'subscription'] as const)('%s deletion rollback at every child-write boundary preserves exact data', async kind => {
  const id = await create(kind); const tx = await record(kind, id); const deletion = await readRecordedPaymentDeletion(db, tx); const before = await snapshot();
  for (const boundary of ['DELETE FROM', 'UPDATE transactions', `UPDATE ${kind === 'subscription' ? 'subscriptions' : 'planned_payments'}`]) {
    const run = db.runAsync.bind(db); const spy = jest.spyOn(db, 'runAsync').mockImplementation(async (s, ...args) => { if (s.startsWith(boundary)) throw new Error('Injected deletion failure'); return run(s, ...args); });
    await expect(deleteRecordedPayment(db, deletion)).rejects.toThrow('Injected'); spy.mockRestore(); expect(await snapshot()).toEqual(before); expect(await balance()).toBe(kind === 'subscription' ? 50000 : 80000);
  }
});

test.each([10, 15, 20, 23, 30, 60])('Every %i Days advances scheduled anchor across leap day/month boundary for both sources', async n => {
  const expected = advanceRecurrence('2028-02-20', 'EVERY_N_DAYS', n)!;
  for (const kind of ['expense', 'subscription'] as const) {
    const id = await create(kind, 'EVERY_N_DAYS', n, '2028-02-20'); const tx = await record(kind, id);
    expect(next(await parent(kind, id))).toBe(expected);
    if (kind === 'subscription') expect((await repo.listTransactions(db)).find(t => t.id === tx)?.occurred_on).toBe('2026-10-08');
    await deleteRecordedPayment(db, await readRecordedPaymentDeletion(db, tx)); expect(next(await parent(kind, id))).toBe('2028-02-20');
  }
  expect(formatRecurrenceLabel('EVERY_N_DAYS', n)).toBe(`Every ${n} days`);
});
test('Daily, every 30 days and monthly remain distinct; local leap/year math and integer monthly estimate', () => {
  expect(advanceRecurrence('2028-02-28', 'DAILY')).toBe('2028-02-29'); expect(advanceRecurrence('2026-12-31', 'DAILY')).toBe('2027-01-01');
  expect(advanceRecurrence('2028-01-31', 'EVERY_N_DAYS', 30)).toBe('2028-03-01'); expect(advanceRecurrence('2028-01-31', 'MONTHLY')).toBe('2028-02-29');
  expect(normalizedMonthlyCost({ amount_minor: 10000, frequency_type: 'DAILY', frequency_interval: 1 })).toBe(304167);
  expect(normalizedMonthlyCost({ amount_minor: 10000, frequency_type: 'EVERY_N_DAYS', frequency_interval: 30 })).toBe(10139);
});
test.each(['', '0', '-1', '1.5', 'abc', '3651', '9007199254740992'])('invalid Every N Days input %s is rejected', value => {
  expect(validateRecurrenceInterval('EVERY_N_DAYS', parseRecurrenceInterval(value))).not.toBeNull();
});
test.each(['expense', 'subscription'] as const)('%s new day interval edit/pause/resume retains anchor and creates no money until recorded', async kind => {
  const id = await create(kind, 'DAILY'); const p = await parent(kind, id);
  if (kind === 'subscription') await repo.updateSubscription(db, id, p.updated_at, { ...p as Subscription, frequency_type: 'EVERY_N_DAYS', frequency_interval: 15 });
  else await repo.updatePlannedPayment(db, id, p.updated_at, { ...p as PlannedPayment, recurrence_type: 'EVERY_N_DAYS', recurrence_interval: 15 });
  const updated = await parent(kind, id);
  if (kind === 'subscription') { await repo.changeSubscriptionStatus(db, id, updated.updated_at, 'PAUSED'); await repo.changeSubscriptionStatus(db, id, (await parent(kind, id)).updated_at, 'ACTIVE'); }
  else { await repo.pausePlannedPayment(db, id, updated.updated_at); await repo.resumePlannedPayment(db, id, (await parent(kind, id)).updated_at); }
  expect(await repo.listTransactions(db)).toEqual([]); expect((await parent(kind, id)).schedule_provenance).toBe(updated.schedule_provenance);
  await record(kind, id); expect(next(await parent(kind, id))).toBe('2026-10-23');
});
test('Planned monthly original 31 anchor survives short months and deletion', async () => {
  const id = await create('expense', 'MONTHLY', 1, '2028-01-31'); await record('expense', id); const feb = await record('expense', id);
  expect(next(await parent('expense', id))).toBe('2028-03-31'); await deleteRecordedPayment(db, await readRecordedPaymentDeletion(db, feb)); expect(next(await parent('expense', id))).toBe('2028-02-29');
});
test('changing future limits in February retains the Planned monthly 31 anchor without altering earlier history', async () => {
  const id = await create('expense', 'MONTHLY', 1, '2028-01-31'); await record('expense', id); const p = await parent('expense', id) as PlannedPayment;
  const before = await repo.listPlannedPaymentOccurrences(db, id);
  await repo.updatePlannedPayment(db, id, p.updated_at, { ...p, occurrence_limit: 10 }); await record('expense', id);
  expect(next(await parent('expense', id))).toBe('2028-03-31'); expect((await repo.listPlannedPaymentOccurrences(db, id))[1]).toEqual(before[0]);
});
test('Every N Days rejects date-range overflow before any financial posting', async () => {
  const id = await create('expense', 'EVERY_N_DAYS', 60, '9999-12-31'); const before = await snapshot();
  await expect(record('expense', id)).rejects.toThrow('supported date range'); expect(await snapshot()).toEqual(before);
});
test('Every N Days skip remains scheduled-anchor based and deletion retains skipped history', async () => {
  const id = await create('expense', 'EVERY_N_DAYS', 23); const tx = await record('expense', id); await repo.skipPlannedPayment(db, id, '2026-10-31');
  await deleteRecordedPayment(db, await readRecordedPaymentDeletion(db, tx)); expect(next(await parent('expense', id))).toBe('2026-11-23');
  expect(await repo.listPlannedPaymentOccurrences(db, id)).toMatchObject([{ scheduled_date: '2026-10-31', outcome: 'SKIPPED' }]);
});

test('schema 13 backup round-trips Daily/custom anchors, skipped/recorded/deleted history and deletion remains usable', async () => {
  const planned = await create('expense', 'EVERY_N_DAYS', 23); const subscription = await create('subscription', 'DAILY');
  const tx = await record('expense', planned); await repo.skipPlannedPayment(db, planned, '2026-10-31'); const subTx = await record('subscription', subscription);
  await deleteRecordedPayment(db, await readRecordedPaymentDeletion(db, tx)); const text = await service.export();
  await service.preview(text); await service.restore(text, async () => {}); expect(await service.export()).toBe(text);
  await deleteRecordedPayment(db, await readRecordedPaymentDeletion(db, subTx)); expect(next(await parent('subscription', subscription))).toBe('2026-10-08');
});
test.each([8, 9, 10, 11, 12] as const)('schema %i legacy backup preserves history and supplies NULL provenance without historical guessing', async version => {
  const id = await create('expense'); const tx = await record('expense', id); const backup = JSON.parse(await service.export()) as Backup; backup.schemaVersion = version;
  stripScheduleProvenanceForFixture(backup);
  if (version < 12) for (const t of [...backup.data.transactions, ...backup.data.person_entries]) delete t.cash_effect_minor;
  if (version < 10) for (const s of backup.data.split_groups) delete s.split_definition;
  await service.preview(JSON.stringify(backup)); await service.restore(JSON.stringify(backup), async () => {});
  expect((await parent('expense', id)).schedule_provenance).toBeNull(); expect((await repo.listTransactions(db))[0].id).toBe(tx);
  await deleteRecordedPayment(db, await readRecordedPaymentDeletion(db, tx)); expect(next(await parent('expense', id))).toBe('2026-11-08');
});
test('malformed provenance and day intervals fail backup before safety copy/replacement', async () => {
  const id = await create('expense', 'EVERY_N_DAYS', 10); await record('expense', id); const text = await service.export(); const before = await snapshot();
  for (const mutate of [
    (b: Backup) => { b.data.planned_payments[0].recurrence_interval = 0; },
    (b: Backup) => { b.data.planned_payments[0].schedule_provenance = '{}'; },
    (b: Backup) => { const p = JSON.parse(String(b.data.planned_payments[0].schedule_provenance)); p.interval = 23; b.data.planned_payments[0].schedule_provenance = JSON.stringify(p); },
    (b: Backup) => { b.data.planned_payment_occurrences[0].scheduled_date = '2026-10-09'; },
  ]) { const b: Backup = JSON.parse(text); mutate(b); const safety = jest.fn(); await expect(service.restore(JSON.stringify(b), safety)).rejects.toThrow(); expect(safety).not.toHaveBeenCalled(); expect(await snapshot()).toEqual(before); }
});
test('migration 13 preserves legacy rows/provenance unknown and rolls back/retries all four additions', async () => {
  const id = await create('expense'); await record('expense', id); await removeMigration13ForFixture(db); const before = await snapshot();
  const schema = await db.getAllAsync('SELECT * FROM sqlite_schema ORDER BY name;'); const run = db.runAsync.bind(db);
  const spy = jest.spyOn(db, 'runAsync').mockImplementation(async (s, ...args) => { if (s.includes('INSERT INTO schema_migrations') && args[0] === 13) throw new Error('migration interrupted'); return run(s, ...args); });
  await expect(openAppDatabase()).rejects.toThrow('migration interrupted'); spy.mockRestore(); expect(await snapshot()).toEqual(before); expect(await db.getAllAsync('SELECT * FROM sqlite_schema ORDER BY name;')).toEqual(schema);
  await openAppDatabase(); expect(decodeScheduleProvenance((await create('expense').then(id => parent('expense', id))).schedule_provenance!).version).toBe(1);
  expect((await parent('expense', id)).schedule_provenance).toBeNull(); expect((await repo.listPlannedPaymentOccurrences(db, id))[0].schedule_provenance).toBeNull();
  const after = await snapshot(); await openAppDatabase(); expect(await snapshot()).toEqual(after);
});

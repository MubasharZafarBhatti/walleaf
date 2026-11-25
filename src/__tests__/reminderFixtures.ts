import { DatabaseSync } from 'node:sqlite';
import * as SQLite from 'expo-sqlite';
import { openAppDatabase, type AppDb } from '../database/database';
import * as repo from '../database/repositories/repositories';
import type { PlannedPayment, Subscription } from '../types/models';
import type { ManagedReminder, NotificationBoundary, ReminderPermission } from '../services/notifications/NotificationService';

export async function reminderDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  const transaction = async (work: () => Promise<void>) => { sqlite.exec('BEGIN'); try { await work(); sqlite.exec('COMMIT'); } catch (e) { sqlite.exec('ROLLBACK'); throw e; } };
  const adapter = { execAsync: async (sql: string) => { sqlite.exec(sql); },
    runAsync: async (sql: string, ...args: (string | number | null)[]) => sqlite.prepare(sql).run(...args),
    getFirstAsync: async (sql: string, ...args: (string | number | null)[]) => sqlite.prepare(sql).get(...args) ?? null,
    getAllAsync: async (sql: string, ...args: (string | number | null)[]) => sqlite.prepare(sql).all(...args),
    withTransactionAsync: transaction,
    withExclusiveTransactionAsync: async (work: (txn: AppDb) => Promise<void>) => transaction(() => work(db)),
  };
  const db = adapter as unknown as AppDb;
  jest.mocked(SQLite.openDatabaseAsync).mockResolvedValue(db); await openAppDatabase();
  const financial = () => Promise.all(['accounts', 'transactions', 'person_entries', 'planned_payments', 'planned_payment_occurrences', 'subscriptions', 'subscription_payments', 'budgets'].map(t => db.getAllAsync(`SELECT * FROM ${t} ORDER BY rowid;`)));
  return { db, close: () => sqlite.close(), financial };
}
export async function reminderPlan(db: AppDb, overrides: Partial<PlannedPayment> = {}) {
  const id = await repo.savePlannedPayment(db, { name: 'Internet Bill', type: 'EXPENSE', amount_minor: 20000, category_id: 'cat_expense_bills', account_id: 'account_cash_default', next_due_date: '2026-10-20', recurrence_type: 'NONE', recurrence_interval: 1, end_date: null, occurrence_limit: null, reminder_enabled: 1, reminder_days_before: 3, note: null, ...overrides });
  return (await repo.getPlannedPayment(db, id))!;
}
export async function reminderSubscription(db: AppDb, overrides: Partial<Subscription> = {}) {
  const id = await repo.saveSubscription(db, { name: 'Netflix', amount_minor: 50000, category_id: 'cat_expense_subscriptions', account_id: 'account_cash_default', start_date: '2026-10-20', next_renewal_date: '2026-10-20', frequency_type: 'MONTHLY', frequency_interval: 1, end_date: null, total_cycles: null, reminder_enabled: 1, reminder_days_before: 3, cancellation_reminder_enabled: 0, cancellation_reminder_date: null, note: null, ...overrides });
  return (await repo.getSubscription(db, id))!;
}
export function reminderNative(initial: ReminderPermission = 'granted') {
  let permission = initial;
  const pending: { identifier: string; content: { data: Record<string, unknown> } }[] = [];
  const saved: ManagedReminder[] = [];
  const boundary: NotificationBoundary = {
    getPermission: jest.fn(async () => permission), requestPermission: jest.fn(async () => permission),
    getScheduled: jest.fn(async () => [...pending]),
    schedule: jest.fn(async (item, signature) => { pending.push({ identifier: item.key, content: { data: { managedBy: 'expense-tracker', reminderKey: item.key, scheduleSignature: signature } } }); saved.push(item); return item.key; }),
    cancel: jest.fn(async id => { const index = pending.findIndex(p => p.identifier === id); if (index >= 0) pending.splice(index, 1); }),
  };
  return { boundary, pending, saved, permission: (value: ReminderPermission) => { permission = value; } };
}

import type { AppDb } from '../../database/database';
import * as repo from '../../database/repositories/repositories';
import { projectAccountOutflow } from '../finance/FinanceService';
import { displayFullDate, todayLocal } from '../../utils/date';
import { formatMoney } from '../../utils/money';
import type { ReminderTarget } from './ReminderNavigation';

export type ReminderPaymentResult = { ok: boolean; title: string; body: string };

/**
 * "Mark as paid" / "Mark as received" pressed on a reminder card. The press is
 * the user's confirmation; recording reuses the same atomic paths as the
 * in-app Record/Mark Paid buttons. Without a dialog to ask, it refuses (and
 * explains) instead of overdrawing an account, double-recording, or recording
 * a stale occurrence.
 */
export async function recordPaymentFromReminder(db: AppDb, target: ReminderTarget): Promise<ReminderPaymentResult> {
  const settings = await repo.getSettings(db);
  // The receipt shows the amount in the currency of the account it was paid from.
  const currencies = new Map((await repo.listAccountCurrencies(db)).map((row) => [row.id, row.currency]));
  const money = (minor: number, accountId: string) => formatMoney(minor, currencies.get(accountId) ?? settings.currency);
  const notRecorded = (body: string): ReminderPaymentResult => ({ ok: false, title: 'Not recorded', body });
  const date = displayFullDate(target.occurrenceDate);

  const wouldOverdraw = async (accountId: string, amountMinor: number) => {
    const [accounts, transactions, entries] = await Promise.all([repo.listAccounts(db), repo.listTransactions(db), repo.listPersonEntries(db)]);
    const account = accounts.find(item => item.id === accountId);
    if (!account) return 'Its account is no longer active. Open the app to choose another account.';
    return projectAccountOutflow(account, transactions, entries, amountMinor).needsConfirmation
      ? `${account.name} would go below zero. Open the app to record it if that is correct.` : null;
  };

  if (target.sourceType === 'planned_payment') {
    const plan = await repo.getPlannedPayment(db, target.sourceId);
    if (!plan) return notRecorded('This planned payment is no longer tracked.');
    const income = plan.type === 'INCOME';
    if (plan.next_due_date !== target.occurrenceDate) {
      const handled = (await repo.listPlannedPaymentOccurrences(db, plan.id)).find(item => item.scheduled_date === target.occurrenceDate);
      return notRecorded(handled
        ? `${plan.name} for ${date} was already ${handled.outcome === 'RECORDED' ? 'recorded' : 'skipped'}. No duplicate was created.`
        : `This reminder is out of date. ${plan.name} is now due ${displayFullDate(plan.next_due_date)}.`);
    }
    if (plan.status !== 'ACTIVE') return notRecorded(`${plan.name} is paused. Resume it in the app to record payments.`);
    if (!income) { const problem = await wouldOverdraw(plan.account_id, plan.amount_minor); if (problem) return notRecorded(problem); }
    try { await repo.markPlannedPaymentPaid(db, plan.id, plan.next_due_date); }
    catch (error) {
      if (error instanceof Error && error.message === 'This scheduled occurrence was already handled.') return notRecorded(`${plan.name} for ${date} was already recorded. No duplicate was created.`);
      return notRecorded(`${plan.name} could not be recorded. Open the app to try again.`);
    }
    const accountName = (await repo.listAccounts(db)).find(item => item.id === plan.account_id)?.name ?? 'your account';
    return { ok: true, title: income ? 'Income recorded' : 'Payment recorded', body: `${money(plan.amount_minor, plan.account_id)} ${income ? 'into' : 'from'} ${accountName} · ${plan.name}` };
  }

  const sub = await repo.getSubscription(db, target.sourceId);
  if (!sub) return notRecorded('This subscription is no longer tracked.');
  if (sub.next_renewal_date !== target.occurrenceDate) {
    const paid = (await repo.listSubscriptionPayments(db, sub.id)).some(item => item.scheduled_date === target.occurrenceDate);
    return notRecorded(paid
      ? `${sub.name} for ${date} was already recorded. No duplicate was created.`
      : `This reminder is out of date. ${sub.name} now renews ${displayFullDate(sub.next_renewal_date)}.`);
  }
  if (sub.status !== 'ACTIVE') return notRecorded(`${sub.name} is not active. Resume it in the app to record payments.`);
  const problem = await wouldOverdraw(sub.account_id, sub.amount_minor);
  if (problem) return notRecorded(problem);
  try { await repo.markSubscriptionPaid(db, sub.id, sub.next_renewal_date, sub.updated_at, todayLocal()); }
  catch (error) {
    if (error instanceof Error && error.message === 'This subscription occurrence was already paid.') return notRecorded(`${sub.name} for ${date} was already recorded. No duplicate was created.`);
    return notRecorded(`${sub.name} could not be recorded. Open the app to try again.`);
  }
  const accountName = (await repo.listAccounts(db)).find(item => item.id === sub.account_id)?.name ?? 'your account';
  return { ok: true, title: 'Payment recorded', body: `${money(sub.amount_minor, sub.account_id)} from ${accountName} · ${sub.name}` };
}

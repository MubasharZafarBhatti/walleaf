import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { Card, EmptyState, ListRow, MoneyText, PrimaryButton, SecondaryButton, SectionHeader, TextField } from '../components/common';
import { FormScreen, Picker } from '../components/forms';
import { useAppDialog } from '../components/dialogs/AppDialogProvider';
import { useAppData } from '../hooks/useAppData';
import { useCurrencyInfo } from '../hooks/useCurrencyInfo';
import { CurrencyProvider, useAccountLabel } from '../components/CurrencyView';
import { useSubmitGuard } from '../hooks/useSubmitGuard';
import { useReminderSelectionWarning } from '../hooks/useReminderSelectionWarning';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { useConfirmOutflow } from '../hooks/useConfirmOutflow';
import { getSubscriptionDueStatus, normalizedMonthlyCost } from '../services/subscriptions/SubscriptionService';
import type { Subscription, SubscriptionPayment, FrequencyType } from '../types/models';
import { dateKeyToInputDate, displayFullDate, inputDateToDateKey, todayLocal } from '../utils/date';
import { moneyToMinorUnits } from '../utils/money';
import { formatReminderAck, useReminderAck } from '../hooks/useReminderAck';
import { reminderOffsetLabel } from '../services/planned/PlannedPaymentService';
import { validMoneyInput } from '../utils/formValidation';
import { formatRecurrenceLabel, parseRecurrenceInterval, recurrenceIntervalForSave, subscriptionFrequencyRows, validateRecurrenceInterval } from '../utils/recurrence';
import { colors } from '../theme';
import { categoryRows } from '../utils/icons';
import { LabelWithInfo } from '../components/InfoTip';

type Snapshot = Subscription & { account_name: string | null; category_name: string | null };
function draftFor(sub: Subscription) {
  return {
    name: sub.name, amount: (sub.amount_minor / 100).toFixed(2),
    account: sub.account_id, category: sub.category_id, date: dateKeyToInputDate(sub.next_renewal_date),
    frequency: sub.frequency_type, interval: String(sub.frequency_interval),
    reminder: String(sub.reminder_enabled), days: String(sub.reminder_days_before),
    cancellation: String(sub.cancellation_reminder_enabled),
    cancellationDate: sub.cancellation_reminder_date ? dateKeyToInputDate(sub.cancellation_reminder_date) : '',
    note: sub.note ?? '',
  };
}
const toggles = [['0', 'Off'], ['1', 'On']];
function draftIdentity(draft: ReturnType<typeof draftFor>) {
  return JSON.stringify({ ...draft, name: draft.name.trim(), note: draft.note.trim(), amount: moneyToMinorUnits(draft.amount) });
}

export function SubscriptionDetailScreen({ route, navigation }: any) {
  const { db, repo, accounts, categories, subscriptions, refresh, currentDateKey = todayLocal() } = useAppData();
  // A subscription is paid from one account, so it is shown in that account's currency.
  const { accountCurrency, mainCurrency } = useCurrencyInfo();
  const accountLabel = useAccountLabel();
  const focused = useIsFocused();
  const dialog = useAppDialog();
  const confirmOutflow = useConfirmOutflow();
  const [sub, setSub] = useState<Snapshot | null>(null);
  const [payments, setPayments] = useState<SubscriptionPayment[]>([]);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [editor, setEditor] = useState<{ original: Snapshot; draft: ReturnType<typeof draftFor> } | null>(null);
  const id: string = route.params.subscriptionId;
  const actions = useSubmitGuard(async () => { await refresh(); setRetry((value) => value + 1); });
  const editorChanged = !!editor && draftIdentity(editor.draft) !== draftIdentity(draftFor(editor.original));
  const dirty = useDirtyForm(editorChanged, actions.isSaving);
  const reminderWarning = useReminderSelectionWarning({ name: editor?.draft.name ?? sub?.name ?? '', kind: 'subscription', enabled: editor && (editor.draft.reminder === '1' || editor.draft.cancellation === '1') ? '1' : '0', days: editor?.draft.days ?? '3', available: !!sub, save: () => save() });
  const reminderAck = useReminderAck('subscription', id, `${focused}:${sub?.updated_at}:${retry}`);

  useEffect(() => {
    if (!db || !focused) return;
    let active = true;
    setSub(null);
    setError('');
    Promise.all([repo.getSubscription(db, id), repo.listSubscriptionPayments(db, id)])
      .then(([value, history]) => {
        if (!active) return;
        if (!value) { setError('Subscription is no longer available.'); return; }
        setSub(value); setPayments(history);
      })
      .catch(() => { if (active) setError('Could not load subscription and payment history.'); });
    return () => { active = false; };
  }, [db, focused, id, repo, subscriptions, retry]);

  if (!sub) return <FormScreen title="Subscription"><EmptyState title={error || 'Loading subscription...'} />{error ? <SecondaryButton title="Retry" onPress={() => setRetry(retry + 1)} /> : null}</FormScreen>;
  const due = getSubscriptionDueStatus(sub, currentDateKey);
  const canTrack = sub.status === 'ACTIVE' || sub.status === 'PAUSED';
  const set = (key: keyof ReturnType<typeof draftFor>, value: string) => {
    setEditor((current) => current ? { ...current, draft: { ...current.draft, [key]: value } } : null);
    if (key === 'reminder') reminderWarning.select(value, editor?.draft.days ?? '3');
    if (key === 'days') reminderWarning.select(editor?.draft.reminder ?? '0', value, false);
    if (key === 'cancellation') reminderWarning.select(value, '0');
  };
  const submit = (work: () => Promise<void>) => actions.submit(async () => {
    try { await work(); }
    catch (failure) { dialog.showDialog({ title: failure instanceof Error && failure.message === 'This subscription occurrence was already paid.' ? 'Already recorded' : 'Could not save subscription', message: failure instanceof Error && failure.message === 'This subscription occurrence was already paid.' ? 'This subscription payment has already been recorded for this scheduled date. You can review it in the payment history.' : failure instanceof Error ? failure.message : 'Your input has been kept. Please try again.' }); }
  });

  const paid = () => submit(async () => {
    if (!db) return;
    const paymentDate = todayLocal();
    const early = sub.next_renewal_date > paymentDate;
    if (!await dialog.confirm({ title: early ? 'Record an early payment?' : 'Mark subscription paid?', message: `Record one expense paid today, ${displayFullDate(paymentDate)}, for the renewal scheduled ${displayFullDate(sub.next_renewal_date)}. The billing schedule will advance once from that scheduled date.`, confirmText: 'Mark Paid' })) return;
    if (!await confirmOutflow(sub.account_id, sub.amount_minor)) return;
    await repo.markSubscriptionPaid(db, sub.id, sub.next_renewal_date, sub.updated_at, paymentDate);
    await actions.saved('Subscription payment recorded', () => {});
  });
  const status = (value: 'ACTIVE' | 'PAUSED' | 'CANCELLED') => submit(async () => {
    if (!db) return;
    if (value === 'CANCELLED' && !await dialog.confirm({ title: 'Cancel Tracking?', message: 'This only stops tracking the subscription in this app. It does not cancel the actual service. Recorded expenses and payment history will be kept.', confirmText: 'Cancel Tracking', cancelText: 'Keep Tracking', destructive: true })) return;
    await repo.changeSubscriptionStatus(db, sub.id, sub.updated_at, value);
    await actions.saved(value === 'ACTIVE' ? 'Subscription resumed' : value === 'PAUSED' ? 'Subscription paused' : 'Subscription tracking cancelled', () => {});
  });
  const save = () => submit(async () => {
    if (!db || !editor) return;
    const d = editor.draft;
    const amount = moneyToMinorUnits(d.amount);
    const date = d.date.trim() ? inputDateToDateKey(d.date) : null;
    const cancelDate = d.cancellationDate.trim() ? inputDateToDateKey(d.cancellationDate) : null;
    const interval = parseRecurrenceInterval(d.interval);
    const intervalError = validateRecurrenceInterval(d.frequency, interval);
    if (!amount || amount <= 0) throw new Error('Enter an amount greater than zero.');
    if (!date) throw new Error('Enter a valid next billing date.');
    if (d.cancellationDate.trim() && !cancelDate) throw new Error('Enter a valid cancellation reminder date.');
    if (intervalError) throw new Error(intervalError);
    if (!/^\d+$/.test(d.days)) throw new Error('Reminder days must be a nonnegative whole number.');
    if (!await reminderWarning.beforeSave()) return;
    await repo.updateSubscription(db, sub.id, editor.original.updated_at, {
      ...editor.original, name: d.name, amount_minor: amount, account_id: d.account, category_id: d.category,
      next_renewal_date: date, frequency_type: d.frequency as FrequencyType,
      frequency_interval: recurrenceIntervalForSave(d.frequency, interval),
      reminder_enabled: Number(d.reminder), reminder_days_before: Number(d.days),
      cancellation_reminder_enabled: Number(d.cancellation), cancellation_reminder_date: cancelDate, note: d.note,
    });
    await actions.saved('Subscription updated', () => setEditor(null));
  });

  return <FormScreen title={sub.name}>
    <CurrencyProvider currency={accountCurrency.get(sub.account_id) ?? mainCurrency}>
    <Card>
      <MoneyText amount={sub.amount_minor} style={{ fontSize: 28 }} />
      <Text>Status: {due.label}</Text>
      <Text>Category: {sub.category_name ?? 'Unavailable category'}</Text>
      <Text>Account: {sub.account_name ? accountLabel({ name: sub.account_name, currency: accountCurrency.get(sub.account_id) ?? mainCurrency }) : 'Unavailable account'}</Text>
      <Text>Frequency: {formatRecurrenceLabel(sub.frequency_type, sub.frequency_interval)}</Text>
      <Text>Next billing: {displayFullDate(sub.next_renewal_date)}</Text>
      <Text>Started: {displayFullDate(sub.start_date)}</Text>
      {sub.end_date ? <Text>Tracking ends: {displayFullDate(sub.end_date)}</Text> : null}
      {sub.total_cycles != null ? <Text>Recorded cycles: {sub.completed_cycles} of {sub.total_cycles}</Text> : null}
      <Text>Note: {sub.note || 'None'}</Text>
      <Text>Estimated monthly cost (reporting only)</Text><MoneyText amount={normalizedMonthlyCost(sub)} />
      <Text>Reminder preference: {sub.reminder_enabled ? reminderOffsetLabel(sub.reminder_days_before, 'On the renewal date') : 'Off'}</Text>
      {reminderAck ? <Text style={{ color: colors.muted }}>{formatReminderAck(reminderAck)}</Text> : null}
      <Text>Trial / cancellation reminder: {sub.cancellation_reminder_enabled && sub.cancellation_reminder_date ? displayFullDate(sub.cancellation_reminder_date) : 'Off'}</Text>
      <LabelWithInfo label="When to mark it paid" info="Mark Paid when the renewal actually happens. Pause and Resume do not move money or create missed payments." textStyle={{ color: colors.muted }} />
    </Card>
    {editor ? <Card>
      <Text>Changes apply to future tracking. Recorded payments stay unchanged.</Text>
      <TextField label="Name" placeholder="Netflix" value={editor.draft.name} onChangeText={(v) => set('name', v)} />
      <TextField label="Amount" placeholder="1500" value={editor.draft.amount} onChangeText={(v) => set('amount', v)} keyboardType="decimal-pad" />
      <Picker label="Category" value={editor.draft.category} setValue={(v) => set('category', v)} rows={categoryRows(categories.filter((c) => c.type === 'EXPENSE' && !c.is_archived))} />
      <Picker label="Account" value={editor.draft.account} setValue={(v) => set('account', v)} rows={accounts.filter((a) => !sub || (a.currency ?? mainCurrency) === (accountCurrency.get(sub.account_id) ?? mainCurrency)).map((a) => [a.id, accountLabel(a)])} />
      <TextField label="Next billing date" info="Changing this date also sets the day of the month (or week) future renewals fall on." placeholder="DD-MM-YYYY" value={editor.draft.date} onChangeText={(v) => set('date', v)} allowFuture allowPast={false} />
      <Picker label="Frequency" value={editor.draft.frequency} setValue={(v) => set('frequency', v)} rows={subscriptionFrequencyRows} />
      {editor.draft.frequency === 'EVERY_N_MONTHS' || editor.draft.frequency === 'EVERY_N_DAYS' ? <TextField label={editor.draft.frequency === 'EVERY_N_DAYS' ? 'Repeat every days' : 'Repeat every months'} placeholder="3" value={editor.draft.interval} onChangeText={(v) => set('interval', v)} keyboardType="number-pad" money={false} /> : null}
      <Picker label="Reminder" value={editor.draft.reminder} setValue={(v) => set('reminder', v)} rows={toggles} />
      <TextField label="Reminder days before" value={editor.draft.days} onChangeText={(v) => set('days', v)} onBlur={reminderWarning.checkSelection} keyboardType="number-pad" />
      <Picker label="Trial / cancellation reminder" value={editor.draft.cancellation} setValue={(v) => set('cancellation', v)} rows={toggles} />
      <TextField label="Cancellation reminder date" placeholder="DD-MM-YYYY" value={editor.draft.cancellationDate} onChangeText={(v) => set('cancellationDate', v)} allowFuture allowPast={false} />
      <TextField label="Note" placeholder="Optional" value={editor.draft.note} onChangeText={(v) => set('note', v)} />
      <PrimaryButton title="Save Changes" onPress={save} saving={actions.saving} disabled={reminderWarning.busy || !editorChanged || !editor.draft.name.trim() || !validMoneyInput(editor.draft.amount) || !inputDateToDateKey(editor.draft.date) || !accounts.some((item) => item.id === editor.draft.account) || !categories.some((item) => item.id === editor.draft.category && !item.is_archived) || !!validateRecurrenceInterval(editor.draft.frequency, parseRecurrenceInterval(editor.draft.interval)) || !/^\d+$/.test(editor.draft.days) || !!(editor.draft.cancellationDate && !inputDateToDateKey(editor.draft.cancellationDate))} />
      <SecondaryButton title="Cancel" disabled={actions.saving} onPress={() => dirty.discard(() => setEditor(null))} />
    </Card> : <>
      {sub.status === 'ACTIVE' && due.status !== 'ENDED' ? <PrimaryButton title="Mark Paid" onPress={paid} saving={actions.saving} /> : null}
      {canTrack ? <SecondaryButton title="Edit" onPress={() => { reminderWarning.reset(); setEditor({ original: sub, draft: draftFor(sub) }); }} disabled={actions.saving} /> : null}
      {sub.status === 'ACTIVE' ? <SecondaryButton title="Pause" onPress={() => status('PAUSED')} disabled={actions.saving} /> : null}
      {sub.status === 'PAUSED' ? <SecondaryButton title="Resume" onPress={() => status('ACTIVE')} disabled={actions.saving} /> : null}
      {canTrack ? <SecondaryButton title="Cancel Tracking" onPress={() => status('CANCELLED')} disabled={actions.saving} /> : null}
    </>}
    <SectionHeader title="Payment History" />
    {payments.length ? payments.map((p) => <ListRow key={p.id}
      card
      icon="checkmark-circle-outline"
      iconTone="negative"
      title={p.transaction_available ? `Paid · ${p.transaction_title}` : 'Expense unavailable'}
      subtitle={`${p.transaction_date ? displayFullDate(p.transaction_date) : 'Payment date unavailable'} · ${p.account_name ? accountLabel({ name: p.account_name, currency: accountCurrency.get(sub.account_id) ?? mainCurrency }) : ''} · ${p.category_name ?? ''}`}
      right={p.transaction_available && p.transaction_amount_minor != null ? <MoneyText amount={-p.transaction_amount_minor} type="negative" /> : undefined}
      onPress={p.transaction_available ? () => navigation.navigate('ActivityDetail', { kind: 'transaction', sourceId: p.transaction_id }) : undefined}
    />) : <EmptyState title="No payments recorded yet." subtitle="Mark Paid records one real expense and links it here." />}
    </CurrencyProvider>
  </FormScreen>;
}

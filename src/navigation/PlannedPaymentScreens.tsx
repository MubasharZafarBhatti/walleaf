import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import {
  Card,
  EmptyState,
  ListRow,
  MoneyText,
  PrimaryButton,
  SecondaryButton,
  SectionHeader,
  TextField,
} from '../components/common';
import { useAppDialog } from '../components/dialogs/AppDialogProvider';
import { FormScreen, Picker } from '../components/forms';
import { useAppData } from '../hooks/useAppData';
import { useCurrencyInfo } from '../hooks/useCurrencyInfo';
import { CurrencyProvider, useAccountLabel } from '../components/CurrencyView';
import { useConfirmOutflow } from '../hooks/useConfirmOutflow';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { useSubmitGuard } from '../hooks/useSubmitGuard';
import { useReminderSelectionWarning } from '../hooks/useReminderSelectionWarning';
import {
  getPlannedDueStatus,
  plannedRecordActionLabel,
  reminderOffsetLabel,
} from '../services/planned/PlannedPaymentService';
import { colors } from '../theme';
import type {
  PlannedPaymentOccurrence,
  PlannedPaymentType,
  PlannedRecurrenceType,
} from '../types/models';
import {
  dateKeyToInputDate,
  displayFullDate,
  inputDateToDateKey,
  todayLocal,
} from '../utils/date';
import { moneyToMinorUnits } from '../utils/money';
import { formatReminderAck, useReminderAck } from '../hooks/useReminderAck';
import { validMoneyInput } from '../utils/formValidation';
import {
  formatRecurrenceLabel,
  parseRecurrenceInterval,
  plannedRecurrenceRows,
  recurrenceIntervalForSave,
  validateRecurrenceInterval,
} from '../utils/recurrence';
import { categoryRows } from '../utils/icons';

const typeRows = [
  ['EXPENSE', 'Expense'],
  ['INCOME', 'Income'],
];
const reminderRows = [
  ['0', 'Off'],
  ['1', 'On'],
];
const reminderDayRows = [0, 1, 2, 3, 7].map((days) => [
  String(days),
  reminderOffsetLabel(days),
]);

export function PlannedPaymentDetailScreen({ route, navigation }: any) {
  const { db, repo, plannedPayments, categories, accounts, refresh, currentDateKey = todayLocal() } =
    useAppData();
  // A planned payment uses one account, so it is shown in that account's currency.
  const { accountCurrency, mainCurrency } = useCurrencyInfo();
  const accountLabel = useAccountLabel();
  const focused = useIsFocused();
  const dialog = useAppDialog();
  const confirmOutflow = useConfirmOutflow();
  const actions = useSubmitGuard(refresh);
  const plan = plannedPayments.find((item) => item.id === route.params.plannedPaymentId);
  const [history, setHistory] = useState<PlannedPaymentOccurrence[]>([]);
  const [historyError, setHistoryError] = useState('');
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<PlannedPaymentType>('EXPENSE');
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [nextDate, setNextDate] = useState('');
  const [recurrence, setRecurrence] = useState<PlannedRecurrenceType>('NONE');
  const [interval, setInterval] = useState('3');
  const [reminderEnabled, setReminderEnabled] = useState('0');
  const [reminderDays, setReminderDays] = useState('3');
  const [note, setNote] = useState('');
  const reminderWarning = useReminderSelectionWarning({ name, kind: type === 'INCOME' ? 'planned_income' : 'planned_expense', enabled: reminderEnabled, days: reminderDays, save: () => saveEdit() });
  const reminderAck = useReminderAck('planned_payment', plan?.id, `${focused}:${plan?.updated_at}`);

  useEffect(() => {
    if (!db || !focused || !plan) return;
    let active = true;
    repo.listPlannedPaymentOccurrences(db, plan.id)
      .then((rows) => {
        if (active) {
          setHistory(rows);
          setHistoryError('');
        }
      })
      .catch(() => {
        if (active) setHistoryError('Could not load occurrence history.');
      });
    return () => { active = false; };
  }, [db, focused, plan, repo, plannedPayments]);

  const dirty = !!plan && editing && (
    name.trim() !== plan.name || type !== plan.type ||
    moneyToMinorUnits(amount) !== plan.amount_minor ||
    categoryId !== plan.category_id || accountId !== plan.account_id ||
    nextDate !== dateKeyToInputDate(plan.next_due_date) ||
    recurrence !== plan.recurrence_type ||
    interval !== String(plan.recurrence_interval) ||
    reminderEnabled !== String(plan.reminder_enabled) ||
    reminderDays !== String(plan.reminder_days_before) || note.trim() !== (plan.note ?? '')
  );
  const dirtyForm = useDirtyForm(dirty, actions.isSaving);

  if (!plan) {
    return (
      <FormScreen title="Planned Payment">
        <EmptyState title="Planned payment not found." subtitle="It may no longer be tracked." />
      </FormScreen>
    );
  }

  const category = categories.find((item) => item.id === plan.category_id);
  const account = accounts.find((item) => item.id === plan.account_id);
  const due = getPlannedDueStatus(plan, currentDateKey);
  const typeHasHistory = history.length > 0;
  const editCategories = categories.filter((item) => item.type === type && !item.is_archived);

  function openEdit() {
    reminderWarning.reset();
    setName(plan!.name);
    setType(plan!.type);
    setAmount((plan!.amount_minor / 100).toFixed(2));
    setCategoryId(plan!.category_id);
    setAccountId(plan!.account_id);
    setNextDate(dateKeyToInputDate(plan!.next_due_date));
    setRecurrence(plan!.recurrence_type);
    setInterval(String(plan!.recurrence_interval));
    setReminderEnabled(String(plan!.reminder_enabled));
    setReminderDays(String(plan!.reminder_days_before));
    setNote(plan!.note ?? '');
    setEditing(true);
  }

  const record = () => actions.submit(async () => {
    if (!db || plan.status !== 'ACTIVE') return;
    if (plan.type === 'EXPENSE' && !await confirmOutflow(plan.account_id, plan.amount_minor)) return;
    try { await repo.markPlannedPaymentPaid(db, plan.id, plan.next_due_date); }
    catch (error) {
      if (error instanceof Error && error.message === 'This scheduled occurrence was already handled.') {
        const occurrences = await repo.listPlannedPaymentOccurrences(db, plan.id);
        const recorded = occurrences.some((occurrence) => occurrence.scheduled_date === plan.next_due_date && occurrence.outcome === 'RECORDED');
        dialog.showDialog({ title: recorded ? 'Already recorded' : 'Already handled', message: recorded ? `This ${plan.type === 'INCOME' ? 'income' : 'expense'} has already been recorded for this scheduled date. You can review it in the payment history. No duplicate transaction was created.` : 'This planned payment occurrence has already been skipped. No transaction was created.' });
        return;
      }
      throw error;
    }
    await actions.saved(plan.type === 'EXPENSE' ? 'Expense recorded' : 'Income recorded', () => {});
  });

  const skip = () => actions.submit(async () => {
    if (!db || plan.status !== 'ACTIVE') return;
    if (!await dialog.confirm({
      title: 'Skip this occurrence?',
      message: 'No expense or income will be recorded. The schedule will move to its next occurrence.',
      confirmText: 'Skip',
      cancelText: 'Cancel',
    })) return;
    await repo.skipPlannedPayment(db, plan.id, plan.next_due_date);
    await actions.saved('Occurrence skipped', () => {});
  });

  const saveEdit = () => actions.submit(async () => {
    if (!db) return;
    const amountMinor = moneyToMinorUnits(amount);
    const dateKey = inputDateToDateKey(nextDate);
    const parsedInterval = parseRecurrenceInterval(interval);
    const intervalError = validateRecurrenceInterval(recurrence, parsedInterval);
    if (!name.trim()) return dialog.showDialog({ title: 'Name required', message: 'Enter a planned payment name.' });
    if (!amountMinor || amountMinor <= 0) return dialog.showDialog({ title: 'Invalid amount', message: 'Enter an amount greater than zero.' });
    if (!categoryId) return dialog.showDialog({ title: 'Category required', message: 'Choose an active category.' });
    if (!accountId) return dialog.showDialog({ title: 'Account required', message: 'Choose an active account.' });
    if (!dateKey) return dialog.showDialog({ title: 'Invalid date', message: 'Use DD-MM-YYYY, for example 09-09-2026.' });
    if (intervalError) return dialog.showDialog({ title: 'Invalid repeat interval', message: intervalError });
    if (!await reminderWarning.beforeSave()) return;
    await repo.updatePlannedPayment(db, plan.id, plan.updated_at, {
      name,
      type,
      amount_minor: amountMinor,
      category_id: categoryId,
      account_id: accountId,
      next_due_date: dateKey,
      recurrence_type: recurrence,
      recurrence_interval: recurrenceIntervalForSave(recurrence, parsedInterval),
      end_date: plan.end_date,
      occurrence_limit: plan.occurrence_limit,
      reminder_enabled: Number(reminderEnabled),
      reminder_days_before: Number(reminderDays),
      subscription_metadata: plan.subscription_metadata,
      note,
    });
    await actions.saved('Planned payment updated', () => setEditing(false));
  });

  const pause = () => actions.submit(async () => {
    if (!db) return;
    await repo.pausePlannedPayment(db, plan.id, plan.updated_at);
    await actions.saved('Planned payment paused', () => {});
  });

  const resume = () => actions.submit(async () => {
    if (!db) return;
    await repo.resumePlannedPayment(db, plan.id, plan.updated_at);
    await actions.saved('Planned payment resumed', () => {});
  });

  const stopTracking = () => actions.submit(async () => {
    if (!db) return;
    if (!await dialog.confirm({
      title: 'Stop tracking this plan?',
      message: 'The future plan will be removed. Recorded expenses or income will stay in Transactions.',
      confirmText: 'Stop Tracking',
      cancelText: 'Cancel',
      destructive: true,
    })) return;
    await repo.stopTrackingPlannedPayment(db, plan.id, plan.updated_at);
    await actions.saved('Planned payment tracking stopped', () => dirtyForm.leave(() => navigation.goBack()), true);
  });

  return (
    <FormScreen title={plan.name}>
      <CurrencyProvider currency={accountCurrency.get(plan.account_id) ?? mainCurrency}>
      <Card>
        <Text style={{ color: colors.muted }}>{plan.type === 'EXPENSE' ? 'Expense' : 'Income'}</Text>
        <MoneyText
          amount={plan.type === 'EXPENSE' ? -plan.amount_minor : plan.amount_minor}
          type={plan.type === 'EXPENSE' ? 'negative' : 'positive'}
          style={{ fontSize: 28 }}
        />
        <Text>Status: {due.label}</Text>
        <Text>Category: {category?.name ?? 'Archived category'}</Text>
        <Text>Account: {plan.account_name ?? account?.name ? accountLabel({ name: (plan.account_name ?? account?.name)!, currency: accountCurrency.get(plan.account_id) ?? mainCurrency }) : 'Unavailable account'}</Text>
        <Text>Next due: {displayFullDate(plan.next_due_date)}</Text>
        <Text>Recurrence: {formatRecurrenceLabel(plan.recurrence_type, plan.recurrence_interval)}</Text>
        <Text>Reminder: {plan.reminder_enabled ? reminderOffsetLabel(plan.reminder_days_before) : 'Off'}</Text>
        {plan.note ? <Text>Note: {plan.note}</Text> : <Text style={{ color: colors.muted }}>No note</Text>}
        {reminderAck ? <Text style={{ color: colors.muted }}>{formatReminderAck(reminderAck)}</Text> : null}
      </Card>

      {editing ? (
        <Card>
          <TextField label="Name" placeholder="Internet bill" value={name} onChangeText={setName} />
          {typeHasHistory ? (
            <Text>Type: {plan.type === 'EXPENSE' ? 'Expense' : 'Income'} (kept fixed after history is recorded)</Text>
          ) : (
            <Picker label="Type" value={type} setValue={(value) => {
              const nextType = value as PlannedPaymentType;
              setType(nextType);
              setCategoryId(categories.find((item) => item.type === nextType && !item.is_archived)?.id ?? '');
            }} rows={typeRows} />
          )}
          <TextField label="Amount" placeholder="3500" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
          <Picker label="Category" value={categoryId} setValue={setCategoryId} rows={categoryRows(editCategories)} />
          <Picker label="Account" value={accountId} setValue={setAccountId} rows={accounts.filter((item) => !plan || (item.currency ?? mainCurrency) === (accountCurrency.get(plan.account_id) ?? mainCurrency)).map((item) => [item.id, accountLabel(item)])} />
          <TextField label="Next Date" placeholder="DD-MM-YYYY" value={nextDate} onChangeText={setNextDate} allowFuture allowPast={false} />
          <Picker label="Recurrence" value={recurrence} setValue={(value) => setRecurrence(value as PlannedRecurrenceType)} rows={plannedRecurrenceRows} />
          {recurrence === 'EVERY_N_MONTHS' || recurrence === 'EVERY_N_DAYS' ? <TextField label={recurrence === 'EVERY_N_DAYS' ? 'Repeat every days' : 'Repeat every months'} placeholder="3" value={interval} onChangeText={setInterval} keyboardType="number-pad" money={false} /> : null}
          <Picker label="Reminder" value={reminderEnabled} setValue={value => { setReminderEnabled(value); reminderWarning.select(value, reminderDays); }} rows={reminderRows} />
          {reminderEnabled === '1' ? <Picker label="Remind me" value={reminderDays} setValue={value => { setReminderDays(value); reminderWarning.select(reminderEnabled, value); }} rows={reminderDayRows} /> : null}
          <TextField label="Note" placeholder="Optional" value={note} onChangeText={setNote} />
          <PrimaryButton title="Save Changes" onPress={saveEdit} saving={actions.saving} disabled={reminderWarning.busy || !dirty || !name.trim() || !validMoneyInput(amount) || !inputDateToDateKey(nextDate) || !editCategories.some((item) => item.id === categoryId) || !accounts.some((item) => item.id === accountId) || !!validateRecurrenceInterval(recurrence, parseRecurrenceInterval(interval))} />
          <SecondaryButton title="Cancel" disabled={actions.saving} onPress={() => dirtyForm.discard(() => setEditing(false))} />
        </Card>
      ) : (
        <>
          {plan.status === 'ACTIVE' ? <PrimaryButton title={plannedRecordActionLabel(plan.type)} onPress={record} saving={actions.saving} /> : null}
          {plan.status === 'ACTIVE' ? <SecondaryButton title="Skip" onPress={skip} disabled={actions.saving} /> : null}
          {plan.status !== 'ENDED' ? <SecondaryButton title="Edit" onPress={openEdit} disabled={actions.saving} /> : null}
          {plan.status === 'ACTIVE' ? <SecondaryButton title="Pause" onPress={pause} disabled={actions.saving} /> : null}
          {plan.status === 'PAUSED' ? <SecondaryButton title="Resume" onPress={resume} disabled={actions.saving} /> : null}
          <SecondaryButton title="Stop Tracking" onPress={stopTracking} disabled={actions.saving} />
        </>
      )}

      <SectionHeader title="Occurrence History" />
      {historyError ? <Text accessibilityRole="alert" style={{ color: colors.negative }}>{historyError}</Text> : null}
      {history.length ? history.map((occurrence) => (
        <ListRow
          key={occurrence.id}
          card
          icon={occurrence.outcome === 'SKIPPED' ? 'play-skip-forward-outline' : 'checkmark-circle-outline'}
          iconTone={occurrence.outcome === 'SKIPPED' ? 'neutral' : occurrence.transaction_type === 'EXPENSE' ? 'negative' : 'positive'}
          title={occurrence.outcome === 'SKIPPED' ? 'Skipped' : occurrence.transaction_type === 'EXPENSE' ? 'Expense recorded' : 'Income recorded'}
          subtitle={`${displayFullDate(occurrence.scheduled_date)}${occurrence.transaction_deleted_at ? ' · Financial record removed' : ''}`}
          onPress={occurrence.transaction_id && !occurrence.transaction_deleted_at ? () => navigation.navigate('ActivityDetail', { kind: 'transaction', sourceId: occurrence.transaction_id }) : undefined}
          right={occurrence.outcome === 'RECORDED' && occurrence.transaction_amount_minor != null ? <MoneyText amount={occurrence.transaction_type === 'EXPENSE' ? -occurrence.transaction_amount_minor : occurrence.transaction_amount_minor} type={occurrence.transaction_type === 'EXPENSE' ? 'negative' : 'positive'} /> : undefined}
        />
      )) : <EmptyState title="No occurrences recorded yet." subtitle="Nothing moves in your accounts until you record an expense or income." />}
      </CurrencyProvider>
    </FormScreen>
  );
}

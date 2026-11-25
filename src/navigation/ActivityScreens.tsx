import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { AppHeader, Card, EmptyState, ListRow, MoneyText, PrimaryButton, Screen, SecondaryButton, TextField } from '../components/common';
import { useAppDialog } from '../components/dialogs/AppDialogProvider';
import { useAppData } from '../hooks/useAppData';
import { useSubmitGuard } from '../hooks/useSubmitGuard';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { useConfirmActivityChange } from '../hooks/useConfirmOutflow';
import { activityDateBounds, activityDisplayLabel, activityOrderSetting, type ActivityOrder, activitySubtitle, legacyReadOnlyMessage, listActivity, ordinaryReadOnlyReason, readPaymentAllocations, readSharedEvent, type ActivityRange, type ActivityRow, type ActivityType, type PaymentAllocationDetail, type SharedEventRecords } from '../services/activity/ActivityService';
import { deleteSharedExpense, sharedReadOnlyReason } from '../services/sharedExpense/SharedExpenseService';
import { deleteTransaction } from '../services/finance/TransactionService';
import { deleteRecordedPayment, readRecordedPaymentDeletion, type RecordedPaymentDeletion } from '../services/planned/RecordedPaymentService';
import { exchangeRateText, formatMoney } from '../utils/money';
import { CurrencyProvider, useAccountLabel } from '../components/CurrencyView';
import { useCurrencyInfo } from '../hooks/useCurrencyInfo';
import { currencyRows } from '../utils/currency';
import { deletePersonEntry, personEntryReadOnlyReason } from '../services/people/PersonService';
import { personEntryDelta } from '../services/people/PeopleBalanceService';
import type { PersonEntry, Transaction } from '../types/models';
import { dateKeyToInputDate, displayFullDate, displayListDate, inputDateToDateKey } from '../utils/date';
import { colors, spacing } from '../theme';
import { FormScreen, Picker } from '../components/forms';
import { SharedBillDetail } from '../components/SharedBillDetail';
import { activityIcon, categoryRows } from '../utils/icons';

const typeRows = [['ALL', 'All'], ['EXPENSE', 'Expense'], ['INCOME', 'Income'], ['TRANSFER', 'Move Money'], ['ADJUSTMENT', 'Balance adjustment'], ['PEOPLE', 'People'], ['SHARED', 'Shared']];
const rangeRows = [['ALL', 'All dates'], ['THIS_MONTH', 'This month'], ['LAST_MONTH', 'Last month'], ['LAST_3_MONTHS', 'Last 3 months'], ['LAST_6_MONTHS', 'Last 6 months'], ['THIS_YEAR', 'This year'], ['CUSTOM', 'Custom range']];

/** "16 Nov 2026, 5:05 AM": when the record was created on this device. */
function recordedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}, ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

const ACTIVITY_PAGE = 100;

export function ActivityListScreen({ navigation }: any) {
  const { db, transactions, entries, accounts, categories, people, groups, settings, setSetting, refresh } = useAppData();
  const accountLabel = useAccountLabel();
  const { currencies } = useCurrencyInfo();
  const [query, setQuery] = useState('');
  // Saved choice: the list keeps the user's order across restarts until they tap again.
  const savedOrder = activityOrderSetting(settings?.activity_sort_order);
  const [order, setOrder] = useState<ActivityOrder>(savedOrder);
  useEffect(() => setOrder(savedOrder), [savedOrder]);
  const toggleOrder = () => {
    const next: ActivityOrder = order === 'DATE' ? 'CREATED' : 'DATE';
    setOrder(next);
    if (db) void setSetting(db, 'activity_sort_order', next).then(refresh).catch(() => setOrder(order));
  };
  const [type, setType] = useState<ActivityType>('ALL');
  const [range, setRange] = useState<ActivityRange>('ALL');
  const [from, setFrom] = useState(dateKeyToInputDate());
  const [to, setTo] = useState(dateKeyToInputDate());
  const [advanced, setAdvanced] = useState(false);
  const [account, setAccount] = useState('');
  // The currency filter is offered only once there is more than one currency.
  const [currencyChoice, setCurrencyChoice] = useState('');
  const currency = currencies.length > 1 ? currencyChoice : '';
  const [category, setCategory] = useState('');
  const [person, setPerson] = useState('');
  const [group, setGroup] = useState('');
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const hasSnapshotRef = useRef(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [invalidRange, setInvalidRange] = useState(false);
  const [retry, setRetry] = useState(0);
  const focused = useIsFocused();
  // Inputs of the last successful load. While this tab is not visible, a save
  // elsewhere only marks the list stale; it reloads when the tab is shown, so
  // saving an expense does not also re-read the whole history in the background.
  const loadedFor = useRef<unknown[] | null>(null);
  // Years of history can mean thousands of rows; read a page at a time and grow
  // the page when the list nears its end, so low-end phones never load it all at once.
  const [pageLimit, setPageLimit] = useState(ACTIVITY_PAGE);
  useEffect(() => {
    if (!db) return;
    const inputs = [db, transactions, entries, groups, type, range, from, to, query, account, currency, category, person, group, retry, pageLimit, order];
    if (hasSnapshotRef.current && (!focused || (loadedFor.current?.length === inputs.length && inputs.every((value, index) => Object.is(value, loadedFor.current![index]))))) return;
    let active = true;
    if (!hasSnapshotRef.current) setLoading(true);
    setError('');
    setInvalidRange(false);
    const filters = { type, range, from: from.trim() ? inputDateToDateKey(from) ?? '' : '', to: to.trim() ? inputDateToDateKey(to) ?? '' : '', query, accountId: account, currency: currency || undefined, categoryId: category, personId: person, groupId: group, limit: pageLimit, order };
    async function load() {
      try {
        activityDateBounds(filters);
      } catch (e) {
        if (active) { setInvalidRange(true); setError(e instanceof Error ? e.message : 'Check your date range.'); setLoading(false); setRefreshing(false); }
        return;
      }
      try {
        const result = await listActivity(db!, filters);
        if (active) {
          setRows(result);
          loadedFor.current = inputs;
          hasSnapshotRef.current = true;
          setHasSnapshot(true);
          setError('');
        }
      } catch { if (active) setError('Could not load activity. Please try again.'); }
      finally { if (active) { setLoading(false); setRefreshing(false); } }
    }
    void load();
    return () => { active = false; };
  }, [db, focused, transactions, entries, groups, type, range, from, to, query, account, currency, category, person, group, retry, pageLimit, order]);
  // Stable row renderer: a data refresh elsewhere re-renders this screen's header, not every loaded row.
  const renderRow = useCallback(({ item }: { item: ActivityRow }) => {
    const icon = activityIcon(item);
    return <ListRow card icon={icon.name} iconTone={icon.tone} title={item.title} subtitle={activitySubtitle(item, displayListDate(item.occurred_on))} onPress={() => navigation.navigate('ActivityDetail', { kind: item.kind, sourceId: item.source_id })} right={<MoneyText amount={item.amount_minor} currency={item.currency} type={item.type === 'EXPENSE' ? 'negative' : item.type === 'INCOME' ? 'positive' : 'neutral'} />} />;
  }, [navigation]);
  const filterSummary = [
    type !== 'ALL' && `Type: ${typeRows.find(([id]) => id === type)?.[1] ?? type}`,
    range !== 'ALL' && `Dates: ${range === 'CUSTOM' ? `${from} to ${to}` : rangeRows.find(([id]) => id === range)?.[1] ?? range}`,
    currency && `Currency: ${currency}`,
    account && `Account: ${(() => { const found = accounts.find((a) => a.id === account); return found ? accountLabel(found) : 'Unavailable account'; })()}`,
    category && `Category: ${categories.find((c) => c.id === category)?.name ?? 'Unavailable category'}`,
    person && `Person: ${people.find((p) => p.id === person)?.name ?? 'Unavailable person'}`,
    group && `Group: ${groups.find((g) => g.id === group)?.name ?? 'Unavailable group'}`,
  ].filter(Boolean).join(' | ');
  return <Screen>
    <AppHeader title="Transactions" />
    <FlatList
      data={rows}
      showsVerticalScrollIndicator={false}
      refreshing={refreshing}
      onRefresh={() => { setRefreshing(true); setRetry((value) => value + 1); }}
      contentContainerStyle={{ paddingBottom: spacing.xxl }}
      keyExtractor={(item) => item.id}
      keyboardShouldPersistTaps="handled"
      onEndReachedThreshold={0.5}
      onEndReached={() => { if (rows.length >= pageLimit) setPageLimit((value) => value + ACTIVITY_PAGE); }}
      ListHeaderComponent={<View>
        <TextField placeholder="Search activity" value={query} onChangeText={setQuery} />
        {/* Type and date range live in the Filter panel so the list starts higher on small screens. */}
        {/* Two equal halves, so neither button changes size when its label changes. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <View style={{ flex: 1 }}><SecondaryButton compact title={advanced ? 'Hide filters' : 'Filter'} onPress={() => setAdvanced(!advanced)} /></View>
          <View style={{ flex: 1 }}>
            <SecondaryButton
              compact
              icon="swap-vertical-outline"
              title={order === 'DATE' ? 'By Date' : 'By Entry'}
              accessibilityLabel={order === 'DATE' ? 'Sorted by date. Tap to sort by entry time' : 'Sorted by entry time. Tap to sort by date'}
              onPress={toggleOrder}
            />
          </View>
        </View>
        {advanced ? <>
          <Picker label="Type" value={type} setValue={(value) => setType(value as ActivityType)} rows={typeRows} />
          <Picker label="Date range" value={range} setValue={(value) => setRange(value as ActivityRange)} rows={rangeRows} />
          {range === 'CUSTOM' ? <>
            <TextField label="From" placeholder="DD-MM-YYYY" value={from} onChangeText={setFrom} />
            <TextField label="To" placeholder="DD-MM-YYYY" value={to} onChangeText={setTo} />
            <Text style={{ color: colors.muted }}>{from} to {to}</Text>
          </> : null}
          {currencies.length > 1 ? <Picker label="Currency" value={currency} setValue={setCurrencyChoice} rows={[['', 'All currencies'], ...currencies.map((code) => [code, currencyRows.find(([id]) => id === code)?.[1] ?? code])]} /> : null}
          <Picker label="Account" value={account} setValue={setAccount} rows={ [['', 'All accounts'], ...accounts.map((a) => [a.id, accountLabel(a)])] } />
           <Picker label="Category" value={category} setValue={setCategory} rows={ [['', 'All categories'], ...categoryRows(categories.filter((c) => !c.is_archived || c.id === category))] } />
          <Picker label="Person" value={person} setValue={setPerson} rows={ [['', 'All people'], ...people.map((p) => [p.id, p.name])] } />
          <Picker label="Group" value={group} setValue={setGroup} rows={ [['', 'All groups'], ...groups.map((g) => [g.id, g.name])] } />
          <SecondaryButton title="Clear filters" onPress={() => { setAccount(''); setCurrencyChoice(''); setCategory(''); setPerson(''); setGroup(''); setQuery(''); setType('ALL'); setRange('ALL'); }} />
        </> : null}
        {!advanced && filterSummary ? <Text style={{ color: colors.muted }}>{filterSummary}</Text> : null}
        {error ? <Text accessibilityRole="alert" style={{ color: colors.negative }}>{error}</Text> : null}
        {error && !invalidRange ? <SecondaryButton title="Retry" onPress={() => setRetry((value) => value + 1)} /> : null}
      </View>}
      ListEmptyComponent={<EmptyState title={!hasSnapshot && loading ? 'Loading activity...' : invalidRange ? 'Check your date range.' : !hasSnapshot && error ? 'Activity unavailable.' : query.trim() || type !== 'ALL' || range !== 'ALL' || account || currency || category || person || group ? 'No matching activity.' : 'No activity yet.'} subtitle="Expenses, income, money moved, People and shared bills appear here." />}
      renderItem={renderRow}
    />
  </Screen>;
}

type Detail = { row: ActivityRow; transaction?: Transaction; entry?: PersonEntry; shared?: SharedEventRecords; allocations?: PaymentAllocationDetail[]; subscriptionId?: string; paymentDeletion?: RecordedPaymentDeletion; reason: string | null };

export function ActivityDetailScreen({ navigation, route }: any) {
  const { db, transactions, entries, refresh } = useAppData();
  const accountLabel = useAccountLabel();
  const focused = useIsFocused();
  const { confirm, showDialog } = useAppDialog();
  const form = useSubmitGuard(refresh);
  const dirty = useDirtyForm(false, form.isSaving);
  const confirmChange = useConfirmActivityChange();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const { kind, sourceId } = route.params;
  useEffect(() => {
    if (!db || !focused) return;
    let active = true;
    setDetail(null);
    setError('');
    async function load() {
      try {
        let row = (await listActivity(db!, { activityId: `${kind}:${sourceId}` }))[0];
        // Home's raw transaction row can point to a shared child. Resolve only explicit links.
        if (!row && kind === 'transaction') {
          const tx = await db!.getFirstAsync<Transaction>('SELECT * FROM transactions WHERE id = ? AND deleted_at IS NULL;', sourceId);
          if (tx) {
            const linked = await db!.getAllAsync<{ id: string }>('SELECT id FROM split_groups WHERE deleted_at IS NULL AND (id = ? OR financial_event_id = ?);', tx.group_id ?? null, tx.financial_event_id ?? null);
            if (linked.length === 1) row = (await listActivity(db!, { activityId: `shared:${linked[0].id}` }))[0];
          }
        }
        // A People history row can be one share of a split/group bill: open that bill.
        if (!row && kind === 'person') {
          const linkedEntry = await db!.getFirstAsync<PersonEntry>('SELECT * FROM person_entries WHERE id = ? AND deleted_at IS NULL;', sourceId);
          if (linkedEntry && (linkedEntry.split_group_id || linkedEntry.financial_event_id)) {
            const linked = await db!.getAllAsync<{ id: string }>('SELECT id FROM split_groups WHERE deleted_at IS NULL AND (id = ? OR financial_event_id = ?);', linkedEntry.split_group_id ?? null, linkedEntry.financial_event_id ?? null);
            if (linked.length === 1) row = (await listActivity(db!, { activityId: `shared:${linked[0].id}` }))[0];
          }
        }
        if (!row) throw new Error('Activity is unavailable. Return to Transactions and refresh.');
        let value: Detail;
        if (row.kind === 'shared') {
          const shared = await readSharedEvent(db!, row.source_id);
          value = { row, shared, reason: await sharedReadOnlyReason(db!, shared) };
        } else if (row.kind === 'transaction') {
          const transaction = await db!.getFirstAsync<Transaction>('SELECT * FROM transactions WHERE id = ? AND deleted_at IS NULL;', row.source_id);
          if (!transaction) throw new Error('Activity no longer exists.');
          value = { row, transaction, reason: await ordinaryReadOnlyReason(db!, transaction) };
          if (transaction.source === 'PLANNED' || transaction.source === 'SUBSCRIPTION') {
            try { value.paymentDeletion = await readRecordedPaymentDeletion(db!, transaction.id); }
            catch { /* Unlinked/ambiguous historical payments remain read-only. */ }
          }
          if (transaction.source === 'SUBSCRIPTION' && transaction.type === 'EXPENSE') {
            const payment = await db!.getFirstAsync<{ subscription_id: string }>('SELECT subscription_id FROM subscription_payments WHERE transaction_id = ? AND id = ?;', transaction.id, transaction.financial_event_id ?? null);
            value.subscriptionId = payment?.subscription_id;
          }
        } else {
          const entry = await db!.getFirstAsync<PersonEntry>('SELECT * FROM person_entries WHERE id = ?;', row.source_id);
          const allocations = row.label.endsWith('for shared bills') ? await readPaymentAllocations(db!, row.source_id) : [];
          value = { row, entry: entry ?? undefined, allocations, reason: allocations.length ? 'This payment is applied to the shared bills shown above. It is one People/account movement; applying earlier money never records it again. Reconciled bills and payments are read-only.' : entry ? await personEntryReadOnlyReason(db!, entry) : 'This People record no longer exists.' };
        }
        if (active) setDetail(value);
      } catch (e) { if (active) setError(e instanceof Error ? e.message : 'Could not load activity.'); }
    }
    void load();
    return () => { active = false; };
  }, [db, focused, kind, sourceId, transactions, entries, retry]);
  const remove = () => form.submit(async () => {
    if (!db || !detail || (detail.reason && !detail.paymentDeletion)) return;
    if (detail.entry && detail.row.kind === 'person') {
      const entry = detail.entry;
      const amount = formatMoney(entry.amount_minor, detail.row.currency);
      const outflow = personEntryDelta(entry.type, entry.amount_minor) > 0;
      if (!await confirm({ title: 'Delete People record?', message: `This removes ${amount} ${outflow ? 'given to' : 'received from'} ${detail.row.person_name}. ${outflow ? `${amount} goes back into ${detail.row.account_name}` : `${amount} is taken back out of ${detail.row.account_name}`}, and ${detail.row.person_name}'s balance updates. Spending is not affected.`, destructive: true, cancelText: 'Cancel', confirmText: 'Delete' })) return;
      try {
        await deletePersonEntry(db, entry.id, entry.updated_at);
        await form.saved('People record deleted', () => dirty.leave(() => navigation.goBack()), true);
      } catch (e) { showDialog({ title: 'Could not delete', message: e instanceof Error ? e.message : 'Your records were kept. Please reopen this record.' }); }
      return;
    }
    if (detail.paymentDeletion) {
      const payment = detail.paymentDeletion;
      const amount = formatMoney(payment.transaction.amount_minor, detail.row.currency);
      const effect = payment.transaction.type === 'INCOME' ? `This removes ${amount} of income and deducts it from ${detail.row.account_name}.` : `This restores ${amount} to ${detail.row.account_name} and removes the recorded personal expense.`;
      if (!await confirm({ title: 'Delete Transaction?', message: `${effect} Spending Plan and Insights will update. ${payment.explanation} The tracking template and unrelated occurrences will be kept.`, destructive: true, confirmText: 'Delete Transaction', cancelText: 'Cancel' })) return;
      try {
        if (!await confirmChange([payment.transaction], [], [], [])) return;
        await deleteRecordedPayment(db, payment);
        await form.saved('Transaction deleted', () => dirty.leave(() => navigation.goBack()), true);
      } catch (e) { showDialog({ title: 'Could not delete', message: e instanceof Error ? e.message : 'Your records were kept. Please reopen this transaction.' }); }
      return;
    }
    if (!await confirm({ title: detail.shared ? 'Delete shared expense?' : 'Delete transaction?', message: 'This will remove this activity and update related balances. Unrelated repayments will be kept.', destructive: true, cancelText: 'Cancel', confirmText: 'Delete' })) return;
    try {
      if (detail.shared) await deleteSharedExpense(db, detail.shared.split.id, detail.shared.split.updated_at);
      else if (detail.transaction) {
        if (!await confirmChange([detail.transaction], [], [], [])) return;
        await deleteTransaction(db, detail.transaction.id, detail.transaction.updated_at);
      }
      await form.saved('Activity deleted', () => dirty.leave(() => navigation.goBack()), true);
    } catch (e) { showDialog({ title: 'Could not delete', message: e instanceof Error ? e.message : 'Please reopen this activity.' }); }
  });
  if (!detail) return <FormScreen title="Activity"><EmptyState title={error || 'Loading activity...'} />{error ? <SecondaryButton title="Retry" onPress={() => setRetry(retry + 1)} /> : null}</FormScreen>;
  const { row, shared, reason, transaction } = detail;
  // A record is always shown in the currency of its account.
  return <FormScreen title={row.title}>
    <CurrencyProvider currency={row.currency}>
    <Card>
      <Text style={{ color: colors.muted }}>{shared ? 'Full bill' : activityDisplayLabel(row)}</Text>
      <View style={{ alignItems: 'center' }}>
      {row.source === 'PLANNED' ? <Text>Planned payment occurrence</Text> : null}
      {row.source === 'SUBSCRIPTION' ? <Text>Subscription payment</Text> : null}
      {detail.subscriptionId ? <SecondaryButton title="View Subscription" onPress={() => navigation.navigate('SubscriptionDetail', { subscriptionId: detail.subscriptionId })} /> : null}
       <MoneyText amount={row.amount_minor} style={{ fontSize: 28, textAlign: 'center' }} />
      <Text style={{ textAlign: 'center' }}>{displayFullDate(row.occurred_on)}</Text>
      {row.category_name ? <Text style={{ textAlign: 'center' }}>{row.category_name}</Text> : null}
      {row.person_name && !shared ? <Text style={{ textAlign: 'center' }}>{row.person_name}</Text> : null}
      {!shared ? <Text style={{ textAlign: 'center' }}>Account: {accountLabel({ name: row.account_name, currency: row.currency })}</Text> : null}
      {transaction?.type === 'TRANSFER' ? <><Text style={{ textAlign: 'center' }}>To: {accountLabel({ name: row.destination_name, currency: row.destination_currency || row.currency })}</Text>{transaction.destination_amount_minor != null ? <>
        <Text style={{ textAlign: 'center' }}>Received: {formatMoney(transaction.destination_amount_minor, row.destination_currency)}</Text>
        <Text style={{ textAlign: 'center', color: colors.muted }}>{exchangeRateText(row.currency, row.destination_currency, transaction.amount_minor, transaction.destination_amount_minor)}</Text>
        <Text style={{ textAlign: 'center' }}>Currency exchange between your own accounts. No expense, income, budget or People effect.</Text>
      </> : <Text style={{ textAlign: 'center' }}>No expense, income, budget or People effect.</Text>}</> : null}
      {transaction?.type === 'ADJUSTMENT' ? <Text style={{ textAlign: 'center' }}>This account correction is not income, expense, budget spending or People activity.</Text> : null}
      {shared ? <>
        {row.group_name ? <Text style={{ textAlign: 'center' }}>Group: {row.group_name}</Text> : null}
      </> : null}
      <Text style={{ marginTop: spacing.md, textAlign: 'center', color: colors.text }}>{row.title}</Text>
      {row.note ? <Text style={{ marginTop: spacing.sm, textAlign: 'center' }}>Note: {row.note}</Text> : null}
      {row.created_at ? <Text style={{ marginTop: spacing.sm, textAlign: 'center', color: colors.muted }}>Recorded {recordedAt(row.created_at)}</Text> : null}
      </View>
      {shared && reason !== legacyReadOnlyMessage ? <SharedBillDetail records={shared} accountName={row.account_name ? accountLabel({ name: row.account_name, currency: row.currency }) : row.account_name} /> : shared?.participants.map((p) => <ListRow key={p.id} card icon={p.is_self ? 'person-circle-outline' : 'person-outline'} title={p.is_self ? 'You' : p.name} right={<MoneyText amount={p.share_minor} />} />)}
      {detail.allocations?.length ? <>
        <Text style={{ marginTop: spacing.md }}>Applied to shared bills</Text>
        {detail.allocations.map((allocation) => <ListRow key={allocation.id} card icon="people-outline" title={allocation.expense_title} subtitle={`${allocation.group_name} | ${displayFullDate(allocation.occurred_on)}`} right={<MoneyText amount={allocation.amount_minor} />} onPress={allocation.group_id ? () => navigation.navigate('GroupDetail', { groupId: allocation.group_id }) : undefined} />)}
        <Text>The full payment is shown once above. These are its applied portions, not extra money movements.</Text>
        {detail.entry ? <Text>Global People label: {detail.entry.type === 'GIVEN' || detail.entry.type === 'PAID_BACK' ? 'Given' : detail.entry.type === 'BORROWED_FROM' || detail.entry.type === 'RECEIVED_BACK' ? 'Received' : 'Adjustment'}</Text> : null}
      </> : null}
    </Card>
    {reason ? <Text style={{ color: colors.muted }}>{detail.paymentDeletion ? 'Edit future tracking separately. Delete Transaction removes only this recorded payment and its occurrence history.' : reason}</Text> : <>
      <PrimaryButton title={shared ? 'Edit Shared Expense' : 'Edit'} disabled={form.saving} onPress={() => shared ? navigation.navigate('Split', { shared }) : detail.entry && row.kind === 'person' ? navigation.navigate('PersonEntryForm', { personId: detail.entry.person_id, entry: detail.entry }) : navigation.navigate('TransactionForm', { transaction })} />
      <SecondaryButton title={shared ? 'Delete Shared Expense' : 'Delete'} disabled={form.saving} onPress={remove} />
    </>}
    {detail.paymentDeletion ? <SecondaryButton title="Delete Transaction" disabled={form.saving} onPress={remove} /> : null}
    </CurrencyProvider>
  </FormScreen>;
}

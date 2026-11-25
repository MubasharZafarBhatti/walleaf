import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Card, PrimaryButton, SecondaryButton, SectionHeader, TextField } from '../components/common';
import { FormScreen, Picker } from '../components/forms';
import { PeopleMultiPicker } from '../components/PeopleMultiPicker';
import { SharedBillSummary, type SharedBillResult } from '../components/SharedBillSummary';
import { useAppDialog } from '../components/dialogs/AppDialogProvider';
import { useAppData } from '../hooks/useAppData';
import { useCurrencyInfo } from '../hooks/useCurrencyInfo';
import { useAccountLabel, useMoneyLabel } from '../components/CurrencyView';
import { currencyRows } from '../utils/currency';
import { useSubmitGuard } from '../hooks/useSubmitGuard';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { useConfirmActivityChange, useConfirmOutflow } from '../hooks/useConfirmOutflow';
import { previewSharedExpensePosting, reopenSharedExpenseInput, saveSharedExpensePosting, updateSharedExpense, type SharedExpensePostingInput } from '../services/sharedExpense/SharedExpenseService';
import { calculateSplit, distributeRemainder, type SplitMethod, type SplitParticipantInput } from '../services/split/SplitService';
import { calculateSharedBill, exactSum, personIdentity, type Contribution } from '../services/split/SharedBillCalculation';
import type { SharedEventRecords } from '../services/activity/ActivityService';
import type { PersonEntry, Transaction } from '../types/models';
import { colors, radius, spacing } from '../theme';
import { dateKeyToInputDate, inputDateToDateKey } from '../utils/date';
import { formatMoney, minorUnitsToMoney, moneyToMinorUnits } from '../utils/money';
import { makeId } from '../utils/id';
import type { AppDb } from '../database/database';
import { categoryIcon } from '../utils/icons';
import { defaultAccountId } from '../services/accounts/AccountService';

function participantLabel(participant: Pick<SplitParticipantInput, 'name' | 'isSelf'>) {
  return participant.isSelf ? 'You' : /^(?:me|you)$/i.test(participant.name.trim()) ? `${participant.name} (person)` : participant.name;
}

export function SplitScreen({ navigation, route }: any) {
  const { db, repo, accounts, categories, refresh, groups, groupMembers, people, allPeople, settings } = useAppData();
  const { showDialog, confirm } = useAppDialog();
  const original = route.params?.shared as SharedEventRecords | undefined;
  const [source] = useState(() => original ? reopenSharedExpenseInput(original) : undefined);
  const groupId = (original?.split.group_id ?? route.params?.groupId) as string | undefined;
  const group = groups.find(item => item.id === groupId);
  const members = groupMembers.filter(member => member.group_id === groupId);
  const groupPeople = people.filter(person => members.some(member => !member.is_self && member.person_id === person.id));
  const availablePeople = group ? groupPeople : people;
  const selfIsCurrentMember = !group || members.some(member => member.is_self);
  const expenseCategories = categories.filter(category => category.type === 'EXPENSE' && !category.is_archived);
  const categoryChoices = original?.split.category_id && !expenseCategories.some(category => category.id === original.split.category_id)
    ? [...expenseCategories, ...categories.filter(category => category.id === original.split.category_id)] : expenseCategories;
  const [amount, setAmount] = useState(original ? minorUnitsToMoney(original.split.total_amount_minor) : '');
  const [title, setTitle] = useState(original?.split.title ?? '');
  // Start on today, as the date field would: an untouched new split is not an unsaved change.
  const [date, setDate] = useState(original ? dateKeyToInputDate(original.split.occurred_on) : dateKeyToInputDate());
  const [accountId, setAccountId] = useState(original?.split.account_id ?? defaultAccountId(accounts, settings));
  const { currencies, mainCurrency, accountCurrency } = useCurrencyInfo();
  const accountLabel = useAccountLabel();
  const moneyLabel = useMoneyLabel();
  // A bill is in one currency: the account you paid from, or (when someone else
  // paid) the currency chosen for it. Every share and balance uses that currency.
  const [billCurrency, setBillCurrency] = useState(() => accountCurrency.get(original?.split.account_id ?? accountId ?? '') ?? mainCurrency);
  const [categoryId, setCategoryId] = useState(original?.split.category_id ?? expenseCategories[0]?.id);
  const [payerId, setPayerId] = useState(source?.payers?.[0]?.identity ?? (original && !original.split.payer_is_self ? personIdentity(original.split.payer_person_id!) : 'SELF'));
  const [payerMode, setPayerMode] = useState<'one' | 'multiple'>(() => source?.payers && source.payers.length > 1 ? 'multiple' : 'one');
  const [payerIds, setPayerIds] = useState<string[]>(source?.payers?.map(row => row.identity) ?? [payerId]);
  const [paidValues, setPaidValues] = useState<Record<string, string>>(Object.fromEntries(source?.payers?.map(row => [row.identity, minorUnitsToMoney(row.paidMinor)]) ?? []));
  const [method, setMethod] = useState<SplitMethod>(source?.editor?.method ?? (original ? 'Exact' : 'Equal'));
  const [common, setCommon] = useState(source?.editor?.commonCostMinor ? minorUnitsToMoney(source.editor.commonCostMinor) : '');
  const [participants, setParticipants] = useState<SplitParticipantInput[]>(() => source?.shares.map(share => ({ key: share.isSelf ? 'SELF' : personIdentity(share.personId!), name: share.isSelf ? 'You' : allPeople.find(person => person.id === share.personId)?.name ?? share.name, isSelf: share.isSelf, personId: share.personId ?? undefined })) ?? (selfIsCurrentMember ? [{ key: 'SELF', name: 'You', isSelf: true }] : groupPeople.map(person => ({ key: personIdentity(person.id), name: person.name, personId: person.id, isSelf: false }))));
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(participants.map((participant, index) => [participant.key, source?.editor?.values[index] ?? (original ? minorUnitsToMoney(source!.shares[index].shareMinor) : '')])));
  const [customizing, setCustomizing] = useState(!!source?.customUserSettlement);
  const [customValues, setCustomValues] = useState<Record<string, string>>(Object.fromEntries(source?.customUserSettlement?.map(row => [row.identity, minorUnitsToMoney(row.amountMinor)]) ?? []));
  const [newPersonName, setNewPersonName] = useState('');
  const [stagedIds, setStagedIds] = useState(new Set<string>());
  const form = useSubmitGuard(refresh);
  const confirmOutflow = useConfirmOutflow();
  const confirmChange = useConfirmActivityChange();
  // Someone else paid: the bill is kept with your preferred account in its currency.
  const recordAccountFor = (code: string) => {
    const preferred = defaultAccountId(accounts, settings);
    return (accounts.find(account => account.id === preferred && account.currency === code) ?? accounts.find(account => account.currency === code && !account.is_archived))?.id;
  };
  const payerUsesAccount = () => payerMode === 'one' ? payerId === 'SELF' : payerIds.includes('SELF') && (moneyToMinorUnits(paidValues.SELF ?? '') ?? 0) > 0;
  const paidFromCurrency = accountCurrency.get(accountId ?? '');
  const lockedCurrency = original ? accountCurrency.get(original.split.account_id) : undefined;
  const currency = lockedCurrency ?? (payerUsesAccount() ? paidFromCurrency : undefined) ?? billCurrency;
  const fmt = (value: number) => formatMoney(value, currency);
  const snapshot = JSON.stringify([amount, title, date, accountId, billCurrency, categoryId, payerId, payerMode, payerIds, paidValues, method, common, participants, values, customizing, customValues]);
  const [baseline] = useState(snapshot);
  const dirty = useDirtyForm(snapshot !== baseline || !!newPersonName.trim(), form.isSaving);
  const totalMinor = moneyToMinorUnits(amount);
  const commonMinor = method === 'Exact' && common.trim() ? moneyToMinorUnits(common) : 0;
  const result = calculateSplit({ totalMinor, method, participants, values, commonCostMinor: commonMinor, minimumParticipants: 1 });
  const payerChoices = [{ id: 'SELF', name: 'You (me)' }, ...availablePeople.map(person => ({ id: personIdentity(person.id), name: person.name }))];
  for (const id of source?.payers?.map(row => row.identity) ?? (original?.split.payer_person_id ? [personIdentity(original.split.payer_person_id)] : [])) {
    if (!payerChoices.some(row => row.id === id)) payerChoices.push({ id, name: allPeople.find(person => personIdentity(person.id) === id)?.name ?? original?.split.payer_name ?? 'Historical person' });
  }
  const label = (id: string) => id === 'SELF' ? 'You' : participants.find(row => row.key === id)?.name ?? payerChoices.find(row => row.id === id)?.name ?? allPeople.find(person => personIdentity(person.id) === id)?.name ?? 'Unavailable person';
  const payers: Contribution[] = payerMode === 'one' ? [{ identity: payerId, paidMinor: totalMinor }] : payerIds.map(identity => ({ identity, paidMinor: moneyToMinorUnits(paidValues[identity] ?? '') }));
  let paidTotal = 0;
  try { paidTotal = exactSum(payers.map(row => row.paidMinor)); } catch { paidTotal = NaN; }
  const userPaid = payers.find(row => row.identity === 'SELF')?.paidMinor ?? 0;
  let suggested: SharedBillResult | undefined;
  let calculationError = '';
  try { suggested = calculateSharedBill({ totalMinor, method, participants, values, commonCostMinor: commonMinor, payers }); }
  catch (error) { calculationError = error instanceof Error ? error.message : 'Check the bill amounts.'; }
  if (Number.isSafeInteger(totalMinor) && totalMinor > 0) {
    if (!Number.isSafeInteger(commonMinor) || commonMinor < 0) calculationError = 'Enter a valid combined cost of zero or more.';
    else if (payers.some(payer => !Number.isSafeInteger(payer.paidMinor) || payer.paidMinor < 0)) calculationError = 'Enter a valid payment of zero or more for each selected payer.';
    else if (!payers.length) calculationError = 'Choose who paid this bill.';
  }
  // Opposite canonical positions expose the service's valid counterpart amounts.
  const counterparties = suggested?.positions.filter(row => row.identity !== 'SELF' && row.netMinor && suggested!.userNetMinor && Math.sign(row.netMinor) !== Math.sign(suggested!.userNetMinor)) ?? [];
  const customRows = Object.entries(customValues).map(([identity, value]) => ({ identity, amountMinor: moneyToMinorUnits(value) }));
  let preview = suggested;
  if (customizing && suggested) {
    try { preview = calculateSharedBill({ totalMinor, method, participants, values, commonCostMinor: commonMinor, payers, customUserSettlement: customRows }); }
    catch { preview = undefined; calculationError = `Assign exactly ${fmt(Math.abs(suggested.userNetMinor))} without going above the amount shown for each person. Choose suggested settlement to recalculate.`; }
  }
  let assigned = 0;
  try { assigned = exactSum(customRows.map(row => row.amountMinor)); } catch { assigned = NaN; }
  const activeAccount = accounts.some(account => account.id === accountId && !account.is_archived);
  const canSave = !!db && !!preview && !!categoryId && !!inputDateToDateKey(date) && (userPaid === 0 || activeAccount) && (payerMode === 'one' ? payerChoices.some(row => row.id === payerId) : payerIds.length > 1 && payerIds.every(id => payerChoices.some(row => row.id === id)));
  const warn = (titleText: string, message: string) => showDialog({ title: titleText, message });
  const resetCustom = () => { setCustomizing(false); setCustomValues({}); };
  function chooseMethod(next: SplitMethod) {
    if (form.isSaving() || next === method) return;
    setMethod(next); setCommon(''); resetCustom();
    const amounts = distributeRemainder(Number.isSafeInteger(totalMinor) && totalMinor > 0 ? totalMinor : 0, participants.length);
    const percentages = distributeRemainder(10000, participants.length);
    setValues(Object.fromEntries(participants.map((participant, index) => [participant.key, next === 'Equal' ? '' : next === 'Exact' ? minorUnitsToMoney(amounts[index] ?? 0) : next === 'Percentage' ? minorUnitsToMoney(percentages[index] ?? 0) : '1'])));
  }
  function changePayerMode(next: 'one' | 'multiple') {
    if (form.isSaving()) return;
    setPayerMode(next); resetCustom();
    if (next === 'multiple') { setPayerIds([payerId]); setPaidValues({ [payerId]: Number.isSafeInteger(totalMinor) && totalMinor > 0 ? minorUnitsToMoney(totalMinor) : '' }); }
    else { setPayerId(payerIds[0] ?? 'SELF'); setPayerIds([]); setPaidValues({}); }
  }
  function addPerson() {
    if (form.isSaving()) return;
    const name = newPersonName.trim();
    if (!name) return warn('Person name required', 'Enter a name to add.');
    const existing = allPeople.find(person => person.name.trim().toLowerCase() === name.toLowerCase());
    if (existing?.is_archived) return warn('Person is archived', 'An archived person already uses this name.');
    if (participants.some(row => row.name.toLowerCase() === name.toLowerCase())) return warn('Already selected', `${name} is already a participant.`);
    const id = existing?.id ?? makeId('person');
    if (!existing) setStagedIds(ids => new Set([...ids, id]));
    setParticipants([...participants, { key: personIdentity(id), name: existing?.name ?? name, personId: id, isSelf: false }]); setNewPersonName(''); resetCustom();
  }
  const save = () => form.submit(async () => {
    if (!db || !preview || !canSave) return;
    try {
      const occurredOn = inputDateToDateKey(date)!;
      const modern = payerMode === 'multiple' || commonMinor > 0 || customizing || !!source?.payers;
      const input: SharedExpensePostingInput = { splitGroupId: original?.split.id, title: title.trim() || 'Split expense', totalAmountMinor: totalMinor, categoryId: categoryId!, accountId: userPaid > 0 ? accountId! : original?.split.account_id ?? recordAccountFor(currency) ?? '', occurredOn, groupId: groupId ?? null,
        payerPersonId: payerId === 'SELF' ? null : payerId.slice(7), payerName: label(payerId), payerIsSelf: payerId === 'SELF', shares: preview.shares,
        editor: { method, values: participants.map(row => method === 'Equal' ? '' : values[row.key] ?? ''), commonCostMinor: commonMinor },
        ...(modern ? { payers, customUserSettlement: customizing ? customRows : undefined } : {}) };
      const plan = await previewSharedExpensePosting(db, input);
      const crossingConfirmations: Record<string, number> = {};
      for (const crossing of plan.crossings ?? []) {
        const name = label(personIdentity(crossing.personId));
        if (!await confirm({ title: 'Balance will cross zero', message: `${name}: ${crossing.nextBalanceMinor > 0 ? `${name} will owe you` : `You will owe ${name}`} ${fmt(Math.abs(crossing.nextBalanceMinor))} after this bill. Continue?`, confirmText: 'Continue', cancelText: 'Go Back' })) return;
        crossingConfirmations[crossing.personId] = crossing.balanceBeforeMinor;
      }
      input.crossingConfirmations = crossingConfirmations;
      if (original) {
        if (!await confirmChange(original.transactions, original.entries, plan.personalExpenseTransaction ? [plan.personalExpenseTransaction as Transaction] : [], plan.personEntries as PersonEntry[])) return;
        await updateSharedExpense(db, original.split.id, original.split.updated_at, input);
      } else {
        if (userPaid > 0 && !await confirmOutflow(accountId!, userPaid)) return;
        // Resolve staged Person identities in the same outer transaction as the
        // authoritative shared save. The facade reuses that transaction only.
        await db.withExclusiveTransactionAsync(async txn => {
          const transactionalDb = new Proxy(txn, { get(target, property) { if (property === 'withExclusiveTransactionAsync') return async (work: (db: AppDb) => Promise<void>) => work(txn); const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value; } });
          for (const participant of participants) if (participant.personId && stagedIds.has(participant.personId)) {
            const actualId = await repo.savePerson(transactionalDb, participant.name);
            input.shares = input.shares.map(share => share.personId === participant.personId ? { ...share, personId: actualId } : share);
            if (input.customUserSettlement) input.customUserSettlement = input.customUserSettlement.map(row => row.identity === participant.key ? { ...row, identity: personIdentity(actualId) } : row);
          }
          await saveSharedExpensePosting(transactionalDb, input);
        });
      }
      await form.saved(original ? 'Shared expense updated' : 'Split saved', () => dirty.leave(() => navigation.goBack()), true);
    } catch (error) { warn('Could not save shared expense', error instanceof Error ? error.message : 'Your input has been kept. Please try again.'); }
  });
  const participantChoices = [...(selfIsCurrentMember || source?.shares.some(row => row.isSelf) ? [{ id: 'SELF', name: 'You' }] : []), ...availablePeople.map(person => ({ id: personIdentity(person.id), name: person.name })), ...participants.filter(row => row.personId && stagedIds.has(row.personId)).map(row => ({ id: row.key, name: row.name }))];
  return <FormScreen title={original ? 'Edit Shared Expense' : group ? `${group.name} Expense` : 'Split Expense'}>
    {original && !source?.editor ? <Text style={styles.muted}>Legacy saved shares open as Exact because the original method was not stored.</Text> : null}
    <TextField label={moneyLabel('Total Amount', currency)} placeholder="10000" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
    <TextField label="Description" placeholder="Dinner" value={title} onChangeText={setTitle} />
    <Picker label="Category" value={categoryId} setValue={setCategoryId} rows={categoryChoices.map(category => [category.id, category.is_archived ? `${category.name} (archived)` : category.name, categoryIcon(category)])} />
    <SectionHeader title="Paid by" />
    <View style={styles.methods}>{(['one', 'multiple'] as const).map(mode => <Pressable key={mode} accessibilityRole="radio" accessibilityLabel={mode === 'one' ? 'One person' : 'Multiple people'} accessibilityState={{ selected: payerMode === mode, checked: payerMode === mode, disabled: form.saving }} disabled={form.saving} onPress={() => changePayerMode(mode)} style={[styles.method, payerMode === mode && styles.selected]}><Text style={[styles.methodText, payerMode === mode && styles.selectedText]}>{mode === 'one' ? 'One person' : 'Multiple people'}</Text></Pressable>)}</View>
    {payerMode === 'one' ? <Picker label="Payer" value={payerId} setValue={id => { setPayerId(id); resetCustom(); }} rows={payerChoices.map(row => [row.id, row.name])} /> : <>
      <SectionHeader title="Who paid?" info="Choose who paid the merchant. Paying does not add someone to the participants." />
      <PeopleMultiPicker kind="payers" rows={payerChoices} selected={payerIds} disabled={form.saving} onChange={ids => { setPayerIds(ids); setPaidValues(current => Object.fromEntries(ids.map(id => [id, current[id] ?? '']))); resetCustom(); }} />
      {payerIds.length < 2 ? <Text style={styles.muted}>Choose at least two payers, or use One person.</Text> : null}
      {payerIds.map(id => <TextField key={id} money label={`${label(id)} paid`} value={paidValues[id] ?? ''} placeholder="0.00" keyboardType="decimal-pad" onChangeText={value => setPaidValues(current => ({ ...current, [id]: value }))} />)}
      <Text>Total paid: {fmt(Number.isSafeInteger(paidTotal) ? paidTotal : 0)}</Text>
      <Text>Remaining to assign: {fmt(Number.isSafeInteger(paidTotal) && Number.isSafeInteger(totalMinor) ? totalMinor - paidTotal : 0)}</Text>
      {Number.isSafeInteger(paidTotal) && Number.isSafeInteger(totalMinor) && paidTotal !== totalMinor ? <Text style={styles.error}>{paidTotal < totalMinor ? `${fmt(totalMinor - paidTotal)} still needs to be assigned.` : `Payer contributions exceed the bill by ${fmt(paidTotal - totalMinor)}.`}</Text> : null}
    </>}
    {userPaid > 0 ? <Picker label="Paid from account" value={accountId} setValue={setAccountId} rows={accounts.filter(account => !account.is_archived && (!lockedCurrency || account.currency === lockedCurrency)).map(account => [account.id, accountLabel(account)])} />
      : !original && currencies.length > 1 && !payerUsesAccount() ? <Picker label="Bill currency" info="Someone else paid, so choose the currency of the bill. Shares and balances use it; nothing is converted." value={billCurrency} setValue={setBillCurrency} rows={currencyRows.filter(([code]) => currencies.includes(code))} /> : null}
    <TextField label="Date" placeholder="DD-MM-YYYY" value={date} onChangeText={setDate} />
    <SectionHeader title="Who is included?" /><Text style={styles.muted}>{group ? 'Choose current members who shared this expense.' : 'Choose who consumed or received a share. New people are created only when the split saves.'}</Text>
    <View style={styles.chips}>{participants.map(participant => <View key={participant.key} accessibilityLabel={`Selected participant ${participantLabel(participant)}`} style={styles.chip}><Text style={styles.methodText}>{participantLabel(participant)}{participant.personId && stagedIds.has(participant.personId) ? ' (new)' : ''}</Text></View>)}</View>
    <PeopleMultiPicker kind="participants" rows={participantChoices} selected={participants.map(row => row.key)} disabled={form.saving} onChange={ids => { setParticipants(ids.map(id => participants.find(row => row.key === id) ?? { key: id, name: id === 'SELF' ? 'You' : label(id), isSelf: id === 'SELF', personId: id === 'SELF' ? undefined : id.slice(7) })); resetCustom(); }} />
    {!group && !original ? <><TextField label="New person name" placeholder="Add someone without leaving" value={newPersonName} onChangeText={setNewPersonName} /><SecondaryButton title="Add someone else" disabled={form.saving} onPress={addPerson} /></> : null}
    <View style={styles.methods}>{(['Equal', 'Exact', 'Percentage', 'Shares'] as SplitMethod[]).map(item => <Pressable key={item} accessibilityRole="radio" accessibilityLabel={`${item} split`} accessibilityState={{ selected: method === item, checked: method === item }} disabled={form.saving} onPress={() => chooseMethod(item)} style={[styles.method, method === item && styles.selected]}><Text style={[styles.methodText, method === item && styles.selectedText]}>{item}</Text></Pressable>)}</View>
    {method === 'Exact' ? <SectionHeader title="Individual amounts" /> : null}
    {method !== 'Equal' ? participants.map(participant => <TextField key={`${method}:${participant.key}`} money={method === 'Exact'} label={`${participantLabel(participant)} ${method === 'Exact' ? 'amount' : method === 'Percentage' ? 'percentage' : 'shares'}`} placeholder={method === 'Exact' ? '0.00' : method === 'Percentage' ? '0%' : '1'} keyboardType="decimal-pad" value={values[participant.key] ?? ''} onChangeText={value => setValues(current => ({ ...current, [participant.key]: value }))} />) : null}
    {method === 'Exact' ? <><TextField money label="Combined / common cost" info="Use this for shared delivery, tip, drinks, or another cost everyone shares." value={common} onChangeText={setCommon} placeholder="0.00" keyboardType="decimal-pad" /><Text>Individual subtotal: {fmt(Number.isSafeInteger(result.allocatedMinor) && Number.isSafeInteger(commonMinor) ? result.allocatedMinor - commonMinor : 0)}</Text><Text>Combined cost: {fmt(Number.isSafeInteger(commonMinor) ? commonMinor : 0)}</Text><Text>Total allocated: {fmt(result.allocatedMinor)} / {fmt(Number.isSafeInteger(totalMinor) ? totalMinor : 0)}</Text><Text>Remaining: {fmt(Number.isSafeInteger(result.remainingMinor) ? result.remainingMinor : 0)}</Text></> : <Text style={styles.muted}>{method === 'Percentage' ? `Total: ${Math.round(Number(result.enteredTotal) * 100) / 100}% | Remaining: ${Math.round((100 - Number(result.enteredTotal)) * 100) / 100}%` : method === 'Shares' ? `Total shares: ${result.enteredTotal}` : ''}</Text>}
    {calculationError ? <Text style={styles.error}>{calculationError}</Text> : null}
    {suggested && (counterparties.length > 1 || customizing) ? <>
      <SecondaryButton title="Use suggested settlement" disabled={form.saving || !customizing} onPress={resetCustom} />
      {!customizing ? <SecondaryButton title="Customize my settlement" disabled={form.saving} onPress={() => { setCustomizing(true); setCustomValues(Object.fromEntries(counterparties.map(row => [row.identity, minorUnitsToMoney(suggested!.routes.filter(route => suggested!.userNetMinor < 0 ? route.from === 'SELF' && route.to === row.identity : route.to === 'SELF' && route.from === row.identity).reduce((sum, route) => sum + route.amountMinor, 0))]))); }} /> : <>
        <SectionHeader title="Customize my settlement" /><Text>{suggested.userNetMinor < 0 ? 'You still need to pay' : 'You should receive'} {fmt(Math.abs(suggested.userNetMinor))}.</Text>
        {counterparties.map(row => <View key={row.identity}><TextField money label={suggested!.userNetMinor < 0 ? `Pay ${label(row.identity)}` : `${label(row.identity)} owes you`} value={customValues[row.identity] ?? ''} placeholder="0.00" keyboardType="decimal-pad" onChangeText={value => setCustomValues(current => ({ ...current, [row.identity]: value }))} /><Text style={styles.muted}>Up to {fmt(Math.abs(row.netMinor))}</Text></View>)}
        <Text>Assigned: {fmt(Number.isSafeInteger(assigned) ? assigned : 0)} / {fmt(Math.abs(suggested.userNetMinor))}</Text><Text>Remaining: {fmt(Number.isSafeInteger(assigned) ? Math.abs(suggested.userNetMinor) - assigned : Math.abs(suggested.userNetMinor))}</Text>
      </>}
    </> : null}
    {preview ? <Card><SharedBillSummary result={preview} totalMinor={totalMinor} payers={payers} participants={participants} method={method} values={values} label={label} fmt={fmt} accountName={(() => { const paidFrom = accounts.find(account => account.id === accountId); return paidFrom ? accountLabel(paidFrom) : undefined; })()} /></Card> : null}
    <PrimaryButton title="Confirm & Save" onPress={save} disabled={!canSave || (!!original && snapshot === baseline)} saving={form.saving} />
  </FormScreen>;
}

const styles = StyleSheet.create({
  muted: { color: colors.muted, marginBottom: spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  chip: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.pill, backgroundColor: '#E2EAE4' },
  methods: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginVertical: spacing.md },
  method: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill, backgroundColor: colors.surface },
  selected: { borderColor: colors.primary, backgroundColor: colors.primary },
  methodText: { color: colors.text, fontWeight: '700' },
  selectedText: { color: colors.surface },
  error: { color: colors.negative, marginBottom: spacing.md, fontWeight: '600' },
});

import { useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { Card, EmptyState, ListRow, MoneyText, PrimaryButton, RowIcon, SecondaryButton, SectionHeader, TextField } from '../components/common';
import { FormScreen, Picker } from '../components/forms';
import { MemberPicker } from '../components/MemberPicker';
import { SharedBillDetail } from '../components/SharedBillDetail';
import { useAppDialog } from '../components/dialogs/AppDialogProvider';
import { useAppData } from '../hooks/useAppData';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { useSubmitGuard } from '../hooks/useSubmitGuard';
import { useConfirmOutflow } from '../hooks/useConfirmOutflow';
import { archiveGroup, buildGroupNetSettlement, groupPersonLedger, groupPositionLabel, readGroupSnapshot, reconcileAllocation, restoreGroup, saveGroupDetails, setAllocationUnrelated, settleGroup, type GroupSnapshot } from '../services/groups/GroupService';
import { readPersonSnapshot } from '../services/people/PersonService';
import { buildBalanceCrossingMessage, resolvePeopleAction } from '../services/people/PeopleBalanceService';
import { colors, spacing } from '../theme';
import { dateKeyToInputDate, displayFullDate, inputDateToDateKey } from '../utils/date';
import { formatMoney, minorUnitsToMoney, moneyToMinorUnits } from '../utils/money';
import { makeId } from '../utils/id';
import { defaultAccountId } from '../services/accounts/AccountService';
import { CurrencyProvider, CurrencySwitch, useAccountLabel } from '../components/CurrencyView';

function modernBill(definition?: string | null) {
  try { return !!definition && JSON.parse(definition).version === 2; } catch { return false; }
}

/** A group's bills and balances in one currency (the group's first when none is given). */
function useGroupSnapshot(groupId?: string, currency?: string) {
  const { db, groups, entries } = useAppData();
  const focused = useIsFocused();
  const [snapshot, setSnapshot] = useState<GroupSnapshot | null>(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!db || !groupId || !focused) return;
    let active = true;
    setError('');
    readGroupSnapshot(db, groupId, currency).then((value) => { if (active) setSnapshot(value); }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'Could not load group.'); });
    return () => { active = false; };
  }, [db, groupId, currency, focused, groups, entries, version]);
  return { snapshot: snapshot?.group.id === groupId ? snapshot : null, error, retry: () => setVersion((v) => v + 1) };
}

export function GroupListPanel({ navigation, active: visible = true }: any) {
  const { db, repo, groups, entries } = useAppData();
  const focused = useIsFocused();
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [rows, setRows] = useState<(GroupSnapshot & { perCurrency: GroupSnapshot[] })[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const loaded = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [version, setVersion] = useState(0);
  const archivedCount = rows.filter((row) => row.group.is_archived).length;
  const viewingArchived = archived && archivedCount > 0;
  useEffect(() => { if (!archivedCount) setArchived(false); }, [archivedCount]);
  useEffect(() => {
    if (!db) return;
    if (!focused || !visible) { setRefreshing(false); return; }
    let active = true;
    if (!loaded.current) setLoading(true);
    setError('');
    // Amounts in different currencies never add up: one position per currency.
    repo.listGroups(db, true).then((list) => Promise.all(list.map(async (g) => {
      const first = await readGroupSnapshot(db, g.id);
      const others = await Promise.all(first.currencies.filter((code) => code !== first.currency).map((code) => readGroupSnapshot(db, g.id, code)));
      return { ...first, perCurrency: [first, ...others] };
    }))).then((value) => { if (active) { loaded.current = true; setRows(value); setLoading(false); setRefreshing(false); } }).catch(() => { if (active) { setError('Could not refresh groups. Showing the last update when available.'); setLoading(false); setRefreshing(false); } });
    return () => { active = false; };
  }, [db, repo, groups, entries, focused, visible, version]);
  if (!visible) return null;
  return <View style={{ flex: 1 }}>
    <TextField placeholder="Search groups..." value={query} onChangeText={setQuery} />
    {archivedCount > 0 ? <SecondaryButton title={viewingArchived ? 'Show active groups' : 'Show archived groups'} onPress={() => setArchived(!viewingArchived)} /> : null}
    {error ? <><Text accessibilityRole="alert" style={styles.muted}>{error}</Text><SecondaryButton title="Retry" onPress={() => setVersion((v) => v + 1)} /></> : null}
    <FlatList
      data={rows.filter((row) => !!row.group.is_archived === viewingArchived && row.group.name.toLowerCase().includes(query.trim().toLowerCase()))}
      refreshing={refreshing} onRefresh={() => { setRefreshing(true); setVersion((v) => v + 1); }} keyExtractor={(row) => row.group.id}
      showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 96 }}
      ListEmptyComponent={<EmptyState title={loading ? 'Loading groups...' : error && !rows.length ? 'Groups unavailable.' : query.trim() ? 'No matching groups.' : viewingArchived ? 'No archived groups.' : 'No groups yet.'} />}
      renderItem={({ item }) => <ListRow card icon="people-outline" iconTone={!item.ambiguous && item.balanceMinor > 0 ? 'positive' : !item.ambiguous && item.balanceMinor < 0 ? 'negative' : 'neutral'} title={item.group.name} subtitle={`${item.members.length} member${item.members.length === 1 ? '' : 's'} | ${item.perCurrency.map((part) => `${groupPositionLabel(part)}${!part.ambiguous && part.balanceMinor ? ` ${formatMoney(Math.abs(part.balanceMinor), part.currency)}` : ''}`).join(' · ')}`} onPress={() => navigation.navigate('GroupDetail', { groupId: item.group.id })} />}
    />
  </View>;
}

export function GroupDetailScreen({ route, navigation }: any) {
  const { db, refresh } = useAppData();
  const { confirm, showDialog } = useAppDialog();
  const form = useSubmitGuard(refresh);
  const groupId = route.params.groupId as string;
  const [currency, setCurrency] = useState<string | undefined>(route.params?.currency);
  const { snapshot, error, retry } = useGroupSnapshot(groupId, currency);
  const accountLabel = useAccountLabel();
  const fmt = (amount: number) => formatMoney(amount, snapshot?.currency);
  if (!snapshot) return <FormScreen title="Group"><EmptyState title={error || 'Loading group...'} />{error ? <SecondaryButton title="Retry" onPress={retry} /> : null}</FormScreen>;
  const { group, expenses, members, positions, history } = snapshot;
  const archive = () => form.submit(async () => {
    if (!db || !await confirm({ title: 'Archive group?', message: `${snapshot.ambiguous || snapshot.targets.some((t) => t.remaining_minor) ? 'There are open or unreconciled amounts. ' : ''}History and balances will remain visible under archived groups, but new expenses and settlements will be disabled. Archiving does not settle balances or move any money.`, confirmText: 'Archive', destructive: true })) return;
    try { await archiveGroup(db, groupId, group.updated_at); await form.saved('Group archived', retry); }
    catch (reason) { showDialog({ title: 'Could not archive', message: reason instanceof Error ? reason.message : 'Try again.' }); }
  });
  const restore = () => form.submit(async () => {
    if (!db) return;
    try { await restoreGroup(db, groupId, group.updated_at); await form.saved('Group restored', retry); }
    catch (reason) { showDialog({ title: 'Could not restore group', message: reason instanceof Error ? reason.message : 'Please try again.' }); }
  });
  return <FormScreen title={group.name}>
    <CurrencySwitch options={snapshot.currencies} value={snapshot.currency} onChange={setCurrency} />
    <CurrencyProvider currency={snapshot.currency}>
    <Card><Text style={styles.body}>{group.is_archived ? 'Archived | ' : ''}{groupPositionLabel(snapshot)}</Text><MoneyText amount={snapshot.balanceMinor} />
      <Text style={styles.muted}>{snapshot.ambiguous ? 'This is the unallocated position, not a confirmed amount to pay. Review earlier money first.' : 'Your position from this group only. Global People balances may be different.'}</Text>
      <Text style={styles.muted}>Group expenses: {fmt(expenses.reduce((sum, e) => sum + e.total_amount_minor, 0))}</Text>
    </Card>
    {!group.is_archived ? <><PrimaryButton title="Add Group Expense" onPress={() => navigation.navigate('Split', { groupId })} /><SecondaryButton title="Rename / Manage Members" onPress={() => navigation.navigate('GroupEdit', { groupId })} /><SecondaryButton title="Archive Group" disabled={form.saving} onPress={archive} /></> : <PrimaryButton title="Restore Group" onPress={restore} saving={form.saving} />}
    <SectionHeader title="Balances with you" />
    {positions.map((p) => <Card key={p.personId}>
      <View style={styles.positionHeader}>
        <RowIcon name="person-outline" tone={p.ambiguous ? 'neutral' : p.balanceMinor > 0 ? 'positive' : p.balanceMinor < 0 ? 'negative' : 'neutral'} />
        <Text style={styles.body}>{p.name}</Text>
      </View>
      <Text style={styles.muted}>They owe you {fmt(p.owedMinor)} | You owe {fmt(p.oweMinor)}</Text>
      <Text style={styles.muted}>{p.ambiguous ? 'Reconciliation needed' : p.owedMinor || p.oweMinor ? `Net: ${fmt(p.balanceMinor)}` : 'Settled'}</Text>
      {!group.is_archived && (p.owedMinor > 0 || p.oweMinor > 0) ? <SecondaryButton title={p.ambiguous ? `Review money with ${p.name}` : `Settle with ${p.name}`} onPress={() => navigation.navigate(p.ambiguous ? 'GroupReconcile' : 'GroupSettle', { groupId, personId: p.personId, currency: snapshot.currency })} /> : null}
    </Card>)}
    {snapshot.invalidHistory ? <Text style={styles.muted}>Some older obligations have invalid links. They remain read-only; no amounts have been guessed.</Text> : null}
    {!group.is_archived ? <SecondaryButton title="Review earlier money / reconciliation" onPress={() => navigation.navigate('GroupReconcile', { groupId, currency: snapshot.currency })} /> : null}
    <SectionHeader title="People in this group" />
    {members.map((m) => <ListRow key={m.id} card icon={m.is_self ? 'person-circle-outline' : 'person-outline'} title={m.is_self ? 'You' : m.name} subtitle={m.is_self ? 'You (me)' : 'Current member'} />)}
    <SectionHeader title="Payments applied to this group" />
    {history.length ? history.map((entry) => <ListRow key={entry.id} card icon="person-outline" iconTone={['GIVEN', 'PAID_BACK'].includes(entry.type) ? 'negative' : 'positive'} title={`${['GIVEN', 'PAID_BACK'].includes(entry.type) ? 'Paid to' : 'Received from'} ${entry.person_name}`} subtitle={`${displayFullDate(entry.occurred_on)} | ${entry.title} | Group portion ${fmt(entry.allocated_minor)} of ${fmt(entry.amount_minor)}`} right={<MoneyText amount={entry.allocated_minor} />} onPress={() => navigation.navigate('ActivityDetail', { kind: 'person', sourceId: entry.id })} />) : <Text style={styles.muted}>No payments allocated yet. Earlier cash is never assigned automatically.</Text>}
    {snapshot.offsets.length ? <><SectionHeader title="Confirmed offsets — no money moved" />{snapshot.offsets.map((offset) => <ListRow key={offset.id} card icon="git-compare-outline" title={offset.person_name} subtitle={`${offset.source_title} offset against ${offset.target_title}`} right={<MoneyText amount={offset.amount_minor} />} />)}</> : null}
    <SectionHeader title="Shared expenses" />
    {expenses.map((expense) => <Pressable key={expense.id} accessibilityRole="button" accessibilityLabel={`Open ${expense.title} details`} onPress={() => navigation.navigate('ActivityDetail', { kind: 'shared', sourceId: expense.id })}>
      <Card><Text style={styles.body}>{expense.title}</Text><MoneyText amount={expense.total_amount_minor} /><Text style={styles.muted}>{expense.category_name} | {displayFullDate(expense.occurred_on)}</Text>
        {modernBill(expense.split_definition) ? <SharedBillDetail records={{ split: expense, participants: snapshot.participants.filter(p => p.split_group_id === expense.id), transactions: [], entries: [] }} accountName={expense.account_name ? accountLabel({ name: expense.account_name, currency: snapshot.currency }) : expense.account_name} /> : <><Text style={styles.muted}>Paid by {expense.payer_is_self ? `You from ${accountLabel({ name: expense.account_name ?? '', currency: snapshot.currency })}` : expense.payer_name}</Text>{snapshot.participants.filter((p) => p.split_group_id === expense.id).map((p) => <Text key={p.id} style={styles.muted}>{p.is_self ? 'You' : p.name}: {fmt(p.share_minor)}</Text>)}</>}
      </Card></Pressable>)}
    </CurrencyProvider>
  </FormScreen>;
}

export function GroupEditScreen({ route, navigation }: any) {
  const { db, allPeople, refresh } = useAppData();
  const { showDialog } = useAppDialog();
  const groupId = route.params?.groupId as string | undefined;
  const { snapshot, error, retry } = useGroupSnapshot(groupId);
  const [name, setName] = useState('');
  const [ids, setIds] = useState<string[]>([]);
  const [includeSelf, setIncludeSelf] = useState(true);
  const [newName, setNewName] = useState('');
  const [newNames, setNewNames] = useState<string[]>([]);
  const initialized = useRef(false);
  const expectedUpdatedAt = useRef<string | undefined>(undefined);
  const form = useSubmitGuard(refresh);
  useEffect(() => { if (snapshot && !initialized.current) { initialized.current = true; expectedUpdatedAt.current = snapshot.group.updated_at; setName(snapshot.group.name); setIds(snapshot.members.flatMap((m) => m.person_id ? [m.person_id] : [])); setIncludeSelf(snapshot.members.some((member) => member.is_self)); } }, [snapshot]);
  const originalIds = snapshot?.members.flatMap((m) => m.person_id ? [m.person_id] : []) ?? [];
  const changed = name.trim() !== (snapshot?.group.name ?? '') || newNames.length > 0 || !!newName.trim() || includeSelf !== (snapshot ? snapshot.members.some((member) => member.is_self) : true) || JSON.stringify([...ids].sort()) !== JSON.stringify([...originalIds].sort());
  const dirty = useDirtyForm(changed, form.isSaving);
  const addName = () => {
    const clean = newName.trim();
    if (!clean) return;
    const person = allPeople.find((p) => p.name.toLowerCase() === clean.toLowerCase());
    if (person?.is_archived) { showDialog({ title: 'Person is archived', message: 'Choose an active person.' }); return; }
    if (person) setIds((old) => old.includes(person.id) ? old : [...old, person.id]);
    else if (!newNames.some((n) => n.toLowerCase() === clean.toLowerCase())) setNewNames([...newNames, clean]);
    setNewName('');
  };
  const save = () => form.submit(async () => {
    if (!db) return;
    if (newName.trim()) { showDialog({ title: 'Add this person first', message: 'Tap Add Person to include the name you entered, or clear it.' }); return; }
    try { await saveGroupDetails(db, { id: groupId, expectedUpdatedAt: expectedUpdatedAt.current, name, personIds: ids, includeSelf, newNames }); await form.saved('Group saved', () => dirty.leave(() => navigation.goBack()), true); }
    catch (reason) { showDialog({ title: 'Could not save group', message: reason instanceof Error ? reason.message : 'Your input has been kept.' }); }
  });
  if (groupId && !snapshot) return <FormScreen title="Manage Group"><EmptyState title={error || 'Loading group...'} />{error ? <SecondaryButton title="Retry" onPress={retry} /> : null}</FormScreen>;
  if (snapshot?.group.is_archived) return <FormScreen title="Archived Group"><Text style={styles.muted}>Restore this group before renaming it or managing members.</Text></FormScreen>;
  return <FormScreen title={groupId ? 'Manage Group' : 'New Group'}>
    <TextField label="Group name" value={name} onChangeText={setName} placeholder="Murree Trip" info="Choose current members, including You if relevant. Removing a member changes future selection only; earlier expenses and balances stay." />
    <MemberPicker disabled={form.saving} rows={[{ id: 'SELF', name: 'You (me)' }, ...allPeople.filter((person) => !person.is_archived || ids.includes(person.id)).map((person) => ({ id: `PERSON:${person.id}`, name: `${person.name}${person.is_archived ? ' (archived)' : ''}` }))]} selected={[...(includeSelf ? ['SELF'] : []), ...ids.map((id) => `PERSON:${id}`)]} onChange={(selected) => { setIncludeSelf(selected.includes('SELF')); setIds(selected.filter((id) => id.startsWith('PERSON:')).map((id) => id.slice(7))); }} />
    {newNames.map((n) => <ListRow key={n} card icon="person-add-outline" title={n} subtitle="New person; tap to remove" onPress={() => setNewNames(newNames.filter((name) => name !== n))} />)}
    <TextField label="New person name" placeholder="Add someone without leaving" value={newName} onChangeText={setNewName} />
    <SecondaryButton title="Add Person" onPress={addName} disabled={form.saving || !newName.trim()} />
    <PrimaryButton title="Save Group" onPress={save} saving={form.saving} disabled={!name.trim() || !!newName.trim() || (!!snapshot && !changed)} />
  </FormScreen>;
}

export function GroupReconcileScreen({ route, navigation }: any) {
  const { db, refresh } = useAppData();
  const { showDialog, confirm } = useAppDialog();
  const { snapshot, error, retry } = useGroupSnapshot(route.params.groupId, route.params?.currency);
  const [sourceId, setSourceId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [amount, setAmount] = useState('');
  const request = useRef(makeId('reconcile'));
  const form = useSubmitGuard(refresh);
  const dirty = useDirtyForm(!!(sourceId || targetId || amount), form.isSaving);
  const fmt = (value: number) => formatMoney(value, snapshot?.currency);
  if (!snapshot) return <FormScreen title="Reconcile Earlier Money"><EmptyState title={error || 'Loading...'} />{error ? <SecondaryButton title="Retry" onPress={retry} /> : null}</FormScreen>;
  if (snapshot.group.is_archived) return <FormScreen title="Archived Group"><Text style={styles.muted}>History is read-only. Restore this group before changing reconciliation.</Text></FormScreen>;
  const candidates = snapshot.candidates.filter((c) => !route.params.personId || c.target.person_id === route.params.personId);
  const sources = [...new Map(candidates.map((c) => [c.source.id, c.source])).values()];
  const targets = candidates.filter((c) => c.source.id === sourceId).map((c) => c.target);
  const pair = candidates.find((c) => c.source.id === sourceId && c.target.id === targetId);
  const save = (unrelated: boolean) => form.submit(async () => {
    if (!db || !pair) { showDialog({ title: 'Choose both records', message: 'Select the earlier payment and the specific shared obligation.' }); return; }
    try {
      if (unrelated) {
        if (!await confirm({ title: 'Remaining money not for this obligation?', message: `The still-unallocated money from ${pair.source.title} was unrelated to ${pair.target.expense_title}. Earlier applied portions are kept. This records your choice only; it does not move money or erase either record.`, confirmText: 'Mark unrelated' })) return;
        await setAllocationUnrelated(db, sourceId, targetId, true);
      } else {
        const minor = moneyToMinorUnits(amount);
        if (!Number.isSafeInteger(minor) || minor <= 0 || minor > pair.source.available_minor || minor > pair.target.remaining_minor) throw new Error('Enter a positive amount no larger than the available payment and remaining obligation.');
        if (!await confirm({ title: 'Apply earlier money?', message: `Apply ${fmt(minor)} from ${pair.source.title} to ${pair.target.expense_title}. No new money will be recorded. This allocation is permanent; check both records carefully.`, confirmText: 'Apply' })) return;
        await reconcileAllocation(db, { id: request.current, sourceEntryId: sourceId, targetEntryId: targetId, amountMinor: minor });
      }
      await form.saved('Reconciliation saved; no money moved', () => { setSourceId(''); setTargetId(''); setAmount(''); request.current = makeId('reconcile'); retry(); });
    } catch (reason) { showDialog({ title: 'Could not reconcile', message: reason instanceof Error ? reason.message : 'Check the amount and records.' }); }
  });
  return <FormScreen title="Reconcile Earlier Money">
    <Text style={styles.body}>{candidates.length ? 'Reconciliation needed' : 'No unresolved matching cash for these obligations.'}</Text>
    <Picker label="Earlier cash payment" info="Earlier money may or may not have paid these bills, so choose explicitly. Labels such as Given or Received describe the overall balance, not the purpose of the money." value={sourceId} setValue={(id: string) => { setSourceId(id); setTargetId(''); }} rows={sources.map((s) => [s.id, `${snapshot.positions.find((p) => p.personId === s.person_id)?.name}: ${s.title} | ${displayFullDate(s.occurred_on)} | ${s.account_name} | ${s.cash_direction > 0 ? 'Received' : 'Sent'} ${fmt(s.amount_minor)} | Available ${fmt(s.available_minor)}`])} />
    <Picker label="Shared obligation" value={targetId} setValue={setTargetId} rows={targets.map((t) => [t.id, `${t.expense_title} | ${displayFullDate(t.occurred_on)} | Remaining ${fmt(t.remaining_minor)}`])} />
    <TextField label="Amount to apply" info="A partial amount leaves other possible matches open. Marking money as unrelated applies only to this exact pair and can be reopened below." placeholder="0.00" keyboardType="decimal-pad" value={amount} onChangeText={setAmount} />
    <PrimaryButton title="Apply Existing Money (No Cash Movement)" disabled={!pair || !Number.isSafeInteger(moneyToMinorUnits(amount)) || moneyToMinorUnits(amount) <= 0 || moneyToMinorUnits(amount) > pair.source.available_minor || moneyToMinorUnits(amount) > pair.target.remaining_minor} saving={form.saving} onPress={() => save(false)} />
    <SecondaryButton title="Remaining Money Was Unrelated to This Obligation" disabled={!pair || form.saving} onPress={() => save(true)} />
    {snapshot.exclusions.map((x) => <ListRow key={`${x.source_entry_id}:${x.target_entry_id}`} card icon="close-circle-outline" title={x.source_title} subtitle={`Marked unrelated to ${x.target_title}; tap to review again`} onPress={() => void form.submit(async () => { if (!db || !await confirm({ title: 'Review this pair again?', message: 'The pair will need reconciliation again. No money moves.', confirmText: 'Review again' })) return; await setAllocationUnrelated(db, x.source_entry_id, x.target_entry_id, false); await form.saved('Choice reopened', retry); })} />)}
    <SecondaryButton title="Back" onPress={() => dirty.discard(() => navigation.goBack())} />
  </FormScreen>;
}

export function GroupSettleScreen({ route, navigation }: any) {
  const { db, accounts: allAccounts, refresh, settings } = useAppData();
  const { showDialog, confirm } = useAppDialog();
  const { snapshot, error, retry } = useGroupSnapshot(route.params.groupId, route.params?.currency);
  const accountLabel = useAccountLabel();
  // A payment settles bills only in its own currency, so only those accounts are offered.
  const accounts = snapshot ? allAccounts.filter((a) => a.currency === snapshot.currency) : allAccounts;
  const [direction, setDirection] = useState('1');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [customize, setCustomize] = useState(false);
  const [method, setMethod] = useState('NET');
  const [accountId, setAccountId] = useState(defaultAccountId(allAccounts, settings) ?? '');
  const [date, setDate] = useState(dateKeyToInputDate());
  const initialized = useRef(false);
  const [initialValues, setInitialValues] = useState('');
  const requestId = useRef(makeId('settlement'));
  const form = useSubmitGuard(refresh);
  const dirty = useDirtyForm(!!initialValues && (JSON.stringify([direction, amounts, accountId, date, amount, method]) !== initialValues || !!note.trim()), form.isSaving);
  const confirmOutflow = useConfirmOutflow();
  const fmt = (amount: number) => formatMoney(amount, snapshot?.currency);
  const personId = route.params.personId as string;
  useEffect(() => {
    if (!snapshot || initialized.current) return;
    initialized.current = true;
    const targets = snapshot.targets.filter((t) => t.person_id === personId && t.remaining_minor > 0);
    const net = snapshot.positions.find((position) => position.personId === personId)?.balanceMinor ?? 0;
    const firstDirection = net < 0 ? -1 : 1;
    const defaults = Object.fromEntries(targets.filter((t) => t.direction === firstDirection).map((t) => [t.id, minorUnitsToMoney(t.remaining_minor)]));
    const firstAccount = defaultAccountId(accounts, settings) ?? '';
    setAccountId(firstAccount);
    setInitialValues(JSON.stringify([String(firstDirection), defaults, firstAccount, dateKeyToInputDate(), minorUnitsToMoney(Math.abs(net)), 'NET']));
    setDirection(String(firstDirection));
    setAmounts(defaults);
    setAmount(minorUnitsToMoney(Math.abs(net)));
  }, [snapshot, personId, accounts, settings]);
  const position = snapshot?.positions.find((p) => p.personId === personId);
  const targets = snapshot?.targets.filter((t) => t.person_id === personId && t.direction === Number(direction) && t.remaining_minor > 0) ?? [];
  const selectedAmounts = targets.filter((target) => amounts[target.id]?.trim()).map((target) => ({ amount: moneyToMinorUnits(amounts[target.id]), cap: target.remaining_minor }));
  const validAmounts = selectedAmounts.length > 0 && selectedAmounts.every(({ amount, cap }) => Number.isSafeInteger(amount) && amount > 0 && amount <= cap) && Number.isSafeInteger(selectedAmounts.reduce((sum, row) => sum + row.amount, 0));
  let netPlan: ReturnType<typeof buildGroupNetSettlement> | null = null;
  let netError = '';
  try { if (snapshot) netPlan = buildGroupNetSettlement(snapshot.targets, personId, moneyToMinorUnits(amount)); }
  catch (reason) { netError = reason instanceof Error ? reason.message : 'Check the amount.'; }
  const save = () => form.submit(async () => {
    if (!db || !snapshot || !position) return;
    try {
      const selected = method === 'NET' ? netPlan?.targets ?? [] : targets.filter((t) => amounts[t.id]?.trim()).map((t) => ({ targetEntryId: t.id, amountMinor: moneyToMinorUnits(amounts[t.id]) }));
      const offsets = method === 'NET' ? netPlan?.offsets ?? [] : [];
      if (method === 'NET' ? !netPlan || (!selected.length && !offsets.length) : !validAmounts) throw new Error(netError || 'Enter valid amounts within the remaining balance.');
      const total = selected.reduce((sum, t) => sum + t.amountMinor, 0);
      if (!Number.isSafeInteger(total)) throw new Error('Total is outside the supported range.');
      const occurredOn = inputDateToDateKey(date);
      if (!occurredOn) throw new Error('Choose a valid date.');
      if (total > 0 && !accounts.some((a) => a.id === accountId)) throw new Error('Choose an active account.');
      const person = await readPersonSnapshot(db, personId, snapshot.currency);
      const receiving = method === 'NET' ? position.balanceMinor >= 0 : direction === '1';
      const action = receiving ? 'BORROW' : 'GIVE';
      const resolved = resolvePeopleAction(person.balanceMinor, action, total);
      if (resolved.requiresCrossingConfirmation && !await confirm({ title: 'Balance changes direction', message: buildBalanceCrossingMessage(person.person.name, person.balanceMinor, action, total, snapshot.currency), confirmText: 'Continue' })) return;
      if (!receiving && total > 0 && !await confirmOutflow(accountId, total)) return;
      const explanation = offsets.length ? `This will offset ${fmt(netPlan!.offsetMinor)} you owe against ${fmt(position.owedMinor)} ${position.name} owes you and record ${total ? `a net payment of ${fmt(total)} ${receiving ? 'to you' : `to ${position.name}`}` : 'no cash payment'}.` : `${fmt(total)} ${receiving ? 'received from' : 'paid to'} ${position.name} for ${snapshot.group.name}.`;
      if (!await confirm({ title: offsets.length ? 'Confirm net settlement' : receiving ? 'Confirm money received' : 'Confirm payment sent', message: `${explanation}\n\n${total ? 'Only the actual payment moves money.' : 'This offsets group obligations only; no money moves.'} No Income, Expense or Spending Plan spending is created.`, confirmText: 'Record Settlement' })) return;
      await settleGroup(db, { requestId: requestId.current, groupId: snapshot.group.id, personId, accountId, occurredOn, targets: selected, offsets, nettingConfirmed: offsets.length > 0, note, expectedRevision: snapshot.revision, expectedBalanceMinor: person.balanceMinor, crossingConfirmed: resolved.requiresCrossingConfirmation });
      await form.saved('Settlement recorded', () => dirty.leave(() => navigation.goBack()), true);
    } catch (reason) { showDialog({ title: 'Could not settle', message: reason instanceof Error ? reason.message : 'Your input has been kept.' }); }
  });
  if (!snapshot) return <FormScreen title="Settle Group"><EmptyState title={error || 'Loading...'} />{error ? <SecondaryButton title="Retry" onPress={retry} /> : null}</FormScreen>;
  if (snapshot.group.is_archived) return <FormScreen title="Archived Group"><Text style={styles.muted}>Restore this group before recording a settlement.</Text></FormScreen>;
  const blocked = !position || position.ambiguous || !!snapshot.group.is_archived;
  return <FormScreen title={`Settle with ${position?.name ?? 'Person'}`}>
    <SectionHeader title={`Money between you and ${position?.name ?? 'this person'}`} />
    {groupPersonLedger(snapshot, personId).map((entry) => <Card key={entry.id}>
      <Text style={styles.body}>{entry.title} — {displayFullDate(entry.occurredOn)}</Text>
      <Text style={styles.muted}>{entry.description}</Text>
      <Text style={{ color: entry.deltaMinor > 0 ? colors.positive : entry.deltaMinor < 0 ? colors.negative : colors.text, fontWeight: '700' }}>{entry.offsetMinor ? `Offset ${fmt(entry.offsetMinor)}` : `${entry.deltaMinor >= 0 ? '+ ' : '- '}${fmt(Math.abs(entry.deltaMinor))}`}</Text>
      <Text style={styles.muted}>{entry.direction}{entry.remainingMinor !== null ? ` · Remaining ${fmt(entry.remainingMinor)}` : ''}</Text>
      {entry.note ? <Text style={styles.muted}>{entry.note}</Text> : null}
    </Card>)}
    <SectionHeader title="Current balance" />
    <Card><Text>They owe you: {fmt(position?.owedMinor ?? 0)}</Text><Text>You owe them: {fmt(position?.oweMinor ?? 0)}</Text><Text style={[styles.body, { color: (position?.balanceMinor ?? 0) < 0 ? colors.negative : colors.positive }]}>{position?.balanceMinor ? position.balanceMinor > 0 ? `${position.name} owes you ${fmt(position.balanceMinor)} net` : `You owe ${position.name} ${fmt(-position.balanceMinor)} net` : position?.owedMinor ? 'Net zero; confirm the offset to clear both directions.' : 'You are settled with this person in this group.'}</Text></Card>
    {blocked ? <><Text style={styles.muted}>Reconcile earlier money first. Archived groups cannot record new payments.</Text><SecondaryButton title="Review Earlier Money" onPress={() => navigation.navigate('GroupReconcile', { groupId: snapshot.group.id, personId })} /></> : null}
    {method === 'NET' ? <>
      {netPlan?.offsetMinor ? <Text style={styles.muted}>This will offset {fmt(netPlan.offsetMinor)} you owe against {fmt(position?.owedMinor ?? 0)} they owe you. Only the entered net payment will move money, after confirmation.</Text> : null}
      <TextField label="Amount being settled" keyboardType="decimal-pad" value={amount} onChangeText={setAmount} />
      {netError ? <Text accessibilityRole="alert" style={{ color: colors.negative }}>{netError}</Text> : null}
    </> : null}
    <SecondaryButton title={customize ? 'Hide settlement details' : 'Customize settlement'} onPress={() => setCustomize((value) => !value)} />
    {method === 'BILLS' ? <Text style={styles.muted}>Selected bills: {fmt(selectedAmounts.reduce((sum, row) => sum + (Number.isSafeInteger(row.amount) ? row.amount : 0), 0))}. No offset is recorded in this mode.</Text> : null}
    {customize ? <Card>
      <Picker label="Settlement method" value={method} setValue={setMethod} rows={[['NET', 'Net settlement — explicit offset'], ['BILLS', 'Choose bills in one direction — no offset']]} />
      {method === 'BILLS' ? <>
        <Picker label="Payment direction" info="Edit bill amounts or leave a bill blank. Opposite obligations stay open; no offset is recorded in this mode." value={direction} setValue={(value: string) => { setDirection(value); setAmounts(Object.fromEntries(snapshot.targets.filter((t) => t.person_id === personId && t.direction === Number(value) && t.remaining_minor > 0).map((t) => [t.id, minorUnitsToMoney(t.remaining_minor)]))); }} rows={[["1", 'They pay you'], ['-1', 'You pay them']]} />
        {targets.map((t) => <TextField key={t.id} label={`${t.expense_title} | ${displayFullDate(t.occurred_on)} | Remaining ${fmt(t.remaining_minor)}`} keyboardType="decimal-pad" value={amounts[t.id] ?? ''} onChangeText={(text) => setAmounts({ ...amounts, [t.id]: text })} />)}
      </> : <>{netPlan?.offsets.map((offset) => <Text key={`${offset.sourceEntryId}:${offset.targetEntryId}`}>Offset {fmt(offset.amountMinor)}: {snapshot.targets.find((target) => target.id === offset.sourceEntryId)?.expense_title} against {snapshot.targets.find((target) => target.id === offset.targetEntryId)?.expense_title}</Text>)}{netPlan?.targets.map((target) => <Text key={target.targetEntryId}>Payment {fmt(target.amountMinor)}: {snapshot.targets.find((row) => row.id === target.targetEntryId)?.expense_title}</Text>)}</>}
    </Card> : null}
    {(method === 'NET' ? moneyToMinorUnits(amount) : selectedAmounts.reduce((sum, row) => sum + row.amount, 0)) > 0 ? <Picker label={method === 'NET' && (position?.balanceMinor ?? 0) < 0 || method === 'BILLS' && direction === '-1' ? 'Account sending payment' : 'Account receiving payment'} value={accountId} setValue={setAccountId} rows={accounts.map((a) => [a.id, accountLabel(a)])} /> : null}
    <TextField label="Date" placeholder="DD-MM-YYYY" value={date} onChangeText={setDate} />
    <TextField label="Note" placeholder="Optional" value={note} onChangeText={setNote} />
    <PrimaryButton title="Record Settlement" onPress={save} disabled={blocked || (method === 'NET' ? !netPlan || (!netPlan.targets.length && !netPlan.offsets.length) : !validAmounts) || ((method === 'NET' ? moneyToMinorUnits(amount) : selectedAmounts.reduce((sum, row) => sum + row.amount, 0)) > 0 && !accounts.some((account) => account.id === accountId)) || !inputDateToDateKey(date)} saving={form.saving} />
  </FormScreen>;
}

const styles = StyleSheet.create({
  positionHeader: { flexDirection: 'row', alignItems: 'center', columnGap: spacing.md, marginBottom: spacing.xs },
  body: { color: colors.text, fontWeight: '600', fontSize: 16, marginVertical: spacing.sm },
  muted: { color: colors.muted, marginBottom: spacing.sm },
  choice: { padding: spacing.md, marginBottom: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: 12, backgroundColor: colors.surface },
});

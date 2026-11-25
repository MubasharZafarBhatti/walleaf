import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { Card, EmptyState, ListRow, MoneyText, PrimaryButton, SecondaryButton, TextField } from '../components/common';
import { useAppDialog } from '../components/dialogs/AppDialogProvider';
import { FormScreen, Picker } from '../components/forms';
import { CurrencyProvider } from '../components/CurrencyView';
import { currencyRows } from '../utils/currency';
import { useAppData } from '../hooks/useAppData';
import { useCurrencyInfo } from '../hooks/useCurrencyInfo';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { useSubmitGuard } from '../hooks/useSubmitGuard';
import { AccountArchiveError, accountActivityEffect, accountHasRecords, adjustAccountBalance, archiveAccount, formatAccountType, listArchivedAccounts, readAccountSnapshot, renameAccount, restoreAccount, type AccountSnapshot } from '../services/accounts/AccountService';
import { activitySubtitle } from '../services/activity/ActivityService';
import type { Account } from '../types/models';
import { colors, spacing } from '../theme';
import { displayListDate } from '../utils/date';
import { formatMoney, signedMoneyToMinorUnits } from '../utils/money';
import { changedName } from '../utils/formValidation';
import { LabelWithInfo } from '../components/InfoTip';
import { accountIcon, activityIcon } from '../utils/icons';

function useAccountSnapshot(accountId: string) {
  const { db, transactions, entries } = useAppData();
  const focused = useIsFocused();
  const [snapshot, setSnapshot] = useState<AccountSnapshot | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!db || !focused) return;
    let active = true;
    setError('');
    readAccountSnapshot(db, accountId)
      .then((value) => { if (active) setSnapshot(value); })
      .catch((reason) => { if (active) { setSnapshot(null); setError(reason instanceof Error ? reason.message : 'Could not load account.'); } });
    return () => { active = false; };
  }, [accountId, db, entries, focused, retry, transactions]);
  return { snapshot, error, retry: () => setRetry((value) => value + 1) };
}

export function ArchivedAccountsPanel({ navigation }: any) {
  const { db, accounts, transactions, entries } = useAppData();
  const focused = useIsFocused();
  const [rows, setRows] = useState<Account[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!db || !focused) return;
    let active = true;
    listArchivedAccounts(db).then((value) => { if (active) { setRows(value); setError(false); if (!value.length) setOpen(false); } }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [db, focused, accounts, transactions, entries, retry]);
  return <>
    {error ? <SecondaryButton title="Retry archived accounts" onPress={() => setRetry((value) => value + 1)} /> : null}
    {rows.length > 0 ? <SecondaryButton title={open ? 'Hide archived accounts' : 'Show archived accounts'} onPress={() => setOpen((value) => !value)} /> : null}
    {open ? rows.map((account) => <ListRow key={account.id} card icon={accountIcon(account.type)} title={account.name} subtitle={`${formatAccountType(account.type)} · Archived`} onPress={() => navigation.navigate('AccountDetail', { accountId: account.id })} />) : null}
  </>;
}

export function AccountDetailScreen({ navigation, route }: any) {
  const { db, accounts, refresh } = useAppData();
  const { mainCurrency, currencies } = useCurrencyInfo();
  const { confirm, showDialog } = useAppDialog();
  const form = useSubmitGuard(refresh);
  const accountId = route.params.accountId as string;
  const { snapshot, error, retry } = useAccountSnapshot(accountId);
  // Everything on this screen is in the account's own currency.
  const fmt = (amount: number) => formatMoney(amount, snapshot?.account.currency ?? mainCurrency);
  const restore = () => form.submit(async () => {
    if (!db || !snapshot) return;
    try { await restoreAccount(db, accountId, snapshot.account.updated_at); await form.saved('Account restored', retry); }
    catch (reason) { showDialog({ title: reason instanceof Error && reason.message === 'ACCOUNT_NAME_EXISTS' ? 'Duplicate account' : 'Could not restore account', message: reason instanceof Error && reason.message === 'ACCOUNT_NAME_EXISTS' ? 'An active account already uses this name. Rename that account before restoring this history.' : reason instanceof Error ? reason.message : 'Please try again.' }); }
  });
  const archive = () => {
    if (!db || !snapshot || snapshot.account.is_archived) return;
    if (snapshot.currentBalanceMinor !== 0) {
      showDialog({
        title: 'Account still has money',
        message: `This account still has ${fmt(snapshot.currentBalanceMinor)}. Move the money or adjust the balance before archiving.`,
      });
      return;
    }
    void form.submit(async () => {
      if (!await confirm({
        title: 'Archive account?',
        message: 'The account will be hidden from new entries. Historical records will be kept.',
        destructive: true,
        cancelText: 'Cancel',
        confirmText: 'Archive',
      })) return;
      try {
        await archiveAccount(db, accountId, snapshot.account.updated_at);
        await form.saved('Account archived', retry);
      } catch (reason) {
        const balance = reason instanceof AccountArchiveError ? reason.balanceMinor : undefined;
        showDialog({
          title: 'Could not archive',
          message: balance == null
            ? reason instanceof Error ? reason.message : 'Please reopen this account.'
            : `This account still has ${fmt(balance)}. Move the money or adjust the balance before archiving.`,
        });
      }
    });
  };
  if (!snapshot) return <FormScreen title="Account"><EmptyState title={error || 'Loading account...'} />{error ? <SecondaryButton title="Retry" onPress={retry} /> : null}</FormScreen>;
  const { account, currentBalanceMinor, activity } = snapshot;
  return <FormScreen title={account.name}>
    <CurrencyProvider currency={account.currency}>
    <Card>
      <Text style={{ color: colors.muted }}>{formatAccountType(account.type)}{currencies.length > 1 ? ` | ${account.currency}` : ''}{account.is_archived ? ' | Archived' : ''}</Text>
      <Text style={{ marginTop: spacing.sm, color: colors.muted }}>Current balance</Text>
      <MoneyText amount={currentBalanceMinor} type="neutral" style={{ fontSize: 28 }} />
      <View style={{ marginTop: spacing.md }}><LabelWithInfo label="Opening balance" info="Money already in this account when you added it. It was not recorded as income." textStyle={{ color: colors.muted }} /></View>
      <MoneyText amount={account.opening_balance_minor} type="neutral" />
    </Card>
    {!account.is_archived ? <>
      <PrimaryButton title="Edit Account" disabled={form.saving} onPress={() => navigation.navigate('AccountEdit', { accountId })} />
      <SecondaryButton title="Adjust Balance" disabled={form.saving} onPress={() => navigation.navigate('AccountAdjust', { accountId })} />
      <SecondaryButton title="Move Money" disabled={form.saving || accounts.length < 2} onPress={() => navigation.navigate('TransactionForm', { type: 'TRANSFER', accountId })} />
      {accounts.length < 2 ? <Text style={{ color: colors.muted }}>Add another account before moving money.</Text> : null}
      <SecondaryButton title="Archive Account" disabled={form.saving} onPress={archive} />
    </> : <Card><Text style={{ color: colors.muted }}>This archived account remains available for historical records.</Text><PrimaryButton title="Restore Account" onPress={restore} saving={form.saving} /></Card>}
    <Text style={{ marginTop: spacing.lg, marginBottom: spacing.sm, color: colors.text, fontWeight: '700' }}>Recent activity</Text>
    {activity.length ? activity.map((item) => {
      const effect = accountActivityEffect(item, accountId);
      return <ListRow
        key={item.id}
        card
        icon={activityIcon(item).name}
        iconTone={activityIcon(item).tone}
        title={item.title}
        subtitle={activitySubtitle(item, displayListDate(item.occurred_on))}
        right={<MoneyText amount={effect} type={effect < 0 ? 'negative' : effect > 0 ? 'positive' : 'neutral'} />}
        onPress={() => navigation.navigate('ActivityDetail', { kind: item.kind, sourceId: item.source_id })}
      />;
    }) : <EmptyState title="No account activity yet." subtitle="Expenses, income, money moved, People payments, shared bills and balance adjustments appear here." />}
    </CurrencyProvider>
  </FormScreen>;
}

export function AccountEditScreen({ navigation, route }: any) {
  const { db, refresh } = useAppData();
  const { currencies, mainCurrency } = useCurrencyInfo();
  const { showDialog } = useAppDialog();
  const form = useSubmitGuard(refresh);
  const accountId = route.params.accountId as string;
  const { snapshot, error, retry } = useAccountSnapshot(accountId);
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('');
  const [locked, setLocked] = useState(true);
  const initializedAccount = useRef('');
  useEffect(() => {
    if (snapshot && initializedAccount.current !== snapshot.account.id) {
      initializedAccount.current = snapshot.account.id;
      setName(snapshot.account.name);
      setCurrency(snapshot.account.currency);
    }
  }, [snapshot]);
  useEffect(() => {
    if (!db) return;
    let active = true;
    void accountHasRecords(db, accountId).then((value) => { if (active) setLocked(value); }).catch(() => {});
    return () => { active = false; };
  }, [db, accountId, snapshot]);
  const currencyChanged = !!snapshot && !!currency && currency !== snapshot.account.currency;
  const dirty = useDirtyForm(!!snapshot && (name.trim() !== snapshot.account.name || currencyChanged), form.isSaving);
  const save = () => form.submit(async () => {
    if (!db || !snapshot) return;
    try {
      await renameAccount(db, accountId, snapshot.account.updated_at, name, currency || snapshot.account.currency);
      await form.saved('Account updated', () => dirty.leave(() => navigation.goBack()), true);
    } catch (reason) {
      showDialog({
        title: reason instanceof Error && reason.message === 'ACCOUNT_NAME_EXISTS' ? 'Duplicate account' : 'Could not update account',
        message: reason instanceof Error && reason.message === 'ACCOUNT_NAME_EXISTS' ? 'An active account with this name already exists in this currency.' : reason instanceof Error ? reason.message : 'Your input has been kept. Please try again.',
      });
    }
  });
  if (!snapshot) return <FormScreen title="Edit Account"><EmptyState title={error || 'Loading account...'} />{error ? <SecondaryButton title="Retry" onPress={retry} /> : null}</FormScreen>;
  return <FormScreen title="Edit Account">
    <TextField label="Account name" placeholder="Meezan Bank" value={name} onChangeText={setName} />
    <Card>
      <LabelWithInfo label="Account type" info="The type can't be changed, so existing history stays clear." textStyle={{ color: colors.muted }} />
      <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600' }}>{formatAccountType(snapshot.account.type)}</Text>
    </Card>
    {currencies.length < 2 && snapshot.account.currency === mainCurrency ? null : locked ? <Card>
      <LabelWithInfo label="Currency" info="This account already has records, so its currency stays the same and its history keeps its meaning. For money in another currency, add a new account." textStyle={{ color: colors.muted }} />
      <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600' }}>{currencyRows.find(([code]) => code === snapshot.account.currency)?.[1] ?? snapshot.account.currency}</Text>
    </Card> : <Picker label="Currency" info="Can be changed while the account has no records." value={currency || snapshot.account.currency} setValue={setCurrency} rows={currencyRows} />}
    <PrimaryButton title="Save" onPress={save} saving={form.saving} disabled={!changedName(name, snapshot.account.name) && !currencyChanged} />
  </FormScreen>;
}

export function AccountAdjustScreen({ navigation, route }: any) {
  const { db, refresh } = useAppData();
  const { mainCurrency } = useCurrencyInfo();
  const { confirm, showDialog } = useAppDialog();
  const form = useSubmitGuard(refresh);
  const accountId = route.params.accountId as string;
  const { snapshot, error, retry } = useAccountSnapshot(accountId);
  const [actual, setActual] = useState('');
  const [reason, setReason] = useState('');
  const dirty = useDirtyForm(!!(actual.trim() || reason.trim()), form.isSaving);
  const actualMinor = signedMoneyToMinorUnits(actual);
  const adjustmentMinor = snapshot && Number.isSafeInteger(actualMinor) ? actualMinor - snapshot.currentBalanceMinor : NaN;
  const fmt = (amount: number) => formatMoney(amount, snapshot?.account.currency ?? mainCurrency);
  const save = () => form.submit(async () => {
    if (!db || !snapshot) return;
    if (!Number.isSafeInteger(actualMinor)) {
      showDialog({ title: 'Invalid balance', message: 'Enter the actual balance, using up to two decimal places.' });
      return;
    }
    if (adjustmentMinor === 0) {
      showDialog({ title: 'No adjustment needed', message: 'The actual balance already matches this account.' });
      return;
    }
    if (!await confirm({
      title: `Adjust ${snapshot.account.name}?`,
      message: `Current app balance: ${fmt(snapshot.currentBalanceMinor)}\nActual balance: ${fmt(actualMinor)}\nAdjustment: ${fmt(adjustmentMinor)}${actualMinor < 0 ? '\n\nThis account will have a negative balance.' : ''}\n\nThis is not income, expense, Spending Plan activity or People activity.`,
      cancelText: 'Edit',
      confirmText: 'Confirm',
    })) return;
    try {
      await adjustAccountBalance(db, accountId, actualMinor, reason);
      await form.saved('Balance adjusted', () => dirty.leave(() => navigation.goBack()), true);
    } catch (problem) {
      showDialog({ title: 'Could not adjust balance', message: problem instanceof Error ? problem.message : 'Your input has been kept. Please try again.' });
    }
  });
  if (!snapshot) return <FormScreen title="Adjust Balance"><EmptyState title={error || 'Loading account...'} />{error ? <SecondaryButton title="Retry" onPress={retry} /> : null}</FormScreen>;
  return <FormScreen title="Adjust Balance">
    <CurrencyProvider currency={snapshot.account.currency}>
    <Card>
      <Text style={{ color: colors.muted }}>Current app balance</Text>
      <MoneyText amount={snapshot.currentBalanceMinor} type="neutral" style={{ fontSize: 24 }} />
    </Card>
    <TextField label="Actual account balance" placeholder="e.g. 25,000 or -500" value={actual} onChangeText={setActual} keyboardType="numbers-and-punctuation" />
    {Number.isSafeInteger(adjustmentMinor) ? <Card>
      <LabelWithInfo label="Adjustment" info="This correction does not count as income, expense, Spending Plan spending or People activity." textStyle={{ color: colors.muted }} />
      <MoneyText amount={adjustmentMinor} type={adjustmentMinor < 0 ? 'negative' : 'positive'} />
    </Card> : null}
    <TextField label="Reason optional" placeholder="Bank reconciliation or cash count correction" value={reason} onChangeText={setReason} />
    <PrimaryButton title="Confirm Adjustment" onPress={save} saving={form.saving} disabled={!Number.isSafeInteger(adjustmentMinor) || adjustmentMinor === 0} />
    </CurrencyProvider>
  </FormScreen>;
}

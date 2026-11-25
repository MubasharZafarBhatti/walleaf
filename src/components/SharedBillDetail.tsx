import { Text } from 'react-native';
import { SharedBillSummary } from './SharedBillSummary';
import { reopenSharedExpenseInput } from '../services/sharedExpense/SharedExpenseService';
import { calculateSharedBill, personIdentity } from '../services/split/SharedBillCalculation';
import type { SharedEventRecords } from '../services/activity/ActivityService';
import { useAppData } from '../hooks/useAppData';
import { useCurrencyInfo } from '../hooks/useCurrencyInfo';
import { formatMoney, minorUnitsToMoney } from '../utils/money';
import { ListRow, MoneyText } from './common';
import type { Person } from '../types/models';

export function SharedBillDetail({ records, accountName }: { records: SharedEventRecords; accountName?: string | null }) {
  const { allPeople: currentPeople } = useAppData();
  const { accountCurrency, mainCurrency } = useCurrencyInfo();
  // A bill is in the currency of the account it was recorded with.
  const currency = accountCurrency.get(records.split.account_id) ?? mainCurrency;
  const allPeople = currentPeople ?? [];
  const model = detailModel(records, allPeople);
  if (!model) return <><Text>Unverified older record. Saved shares are shown without guessing who paid or who should settle.</Text>{records.participants.map(participant => <ListRow key={participant.id} title={participant.is_self ? 'You' : participant.name} right={<MoneyText amount={participant.share_minor} />} />)}</>;
  return <SharedBillSummary historical {...model} fmt={amount => formatMoney(amount, currency)} accountName={accountName ?? undefined} />;
}

function detailModel(records: SharedEventRecords, allPeople: Person[]) {
  try {
    const input = reopenSharedExpenseInput(records);
    const participants = input.shares.map(share => ({ key: share.isSelf ? 'SELF' : personIdentity(share.personId!), name: share.isSelf ? 'You' : allPeople.find(person => person.id === share.personId)?.name ?? share.name, personId: share.personId ?? undefined, isSelf: share.isSelf }));
    const method = input.editor?.method ?? 'Exact';
    const values = Object.fromEntries(participants.map((participant, index) => [participant.key, input.editor?.values[index] ?? minorUnitsToMoney(input.shares[index].shareMinor)]));
    const payers = input.payers ?? [{ identity: input.payerIsSelf ? 'SELF' : personIdentity(input.payerPersonId!), paidMinor: input.totalAmountMinor }];
    const result = calculateSharedBill({ totalMinor: input.totalAmountMinor, method, participants, values, commonCostMinor: input.editor?.commonCostMinor, payers, customUserSettlement: input.customUserSettlement });
    const label = (id: string) => id === 'SELF' ? 'You' : allPeople.find(person => personIdentity(person.id) === id)?.name ?? participants.find(participant => participant.key === id)?.name ?? input.payerName ?? 'Historical person';
    return { result, totalMinor: input.totalAmountMinor, payers, participants, method, values, label };
  } catch {
    return null;
  }
}

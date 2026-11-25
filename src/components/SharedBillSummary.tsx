import { Text, View, StyleSheet } from 'react-native';
import { calculateSharedBill, type Contribution } from '../services/split/SharedBillCalculation';
import { type SplitMethod, type SplitParticipantInput } from '../services/split/SplitService';
import { moneyToMinorUnits } from '../utils/money';
import { colors, spacing } from '../theme';
import { ListRow, MoneyText } from './common';
import { LabelWithInfo } from './InfoTip';

export type SharedBillResult = ReturnType<typeof calculateSharedBill>;
export function billPositionText(net: number, fmt: (amount: number) => string) {
  return net < 0 ? `You will owe ${fmt(-net)}.` : net > 0 ? `You should receive ${fmt(net)}.` : 'You are settled for this bill.';
}

/** Presentation only: all shares, common amounts, positions and routes are canonical output. */
export function SharedBillSummary({ result, totalMinor, payers, participants, method, values, label, fmt, accountName, historical = false }: {
  result: SharedBillResult; totalMinor: number; payers: Contribution[]; participants: SplitParticipantInput[];
  method: SplitMethod; values: Record<string, string>; label: (id: string) => string; fmt: (amount: number) => string;
  accountName?: string; historical?: boolean;
}) {
  return <View style={styles.sections}>
    {!historical ? <><Text style={styles.heading}>Full bill</Text><Text>{fmt(totalMinor)}</Text></> : null}
    <Text style={styles.heading}>{historical ? 'Your part' : 'Your effect'}</Text>
    <Text>{historical ? 'You paid' : 'You pay now'}: {fmt(result.userPaidMinor)}{result.userPaidMinor > 0 ? ` from ${accountName ?? 'choose an account'}` : ''}</Text>
    <Text>{historical ? 'Your final share' : 'Your personal expense'}: {fmt(result.userShareMinor)}</Text>
    <Text>Your position after this bill</Text><Text>{billPositionText(result.userNetMinor, fmt)}</Text>
    <Text style={styles.heading}>Who paid</Text>
    {payers.map(payer => <Text key={payer.identity}>{label(payer.identity)} — {fmt(payer.paidMinor)}</Text>)}
    <Text style={styles.heading}>Final shares</Text>
    {result.shares.map((share, index) => <View key={participants[index].key}>
      {historical ? <ListRow title={share.isSelf ? 'You' : share.name} right={<MoneyText amount={share.shareMinor} />} /> : <Text>{share.isSelf ? 'You' : share.name} — {fmt(share.shareMinor)}</Text>}
      {method === 'Exact' && result.commonAllocations.some(amount => amount > 0) ? <Text style={styles.muted}>Individual {fmt(moneyToMinorUnits(values[participants[index].key]))} | Common {fmt(result.commonAllocations[index])} | Total {fmt(share.shareMinor)}</Text> : null}
    </View>)}
    <LabelWithInfo label={historical ? 'Settlement plan' : 'Suggested settlement'} info={historical ? 'Who should pay whom on the original bill. Later payments and confirmed offsets are shown in Group settlements. This plan does not record a payment.' : 'Who should pay whom. This plan does not record a payment.'} textStyle={styles.heading} />
    {result.routes.length ? result.routes.map((route, index) => <Text key={`${route.from}:${route.to}:${index}`}>{label(route.from)} {route.from === 'SELF' ? 'pay' : 'pays'} {label(route.to)} — {fmt(route.amountMinor)}</Text>) : <Text>No payment is needed for this bill.</Text>}
  </View>;
}

const styles = StyleSheet.create({
  sections: { gap: spacing.sm },
  heading: { color: colors.text, fontWeight: '700', fontSize: 16, marginTop: spacing.md },
  muted: { color: colors.muted },
});

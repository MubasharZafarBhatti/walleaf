import { useEffect, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { EmptyState, ListRow, MoneyText, Screen, SecondaryButton } from '../components/common';
import { BackHeader } from '../components/forms';
import { useAppData } from '../hooks/useAppData';
import { listPersonalSpendingActivity, type ActivityRow } from '../services/activity/ActivityService';
import { colors, spacing } from '../theme';
import { displayFullDate } from '../utils/date';
import { activityIcon } from '../utils/icons';

export type InsightsCategoryDetailParams = {
  categoryId: string;
  categoryName: string;
  /** Only spending in this currency. */
  currency?: string;
  from: string;
  to: string;
};

export function InsightsCategoryDetailScreen({ navigation, route }: any) {
  const { db, transactions } = useAppData();
  const focused = useIsFocused();
  const { categoryId, categoryName, from, to, currency } = route.params as InsightsCategoryDetailParams;
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!db || !focused) return;
    let active = true;
    setLoading(true);
    setError('');
    void listPersonalSpendingActivity(db, { categoryId, from, to, currency })
      .then((result) => {
        if (active) setRows(result);
      })
      .catch(() => {
        if (active) setError('Could not load this spending activity. Please try again.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [db, focused, transactions, categoryId, from, to, currency, retry]);

  return <Screen>
    <BackHeader title={categoryName} />
    <FlatList
      data={rows}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingRight: spacing.md, paddingBottom: spacing.xxl }}
      keyExtractor={(item) => item.id}
      ListHeaderComponent={<View>
        <Text style={{ color: colors.muted }}>Personal spending</Text>
        <Text style={{ color: colors.muted, marginBottom: spacing.md }}>{displayFullDate(from)} to {displayFullDate(to)} | Amounts show your personal share.</Text>
        {error ? <View accessibilityRole="alert"><Text style={{ color: colors.negative }}>{error}</Text><SecondaryButton title="Retry" onPress={() => setRetry((value) => value + 1)} /></View> : null}
      </View>}
      ListEmptyComponent={<EmptyState title={loading ? 'Loading spending activity...' : error ? 'Spending activity unavailable.' : 'No spending activity in this range.'} />}
      renderItem={({ item }) => <ListRow
        card
        icon={activityIcon(item).name}
        iconTone="negative"
        title={item.title}
        subtitle={`${item.label} | ${displayFullDate(item.occurred_on)}`}
        onPress={() => navigation.navigate('ActivityDetail', { kind: item.kind, sourceId: item.source_id })}
        right={<MoneyText amount={-item.amount_minor} currency={item.currency} type="negative" />}
      />}
    />
  </Screen>;
}

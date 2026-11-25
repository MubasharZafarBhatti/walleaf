import { useState } from 'react';
import { Text, View } from 'react-native';
import { BackHeader, Picker } from '../components/forms';
import { Card, EmptyState, ListRow, MoneyText, Screen, SectionHeader, TextField } from '../components/common';
import { BarChart, chartOtherColor, chartPalette, compactAmount, DonutChart } from '../components/Charts';
import { useAppData } from '../hooks/useAppData';
import { useCurrencyData } from '../hooks/useCurrencyInfo';
import { CurrencyProvider, CurrencySwitch } from '../components/CurrencyView';
import { buildInsightsSnapshot, type InsightsRange, type TrendMonths } from '../services/insights/InsightsService';
import { colors, spacing } from '../theme';
import { dateKeyToInputDate, displayFullDate, inputDateToDateKey, parseDateKey, todayLocal } from '../utils/date';
import { formatMoney } from '../utils/money';
import { categoryIcon } from '../utils/icons';

// The donut shows the five largest categories; the rest share one grey slice.
const DONUT_SLICES = 5;

const rangeRows = [
  ['THIS_MONTH', 'This month'],
  ['LAST_MONTH', 'Last month'],
  ['LAST_3_MONTHS', 'Last 3 months'],
  ['LAST_6_MONTHS', 'Last 6 months'],
  ['THIS_YEAR', 'This year'],
  ['CUSTOM', 'Custom range'],
];
const trendRows = [['3', '3 months'], ['6', '6 months'], ['12', '12 months']];

export function InsightsScreen({ navigation }: any) {
  const { accounts, categories, allPeople, currentDateKey = todayLocal() } = useAppData();
  // One currency at a time: amounts in different currencies are never added together.
  const { currency, transactions, entries, subscriptions, accountIds } = useCurrencyData();
  const [range, setRange] = useState<InsightsRange>('THIS_MONTH');
  const [fromInput, setFromInput] = useState(dateKeyToInputDate());
  const [toInput, setToInput] = useState(dateKeyToInputDate());
  const [trendMonths, setTrendMonths] = useState<TrendMonths>(6);
  const from = fromInput.trim() ? inputDateToDateKey(fromInput) ?? '' : '';
  const to = toInput.trim() ? inputDateToDateKey(toInput) ?? '' : '';
  let report = null;
  let error = '';
  try {
    report = buildInsightsSnapshot({
      selection: { range, from, to },
      trendMonths,
      today: currentDateKey,
      accounts: accounts.filter((account) => account.currency === currency),
      categories,
      transactions,
      people: allPeople,
      peopleEntries: entries,
      subscriptions,
      accountIds,
    });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'Could not calculate insights.';
  }
  const colorFor = (index: number) => index < DONUT_SLICES ? chartPalette[index] : chartOtherColor;
  const donutSegments = report ? [
    ...report.categories.slice(0, DONUT_SLICES).map((category, index) => ({ key: category.id, value: category.amountMinor, color: colorFor(index) })),
    { key: 'other', value: report.categories.slice(DONUT_SLICES).reduce((sum, category) => sum + category.amountMinor, 0), color: chartOtherColor },
  ] : [];
  const trendPoints = report ? report.trend.map((point) => ({
    key: point.month,
    label: parseDateKey(`${point.month}-01`).toLocaleDateString(undefined, { month: 'short' }),
    value: point.amountMinor,
    valueLabel: compactAmount(point.amountMinor),
  })) : [];
  const trendTotal = report ? report.trend.reduce((sum, point) => sum + point.amountMinor, 0) : 0;
  const trendAverage = report && report.trend.length ? Math.round(trendTotal / report.trend.length) : 0;
  return <Screen scroll>
    <BackHeader title="Insights" />
    <CurrencySwitch />
    <CurrencyProvider currency={currency}>
    <Picker label="Date range" value={range} setValue={(value) => setRange(value as InsightsRange)} rows={rangeRows} />
    {range === 'CUSTOM' ? <>
      <TextField label="From" placeholder="DD-MM-YYYY" value={fromInput} onChangeText={setFromInput} />
      <TextField label="To" placeholder="DD-MM-YYYY" value={toInput} onChangeText={setToInput} />
    </> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: colors.negative }}>{error}</Text> : null}
    {report ? <>
      <Text style={{ color: colors.muted }}>{`${displayFullDate(report.from)} to ${displayFullDate(report.to)}`}</Text>
      <SectionHeader title="Personal financial result" />
      <Card>
        <ListRow title="Personal spending" subtitle="Expenses plus only your share of shared bills" right={<MoneyText amount={-report.personalSpendingMinor} type="negative" />} />
        <ListRow title="Genuine income" right={<MoneyText amount={report.incomeMinor} type="positive" />} />
        <ListRow title="Income minus spending" subtitle="This is not account cash change" right={<MoneyText amount={report.personalResultMinor} type={report.personalResultMinor >= 0 ? 'positive' : 'negative'} />} />
      </Card>

      <SectionHeader title="Cash and current position" />
      <Card>
        <ListRow title="Account cash change" subtitle="Actual account inflows minus outflows in this period" right={<MoneyText amount={report.accountCashChangeMinor} type={report.accountCashChangeMinor >= 0 ? 'positive' : 'negative'} />} />
        <ListRow title="Total account balance" subtitle="Current balance across active accounts" right={<MoneyText amount={report.totalAccountBalanceMinor} />} />
        <ListRow title="Net personal position" subtitle="Account balances plus what others owe you, minus what you owe" right={<MoneyText amount={report.netPersonalPositionMinor} type={report.netPersonalPositionMinor >= 0 ? 'positive' : 'negative'} />} />
      </Card>

      <SectionHeader title="Current People balances" />
      <Card>
        <ListRow title="Others owe you" right={<MoneyText amount={report.peopleOweYouMinor} type="positive" />} />
        <ListRow title="You owe others" right={<MoneyText amount={-report.youOwePeopleMinor} type="negative" />} />
        <ListRow title="Net People position" right={<MoneyText amount={report.netPeoplePositionMinor} type={report.netPeoplePositionMinor >= 0 ? 'positive' : 'negative'} />} />
        {!report.peopleOweYouMinor && !report.youOwePeopleMinor ? <Text style={{ color: colors.muted }}>No current People balances.</Text> : null}
      </Card>

      <SectionHeader title="Spending by category" />
      {report.categories.length ? <Card>
        <DonutChart
          segments={donutSegments}
          centerTitle="Spent"
          centerValue={formatMoney(report.personalSpendingMinor, currency)}
          accessibilityLabel={`Spending by category: ${report.categories.map((category) => `${category.name} ${category.sharePercent}%`).join(', ')}`}
        />
        {/* Legend: each category in its slice colour; tap to see its records. */}
        <View style={{ marginTop: spacing.md }}>
          {report.categories.map((category, index) => <ListRow
            key={category.id}
            icon={categoryIcon(categories.find((item) => item.id === category.id) ?? { name: category.name, type: 'EXPENSE' })}
            iconColor={colorFor(index)}
            title={category.name}
            subtitle={`${category.sharePercent}% of spending`}
            right={<MoneyText amount={-category.amountMinor} type="negative" />}
            onPress={() => navigation.navigate('InsightsCategoryDetail', {
              categoryId: category.id,
              categoryName: category.name,
              from: report!.from,
              to: report!.to,
              currency,
            })}
          />)}
        </View>
      </Card> : <EmptyState title="No personal spending in this range." subtitle="Income and money movements do not appear in category spending." />}

      <SectionHeader title="Spending trend" />
      <Picker label="Trend period" value={String(trendMonths)} setValue={(value) => setTrendMonths(Number(value) as TrendMonths)} rows={trendRows} />
      <Card>
        <BarChart
          points={trendPoints}
          highlightKey={currentDateKey.slice(0, 7)}
          accessibilityLabel={`Spending trend: ${report.trend.map((point) => `${point.label} ${formatMoney(point.amountMinor, currency)}`).join(', ')}`}
        />
        {report.trend.some((point) => point.amountMinor > 0)
          ? <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.md }}>
            <Text style={{ color: colors.muted }}>Monthly average</Text>
            <MoneyText amount={trendAverage} />
          </View>
          : <Text style={{ color: colors.muted, marginTop: spacing.sm }}>No personal spending in these months.</Text>}
      </Card>

      <SectionHeader title="Subscription commitments" info="Future planned payments and subscription estimates are not included in actual income, spending or cash movement until a payment is recorded." />
      <Card>
        <ListRow title="Estimated monthly subscriptions" subtitle={`${report.activeSubscriptionCount} active | Reporting estimate only`} right={<MoneyText amount={-report.subscriptionMonthlyMinor} type="negative" />} />
        {!report.activeSubscriptionCount ? <Text style={{ color: colors.muted }}>No active subscription commitments.</Text> : null}
      </Card>
    </> : null}
    </CurrencyProvider>
  </Screen>;
}

import { useHideStartupSplash } from '../components/StartupSplash';
import { Ionicons } from '@expo/vector-icons';
import { BackupActions } from '../components/BackupActions';
import { PersonCapsule, PersonSummary, personHistoryLayout, personSnapOffset } from '../components/PersonSummary';
import { ResponsivePreview } from '../components/ResponsivePreview';
import { ReminderIntroduction, ReminderPreferences } from '../components/ReminderControls';
import { ReminderNavigationReady } from './ReminderNavigationContext';
import { useReminderNavigation } from '../hooks/useReminderNavigation';
import appConfig from '../../app.json';
import { KeyboardSafeScrollView } from '../components/KeyboardSafeScrollView';
import { changedName, validMoneyInput } from '../utils/formValidation';
import {
  DefaultTheme,
  NavigationContainer,
} from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { accountIcon, activityIcon, categoryIcon, categoryRows, type IconTone } from '../utils/icons';
import { createMaterialTopTabNavigator } from '@react-navigation/material-top-tabs';
import {
  createStackNavigator,
  type StackCardStyleInterpolator,
} from '@react-navigation/stack';
import {
  Animated,
  Easing,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  LayoutAnimation,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';
import {
  AppHeader,
  Card,
  EmptyState,
  ListRow,
  LoadingScreen,
  MoneyText,
  PrimaryButton,
  ProgressBar,
  Screen,
  TabSceneContext,
  SecondaryButton,
  SectionHeader,
  TextField,
} from '../components/common';
import { useAppDialog } from '../components/dialogs/AppDialogProvider';
import { BackHeader, FormScreen, Picker, SelectField } from '../components/forms';
import { useAppData } from '../hooks/useAppData';
import { useCurrencyData, useCurrencyInfo } from '../hooks/useCurrencyInfo';
import { CurrencyProvider, CurrencySwitch, useAccountLabel, useMoney, useMoneyLabel } from '../components/CurrencyView';
import { orderCurrencies } from '../services/currency/CurrencyScope';
import { useSubmitGuard } from '../hooks/useSubmitGuard';
import { useReminderSelectionWarning } from '../hooks/useReminderSelectionWarning';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { useConfirmActivityChange, useConfirmOutflow } from '../hooks/useConfirmOutflow';
import { ActivityDetailScreen, ActivityListScreen } from './ActivityScreens';
import { activityOrderSetting, activitySubtitle, listActivity, type ActivityRow } from '../services/activity/ActivityService';
import { AccountAdjustScreen, AccountDetailScreen, AccountEditScreen, ArchivedAccountsPanel } from './AccountScreens';
import { GroupDetailScreen, GroupEditScreen, GroupListPanel, GroupReconcileScreen, GroupSettleScreen } from './GroupScreens';
import { SplitScreen } from './SplitScreen';
import { PlannedPaymentDetailScreen } from './PlannedPaymentScreens';
import { updateTransaction } from '../services/finance/TransactionService';
import { paidByPersonExpenseInput, previewSharedExpensePosting, saveSharedExpensePosting } from '../services/sharedExpense/SharedExpenseService';
import { colors, elevation, radius, spacing, tones } from '../theme';
import { PressableScale } from '../components/PressableScale';
import { LabelWithInfo } from '../components/InfoTip';
import {
  displayDate,
  dateKeyToInputDate,
  displayFullDate,
  displayMonthYear,
  inputDateToDateKey,
  monthKey,
  todayLocal,
} from '../utils/date';
import { currencySymbol, exchangeRateText, formatMoney, minorUnitsToMoney, moneyToMinorUnits } from '../utils/money';
import {
  formatRecurrenceLabel,
  parseRecurrenceInterval,
  plannedRecurrenceRows,
  recurrenceIntervalForSave,
  subscriptionFrequencyRows,
  validateRecurrenceInterval,
} from '../utils/recurrence';
import { currencyRows, defaultCurrency } from '../utils/currency';
import {
  getBudgetLimitState,
  normalizeBudgetThreshold,
} from '../utils/budget';
import { calculateAccountBalance } from '../services/finance/FinanceService';
import {
  accountHasRecords,
  accountTypeRows,
  accountTotalsByCurrency,
  defaultAccountId,
  defaultAccountNameForType,
  formatAccountType,
  hasActiveAccountNamed,
} from '../services/accounts/AccountService';
import { validateSetupInput } from '../services/onboarding/OnboardingService';
import {
  balanceStatus,
  buildBalanceCrossingMessage,
  detectBalanceCrossing,
  peopleActionLabel,
  peopleEntryDisplayLabel,
  personEntryDelta,
  resolvePeopleAction,
  type VisiblePeopleAction,
} from '../services/people/PeopleBalanceService';
import {
  PersonArchiveError,
  archivePerson,
  recordPeopleAction,
  renamePerson,
  restorePerson,
  updatePersonEntry,
} from '../services/people/PersonService';
import {
  calculateNextRenewal,
  getSubscriptionDueStatus,
} from '../services/subscriptions/SubscriptionService';
import { SubscriptionDetailScreen } from './SubscriptionScreens';
import { InsightsScreen } from './InsightsScreen';
import { InsightsCategoryDetailScreen } from './InsightsCategoryDetailScreen';
import {
  getBudgetRemaining,
  getBudgetUsagePercentage,
  getDailyAllowanceState,
  getThreeMonthCategorySuggestion,
  getCategoryExpenseTotal,
  getMonthlyExpenseTotal,
  shiftMonthKey,
} from '../services/budget/BudgetService';
import {
  copyPreviousMonthPlan,
  planMonthNavigation,
  createCategoryBudget,
  previewCopyPreviousMonth,
  removeCategoryBudget,
  updateCategoryBudget,
} from '../services/budget/SpendingPlanService';
import { suggestCategory } from '../services/categories/CategoryService';
import {
  calculateGoalProgress,
  calculateGoalRemaining,
  calculateSuggestedMonthlySaving,
  getGoalOverBalance,
  getGoalStatus,
  goalStatusLabel,
} from '../services/goals/GoalService';
import {
  getPlannedDueStatus,
} from '../services/planned/PlannedPaymentService';
import type {
  AccountType,
  Person,
  PersonEntry,
  FrequencyType,
  PlannedRecurrenceType,
  TransactionType,
  Transaction,
  Budget,
} from '../types/models';

type AlertAction = {
  text: string;
  onPress?: () => void | Promise<void>;
  style?: 'cancel' | 'destructive' | 'default';
};

const weekStartRows = [
  ['SUNDAY', 'Sunday'],
  ['MONDAY', 'Monday'],
  ['TUESDAY', 'Tuesday'],
  ['WEDNESDAY', 'Wednesday'],
  ['THURSDAY', 'Thursday'],
  ['FRIDAY', 'Friday'],
  ['SATURDAY', 'Saturday'],
];

function useThemedAlert() {
  const { showDialog } = useAppDialog();
  return (
    title: string,
    message?: string,
    actions?: AlertAction[],
  ) => {
    showDialog({
      title,
      message,
      actions: actions?.map((action, index) => ({
        text: action.text,
        onPress: action.onPress,
        variant:
          action.style === 'destructive'
            ? 'destructive'
            : index === actions.length - 1 && action.style !== 'cancel'
              ? 'primary'
              : 'secondary',
      })),
    });
  };
}

/** Formats in the screen's currency (see CurrencyProvider), or in the currency given. */
function useMoneyFormat() {
  return useMoney();
}

function SettingSelectRow({
  title,
  value,
  rows,
  onSelect,
  info,
}: {
  title: string;
  value: string;
  rows: string[][];
  onSelect: (value: string) => void;
  info?: string;
}) {
  const selectedLabel = rows.find(([id]) => id === value)?.[1] ?? value;
  return (
    <SelectField
      label={title}
      info={info}
      value={selectedLabel}
      rows={rows}
      onSelect={onSelect}
    />
  );
}

const Stack = createStackNavigator();
const Tabs = createMaterialTopTabNavigator();
const navigationTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: colors.background,
    card: colors.background,
    primary: colors.primary,
    text: colors.text,
    border: colors.border,
  },
};
const pagerTransitionSpec = {
  animation: 'timing' as const,
  config: {
    duration: 600,
    easing: Easing.out(Easing.cubic),
  },
};
const pagerCardStyleInterpolator: StackCardStyleInterpolator = ({
  current,
  next,
  layouts,
}) => {
  const screenWidth = layouts.screen.width;
  const translateX = next
    ? next.progress.interpolate({
        inputRange: [0, 1],
        outputRange: [0, -screenWidth],
        extrapolate: 'clamp',
      })
    : current.progress.interpolate({
        inputRange: [0, 1],
        outputRange: [screenWidth, 0],
        extrapolate: 'clamp',
      });

  return {
    cardStyle: {
      backgroundColor: colors.background,
      transform: [{ translateX }],
    },
  };
};
const stackScreenOptions = {
  headerShown: false,
  gestureEnabled: true,
  gestureDirection: 'horizontal' as const,
  cardStyle: { backgroundColor: colors.background },
  cardStyleInterpolator: pagerCardStyleInterpolator,
  cardOverlayEnabled: false,
  cardShadowEnabled: false,
  transitionSpec: {
    open: pagerTransitionSpec,
    close: pagerTransitionSpec,
  },
};
export function AppNavigator() {
  const { ready, settings, dataEpoch, restoreRefreshFailed, retryRestoreRefresh, resumeRefreshFailed, retryResumeRefresh } = useAppData();
  const { showDialog } = useAppDialog();
  const { navigationRef: reminderNavigationRef, introductionReady, onReady: onReminderNavigationReady } = useReminderNavigation();
  const insets = useSafeAreaInsets();
  useHideStartupSplash(restoreRefreshFailed || (ready && !!settings));
  if (restoreRefreshFailed) return <Screen><Card><Text>Backup restored. Reload your data to continue.</Text><PrimaryButton title="Retry Reload" onPress={() => { void retryRestoreRefresh().catch(() => showDialog({ title: 'Unable to reload', message: 'Your restored data is saved. Please try reloading again.' })); }} /></Card></Screen>;
  if (!ready || !settings) return <LoadingScreen />;
  return (
    <View style={styles.appRoot}>
    <ReminderNavigationReady.Provider value={introductionReady}>
    <NavigationContainer key={dataEpoch} ref={reminderNavigationRef} onReady={onReminderNavigationReady} theme={navigationTheme}>
      <Stack.Navigator
        detachInactiveScreens={false}
        screenOptions={stackScreenOptions}
      >
        {settings.setup_complete !== 'true' ? (
          <Stack.Screen name="Onboarding" component={OnboardingScreen} />
        ) : (
          <>
            <Stack.Screen name="Tabs" component={MainTabs} />
            <Stack.Screen
              name="TransactionForm"
              component={TransactionFormScreen}
            />
            <Stack.Screen name="PersonDetail" component={PersonDetailScreen} />
            <Stack.Screen name="PersonEdit" component={PersonEditScreen} />
            <Stack.Screen name="ActivityDetail" component={ActivityDetailScreen} />
            <Stack.Screen name="GroupDetail" component={GroupDetailScreen} />
            <Stack.Screen name="GroupEdit" component={GroupEditScreen} />
            <Stack.Screen name="GroupReconcile" component={GroupReconcileScreen} />
            <Stack.Screen name="GroupSettle" component={GroupSettleScreen} />
            <Stack.Screen
              name="PersonEntryForm"
              component={PersonEntryFormScreen}
            />
            <Stack.Screen name="Split" component={SplitScreen} />
            <Stack.Screen name="GoalDetail" component={GoalDetailScreen} />
            <Stack.Screen name="Accounts" component={AccountsScreen} />
            <Stack.Screen name="AccountDetail" component={AccountDetailScreen} />
            <Stack.Screen name="AccountEdit" component={AccountEditScreen} />
            <Stack.Screen name="AccountAdjust" component={AccountAdjustScreen} />
            <Stack.Screen name="Budget" component={BudgetScreen} />
            <Stack.Screen name="Categories" component={CategoriesScreen} />
            <Stack.Screen name="Planned" component={PlannedScreen} />
            <Stack.Screen name="AddPlannedPayment" component={AddPlannedPaymentScreen} />
            <Stack.Screen name="PlannedPaymentDetail" component={PlannedPaymentDetailScreen} getId={({ params }) => params && 'plannedPaymentId' in params && typeof params.plannedPaymentId === 'string' ? params.plannedPaymentId : undefined} />
            <Stack.Screen
              name="Subscriptions"
              component={SubscriptionsScreen}
            />
            <Stack.Screen name="SubscriptionDetail" component={SubscriptionDetailScreen} getId={({ params }) => params && 'subscriptionId' in params && typeof params.subscriptionId === 'string' ? params.subscriptionId : undefined} />
            <Stack.Screen name="AddSubscription" component={AddSubscriptionScreen} />
            <Stack.Screen name="Insights" component={InsightsScreen} />
            <Stack.Screen name="InsightsCategoryDetail" component={InsightsCategoryDetailScreen} />
            <Stack.Screen name="Settings" component={SettingsScreen} />
            <Stack.Screen name="About" component={AboutScreen} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
    </ReminderNavigationReady.Provider>
    {resumeRefreshFailed ? (
      <View accessibilityRole="alert" style={[styles.resumeNotice, { bottom: 76 + insets.bottom }]}>
        <Text style={styles.resumeNoticeText}>Could not refresh current data.</Text>
        <SecondaryButton title="Retry refresh" onPress={() => { void retryResumeRefresh().catch(() => showDialog({ title: 'Unable to refresh', message: 'Your existing data is safe. Please try again.' })); }} />
      </View>
    ) : null}
    </View>
  );
}

/** On full-screen (stack) lists the + button must also clear Android's gesture bar / 3-button navigation. */
function useStackFabStyle() {
  const insets = useSafeAreaInsets();
  return [styles.fab, { bottom: 28 + insets.bottom }];
}

export const mainTabSceneStyle = {
  backgroundColor: colors.background,
  overflow: 'hidden' as const,
};

function MainTabs() {
  // Edge-to-edge: keep the tab bar above Android's gesture bar or 3-button navigation.
  const insets = useSafeAreaInsets();
  return (
    <TabSceneContext.Provider value={true}>
    <Tabs.Navigator
      tabBarPosition="bottom"
      initialLayout={{ width: 390 }}
      screenOptions={({ route }) => ({
        swipeEnabled: true,
        animationEnabled: true,
        lazy: false,
        sceneStyle: mainTabSceneStyle,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.muted,
        tabBarPressColor: '#DDE5DC',
        tabBarIndicatorStyle: {
          backgroundColor: colors.primary,
          height: 2,
          top: 0,
        },
        tabBarStyle: {
          height: 62 + insets.bottom,
          paddingTop: 4,
          paddingBottom: 5 + insets.bottom,
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          elevation: 0,
        },
        tabBarItemStyle: { paddingHorizontal: 0, paddingVertical: 0 },
        tabBarShowIcon: true,
        tabBarLabel: ({ color }) => (
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.65}
            style={{ color, fontSize: 10, fontWeight: '600' }}
          >
            {route.name}
          </Text>
        ),
        tabBarIcon: ({ color, focused }) => {
          const icons = {
            Home: focused ? 'home' : 'home-outline',
            Transactions: focused ? 'list' : 'list-outline',
            Goals: focused ? 'flag' : 'flag-outline',
            People: focused ? 'people' : 'people-outline',
            More: focused ? 'menu' : 'menu-outline',
          } as Record<string, any>;
          return <Ionicons name={icons[route.name]} color={color} size={20} />;
        },
      })}
    >
      <Tabs.Screen name="Home" component={HomeScreen} />
      <Tabs.Screen name="Transactions" component={ActivityListScreen} />
      <Tabs.Screen name="Goals" component={GoalsScreen} />
      <Tabs.Screen name="People" component={PeopleScreen} />
      <Tabs.Screen name="More" component={MoreScreen} />
    </Tabs.Navigator>
    </TabSceneContext.Provider>
  );
}

export function GoalsScreen({ navigation }: any) {
  const { db, repo, goals, allGoals, accounts, refresh } = useAppData();
  const { currencies, mainCurrency } = useCurrencyInfo();
  const alert = useThemedAlert();
  const dialog = useAppDialog();
  const fmt = useMoneyFormat();
  const accountLabel = useAccountLabel();
  const moneyLabel = useMoneyLabel();
  // A goal is in one currency: its linked account's, or the one chosen for it.
  const [chosenCurrency, setGoalCurrency] = useState(mainCurrency);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [saved, setSaved] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [account, setAccount] = useState<string | undefined>(undefined);
  const [note, setNote] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const archivedGoals = allGoals.filter((goal) => goal.is_archived);
  const viewingArchived = showArchived && archivedGoals.length > 0;
  useEffect(() => { if (!archivedGoals.length) setShowArchived(false); }, [archivedGoals.length]);
  const form = useSubmitGuard(refresh);
  const dirty = useDirtyForm(adding && !!(name.trim() || target.trim() || saved.trim() || note.trim() || account || targetDate), form.isSaving);
  function resetGoal() {
    setName(''); setTarget(''); setSaved(''); setTargetDate(''); setNote(''); setAccount(undefined); setAdding(false);
  }
  const goalCurrency = (account ? accounts.find((a) => a.id === account)?.currency : undefined) ?? chosenCurrency;
  const save = () => form.submit(async () => {
    if (!db || !name.trim())
      return alert('Name required', 'Enter a goal name.');
    const targetMinor = moneyToMinorUnits(target);
    const savedMinor = saved ? moneyToMinorUnits(saved) : 0;
    const dateKey = targetDate ? inputDateToDateKey(targetDate) : null;
    if (!targetMinor || targetMinor <= 0)
      return alert(
        'Invalid target',
        'Enter a target amount greater than zero.',
      );
    if (Number.isNaN(savedMinor) || savedMinor < 0)
      return alert('Invalid saved amount', 'Enter a valid saved amount.');
    if (targetDate && !dateKey)
      return alert(
        'Invalid date',
        'Use DD-MM-YYYY, for example 09-09-2026.',
      );
    if (account) {
      const [freshAccounts, freshTransactions, freshEntries] = await Promise.all([
        repo.listAccounts(db),
        repo.listTransactions(db),
        repo.listPersonEntries(db),
      ]);
      const overBalance = getGoalOverBalance(savedMinor, account, freshAccounts, freshTransactions, freshEntries);
      if (overBalance && !await dialog.confirm({
        title: 'Savings exceed account balance',
        message: `This goal tracks ${fmt(savedMinor, goalCurrency)}, but the linked account currently has ${fmt(overBalance.balanceMinor, goalCurrency)}. The goal is tracking only and will not move money.`,
        cancelText: 'Go Back',
        confirmText: 'Save Anyway',
      })) return;
    }
    await repo.saveGoal(db, {
      name,
      target_amount_minor: targetMinor,
      initial_saved_minor: savedMinor,
      target_date: dateKey,
      linked_account_id: account ?? null,
      note,
      currency: goalCurrency,
    });
    await form.saved('Goal saved', () => { resetGoal(); setGoalCurrency(mainCurrency); });
  });
  return (
    <Screen>
      <AppHeader title="Goals" />
      {adding ? (
        <KeyboardAvoidingView enabled={Platform.OS === 'ios'} behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 3, maxHeight: '80%' }}>
        <KeyboardSafeScrollView>
        <Card>
          <TextField
            label="Name"
            placeholder="Laptop"
            value={name}
            onChangeText={setName}
          />
          <TextField
            label={moneyLabel('Target Amount', goalCurrency)}
            placeholder="150000"
            value={target}
            onChangeText={setTarget}
            keyboardType="decimal-pad"
          />
          <TextField
            label={moneyLabel('Current Saved Amount', goalCurrency)}
            placeholder="0"
            value={saved}
            onChangeText={setSaved}
            keyboardType="decimal-pad"
          />
          <TextField
            label="Target Date"
            placeholder="DD-MM-YYYY"
            value={targetDate}
            onChangeText={setTargetDate}
            optionalDate="No target date"
            allowFuture
            allowPast={false}
          />
          <Picker
            label="Linked Account"
            value={account}
            setValue={setAccount}
            rows={[['', 'None'], ...accounts.map((a) => [a.id, accountLabel(a)])]}
          />
          {!account && currencies.length > 1 ? <Picker
            label="Goal currency"
            info="The currency this goal is saved in. A linked account decides it instead."
            value={goalCurrency}
            setValue={setGoalCurrency}
            rows={currencyRows.filter(([code]) => currencies.includes(code))}
          /> : null}
          <TextField
            label="Note"
            placeholder="Optional"
            value={note}
            onChangeText={setNote}
          />
          <PrimaryButton title="Save Goal" onPress={save} saving={form.saving} disabled={!name.trim() || !validMoneyInput(target) || !validMoneyInput(saved, { optional: true, allowZero: true }) || !!(targetDate && !inputDateToDateKey(targetDate))} />
        </Card>
        </KeyboardSafeScrollView>
        </KeyboardAvoidingView>
      ) : null}
      {archivedGoals.length > 0 ? <SecondaryButton title={viewingArchived ? 'Hide Archived Goals' : 'Show Archived Goals'} onPress={() => setShowArchived((value) => !value)} /> : null}
      {/* While adding, the form gets most of the room; the goals list keeps the rest. */}
      <FlatList
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.fabListPadding}
        data={viewingArchived ? archivedGoals : goals}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={
          <EmptyState
            title="No goals yet."
            subtitle="Create a goal for something you're saving toward."
          />
        }
        renderItem={({ item }) => {
          const savedMinor = item.saved_minor ?? item.initial_saved_minor;
          const progress = calculateGoalProgress(
            item.target_amount_minor,
            savedMinor,
          );
          return (
            <ListRow
              card
              icon="flag-outline"
              iconTone={progress >= 100 ? 'positive' : 'neutral'}
              title={item.name}
              subtitle={`${goalStatusLabel(getGoalStatus(item, savedMinor))} · ${fmt(savedMinor, item.currency)} / ${fmt(item.target_amount_minor, item.currency)}`}
              onPress={() =>
                navigation.navigate('GoalDetail', { goalId: item.id })
              }
              right={<View style={styles.goalProgress}><Text style={styles.goalPercent}>{progress}%</Text><ProgressBar value={progress} /></View>}
            />
          );
        }}
      />
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="Add goal"
        onPress={() => adding ? dirty.discard(resetGoal) : setAdding(true)}
        android_ripple={{ color: colors.secondary }}
        scaleTo={0.92}
        containerStyle={styles.fab}
        style={styles.fabInner}
      >
        <Ionicons
          name={adding ? 'close' : 'add'}
          size={28}
          color={colors.surface}
        />
      </PressableScale>
    </Screen>
  );
}

export function GoalDetailScreen({ route, navigation }: any) {
  const { db, repo, allGoals, goalEntries, accounts, refresh } = useAppData();
  const accountLabel = useAccountLabel();
  const alert = useThemedAlert();
  const dialog = useAppDialog();
  const fmtMoney = useMoneyFormat();
  const goal = allGoals.find((item) => item.id === route.params.goalId);
  // Everything here is in the goal's own currency.
  const fmt = (amountMinor: number) => fmtMoney(amountMinor, goal?.currency);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [account, setAccount] = useState<string | undefined>();
  const [note, setNote] = useState('');
  const form = useSubmitGuard(refresh);
  useDirtyForm(editing ? !!(name.trim() || target.trim() || targetDate.trim() || account || note.trim()) : !!(amount.trim() || (date && date !== dateKeyToInputDate())), form.isSaving);
  if (!goal)
    return (
      <Screen>
        <BackHeader title="Goal" />
        <EmptyState title="Goal not found." />
      </Screen>
    );
  const savedMinor = goal.saved_minor ?? goal.initial_saved_minor;
  const remaining = calculateGoalRemaining(
    goal.target_amount_minor,
    savedMinor,
  );
  const progress = calculateGoalProgress(goal.target_amount_minor, savedMinor);
  const status = getGoalStatus(goal, savedMinor);
  const history = goalEntries.filter((entry) => entry.goal_id === goal.id);
  function openEdit() {
    setName(goal!.name);
    setTarget((goal!.target_amount_minor / 100).toFixed(2));
    setTargetDate(goal!.target_date ? dateKeyToInputDate(goal!.target_date) : '');
    setAccount(goal!.linked_account_id ?? undefined);
    setNote(goal!.note ?? '');
    setEditing(true);
  }
  const addEntry = (type: 'ADD' | 'WITHDRAW') => form.submit(async () => {
    if (!db || !goal) return;
    const minor = moneyToMinorUnits(amount);
    const dateKey = inputDateToDateKey(date);
    if (!minor || minor <= 0)
      return alert(
        'Invalid amount',
        'Enter an amount greater than zero.',
      );
    if (!dateKey)
      return alert(
        'Invalid date',
        'Use DD-MM-YYYY, for example 09-09-2026.',
      );
    try {
      await repo.saveGoalEntry(db, { goal_id: goal.id, type, amount_minor: minor, occurred_on: dateKey });
      await form.saved(type === 'WITHDRAW' ? 'Money released from goal tracking' : 'Goal savings updated', () => { setAmount(''); setDate(dateKeyToInputDate()); });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Please try again.';
      if (type === 'WITHDRAW' && message.includes('currently tracked')) return alert('Not enough saved in this goal', `This goal currently tracks ${fmt(savedMinor)}. Choose that amount or less.`);
      throw error;
    }
  });
  const saveEdit = () => form.submit(async () => {
    if (!db) return;
    const targetMinor = moneyToMinorUnits(target);
    const dateKey = targetDate ? inputDateToDateKey(targetDate) : null;
    if (!name.trim()) return alert('Name required', 'Enter a goal name.');
    if (!targetMinor || targetMinor <= 0) return alert('Invalid target', 'Enter a target amount greater than zero.');
    if (targetMinor < savedMinor) return alert('Target is too low', `This goal already tracks ${fmt(savedMinor)}. Increase the target or withdraw money first.`);
    if (targetDate && !dateKey) return alert('Invalid date', 'Use DD-MM-YYYY, for example 09-09-2026.');
    if (account) {
      const [freshAccounts, freshTransactions, freshEntries] = await Promise.all([
        repo.listAccounts(db),
        repo.listTransactions(db),
        repo.listPersonEntries(db),
      ]);
      const overBalance = getGoalOverBalance(savedMinor, account, freshAccounts, freshTransactions, freshEntries);
      if (overBalance && !await dialog.confirm({
        title: 'Savings exceed account balance',
        message: `This goal tracks ${fmt(savedMinor)}, but the linked account currently has ${fmt(overBalance.balanceMinor)}. The goal is tracking only and will not move money.`,
        cancelText: 'Go Back',
        confirmText: 'Save Anyway',
      })) return;
    }
    await repo.updateGoal(db, goal.id, goal.updated_at, { name, target_amount_minor: targetMinor, target_date: dateKey, linked_account_id: account ?? null, note });
    await form.saved('Goal updated', () => setEditing(false));
  });
  const archive = () => form.submit(async () => {
    if (!db) return;
    if (!await dialog.confirm({ title: 'Archive goal?', message: 'Its saved amount and history will stay readable, but new allocations and withdrawals will stop.', confirmText: 'Archive', cancelText: 'Cancel', destructive: true })) return;
    await repo.archiveGoal(db, goal.id, goal.updated_at);
    await form.saved('Goal archived', () => navigation.goBack(), true);
  });
  const deleteGoal = () => form.submit(async () => {
    if (!db) return;
    if (!await dialog.confirm({ title: 'Delete empty goal?', message: 'Only a goal with no saved money or history can be deleted.', confirmText: 'Delete', cancelText: 'Cancel', destructive: true })) return;
    await repo.deleteEmptyGoal(db, goal.id, goal.updated_at);
    await form.saved('Goal deleted', () => navigation.goBack(), true);
  });
  const restore = () => form.submit(async () => {
    if (!db) return;
    await repo.restoreGoal(db, goal.id, goal.updated_at);
    await form.saved('Goal restored', () => setEditing(false));
  });
  return (
    <FormScreen title={goal.name}>
      <CurrencyProvider currency={goal.currency}>
      <Card>
        <LabelWithInfo label="Saved" info="Goal savings are tracked here. Adding or withdrawing money does not move money from your account, create income or expense, or affect your Spending Plan." textStyle={styles.muted} />
        <MoneyText amount={savedMinor} style={{ fontSize: 28 }} />
        <Text style={styles.muted}>
          of {fmt(goal.target_amount_minor)}
        </Text>
        <ProgressBar value={progress} />
        <Text>Remaining: {fmt(remaining)}</Text>
        <Text>Status: {goalStatusLabel(status)}</Text>
        <Text style={styles.muted}>
          Target:{' '}
          {goal.target_date
            ? displayFullDate(goal.target_date)
            : 'No target date'}
        </Text>
        <Text style={styles.muted}>
          Suggested monthly saving:{' '}
          {fmt(calculateSuggestedMonthlySaving(remaining, goal.target_date))}
        </Text>
        {goal.linked_account_id ? <Text style={styles.muted}>Reference account: {goal.linked_account_name ?? accounts.find((item) => item.id === goal.linked_account_id)?.name ? accountLabel({ name: (goal.linked_account_name ?? accounts.find((item) => item.id === goal.linked_account_id)?.name)!, currency: goal.currency }) : 'Unavailable account'} (reference only)</Text> : null}
      </Card>
      {goal.is_archived ? <Card><Text style={styles.muted}>This goal is archived. Its history remains here for reference.</Text><PrimaryButton title="Restore Goal" onPress={restore} saving={form.saving} /></Card> : editing ? <Card>
        <TextField label="Name" placeholder="Laptop" value={name} onChangeText={setName} />
        <TextField label="Target Amount" placeholder="150000" value={target} onChangeText={setTarget} keyboardType="decimal-pad" />
        <TextField label="Target Date" placeholder="DD-MM-YYYY" value={targetDate} onChangeText={setTargetDate} optionalDate="No target date" allowFuture allowPast={false} />
        <Picker label="Reference Account" value={account} setValue={setAccount} rows={[['', 'None'], ...accounts.filter((item) => item.currency === goal.currency || item.id === goal.linked_account_id).map((item) => [item.id, accountLabel(item)])]} />
        <TextField label="Note" placeholder="Optional" value={note} onChangeText={setNote} />
        <PrimaryButton title="Save Changes" onPress={saveEdit} saving={form.saving} disabled={!name.trim() || !validMoneyInput(target) || moneyToMinorUnits(target) < savedMinor || !!(targetDate && !inputDateToDateKey(targetDate)) || (name.trim() === goal.name && moneyToMinorUnits(target) === goal.target_amount_minor && (targetDate ? inputDateToDateKey(targetDate) : null) === (goal.target_date ?? null) && (account || null) === (goal.linked_account_id ?? null) && note.trim() === (goal.note ?? ''))} />
        <SecondaryButton title="Cancel" disabled={form.saving} onPress={() => setEditing(false)} />
      </Card> : <>
        <TextField label="Amount" placeholder="0" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
        <TextField label="Date" placeholder="DD-MM-YYYY" value={date} onChangeText={setDate} />
        <View style={styles.quick}>
          <SecondaryButton title="Add Money" disabled={form.saving || !validMoneyInput(amount) || !inputDateToDateKey(date)} onPress={() => addEntry('ADD')} />
          <SecondaryButton title="Withdraw Money" disabled={form.saving || !validMoneyInput(amount) || moneyToMinorUnits(amount) > savedMinor || !inputDateToDateKey(date)} onPress={() => addEntry('WITHDRAW')} />
        </View>
        <SecondaryButton title="Edit Goal" disabled={form.saving} onPress={openEdit} />
        <SecondaryButton title="Archive Goal" disabled={form.saving} onPress={archive} />
        {history.length === 0 && goal.initial_saved_minor === 0 ? <SecondaryButton title="Delete Empty Goal" disabled={form.saving} onPress={deleteGoal} /> : null}
      </>}
      <SectionHeader title="History" />
      {history
        .map((entry) => (
          <ListRow
            key={entry.id}
            card
            icon={entry.type === 'WITHDRAW' ? 'remove-circle-outline' : entry.type === 'ADJUSTMENT' ? 'options-outline' : 'add-circle-outline'}
            iconTone={entry.type === 'WITHDRAW' ? 'negative' : entry.type === 'ADJUSTMENT' ? 'neutral' : 'positive'}
            title={entry.type === 'WITHDRAW' ? 'Withdrawn' : 'Added'}
            subtitle={`${displayDate(entry.occurred_on)}${entry.note ? ` · ${entry.note}` : ''}`}
            right={
              <MoneyText
                amount={
                  entry.type === 'WITHDRAW'
                    ? -entry.amount_minor
                    : entry.amount_minor
                }
                type={entry.type === 'WITHDRAW' ? 'negative' : 'positive'}
              />
            }
          />
        ))}
      </CurrencyProvider>
    </FormScreen>
  );
}

function OnboardingScreen() {
  const { db, repo, refresh } = useAppData();
  const alert = useThemedAlert();
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState(defaultCurrency());
  const [cash, setCash] = useState('');
  const [budget, setBudget] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  async function start() {
    if (savingRef.current) return;
    if (!db) return alert('Setup unavailable', 'Please try again.');
    const validation = validateSetupInput({
      name,
      currency,
      startingCash: cash,
      monthlyPlan: budget,
    });
    if (!validation.ok) return alert('Check setup', validation.message);
    savingRef.current = true;
    setSaving(true);
    try {
      await repo.completeSetup(db, { name, currency, startingCash: cash, monthlyPlan: budget });
      await refresh();
    } catch {
      alert('Setup could not finish', 'Please try again.');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  return (
    <KeyboardAvoidingView
      enabled={Platform.OS === 'ios'}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
      <Screen>
        <KeyboardSafeScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.formContent}
        >
          <AppHeader title="Setup" />
          <Text style={[styles.muted, styles.setupIntro]}>
            Let&apos;s set up the basics. You can change these later in Settings.
          </Text>
          {/* Every section: title, one helper line, then the field — same spacing throughout. */}
          <SetupSection title="Your name" helper="Used to personalize the app.">
            <TextField
              placeholder="Your name"
              value={name}
              onChangeText={setName}
            />
          </SetupSection>
          <SetupSection title="Currency" helper="Choose how money is displayed.">
            <SelectField
              label="Currency"
              showLabel={false}
              value={currencyRows.find(([id]) => id === currency)?.[1] ?? currency}
              rows={currencyRows}
              onSelect={setCurrency}
            />
          </SetupSection>
          <SetupSection title="Starting cash balance" helper="How much physical cash do you have right now? This becomes the opening balance of your Cash account.">
            <TextField
              placeholder="e.g. 15,000"
              value={cash}
              onChangeText={setCash}
              keyboardType="decimal-pad"
            />
          </SetupSection>
          <SetupSection title="Monthly spending plan" helper="How much do you want to spend this month? You can change this later.">
            <TextField
              placeholder="e.g. 50,000"
              value={budget}
              onChangeText={setBudget}
              keyboardType="decimal-pad"
            />
          </SetupSection>
          <PrimaryButton title="Start" onPress={start} disabled={saving || !validateSetupInput({ name, currency, startingCash: cash, monthlyPlan: budget }).ok} />
        </KeyboardSafeScrollView>
      </Screen>
    </KeyboardAvoidingView>
  );
}

function SetupSection({ title, helper, children }: { title: string; helper: string; children: ReactNode }) {
  return <View style={styles.setupSection}>
    <Text style={styles.setupTitle}>{title}</Text>
    <Text style={styles.setupHelper}>{helper}</Text>
    {children}
  </View>;
}

export function getHomeGreeting(date = new Date()) {
  const hour = date.getHours();
  return hour >= 5 && hour < 12
    ? 'Good morning'
    : hour >= 12 && hour < 17
      ? 'Good afternoon'
      : 'Good evening';
}

export function getHomeGreetingCopy(date = new Date(), name?: string | null) {
  const greeting = getHomeGreeting(date);
  const cleanName = name?.trim();
  return {
    primary: cleanName ? `${greeting}, ${cleanName}` : greeting,
    secondary:
      greeting === 'Good morning'
        ? 'A fresh look at your finances.'
        : greeting === 'Good afternoon'
          ? 'Here’s how your day is looking.'
          : 'A quick look at today.',
  };
}

export function HomeScreen({ navigation }: any) {
  const { db, settings, transactions, entries, groups, currentDateKey = todayLocal() } = useAppData();
  // The spending card shows one currency at a time; the switch appears only with several.
  const scoped = useCurrencyData();
  const { currencies } = useCurrencyInfo();
  const fmtMoney = useMoneyFormat();
  const fmt = (amountMinor: number) => fmtMoney(amountMinor, scoped.currency);
  const [modal, setModal] = useState(false);
  const [recent, setRecent] = useState<ActivityRow[]>([]);
  const [hasRecentSnapshot, setHasRecentSnapshot] = useState(false);
  const hasRecentSnapshotRef = useRef(false);
  const [recentError, setRecentError] = useState(false);
  const [recentLoading, setRecentLoading] = useState(true);
  const [recentRetry, setRecentRetry] = useState(0);
  const currentMonth = monthKey(currentDateKey);
  const spent = getMonthlyExpenseTotal(scoped.transactions, currentMonth);
  const totalBudget = scoped.budgets.find((b) => !b.category_id)?.amount_minor ?? 0;
  const usage = getBudgetUsagePercentage(totalBudget, spent);
  const allowance = getDailyAllowanceState(totalBudget || null, spent, currentMonth, currentDateKey);
  // Enough rows for tall screens; ResponsivePreview shows only the whole cards that fit.
  const recentLimit = 8;
  // Same saved order as the Transactions tab's sort button.
  const recentOrder = activityOrderSetting(settings?.activity_sort_order);
  const greeting = getHomeGreetingCopy(new Date(), settings?.user_name);
  useEffect(() => {
    if (!db) return;
    let active = true;
    if (!hasRecentSnapshotRef.current) setRecentLoading(true);
    setRecentError(false);
    listActivity(db, { type: 'ALL', range: 'ALL', limit: recentLimit, order: recentOrder })
      .then((rows) => {
        if (active) {
          setRecent(rows);
          hasRecentSnapshotRef.current = true;
          setHasRecentSnapshot(true);
        }
      })
      .catch(() => { if (active) setRecentError(true); })
      .finally(() => { if (active) setRecentLoading(false); });
    return () => { active = false; };
  }, [db, transactions, entries, groups, recentLimit, recentRetry, recentOrder]);
  return (
    <Screen>
      <AppHeader title={greeting.primary} />
      <ReminderIntroduction />
      <Text style={styles.homeGreetingSubtitle}>{greeting.secondary}</Text>
      <CurrencySwitch />
      <CurrencyProvider currency={scoped.currency}>
      <Card>
         <View style={styles.rowBetween}>
          <View>
            <Text style={styles.muted}>Spent</Text>
            <MoneyText amount={spent} />
          </View>
          <View>
            <Text style={styles.muted}>Spending Plan</Text>
            <MoneyText amount={totalBudget} />
          </View>
        </View>
        <ProgressBar value={usage} over={totalBudget > 0 && spent > totalBudget} />
        <View style={styles.rowBetween}>
          <Text style={styles.muted}>{totalBudget > 0 || currencies.length < 2 ? `${usage}% used` : ''}</Text>
          {/* Same wording as the Spending Plan screen: "Rs. X over" once the plan is exceeded. */}
          <Text style={totalBudget > 0 && spent > totalBudget ? styles.homeOver : styles.muted}>
            {totalBudget > 0 && spent > totalBudget ? `${fmt(spent - totalBudget)} over` : totalBudget > 0 || currencies.length < 2 ? `${fmt(getBudgetRemaining(totalBudget, spent))} left` : 'No Spending Plan yet'}
          </Text>
         </View>
         {allowance.kind === 'available' ? <Text style={styles.muted}>About {fmt(allowance.allowanceMinor)}/day available</Text> : null}
       </Card>
      </CurrencyProvider>
      {/* Raised Material 3 buttons: Add is the main action, Split a lighter tonal one. */}
      <View style={styles.homeActions}>
        <PressableScale accessibilityRole="button" accessibilityLabel="Add transaction" onPress={() => setModal(true)} android_ripple={{ color: colors.secondary }} containerStyle={[styles.homeActionOuter, elevation.level3]} style={styles.homeActionAdd}>
          <Ionicons name="add" size={22} color={colors.surface} />
          <Text style={styles.homeActionAddText}>Add</Text>
        </PressableScale>
        <PressableScale accessibilityRole="button" accessibilityLabel="Split an expense" onPress={() => navigation.navigate('Split')} android_ripple={{ color: '#C9D9CF' }} containerStyle={[styles.homeActionOuter, elevation.level1]} style={styles.homeActionSplit}>
          <Ionicons name="people-outline" size={20} color={tones.onPrimaryContainer} />
          <Text style={styles.homeActionSplitText}>Split</Text>
        </PressableScale>
      </View>
       <View style={styles.rowBetween}>
          <Text style={[styles.homeQuickTitle, { marginTop: spacing.sm, marginBottom: spacing.sm }]}>Recent Activity</Text>
         <Pressable accessibilityRole="button" accessibilityLabel="View all activity" onPress={() => navigation.navigate('Transactions')} style={styles.homeActivityLink}>
           <Text style={styles.homeActivityLinkText}>View all</Text>
         </Pressable>
       </View>
       {!hasRecentSnapshot && recentLoading ? <EmptyState title="Loading recent activity..." /> : !hasRecentSnapshot && recentError ? <><EmptyState title="Recent activity is unavailable." subtitle="Try again to see your latest activity." /><SecondaryButton title="Retry recent activity" onPress={() => setRecentRetry((value) => value + 1)} /></> : recent.length ? (
         <ResponsivePreview max={recentLimit}>{recent.map((activity) => (
           <ListRow
             key={activity.id}
             preview
             card
             icon={activityIcon(activity).name}
             iconTone={activityIcon(activity).tone}
             title={activity.title}
             onPress={() => navigation.navigate('ActivityDetail', { kind: activity.kind, sourceId: activity.source_id })}
                subtitle={activitySubtitle(activity, displayDate(activity.occurred_on))}
             right={
               <MoneyText
                 amount={activity.amount_minor}
                 currency={activity.currency}
                 type={
                   activity.type === 'EXPENSE'
                     ? 'negative'
                     : activity.type === 'INCOME'
                      ? 'positive'
                      : 'neutral'
                }
              />
            }
          />
         ))}</ResponsivePreview>
      ) : (
        <EmptyState
           title="No activity yet."
           subtitle="Add an expense, income, People movement, or split to get started."
         />
       )}
       {hasRecentSnapshot && recentError ? <View accessibilityRole="alert"><Text style={styles.muted}>Could not refresh recent activity. Showing the last update.</Text><SecondaryButton title="Retry recent activity" onPress={() => setRecentRetry((value) => value + 1)} /></View> : null}
      <AddModal
        visible={modal}
        close={() => setModal(false)}
        navigation={navigation}
      />
    </Screen>
  );
}

function AddModal({ visible, close, navigation }: any) {
  const open = (type: string) => {
    close();
    navigation.navigate('TransactionForm', { type: type.toUpperCase() });
  };
  return (
    <Modal transparent visible={visible} animationType="fade">
      <Pressable style={styles.overlay} onPress={close}>
        <Card style={styles.sheet}>
           <ListRow icon="arrow-up-outline" iconTone="negative" title="Expense" onPress={() => open('Expense')} />
           <ListRow icon="arrow-down-outline" iconTone="positive" title="Income" onPress={() => open('Income')} />
        </Card>
      </Pressable>
    </Modal>
  );
}

export function TransactionFormScreen({ navigation, route }: any) {
  const { db, repo, accounts, categories, transactions, refresh, settings, people } = useAppData();
  const alert = useThemedAlert();
  const { confirm } = useAppDialog();
  const { currencies, mainCurrency } = useCurrencyInfo();
  const accountLabel = useAccountLabel();
  const moneyLabel = useMoneyLabel();
  const original = route.params?.transaction as Transaction | undefined;
  const type = (original?.type ?? route.params?.type ?? 'EXPENSE') as TransactionType;
  const [amount, setAmount] = useState(original ? String(original.amount_minor / 100) : '');
  const [received, setReceived] = useState(original?.destination_amount_minor ? String(original.destination_amount_minor / 100) : '');
  const [title, setTitle] = useState(original?.title ?? '');
  const [date, setDate] = useState(original ? dateKeyToInputDate(original.occurred_on) : '');
  const [note, setNote] = useState(original?.note ?? '');
  const initialAccount = original?.account_id ?? route.params?.accountId ?? defaultAccountId(accounts, settings);
  const initialDest = original?.destination_account_id ?? accounts.find((item) => item.id !== initialAccount)?.id;
  const [account, setAccount] = useState(initialAccount);
  const [dest, setDest] = useState(initialDest);
  const categoryType = type === 'INCOME' ? 'INCOME' : 'EXPENSE';
  const cats = categories.filter((c) => c.type === categoryType && !c.is_archived);
  const categoryChoices = original?.category_id && !cats.some((category) => category.id === original.category_id)
    ? [...cats, ...categories.filter((category) => category.id === original.category_id)]
    : cats;
  const [cat, setCat] = useState(original?.category_id ?? cats[0]?.id);
  // A new expense can be paid by another person: it becomes your spending and
  // changes what you and that person owe each other. No account money moves.
  const payerChoices = !original && type === 'EXPENSE' ? (people ?? []).filter((person) => !person.is_archived) : [];
  const [paidBy, setPaidBy] = useState('SELF');
  const payer = paidBy === 'SELF' ? undefined : payerChoices.find((person) => person.id === paidBy);
  const [billCurrency, setBillCurrency] = useState(() => accounts.find((item) => item.id === initialAccount)?.currency ?? mainCurrency);
  const recordAccount = (() => {
    const preferred = defaultAccountId(accounts.filter((item) => !item.is_archived), settings);
    return (accounts.find((item) => item.id === preferred && item.currency === billCurrency) ?? accounts.find((item) => item.currency === billCurrency && !item.is_archived))?.id;
  })();
  const payerBalance = payer?.balances?.find((row) => row.currency === billCurrency)?.amountMinor ?? 0;
  const payerNextBalance = payerBalance - (moneyToMinorUnits(amount) || 0);
  const suggestion = type === 'TRANSFER' ? null : suggestCategory(categories, transactions, categoryType, title, note);
  const form = useSubmitGuard(refresh);
  const confirmOutflow = useConfirmOutflow();
  const confirmChange = useConfirmActivityChange();
  // A move between accounts in different currencies records what left and exactly what arrived.
  const fromCurrency = accounts.find((item) => item.id === account)?.currency;
  const toCurrency = accounts.find((item) => item.id === dest)?.currency;
  const exchange = type === 'TRANSFER' && !!fromCurrency && !!toCurrency && fromCurrency !== toCurrency;
  const sentMinor = moneyToMinorUnits(amount);
  const receivedMinor = moneyToMinorUnits(received);
  const amountCurrency = payer ? billCurrency : fromCurrency;
  const rate = exchange && sentMinor && receivedMinor && sentMinor > 0 && receivedMinor > 0 ? exchangeRateText(fromCurrency, toCurrency, sentMinor, receivedMinor) : '';
  const [baseline] = useState(JSON.stringify([amount, title, date, note, account, dest, cat, received]));
  const dirty = useDirtyForm(original ? JSON.stringify([amount, title, date, note, account, dest, cat, received]) !== baseline : !!(amount.trim() || received.trim() || title.trim() || note.trim() || (date && date !== dateKeyToInputDate()) || account !== initialAccount || dest !== initialDest || cat !== cats[0]?.id || paidBy !== 'SELF'), form.isSaving);
  const save = () => form.submit(async () => {
    try {
    if (!db || !account) return;
    const minor = moneyToMinorUnits(amount);
    const dateKey = inputDateToDateKey(date);
    if (!minor || minor <= 0)
      return alert(
        'Invalid amount',
        'Please enter an amount greater than zero.',
      );
    if (!dateKey)
      return alert(
        'Invalid date',
        'Use DD-MM-YYYY, for example 09-09-2026.',
      );
    if (type === 'TRANSFER' && (!dest || dest === account))
      return alert('Invalid transfer', 'Choose different accounts.');
    const receivedValue = exchange ? moneyToMinorUnits(received) : null;
    if (exchange && (!receivedValue || receivedValue <= 0))
      return alert('Amount received needed', 'Enter exactly how much arrived, after any exchange fee.');
    if (type !== 'TRANSFER' && !cat)
      return alert('Category required', 'Choose a category.');
    if (paidBy !== 'SELF') {
      if (!payer) return alert('Choose who paid', 'This person is no longer available.');
      if (!recordAccount) return alert('No account in this currency', 'Add an account in this currency first.');
      const shared = paidByPersonExpenseInput({ personId: payer.id, personName: payer.name, amountMinor: minor, categoryId: cat!, accountId: recordAccount, title: title.trim() || 'Expense', occurredOn: dateKey });
      const plan = await previewSharedExpensePosting(db, shared);
      const crossingConfirmations: Record<string, number> = {};
      for (const crossing of plan.crossings ?? []) {
        if (!await confirm({ title: 'Balance will cross zero', message: `${payer.name}: ${crossing.nextBalanceMinor > 0 ? `${payer.name} will owe you` : `You will owe ${payer.name}`} ${formatMoney(Math.abs(crossing.nextBalanceMinor), billCurrency)} after this expense. Continue?`, confirmText: 'Continue', cancelText: 'Go Back' })) return;
        crossingConfirmations[crossing.personId] = crossing.balanceBeforeMinor;
      }
      await saveSharedExpensePosting(db, { ...shared, crossingConfirmations });
      await form.saved('Expense saved', () => dirty.leave(() => navigation.goBack()), true);
      return;
    }
    const input = {
      type,
      amount_minor: minor,
      account_id: account,
      destination_account_id: type === 'TRANSFER' ? dest : null,
      destination_amount_minor: receivedValue,
      category_id: type === 'TRANSFER' ? null : cat,
      title: title.trim() || (exchange ? 'Currency exchange' : type[0] + type.slice(1).toLowerCase()),
      note,
      occurred_on: dateKey,
      source: 'MANUAL' as const,
    };
    if (original) {
      if (!await confirmChange([original], [], [{ ...original, ...input }], [])) return;
      const id = await updateTransaction(db, original.id, original.updated_at, input);
      await form.saved('Activity updated', () => dirty.leave(() => navigation.popTo('ActivityDetail', { kind: 'transaction', sourceId: id })), true);
      return;
    }
    if (type !== 'INCOME' && !await confirmOutflow(account, minor)) return;
    await repo.saveTransaction(db, input);
    await form.saved(type === 'INCOME' ? 'Income saved' : type === 'TRANSFER' ? 'Money moved' : 'Expense saved', () => dirty.leave(() => navigation.goBack()), true);
    } catch (error) { alert('Could not save', error instanceof Error ? error.message : 'Your input has been kept. Please try again.'); }
  });
  return (
    <FormScreen
      title={
        original ? 'Edit Activity' : type === 'TRANSFER'
          ? 'Transfer'
          : type === 'INCOME'
            ? 'Add Income'
            : 'Add Expense'
      }
    >
      <TextField
        label={moneyLabel(exchange ? 'Amount sent' : 'Amount', amountCurrency)}
        placeholder="0"
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
      />
      {payerChoices.length ? (
        <Picker
          label="Paid by"
          info="If someone else paid for you, it still counts as your spending, no money leaves your accounts, and the amount is added to what you owe them."
          value={paidBy}
          setValue={setPaidBy}
          rows={[['SELF', 'You'], ...payerChoices.map((person) => [person.id, person.name])]}
        />
      ) : null}
      {payer ? (
        <>
          {currencies.length > 1 ? (
            <Picker
              label="Bill currency"
              info="Choose the currency of the bill. The balance with this person uses it; nothing is converted."
              value={billCurrency}
              setValue={setBillCurrency}
              rows={currencyRows.filter(([code]) => currencies.includes(code))}
            />
          ) : null}
          <Card style={styles.paidByCard}>
            <Text style={styles.muted}>No money leaves your accounts.</Text>
            <Text style={styles.muted}>Now: {balanceStatus(payerBalance, payer.name)}{payerBalance ? ` ${formatMoney(Math.abs(payerBalance), billCurrency)}` : ''}</Text>
            <Text style={styles.paidByAfter}>After this: {balanceStatus(payerNextBalance, payer.name)}{payerNextBalance ? ` ${formatMoney(Math.abs(payerNextBalance), billCurrency)}` : ''}</Text>
          </Card>
        </>
      ) : (
        <Picker
          label="Account"
          value={account}
          setValue={setAccount}
          rows={accounts.map((a) => [a.id, accountLabel(a)])}
        />
      )}
      {type === 'TRANSFER' ? (
        <>
          <Picker
            label="To Account"
            value={dest}
            setValue={setDest}
            rows={accounts.map((a) => [a.id, accountLabel(a)])}
          />
          {exchange && toCurrency ? <>
            <TextField
              label={`Amount received (${currencySymbol(toCurrency)})`}
              info="Exactly what arrived after any exchange fee. Nothing is converted for you; this is not spending or income."
              placeholder="After any exchange fee"
              value={received}
              onChangeText={setReceived}
              keyboardType="decimal-pad"
            />
            {rate ? <Text style={styles.muted}>{rate}</Text> : null}
          </> : null}
        </>
      ) : (
        <>
          <Picker
            label="Category"
            value={cat}
            setValue={setCat}
            rows={categoryRows(categoryChoices, (c) => c.is_archived ? `${c.name} (archived)` : c.name)}
          />
          {suggestion && suggestion.id !== cat ? <View style={styles.suggestion}><Text style={styles.muted}>Suggested category: {suggestion.name}</Text><SecondaryButton title="Use suggestion" onPress={() => setCat(suggestion.id)} /></View> : null}
        </>
      )}
      <TextField
        label="Description"
        placeholder="Dinner, fuel, salary..."
        value={title}
        onChangeText={setTitle}
      />
      <TextField
        label="Date"
        placeholder="DD-MM-YYYY"
        value={date}
        onChangeText={setDate}
      />
      {payer ? null : (
        <TextField
          label="Note optional"
          placeholder="Optional"
          value={note}
          onChangeText={setNote}
        />
      )}
      <PrimaryButton title="Save" onPress={save} saving={form.saving} disabled={!validMoneyInput(amount) || (exchange && !validMoneyInput(received)) || !inputDateToDateKey(date) || !account || (!!payer && !recordAccount) || (type === 'TRANSFER' ? !dest || dest === account : !cat) || !!(original && moneyToMinorUnits(amount) === original.amount_minor && title.trim() === original.title && note.trim() === (original.note ?? '') && inputDateToDateKey(date) === original.occurred_on && account === original.account_id && (type === 'TRANSFER' ? dest === original.destination_account_id && (!exchange || moneyToMinorUnits(received) === original.destination_amount_minor) : cat === original.category_id))} />
    </FormScreen>
  );
}

export function BudgetScreen() {
  const { db, repo, categories, refresh, settings } = useAppData();
  // Each currency has its own plan, measured only against spending in that currency.
  const { currency, transactions, budgets } = useCurrencyData();
  const alert = useThemedAlert();
  const { confirm } = useAppDialog();
  const fmtMoney = useMoneyFormat();
  const fmt = (amountMinor: number) => fmtMoney(amountMinor, currency);
  const today = todayLocal();
  const currentMonth = monthKey(today);
  const nextMonth = shiftMonthKey(currentMonth, 1);
  const [selectedMonth, setSelectedMonth] = useState(currentMonth);
  const [allPlanRows, setPlanRows] = useState<Budget[]>(budgets);
  const planRows = allPlanRows.filter((budget) => budget.currency === currency);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [previousMonth, setPreviousMonth] = useState<string | null>(null);
  const [followingMonth, setFollowingMonth] = useState<string | null>(nextMonth);
  useEffect(() => {
    let active = true;
    setPreviousMonth(null);
    setFollowingMonth(null);
    if (db) void planMonthNavigation(db, selectedMonth, currentMonth, transactions).then((months) => { if (active) { setPreviousMonth(months.previous); setFollowingMonth(months.next); } }).catch(() => {});
    return () => { active = false; };
  }, [db, selectedMonth, currentMonth, transactions, budgets]);
  const [amount, setAmount] = useState(() => minorUnitsToMoney(budgets.find((budget) => !budget.category_id)?.amount_minor ?? 0).replace(/^0$/, ''));
  const [amountBaseline, setAmountBaseline] = useState(amount);
  // The plan the amount field was filled from: a month in one currency.
  const planKey = `${selectedMonth}|${currency}`;
  const [amountMonth, setAmountMonth] = useState(planKey);
  const [categoryId, setCategoryId] = useState('');
  const [categoryAmount, setCategoryAmount] = useState('');
  const [editingBudget, setEditingBudget] = useState<Budget | null>(null);

  const reloadPlan = async () => {
    await refresh();
    if (db) setPlanRows(await repo.listBudgets(db, selectedMonth));
  };
  const form = useSubmitGuard(reloadPlan);
  const planReadGeneration = useRef(0);
  const applyLoadedPlan = useEffectEvent((rows: Budget[], month: string) => {
    if (month !== selectedMonth) return;
    setPlanRows(rows);
    if (amountMonth !== planKey || amount === amountBaseline) {
      const next = rows.find((budget) => !budget.category_id && budget.currency === currency)?.amount_minor;
      const value = next == null ? '' : minorUnitsToMoney(next);
      setAmount(value); setAmountBaseline(value); setAmountMonth(planKey);
    }
  });
  const loadSelectedPlan = useEffectEvent(async () => {
    if (!db) return;
    const generation = ++planReadGeneration.current;
    setLoadingPlan(true);
    try {
      const rows = await repo.listBudgets(db, selectedMonth);
      if (generation === planReadGeneration.current) applyLoadedPlan(rows, selectedMonth);
    }
    catch { if (generation === planReadGeneration.current) alert('Could not load Spending Plan', 'Return to this screen and try again.'); }
    finally { if (generation === planReadGeneration.current) setLoadingPlan(false); }
  });
  useEffect(() => { loadSelectedPlan(); }, [db, selectedMonth, budgets, currency]);
  useDirtyForm(amount !== amountBaseline || !!categoryAmount.trim(), form.isSaving);

  const totalBudget = planRows.find((budget) => !budget.category_id);
  const categoryBudgets = planRows.filter((budget) => budget.category_id);
  const spent = getMonthlyExpenseTotal(transactions, selectedMonth);
  const remaining = totalBudget ? getBudgetRemaining(totalBudget.amount_minor, spent) : null;
  const usage = totalBudget ? getBudgetUsagePercentage(totalBudget.amount_minor, spent) : 0;
  const limitState = getBudgetLimitState(usage, normalizeBudgetThreshold(settings?.budget_alert_threshold));
  const daily = getDailyAllowanceState(totalBudget?.amount_minor ?? null, spent, selectedMonth, today);
  const allocated = categoryBudgets.reduce((sum, budget) => sum + budget.amount_minor, 0);
  const unallocated = totalBudget ? totalBudget.amount_minor - allocated : null;
  const selectableCategories = categories.filter((category) =>
    category.type === 'EXPENSE' && !category.is_archived &&
    (!categoryBudgets.some((budget) => budget.category_id === category.id) || editingBudget?.category_id === category.id));
  const suggestion = categoryId
    ? getThreeMonthCategorySuggestion(transactions, categoryId, selectedMonth, today)
    : null;

  const saveMonthly = () => form.submit(async () => {
    if (!db) return;
    const minor = moneyToMinorUnits(amount);
    if (!minor || minor <= 0) return alert('Invalid budget', 'Enter an amount greater than zero.');
    await repo.saveBudget(db, { month_key: selectedMonth, amount_minor: minor, currency });
    await form.saved('Spending Plan updated', () => { const value = minorUnitsToMoney(minor); setAmount(value); setAmountBaseline(value); });
  });

  const saveCategory = () => form.submit(async () => {
    if (!db || !categoryId) return alert('Category required', 'Choose an expense category.');
    const minor = moneyToMinorUnits(categoryAmount);
    if (!minor || minor <= 0) return alert('Invalid budget', 'Enter an amount greater than zero.');
    if (editingBudget)
      await updateCategoryBudget(db, { id: editingBudget.id, expectedUpdatedAt: editingBudget.updated_at, amountMinor: minor });
    else await createCategoryBudget(db, { month: selectedMonth, categoryId, amountMinor: minor, currency });
    await form.saved(editingBudget ? 'Category budget updated' : 'Category budget added', () => {
      setCategoryId(''); setCategoryAmount(''); setEditingBudget(null);
    });
  });

  const startEdit = (budget: Budget) => {
    setEditingBudget(budget);
    setCategoryId(budget.category_id!);
    setCategoryAmount(String(budget.amount_minor / 100));
  };

  const removeSelectedCategory = () => form.submit(async () => {
    if (!db || !editingBudget) return;
    const category = categories.find((row) => row.id === editingBudget.category_id);
    if (!await confirm({
      title: 'Remove category budget?',
      message: `This removes ${category?.name ?? 'this category'} from ${displayMonthYear(`${selectedMonth}-01`)}. Transactions and the category stay unchanged.`,
      destructive: true, cancelText: 'Cancel', confirmText: 'Remove',
    })) return;
    await removeCategoryBudget(db, editingBudget.id, editingBudget.updated_at);
    await form.saved('Category budget removed', () => { setCategoryId(''); setCategoryAmount(''); setEditingBudget(null); });
  });

  const copyPrevious = () => form.submit(async () => {
    if (!db) return;
    const preview = await previewCopyPreviousMonth(db, selectedMonth, currency);
    if (!preview.items.length)
      return alert('Previous month unavailable', `${displayMonthYear(`${preview.sourceMonth}-01`)} has no Spending Plan to copy.`);
    const copied = preview.items.filter((item) => item.status === 'copy').map((item) => `${item.label}: ${fmt(item.amountMinor)}`).join('\n');
    if (!preview.copyCount)
      return alert('Nothing to copy', `${displayMonthYear(`${preview.targetMonth}-01`)} already has everything available from ${displayMonthYear(`${preview.sourceMonth}-01`)}.`);
    const skipped = [preview.conflictCount ? `${preview.conflictCount} existing item(s) kept` : '', preview.archivedCount ? `${preview.archivedCount} archived category item(s) skipped` : ''].filter(Boolean).join('; ');
    if (!await confirm({
      title: 'Copy previous month?',
      message: `${copied}${skipped ? `\n\n${skipped}.` : ''}\n\nOnly plan amounts are copied. Spending and transactions are never copied.`,
      cancelText: 'Cancel', confirmText: 'Copy plan',
    })) return;
    await copyPreviousMonthPlan(db, selectedMonth, currency);
    await form.saved('Previous month plan copied', () => {});
  });

  const dailyText = daily.kind === 'available'
    ? `About ${fmt(daily.allowanceMinor)}/day available for the remaining ${daily.daysRemaining} day(s).`
    : daily.kind === 'overspent' ? `You are ${fmt(daily.overMinor)} over your Spending Plan. No daily allowance is available.`
    : daily.kind === 'exhausted' ? 'The Spending Plan is fully used. No daily allowance is available.'
    : daily.kind === 'historical' ? 'Daily allowance is not shown for a completed month.'
    : daily.kind === 'future' ? 'Daily allowance will appear when this month begins.'
    : 'Set a total Spending Plan to see a daily allowance.';

  return (
    <FormScreen title="Spending Plan">
      <CurrencySwitch />
      <CurrencyProvider currency={currency}>
      <View style={styles.planMonthNav}>
        <Pressable accessibilityRole="button" accessibilityLabel="Previous month" accessibilityState={{ disabled: !previousMonth }} disabled={!previousMonth} style={[styles.planMonthButton, !previousMonth && styles.planMonthButtonDisabled]} onPress={() => { if (previousMonth) setSelectedMonth(previousMonth); }}>
          <Ionicons name="chevron-back" size={20} color={previousMonth ? colors.primary : colors.muted} />
        </Pressable>
        <View style={styles.planMonthTitle}>
          <Text style={styles.sectionSmall}>{displayMonthYear(`${selectedMonth}-01`)}</Text>
          <Text style={styles.muted}>{selectedMonth === currentMonth ? 'Current month' : selectedMonth > currentMonth ? 'Future plan' : 'Past plan'}</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Next month" accessibilityState={{ disabled: !followingMonth }} disabled={!followingMonth} style={[styles.planMonthButton, !followingMonth && styles.planMonthButtonDisabled]} onPress={() => { if (followingMonth) setSelectedMonth(followingMonth); }}>
          <Ionicons name="chevron-forward" size={20} color={followingMonth ? colors.primary : colors.muted} />
        </Pressable>
      </View>
      {selectedMonth !== currentMonth ? <SecondaryButton title="Return to current month" onPress={() => setSelectedMonth(currentMonth)} /> : null}
      <Card>
        <Text style={styles.sectionSmall}>{displayMonthYear(`${selectedMonth}-01`)} Spending Plan</Text>
        {loadingPlan ? <Text style={styles.muted}>Loading this plan...</Text> : totalBudget ? (
          <>
            <Text>{fmt(spent)} spent of {fmt(totalBudget.amount_minor)}</Text>
            <ProgressBar value={usage} over={remaining! < 0} />
            <Text style={remaining! < 0 ? styles.warn : styles.muted}>{remaining! < 0 ? `${fmt(Math.abs(remaining!))} over` : `${fmt(remaining!)} remaining`}</Text>
            <Text style={styles.muted}>{dailyText}</Text>
            {remaining! < 0 ? <Text style={styles.warn}>You have spent more than this plan.</Text>
              : limitState === 'reached' ? <Text style={styles.warn}>You have reached your Spending Plan.</Text>
              : limitState === 'warning' ? <Text style={styles.warn}>You are nearing your Spending Plan.</Text> : null}
          </>
        ) : <EmptyState title="No Spending Plan" subtitle="Set a total below or copy the previous month. You can still add category allocations." />}
      </Card>
      <TextField label={totalBudget ? 'Edit Total Spending Plan' : 'Set Total Spending Plan'} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
      <PrimaryButton title="Save Spending Plan" onPress={saveMonthly} saving={form.saving} disabled={loadingPlan || !validMoneyInput(amount)} />
      <SecondaryButton title="Copy previous month" onPress={copyPrevious} disabled={form.saving} />

      <SectionHeader title="Category Budgets" />
      {!categoryBudgets.length ? <EmptyState title="No category allocations" subtitle="Add one below to plan how the total may be used." /> : null}
      {categoryBudgets.map((budget) => {
        const category = categories.find((row) => row.id === budget.category_id);
        const categorySpent = getCategoryExpenseTotal(transactions, selectedMonth, budget.category_id!);
        const categoryRemaining = budget.amount_minor - categorySpent;
        return <ListRow key={budget.id} card icon={categoryIcon(category)} iconTone={categoryRemaining < 0 ? 'negative' : 'neutral'} title={category?.name ?? 'Category'}
          subtitle={`Allocated ${fmt(budget.amount_minor)} | Spent ${fmt(categorySpent)} | ${categoryRemaining >= 0 ? `Remaining ${fmt(categoryRemaining)}` : `Over ${fmt(Math.abs(categoryRemaining))}`}${category?.is_archived ? ' | Archived category' : ''}`}
          right={<Text style={categoryRemaining < 0 ? styles.warn : undefined}>{getBudgetUsagePercentage(budget.amount_minor, categorySpent)}%</Text>}
          onPress={() => startEdit(budget)} />;
      })}
      {totalBudget && unallocated !== null ? (
        <Card><Text style={unallocated < 0 ? styles.warn : styles.body}>{unallocated < 0 ? `Category budgets are ${fmt(Math.abs(unallocated))} over-allocated.` : `${fmt(unallocated)} remains unallocated.`}</Text></Card>
      ) : null}
      <Picker label={editingBudget ? 'Category (editing)' : 'Category'} value={categoryId} setValue={setCategoryId}
        rows={(editingBudget && !selectableCategories.some((row) => row.id === editingBudget.category_id)
          ? [categories.find((row) => row.id === editingBudget.category_id)!].filter(Boolean)
          : selectableCategories).map((category) => [category.id, `${category.name}${category.is_archived ? ' (archived)' : ''}`, categoryIcon(category)])} />
      <TextField label={editingBudget ? 'Edit Category Budget Amount' : 'Category Budget Amount'} value={categoryAmount} onChangeText={setCategoryAmount} keyboardType="decimal-pad" />
      {categoryId && suggestion ? <Card>
        <Text style={styles.body}>Suggestion from recent spending</Text>
        {suggestion.hasHistory ? <>
          <Text style={styles.muted}>Your average personal spending across the previous 3 complete months was {fmt(suggestion.averageMinor)}.</Text>
          <SecondaryButton title={`Use ${fmt(suggestion.averageMinor)}`} onPress={() => setCategoryAmount(String(suggestion.averageMinor / 100))} />
        </> : <Text style={styles.muted}>No personal spending history is available for this category in the previous 3 complete months.</Text>}
      </Card> : null}
      <PrimaryButton title={editingBudget ? 'Update Category Budget' : 'Add Category Budget'} onPress={saveCategory} saving={form.saving} disabled={!categoryId || !validMoneyInput(categoryAmount)} />
      {editingBudget ? <>
        <SecondaryButton title="Cancel editing" onPress={() => { setEditingBudget(null); setCategoryId(''); setCategoryAmount(''); }} />
        <SecondaryButton title="Remove Category Budget" onPress={removeSelectedCategory} disabled={form.saving} />
      </> : null}
      </CurrencyProvider>
    </FormScreen>
  );
}

/** A row's tone and wording when a person may have balances in several currencies. */
function peopleTone(balances: Person['balances']): IconTone {
  if (!balances?.length) return 'neutral';
  if (balances.every((balance) => balance.amountMinor > 0)) return 'positive';
  if (balances.every((balance) => balance.amountMinor < 0)) return 'negative';
  return 'neutral';
}

/** A person's non-zero balances, main currency first (older data without them: the main balance). */
function balancesOf(person: Pick<Person, 'balances' | 'balance_minor'>, mainCurrency: string): NonNullable<Person['balances']> {
  return person.balances ?? (person.balance_minor ? [{ currency: mainCurrency, amountMinor: person.balance_minor }] : []);
}

function peopleRelationship(balances: Person['balances']): string {
  if (!balances?.length) return 'Settled';
  if (balances.every((balance) => balance.amountMinor > 0)) return 'They owe you';
  if (balances.every((balance) => balance.amountMinor < 0)) return 'You owe them';
  return 'Balances in both directions';
}

export function PeopleScreen({ navigation, route }: any) {
  const { people, allPeople, db, repo, refresh } = useAppData();
  const { mainCurrency } = useCurrencyInfo();
  const alert = useThemedAlert();
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [personPanelMounted, setPersonPanelMounted] = useState(false);
  const [mode, setMode] = useState<'People' | 'Groups'>('People');
  const [name, setName] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [personPanelProgress] = useState(() => new Animated.Value(0));
  const personNameInput = useRef<TextInput>(null);
  const form = useSubmitGuard(refresh);
  const pendingAction = route?.params?.action as VisiblePeopleAction | undefined;
  const dirty = useDirtyForm(adding && !!name.trim(), form.isSaving);
  function animatePersonPanel(open: boolean, onFinished?: () => void) {
    personPanelProgress.stopAnimation();
    Animated.timing(personPanelProgress, {
      toValue: open ? 1 : 0,
      duration: 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished) onFinished?.();
    });
  }
  function openPersonPanel() {
    setPersonPanelMounted(true);
    setAdding(true);
    animatePersonPanel(true);
  }
  function resetPerson() {
    Keyboard.dismiss();
    personNameInput.current?.blur();
    setName('');
    setAdding(false);
    animatePersonPanel(false, () => setPersonPanelMounted(false));
  }
  const add = () => form.submit(async () => {
    const cleanName = name.trim();
    if (!db || !cleanName)
      return alert('Name required', 'Enter a person name.');
    const duplicate = allPeople.find((p) => p.name.trim().toLowerCase() === cleanName.toLowerCase());
    if (duplicate)
      return alert(
        'Person already exists',
        duplicate.is_archived
          ? 'This name belongs to an archived person. Restore that person to use the same identity and history.'
          : `${cleanName} is already in your people list.`,
      );
    await repo.savePerson(db, cleanName);
    await form.saved('Person saved', resetPerson);
  });
  const rows = (showArchived && !pendingAction ? allPeople : people)
    .filter((p) => showArchived || !p.is_archived)
    .filter((p) => p.name.toLowerCase().includes(query.toLowerCase()))
    .sort(
      (a, b) =>
        Number(!!balancesOf(b, mainCurrency).length) -
          Number(!!balancesOf(a, mainCurrency).length) || a.name.localeCompare(b.name),
    );
  return (
    <Screen>
      <AppHeader title="People" />
      <View style={styles.quick}>
        {(['People', 'Groups'] as const).map((tab) => (
          <Pressable
            key={tab}
            accessibilityRole="tab"
            accessibilityState={{ selected: mode === tab }}
            onPress={() => tab !== mode && dirty.discard(() => { resetPerson(); setMode(tab); })}
            style={[styles.peopleTab, mode === tab && styles.peopleTabSelected]}
          >
            <Text style={[styles.peopleTabText, mode === tab && styles.peopleTabTextSelected]}>
              {tab}
            </Text>
          </Pressable>
        ))}
      </View>
      {personPanelMounted ? (
        <Animated.View
          accessibilityLabel="Add person panel"
          pointerEvents={adding ? 'auto' : 'none'}
          style={[
            styles.personAddPanel,
            {
              maxHeight: personPanelProgress.interpolate({ inputRange: [0, 1], outputRange: [0, 180] }),
              opacity: personPanelProgress,
              transform: [{ translateY: personPanelProgress.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] }) }],
            },
          ]}
        >
        <Card style={styles.personAddCard}>
           <TextField
            ref={personNameInput}
            label={mode === 'People' ? 'Person name' : 'Group name'}
            placeholder={mode === 'People' ? 'Name' : 'Murree Trip'}
            value={name}
            onChangeText={setName}
            autoFocus
          />
          <PrimaryButton
            title="Save Person"
            onPress={add}
            saving={form.saving}
            disabled={!name.trim()}
          />
        </Card>
        </Animated.View>
      ) : null}
      {mode === 'People' ? (
        <>
          <TextField
            placeholder="Search people..."
            value={query}
             onChangeText={setQuery}
           />
           {!pendingAction && allPeople.some((person) => person.is_archived) ? (
             <SecondaryButton
               title={showArchived ? 'Hide Archived People' : 'Show Archived People'}
               onPress={() => setShowArchived((value) => !value)}
             />
           ) : null}
          <FlatList
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.fabListPadding}
            data={rows}
            keyExtractor={(item) => item.id}
            ListEmptyComponent={
              <EmptyState
            title={query.trim() ? 'No matching people.' : 'No people yet.'}
                 subtitle="Add someone when you give, receive or split an expense."
              />
            }
            renderItem={({ item }) => (
              <ListRow
                card
                icon="person-outline"
                iconTone={peopleTone(balancesOf(item, mainCurrency))}
                title={item.name}
                 subtitle={
                   item.is_archived
                     ? 'Archived'
                     : peopleRelationship(balancesOf(item, mainCurrency))
                 }
                onPress={() => {
                  if (pendingAction && !item.is_archived) {
                    navigation.setParams({ action: undefined });
                    navigation.push('PersonEntryForm', { personId: item.id, action: pendingAction });
                  } else navigation.navigate('PersonDetail', { personId: item.id });
                }}
                right={
                  balancesOf(item, mainCurrency).length > 1 ? <View style={{ alignItems: 'flex-end' }}>
                    {balancesOf(item, mainCurrency).map((balance) => <MoneyText
                      key={balance.currency}
                      amount={balance.amountMinor}
                      currency={balance.currency}
                      type={balance.amountMinor > 0 ? 'positive' : 'negative'}
                    />)}
                  </View> : <MoneyText
                    amount={balancesOf(item, mainCurrency)[0]?.amountMinor ?? 0}
                    currency={balancesOf(item, mainCurrency)[0]?.currency}
                    type={(balancesOf(item, mainCurrency)[0]?.amountMinor ?? 0) > 0 ? 'positive' : (balancesOf(item, mainCurrency)[0]?.amountMinor ?? 0) < 0 ? 'negative' : 'neutral'}
                  />
                }
              />
            )}
          />
        </>
      ) : null}
      <GroupListPanel navigation={navigation} active={mode === 'Groups'} />
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={mode === 'Groups' ? 'Add group' : 'Add person'}
        onPress={() => mode === 'Groups' ? navigation.navigate('GroupEdit') : adding ? dirty.discard(resetPerson) : openPersonPanel()}
        android_ripple={{ color: colors.secondary }}
        scaleTo={0.92}
        containerStyle={styles.fab}
        style={styles.fabInner}
      >
        <Ionicons
          name={adding ? 'close' : 'add'}
          size={28}
          color={colors.surface}
        />
      </PressableScale>
    </Screen>
  );
}

export function PersonDetailScreen({ route, navigation }: any) {
  const { db, allPeople, entries, refresh } = useAppData();
  const { accountCurrency, mainCurrency } = useCurrencyInfo();
  const { confirm, showDialog } = useAppDialog();
  const form = useSubmitGuard(refresh);
  const fmtMoney = useMoneyFormat();
  const person = allPeople.find((p) => p.id === route.params.personId);
  const history = entries.filter((e) => e.person_id === person?.id);
  // Money in different currencies never cancels out: the summary and the
  // Give/Borrow/Settle buttons work in one currency; the switch shows only with several.
  const entryCurrency = (entry: PersonEntry) => accountCurrency.get(entry.account_id) ?? mainCurrency;
  const personCurrencies = orderCurrencies([mainCurrency, ...history.map(entryCurrency)], mainCurrency);
  const [chosenCurrency, setChosenCurrency] = useState<string | null>(null);
  const currency = chosenCurrency && personCurrencies.includes(chosenCurrency) ? chosenCurrency : (person ? balancesOf(person, mainCurrency)[0]?.currency : undefined) ?? mainCurrency;
  const fmt = (amountMinor: number) => fmtMoney(amountMinor, currency);
  const inCurrency = history.filter((entry) => entryCurrency(entry) === currency);
  const [scroll] = useState(() => new Animated.Value(0));
  const historyList = useRef<FlatList>(null);
  const [bodyHeight, setBodyHeight] = useState(0);
  const [summaryHeight, setSummaryHeight] = useState(0);
  const [controlsHeight, setControlsHeight] = useState(0);
  const [summaryCollapsed, setSummaryCollapsed] = useState(false);
  const [summaryInteractive, setSummaryInteractive] = useState(true);
  const offset = useRef(0);
  const snapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { fontScale } = useWindowDimensions();
  const { collapsible, distance, minContentHeight } = personHistoryLayout(bodyHeight, summaryHeight, controlsHeight, fontScale);
  const controlsTranslation = scroll.interpolate({ inputRange: [0, Math.max(1, distance)], outputRange: [0, -distance], extrapolate: 'clamp' });
  const clearSnapTimer = () => { if (snapTimer.current) { clearTimeout(snapTimer.current); snapTimer.current = null; } };
  const finishRest = (value: number) => { setSummaryCollapsed(value >= distance && distance > 0); setSummaryInteractive(true); };
  const snap = () => {
    clearSnapTimer();
    const target = personSnapOffset(offset.current, distance);
    if (target === null || Math.abs(target - offset.current) < 0.5) { finishRest(offset.current); return; }
    historyList.current?.scrollToOffset({ offset: target, animated: true });
  };
  const expand = () => { clearSnapTimer(); setSummaryInteractive(false); historyList.current?.scrollToOffset({ offset: 0, animated: true }); };
  useEffect(() => () => { if (snapTimer.current) clearTimeout(snapTimer.current); }, []);
  useEffect(() => { if (!collapsible) scroll.setValue(0); }, [collapsible, scroll]);
  if (!person)
    return (
      <Screen>
        <BackHeader title="Person" />
        <EmptyState title="Person not found." />
      </Screen>
    );
  const balance = balancesOf(person, mainCurrency).find((item) => item.currency === currency)?.amountMinor ?? 0;
  const archive = () => {
    if (!db || person.is_archived) return;
    const open = balancesOf(person, mainCurrency)[0];
    if (open) {
      const balance = open.amountMinor;
      const fmt = (amountMinor: number) => fmtMoney(amountMinor, open.currency);
      showDialog({
        title: 'Settle balance first',
        message: balance > 0
          ? `They still owe you ${fmt(Math.abs(balance))}. Settle this balance before archiving.`
          : `You still owe them ${fmt(Math.abs(balance))}. Settle this balance before archiving.`,
      });
      return;
    }
    void form.submit(async () => {
      if (!await confirm({
        title: 'Archive person?',
        message: 'They will be hidden from new entries. Historical records and group references will be kept.',
        destructive: true,
        cancelText: 'Cancel',
        confirmText: 'Archive',
      })) return;
      try {
        await archivePerson(db, person.id, person.updated_at);
        await form.saved('Person archived', () => {});
      } catch (reason) {
        const freshBalance = reason instanceof PersonArchiveError ? reason.balanceMinor : undefined;
        showDialog({
          title: 'Could not archive',
          message: freshBalance == null
            ? reason instanceof Error ? reason.message : 'Please reopen this person.'
            : freshBalance > 0
              ? `They still owe you ${fmtMoney(Math.abs(freshBalance), reason instanceof PersonArchiveError ? reason.currency : null)}. Settle this balance before archiving.`
              : `You still owe them ${fmtMoney(Math.abs(freshBalance), reason instanceof PersonArchiveError ? reason.currency : null)}. Settle this balance before archiving.`,
        });
      }
    });
  };
  const restore = () => {
    if (!db || !person.is_archived) return;
    void form.submit(async () => {
      try {
        await restorePerson(db, person.id, person.updated_at);
        await form.saved('Person restored', () => {});
      } catch (reason) {
        showDialog({
          title: 'Could not restore',
          message: reason instanceof Error && reason.message === 'PERSON_NAME_EXISTS'
            ? 'An active person now uses this name. Rename that person before restoring this history.'
            : reason instanceof Error ? reason.message : 'Please reopen this person and try again.',
        });
      }
    });
  };
  const given = inCurrency
    .filter((e) => personEntryDelta(e.type, e.amount_minor) > 0)
    .reduce((s, e) => s + e.amount_minor, 0);
  const received = inCurrency
    .filter((e) => personEntryDelta(e.type, e.amount_minor) < 0)
    .reduce((s, e) => s + e.amount_minor, 0);
  return (
    <Screen>
      <BackHeader title={person.name} />
      {/* Stays above the scrolling history, so the summary and its buttons keep their positions. */}
      <CurrencySwitch options={personCurrencies} value={currency} onChange={setChosenCurrency} />
      <View testID="person-history-viewport" style={{ flex: 1, overflow: 'hidden' }} onLayout={(event) => setBodyHeight(event.nativeEvent.layout.height)}>
      <Animated.FlatList
        ref={historyList}
        contentContainerStyle={{ minHeight: minContentHeight, paddingBottom: spacing.md }}
        ListHeaderComponent={<View>
          <PersonSummary name={person.name} note={person.note} balance={balance} amount={fmt(Math.abs(balance))} given={fmt(given)} received={fmt(received)} archived={!!person.is_archived} disabled={form.saving} onArchive={archive} onEdit={() => navigation.navigate('PersonEdit', { personId: person.id })} scroll={scroll} collapsible={collapsible} collapsed={summaryCollapsed} interactive={summaryInteractive} onExpandedHeight={setSummaryHeight} onExpand={expand} />
          <View style={{ height: controlsHeight }} />
        </View>}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scroll } } }], { useNativeDriver: true })}
        onScrollBeginDrag={() => { clearSnapTimer(); setSummaryInteractive(false); }}
        onScrollEndDrag={(event) => { offset.current = Math.max(0, event.nativeEvent.contentOffset.y); clearSnapTimer(); snapTimer.current = setTimeout(snap, 80); }}
        onMomentumScrollBegin={clearSnapTimer}
        onMomentumScrollEnd={(event) => { offset.current = Math.max(0, event.nativeEvent.contentOffset.y); snap(); }}
        scrollEventThrottle={16}
        removeClippedSubviews={false}
        showsVerticalScrollIndicator={false}
        data={history}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={<EmptyState title="No entries yet." />}
        renderItem={({ item }) => <ListRow card icon="person-outline" title={item.title} onPress={() => navigation.navigate('ActivityDetail', { kind: 'person', sourceId: item.id })} subtitle={`${peopleEntryDisplayLabel(item.type)} · ${person.name} · ${displayDate(item.occurred_on)}`} right={<MoneyText currency={entryCurrency(item)} amount={personEntryDelta(item.type, item.amount_minor)} type={personEntryDelta(item.type, item.amount_minor) >= 0 ? 'positive' : 'negative'} />} />}
      />
      {/* Starts one gap higher (over the summary's empty bottom margin), so once collapsed it meets the name bar and no history shows between them. */}
      <Animated.View pointerEvents="box-none" style={{ position: 'absolute', top: Math.max(0, summaryHeight - spacing.sm), paddingTop: spacing.sm, left: 0, right: 0, backgroundColor: colors.background, transform: [{ translateY: controlsTranslation }] }}>
      <View testID="person-history-controls" onLayout={(event) => setControlsHeight(event.nativeEvent.layout.height)}>
      {!person.is_archived ? <>
      <View style={styles.personActionRow}>
        <View style={styles.personActionCell}><SecondaryButton
          compact
          title={peopleActionLabel(balance, 'GIVE')}
          onPress={() =>
            navigation.push('PersonEntryForm', {
              personId: person.id,
              action: 'GIVE',
              currency,
            })
          }
        /></View>
        {balance !== 0 ? <View style={styles.personActionCell}><PrimaryButton compact title="Settle" disabled={form.saving} onPress={() => navigation.push('PersonEntryForm', { personId: person.id, action: balance > 0 ? 'BORROW' : 'GIVE', settlement: true, currency, amountMinor: Math.abs(balance), expectedBalanceMinor: balance })} /></View> : null}
        <View style={styles.personActionCell}><SecondaryButton
          compact
          title={peopleActionLabel(balance, 'BORROW')}
          onPress={() =>
            navigation.push('PersonEntryForm', {
              personId: person.id,
              action: 'BORROW',
              currency,
            })
          }
        /></View>
      </View>
       </> : <Card><Text style={styles.muted}>Archived people remain available in historical records and groups.</Text><SecondaryButton title="Restore Person" disabled={form.saving} onPress={restore} /></Card>}
      <SectionHeader title="History" />
      </View>
      </Animated.View>
      {collapsible ? <PersonCapsule name={person.name} balance={balance} amount={fmt(Math.abs(balance))} scroll={scroll} distance={distance} collapsed={summaryCollapsed} interactive={summaryInteractive} onExpand={expand} /> : null}
      </View>
    </Screen>
  );
}

export function PersonEditScreen({ route, navigation }: any) {
  const { db, allPeople, refresh } = useAppData();
  const { showDialog } = useAppDialog();
  const form = useSubmitGuard(refresh);
  const person = allPeople.find((item) => item.id === route.params.personId);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const initializedPerson = useRef('');
  useEffect(() => {
    if (person && initializedPerson.current !== person.id) {
      initializedPerson.current = person.id;
      setName(person.name);
      setNote(person.note ?? '');
    }
  }, [person]);
  const dirty = useDirtyForm(!!person && (name.trim() !== person.name || note.trim() !== (person.note ?? '')), form.isSaving);
  const save = () => form.submit(async () => {
    if (!db || !person) return;
    try {
      await renamePerson(db, person.id, person.updated_at, name, note);
      await form.saved('Person updated', () => dirty.leave(() => navigation.goBack()), true);
    } catch (reason) {
      showDialog({
        title: reason instanceof Error && reason.message === 'PERSON_NAME_EXISTS' ? 'Duplicate person' : 'Could not update person',
        message: reason instanceof Error && reason.message === 'PERSON_NAME_EXISTS'
          ? 'An active person with this name already exists.'
          : reason instanceof Error ? reason.message : 'Your input has been kept. Please try again.',
      });
    }
  });
  if (!person) return <FormScreen title="Edit Person"><EmptyState title="Person not found." /></FormScreen>;
  return <FormScreen title="Edit Person">
    <TextField label="Person name" placeholder="Name" value={name} onChangeText={setName} />
    <TextField label="Note optional" placeholder="Anything helpful to remember" value={note} onChangeText={setNote} />
    <PrimaryButton title="Save" onPress={save} saving={form.saving} disabled={!name.trim() || (!changedName(name, person.name) && note.trim() === (person.note ?? ''))} />
  </FormScreen>;
}

export function PersonEntryFormScreen({ route, navigation }: any) {
  const { db, people, accounts, refresh, settings } = useAppData();
  const { accountCurrency, mainCurrency } = useCurrencyInfo();
  const alert = useThemedAlert();
  const fmtMoney = useMoneyFormat();
  const accountLabel = useAccountLabel();
  const moneyLabel = useMoneyLabel();
  const person = people.find((p) => p.id === route.params.personId);
  // Editing an existing plain Give/Receive record keeps its direction fixed.
  const editing = route.params?.entry as PersonEntry | undefined;
  const editingDelta = editing ? personEntryDelta(editing.type, editing.amount_minor) : 0;
  const action = (editing ? (editingDelta > 0 ? 'GIVE' : 'BORROW') : route.params?.action ?? 'GIVE') as VisiblePeopleAction;
  const settlement = !editing && route.params?.settlement === true;
  // The money is in the chosen account's currency and is matched only against the
  // balance in that currency. Person Detail sends the currency it was showing.
  const requestedCurrency: string | undefined = editing ? accountCurrency.get(editing.account_id) : route.params?.currency;
  const preferredAccount = defaultAccountId(accounts, settings);
  const initialAccount = editing?.account_id ?? (requestedCurrency && accountCurrency.get(preferredAccount ?? '') !== requestedCurrency
    ? accounts.find((a) => a.currency === requestedCurrency)?.id ?? preferredAccount
    : preferredAccount);
  const initial = {
    amount: editing ? String(editing.amount_minor / 100) : route.params?.amountMinor ? String(route.params.amountMinor / 100) : '',
    title: editing?.title ?? '',
    account: initialAccount,
    date: editing ? dateKeyToInputDate(editing.occurred_on) : settlement ? dateKeyToInputDate() : '',
  };
  const [amount, setAmount] = useState(initial.amount);
  const [title, setTitle] = useState(initial.title);
  const [account, setAccount] = useState(initial.account);
  const currency = (account ? accountCurrency.get(account) : undefined) ?? requestedCurrency ?? mainCurrency;
  const fmt = (amountMinor: number) => fmtMoney(amountMinor, currency);
  const listedBalance = person ? balancesOf(person, mainCurrency).find((item) => item.currency === currency)?.amountMinor ?? 0 : 0;
  const expectedBalance = route.params?.expectedBalanceMinor != null && (route.params?.currency ?? mainCurrency) === currency ? route.params.expectedBalanceMinor as number : listedBalance;
  const actionLabel = peopleActionLabel(expectedBalance, action);
  // An edit keeps its currency, and a settlement pays the balance in the currency
  // it was opened for: only accounts in that currency can hold it.
  const sameCurrencyAccounts = accounts.filter((a) => a.currency === requestedCurrency || a.id === editing?.account_id);
  const accountChoices = editing || (settlement && requestedCurrency && sameCurrencyAccounts.length) ? sameCurrencyAccounts : accounts;
  const [date, setDate] = useState(initial.date);
  const form = useSubmitGuard(refresh);
  const { confirm } = useAppDialog();
  const confirmOutflow = useConfirmOutflow();
  const editChanged = !!editing && (amount !== initial.amount || title !== initial.title || account !== initial.account || date !== initial.date);
  const dirty = useDirtyForm(editing
    ? editChanged
    : !!(amount.trim() || title.trim() || (date && date !== dateKeyToInputDate()) || account !== initial.account), form.isSaving);
  const saveEdit = (entry: PersonEntry) => form.submit(async () => {
    if (!db || !person || !account) return;
    const minor = moneyToMinorUnits(amount);
    const dateKey = inputDateToDateKey(date);
    if (!minor || minor <= 0) return alert('Invalid amount', 'Please enter an amount greater than zero.');
    if (!dateKey) return alert('Invalid date', 'Use DD-MM-YYYY, for example 09-09-2026.');
    const nextBalance = expectedBalance - editingDelta + personEntryDelta(entry.type, minor);
    if (detectBalanceCrossing(expectedBalance, nextBalance - expectedBalance) !== null && !await confirm({
      title: 'Balance will switch sides',
      message: `${person.name}'s balance will change from ${balanceStatus(expectedBalance, person.name).toLowerCase()} ${fmt(Math.abs(expectedBalance))} to ${balanceStatus(nextBalance, person.name).toLowerCase()} ${fmt(Math.abs(nextBalance))}.`,
    })) return;
    // Only the extra money leaving an account needs the low-balance check.
    const extraOutflow = action === 'GIVE' ? (account === entry.account_id ? minor - entry.amount_minor : minor) : 0;
    if (extraOutflow > 0 && !await confirmOutflow(account, extraOutflow)) return;
    try {
      await updatePersonEntry(db, entry.id, entry.updated_at, { amountMinor: minor, accountId: account, occurredOn: dateKey, title, note: entry.note });
      await form.saved('People record updated', () => dirty.leave(() => navigation.goBack()), true);
    } catch (reason) {
      alert('Could not update', reason instanceof Error ? reason.message : 'Your input has been kept. Please try again.');
    }
  });
  const save = () => editing ? saveEdit(editing) : form.submit(async () => {
    if (!db || !person || !account) return;
    const minor = moneyToMinorUnits(amount);
    const dateKey = inputDateToDateKey(date);
    if (!minor || minor <= 0)
      return alert(
        'Invalid amount',
        'Please enter an amount greater than zero.',
      );
    if (!dateKey)
      return alert(
        'Invalid date',
        'Use DD-MM-YYYY, for example 09-09-2026.',
      );
    const resolved = resolvePeopleAction(
      expectedBalance,
      action,
      minor,
    );
    const crossing = detectBalanceCrossing(
      expectedBalance,
      resolved.delta,
    );
    if (crossing !== null && !await confirm({
      title: 'Balance will switch sides',
      message: buildBalanceCrossingMessage(person.name, expectedBalance, action, minor, currency),
    })) return;
    if (action === 'GIVE' && !await confirmOutflow(account, minor)) return;
    try {
      await recordPeopleAction(db, {
        personId: person.id,
        action,
        amountMinor: minor,
        accountId: account,
        title,
        occurredOn: dateKey,
        expectedBalanceMinor: expectedBalance,
      });
      await form.saved(settlement ? 'Balance updated' : 'Money recorded', () => dirty.leave(() => navigation.goBack()), true);
    } catch (reason) {
      alert('Could not record money', reason instanceof Error ? reason.message : 'Your input has been kept. Please try again.');
    }
  });
  return (
    <FormScreen title={editing ? `Edit ${action === 'GIVE' ? 'Given' : 'Received'}` : settlement ? 'Settle Balance' : `${actionLabel} Money`}>
      <Text style={styles.muted}>
        {editing
          ? `Changing the amount, account or date updates ${person?.name ?? 'this person'}'s balance and the account together.`
          : settlement
          ? `You can settle up to ${fmt(Math.abs(expectedBalance))}. You can change the amount for a partial settlement.`
          : action === 'GIVE'
          ? 'Money leaves your account and appears as Given in People history.'
          : 'Money comes into your account and appears as Received in People history.'}
      </Text>
      <TextField
        label={moneyLabel('Amount', currency)}
        placeholder="0"
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
      />
      <TextField
        label="Description"
        placeholder="What was the money for?"
        value={title}
        onChangeText={setTitle}
      />
      <Picker
        label="Account"
        value={account}
        setValue={setAccount}
        rows={accountChoices.map((a) => [a.id, accountLabel(a)])}
      />
      <TextField
        label="Date"
        placeholder="DD-MM-YYYY"
        value={date}
        onChangeText={setDate}
      />
      <PrimaryButton title={editing ? 'Save Changes' : settlement ? 'Confirm Settlement' : 'Save'} onPress={save} saving={form.saving} disabled={!person || !account || !validMoneyInput(amount) || !inputDateToDateKey(date) || (!!editing && !editChanged)} />
    </FormScreen>
  );
}

export function AccountsScreen({ navigation }: any) {
  const { db, repo, accounts, transactions, entries, refresh, settings } =
    useAppData();
  const { mainCurrency, currencies } = useCurrencyInfo();
  const alert = useThemedAlert();
  const accountLabel = useAccountLabel();
  const moneyLabel = useMoneyLabel();
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType>('BANK');
  const [currency, setCurrency] = useState(mainCurrency);
  // With one currency the screen stays as it always was; "Another currency?" opens the choice.
  const multiCurrency = currencies.length > 1;
  const [choosingCurrency, setChoosingCurrency] = useState(false);
  const showCurrency = multiCurrency || choosingCurrency || currency !== mainCurrency;
  const [opening, setOpening] = useState('');
  const [moveAmount, setMoveAmount] = useState('');
  const [receivedAmount, setReceivedAmount] = useState('');
  const [fromAccount, setFromAccount] = useState<string | undefined>(defaultAccountId(accounts, settings));
  const [toAccount, setToAccount] = useState<string | undefined>(accounts.find((a) => a.id !== defaultAccountId(accounts, settings))?.id);
  const [moveBaseline, setMoveBaseline] = useState(`${fromAccount ?? ''}|${toAccount ?? ''}`);
  const form = useSubmitGuard(refresh);
  const confirmOutflow = useConfirmOutflow();
  useDirtyForm(!!(name.trim() || opening.trim() || moveAmount.trim() || receivedAmount.trim() || type !== 'BANK' || currency !== mainCurrency) || `${fromAccount ?? ''}|${toAccount ?? ''}` !== moveBaseline, form.isSaving);
  useEffect(() => {
    const from = accounts.some((a) => a.id === fromAccount) ? fromAccount : defaultAccountId(accounts, settings);
    const to = accounts.some((a) => a.id === toAccount && a.id !== from)
      ? toAccount : accounts.find((a) => a.id !== from)?.id;
    if (from === fromAccount && to === toAccount) return;
    // A chosen account that was archived is replaced automatically: not an unsaved edit.
    if (`${fromAccount ?? ''}|${toAccount ?? ''}` === moveBaseline) setMoveBaseline(`${from ?? ''}|${to ?? ''}`);
    setFromAccount(from);
    setToAccount(to);
  }, [accounts, fromAccount, toAccount, settings, moveBaseline]);
  useEffect(() => {
    // Adding the second account initializes To automatically, not as a user edit.
    if (!moveBaseline.split('|')[1] && toAccount)
      setMoveBaseline(`${fromAccount ?? ''}|${toAccount}`);
  }, [moveBaseline, fromAccount, toAccount]);
  const save = () => form.submit(async () => {
    if (!db) return alert('Accounts unavailable', 'Please try again.');
    const cleanName = name.trim();
    if (!cleanName)
      return alert('Name required', 'Enter an account name.');
    // The same name is fine in another currency: "Cash" in Rs. and "Cash" in $.
    if (hasActiveAccountNamed(accounts.filter((a) => a.currency === currency), cleanName))
      return alert(
        'Duplicate account',
        multiCurrency ? `An account with this name already exists in ${currency}.` : 'An account with this name already exists.',
      );
    const minor = opening.trim() ? moneyToMinorUnits(opening) : 0;
    if (!Number.isSafeInteger(minor) || minor < 0)
      return alert('Invalid opening balance', 'Enter a valid opening balance.');
      await repo.createAccount(db, {
        name: cleanName,
        type,
        opening_balance_minor: minor,
        currency,
      });
    await form.saved('Account saved', () => { setName(''); setOpening(''); setType('BANK'); setCurrency(mainCurrency); setChoosingCurrency(false); });
  });
  // One section per currency: its accounts and their total. Currencies are never added together.
  const accountTotals = accountTotalsByCurrency(accounts, transactions, entries);
  const sections = orderCurrencies(accounts.map((a) => a.currency), mainCurrency)
    .map((code) => ({ code, accounts: accounts.filter((a) => a.currency === code), totalMinor: accountTotals.find((total) => total.currency === code)?.amountMinor ?? 0 }));
  const defaultId = defaultAccountId(accounts, settings);
  const chooseDefault = (id: string) => {
    if (!db || id === defaultId) return;
    void repo.setSetting(db, 'default_account_id', id).then(refresh).catch(() => alert('Default not saved', 'Please try again.'));
  };
  const from = accounts.find((a) => a.id === fromAccount);
  const to = accounts.find((a) => a.id === toAccount);
  // A move between currencies is an exchange: the user types exactly what left and what arrived.
  const exchange = !!from && !!to && from.currency !== to.currency;
  const sentMinor = moneyToMinorUnits(moveAmount);
  const receivedMinor = moneyToMinorUnits(receivedAmount);
  const rate = exchange && sentMinor && receivedMinor && sentMinor > 0 && receivedMinor > 0 ? exchangeRateText(from.currency, to.currency, sentMinor, receivedMinor) : '';
  const moveMoney = () => form.submit(async () => {
    if (!db) return alert('Accounts unavailable', 'Please try again.');
    if (!fromAccount || !toAccount || !from || !to)
      return alert('Missing accounts', 'Choose both From and To accounts.');
    const minor = moneyToMinorUnits(moveAmount);
    if (!Number.isSafeInteger(minor) || minor <= 0)
      return alert(
        'Invalid amount',
        'Enter an amount greater than zero.',
      );
    if (fromAccount === toAccount)
      return alert(
        'Choose different accounts',
        'Move Money needs two different accounts.',
      );
    const received = exchange ? moneyToMinorUnits(receivedAmount) : null;
    if (exchange && (!Number.isSafeInteger(received) || !received || received <= 0))
      return alert('Amount received needed', `Enter how much arrived in ${to.name} (${to.currency}), after any exchange fee.`);
    if (!await confirmOutflow(fromAccount, minor)) return;
      await repo.saveTransaction(db, {
        type: 'TRANSFER',
        amount_minor: minor,
        account_id: fromAccount,
        destination_account_id: toAccount,
        destination_amount_minor: received,
        category_id: null,
        title: exchange ? 'Currency exchange' : 'Move Money',
        note: null,
        occurred_on: todayLocal(),
        source: 'MANUAL',
      });
    await form.saved(exchange ? 'Exchange recorded' : 'Money moved', () => { setMoveAmount(''); setReceivedAmount(''); setMoveBaseline(`${fromAccount}|${toAccount}`); });
  });
  return (
    <FormScreen title="Accounts">
      {sections.map((section) => (
        <View key={section.code}>
          {sections.length > 1 ? <SectionHeader title={currencyRows.find(([code]) => code === section.code)?.[1] ?? section.code} /> : null}
          {section.accounts.map((a) => (
            <ListRow
              key={a.id}
              card
              icon={accountIcon(a.type)}
              title={a.name}
              subtitle={accounts.length > 1 && a.id === defaultId ? `${formatAccountType(a.type)} · Default` : formatAccountType(a.type)}
              onPress={() => navigation.navigate('AccountDetail', { accountId: a.id })}
              right={
                <Text style={{ color: colors.text, fontWeight: '700' }}>{formatMoney(calculateAccountBalance(a, transactions, entries), a.currency)}</Text>
              }
            />
          ))}
          <View style={[styles.rowBetween, { paddingVertical: spacing.md, borderTopWidth: 1, borderTopColor: colors.border }]}><Text style={styles.sectionSmall}>{sections.length > 1 ? `Total ${section.code}` : 'Total'}</Text><Text style={styles.sectionSmall}>{formatMoney(section.totalMinor, section.code)}</Text></View>
        </View>
      ))}
      {accounts.length > 1 ? (
        <Picker
          label="Default account"
          info="Picked first in new expenses, income, People entries and splits. You can still choose another account each time."
          value={defaultId}
          setValue={chooseDefault}
          rows={accounts.map((a) => [a.id, accountLabel(a), accountIcon(a.type)])}
        />
      ) : null}
      <ArchivedAccountsPanel navigation={navigation} />
      <SectionHeader title="Add Account" />
      <Picker
        label="Account type"
        value={type}
        setValue={(value) => {
          const nextType = value as AccountType;
          setType(nextType);
          if (!name.trim()) setName(defaultAccountNameForType(nextType));
        }}
        rows={accountTypeRows}
      />
      <TextField
        label="Account name"
        placeholder={type === 'CASH' ? 'Cash' : type === 'BANK' ? 'Enter Bank Name' : type === 'EWALLET' ? 'Enter Wallet Name' : 'Account name'}
        value={name}
        onChangeText={setName}
      />
      {showCurrency ? <Picker
        label="Currency"
        info="The money this account holds. Its records always show in this currency; nothing is converted. An account's currency can be changed only while it has no records."
        value={currency}
        setValue={setCurrency}
        rows={currencyRows}
      /> : <Pressable accessibilityRole="button" accessibilityLabel="Add an account in another currency" onPress={() => setChoosingCurrency(true)} style={styles.currencyLink}>
        <Text style={styles.homeActivityLinkText}>Another currency?</Text>
      </Pressable>}
      <Text style={styles.muted}>
        How much money is currently in this account?
      </Text>
      <TextField
        label={moneyLabel('Current balance', currency)}
        placeholder="e.g. 75,000"
        value={opening}
        onChangeText={setOpening}
        keyboardType="decimal-pad"
      />
      <PrimaryButton title="Add Account" onPress={save} saving={form.saving} disabled={!name.trim() || !validMoneyInput(opening, { optional: true, allowZero: true })} />
      <SectionHeader title="Move Money" info={multiCurrency ? 'Moving money between accounts in different currencies records an exchange: type the amount that left and the exact amount that arrived after any fee. Nothing is converted for you, and it does not count as spending or income.' : undefined} />
      <Text style={styles.muted}>
        Move money between your own accounts. This does not affect spending
        plan, income, or People.
      </Text>
      {accounts.length < 2 ? (
        <Card>
          <Text style={styles.muted}>
            Add another account to move money between your accounts.
          </Text>
        </Card>
      ) : (
        <>
          <TextField
            label={exchange && from ? `Amount sent (${currencySymbol(from.currency)})` : 'Amount'}
            placeholder="10000"
            value={moveAmount}
            onChangeText={setMoveAmount}
            keyboardType="decimal-pad"
          />
          <Picker
            label="From"
            value={fromAccount}
            setValue={setFromAccount}
            rows={accounts.map((a) => [a.id, accountLabel(a)])}
          />
          <Picker
            label="To"
            value={toAccount}
            setValue={setToAccount}
            rows={accounts.map((a) => [a.id, accountLabel(a)])}
          />
          {exchange && to ? <>
            <TextField
              label={`Amount received (${currencySymbol(to.currency)})`}
              placeholder="After any exchange fee"
              value={receivedAmount}
              onChangeText={setReceivedAmount}
              keyboardType="decimal-pad"
            />
            {rate ? <Text style={styles.muted}>{rate}</Text> : null}
          </> : null}
          <PrimaryButton title={exchange ? 'Record Exchange' : 'Move Money'} onPress={moveMoney} saving={form.saving} disabled={!validMoneyInput(moveAmount) || (exchange && !validMoneyInput(receivedAmount)) || !fromAccount || !toAccount || fromAccount === toAccount} />
        </>
      )}
    </FormScreen>
  );
}

export function CategoriesScreen() {
  const { db, repo, categories, refresh } = useAppData();
  const alert = useThemedAlert();
  const { confirm, showDialog } = useAppDialog();
  const [name, setName] = useState('');
  const [type, setType] = useState('EXPENSE');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const form = useSubmitGuard(refresh);
  const selected = categories.find((category) => category.id === selectedId);
  const dirty = useDirtyForm(!!name.trim() || type !== 'EXPENSE' || !!(selected && editName.trim() !== selected.name), form.isSaving);
  const save = () => form.submit(async () => {
    if (!db || !name.trim())
      return alert('Name required', 'Do not use an empty category name.');
    try {
      await repo.createCategory(db, { name, type });
      await form.saved('Category saved', () => { setName(''); setType('EXPENSE'); });
    } catch (error) {
      alert('Could not save category', error instanceof Error && error.message === 'CATEGORY_NAME_EXISTS' ? 'A category with this name is already reserved.' : error instanceof Error ? error.message : 'Please try again.');
    }
  });
  const closeEditor = () => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setSelectedId(null); };
  const open = (category: typeof categories[number]) => {
    if (form.isSaving()) return;
    dirty.discard(() => {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setSelectedId(selectedId === category.id ? null : category.id); setEditName(category.name);
    });
  };
  const rename = () => form.submit(async () => {
    if (!db || !selected) return;
    try { await repo.renameCategory(db, selected.id, selected.updated_at, editName); await form.saved('Category renamed', closeEditor); }
    catch (error) { showDialog({ title: 'Could not rename category', message: error instanceof Error && error.message === 'CATEGORY_NAME_EXISTS' ? 'A category with this name is already reserved.' : error instanceof Error ? error.message : 'Please try again.' }); }
  });
  const remove = () => form.submit(async () => {
    if (!db || !selected || !await confirm({ title: 'Delete category?', message: 'This category will be removed from new choices. Historical activity, reports and Spending Plan history will keep it.', destructive: true, cancelText: 'Cancel', confirmText: 'Delete Category' })) return;
    try { await repo.deleteCategory(db, selected.id, selected.updated_at); await form.saved('Category deleted', closeEditor); }
    catch (error) { showDialog({ title: 'Could not delete category', message: error instanceof Error ? error.message : 'Please try again.' }); }
  });
  const renderCategory = (category: typeof categories[number]) => {
    const protectedCategory = category.id === 'cat_expense_other' || category.id === 'cat_income_other_income';
    return <View key={category.id} accessibilityLabel={`Category ${category.name}`}>
      <ListRow card icon={categoryIcon(category)} iconTone={category.type === 'INCOME' ? 'positive' : 'neutral'} title={category.name} subtitle={category.is_default ? 'Default' : 'Custom'} onPress={() => open(category)} />
      {selectedId === category.id ? <Card>
        {protectedCategory ? <Text style={styles.muted}>This required fallback category stays available for your records.</Text> : <>
          <TextField label="Name" value={editName} onChangeText={setEditName} />
          <PrimaryButton title="Rename" onPress={rename} saving={form.saving} disabled={!changedName(editName, category.name)} />
          <SecondaryButton title="Delete Category" disabled={form.saving} onPress={remove} />
        </>}
      </Card> : null}
    </View>;
  };
  return (
    <FormScreen title="Categories">
      <SectionHeader title="Expense Categories" />
      {categories
        .filter((c) => c.type === 'EXPENSE' && !c.is_archived)
        .map(renderCategory)}
      <SectionHeader title="Income Categories" />
      {categories
        .filter((c) => c.type === 'INCOME' && !c.is_archived)
        .map(renderCategory)}
      <SectionHeader title="Add Category" />
      <TextField
        label="Name"
        placeholder="Pet Care"
        value={name}
        onChangeText={setName}
      />
      <Picker
        label="Type"
        value={type}
        setValue={setType}
        rows={[
          ['EXPENSE', 'Expense'],
          ['INCOME', 'Income'],
        ]}
      />
      <PrimaryButton title="Save" onPress={save} saving={form.saving} disabled={!name.trim()} />
    </FormScreen>
  );
}

export function SubscriptionsScreen({ navigation }: any) {
  const { subscriptions, categories, currentDateKey = todayLocal() } = useAppData();
  const { accountCurrency } = useCurrencyInfo();
  const fmt = useMoneyFormat();
  const fabStyle = useStackFabStyle();
  return <Screen>
    <BackHeader title="Subscriptions" />
    <FlatList data={subscriptions} keyExtractor={(item) => item.id} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 88 }}
      ListEmptyComponent={<EmptyState title="No subscriptions yet." subtitle="Tap + to track a recurring service." />}
      renderItem={({ item }) => <ListRow card icon={categoryIcon(categories.find((c) => c.id === item.category_id))} iconTone="negative" title={item.name} subtitle={`${fmt(item.amount_minor, accountCurrency.get(item.account_id))} · ${formatRecurrenceLabel(item.frequency_type, item.frequency_interval)} · Next: ${displayDate(item.next_renewal_date)} · ${getSubscriptionDueStatus(item, currentDateKey).label}`} onPress={() => navigation.navigate('SubscriptionDetail', { subscriptionId: item.id })} />} />
    <PressableScale accessibilityRole="button" accessibilityLabel="Add subscription" onPress={() => navigation.navigate('AddSubscription')} android_ripple={{ color: colors.secondary }} scaleTo={0.92} containerStyle={fabStyle} style={styles.fabInner}><Ionicons name="add" size={28} color={colors.surface} /></PressableScale>
  </Screen>;
}

export function AddSubscriptionScreen({ navigation }: any) {
  const { db, repo, categories, accounts, refresh, settings } =
    useAppData();
  const alert = useThemedAlert();
  const dialog = useAppDialog();
  const confirmOutflow = useConfirmOutflow();
  const fmtMoney = useMoneyFormat();
  const accountLabel = useAccountLabel();
  const moneyLabel = useMoneyLabel();
  const { accountCurrency } = useCurrencyInfo();
  const expenseCats = categories.filter((c) => c.type === 'EXPENSE' && !c.is_archived);
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [frequency, setFrequency] = useState<FrequencyType>('MONTHLY');
  const [interval, setInterval] = useState('3');
  const [reminderEnabled, setReminderEnabled] = useState('1');
  const [reminderDays, setReminderDays] = useState('3');
  const [start, setStart] = useState('');
  const [cat, setCat] = useState(expenseCats[0]?.id);
  const [account, setAccount] = useState(defaultAccountId(accounts, settings));
  const form = useSubmitGuard(refresh);
  const dirty = useDirtyForm(!!(name.trim() || amount.trim() || frequency !== 'MONTHLY' || interval !== '3' || reminderEnabled !== '1' || reminderDays !== '3' || cat !== expenseCats[0]?.id || account !== defaultAccountId(accounts, settings) || (start && start !== dateKeyToInputDate())), form.isSaving);
  const reminderWarning = useReminderSelectionWarning({ name, kind: 'subscription', enabled: reminderEnabled, days: reminderDays, create: true, save: () => save() });
  const fmt = (amountMinor: number) => fmtMoney(amountMinor, accountCurrency.get(account ?? ''));
  const save = () => form.submit(async () => {
    if (!db || !name.trim() || !cat || !account)
      return alert('Missing details', 'Enter subscription details.');
    const minor = moneyToMinorUnits(amount);
    const startKey = inputDateToDateKey(start);
    if (!minor || minor <= 0)
      return alert(
        'Invalid amount',
        'Enter an amount greater than zero.',
      );
    if (!startKey)
      return alert(
        'Invalid date',
        'Use DD-MM-YYYY, for example 09-09-2026.',
      );
    const customInterval = parseRecurrenceInterval(interval);
    const intervalError = validateRecurrenceInterval(frequency, customInterval);
    if (intervalError) return alert('Invalid repeat interval', intervalError);
    const saveInterval = recurrenceIntervalForSave(frequency, customInterval);
    if (!await reminderWarning.beforeSave()) return;
    const today = todayLocal();
    let recordToday = false;
    if (startKey === today) {
      const choice = await new Promise<'today' | 'next' | null>((resolve) => dialog.showDialog({
        title: 'Record today’s payment?',
        message: `This subscription starts today. Record the first ${fmt(minor)} payment now, or start tracking from the next renewal?`,
        onCancel: () => resolve(null),
        actions: [
          { text: 'Record Today', variant: 'primary', onPress: () => resolve('today') },
          { text: 'Start Next Renewal', onPress: () => resolve('next') },
          { text: 'Cancel', onPress: () => resolve(null) },
        ],
      }));
      if (choice === null) return;
      recordToday = choice === 'today';
      if (recordToday && !await confirmOutflow(account, minor)) return;
    }
    await repo.saveSubscription(db, {
      name,
      amount_minor: minor,
      category_id: cat,
      account_id: account,
      frequency_type: frequency,
      frequency_interval: saveInterval,
      start_date: startKey,
      next_renewal_date: recordToday || startKey > today ? startKey : calculateNextRenewal(
        startKey,
        frequency,
        saveInterval,
      ),
      end_date: null,
      total_cycles: null,
      reminder_enabled: Number(reminderEnabled),
      reminder_days_before: Number(reminderDays),
      cancellation_reminder_enabled: 0,
      cancellation_reminder_date: null,
      note: null,
    }, { recordToday });
    await form.saved(recordToday ? 'Subscription and payment saved' : 'Subscription saved', () => dirty.leave(() => navigation.goBack()), true);
  });
  return (
    <FormScreen title="Add Subscription">
      <TextField
        label="Name"
        placeholder="Netflix"
        value={name}
        onChangeText={setName}
      />
      <TextField
        label={moneyLabel('Amount', accountCurrency.get(account ?? ''))}
        placeholder="500"
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
      />
      <Picker
        label="Category"
        value={cat}
        setValue={setCat}
        rows={categoryRows(expenseCats)}
      />
      <Picker
        label="Account"
        value={account}
        setValue={setAccount}
        rows={accounts.map((a) => [a.id, accountLabel(a)])}
      />
      <Picker
        label="Frequency"
        value={frequency}
        setValue={(value) => setFrequency(value as FrequencyType)}
        rows={subscriptionFrequencyRows}
      />
      {frequency === 'EVERY_N_MONTHS' || frequency === 'EVERY_N_DAYS' ? (
        <View style={styles.rowBetweenFull}>
          <TextField
            label="Repeat every"
            placeholder="3"
            value={interval}
            onChangeText={setInterval}
            keyboardType="number-pad"
            style={{ flex: 1 }}
          />
          <Text style={styles.muted}>{frequency === 'EVERY_N_DAYS' ? 'days' : 'months'}</Text>
        </View>
      ) : null}
      <TextField
        label="Start date"
        placeholder="DD-MM-YYYY"
        value={start}
        onChangeText={setStart}
        allowFuture
        info="Starting today lets you record the first payment or begin at the next renewal. A future start is the first billing date. A past start tracks from one renewal after that date; no past payments are added automatically."
      />
      <Picker label="Reminder" value={reminderEnabled} setValue={value => { setReminderEnabled(value); reminderWarning.select(value, reminderDays); }} rows={[["0", "Off"], ["1", "On"]]} />
      {reminderEnabled === '1' ? <Picker label="Remind me" value={reminderDays} setValue={value => { setReminderDays(value); reminderWarning.select(reminderEnabled, value); }} rows={[["0", "On the due date"], ["1", "1 day before"], ["2", "2 days before"], ["3", "3 days before"], ["7", "7 days before"]]} /> : null}
      <PrimaryButton title="Save Subscription" onPress={save} saving={form.saving} disabled={reminderWarning.busy || !name.trim() || !validMoneyInput(amount) || !cat || !account || !inputDateToDateKey(start) || !!validateRecurrenceInterval(frequency, parseRecurrenceInterval(interval))} />
      {settings?.notifications_enabled !== 'true' ? <Text style={styles.muted}>Turn on Notifications in Settings to schedule saved reminders locally on this device.</Text> : null}
    </FormScreen>
  );
}

export function PlannedScreen({ navigation }: any) {
  const { plannedPayments, categories, currentDateKey = todayLocal() } = useAppData();
  const { accountCurrency } = useCurrencyInfo();
  const fabStyle = useStackFabStyle();
  return <Screen>
    <BackHeader title="Planned Payments" />
    <FlatList data={plannedPayments} keyExtractor={(item) => item.id} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 88 }}
      ListEmptyComponent={<EmptyState title="No planned payments yet." subtitle="Tap + to plan a bill or expected income. Nothing moves until you record it." />}
      renderItem={({ item }) => <ListRow card icon={categoryIcon(categories.find((c) => c.id === item.category_id))} iconTone={item.type === 'EXPENSE' ? 'negative' : 'positive'} title={item.name} subtitle={`${displayDate(item.next_due_date)} · ${item.type === 'EXPENSE' ? 'Expense' : 'Income'} · ${formatRecurrenceLabel(item.recurrence_type, item.recurrence_interval)} · ${getPlannedDueStatus(item, currentDateKey).label}`} right={<MoneyText currency={accountCurrency.get(item.account_id)} amount={item.type === 'EXPENSE' ? -item.amount_minor : item.amount_minor} type={item.type === 'EXPENSE' ? 'negative' : 'positive'} />} onPress={() => navigation.navigate('PlannedPaymentDetail', { plannedPaymentId: item.id })} />} />
    <PressableScale accessibilityRole="button" accessibilityLabel="Add planned payment" onPress={() => navigation.navigate('AddPlannedPayment')} android_ripple={{ color: colors.secondary }} scaleTo={0.92} containerStyle={fabStyle} style={styles.fabInner}><Ionicons name="add" size={28} color={colors.surface} /></PressableScale>
  </Screen>;
}

export function AddPlannedPaymentScreen({ navigation }: any) {
  const { db, repo, categories, accounts, refresh, settings } =
    useAppData();
  const alert = useThemedAlert();
  const accountLabel = useAccountLabel();
  const moneyLabel = useMoneyLabel();
  const { accountCurrency } = useCurrencyInfo();
  const [name, setName] = useState('');
  const [type, setType] = useState<'EXPENSE' | 'INCOME'>('EXPENSE');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [recurrence, setRecurrence] = useState<PlannedRecurrenceType>('NONE');
  const [interval, setInterval] = useState('3');
  const [note, setNote] = useState('');
  const [reminderEnabled, setReminderEnabled] = useState('0');
  const [reminderDays, setReminderDays] = useState('3');
  const cats = categories.filter((c) => c.type === type && !c.is_archived);
  const [cat, setCat] = useState(cats[0]?.id);
  const [account, setAccount] = useState(defaultAccountId(accounts, settings));
  const form = useSubmitGuard(refresh);
  const dirty = useDirtyForm(!!(name.trim() || amount.trim() || type !== 'EXPENSE' || recurrence !== 'NONE' || interval !== '3' || note.trim() || reminderEnabled !== '0' || reminderDays !== '3' || cat !== cats[0]?.id || account !== defaultAccountId(accounts, settings) || (date && date !== dateKeyToInputDate())), form.isSaving);
  const reminderWarning = useReminderSelectionWarning({ name, kind: type === 'INCOME' ? 'planned_income' : 'planned_expense', enabled: reminderEnabled, days: reminderDays, create: true, save: () => save() });
  const save = () => form.submit(async () => {
    if (!db || !name.trim() || !cat || !account)
      return alert('Missing details', 'Enter planned payment details.');
    const minor = moneyToMinorUnits(amount);
    const dateKey = inputDateToDateKey(date);
    if (!minor || minor <= 0)
      return alert(
        'Invalid amount',
        'Enter an amount greater than zero.',
      );
    if (!dateKey)
      return alert(
        'Invalid date',
        'Use DD-MM-YYYY, for example 09-09-2026.',
      );
    const customInterval = parseRecurrenceInterval(interval);
    const intervalError = validateRecurrenceInterval(recurrence, customInterval);
    if (intervalError) return alert('Invalid repeat interval', intervalError);
    if (!await reminderWarning.beforeSave()) return;
    await repo.savePlannedPayment(db, {
      name,
      type,
      amount_minor: minor,
      category_id: cat,
      account_id: account,
      next_due_date: dateKey,
      recurrence_type: recurrence,
      recurrence_interval: recurrenceIntervalForSave(recurrence, customInterval),
      end_date: null,
      occurrence_limit: null,
      reminder_enabled: Number(reminderEnabled),
      reminder_days_before: Number(reminderDays),
      subscription_metadata: null,
      note,
    });
    await form.saved('Planned payment saved', () => dirty.leave(() => navigation.goBack()), true);
  });
  return (
    <FormScreen title="Add Planned Payment">
      <TextField
        label="Name"
        placeholder="Internet bill"
        value={name}
        onChangeText={setName}
      />
      <Picker
        label="Type"
        value={type}
        setValue={(value) => {
          const nextType = value as 'EXPENSE' | 'INCOME';
          setType(nextType);
          setCat(categories.find((c) => c.type === nextType && !c.is_archived)?.id ?? '');
        }}
        rows={[
          ['EXPENSE', 'Expense'],
          ['INCOME', 'Income'],
        ]}
      />
      <TextField
        label={moneyLabel('Amount', accountCurrency.get(account ?? ''))}
        placeholder="3500"
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
      />
      <Picker
        label="Category"
        value={cat}
        setValue={setCat}
        rows={categoryRows(cats)}
      />
      <Picker
        label="Account"
        value={account}
        setValue={setAccount}
        rows={accounts.map((a) => [a.id, accountLabel(a)])}
      />
      <TextField
        label="Next Date"
        placeholder="DD-MM-YYYY"
        value={date}
        onChangeText={setDate}
        allowFuture
        allowPast={false}
      />
      <Picker
        label="Recurrence"
        value={recurrence}
        setValue={(value) => setRecurrence(value as PlannedRecurrenceType)}
        rows={plannedRecurrenceRows}
      />
      {recurrence === 'EVERY_N_MONTHS' || recurrence === 'EVERY_N_DAYS' ? (
        <View style={styles.rowBetweenFull}>
          <TextField
            label="Repeat every"
            placeholder="3"
            value={interval}
            onChangeText={setInterval}
            keyboardType="number-pad"
            style={{ flex: 1 }}
          />
          <Text style={styles.muted}>{recurrence === 'EVERY_N_DAYS' ? 'days' : 'months'}</Text>
        </View>
      ) : null}
      <Picker label="Reminder" value={reminderEnabled} setValue={value => { setReminderEnabled(value); reminderWarning.select(value, reminderDays); }} rows={[["0", "Off"], ["1", "On"]]} />
      {reminderEnabled === '1' ? <Picker label="Remind me" value={reminderDays} setValue={value => { setReminderDays(value); reminderWarning.select(reminderEnabled, value); }} rows={[["0", "On the due date"], ["1", "1 day before"], ["2", "2 days before"], ["3", "3 days before"], ["7", "7 days before"]]} /> : null}
      <TextField label="Note" placeholder="Optional" value={note} onChangeText={setNote} />
      {settings?.notifications_enabled !== 'true' ? <Text style={styles.muted}>Turn on Notifications in Settings to schedule this reminder locally on this device.</Text> : null}
      <PrimaryButton title="Save Planned Payment" onPress={save} saving={form.saving} disabled={reminderWarning.busy || !name.trim() || !validMoneyInput(amount) || !cat || !account || !inputDateToDateKey(date) || !!validateRecurrenceInterval(recurrence, parseRecurrenceInterval(interval))} />
    </FormScreen>
  );
}

function MoreScreen({ navigation }: any) {
  return (
    <Screen>
      <AppHeader title="More" />
      <ListRow
        card
        icon="wallet-outline"
        title="Accounts"
        onPress={() => navigation.navigate('Accounts')}
      />
      <ListRow
        card
        icon="pie-chart-outline"
        title="Budget / Spending Plan"
        onPress={() => navigation.navigate('Budget')}
      />
      <ListRow
        card
        icon="pricetags-outline"
        title="Categories"
        onPress={() => navigation.navigate('Categories')}
      />
      <ListRow
        card
        icon="calendar-outline"
        title="Planned Payments"
        onPress={() => navigation.navigate('Planned')}
      />
      <ListRow
        card
        icon="repeat-outline"
        title="Subscriptions"
        onPress={() => navigation.navigate('Subscriptions')}
      />
      <ListRow
        card
        icon="stats-chart-outline"
        title="Insights"
        onPress={() => navigation.navigate('Insights')}
      />
      <ListRow
        card
        icon="settings-outline"
        title="Settings"
        onPress={() => navigation.navigate('Settings')}
      />
      <ListRow card icon="information-circle-outline" title="About" onPress={() => navigation.navigate('About')} />
    </Screen>
  );
}
export function SettingsScreen({ navigation }: any) {
  const { db, settings, setSetting, refresh, budgets, transactions, repo } =
    useAppData();
  const { mainCurrency, currencies } = useCurrencyInfo();
  const multiCurrency = currencies.length > 1;
  const alert = useThemedAlert();
  const fmt = useMoneyFormat();
  const [name, setName] = useState(settings?.user_name ?? '');
  const [currency, setCurrency] = useState(settings?.currency ?? 'PKR');
  const [weekStart, setWeekStart] = useState(settings?.week_start ?? 'MONDAY');
  const [threshold, setThreshold] = useState(
    settings?.budget_alert_threshold ?? '80',
  );
  const [autoCopyBudget, setAutoCopyBudget] = useState(settings?.budget_auto_copy_enabled ?? 'false');
  const [budgetAmount, setBudgetAmount] = useState(() => {
    // Settings edits the main currency's plan; other currencies have theirs on the Spending Plan screen.
    const budget = budgets.find((item) => !item.category_id && (item.currency ?? mainCurrency) === mainCurrency);
    return budget ? String(budget.amount_minor / 100) : '';
  });
  const [savedBudget, setSavedBudget] = useState(budgetAmount);
  const [savedSettings, setSavedSettings] = useState([name.trim(), currency, weekStart, threshold.trim(), autoCopyBudget].join('|'));
  const form = useSubmitGuard(refresh);
  const { confirm } = useAppDialog();
  useDirtyForm([name.trim(), currency, weekStart, threshold.trim(), autoCopyBudget].join('|') !== savedSettings || budgetAmount.trim() !== savedBudget, form.isSaving);
  const currentMonth = monthKey(todayLocal());
  const currentBudget = budgets.find((budget) => !budget.category_id && (budget.currency ?? mainCurrency) === mainCurrency);

  const syncSavedDefaults = useEffectEvent(() => {
    if ([name.trim(), currency, weekStart, threshold.trim(), autoCopyBudget].join('|') === savedSettings) {
      const next = [settings?.user_name ?? '', settings?.currency ?? 'PKR', settings?.week_start ?? 'MONDAY', settings?.budget_alert_threshold ?? '80', settings?.budget_auto_copy_enabled ?? 'false'];
      setName(next[0]); setCurrency(next[1]); setWeekStart(next[2]); setThreshold(next[3]); setAutoCopyBudget(next[4]);
      setSavedSettings(next.join('|'));
    }
    if (budgetAmount.trim() === savedBudget) {
      const next = currentBudget ? String(currentBudget.amount_minor / 100) : '';
      setBudgetAmount(next); setSavedBudget(next);
    }
  });
  useEffect(() => { syncSavedDefaults(); }, [settings, currentBudget]);

  const persistSettings = () => form.submit(async () => {
    if (!db) return;
    const cleanName = name.trim();
    const cleanThreshold = Number(threshold);
    if (!cleanName) return alert('Name required', 'Enter a profile name.');
    if (
      !Number.isInteger(cleanThreshold) ||
      cleanThreshold < 1 ||
      cleanThreshold > 100
    )
      return alert(
        'Invalid threshold',
        'Budget warning threshold must be a number from 1 to 100.',
      );
    const currencyChanged = currency !== settings?.currency;
    if (currencyChanged && transactions.length > 0 && !await confirm(multiCurrency ? {
      title: 'Change main currency?',
      message: 'Your accounts keep their own currency and nothing is converted. The main currency is shown first and is used for new accounts.',
      cancelText: 'Keep Editing',
    } : {
      title: 'Currency display will change',
      message: 'Changing the currency changes how amounts are displayed. Existing amounts will not be converted using exchange rates.',
      cancelText: 'Keep Editing',
    })) return;
    // One currency: everything is relabelled, as before. Several: only the main one changes.
    const relabelled = currencyChanged && !multiCurrency && await repo.relabelOnlyCurrency(db, currency);
    await setSetting(db, 'user_name', cleanName);
    await setSetting(db, 'currency', currency);
    await setSetting(db, 'week_start', weekStart);
    await setSetting(db, 'budget_alert_threshold', String(cleanThreshold));
    await setSetting(db, 'budget_auto_copy_enabled', autoCopyBudget);
    // An unused starting Cash account follows the main currency; once it has records it keeps its own.
    if (currencyChanged && !relabelled && !await accountHasRecords(db, 'account_cash_default'))
      await db.runAsync(
        "UPDATE accounts SET currency = ?, updated_at = ? WHERE id = 'account_cash_default' AND opening_balance_minor = 0;",
        currency,
        new Date().toISOString(),
      );
    await form.saved('Settings saved', () => setSavedSettings([name.trim(), currency, weekStart, threshold.trim(), autoCopyBudget].join('|')));
  });

  const updateBudget = () => form.submit(async () => {
    if (!db) return;
    const minor = moneyToMinorUnits(budgetAmount);
    if (!minor || minor <= 0)
      return alert(
        'Invalid budget',
        'Enter a monthly budget amount greater than zero.',
      );
    await repo.saveBudget(db, { month_key: currentMonth, amount_minor: minor, currency: mainCurrency });
    await form.saved('Spending Plan updated', () => setSavedBudget(budgetAmount.trim()));
  });

  return (
    <FormScreen title="Settings">
      <SectionHeader title="General" />
      <TextField label="Profile name" value={name} onChangeText={setName} />
      <SettingSelectRow
        title={multiCurrency ? 'Main currency' : 'Currency'}
        value={currency}
        rows={currencyRows}
        onSelect={setCurrency}
        info={multiCurrency ? 'Shown first and used for new accounts. Each account keeps its own currency, and amounts are never converted. For money in another currency, add an account in that currency.' : undefined}
      />
      <SettingSelectRow
        title="Week starts on"
        value={weekStart}
        rows={weekStartRows}
        onSelect={setWeekStart}
      />
      <TextField
        label="Budget warning threshold"
        value={threshold}
        onChangeText={setThreshold}
        keyboardType="number-pad"
      />
      <SettingSelectRow
        title="Automatically use last month's Spending Plan"
        value={autoCopyBudget}
        rows={[["false", "Off"], ["true", "On"]]}
        onSelect={setAutoCopyBudget}
        info="When on, the app copies available plan amounts once on the first load of an empty new month. Existing and removed budgets are never overwritten."
      />
      <PrimaryButton title="Save Settings" onPress={persistSettings} saving={form.saving} disabled={!name.trim() || !Number.isInteger(Number(threshold)) || Number(threshold) < 1 || Number(threshold) > 100 || [name.trim(), currency, weekStart, threshold.trim(), autoCopyBudget].join('|') === savedSettings} />
      <SectionHeader title="Spending Plan" />
      <Card>
        <Text style={styles.sectionSmall}>
          {displayMonthYear(todayLocal())} Spending Plan
        </Text>
        <Text style={styles.muted}>
          Current: {fmt(currentBudget?.amount_minor ?? 0)}
        </Text>
        <TextField
          label="Current Month Budget"
          value={budgetAmount}
          onChangeText={setBudgetAmount}
          keyboardType="decimal-pad"
        />
        <PrimaryButton
          title={currentBudget ? 'Update Monthly Budget' : 'Set Monthly Budget'}
          onPress={updateBudget}
          saving={form.saving}
          disabled={!validMoneyInput(budgetAmount)}
        />
      </Card>
      <ListRow
        card
        icon="pie-chart-outline"
        title="Manage Spending Plan"
        subtitle="Open category budget details"
        onPress={() => navigation.navigate('Budget')}
      />
      <SectionHeader title="Preferences" />
      <ReminderPreferences />
      <ListRow card icon="color-palette-outline" title="Theme" subtitle="Sage" />
      <SectionHeader title="Data" />
      <BackupActions />
    </FormScreen>
  );
}
export function AboutScreen() {
  return (
    <Screen>
      <BackHeader title="About" />
      <Card>
        <Text style={styles.body}>Walleaf</Text>
        <Text style={styles.muted}>Version {appConfig.expo.version}</Text>
        <Text style={styles.muted}>Android build {appConfig.expo.android.versionCode}</Text>
        <Text style={styles.muted}>
          Local-first personal finance app. Your data stays on this device unless you export a backup.
        </Text>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  appRoot: { flex: 1 },
  resumeNotice: { position: 'absolute', left: spacing.md, right: spacing.md, bottom: 76, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.negative, backgroundColor: colors.surface },
  resumeNoticeText: { color: colors.negative, fontWeight: '700', marginBottom: spacing.sm },
  muted: { color: colors.muted, fontSize: 14, marginBottom: spacing.md },
  planMonthNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
  planMonthButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  planMonthButtonDisabled: { opacity: 0.45 },
  planMonthTitle: { flex: 1, alignItems: 'center', paddingHorizontal: spacing.sm },
  homeGreetingSubtitle: { color: colors.muted, marginBottom: spacing.lg },
  setupIntro: { marginBottom: spacing.sm },
  setupSection: { marginTop: spacing.md },
  setupTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  setupHelper: { color: colors.muted, fontSize: 14, lineHeight: 20, marginTop: spacing.xs, marginBottom: spacing.sm },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between' },
  rowBetweenFull: {
    width: '100%',
    marginTop: spacing.lg,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  quick: {
    flexDirection: 'row',
    gap: spacing.md,
    marginVertical: spacing.md,
    flexWrap: 'wrap',
  },
  personActionRow: { flexDirection: 'row', gap: spacing.sm, marginVertical: spacing.xs },
  personActionCell: { flex: 1, minWidth: 0 },
  filterLine: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  filterTag: {
    flex: 1,
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    borderColor: colors.border,
    borderWidth: 1,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.xs,
  },
  filterTagActive: {
    borderColor: colors.primary,
  },
  filterTagText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
  },
  homeActions: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  homeActionOuter: { flex: 1, borderRadius: radius.md, backgroundColor: colors.background },
  homeActionAdd: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    overflow: 'hidden',
  },
  homeActionAddText: { color: colors.surface, fontSize: 16, fontWeight: '700' },
  homeActionSplit: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: tones.primaryContainer,
    overflow: 'hidden',
  },
  homeActionSplitText: { color: tones.onPrimaryContainer, fontSize: 16, fontWeight: '700' },
  homeQuickTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '700',
  },
  currencyLink: { alignSelf: 'flex-start', paddingVertical: spacing.sm, marginBottom: spacing.sm },
  homeActivityLink: {
    minHeight: 44,
    justifyContent: 'center',
  },
  homeActivityLinkText: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: '700',
  },
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: '#00000055',
    padding: spacing.lg,
  },
  sheet: { gap: spacing.sm },
  suggestion: { marginBottom: spacing.md },
  paidByCard: { marginBottom: spacing.md },
  paidByAfter: { color: colors.text, fontSize: 14, fontWeight: '700' },
  label: { color: colors.text, marginBottom: spacing.sm, fontWeight: '600' },
  personAddPanel: { overflow: 'hidden' },
  personAddCard: { marginBottom: spacing.md },
  peopleTab: {
    flex: 1,
    minHeight: 48,
    paddingHorizontal: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  peopleTabSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  peopleTabText: { color: colors.primary, fontSize: 16, fontWeight: '700' },
  peopleTabTextSelected: { color: colors.surface },
  chip: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    marginRight: spacing.sm,
  },
  chipActive: {
    backgroundColor: colors.surface,
    borderColor: colors.primary,
    borderWidth: 1.5,
  },
  sectionSmall: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  warn: { color: colors.warning, marginTop: spacing.sm, fontWeight: '700' },
  homeOver: { color: colors.warning, fontWeight: '700' },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.secondary,
    color: colors.surface,
    textAlign: 'center',
    textAlignVertical: 'center',
    fontSize: 22,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  titleSmall: { color: colors.text, fontSize: 20, fontWeight: '700' },
  body: { color: colors.text, fontSize: 16, fontWeight: '600' },
  shareLine: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.sm,
    marginTop: spacing.sm,
  },
  goalProgress: { width: 64 },
  goalPercent: { color: colors.text, fontSize: 14, fontWeight: '700', textAlign: 'right', marginBottom: -spacing.sm },
  // Lets the last row scroll clear of the floating + button.
  fabListPadding: { paddingBottom: 96 },
  // Material 3 FAB: 56dp rounded square, raised so it reads as the main action.
  fab: {
    position: 'absolute',
    right: 24,
    bottom: 28,
    width: 56,
    height: 56,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    ...elevation.level3,
  },
  fabInner: {
    flex: 1,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  formContent: { paddingBottom: spacing.xl },
});

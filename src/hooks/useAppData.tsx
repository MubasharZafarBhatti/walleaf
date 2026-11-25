import { AppState } from 'react-native';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  Account,
  Budget,
  Category,
  Goal,
  GoalEntry,
  Group,
  GroupMember,
  Person,
  PersonEntry,
  PlannedPayment,
  Settings,
  Subscription,
  Transaction,
} from '../types/models';
import { openSharedAppDatabase, type AppDb } from '../database/database';
import * as repo from '../database/repositories/repositories';
import { monthKey, todayLocal } from '../utils/date';
import { calculatePersonBalance } from '../services/people/PeopleBalanceService';
import { currenciesInUse, personBalancesByCurrency } from '../services/currency/CurrencyScope';
import { calculateGoalSaved } from '../services/goals/GoalService';
import { groupBy } from '../utils/groupBy';
import { autoCopyCurrentMonthOnce } from '../services/budget/SpendingPlanService';
import { queueAppReminderReconciliation } from '../services/notifications/NotificationService';
import { createDatabaseAccess } from '../database/DatabaseAccess';
import { backupService } from '../services/backup/BackupService';
import { coordinateRestore } from '../services/backup/RestoreCoordinator';
import { saveSafetyBackup } from '../services/backup/BackupFiles';
import {
  createAppLifecycleCoordinator,
  runAppResumeRefresh,
} from '../services/lifecycle/AppLifecycleService';

type Data = {
  db: AppDb | null;
  ready: boolean;
  settings: Settings | null;
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  budgets: Budget[];
  people: Person[];
  allPeople: Person[];
  entries: PersonEntry[];
  subscriptions: Subscription[];
  goals: Goal[];
  allGoals: Goal[];
  goalEntries: GoalEntry[];
  groups: Group[];
  groupMembers: GroupMember[];
  plannedPayments: PlannedPayment[];
  refresh: () => Promise<void>;
  restoreBackup: (text: string) => Promise<{ committed: true; refreshFailed: boolean; notificationsFailed: boolean }>;
  dataEpoch: number;
  restoreRefreshFailed: boolean;
  retryRestoreRefresh: () => Promise<void>;
  currentDateKey: string;
  resumeRefreshFailed: boolean;
  retryResumeRefresh: () => Promise<void>;
  /** The loaded rows, but only while nothing has been written since they were read; otherwise null. */
  currentRows?: (sourceDb: AppDb) => Promise<{ accounts: Account[]; transactions: Transaction[]; entries: PersonEntry[] } | null>;
  setSetting: typeof repo.setSetting;
  repo: typeof repo;
  /** The currency chosen in Settings: shown first and used for new accounts. */
  mainCurrency: string;
  /** Currencies the user works in, main first. More than one shows a currency switch. */
  currencies: string[];
  /** Every account's currency, archived ones included. */
  accountCurrency: ReadonlyMap<string, string>;
  /** The currency the summary screens (Home, Spending Plan, Insights) are showing. */
  viewCurrency: string;
  setViewCurrency: (currency: string) => void;
};
const Context = createContext<Data | null>(null);

/** How often an open app compares its date with the phone's clock (see the midnight effect). */
const CLOCK_CHECK_MS = 15_000;

export function AppDataProvider({ children }: { children: ReactNode }) {
  const access = useRef<ReturnType<typeof createDatabaseAccess> | null>(null);
  const bootstrapped = useRef(false);
  const readGeneration = useRef(0);
  const restoreInProgress = useRef(false);
  const mounted = useRef(true);
  const lifecycleCoordinator = useRef<ReturnType<typeof createAppLifecycleCoordinator> | null>(null);
  const [dataEpoch, setDataEpoch] = useState(0);
  const [restoreRefreshFailed, setRestoreRefreshFailed] = useState(false);
  const [currentDateKey, setCurrentDateKey] = useState(todayLocal());
  const [resumeRefreshFailed, setResumeRefreshFailed] = useState(false);
  const [db, setDb] = useState<AppDb | null>(null);
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [allPeople, setAllPeople] = useState<Person[]>([]);
  const [entries, setEntries] = useState<PersonEntry[]>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [allGoals, setAllGoals] = useState<Goal[]>([]);
  const [goalEntries, setGoalEntries] = useState<GoalEntry[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupMembers, setGroupMembers] = useState<GroupMember[]>([]);
  const [plannedPayments, setPlannedPayments] = useState<PlannedPayment[]>([]);
  const [chosenViewCurrency, setViewCurrency] = useState<string | null>(null);
  const [accountCurrency, setAccountCurrency] = useState<ReadonlyMap<string, string>>(new Map());
  // What the screens last showed: skip a reload when nothing was written since.
  const loaded = useRef<{ db: AppDb; token: string; month: string } | null>(null);
  const latestRows = useRef<{ accounts: Account[]; transactions: Transaction[]; entries: PersonEntry[] } | null>(null);
  const refresh = useCallback(async (sourceDb: AppDb | null = db, reconcile = true) => {
    if (!sourceDb) return;
    const generation = readGeneration.current;
    const month = monthKey(todayLocal());
    // A resume refresh with no writes since the last load would rebuild every
    // list and re-render every mounted screen for nothing, which is noticeable
    // on low-end phones. data_version moves on commits from other connections
    // (exclusive transactions, restore); total_changes() on this connection's own.
    const token = await changeToken(sourceDb);
    const previous = loaded.current;
    if (token && previous && previous.db === sourceDb && previous.token === token && previous.month === month) {
      if (reconcile) void queueAppReminderReconciliation(sourceDb).catch(() => {});
      return;
    }
    const [
      settingsRows,
      accountRows,
      categoryRows,
      transactionRows,
      budgetRows,
      peopleRows,
      entryRows,
      subscriptionRows,
      goalRows,
      goalEntryRows,
      groupRows,
      groupMemberRows,
      plannedRows,
      accountCurrencyRows,
    ] = await Promise.all([
      repo.getSettings(sourceDb),
      repo.listAccounts(sourceDb),
      repo.listCategories(sourceDb),
      repo.listTransactions(sourceDb),
      repo.listBudgets(sourceDb, monthKey(todayLocal())),
      repo.listAllPeople(sourceDb),
      repo.listPersonEntries(sourceDb),
      repo.listSubscriptions(sourceDb),
      repo.listGoals(sourceDb, true),
      repo.listGoalEntries(sourceDb),
      repo.listGroups(sourceDb),
      repo.listGroupMembers(sourceDb),
      repo.listPlannedPayments(sourceDb),
      repo.listAccountCurrencies(sourceDb),
    ]);
    if (generation !== readGeneration.current || !mounted.current) return;
    loaded.current = token ? { db: sourceDb, token, month } : null;
    latestRows.current = { accounts: accountRows, transactions: transactionRows, entries: entryRows };
    setSettings(settingsRows);
    setAccounts(accountRows);
    setCategories(categoryRows);
    setTransactions(transactionRows);
    setBudgets(budgetRows);
    setEntries(entryRows);
    // One pass over entries instead of one full scan per person/goal.
    const entriesByPerson = groupBy(entryRows, (entry) => entry.person_id);
    // Money in different currencies never adds up: one balance per currency.
    const main = settingsRows.currency || 'PKR';
    const currencyOf = new Map(accountCurrencyRows.map((row) => [row.id, row.currency]));
    setAccountCurrency(currencyOf);
    const peopleWithBalances = peopleRows.map((person) => {
      const own = entriesByPerson.get(person.id) ?? [];
      return {
        ...person,
        balance_minor: calculatePersonBalance(own.filter((entry) => (currencyOf.get(entry.account_id) ?? main) === main)),
        balances: personBalancesByCurrency(own, currencyOf, main),
      };
    });
    setAllPeople(peopleWithBalances);
    setPeople(peopleWithBalances.filter((person) => !person.is_archived));
    setSubscriptions(subscriptionRows);
    setGoalEntries(goalEntryRows);
    const entriesByGoal = groupBy(goalEntryRows, (entry) => entry.goal_id);
    const goalsWithSaved = goalRows.map((goal) => ({
        ...goal,
        saved_minor: calculateGoalSaved(goal.initial_saved_minor, entriesByGoal.get(goal.id) ?? []),
      }));
    setAllGoals(goalsWithSaved);
    setGoals(goalsWithSaved.filter((goal) => !goal.is_archived));
    setGroups(groupRows);
    setGroupMembers(groupMemberRows);
    setPlannedPayments(plannedRows);
    // Native permission is live state, not the user's persisted preference.
    // Revocation cancels delivery during reconciliation without silently opting
    // the user out; allowing permission again can rebuild their saved reminders.
    if (reconcile) void queueAppReminderReconciliation(sourceDb).catch(() => {});
  }, [db]);
  const retryRestoreRefresh = useCallback(async () => {
    await refresh();
    setRestoreRefreshFailed(false);
    setReady(true);
  }, [refresh]);
  const runResumeRefresh = useCallback(async (change: Parameters<typeof runAppResumeRefresh>[0]['change']) => {
    if (!db || restoreInProgress.current || !bootstrapped.current) return false;
    try {
      await runAppResumeRefresh({
        db,
        change,
        refreshData: (sourceDb) => refresh(sourceDb, false),
      });
      if (mounted.current) {
        setCurrentDateKey(change.currentDate);
        setResumeRefreshFailed(false);
      }
      return true;
    } catch (error) {
      if (mounted.current) setResumeRefreshFailed(true);
      throw error;
    }
  }, [db, refresh]);
  const currentRows = useCallback(async (sourceDb: AppDb) => {
    const previous = loaded.current;
    if (!previous || previous.db !== sourceDb || !latestRows.current) return null;
    const token = await changeToken(sourceDb);
    return token && token === previous.token ? latestRows.current : null;
  }, []);
  const retryResumeRefresh = useCallback(async () => {
    await lifecycleCoordinator.current?.refreshNow();
  }, []);
  const restoreBackup = useCallback(async (text: string) => {
    if (!access.current) throw new Error('The database is not ready.');
    if (restoreInProgress.current) throw new Error('A restore is already in progress.');
    restoreInProgress.current = true;
    const manager = access.current;
    readGeneration.current += 1;
    setReady(false);
    setRestoreRefreshFailed(false);
    let restoredDb: AppDb | null = null;
    try {
      const result = await coordinateRestore({
        pause: () => manager.pause(),
        write: async () => {
          await backupService.restore(text, saveSafetyBackup);
        },
        refresh: async () => {
          restoredDb = manager.handle();
          setDb(restoredDb);
          setDataEpoch((value) => value + 1);
          await refresh(restoredDb, false);
          setCurrentDateKey(todayLocal());
          setResumeRefreshFailed(false);
          setReady(true);
        },
        reconcile: async () => {
          const result = await queueAppReminderReconciliation(restoredDb!);
          return result.failed.length === 0;
        },
      });
      setRestoreRefreshFailed(result.refreshFailed);
      return result;
    } catch (error) {
      setReady(true);
      throw error;
    } finally {
      restoreInProgress.current = false;
    }
  }, [refresh]);
  useEffect(() => {
    mounted.current = true;
    openSharedAppDatabase()
      .then((raw) => {
        access.current = createDatabaseAccess(raw);
        setDb(access.current.handle());
      })
      .catch((error) => {
        if (__DEV__) console.error(error);
      });
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!db || bootstrapped.current) return;
    async function bootstrap() {
      if (!db) return;
      await autoCopyCurrentMonthOnce(db, monthKey(todayLocal()));
      await refresh();
      bootstrapped.current = true;
      setReady(true);
    }
    bootstrap().catch((error) => {
      if (__DEV__) console.error(error);
      bootstrapped.current = true;
      setReady(true);
    });
  }, [db, refresh]);
  useEffect(() => {
    if (!db) return;
    const coordinator = createAppLifecycleCoordinator({
      initialState: AppState.currentState,
      initialDate: currentDateKey,
      getCurrentDate: todayLocal,
      onResume: runResumeRefresh,
    });
    lifecycleCoordinator.current = coordinator;
    const subscription = AppState.addEventListener('change', (state) => {
      void coordinator.handleStateChange(state).catch(() => {});
    });
    return () => {
      coordinator.dispose();
      if (lifecycleCoordinator.current === coordinator) lifecycleCoordinator.current = null;
      subscription.remove();
    };
  }, [currentDateKey, db, runResumeRefresh]);
  // Follow the phone's clock while the app stays open: past midnight (or after
  // the date is changed in Settings) run the same refresh as a resume, so
  // "Due today", Home's date and the month's plan move to the new day.
  // A single timer re-arms itself every few seconds (never more often than the
  // next midnight needs): a JS timer measures elapsed time, not the wall clock,
  // so a long one-shot timer would sleep through a clock/date/time-zone change.
  // The check is one cheap date comparison and only runs while the app is open.
  useEffect(() => {
    if (!db) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      const now = new Date();
      const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 2);
      timer = setTimeout(() => {
        if (cancelled) return;
        if (AppState.currentState === 'active' && todayLocal() !== currentDateKey) {
          const refreshed = lifecycleCoordinator.current?.refreshNow().catch(() => {});
          void Promise.resolve(refreshed).then(() => { if (!cancelled) arm(); });
          return;
        }
        arm();
      }, Math.min(Math.max(1000, nextMidnight.getTime() - now.getTime()), CLOCK_CHECK_MS));
    };
    arm();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [currentDateKey, db]);
  const mainCurrency = settings?.currency || 'PKR';
  const currencies = useMemo(() => currenciesInUse(accounts, mainCurrency), [accounts, mainCurrency]);
  const viewCurrency = chosenViewCurrency && currencies.includes(chosenViewCurrency) ? chosenViewCurrency : mainCurrency;
  const value = useMemo(
    () => ({
      mainCurrency,
      currencies,
      viewCurrency,
      setViewCurrency,
      accountCurrency,
      db,
      ready,
      settings,
      accounts,
      categories,
      transactions,
      budgets,
      people,
      allPeople,
      entries,
      subscriptions,
      goals,
      allGoals,
      goalEntries,
      groups,
      groupMembers,
      plannedPayments,
      refresh,
      restoreBackup,
      dataEpoch,
      restoreRefreshFailed,
      retryRestoreRefresh,
      currentDateKey,
      resumeRefreshFailed,
      retryResumeRefresh,
      currentRows,
      setSetting: repo.setSetting,
      repo,
    }),
    [
      db,
      ready,
      settings,
      accounts,
      categories,
      transactions,
      budgets,
      people,
      allPeople,
      entries,
      subscriptions,
      goals,
      allGoals,
      goalEntries,
      groups,
      groupMembers,
      plannedPayments,
      refresh,
      restoreBackup,
      dataEpoch,
      restoreRefreshFailed,
      retryRestoreRefresh,
      currentDateKey,
      resumeRefreshFailed,
      retryResumeRefresh,
      currentRows,
      mainCurrency,
      currencies,
      viewCurrency,
      accountCurrency,
    ],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Changes whenever any connection commits a write; null when it cannot be read (then always reload). */
export async function changeToken(db: AppDb): Promise<string | null> {
  try {
    const [version, own] = await Promise.all([
      db.getFirstAsync<{ data_version: number }>('PRAGMA data_version'),
      db.getFirstAsync<{ changes: number }>('SELECT total_changes() AS changes'),
    ]);
    if (typeof version?.data_version !== 'number' || typeof own?.changes !== 'number') return null;
    return `${version.data_version}:${own.changes}`;
  } catch {
    return null;
  }
}

export function useAppData() {
  const value = useContext(Context);
  if (!value) throw new Error('useAppData must be used inside AppDataProvider');
  return value;
}


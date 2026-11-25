import type { AppStateStatus } from 'react-native';
import type { AppDb } from '../../database/database';
import { monthKey } from '../../utils/date';
import { autoCopyCurrentMonthOnce } from '../budget/SpendingPlanService';
import { queueAppReminderReconciliation } from '../notifications/NotificationService';

export type ResumeDateChange = {
  previousDate: string;
  currentDate: string;
  dayChanged: boolean;
  monthChanged: boolean;
};

export function describeResumeDateChange(previousDate: string, currentDate: string): ResumeDateChange {
  return {
    previousDate,
    currentDate,
    dayChanged: previousDate !== currentDate,
    monthChanged: monthKey(previousDate) !== monthKey(currentDate),
  };
}

export async function runAppResumeRefresh(input: {
  db: AppDb;
  change: ResumeDateChange;
  refreshData: (db: AppDb) => Promise<void>;
  autoCopy?: typeof autoCopyCurrentMonthOnce;
  reconcile?: typeof queueAppReminderReconciliation;
}): Promise<{ notificationsFailed: boolean }> {
  let dataFailure: unknown;
  if (input.change.monthChanged) {
    try {
      await (input.autoCopy ?? autoCopyCurrentMonthOnce)(input.db, monthKey(input.change.currentDate));
    } catch (error) {
      dataFailure = error;
    }
  }
  try {
    await input.refreshData(input.db);
  } catch (error) {
    dataFailure ??= error;
  }

  let notificationsFailed = false;
  try {
    const result = await (input.reconcile ?? queueAppReminderReconciliation)(input.db);
    notificationsFailed = result.failed.length > 0;
  } catch {
    notificationsFailed = true;
  }
  if (dataFailure) throw dataFailure;
  return { notificationsFailed };
}

export function createAppLifecycleCoordinator(input: {
  initialState: AppStateStatus;
  initialDate: string;
  getCurrentDate: () => string;
  onResume: (change: ResumeDateChange) => Promise<boolean>;
}) {
  let state = input.initialState;
  let lastActiveDate = input.initialDate;
  let inFlight: Promise<void> | null = null;
  let disposed = false;

  const refreshNow = () => {
    if (disposed) return Promise.resolve();
    if (inFlight) return inFlight;
    const currentDate = input.getCurrentDate();
    const change = describeResumeDateChange(lastActiveDate, currentDate);
    inFlight = input.onResume(change)
      .then((completed) => {
        if (completed && !disposed) lastActiveDate = currentDate;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  };

  return {
    handleStateChange(nextState: AppStateStatus) {
      const previousState = state;
      state = nextState;
      if (nextState !== 'active' || previousState === 'active') return Promise.resolve();
      return refreshNow();
    },
    refreshNow,
    dispose() { disposed = true; },
  };
}

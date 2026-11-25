import { act, createElement, useEffect } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { AppState } from 'react-native';
import {
  createAppLifecycleCoordinator,
  describeResumeDateChange,
  runAppResumeRefresh,
} from '../services/lifecycle/AppLifecycleService';
import { AppDataProvider, useAppData } from '../hooks/useAppData';

let mockAppStateListener: ((state: 'active' | 'background' | 'inactive') => void) | null = null;

const mockNative = { runAsync: jest.fn().mockResolvedValue({ changes: 1 }) };
const mockCopy = jest.fn();
const mockReconcile = jest.fn();
const mockWrite = jest.fn();
let mockName = 'Before';
let mockReadFailure = false;
jest.mock('../database/database', () => ({ openAppDatabase: async () => mockNative, openSharedAppDatabase: async () => mockNative }));
jest.mock('../services/budget/SpendingPlanService', () => ({ autoCopyCurrentMonthOnce: (...args: unknown[]) => mockCopy(...args) }));
jest.mock('../services/notifications/NotificationService', () => ({ queueAppReminderReconciliation: (...args: unknown[]) => mockReconcile(...args) }));
jest.mock('../services/backup/BackupService', () => ({ backupService: { restore: (...args: unknown[]) => mockWrite(...args) } }));
jest.mock('../services/backup/BackupFiles', () => ({ saveSafetyBackup: jest.fn() }));
jest.mock('../database/repositories/repositories', () => ({
  getSettings: async () => {
    if (mockReadFailure) throw new Error('read failed');
    return { user_name: mockName, setup_complete: 'true', currency: 'PKR' };
  },
  listAccounts: async () => [], listCategories: async () => [], listTransactions: async () => [], listBudgets: async () => [],
  listAllPeople: async () => [], listPersonEntries: async () => [], listSubscriptions: async () => [], listGoals: async () => [],
  listGoalEntries: async () => [], listGroups: async () => [], listGroupMembers: async () => [], listPlannedPayments: async () => [], listAccountCurrencies: async () => [],
  setSetting: jest.fn(),
}));

test.each([
  ['2026-09-16', '2026-09-16', false, false],
  ['2026-09-16', '2026-09-17', true, false],
  ['2026-09-30', '2026-10-01', true, true],
  ['2026-12-31', '2027-01-01', true, true],
  ['2028-02-29', '2028-03-01', true, true],
])('local date boundary %s -> %s is classified without another calendar', (previous, current, dayChanged, monthChanged) => {
  expect(describeResumeDateChange(previous, current)).toEqual({ previousDate: previous, currentDate: current, dayChanged, monthChanged });
});

test('background or inactive to active refreshes once while active-to-active does nothing', async () => {
  const resume = jest.fn().mockResolvedValue(true);
  const coordinator = createAppLifecycleCoordinator({
    initialState: 'active', initialDate: '2026-09-16', getCurrentDate: () => '2026-09-16', onResume: resume,
  });
  await coordinator.handleStateChange('active');
  await coordinator.handleStateChange('background');
  await coordinator.handleStateChange('active');
  await coordinator.handleStateChange('inactive');
  await coordinator.handleStateChange('active');
  expect(resume).toHaveBeenCalledTimes(2);
  expect(resume).toHaveBeenLastCalledWith(expect.objectContaining({ dayChanged: false, monthChanged: false }));
});

test('rapid AppState cycles share one in-flight refresh', async () => {
  let finish!: (completed: boolean) => void;
  const resume = jest.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  const coordinator = createAppLifecycleCoordinator({
    initialState: 'background', initialDate: '2026-09-16', getCurrentDate: () => '2026-09-17', onResume: resume,
  });
  const first = coordinator.handleStateChange('active');
  await coordinator.handleStateChange('background');
  const second = coordinator.handleStateChange('active');
  expect(resume).toHaveBeenCalledTimes(1);
  finish(true);
  await Promise.all([first, second]);
});

test('failed refresh retains the prior date boundary and retry is read-only coordination', async () => {
  const resume = jest.fn().mockRejectedValueOnce(new Error('failed')).mockResolvedValueOnce(true);
  const coordinator = createAppLifecycleCoordinator({
    initialState: 'background', initialDate: '2026-09-30', getCurrentDate: () => '2026-10-01', onResume: resume,
  });
  await expect(coordinator.handleStateChange('active')).rejects.toThrow('failed');
  await coordinator.refreshNow();
  expect(resume).toHaveBeenNthCalledWith(2, expect.objectContaining({ previousDate: '2026-09-30', monthChanged: true }));
});

test('same-day refresh reloads data and reconciles without auto-copy or financial posting callbacks', async () => {
  const refreshData = jest.fn().mockResolvedValue(undefined);
  const autoCopy = jest.fn().mockResolvedValue('copied');
  const reconcile = jest.fn().mockResolvedValue({ failed: [] });
  const recordExpense = jest.fn();
  const recordIncome = jest.fn();
  const markSubscriptionPaid = jest.fn();
  const recordPlannedOccurrence = jest.fn();
  await expect(runAppResumeRefresh({
    db: {} as never,
    change: describeResumeDateChange('2026-09-16', '2026-09-16'),
    refreshData, autoCopy, reconcile,
  })).resolves.toEqual({ notificationsFailed: false });
  expect(refreshData).toHaveBeenCalledTimes(1);
  expect(reconcile).toHaveBeenCalledTimes(1);
  expect(autoCopy).not.toHaveBeenCalled();
  expect([recordExpense, recordIncome, markSubscriptionPaid, recordPlannedOccurrence].map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0, 0]);
});

test('month change runs the budget auto-copy once before the full refresh', async () => {
  const order: string[] = [];
  const autoCopy = jest.fn(async () => { order.push('auto-copy'); return 'copied' as const; });
  const refreshData = jest.fn(async () => { order.push('refresh'); });
  const reconcile = jest.fn(async () => { order.push('notifications'); return { failed: [] } as never; });
  await runAppResumeRefresh({
    db: {} as never,
    change: describeResumeDateChange('2026-12-31', '2027-01-01'),
    refreshData, autoCopy, reconcile,
  });
  expect(autoCopy).toHaveBeenCalledWith(expect.anything(), '2027-01');
  expect(autoCopy).toHaveBeenCalledTimes(1);
  expect(order).toEqual(['auto-copy', 'refresh', 'notifications']);
});

test('notification failure cannot block refreshed app data', async () => {
  const refreshData = jest.fn().mockResolvedValue(undefined);
  await expect(runAppResumeRefresh({
    db: {} as never,
    change: describeResumeDateChange('2026-09-16', '2026-09-17'),
    refreshData,
    reconcile: jest.fn().mockRejectedValue(new Error('OS unavailable')),
  })).resolves.toEqual({ notificationsFailed: true });
  expect(refreshData).toHaveBeenCalledTimes(1);
});

test('auto-copy failure still refreshes safe data and reconciles before reporting retry state', async () => {
  const refreshData = jest.fn().mockResolvedValue(undefined);
  const reconcile = jest.fn().mockResolvedValue({ failed: [] });
  await expect(runAppResumeRefresh({
    db: {} as never,
    change: describeResumeDateChange('2026-09-30', '2026-10-01'),
    refreshData,
    autoCopy: jest.fn().mockRejectedValue(new Error('copy failed')),
    reconcile,
  })).rejects.toThrow('copy failed');
  expect(refreshData).toHaveBeenCalledTimes(1);
  expect(reconcile).toHaveBeenCalledTimes(1);
});

let current: ReturnType<typeof useAppData>;
let renderer: ReactTestRenderer;
function Probe() {
  const data = useAppData();
  useEffect(() => { current = data; }, [data]);
  return null;
}
async function flushLifecycle() {
  await act(async () => {
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  });
}

describe('provider AppState integration', () => {
  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 8, 16, 10));
    jest.clearAllMocks();
    Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
      mockAppStateListener = listener as typeof mockAppStateListener;
      return { remove: jest.fn(() => { mockAppStateListener = null; }) };
    });
    mockName = 'Before'; mockReadFailure = false;
    mockCopy.mockResolvedValue('disabled'); mockReconcile.mockResolvedValue({ failed: [] });
    mockWrite.mockResolvedValue(undefined);
    await act(async () => { renderer = create(createElement(AppDataProvider, null, createElement(Probe))); });
  });
  afterEach(async () => {
    await act(async () => renderer.unmount());
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('background to active replaces stale provider snapshot and advances date-sensitive epoch', async () => {
    mockName = 'After';
    mockAppStateListener?.('background');
    jest.setSystemTime(new Date(2026, 8, 17, 19));
    mockAppStateListener?.('active');
    await flushLifecycle();
    expect(current.settings?.user_name).toBe('After');
    expect(current.currentDateKey).toBe('2026-09-17');
    expect(mockReconcile).toHaveBeenCalled();
    expect(current.resumeRefreshFailed).toBe(false);
  });

  test('an app left open past midnight moves to the new day without needing a resume', async () => {
    expect(current.currentDateKey).toBe('2026-09-16');
    jest.setSystemTime(new Date(2026, 8, 17, 0, 0, 30));
    await act(async () => { jest.advanceTimersByTime(14 * 60 * 60 * 1000 + 5_000); }); // the single midnight timer
    await flushLifecycle();
    expect(current.currentDateKey).toBe('2026-09-17');
    expect(mockReconcile).toHaveBeenCalled();
  });

  test('a clock or date change while the app stays open is noticed within seconds, not at the old midnight', async () => {
    expect(current.currentDateKey).toBe('2026-09-16');
    jest.setSystemTime(new Date(2026, 8, 17, 0, 0, 10)); // e.g. Settings date change or the phone's clock jumping past midnight
    await act(async () => { jest.advanceTimersByTime(20_000); });
    await flushLifecycle();
    expect(current.currentDateKey).toBe('2026-09-17');
  });

  test('failed resume preserves safe state and retry replaces it without repeating a write', async () => {
    mockName = 'After'; mockReadFailure = true;
    mockAppStateListener?.('background'); mockAppStateListener?.('active');
    await flushLifecycle();
    expect(current.settings?.user_name).toBe('Before');
    expect(current.resumeRefreshFailed).toBe(true);
    mockReadFailure = false;
    await act(async () => { await current.retryResumeRefresh(); });
    expect(current.settings?.user_name).toBe('After');
    expect(current.resumeRefreshFailed).toBe(false);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  test('resume during restore is deferred to the restore coordinator and cannot bypass its access lock', async () => {
    let finish!: () => void;
    mockWrite.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    let restoring!: ReturnType<typeof current.restoreBackup>;
    await act(async () => { restoring = current.restoreBackup('backup'); });
    const readsBefore = mockReconcile.mock.calls.length;
    mockAppStateListener?.('background'); mockAppStateListener?.('active');
    await flushLifecycle();
    expect(current.ready).toBe(false);
    expect(mockReconcile.mock.calls.length).toBe(readsBefore);
    await act(async () => { finish(); await restoring; });
    expect(current.ready).toBe(true);
    expect(mockReconcile.mock.calls.length).toBe(readsBefore + 1);
  });
});

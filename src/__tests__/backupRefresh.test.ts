import { act, createElement, useEffect } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { AppDataProvider, useAppData } from '../hooks/useAppData';
const mockNative = { runAsync: jest.fn().mockResolvedValue({ changes: 1 }) };
const mockWrite = jest.fn();
const mockReconcile = jest.fn();
const mockCopy = jest.fn();
let mockName = 'Before';
let mockReadFailure = false;
jest.mock('../database/database', () => ({ openAppDatabase: async () => mockNative, openSharedAppDatabase: async () => mockNative }));
jest.mock('../services/backup/BackupService', () => ({ backupService: { restore: (...args: unknown[]) => mockWrite(...args) } }));
jest.mock('../services/backup/BackupFiles', () => ({ saveSafetyBackup: jest.fn() }));
jest.mock('../services/notifications/NotificationService', () => ({ queueAppReminderReconciliation: (...args: unknown[]) => mockReconcile(...args) }));
jest.mock('../services/budget/SpendingPlanService', () => ({ autoCopyCurrentMonthOnce: (...args: unknown[]) => mockCopy(...args) }));
jest.mock('../database/repositories/repositories', () => ({
  getSettings: async () => { if (mockReadFailure) throw new Error('refresh failed'); return { user_name: mockName, setup_complete: 'true', currency: 'PKR' }; },
  listAccounts: async () => [], listCategories: async () => [], listTransactions: async () => [], listBudgets: async () => [],
  listAllPeople: async () => [], listPersonEntries: async () => [], listSubscriptions: async () => [], listGoals: async () => [],
  listGoalEntries: async () => [], listGroups: async () => [], listGroupMembers: async () => [], listPlannedPayments: async () => [], listAccountCurrencies: async () => [],
  setSetting: jest.fn(),
}));
let current: ReturnType<typeof useAppData>;
let renderer: ReactTestRenderer;
function Probe() {
  const data = useAppData();
  useEffect(() => { current = data; }, [data]);
  return null;
}
beforeEach(async () => {
  jest.clearAllMocks(); mockName = 'Before'; mockReadFailure = false;
  mockReconcile.mockResolvedValue({ failed: [] });
  mockWrite.mockImplementation(async () => { mockName = 'Restored'; });
  await act(async () => { renderer = create(createElement(AppDataProvider, null, createElement(Probe))); });
});
afterEach(async () => { await act(async () => renderer.unmount()); });
test('successful restore reloads provider state, resets navigation epoch and revokes stale financial handles', async () => {
  const oldDb = current.db!;
  await act(async () => { await current.restoreBackup('validated-json'); });
  expect(current.settings?.user_name).toBe('Restored');
  expect(current.ready).toBe(true);
  expect(current.dataEpoch).toBe(1);
  expect(mockCopy).toHaveBeenCalledTimes(1);
  await expect(oldDb.runAsync('stale write')).rejects.toThrow('Reopen');
  await current.db!.runAsync('fresh write');
  expect(mockNative.runAsync).toHaveBeenCalledWith('fresh write');
});
test('post-commit read failure hides stale UI and Retry reads only, without another restore', async () => {
  mockWrite.mockImplementationOnce(async () => { mockName = 'Restored'; mockReadFailure = true; });
  await act(async () => {
    const result = await current.restoreBackup('validated-json');
    expect(result.refreshFailed).toBe(true);
  });
  expect(current.ready).toBe(false);
  expect(current.restoreRefreshFailed).toBe(true);
  mockReadFailure = false;
  await act(async () => { await current.retryRestoreRefresh(); });
  expect(current.ready).toBe(true);
  expect(current.settings?.user_name).toBe('Restored');
  expect(mockWrite).toHaveBeenCalledTimes(1);
});
test('failed replacement retains old app handles and state and performs no new reconciliation', async () => {
  const oldDb = current.db!;
  mockWrite.mockRejectedValueOnce(new Error('rolled back'));
  const notificationCount = mockReconcile.mock.calls.length;
  await act(async () => { await expect(current.restoreBackup('backup')).rejects.toThrow('rolled back'); });
  expect(current.ready).toBe(true);
  expect(current.settings?.user_name).toBe('Before');
  expect(current.dataEpoch).toBe(0);
  expect(mockReconcile.mock.calls.length).toBe(notificationCount);
  await oldDb.runAsync('old data still usable');
  expect(mockNative.runAsync).toHaveBeenCalledWith('old data still usable');
});

test('concurrent restore attempts cannot unhide the app or start a second replacement', async () => {
  let finish!: () => void;
  mockWrite.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  let restoring!: ReturnType<typeof current.restoreBackup>;
  await act(async () => { restoring = current.restoreBackup('first'); });
  expect(current.ready).toBe(false);
  await act(async () => { await expect(current.restoreBackup('second')).rejects.toThrow('already in progress'); });
  expect(current.ready).toBe(false);
  expect(mockWrite).toHaveBeenCalledTimes(1);
  await act(async () => { finish(); await restoring; });
  expect(current.ready).toBe(true);
});

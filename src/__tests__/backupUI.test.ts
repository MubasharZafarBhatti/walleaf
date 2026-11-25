import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { BackupActions } from '../components/BackupActions';
import { PrimaryButton, SecondaryButton } from '../components/common';
const mockDialog = { confirm: jest.fn(), showDialog: jest.fn(), showSuccess: jest.fn() };
const mockRestore = jest.fn();
const mockSelect = jest.fn();
const mockShare = jest.fn();
const mockPreview = jest.fn();
const mockExport = jest.fn();
jest.mock('../hooks/useAppData', () => ({ useAppData: () => ({ restoreBackup: mockRestore, settings: { currency: 'PKR' } }) }));
jest.mock('../components/dialogs/AppDialogProvider', () => ({ useAppDialog: () => mockDialog }));
jest.mock('../services/backup/BackupFiles', () => ({ selectBackup: () => mockSelect(), shareBackup: (text: string) => mockShare(text) }));
jest.mock('../services/backup/BackupService', () => ({ backupService: { preview: (text: string) => mockPreview(text), export: () => mockExport() } }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
let renderer: ReactTestRenderer;
beforeEach(async () => {
  jest.clearAllMocks();
  mockExport.mockResolvedValue('export-json');
  mockSelect.mockResolvedValue('selected-json');
  mockPreview.mockResolvedValue({ createdAt: '2026-09-16T12:00:00Z', backupVersion: 1, compatibility: 'Compatible with this app', counts: { accounts: 2, transactions: 10, people: 3, groups: 1, budgets: 1, goals: 2, planned_payments: 3, subscriptions: 4 } });
  mockRestore.mockResolvedValue({ committed: true, refreshFailed: false, notificationsFailed: false });
  mockDialog.confirm.mockResolvedValue(true);
  await act(async () => { renderer = create(createElement(BackupActions)); });
});
afterEach(async () => { await act(async () => renderer.unmount()); });
async function press(title: string) {
  const button = [...renderer.root.findAllByType(PrimaryButton), ...renderer.root.findAllByType(SecondaryButton)].find((node) => node.props.title === title)!;
  await act(async () => { await button.props.onPress(); });
}
test('export shares the service JSON without restoring', async () => {
  await press('Export Backup');
  expect(mockShare).toHaveBeenCalledWith('export-json');
  expect(mockRestore).not.toHaveBeenCalled();
});
test('selection and preview do not restore; immediate Sage destructive confirmation precedes restore', async () => {
  await press('Import / Restore Backup');
  expect(mockPreview).toHaveBeenCalledWith('selected-json');
  expect(mockRestore).not.toHaveBeenCalled();
  expect(JSON.stringify(renderer.toJSON())).toContain('Restore preview');
  await press('Restore This Backup');
  expect(mockDialog.confirm).toHaveBeenCalledWith(expect.objectContaining({ destructive: true, confirmText: 'Replace and Restore' }));
  expect(mockRestore).toHaveBeenCalledTimes(1);
  expect(mockRestore).toHaveBeenCalledWith('selected-json');
});
test('picker cancellation, preview cancellation and confirmation cancellation perform no restore', async () => {
  mockSelect.mockResolvedValueOnce(null);
  await press('Import / Restore Backup');
  expect(mockPreview).not.toHaveBeenCalled();
  await press('Import / Restore Backup');
  await press('Cancel Preview');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('Restore preview');
  await press('Import / Restore Backup');
  mockDialog.confirm.mockResolvedValueOnce(false);
  await press('Restore This Backup');
  expect(mockRestore).not.toHaveBeenCalled();
});
test('invalid file displays Sage error with no destructive action', async () => {
  mockPreview.mockRejectedValueOnce(new Error('Invalid backup'));
  await press('Import / Restore Backup');
  expect(mockDialog.showDialog).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid backup' }));
  expect(mockRestore).not.toHaveBeenCalled();
});
test('rapid taps cannot duplicate a pending confirmation or restore', async () => {
  await press('Import / Restore Backup');
  let decide!: (value: boolean) => void;
  mockDialog.confirm.mockReturnValueOnce(new Promise((resolve) => { decide = resolve; }));
  const action = renderer.root.findByType(PrimaryButton).props.onPress;
  await act(async () => { void action(); void action(); });
  expect(mockDialog.confirm).toHaveBeenCalledTimes(1);
  await act(async () => { decide(true); });
  expect(mockRestore).toHaveBeenCalledTimes(1);
});
test('notification failure is reported as committed success, never a repeat restore', async () => {
  mockRestore.mockResolvedValueOnce({ committed: true, notificationsFailed: true });
  await press('Import / Restore Backup');
  await press('Restore This Backup');
  expect(mockDialog.showDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'Backup restored', message: expect.stringContaining('financial data is saved') }));
  expect(mockRestore).toHaveBeenCalledTimes(1);
});

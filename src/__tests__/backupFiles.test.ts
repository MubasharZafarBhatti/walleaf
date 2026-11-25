import { backupFileName, shareBackup, selectBackup, saveSafetyBackup } from '../services/backup/BackupFiles';
import { Platform } from 'react-native';
const mockPick = jest.fn();
const mockShare = jest.fn();
const mockAvailable = jest.fn();
const mockFiles = new Map<string, string>();
const mockCopy = jest.fn();
const originalOS = Platform.OS;
jest.mock('expo-file-system/legacy', () => ({ copyAsync: (options: unknown) => mockCopy(options) }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: (options: unknown) => mockPick(options) }));
jest.mock('expo-sharing', () => ({ isAvailableAsync: () => mockAvailable(), shareAsync: (...args: unknown[]) => mockShare(...args) }));
jest.mock('expo-file-system', () => ({
  Paths: { cache: { uri: 'file:///cache/' }, document: { uri: 'file:///private/' } },
  File: class {
    uri: string;
    constructor(base: string | { uri: string }, name?: string) { this.uri = (typeof base === 'string' ? base : base.uri) + (name ?? ''); }
    get exists() { return mockFiles.has(this.uri); }
    get size() { return mockFiles.get(this.uri)?.length ?? 0; }
    create() { mockFiles.set(this.uri, ''); }
    write(text: string) { mockFiles.set(this.uri, text); }
    async text() {
      if (!this.uri.startsWith('file:///cache/') && !this.uri.startsWith('file:///private/')) throw new Error("Missing 'READ' permission");
      return mockFiles.get(this.uri)!;
    }
    delete() { mockFiles.delete(this.uri); }
  },
}));
beforeEach(() => {
  jest.clearAllMocks(); mockFiles.clear(); mockAvailable.mockResolvedValue(true); mockShare.mockResolvedValue(undefined);
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  mockCopy.mockImplementation(async ({ from, to }) => {
    if (!mockFiles.has(from)) throw new Error('Document URI is unreadable');
    mockFiles.set(to, mockFiles.get(from)!);
  });
});
afterEach(() => Object.defineProperty(Platform, 'OS', { value: originalOS, configurable: true }));
test('export creates local JSON, uses system share, and retains URI for the receiving app', async () => {
  await shareBackup('{"backupVersion":1}');
  const [uri, options] = mockShare.mock.calls[0];
  expect(uri).toMatch(/^file:\/\/\/cache\/walleaf-backup-.*\.json$/);
  expect(options.mimeType).toBe('application/json');
  expect(mockFiles.get(uri)).toBe('{"backupVersion":1}');
});
test('export file name is a readable local date and time', () => {
  expect(backupFileName(new Date(2026, 10, 18, 17, 40, 31))).toBe('walleaf-backup-2026-11-18-174031.json');
  expect(backupFileName(new Date(2026, 0, 5, 9, 4, 3))).toBe('walleaf-backup-2026-01-05-090403.json');
});
test('unavailable sharing fails without writing a file', async () => {
  mockAvailable.mockResolvedValue(false);
  await expect(shareBackup('sensitive')).rejects.toThrow('unavailable');
  expect(mockFiles.size).toBe(0);
});
test('picker cancellation is a no-op', async () => {
  mockPick.mockResolvedValue({ canceled: true });
  expect(await selectBackup()).toBeNull();
  expect(mockFiles.size).toBe(0);
});
test('picker reads only selected cache copy and removes it after reading', async () => {
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  mockFiles.set('file:///cache/selected.json', 'backup');
  mockPick.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///cache/selected.json', size: 6 }] });
  expect(await selectBackup()).toBe('backup');
  expect(mockPick).toHaveBeenCalledWith(expect.objectContaining({ copyToCacheDirectory: true, multiple: false }));
  expect(mockFiles.has('file:///cache/selected.json')).toBe(false);
});
test.each(['content://com.android.providers.downloads.documents/document/12', 'content://my-files/document/backup.json', 'file:///cache/selected.json'])('Android copies %s into private cache before reading and retains the source', async (uri) => {
  mockFiles.set(uri, '{"backupVersion":1}');
  mockPick.mockResolvedValue({ canceled: false, assets: [{ uri, size: 19 }] });
  expect(await selectBackup()).toBe('{"backupVersion":1}');
  expect(mockPick).toHaveBeenCalledWith(expect.objectContaining({ copyToCacheDirectory: false, multiple: false }));
  expect(mockCopy).toHaveBeenCalledWith({ from: uri, to: expect.stringMatching(/^file:\/\/\/cache\/backup-import.*\.json$/) });
  expect(mockFiles.get(uri)).toBe('{"backupVersion":1}');
  expect(mockFiles.has(mockCopy.mock.calls[0][0].to)).toBe(false);
});
test('failed Android content copy cleans partial private output without modifying the document', async () => {
  const uri = 'content://downloads/backup.json';
  mockFiles.set(uri, 'original');
  mockPick.mockResolvedValue({ canceled: false, assets: [{ uri }] });
  mockCopy.mockImplementationOnce(async ({ to }) => { mockFiles.set(to, 'partial'); throw new Error('copy failed'); });
  await expect(selectBackup()).rejects.toThrow('copy failed');
  expect([...mockFiles.entries()]).toEqual([[uri, 'original']]);
});
test('copied file size is bounded even when picker size metadata is absent', async () => {
  const uri = 'content://downloads/huge.json';
  mockFiles.set(uri, 'x'.repeat(26 * 1024 * 1024));
  mockPick.mockResolvedValue({ canceled: false, assets: [{ uri }] });
  await expect(selectBackup()).rejects.toThrow('25 MB');
  expect(mockFiles.has(uri)).toBe(true);
  expect(mockFiles.has(mockCopy.mock.calls[0][0].to)).toBe(false);
});
test('network URI cannot trigger an import fetch or cache copy', async () => {
  mockPick.mockResolvedValue({ canceled: false, assets: [{ uri: 'https://example.com/backup.json' }] });
  await expect(selectBackup()).rejects.toThrow('local backup');
  expect(mockCopy).not.toHaveBeenCalled();
});
test('oversized import is rejected and original documents are never removed', async () => {
  mockFiles.set('content://original.json', 'original');
  mockPick.mockResolvedValue({ canceled: false, assets: [{ uri: 'content://original.json', size: 30 * 1024 * 1024 }] });
  await expect(selectBackup()).rejects.toThrow('25 MB');
  expect(mockFiles.get('content://original.json')).toBe('original');
});
test('safety copy is private local JSON and verified before replacement proceeds', async () => {
  await saveSafetyBackup('old local data');
  expect(mockFiles.get('file:///private/before-last-restore.json')).toBe('old local data');
  expect(mockShare).not.toHaveBeenCalled();
});

import { File, Paths } from 'expo-file-system';
import { copyAsync } from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { MAX_BACKUP_BYTES, backupTextBytes } from './BackupFormat';
import { makeId } from '../../utils/id';

/** Readable local-time name, e.g. walleaf-backup-2026-11-18-174031.json (sorts by date in a file manager). */
export function backupFileName(now = new Date()): string {
  const two = (value: number) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  return `walleaf-backup-${date}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}.json`;
}

export async function shareBackup(text: string): Promise<void> {
  if (!await Sharing.isAvailableAsync()) throw new Error('File sharing is unavailable on this device.');
  const file = new File(Paths.cache, backupFileName());
  if (file.exists) file.delete();
  file.create();
  try {
    file.write(text);
    await Sharing.shareAsync(file.uri, { mimeType: 'application/json', UTI: 'public.json', dialogTitle: 'Save your local backup' });
  } catch (error) {
    if (file.exists) file.delete();
    throw error;
  }
  // A receiving app may read the URI after the share sheet resolves. Leave the
  // unique cache file available; normal OS cache cleanup can remove it later.
}

export async function selectBackup(): Promise<string | null> {
  // Android's picker cache can be outside Expo Go's scoped FileSystem paths.
  // Keep the granted document URI and copy through ContentResolver instead.
  const android = Platform.OS === 'android';
  const result = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'text/plain', 'application/octet-stream'], copyToCacheDirectory: !android, multiple: false });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset || !/^(file|content):\/\//.test(asset.uri)) throw new Error('Choose a local backup document.');
  const file = android ? new File(Paths.cache, `${makeId('backup-import')}.json`) : new File(asset.uri);
  try {
    if ((asset.size ?? 0) > MAX_BACKUP_BYTES) throw new Error('Choose a backup smaller than 25 MB.');
    if (android) await copyAsync({ from: asset.uri, to: file.uri });
    if (file.size > MAX_BACKUP_BYTES) throw new Error('Choose a backup smaller than 25 MB.');
    const text = await file.text();
    if (backupTextBytes(text) > MAX_BACKUP_BYTES) throw new Error('Choose a backup smaller than 25 MB.');
    return text;
  } finally {
    // Only remove the picker-owned cache copy, never an original document.
    if (file.uri.startsWith(Paths.cache.uri) && file.exists) file.delete();
  }
}

export async function saveSafetyBackup(text: string): Promise<void> {
  // One private recovery copy; only replaced immediately before a new restore.
  const file = new File(Paths.document, 'before-last-restore.json');
  file.create({ overwrite: true });
  file.write(text);
  if (await file.text() !== text) throw new Error('The local safety copy could not be verified. No data was replaced.');
}

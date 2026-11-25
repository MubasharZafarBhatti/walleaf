import { useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Card, PrimaryButton, SecondaryButton } from './common';
import { useAppDialog } from './dialogs/AppDialogProvider';
import { useAppData } from '../hooks/useAppData';
import { backupService } from '../services/backup/BackupService';
import * as files from '../services/backup/BackupFiles';
import { colors } from '../theme';
import { LabelWithInfo } from './InfoTip';

export function BackupActions() {
  const { restoreBackup } = useAppData();
  const dialog = useAppDialog();
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<{ text: string; preview: Awaited<ReturnType<typeof backupService.preview>> } | null>(null);
  const run = async (work: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    try { await work(); }
    catch (error) {
      dialog.showDialog({ title: 'Backup action could not finish', message: error instanceof Error ? error.message : 'Please try again. Your existing data has not been replaced.' });
    } finally { locked.current = false; setBusy(false); }
  };
  const exportBackup = () => run(async () => {
    await files.shareBackup(await backupService.export());
  });
  const importBackup = () => run(async () => {
    const text = await files.selectBackup();
    if (text === null) return;
    const preview = await backupService.preview(text);
    setSelected({ text, preview });
  });
  const restore = () => run(async () => {
    if (!selected) return;
    if (!await dialog.confirm({
      title: 'Replace current local data?',
      message: 'This restores the selected backup and replaces all current local financial data on this device. It does not merge records. Export your current data first if you want to keep a copy.',
      confirmText: 'Replace and Restore', cancelText: 'Cancel', destructive: true,
    })) return;
    const result = await restoreBackup(selected.text);
    if (result.refreshFailed || result.notificationsFailed) {
      dialog.showDialog({ title: 'Backup restored', message: [
        'Your restored financial data is saved.',
        result.refreshFailed ? 'Use Retry on the loading screen to reload it. This will not repeat the restore.' : '',
        result.notificationsFailed ? 'Some reminders could not be reconciled. The app will retry on its next refresh or foreground visit.' : '',
      ].filter(Boolean).join('\n\n') });
    } else dialog.showSuccess('Backup restored');
  });
  return <Card>
    <View style={styles.content}>
      <LabelWithInfo label="Local backup" info="Backup files contain your personal financial data in readable form. Store them safely. Nothing is uploaded automatically. Restore replaces the data on this phone; choosing a file first only reads and previews it." textStyle={styles.heading} />
      <SecondaryButton title="Export Backup" onPress={exportBackup} disabled={busy} />
      <SecondaryButton title="Import / Restore Backup" onPress={importBackup} disabled={busy} />
      {busy && <Text accessibilityLiveRegion="polite" style={styles.helper}>Working…</Text>}
      {selected && <View style={styles.content}>
        <Text style={styles.heading}>Restore preview</Text>
        <Text style={styles.helper}>{new Date(selected.preview.createdAt).toLocaleString()}</Text>
        <Text style={styles.helper}>Backup format {selected.preview.backupVersion} · {selected.preview.compatibility}</Text>
        {([
          ['accounts', 'Accounts'], ['transactions', 'Transactions'], ['people', 'People'], ['groups', 'Groups'],
          ['budgets', 'Spending Plans'], ['goals', 'Goals'], ['planned_payments', 'Planned Payments'], ['subscriptions', 'Subscriptions'],
        ] as const).map(([key, label]) => <Text key={key} style={styles.helper}>{label}: {selected.preview.counts[key]}</Text>)}
        <Text style={styles.helper}>Includes archived records and linked history. Current data will be replaced.</Text>
        <PrimaryButton title="Restore This Backup" onPress={restore} disabled={busy} />
        <SecondaryButton title="Cancel Preview" onPress={() => setSelected(null)} disabled={busy} />
      </View>}
    </View>
  </Card>;
}
const styles = StyleSheet.create({
  content: { gap: 12 },
  heading: { color: colors.text, fontSize: 18, fontWeight: '600' },
  helper: { color: colors.muted, fontSize: 14, lineHeight: 20 },
});

import { useState } from 'react';
import { FlatList, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PrimaryButton, SecondaryButton, TextField } from './common';
import { colors, spacing } from '../theme';
import { FormFocusContext } from './KeyboardSafeScrollView';

const modalFocus = () => {};

export function MemberPicker({ rows, selected, onChange, disabled }: {
  rows: { id: string; name: string }[]; selected: string[]; onChange: (ids: string[]) => void; disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<string[]>([]);
  const close = () => { Keyboard.dismiss(); setOpen(false); };
  return <>
    <View style={styles.chips}>{selected.map((id) => <Pressable key={id} accessibilityRole="button" accessibilityLabel={`Remove member ${rows.find((row) => row.id === id)?.name ?? 'Unavailable person'}`} accessibilityState={{ selected: true, disabled }} disabled={disabled} onPress={() => onChange(selected.filter((value) => value !== id))} style={styles.chip}><Text style={styles.chipText}>{rows.find((row) => row.id === id)?.name ?? 'Unavailable person'} ×</Text></Pressable>)}</View>
    <SecondaryButton title="Add Member" disabled={disabled} onPress={() => { Keyboard.dismiss(); setDraft(selected); setQuery(''); setOpen(true); }} />
    {open ? <Modal visible transparent statusBarTranslucent navigationBarTranslucent animationType="fade" onRequestClose={close}>
      <SafeAreaView style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel="Close member picker" onPress={close} />
        <FormFocusContext.Provider value={modalFocus}>
        <KeyboardAvoidingView enabled={Platform.OS === 'ios'} behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.card}>
          <Text style={styles.heading}>Choose members</Text>
          <TextField accessibilityLabel="Search members" placeholder="Search members..." value={query} onChangeText={setQuery} />
          <FlatList keyboardShouldPersistTaps="handled" data={rows.filter((row) => !selected.includes(row.id) && row.name.toLowerCase().includes(query.trim().toLowerCase()))} keyExtractor={(row) => row.id}
            ListEmptyComponent={<Text style={styles.chipText}>{query.trim() ? 'No matching people.' : 'Everyone available is already selected.'}</Text>}
            renderItem={({ item }) => {
              const checked = draft.includes(item.id);
              return <Pressable accessibilityRole="checkbox" accessibilityLabel={item.name} accessibilityState={{ checked, disabled }} disabled={disabled} onPress={() => setDraft((ids) => checked ? ids.filter((id) => id !== item.id) : [...ids, item.id])} style={[styles.row, checked && styles.chip]}><Text style={styles.chipText}>{checked ? '✓ ' : ''}{item.name}</Text></Pressable>;
            }} />
          <PrimaryButton title="Done" onPress={() => { onChange([...draft].sort((a, b) => a === 'SELF' ? -1 : b === 'SELF' ? 1 : 0)); close(); }} />
          <SecondaryButton title="Cancel" onPress={close} />
        </KeyboardAvoidingView>
        </FormFocusContext.Provider>
      </SafeAreaView>
    </Modal> : null}
  </>;
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  chip: { minHeight: 44, justifyContent: 'center', padding: spacing.sm, backgroundColor: '#E2EAE4', borderRadius: 16 },
  chipText: { color: colors.primary, fontWeight: '600' },
  overlay: { flex: 1, justifyContent: 'center', padding: spacing.lg, backgroundColor: '#00000066' },
  card: { height: '72%', padding: spacing.lg, borderRadius: 16, backgroundColor: colors.background },
  heading: { fontSize: 22, fontWeight: '700', color: colors.text, marginBottom: spacing.md },
  row: { minHeight: 48, justifyContent: 'center', padding: spacing.md },
});

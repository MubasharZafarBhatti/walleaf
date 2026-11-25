import { useState } from 'react';
import { FlatList, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PrimaryButton, SecondaryButton, TextField } from './common';
import { FormFocusContext } from './KeyboardSafeScrollView';
import { colors, spacing } from '../theme';

const modalFocus = () => {};

/** Searchable, staged stable-ID selection. Cancel/Back never changes the form. */
export function PeopleMultiPicker({ kind, rows, selected, onChange, disabled }: {
  kind: 'participants' | 'payers'; rows: { id: string; name: string }[]; selected: string[];
  onChange: (ids: string[]) => void; disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<string[]>([]);
  const singular = kind === 'participants' ? 'participant' : 'payer';
  const close = () => { Keyboard.dismiss(); setOpen(false); };
  return <>
    <SecondaryButton title={`Select ${kind}`} disabled={disabled} onPress={() => { Keyboard.dismiss(); setDraft(selected); setQuery(''); setOpen(true); }} />
    {open ? <Modal visible transparent statusBarTranslucent navigationBarTranslucent animationType="fade" onRequestClose={close}>
      <SafeAreaView style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel={`Close ${singular} picker`} onPress={close} />
        <FormFocusContext.Provider value={modalFocus}>
          <KeyboardAvoidingView enabled={Platform.OS === 'ios'} behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.card} accessibilityLabel={`${kind === 'participants' ? 'Participant' : 'Payer'} picker`}>
            <Text style={styles.heading}>{kind === 'participants' ? 'Who is included?' : 'Who paid?'}</Text>
            <Text style={styles.muted}>You (me) means your own share or payment.</Text>
            <TextField accessibilityLabel={`Search ${kind}`} placeholder={`Search ${kind}...`} value={query} onChangeText={setQuery} />
            <FlatList keyboardShouldPersistTaps="handled" data={rows.filter(row => row.name.toLowerCase().includes(query.trim().toLowerCase()))} keyExtractor={row => row.id}
              ListEmptyComponent={<Text style={styles.muted}>No matching people.</Text>}
              renderItem={({ item }) => <Pressable accessibilityRole="checkbox" accessibilityLabel={item.name} accessibilityState={{ checked: draft.includes(item.id), disabled }} disabled={disabled}
                onPress={() => setDraft(ids => ids.includes(item.id) ? ids.filter(id => id !== item.id) : [...ids, item.id])} style={[styles.row, draft.includes(item.id) && styles.selected]}>
                <Text style={styles.text}>{draft.includes(item.id) ? '✓ ' : ''}{item.name}</Text>
              </Pressable>} />
            <PrimaryButton title="Done" disabled={disabled} onPress={() => { onChange(draft); close(); }} />
            <SecondaryButton title="Cancel" onPress={close} />
          </KeyboardAvoidingView>
        </FormFocusContext.Provider>
      </SafeAreaView>
    </Modal> : null}
  </>;
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', padding: spacing.lg, backgroundColor: '#00000066' },
  card: { height: '72%', padding: spacing.lg, borderRadius: 16, backgroundColor: colors.background, gap: spacing.sm },
  heading: { fontSize: 22, fontWeight: '700', color: colors.text },
  muted: { color: colors.muted },
  row: { minHeight: 48, justifyContent: 'center', padding: spacing.md, borderRadius: 12 },
  selected: { backgroundColor: '#E2EAE4' },
  text: { color: colors.primary, fontWeight: '600' },
});

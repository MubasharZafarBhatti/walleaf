import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useState, type ReactNode } from 'react';
import { FlatList, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { KeyboardSafeScrollView } from './KeyboardSafeScrollView';
import { Screen, SecondaryButton, TextField } from './common';
import { LabelWithInfo } from './InfoTip';
import type { IconName } from '../utils/icons';
import { useAppDialog } from './dialogs/AppDialogProvider';
import { colors, spacing } from '../theme';

/**
 * Rows are [id, name] or [id, name, icon]. With icons (e.g. categories) the
 * searchable list is always used so each option can show its icon.
 */
export function SelectField({ label, value, rows, onSelect, selectedId, showLabel = true, info }: { label: string; value?: string; rows: string[][]; onSelect: (value: string) => void; selectedId?: string; showLabel?: boolean; info?: string }) {
  const { showDialog } = useAppDialog();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const close = () => { Keyboard.dismiss(); setOpen(false); };
  const hasIcons = rows.some((row) => !!row[2]);
  const selectedRow = rows.find(([id, name]) => (selectedId !== undefined ? selectedId === id : value === name));
  const selectedIcon = selectedRow?.[2] as IconName | undefined;
  const choose = () => {
    Keyboard.dismiss();
    if (rows.length > 8 || hasIcons) { setQuery(''); setOpen(true); return; }
    showDialog({ title: label, message: 'Choose an option.', actions: [...rows.map(([id, name]) => ({ text: name, onPress: () => onSelect(id), variant: 'secondary' as const })), { text: 'Cancel', variant: 'secondary' }] });
  };
  return <View style={styles.selectFieldWrap}>
    {showLabel ? <View style={styles.labelWrap}><LabelWithInfo label={label} info={info} textStyle={styles.labelText} /></View> : null}
    {/* Rounded clipping parent: Android's ripple otherwise fills the square corners. */}
    <View style={styles.selectFieldClip}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Choose ${label}`} accessibilityValue={{ text: value || 'Choose' }} onPress={choose} android_ripple={{ color: '#E2EAE4' }} style={styles.selectField}>
        <View style={styles.selectValue}>
          {selectedIcon ? <Ionicons name={selectedIcon} size={20} color={colors.primary} /> : null}
          <Text style={styles.selectFieldText}>{value || 'Choose'}</Text>
        </View>
        <Ionicons name="chevron-down" size={18} color={colors.muted} />
      </Pressable>
    </View>
    {open ? <Modal visible transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={close}>
      <SafeAreaView style={styles.pickerOverlay}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel={`Close ${label} picker`} onPress={close} />
        <KeyboardAvoidingView enabled={Platform.OS === 'ios'} behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.pickerCard}>
          <Text style={styles.pickerTitle}>{label}</Text>
          <TextField accessibilityLabel={`Search ${label}`} placeholder="Search..." value={query} onChangeText={setQuery} />
          <FlatList keyboardShouldPersistTaps="handled" data={rows.filter(([, name]) => name.toLowerCase().includes(query.trim().toLowerCase()))} keyExtractor={([id]) => id}
            ListEmptyComponent={<Text style={styles.label}>{query.trim() ? 'No matching options.' : 'No options available.'}</Text>}
            renderItem={({ item: [id, name, icon] }) => {
              const selected = selectedId !== undefined ? selectedId === id : value === name;
              return <Pressable accessibilityRole="radio" accessibilityLabel={name} accessibilityState={{ selected, checked: selected }} android_ripple={{ color: '#E2EAE4' }} style={[styles.pickerRow, selected && { backgroundColor: '#E2EAE4' }]} onPress={() => { Keyboard.dismiss(); setOpen(false); onSelect(id); }}>
                <View style={styles.pickerRowContent}>
                  <View style={styles.selectValue}>
                    {icon ? <Ionicons name={icon as IconName} size={20} color={colors.primary} /> : null}
                    <Text style={styles.selectFieldText}>{name}</Text>
                  </View>
                  {selected ? <Ionicons name="checkmark" size={20} color={colors.primary} /> : null}
                </View>
              </Pressable>;
            }} />
          <SecondaryButton title="Cancel" onPress={close} />
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal> : null}
  </View>;
}

export function Picker({ label, value, setValue, rows, info }: { label: string; value?: string; setValue: (value: any) => void; rows: string[][]; info?: string }) {
  return <SelectField label={label} info={info} selectedId={value} value={rows.find(([id]) => id === value)?.[1] ?? (value ? 'Unavailable selection' : undefined)} rows={rows} onSelect={setValue} />;
}

export function BackHeader({ title }: { title: string }) {
  const navigation = useNavigation();
  return <View style={styles.backHeader}>
    <Pressable accessibilityRole="button" accessibilityLabel="Go back" onPress={() => navigation.goBack()} style={styles.backButton}>
      <Ionicons name="chevron-back" size={26} color={colors.primary} />
    </Pressable>
    <Text style={styles.backTitle}>{title}</Text>
  </View>;
}

export function FormScreen({ title, children }: { title: string; children: ReactNode }) {
  return <KeyboardAvoidingView enabled={Platform.OS === 'ios'} behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: colors.background }}>
    <Screen><KeyboardSafeScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.formContent}>
      <BackHeader title={title} />{children}
    </KeyboardSafeScrollView></Screen>
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create({
  label: { color: colors.text, marginBottom: spacing.sm, fontWeight: '600' },
  labelWrap: { marginBottom: spacing.sm },
  labelText: { color: colors.text, fontWeight: '600' },
  selectValue: { flexDirection: 'row', alignItems: 'center', columnGap: spacing.md, flexShrink: 1 },
  pickerRowContent: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  selectFieldWrap: { marginBottom: spacing.lg },
  selectFieldClip: { borderRadius: 12, overflow: 'hidden' },
  selectField: { minHeight: 56, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, paddingHorizontal: spacing.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  selectFieldText: { color: colors.text, fontSize: 16, fontWeight: '500' },
  formContent: { paddingBottom: spacing.xl },
  pickerOverlay: { flex: 1, justifyContent: 'center', padding: spacing.lg, backgroundColor: '#00000066' },
  pickerCard: { height: '72%', padding: spacing.lg, borderRadius: 16, backgroundColor: colors.background },
  pickerTitle: { color: colors.text, fontWeight: '700', fontSize: 22, marginBottom: spacing.md },
  pickerRow: { minHeight: 48, justifyContent: 'center', padding: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  backHeader: { minHeight: 52, flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md },
  backButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', marginRight: spacing.sm },
  backTitle: { flex: 1, color: colors.text, fontSize: 28, lineHeight: 34, fontWeight: '700' },
});

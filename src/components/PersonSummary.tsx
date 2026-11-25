import { Ionicons } from '@expo/vector-icons';
import { useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { colors, radius, spacing } from '../theme';

export function personHistoryLayout(body: number, summary: number, controls: number, fontScale = 1) {
  const compact = Math.max(64, 44 + 22 * fontScale);
  const distance = Math.max(0, summary - spacing.sm - compact);
  // The list viewport never changes while scrolling. Plain minimum content room
  // permits deliberate collapse even with empty history, without fake entries.
  return { collapsible: body > 0 && summary > 0 && controls > 0 && distance > 0, distance, minContentHeight: body + distance + 1 };
}

export function personSnapOffset(offset: number, distance: number): number | null {
  if (distance <= 0 || offset >= distance) return null;
  return offset < distance / 2 ? 0 : distance;
}

export function PersonSummary({ name, note, balance, amount, given, received, archived, disabled, onArchive, onEdit, onExpandedHeight, scroll, collapsible, collapsed = false, interactive = true }: {
  name: string; note?: string | null; balance: number; amount: string; given: string; received: string;
  archived: boolean; disabled: boolean; onArchive: () => void; onEdit: () => void; onExpand: () => void;
  onExpandedHeight: (height: number) => void; scroll: Animated.Value; collapsible: boolean;
  collapsed?: boolean; interactive?: boolean;
}) {
  const [height, setHeight] = useState(0);
  const measuredHeight = useRef(0);
  const { fontScale } = useWindowDimensions();
  const compact = Math.max(64, 44 + 22 * fontScale);
  const distance = Math.max(1, height - compact);
  const progress = collapsible ? scroll.interpolate({ inputRange: [0, distance], outputRange: [0, 1], extrapolate: 'clamp' }) : 0;
  const interpolate = (from: number, to: number) => typeof progress === 'number' ? from : progress.interpolate({ inputRange: [0, 1], outputRange: [from, to] });
  const color = balance > 0 ? colors.positive : balance < 0 ? colors.negative : colors.text;
  const backgroundColor = balance > 0 ? '#E7F0E9' : balance < 0 ? '#F5E9E7' : colors.surface;
  return <View style={{ marginBottom: spacing.sm }}>
    <Animated.View pointerEvents={!interactive || collapsed ? 'none' : 'auto'} accessibilityElementsHidden={collapsed} importantForAccessibility={collapsed ? 'no-hide-descendants' : 'auto'} style={{ opacity: interpolate(1, 0), backgroundColor, borderRadius: radius.lg, transform: [{ scale: interpolate(1, 0.96) }] }} onLayout={(event) => { const next = event.nativeEvent.layout.height; if (next > 0 && Math.abs(next - measuredHeight.current) > 0.5) { measuredHeight.current = next; setHeight(next); onExpandedHeight(next + spacing.sm); } }}>
      <View style={styles.expanded}>
        {!archived ? <>
          <Pressable accessibilityRole="button" accessibilityLabel="Archive Person" disabled={disabled} onPress={onArchive} style={[styles.icon, { left: spacing.sm }]}><Ionicons name="archive-outline" size={21} color={colors.primary} /></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Edit Person" disabled={disabled} onPress={onEdit} style={[styles.icon, { right: spacing.sm }]}><Ionicons name="pencil-outline" size={21} color={colors.primary} /></Pressable>
        </> : null}
        <Text style={styles.avatar}>{name[0]?.toUpperCase()}</Text>
        <Text style={styles.name}>{name}</Text>
        <Text style={styles.relationship}>{balance > 0 ? 'They owe you' : balance < 0 ? 'You owe them' : 'Settled'}</Text>
        <Text style={[styles.amount, { color }]}>{amount}</Text>
        {note ? <Text style={styles.note}>{note}</Text> : null}
        <View style={styles.totals}><View><Text style={styles.relationship}>Total given</Text><Text style={styles.total}>{given}</Text></View><View><Text style={styles.relationship}>Total received</Text><Text style={styles.total}>{received}</Text></View></View>
      </View>
    </Animated.View>
  </View>;
}

export function PersonCapsule({ name, balance, amount, scroll, distance, collapsed, interactive, onExpand }: {
  name: string; balance: number; amount: string; scroll: Animated.Value; distance: number; collapsed: boolean; interactive: boolean; onExpand: () => void;
}) {
  const { fontScale } = useWindowDimensions();
  const compact = Math.max(64, 44 + 22 * fontScale);
  const progress = scroll.interpolate({ inputRange: [0, Math.max(1, distance)], outputRange: [0, 1], extrapolate: 'clamp' });
  const color = balance > 0 ? colors.positive : balance < 0 ? colors.negative : colors.text;
  return <Animated.View pointerEvents={interactive && collapsed ? 'auto' : 'none'} accessibilityElementsHidden={!collapsed} importantForAccessibility={collapsed ? 'auto' : 'no-hide-descendants'} style={{ position: 'absolute', left: 0, right: 0, top: 0, height: compact, borderRadius: compact / 2, backgroundColor: balance > 0 ? '#E7F0E9' : balance < 0 ? '#F5E9E7' : colors.surface, opacity: progress }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Expand ${name} summary`} accessibilityHint={`${balance > 0 ? 'They owe you' : balance < 0 ? 'You owe them' : 'Settled'}: ${amount}`} onPress={onExpand} style={styles.capsule}>
      <View style={{ flex: 1 }}><Animated.Text numberOfLines={1} style={[styles.capsuleName, { transform: [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }] }]}>{name}</Animated.Text><Text style={{ color: colors.muted, fontSize: 12 }}>{balance > 0 ? 'They owe you' : balance < 0 ? 'You owe them' : 'Settled'}</Text></View>
      <Animated.Text style={{ color, fontWeight: '700' }}>{amount}</Animated.Text>
    </Pressable>
  </Animated.View>;
}

const styles = StyleSheet.create({
  expanded: { padding: spacing.md, alignItems: 'center' },
  icon: { position: 'absolute', top: spacing.sm, width: 44, height: 44, borderRadius: 22, backgroundColor: '#DDE5DC', alignItems: 'center', justifyContent: 'center' },
  avatar: { width: 40, height: 40, borderRadius: 20, textAlign: 'center', lineHeight: 40, backgroundColor: '#DDE5DC', color: colors.primary, fontSize: 21, fontWeight: '700' },
  name: { color: colors.text, fontSize: 21, fontWeight: '700', textAlign: 'center', marginTop: 4 },
  relationship: { color: colors.muted, fontSize: 14, textAlign: 'center' },
  amount: { fontSize: 26, fontWeight: '700', textAlign: 'center', marginTop: 2 },
  note: { color: colors.muted, fontSize: 12, textAlign: 'center', marginTop: 4 },
  totals: { flexDirection: 'row', justifyContent: 'space-around', gap: spacing.md, alignSelf: 'stretch', marginTop: spacing.sm },
  total: { textAlign: 'center', color: colors.text, fontWeight: '600' },
  capsule: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, paddingHorizontal: spacing.lg },
  capsuleName: { color: colors.text, fontSize: 16, fontWeight: '700' },
});

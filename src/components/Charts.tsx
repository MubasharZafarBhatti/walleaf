import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G } from 'react-native-svg';
import { colors, spacing } from '../theme';

/** Sage shades (plus the gold accent) so charts stay close to the app's monochrome look. */
export const chartPalette = ['#446A5A', '#7A9C8B', '#B1C8BA', '#D3A95B', '#9A7647'];
export const chartOtherColor = '#CBD3CA';
const trackColor = '#E4E8DF';

export type DonutSegment = { key: string; value: number; color: string };

/**
 * Donut chart of shares (e.g. spending by category). Segments start at 12 o'clock
 * and run clockwise with a hairline gap between them; the centre shows a caption.
 */
export function DonutChart({ segments, size = 176, thickness = 24, centerTitle, centerValue, accessibilityLabel }: {
  segments: DonutSegment[];
  size?: number;
  thickness?: number;
  centerTitle?: string;
  centerValue?: string;
  accessibilityLabel?: string;
}) {
  const visible = segments.filter((segment) => segment.value > 0);
  const total = visible.reduce((sum, segment) => sum + segment.value, 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const gap = visible.length > 1 ? 2 : 0;
  let offset = 0;
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={accessibilityLabel} style={{ width: size, height: size, alignSelf: 'center' }}>
      <Svg width={size} height={size}>
        <G rotation={-90} origin={`${size / 2}, ${size / 2}`}>
          <Circle cx={size / 2} cy={size / 2} r={radius} stroke={trackColor} strokeWidth={thickness} fill="none" />
          {total > 0 ? visible.map((segment) => {
            const length = (segment.value / total) * circumference;
            const arc = (
              <Circle
                key={segment.key}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                stroke={segment.color}
                strokeWidth={thickness}
                fill="none"
                strokeDasharray={`${Math.max(0, length - gap)} ${circumference}`}
                strokeDashoffset={-offset}
              />
            );
            offset += length;
            return arc;
          }) : null}
        </G>
      </Svg>
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
        {centerTitle ? <Text style={styles.centerTitle}>{centerTitle}</Text> : null}
        {centerValue ? <Text numberOfLines={1} adjustsFontSizeToFit style={styles.centerValue}>{centerValue}</Text> : null}
      </View>
    </View>
  );
}

export type BarPoint = { key: string; label: string; value: number; valueLabel: string };

/**
 * Vertical bar chart drawn with plain views (cheap to render on budget phones).
 * The highlighted bar (e.g. the current month) uses the primary colour.
 */
export function BarChart({ points, highlightKey, height = 150, accessibilityLabel }: {
  points: BarPoint[];
  highlightKey?: string;
  height?: number;
  accessibilityLabel?: string;
}) {
  const max = Math.max(0, ...points.map((point) => point.value));
  const barArea = height - 22;
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={accessibilityLabel}>
      <View style={[styles.bars, { height }]}>
        {points.map((point) => {
          const barHeight = max > 0 && point.value > 0 ? Math.max(4, (point.value / max) * barArea) : 0;
          return (
            <View key={point.key} style={styles.barColumn}>
              <Text numberOfLines={1} style={styles.barValue}>{point.value > 0 ? point.valueLabel : ''}</Text>
              <View style={[styles.bar, { height: barHeight, backgroundColor: point.key === highlightKey ? colors.primary : '#9DB8A8' }]} />
            </View>
          );
        })}
      </View>
      <View style={styles.baseline} />
      <View style={styles.labels}>
        {points.map((point) => <Text key={point.key} numberOfLines={1} style={[styles.barLabel, point.key === highlightKey && styles.barLabelActive]}>{point.label}</Text>)}
      </View>
    </View>
  );
}

/** "Rs 12.3k" style short amounts for chart labels (minor units in, no currency symbol). */
export function compactAmount(minor: number): string {
  const value = Math.abs(minor) / 100;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 36 },
  centerTitle: { color: colors.muted, fontSize: 13 },
  centerValue: { color: colors.text, fontSize: 18, fontWeight: '700' },
  bars: { flexDirection: 'row', alignItems: 'flex-end', columnGap: spacing.sm },
  barColumn: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', height: '100%' },
  barValue: { color: colors.muted, fontSize: 11, marginBottom: 4 },
  bar: { width: '70%', maxWidth: 34, borderTopLeftRadius: 6, borderTopRightRadius: 6 },
  baseline: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  labels: { flexDirection: 'row', columnGap: spacing.sm, marginTop: spacing.xs },
  barLabel: { flex: 1, textAlign: 'center', color: colors.muted, fontSize: 12 },
  barLabelActive: { color: colors.primary, fontWeight: '700' },
});

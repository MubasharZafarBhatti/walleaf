import { Ionicons } from '@expo/vector-icons';
import { useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { colors, elevation, spacing } from '../theme';

const ARROW = 8;
const EDGE = spacing.lg;

/**
 * A small (i) next to a heading or label. Extra explanation stays out of the
 * way until it is needed; a tap opens a chat-bubble style tip whose arrow points
 * at the icon (below it, or above it near the bottom of the screen). Any tap
 * outside, or the back button, closes it.
 */
export function InfoTip({ text, label }: { text: string; label?: string }) {
  const anchor = useRef<View>(null);
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const [position, setPosition] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const open = () => anchor.current?.measureInWindow((x, y, width, height) => setPosition({ x, y, width, height }));
  const close = () => setPosition(null);
  const bubbleWidth = Math.min(screenWidth - EDGE * 2, 320);
  const centerX = position ? position.x + position.width / 2 : 0;
  const left = Math.max(EDGE, Math.min(centerX - bubbleWidth / 2, screenWidth - bubbleWidth - EDGE));
  const below = !position || position.y < screenHeight * 0.6;
  const arrowLeft = Math.max(12, Math.min(centerX - left - ARROW, bubbleWidth - 12 - ARROW * 2));
  return (
    <>
      <Pressable
        ref={anchor}
        collapsable={false}
        accessibilityRole="button"
        accessibilityLabel={label ? `About ${label}` : 'More information'}
        accessibilityHint={text}
        hitSlop={12}
        onPress={open}
        style={styles.icon}
      >
        <Ionicons name="information-circle-outline" size={18} color={colors.muted} />
      </Pressable>
      {position ? (
        <Modal visible transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={close}>
          <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel="Close information" onPress={close} />
          <View
            pointerEvents="box-none"
            accessibilityLiveRegion="polite"
            style={[
              styles.bubble,
              { left, width: bubbleWidth },
              below ? { top: position.y + position.height + ARROW + 2 } : { bottom: screenHeight - position.y + ARROW + 2 },
            ]}
          >
            <View style={[styles.arrow, { left: arrowLeft }, below ? { top: -ARROW } : { bottom: -ARROW }]} />
            <Text style={styles.text}>{text}</Text>
          </View>
        </Modal>
      ) : null}
    </>
  );
}

/** Heading/label text with an optional (i) tip beside it. */
export function LabelWithInfo({ label, info, textStyle }: { label: string; info?: string; textStyle?: object }) {
  return (
    <View style={styles.labelRow}>
      <Text style={textStyle}>{label}</Text>
      {info ? <InfoTip text={info} label={label} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  icon: { marginLeft: spacing.xs, alignSelf: 'center' },
  labelRow: { flexDirection: 'row', alignItems: 'center' },
  bubble: {
    position: 'absolute',
    backgroundColor: colors.text,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    ...elevation.level3,
  },
  arrow: {
    position: 'absolute',
    width: ARROW * 2,
    height: ARROW * 2,
    backgroundColor: colors.text,
    transform: [{ rotate: '45deg' }],
  },
  text: { color: colors.surface, fontSize: 14, lineHeight: 20 },
});

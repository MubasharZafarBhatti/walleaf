import { useState, type ReactNode } from 'react';
import { Animated, Pressable, StyleSheet, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';

/**
 * Pressable with a short Material-style press-in shrink and a soft spring back:
 * a visual cue that the tap registered. Runs on the native driver, so it stays
 * smooth on low-end phones and costs no JS work per frame.
 *
 * Android draws `android_ripple` on the pressable's full rectangle, even with a
 * border radius; only a rounded parent with overflow hidden keeps it inside the
 * corners. So when a ripple is set, the animated container takes the
 * pressable's corner radius and clips (its own elevation shadow is unaffected).
 */
export function PressableScale({
  children,
  containerStyle,
  scaleTo = 0.97,
  onPressIn,
  onPressOut,
  ...props
}: PressableProps & { children?: ReactNode; containerStyle?: StyleProp<ViewStyle>; scaleTo?: number }) {
  const [scale] = useState(() => new Animated.Value(1));
  const animate = (toValue: number) => {
    Animated.spring(scale, { toValue, useNativeDriver: true, speed: 40, bounciness: toValue === 1 ? 8 : 0 }).start();
  };
  return (
    <Animated.View style={[containerStyle, rippleClip(props), { transform: [{ scale }] }]}>
      <Pressable
        {...props}
        onPressIn={(event) => { if (!props.disabled) animate(scaleTo); onPressIn?.(event); }}
        onPressOut={(event) => { animate(1); onPressOut?.(event); }}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

export function rippleClip({ android_ripple, style }: Pick<PressableProps, 'android_ripple' | 'style'>): ViewStyle | null {
  if (!android_ripple || typeof style === 'function') return null;
  const borderRadius = StyleSheet.flatten(style)?.borderRadius;
  return typeof borderRadius === 'number' ? { borderRadius, overflow: 'hidden' } : null;
}

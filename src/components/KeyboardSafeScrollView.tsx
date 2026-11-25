import { createContext, useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, ScrollView, View, type ScrollViewProps, type TextInput } from 'react-native';

export const FormFocusContext = createContext<(input: TextInput | null) => void>(() => {});

/** The containing KAV (iOS) or native resize (Android <15) reduces the viewport.
 * Android 15+ edge-to-edge apps (targetSdk 35+) are no longer resized, so the
 * keyboard overlaps the viewport; that overlap becomes temporary bottom room. */
export function focusScrollDelta(top: number, height: number, viewportTop: number, viewportBottom: number) {
  const bottom = top + height;
  if (bottom > viewportBottom - 16) return bottom - viewportBottom + 16;
  if (top < viewportTop + 16) return top - viewportTop - 16;
  return 0;
}

export function KeyboardSafeScrollView({ children, contentContainerStyle, onLayout, onScroll, onContentSizeChange, ...props }: ScrollViewProps) {
  const scroll = useRef<ScrollView>(null);
  const viewport = useRef<View>(null);
  const focused = useRef<TextInput | null>(null);
  const offset = useRef(0);
  const keyboardTop = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const coveredRef = useRef(0);
  const [covered, setCovered] = useState(0);
  const setCoveredHeight = useCallback((value: number) => {
    if (coveredRef.current === value) return;
    coveredRef.current = value; setCovered(value);
  }, []);
  const ensureVisible = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (keyboardTop.current === null) return;
      viewport.current?.measureInWindow((_x, y, _width, height) => {
        if (keyboardTop.current === null || !height) return;
        setCoveredHeight(Math.max(0, Math.round(y + height - keyboardTop.current)));
        const input = focused.current;
        if (!input) return;
        input.measureInWindow((_ix, iy, _iw, ih) => {
          if (focused.current !== input || keyboardTop.current === null || !height || !ih) return;
          const delta = focusScrollDelta(iy, ih, y, Math.min(y + height, keyboardTop.current));
          if (delta) scroll.current?.scrollTo({ y: Math.max(0, offset.current + delta), animated: true });
        });
      });
    });
  }, [setCoveredHeight]);
  const focus = useCallback((input: TextInput | null) => { focused.current = input; ensureVisible(); }, [ensureVisible]);
  useEffect(() => {
    const metrics = Keyboard.metrics();
    if (metrics) { keyboardTop.current = metrics.screenY; setKeyboardOpen(true); ensureVisible(); }
    const show = Keyboard.addListener('keyboardDidShow', (event) => {
      keyboardTop.current = event.endCoordinates.screenY;
      setKeyboardOpen(true);
      ensureVisible();
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      keyboardTop.current = null;
      setKeyboardOpen(false);
      setCoveredHeight(0);
    });
    return () => {
      show.remove(); hide.remove();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [ensureVisible, setCoveredHeight]);
  return <FormFocusContext.Provider value={focus}>
    <View ref={viewport} testID="keyboard-form-viewport" collapsable={false} style={{ flex: 1 }} onLayout={ensureVisible}>
      <ScrollView {...props} ref={scroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
        contentContainerStyle={contentContainerStyle} scrollEventThrottle={16}
        onLayout={(event) => { onLayout?.(event); ensureVisible(); }}
        onContentSizeChange={(width, height) => { onContentSizeChange?.(width, height); ensureVisible(); }}
        onScroll={(event) => { offset.current = event.nativeEvent.contentOffset.y; onScroll?.(event); }}>
        {children}
        {keyboardOpen ? <View testID="keyboard-form-spacer" accessible={false} style={{ height: 96 + covered }} /> : null}
      </ScrollView>
    </View>
  </FormFocusContext.Provider>;
}

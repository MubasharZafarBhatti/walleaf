import { cloneElement, isValidElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { PixelRatio, View, useWindowDimensions } from 'react-native';

/** Vertical padding inside each preview card: the same compact card as before. */
export const PREVIEW_PADDING = 6;

export function fittingPreviewRows(available: number, heights: number[], max = 4) {
  let used = 0;
  let count = 0;
  for (const height of heights.slice(0, max)) {
    if (height <= 0 || used + height > available) break;
    used += height;
    count++;
  }
  return count;
}

/**
 * How the preview uses its space. `heights` are the rows' full heights (card
 * plus its bottom margin). Cards keep one size; as many whole cards as fit are
 * shown, and when some had to be left out, the space that is still free is
 * shared out as extra room after each card, so the list ends close to the tab
 * bar instead of leaving an empty strip above it.
 */
export function previewLayout(available: number, heights: number[], max = 4) {
  const rows = heights.slice(0, max);
  if (!rows.length || available <= 0 || rows.some((height) => height <= 0)) return { count: 0, gap: 0 };
  const count = fittingPreviewRows(available, rows, max);
  if (!count) return { count: 0, gap: 0 };
  const used = rows.slice(0, count).reduce((sum, height) => sum + height, 0);
  const gap = count < rows.length ? Math.max(0, Math.floor((available - used) / count)) : 0;
  return { count, gap };
}

// Measured sizes per window size, so the next start lays the cards out on the
// first frame instead of measuring again. A new window size (floating window,
// split screen, resolution or font size change) measures once and is added.
type SavedLayout = { available: number; heights: number[] };
export type PreviewLayoutStore = { getItemSync(key: string): string | null; setItemAsync(key: string, value: string): Promise<void> };
const STORE_KEY = 'home.preview.layout.v1';
const MAX_SAVED_SIZES = 6;
let layoutStore: PreviewLayoutStore | null | undefined;
function store(): PreviewLayoutStore | null {
  if (layoutStore === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- Lazy native load keeps tests and unsupported runtimes working.
      layoutStore = require('expo-sqlite/kv-store').default as PreviewLayoutStore;
    } catch {
      layoutStore = null;
    }
  }
  return layoutStore;
}
export function setPreviewLayoutStoreForTests(value: PreviewLayoutStore | null | undefined) { layoutStore = value; }

function readSaved(): Record<string, SavedLayout> {
  try {
    const parsed = JSON.parse(store()?.getItemSync(STORE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
function writeSaved(sizeKey: string, layout: SavedLayout) {
  try {
    const all = readSaved();
    delete all[sizeKey];
    const next = Object.fromEntries([...Object.entries(all).slice(-(MAX_SAVED_SIZES - 1)), [sizeKey, layout]]);
    void store()?.setItemAsync(STORE_KEY, JSON.stringify(next)).catch(() => {});
  } catch {
    // Saving is only a start-up shortcut; the preview still measures itself.
  }
}

/**
 * Shows as many whole rows as fit the space left on screen (up to `max`), so a
 * taller phone shows more cards instead of empty space. Adapts whitespace before
 * reducing count; never scales text or clips a partial row.
 */
export function ResponsivePreview({ children, max = 4 }: { children: ReactNode[]; max?: number }) {
  const { width, height } = useWindowDimensions();
  const sizeKey = `${Math.round(width)}x${Math.round(height)}@${PixelRatio.getFontScale()}`;
  const [saved] = useState(() => readSaved()[sizeKey]);
  const [available, setAvailable] = useState(saved?.available ?? 0);
  const [heights, setHeights] = useState<number[]>(saved?.heights ?? []);
  const rows = children.slice(0, max);
  const adaptive = rows.map((child) => isValidElement<{ preview?: boolean }>(child) && !!child.props.preview);
  const { count, gap } = previewLayout(available, rows.map((_, i) => heights[i] ?? 0), max);
  const lastSaved = useRef(saved ? JSON.stringify(saved) : '');
  useEffect(() => {
    const measured = rows.map((_, i) => heights[i] ?? 0);
    if (available <= 0 || !measured.length || measured.some((value) => value <= 0)) return;
    const layout = { available, heights: measured };
    const text = JSON.stringify(layout);
    if (text === lastSaved.current) return;
    lastSaved.current = text;
    writeSaved(sizeKey, layout);
  });
  return <View testID="home-activity-preview" style={{ flex: 1, overflow: 'hidden' }} onLayout={(event) => {
    const next = event.nativeEvent.layout.height;
    setAvailable((current) => current === next ? current : next);
  }}>
    {rows.map((child, i) => {
      const top = rows.slice(0, i).reduce((sum: number, _, j) => sum + (heights[j] ?? 0), 0) + i * gap;
      return <View key={isValidElement(child) ? child.key ?? i : i} testID={`home-preview-row-${i}`} pointerEvents={i < count ? 'auto' : 'none'} accessibilityElementsHidden={i >= count} importantForAccessibility={i >= count ? 'no-hide-descendants' : 'auto'} style={{ position: 'absolute', left: 0, right: 0, top, opacity: i < count ? 1 : 0 }} onLayout={(event) => {
        const measured = event.nativeEvent.layout.height;
        setHeights((current) => current[i] === measured ? current : Object.assign([...current], { [i]: measured }));
      }}>{adaptive[i] ? cloneElement(child as ReactElement<{ verticalPadding?: number }>, { verticalPadding: PREVIEW_PADDING }) : child}</View>;
    })}
  </View>;
}

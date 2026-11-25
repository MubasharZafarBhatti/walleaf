export const colors = {
  background: '#EEF1EA',
  surface: '#F7F8F4',
  primary: '#446A5A',
  secondary: '#779786',
  accent: '#D3A95B',
  text: '#26332D',
  muted: '#69766F',
  positive: '#3F7C5D',
  negative: '#A95454',
  border: '#D9DED4',
  warning: '#B9832F',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

export const radius = {
  sm: 12,
  md: 16,
  lg: 18,
  pill: 999,
};

export const typography = {
  title: 28,
  section: 18,
  body: 16,
  secondary: 14,
  amount: 26,
};

/** Material 3 style tonal surfaces built from the Sage palette (still monochrome). */
export const tones = {
  surfaceContainer: '#F2F4EF',
  primaryContainer: '#DCE7DF',
  onPrimaryContainer: '#22392F',
  pressed: '#E2EAE4',
  // Very light tints used only behind small icons, so the app stays monochrome.
  negativeContainer: '#F4E9E7',
  positiveContainer: '#E4EFE7',
  scrim: '#00000066',
};

/** Material 3 elevation levels (Android `elevation` + iOS shadow), tinted with the app's text colour. */
export const elevation = {
  level1: { elevation: 1, shadowColor: '#26332D', shadowOpacity: 0.08, shadowRadius: 2, shadowOffset: { width: 0, height: 1 } },
  level2: { elevation: 3, shadowColor: '#26332D', shadowOpacity: 0.12, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } },
  level3: { elevation: 6, shadowColor: '#26332D', shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } },
} as const;

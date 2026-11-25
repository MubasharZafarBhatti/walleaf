import { Ionicons } from '@expo/vector-icons';
import { createContext, forwardRef, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type AccessibilityState,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, elevation, radius, spacing, tones, typography } from '../theme';
import { LabelWithInfo } from './InfoTip';
import { PressableScale } from './PressableScale';
import type { IconName, IconTone } from '../utils/icons';
import { useAppData } from '../hooks/useAppData';
import { getFirstDateOffset, getWeekdayLabels } from '../utils/calendar';
import {
  dateKeyToInputDate,
  inputDateToDateKey,
  parseDateKey,
  toDateKey,
  todayLocal,
} from '../utils/date';
import { formatMoney, formatMoneyEdit, formatMoneyInput } from '../utils/money';
import { FormFocusContext, KeyboardSafeScrollView } from './KeyboardSafeScrollView';
import { useDisplayCurrency } from './CurrencyView';

const maxCalendarPageWidth = 348;
const calendarMonthRange = 3;

function getInputDate(value: TextInputProps['value']): string {
  return typeof value === 'string' && value ? value : dateKeyToInputDate();
}

function getViewDate(value: TextInputProps['value']): Date {
  return parseDateKey(inputDateToDateKey(getInputDate(value)) ?? todayLocal());
}

export function getCalendarDates(
  viewDate: Date,
  weekStart?: string,
): (Date | null)[] {
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const leadingBlanks = getFirstDateOffset(new Date(year, month, 1), weekStart);
  const cellCount = 42;

  return Array.from({ length: cellCount }, (_, index) => {
    const day = index - leadingBlanks + 1;
    return day >= 1 && day <= daysInMonth ? new Date(year, month, day) : null;
  });
}

function monthStartDateKey(date: Date): string {
  return toDateKey(new Date(date.getFullYear(), date.getMonth(), 1));
}

export function getCalendarMonths(baseDate: Date, allowFuture = false, allowPast = true): Date[] {
  const todayMonthKey = todayLocal().slice(0, 7) + '-01';
  const months: Date[] = [];

  for (
    let offset = -calendarMonthRange;
    offset <= calendarMonthRange;
    offset += 1
  ) {
    const month = new Date(
      baseDate.getFullYear(),
      baseDate.getMonth() + offset,
      1,
    );
    const monthKey = monthStartDateKey(month);
    // Future-only fields (due/target dates) never offer months before today.
    if ((allowFuture || monthKey <= todayMonthKey) && (allowPast || monthKey >= todayMonthKey))
      months.push(month);
  }

  return months;
}

function getBaseMonthIndex(months: Date[], baseDate: Date): number {
  const baseMonthKey = monthStartDateKey(baseDate);
  return Math.max(
    0,
    months.findIndex((month) => monthStartDateKey(month) === baseMonthKey),
  );
}

/**
 * True inside the bottom-tab pages. Their bottom edge sits on the tab bar, which
 * already clears the system navigation bar, so they must not reserve it again
 * (Android 7–9 otherwise lose ~48dp at the bottom of every tab).
 */
export const TabSceneContext = createContext(false);
const tabSceneEdges = ['top', 'left', 'right'] as const;

export function Screen({
  children,
  scroll = false,
}: {
  children: ReactNode;
  scroll?: boolean;
}) {
  const inTabScene = useContext(TabSceneContext);
  return (
    <SafeAreaView style={styles.screen} edges={inTabScene ? tabSceneEdges : undefined}>
      {scroll ? (
        <KeyboardSafeScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </KeyboardSafeScrollView>
      ) : (
        children
      )}
    </SafeAreaView>
  );
}

export function LoadingScreen() {
  return (
    <Screen>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel="Loading your finances"
        accessibilityState={{ busy: true }}
        style={styles.center}
      >
        <ActivityIndicator color={colors.primary} />
        <Text accessibilityLiveRegion="polite" style={styles.muted}>Loading your finances...</Text>
      </View>
    </Screen>
  );
}

export function AppHeader({
  title,
  action,
  info,
}: {
  title: string;
  action?: ReactNode;
  /** Optional extra explanation behind an (i) tip, instead of a paragraph under the title. */
  info?: string;
}) {
  return (
    <View style={styles.header}>
      <LabelWithInfo label={title} info={info} textStyle={styles.title} />
      {action}
    </View>
  );
}

export function Card({
  children,
  style,
  accessibilityState,
}: {
  children: ReactNode;
  style?: ViewStyle;
  accessibilityState?: AccessibilityState;
}) {
  return <View accessibilityState={accessibilityState} style={[styles.card, style]}>{children}</View>;
}

export function PrimaryButton({
  title,
  onPress,
  disabled,
  saving = false,
  compact = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  saving?: boolean;
  compact?: boolean;
}) {
  // Android draws the press ripple on the view's rectangle; only a rounded
  // parent with overflow hidden keeps it inside the rounded corners.
  return (
    <View style={styles.buttonClip}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={saving ? 'Saving...' : title}
        accessibilityState={{ disabled: !!disabled || saving, busy: saving }}
        onPress={onPress}
        disabled={disabled || saving}
        android_ripple={{ color: '#779786' }}
        style={({ pressed }) => [styles.primaryButton, compact && { paddingHorizontal: spacing.sm }, (disabled || saving) && styles.disabled, pressed && { opacity: 0.8 }]}
      >
        <Text style={styles.primaryButtonText}>{saving ? 'Saving...' : title}</Text>
      </Pressable>
    </View>
  );
}

export function SecondaryButton({
  title,
  onPress,
  disabled = false,
  compact = false,
  icon,
  accessibilityLabel,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  compact?: boolean;
  icon?: IconName;
  accessibilityLabel?: string;
}) {
  return (
    <View style={styles.buttonClip}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? title}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        android_ripple={{ color: '#DDE5DC' }}
        style={({ pressed }) => [styles.secondaryButton, compact && { paddingHorizontal: icon ? spacing.md : spacing.sm }, disabled && styles.disabled, pressed && { backgroundColor: '#E2EAE4' }]}
      >
        {icon ? (
          <View style={styles.secondaryButtonRow}>
            <Ionicons name={icon} size={18} color={colors.primary} />
            <Text numberOfLines={1} style={styles.secondaryButtonText}>{title}</Text>
          </View>
        ) : <Text style={styles.secondaryButtonText}>{title}</Text>}
      </Pressable>
    </View>
  );
}

export const TextField = forwardRef<
  TextInput,
  TextInputProps & { label?: string; allowFuture?: boolean; allowPast?: boolean; money?: boolean; info?: string; optionalDate?: string }
>(function TextField(props, ref) {
  const {
    label,
    info,
    placeholder,
    value,
    onChangeText: propsOnChangeText,
    keyboardType,
    inputMode,
    maxLength,
    style,
    allowFuture,
    allowPast,
    optionalDate,
    money = keyboardType === 'decimal-pad' || keyboardType === 'numbers-and-punctuation',
    ...nativeProps
  } = props;
  const [moneySelection, setMoneySelection] = useState<TextInputProps['selection']>();
  const inputRef = useRef<TextInput | null>(null);
  const focusFormField = useContext(FormFocusContext);
  const latestSelection = useRef<{ start: number; end: number } | undefined>(undefined);
  const displayedValue = money && value !== undefined ? formatMoneyInput(value) : value;
  const isDateField = placeholder === 'DD-MM-YYYY';
  const hasInitializedDate = useRef(false);

  // A required date starts on today; an optional one (optionalDate) stays empty until chosen.
  useEffect(() => {
    if (
      !hasInitializedDate.current &&
      isDateField &&
      !optionalDate &&
      value === '' &&
      propsOnChangeText
    ) {
      hasInitializedDate.current = true;
      propsOnChangeText(dateKeyToInputDate());
    }
  }, [isDateField, optionalDate, value, propsOnChangeText]);

  if (isDateField) {
    return (
      <CalendarDateField
        label={label}
        info={info}
        value={value}
        onChangeText={propsOnChangeText}
        disabled={props.editable === false}
        allowFuture={allowFuture}
        allowPast={allowPast}
        optionalDate={optionalDate}
      />
    );
  }

  return (
    <View style={styles.field}>
      {label ? <View style={styles.labelWrap}><LabelWithInfo label={label} info={info} textStyle={styles.labelText} /></View> : null}
      <TextInput
        ref={(input) => { inputRef.current = input; if (typeof ref === 'function') ref(input); else if (ref) ref.current = input; }}
        placeholderTextColor={colors.muted}
        {...nativeProps}
        onFocus={(event) => { focusFormField(inputRef.current); props.onFocus?.(event); }}
        onBlur={(event) => { focusFormField(null); props.onBlur?.(event); }}
        placeholder={placeholder}
        accessibilityLabel={props.accessibilityLabel ?? label ?? placeholder}
        value={displayedValue}
        selection={money ? moneySelection : props.selection}
        onSelectionChange={(event) => {
          latestSelection.current = event.nativeEvent.selection;
          if (money) setMoneySelection(undefined);
          props.onSelectionChange?.(event);
        }}
        onChangeText={money ? (text) => {
          const edit = formatMoneyEdit(displayedValue ?? '', text, latestSelection.current);
          latestSelection.current = edit.selection;
          setMoneySelection(edit.selection);
          propsOnChangeText?.(edit.value);
        } : propsOnChangeText}
        keyboardType={keyboardType}
        inputMode={inputMode}
        maxLength={maxLength}
        style={[styles.input, style]}
      />
    </View>
  );
});

export function DateField({
  value,
  onChangeText,
  label = 'Date',
  allowFuture,
  allowPast,
  info,
}: {
  value: string;
  onChangeText: (value: string) => void;
  label?: string;
  allowFuture?: boolean;
  allowPast?: boolean;
  info?: string;
}) {
  return (
    <CalendarDateField
      label={label}
      info={info}
      value={value}
      onChangeText={onChangeText}
      allowFuture={allowFuture}
      allowPast={allowPast}
    />
  );
}

function CalendarDateField({
  label,
  info,
  value,
  onChangeText,
  disabled,
  allowFuture = false,
  allowPast = true,
  optionalDate,
}: {
  label?: string;
  info?: string;
  value?: TextInputProps['value'];
  onChangeText?: (value: string) => void;
  disabled?: boolean;
  allowFuture?: boolean;
  allowPast?: boolean;
  /** Text shown while no date is chosen, for a date that may be left empty. */
  optionalDate?: string;
}) {
  const { width } = useWindowDimensions();
  const { settings } = useAppData();
  const weekStart = settings?.week_start;
  const weekDays = getWeekdayLabels(weekStart);
  const calendarPageWidth = Math.min(
    maxCalendarPageWidth,
    width - spacing.md * 2 - spacing.lg * 2,
  );
  const [open, setOpen] = useState(false);
  const [baseDate, setBaseDate] = useState(() => getViewDate(value));
  const [monthIndex, setMonthIndex] = useState(calendarMonthRange);
  const calendarScrollRef = useRef<ScrollView>(null);
  const empty = !!optionalDate && !value;
  const displayValue = empty ? optionalDate : getInputDate(value);
  const selectedDateKey = empty ? null : inputDateToDateKey(displayValue);
  const todayDateKey = todayLocal();
  const calendarMonths = open ? getCalendarMonths(baseDate, allowFuture, allowPast) : [];
  const viewDate = calendarMonths[monthIndex] ?? baseDate;
  const nextMonth = calendarMonths[monthIndex + 1];
  const previousMonthDisabled = monthIndex <= 0;
  const nextMonthDisabled =
    monthIndex >= calendarMonths.length - 1 ||
    (!allowFuture &&
      !!nextMonth &&
      toDateKey(nextMonth) > todayDateKey.slice(0, 7) + '-01');

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      calendarScrollRef.current?.scrollTo({
        x: calendarPageWidth * monthIndex,
        animated: false,
      });
    });
  }, [calendarPageWidth, monthIndex, open]);

  function openCalendar() {
    // An existing overdue value stays saved, but a future-only calendar opens
    // on the current month instead of an unselectable past month.
    const viewDateKey = toDateKey(getViewDate(value));
    const nextBaseDate = parseDateKey(!allowPast && viewDateKey < todayLocal() ? todayLocal() : viewDateKey);
    const nextBaseDateMonth = new Date(
      nextBaseDate.getFullYear(),
      nextBaseDate.getMonth(),
      1,
    );
    const nextMonths = getCalendarMonths(nextBaseDateMonth, allowFuture, allowPast);
    setBaseDate(nextBaseDateMonth);
    setMonthIndex(getBaseMonthIndex(nextMonths, nextBaseDateMonth));
    setOpen(true);
  }

  function moveMonth(offset: number) {
    const nextIndex = Math.max(
      0,
      Math.min(calendarMonths.length - 1, monthIndex + offset),
    );
    calendarScrollRef.current?.scrollTo({
      x: calendarPageWidth * nextIndex,
      animated: true,
    });
    setMonthIndex(nextIndex);
  }

  function settleMonth(offsetX: number) {
    const nextIndex = Math.max(
      0,
      Math.min(
        calendarMonths.length - 1,
        Math.round(offsetX / calendarPageWidth),
      ),
    );
    if (nextIndex !== monthIndex) setMonthIndex(nextIndex);
  }

  function renderMonthGrid(monthDate: Date) {
    return (
      <View style={[styles.calendarGridPage, { width: calendarPageWidth }]}>
        {weekDays.map((day) => (
          <Text key={day} style={styles.calendarWeekday}>
            {day}
          </Text>
        ))}
        <View style={styles.calendarWeekDivider} />
        {getCalendarDates(monthDate, weekStart).map((date, index) => {
          const dateKey = date ? toDateKey(date) : '';
          const selected = dateKey === selectedDateKey;
          const isToday = dateKey === todayDateKey;
          const blocked = (!allowFuture && dateKey > todayDateKey) || (!allowPast && !!dateKey && dateKey < todayDateKey);
          const dateLabel = date?.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
          if (!date || blocked) {
            // Plain views, never touch handlers: a swipe that starts here must
            // reach the month pager (see the card note below).
            return (
              <View
                key={`${dateKey}-${index}`}
                style={styles.calendarCell}
                accessible={!!date}
                accessibilityLabel={date ? `${dateLabel}, not available` : undefined}
                accessibilityState={date ? { disabled: true } : undefined}
              >
                <Text style={[styles.calendarDayText, styles.calendarDayTextDisabled]}>
                  {date?.getDate() ?? ''}
                </Text>
              </View>
            );
          }

          return (
            <View key={`${dateKey}-${index}`} style={styles.calendarCell}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={isToday ? `${dateLabel}, today` : dateLabel}
                accessibilityState={{ selected }}
                onPress={() => selectDate(date)}
                style={({ pressed }) => [
                  styles.calendarDay,
                  isToday && !selected && styles.calendarDayToday,
                  pressed && !selected && styles.calendarDayPressed,
                  selected && styles.calendarDaySelected,
                ]}
              >
                <Text
                  style={[
                    styles.calendarDayText,
                    isToday && styles.calendarDayTextToday,
                    selected && styles.calendarDayTextSelected,
                  ]}
                >
                  {date.getDate()}
                </Text>
              </Pressable>
            </View>
          );
        })}
      </View>
    );
  }

  function selectDate(date: Date) {
    onChangeText?.(dateKeyToInputDate(toDateKey(date)));
    setOpen(false);
  }

  return (
    <View style={styles.field}>
      {label ? <View style={styles.labelWrap}><LabelWithInfo label={label} info={info} textStyle={styles.labelText} /></View> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Change ${label ?? 'date'}`}
        disabled={disabled}
        onPress={openCalendar}
        style={[styles.input, styles.dateInput, disabled && styles.disabled]}
      >
        <Text style={empty ? styles.dateInputEmpty : styles.dateInputText}>{displayValue}</Text>
        <Text style={styles.dateInputHint}>{empty ? 'Tap to choose' : 'Tap to change'}</Text>
      </Pressable>
      {open ? (
        <Modal
          transparent
          visible
          animationType="fade"
          onRequestClose={() => setOpen(false)}
        >
          <View style={styles.calendarOverlay}>
            {/* The backdrop is a sibling behind the card, not its parent. A
                pressable card would take over any touch that starts on a
                greyed-out or empty cell and block the month swipe. */}
            <Pressable
              accessibilityLabel="Close calendar"
              style={StyleSheet.absoluteFill}
              onPress={() => setOpen(false)}
            />
            <View style={styles.calendarCard}>
              <View style={styles.calendarHeader}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Previous month"
                  disabled={previousMonthDisabled}
                  onPress={() => moveMonth(-1)}
                  style={[
                    styles.calendarNavButton,
                    previousMonthDisabled && styles.calendarNavButtonDisabled,
                  ]}
                >
                  <Ionicons
                    name="chevron-back"
                    size={22}
                    color={
                      previousMonthDisabled ? colors.muted : colors.primary
                    }
                  />
                </Pressable>
                <Text style={styles.calendarTitle}>
                  {viewDate.toLocaleDateString(undefined, {
                    month: 'long',
                    year: 'numeric',
                  })}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Next month"
                  disabled={nextMonthDisabled}
                  onPress={() => moveMonth(1)}
                  style={[
                    styles.calendarNavButton,
                    nextMonthDisabled && styles.calendarNavButtonDisabled,
                  ]}
                >
                  <Ionicons
                    name="chevron-forward"
                    size={22}
                    color={nextMonthDisabled ? colors.muted : colors.primary}
                  />
                </Pressable>
              </View>
              <ScrollView
                ref={calendarScrollRef}
                horizontal
                pagingEnabled
                disableIntervalMomentum
                directionalLockEnabled
                showsHorizontalScrollIndicator={false}
                scrollEventThrottle={16}
                decelerationRate="fast"
                snapToInterval={calendarPageWidth}
                snapToAlignment="start"
                onMomentumScrollEnd={(event) =>
                  settleMonth(event.nativeEvent.contentOffset.x)
                }
                style={[styles.calendarPager, { width: calendarPageWidth }]}
                contentContainerStyle={styles.calendarPagerContent}
              >
                {calendarMonths.map((month) => (
                  <View
                    key={`${month.getFullYear()}-${month.getMonth()}`}
                    style={[
                      styles.calendarPagerPage,
                      { width: calendarPageWidth },
                    ]}
                  >
                    {renderMonthGrid(month)}
                  </View>
                ))}
              </ScrollView>
              <View style={styles.calendarActions}>
                <SecondaryButton
                  title="Today"
                  onPress={() => selectDate(parseDateKey(todayLocal()))}
                />
                {optionalDate && value ? <SecondaryButton
                  title="Clear"
                  onPress={() => { onChangeText?.(''); setOpen(false); }}
                /> : null}
                <SecondaryButton
                  title="Cancel"
                  onPress={() => setOpen(false)}
                />
              </View>
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

export function SectionHeader({ title, info }: { title: string; info?: string }) {
  if (!info) return <Text style={styles.section}>{title}</Text>;
  return <View style={styles.sectionWrap}><LabelWithInfo label={title} info={info} textStyle={styles.sectionText} /></View>;
}

export function EmptyState({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <View accessibilityRole="text" accessibilityLiveRegion="polite" style={styles.empty}>
      <Text style={styles.body}>{title}</Text>
      {subtitle ? <Text style={styles.muted}>{subtitle}</Text> : null}
    </View>
  );
}

/** `over` turns the fill amber, e.g. when spending has gone past its plan. */
export function ProgressBar({ value, over = false }: { value: number; over?: boolean }) {
  return (
    <View style={styles.progressTrack}>
      <View
        style={[
          styles.progressFill,
          { width: `${Math.max(0, Math.min(100, value))}%` },
          over ? { backgroundColor: colors.warning } : null,
        ]}
      />
    </View>
  );
}

export function MoneyText({
  amount,
  type,
  style,
  currency,
}: {
  amount: number;
  type?: 'positive' | 'negative' | 'neutral';
  style?: TextStyle;
  /** The amount's own currency; otherwise the currency of this part of the screen. */
  currency?: string | null;
}) {
  const displayCurrency = useDisplayCurrency();
  const color =
    type === 'positive'
      ? colors.positive
      : type === 'negative'
        ? colors.negative
        : colors.text;
  return (
    <Text style={[styles.money, { color }, style]}>
      {formatMoney(amount, currency || displayCurrency)}
    </Text>
  );
}

function isLightColor(hex: string): boolean {
  const value = Number.parseInt(hex.replace('#', '').slice(0, 6), 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 160;
}

/** Round leading icon; expense/income get a faint red/green wash, everything else stays Sage. */
export function RowIcon({ name, tone = 'neutral', color: customColor }: { name: IconName; tone?: IconTone; color?: string }) {
  // A custom colour (a chart legend) fills the circle so it matches its slice exactly;
  // the icon switches to dark or white for contrast.
  const background = customColor ?? (tone === 'negative' ? tones.negativeContainer : tone === 'positive' ? tones.positiveContainer : tones.primaryContainer);
  const color = customColor ? (isLightColor(customColor) ? colors.text : colors.surface) : tone === 'negative' ? colors.negative : tone === 'positive' ? colors.positive : colors.primary;
  return <View style={[styles.rowIcon, { backgroundColor: background }]}><Ionicons name={name} size={20} color={color} /></View>;
}

export function ListRow({
  title,
  subtitle,
  right,
  onPress,
  preview = false,
  verticalPadding,
  icon,
  iconTone,
  iconColor,
  card = false,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  onPress?: () => void;
  preview?: boolean;
  verticalPadding?: number;
  icon?: IconName;
  iconTone?: IconTone;
  /** Overrides the tone colour, e.g. to match a chart legend. */
  iconColor?: string;
  /** Full-width rounded card with margins (Transactions, Recent Activity) instead of a divider row. */
  card?: boolean;
}) {
  if (card) {
    return (
      <PressableScale
        onPress={onPress}
        accessibilityRole={onPress ? 'button' : undefined}
        accessibilityLabel={onPress ? title : undefined}
        accessibilityState={{ disabled: !onPress }}
        disabled={!onPress}
        android_ripple={{ color: tones.pressed }}
        containerStyle={styles.rowCardOuter}
        style={[styles.rowCard, preview && { minHeight: verticalPadding !== undefined ? 0 : 56 }, verticalPadding !== undefined && { paddingVertical: verticalPadding }]}
      >
        {icon ? <RowIcon name={icon} tone={iconTone} color={iconColor} /> : null}
        <View style={styles.rowText}>
          <Text numberOfLines={1} style={styles.body}>{title}</Text>
          {subtitle ? <Text numberOfLines={preview ? 1 : 2} style={styles.muted}>{subtitle}</Text> : null}
        </View>
        {right}
      </PressableScale>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={onPress ? title : undefined}
      accessibilityState={{ disabled: !onPress }}
      disabled={!onPress}
      style={[styles.row, preview && { minHeight: 48, paddingVertical: verticalPadding ?? spacing.md }]}
    >
      {icon ? <RowIcon name={icon} tone={iconTone} color={iconColor} /> : null}
      <View style={styles.rowText}>
        <Text numberOfLines={preview ? 1 : undefined} style={styles.body}>{title}</Text>
        {subtitle ? <Text numberOfLines={preview ? 1 : undefined} style={styles.muted}>{subtitle}</Text> : null}
      </View>
      {right}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    position: 'relative',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  header: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  title: {
    color: colors.text,
    fontSize: typography.title,
    fontWeight: '700',
    lineHeight: 34,
  },
  section: {
    marginTop: spacing.xl,
    marginBottom: spacing.md,
    color: colors.text,
    fontSize: typography.section,
    fontWeight: '600',
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    padding: spacing.lg,
    // Stacked cards (group balances, shared bills, settings) keep the same gap as list cards.
    marginBottom: spacing.sm,
  },
  body: {
    color: colors.text,
    fontSize: typography.body,
    fontWeight: '500',
  },
  muted: {
    color: colors.muted,
    fontSize: typography.secondary,
    marginTop: spacing.xs,
  },
  primaryButton: {
    minHeight: 48,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  buttonClip: {
    borderRadius: radius.md,
    overflow: 'hidden',
    marginVertical: spacing.xs,
  },
  secondaryButtonRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  primaryButtonText: {
    textAlign: 'center',
    color: colors.surface,
    fontSize: 16,
    fontWeight: '700',
  },
  secondaryButton: {
    minHeight: 48,
    borderRadius: radius.md,
    borderColor: colors.border,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
  },
  secondaryButtonText: {
    textAlign: 'center',
    color: colors.primary,
    fontSize: 16,
    fontWeight: '700',
  },
  disabled: {
    opacity: 0.45,
  },
  field: {
    marginBottom: spacing.lg,
  },
  label: {
    color: colors.text,
    marginBottom: spacing.sm,
    fontWeight: '600',
  },
  input: {
    minHeight: 48,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    paddingHorizontal: spacing.lg,
    fontSize: 16,
  },
  dateInput: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dateInputText: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '500',
  },
  dateInputHint: {
    color: colors.muted,
    fontSize: 12,
  },
  dateInputEmpty: {
    color: colors.muted,
    fontSize: 16,
  },
  calendarOverlay: {
    flex: 1,
    justifyContent: 'center',
    // Same Sage-tinted scrim as the app's dialogs.
    backgroundColor: 'rgba(38, 51, 45, 0.35)',
    padding: spacing.md,
  },
  calendarCard: {
    width: '100%',
    maxWidth: 380,
    alignSelf: 'center',
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: spacing.lg,
    ...elevation.level3,
  },
  calendarHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  calendarTitle: {
    flex: 1,
    color: colors.text,
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  calendarNavButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tones.primaryContainer,
  },
  calendarNavButtonDisabled: {
    backgroundColor: 'transparent',
    opacity: 0.45,
  },
  calendarPager: {
    alignSelf: 'center',
    height: 308,
    overflow: 'hidden',
  },
  calendarPagerContent: {
    minHeight: 308,
  },
  calendarPagerPage: {
    minHeight: 308,
  },
  calendarGridPage: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    minHeight: 308,
  },
  calendarWeekday: {
    width: '14.285%',
    textAlign: 'center',
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },
  calendarWeekDivider: {
    width: '100%',
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginBottom: spacing.xs,
  },
  calendarCell: {
    width: '14.285%',
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  calendarDay: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  calendarDayToday: {
    borderWidth: 1.5,
    borderColor: colors.primary,
  },
  calendarDayPressed: {
    backgroundColor: tones.pressed,
  },
  calendarDaySelected: {
    backgroundColor: colors.primary,
  },
  calendarDayText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  calendarDayTextToday: {
    color: colors.primary,
    fontWeight: '700',
  },
  calendarDayTextSelected: {
    color: colors.surface,
  },
  calendarDayTextDisabled: {
    color: colors.muted,
    fontWeight: '400',
    opacity: 0.5,
  },
  calendarActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  empty: {
    paddingVertical: spacing.xxl,
    alignItems: 'center',
  },
  progressTrack: {
    height: 8,
    backgroundColor: '#E4E8DF',
    borderRadius: radius.pill,
    overflow: 'hidden',
    marginVertical: spacing.md,
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.primary,
  },
  row: {
    minHeight: 60,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    columnGap: spacing.md,
  },
  rowText: {
    flex: 1,
  },
  rowCardOuter: {
    marginBottom: spacing.sm,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  rowCard: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
  },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  labelWrap: { marginBottom: spacing.sm },
  labelText: { color: colors.text, fontWeight: '600' },
  sectionWrap: { marginTop: spacing.xl, marginBottom: spacing.md },
  sectionText: { color: colors.text, fontSize: typography.section, fontWeight: '600' },
  money: {
    fontSize: 16,
    fontWeight: '700',
  },
});

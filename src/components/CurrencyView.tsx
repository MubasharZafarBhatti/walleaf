import { createContext, useContext, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useCurrencyInfo } from '../hooks/useCurrencyInfo';
import type { Account } from '../types/models';
import { colors, radius, spacing, tones, typography } from '../theme';
import { formatMoney, currencySymbol } from '../utils/money';
import { PressableScale } from './PressableScale';

// Amounts are always shown in the currency they belong to. A screen (or part of
// one) that shows a single currency wraps its content in <CurrencyProvider>, and
// every MoneyText and money formatter inside uses that currency.

const DisplayCurrency = createContext<string | null>(null);

export function CurrencyProvider({ currency, children }: { currency: string; children: ReactNode }) {
  return <DisplayCurrency.Provider value={currency}>{children}</DisplayCurrency.Provider>;
}

/** The currency amounts in this part of the screen are in: the nearest provider's, otherwise the main currency. */
export function useDisplayCurrency(): string {
  const provided = useContext(DisplayCurrency);
  const { mainCurrency } = useCurrencyInfo();
  return provided ?? mainCurrency;
}

/** Formats an amount in this part of the screen's currency, or in the one given. */
export function useMoney() {
  const currency = useDisplayCurrency();
  return (amountMinor: number, inCurrency?: string | null) => formatMoney(amountMinor, inCurrency || currency);
}

/** "Cash (Rs.)" and "Cash ($)" once the user has more than one currency; just the name otherwise. */
export function useAccountLabel() {
  const { currencies } = useCurrencyInfo();
  const multi = currencies.length > 1;
  return (account: Pick<Account, 'name' | 'currency'>) => (multi ? `${account.name} (${currencySymbol(account.currency)})` : account.name);
}

/** "Amount (Rs.)" once more than one currency is in play; just "Amount" otherwise. */
export function useMoneyLabel() {
  const { currencies, mainCurrency } = useCurrencyInfo();
  return (label: string, currency: string | null | undefined) =>
    currency && (currencies.length > 1 || currency !== mainCurrency) ? `${label} (${currencySymbol(currency)})` : label;
}

/**
 * Chooses which currency the summary screens show. Hidden while the user has a
 * single currency, so nothing changes for them.
 */
export function CurrencySwitch({ options, value, onChange }: { options?: string[]; value?: string; onChange?: (currency: string) => void } = {}) {
  const data = useCurrencyInfo();
  const currencies = options ?? data.currencies;
  const viewCurrency = value ?? data.viewCurrency;
  const setViewCurrency = onChange ?? data.setViewCurrency;
  if (currencies.length < 2) return null;
  return (
    <View accessibilityRole="tablist" style={styles.row}>
      {currencies.map((currency) => {
        const selected = currency === viewCurrency;
        return (
          <PressableScale
            key={currency}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={`Show amounts in ${currency}`}
            onPress={() => setViewCurrency(currency)}
            android_ripple={{ color: tones.pressed }}
            style={[styles.chip, selected ? styles.selected : null]}
          >
            <Text style={[styles.label, selected ? styles.selectedLabel : null]}>{`${currencySymbol(currency)}  ${currency}`}</Text>
          </PressableScale>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  chip: {
    minHeight: 40,
    paddingHorizontal: spacing.lg,
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  selected: { backgroundColor: tones.primaryContainer, borderColor: tones.primaryContainer },
  label: { color: colors.muted, fontSize: typography.secondary, fontWeight: '600' },
  selectedLabel: { color: tones.onPrimaryContainer },
});

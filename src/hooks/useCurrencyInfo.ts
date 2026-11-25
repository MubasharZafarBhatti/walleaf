import { useMemo } from 'react';
import { useAppData } from './useAppData';
import { currenciesInUse, scopeToCurrency, type CurrencyData } from '../services/currency/CurrencyScope';

// Stable empty lists keep memoized results stable when a list is not loaded yet.
const none: never[] = [];

/**
 * The user's currencies: the main one (chosen in Settings), every account's
 * currency (archived ones included) and the one the summary screens show.
 */
export function useCurrencyInfo() {
  const data = useAppData();
  const mainCurrency = data.mainCurrency || data.settings?.currency || 'PKR';
  const accounts = data.accounts ?? none;
  const accountCurrency = useMemo(
    () => data.accountCurrency ?? new Map(accounts.map((account) => [account.id, account.currency])),
    [data.accountCurrency, accounts],
  );
  const currencies = data.currencies ?? currenciesInUse(accounts, mainCurrency);
  return {
    mainCurrency,
    accountCurrency,
    currencies,
    viewCurrency: data.viewCurrency ?? mainCurrency,
    setViewCurrency: data.setViewCurrency ?? (() => {}),
  };
}

/**
 * The records of one currency (by default the one the summary screens show),
 * so totals, plans and charts are worked out one currency at a time.
 */
export function useCurrencyData(currency?: string): CurrencyData & { currency: string; accountIds: Set<string> } {
  const data = useAppData();
  const { accountCurrency, mainCurrency, viewCurrency } = useCurrencyInfo();
  const selected = currency ?? viewCurrency;
  const transactions = data.transactions ?? none;
  const entries = data.entries ?? none;
  const budgets = data.budgets ?? none;
  const goals = data.goals ?? none;
  const subscriptions = data.subscriptions ?? none;
  const plannedPayments = data.plannedPayments ?? none;
  return useMemo(
    () => ({ currency: selected, ...scopeToCurrency({ transactions, entries, budgets, goals, subscriptions, plannedPayments }, accountCurrency, selected, mainCurrency) }),
    [selected, accountCurrency, transactions, entries, budgets, goals, subscriptions, plannedPayments, mainCurrency],
  );
}

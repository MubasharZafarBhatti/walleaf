import type { Account, Budget, Goal, PersonEntry, PlannedPayment, Subscription, Transaction } from '../../types/models';
import { currencyRows } from '../../utils/currency';
import { calculatePersonBalance } from '../people/PeopleBalanceService';

// Every record takes the currency of its account and amounts in different
// currencies are never added together or converted. Totals are worked out one
// currency at a time by giving the existing calculations only that currency's records.

export type CurrencyAmount = { currency: string; amountMinor: number };
type AccountLike = Pick<Account, 'id' | 'currency'> & Partial<Pick<Account, 'deleted_at' | 'is_archived'>>;

export function currencyCodes(): string[] {
  return currencyRows.map(([code]) => code);
}

/** Puts currencies in one stable order: the main currency first, then the list order. */
export function orderCurrencies(currencies: Iterable<string>, mainCurrency: string): string[] {
  const set = new Set(currencies);
  return [mainCurrency, ...currencyCodes().filter((code) => code !== mainCurrency && set.has(code))].filter((code) => set.has(code));
}

/** The currencies the user works in: the main one, plus any other active account's. */
export function currenciesInUse(accounts: readonly AccountLike[], mainCurrency: string): string[] {
  const used = new Set(accounts.filter((account) => !account.deleted_at && !account.is_archived).map((account) => account.currency));
  used.add(mainCurrency);
  return orderCurrencies(used, mainCurrency);
}

export function accountCurrencies(accounts: readonly AccountLike[]): Map<string, string> {
  return new Map(accounts.map((account) => [account.id, account.currency]));
}

export function accountCurrency(accounts: readonly AccountLike[], accountId: string | null | undefined, fallback: string): string {
  return (accountId ? accounts.find((account) => account.id === accountId)?.currency : undefined) ?? fallback;
}

/** True for a move between two accounts that use different currencies. */
export function isExchange(tx: Pick<Transaction, 'type' | 'destination_amount_minor'>): boolean {
  return tx.type === 'TRANSFER' && tx.destination_amount_minor != null;
}

export type CurrencyData = {
  transactions: Transaction[];
  entries: PersonEntry[];
  budgets: Budget[];
  goals: Goal[];
  subscriptions: Subscription[];
  plannedPayments: PlannedPayment[];
};

/**
 * Only the records in one currency. A move between currencies belongs to both
 * sides, so each account still sees the money that left or arrived.
 */
export function scopeToCurrency(data: CurrencyData, currencyOf: ReadonlyMap<string, string>, currency: string, mainCurrency: string): CurrencyData & { accountIds: Set<string> } {
  const inCurrency = (accountId: string | null | undefined) => (accountId ? currencyOf.get(accountId) ?? mainCurrency : mainCurrency) === currency;
  return {
    accountIds: new Set([...currencyOf].filter(([, code]) => code === currency).map(([id]) => id)),
    transactions: data.transactions.filter((tx) => inCurrency(tx.account_id) || (tx.type === 'TRANSFER' && inCurrency(tx.destination_account_id))),
    entries: data.entries.filter((entry) => inCurrency(entry.account_id)),
    budgets: data.budgets.filter((budget) => (budget.currency ?? mainCurrency) === currency),
    goals: data.goals.filter((goal) => (goal.currency ?? mainCurrency) === currency),
    subscriptions: data.subscriptions.filter((item) => inCurrency(item.account_id)),
    plannedPayments: data.plannedPayments.filter((item) => inCurrency(item.account_id)),
  };
}

/** Adds amounts per currency; never across currencies. Main currency first. */
export function sumByCurrency<T>(items: readonly T[], currencyOf: (item: T) => string, amountOf: (item: T) => number, mainCurrency: string): CurrencyAmount[] {
  const totals = new Map<string, number>();
  for (const item of items) {
    const currency = currencyOf(item);
    const next = (totals.get(currency) ?? 0) + amountOf(item);
    if (!Number.isSafeInteger(next)) throw new Error('Money total is outside the supported range.');
    totals.set(currency, next);
  }
  return orderCurrencies(totals.keys(), mainCurrency).map((currency) => ({ currency, amountMinor: totals.get(currency)! }));
}

/** A person's balance in each currency they have records in, main currency first. Zero balances are dropped. */
export function personBalancesByCurrency(entries: readonly PersonEntry[], currencyOf: ReadonlyMap<string, string>, mainCurrency: string): CurrencyAmount[] {
  const byCurrency = new Map<string, PersonEntry[]>();
  for (const entry of entries) {
    const currency = currencyOf.get(entry.account_id) ?? mainCurrency;
    byCurrency.set(currency, [...(byCurrency.get(currency) ?? []), entry]);
  }
  return orderCurrencies(byCurrency.keys(), mainCurrency)
    .map((currency) => ({ currency, amountMinor: calculatePersonBalance(byCurrency.get(currency)!) }))
    .filter((balance) => balance.amountMinor !== 0);
}

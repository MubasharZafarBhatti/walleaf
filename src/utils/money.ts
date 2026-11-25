/** Presentation only. Invalid text is retained for the authoritative parser to reject. */
export function formatMoneyInput(value: string): string {
  const clean = value.replace(/,/g, '');
  if (!/^-?\d*(?:\.\d*)?$/.test(clean)) return value;
  const sign = clean.startsWith('-') ? '-' : '';
  const unsigned = sign ? clean.slice(1) : clean;
  const [integer, decimal] = unsigned.split('.');
  const whole = integer.replace(/^0+(?=\d)/, '') || (decimal !== undefined ? '0' : '');
  return sign + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (decimal === undefined ? '' : `.${decimal}`);
}

export function formatMoneyEdit(previous: string, text: string, selection?: { start: number; end: number }) {
  const value = formatMoneyInput(text);
  let prefix = 0;
  while (prefix < previous.length && prefix < text.length && previous[prefix] === text[prefix]) prefix++;
  let suffix = 0;
  while (suffix < previous.length - prefix && suffix < text.length - prefix && previous[previous.length - 1 - suffix] === text[text.length - 1 - suffix]) suffix++;
  let caret = text.length - suffix;
  if (selection) {
    const inserted = text.length - (previous.length - (selection.end - selection.start));
    if (inserted >= 0 && text.slice(0, selection.start) === previous.slice(0, selection.start) && text.slice(selection.start + inserted) === previous.slice(selection.end)) caret = selection.start + inserted;
  }
  // Count semantic characters, not grouping separators, on either side of the edit.
  const right = text.slice(caret).replace(/,/g, '').length;
  let position = value.length;
  let remaining = right;
  while (position > 0 && remaining > 0) { position--; if (value[position] !== ',') remaining--; }
  if (/^-?0$/.test(value)) position = value.length;
  return { value, selection: { start: position, end: position } };
}

export function moneyToMinorUnits(value: string | number): number {
  const normalized = String(value).replace(/,/g, '').trim();
  if (!/^\d+(\.\d{0,2})?$/.test(normalized)) return NaN;
  const [whole, decimals = ''] = normalized.split('.');
  return Number(whole) * 100 + Number(decimals.padEnd(2, '0').slice(0, 2));
}

export function signedMoneyToMinorUnits(value: string | number): number {
  const normalized = String(value).replace(/,/g, '').trim();
  if (!/^-?\d+(\.\d{0,2})?$/.test(normalized)) return NaN;
  const negative = normalized.startsWith('-');
  const amount = moneyToMinorUnits(negative ? normalized.slice(1) : normalized);
  return negative ? -amount : amount;
}

export function minorUnitsToMoney(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100);
  const decimals = abs % 100;
  return `${sign}${whole}${decimals ? `.${String(decimals).padStart(2, '0')}` : ''}`;
}

const currencyPrefixes: Record<string, string> = {
  PKR: 'Rs.',
  USD: '$',
  EUR: '€',
  GBP: '£',
  AED: 'AED',
  SAR: 'SAR',
};

const compactCurrencies = new Set(['USD', 'EUR', 'GBP']);

/** The short sign shown before amounts (Rs., $, €). */
export function currencySymbol(currency: string): string {
  const code = currency.toUpperCase();
  return currencyPrefixes[code] ?? code;
}

export function formatMoney(minor: number, currency = 'PKR'): string {
  const sign = minor < 0 ? '- ' : '';
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100).toLocaleString();
  const decimals = abs % 100;
  const code = currency.toUpperCase();
  const prefix = currencyPrefixes[code] ?? code;
  const separator = compactCurrencies.has(code) ? '' : ' ';
  return `${sign}${prefix}${separator}${whole}${decimals ? `.${String(decimals).padStart(2, '0')}` : ''}`;
}

/** What an exchange cost, for information only: "Your rate: $1 = Rs. 278.50". Nothing is converted with it. */
export function exchangeRateText(fromCurrency: string, toCurrency: string, sentMinor: number, receivedMinor: number): string {
  const rate = receivedMinor / sentMinor;
  const [one, other, value] = rate >= 1 ? [fromCurrency, toCurrency, rate] : [toCurrency, fromCurrency, 1 / rate];
  const code = other.toUpperCase();
  const amount = value >= 100 ? value.toFixed(2) : value.toFixed(4).replace(/0{1,2}$/, '');
  return `Your rate: ${formatMoney(100, one)} = ${currencySymbol(code)}${compactCurrencies.has(code) ? '' : ' '}${amount}`;
}

export function addMoney(...values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

import type { ComponentProps } from 'react';
import type { Ionicons } from '@expo/vector-icons';

export type IconName = ComponentProps<typeof Ionicons>['name'];

// Display-only icons for categories. Stored rows keep their saved `icon` value
// (no migration): default categories were all seeded with the same generic icon,
// so names decide the icon and a custom saved icon wins when it is specific.
const byName: Record<string, IconName> = {
  food: 'restaurant-outline', groceries: 'cart-outline', grocery: 'cart-outline', transport: 'bus-outline', travel: 'airplane-outline',
  shopping: 'bag-handle-outline', bills: 'receipt-outline', utilities: 'flash-outline', education: 'school-outline',
  entertainment: 'film-outline', health: 'medkit-outline', medical: 'medkit-outline', fuel: 'speedometer-outline',
  rent: 'home-outline', subscriptions: 'repeat-outline', gifts: 'gift-outline', other: 'ellipsis-horizontal-outline',
  salary: 'briefcase-outline', freelance: 'laptop-outline', business: 'storefront-outline', 'gift received': 'gift-outline',
  refund: 'return-down-back-outline', 'other income': 'cash-outline',
};
const byKeyword: [RegExp, IconName][] = [
  [/food|lunch|dinner|dining|breakfast|meal|restaurant|\beat/, 'restaurant-outline'], [/coffee|cafe|tea/, 'cafe-outline'], [/grocer|mart|store/, 'cart-outline'],
  [/\bcar\b|taxi|uber|careem|bus|transport|ride/, 'car-outline'], [/fuel|petrol|gas/, 'speedometer-outline'], [/travel|flight|trip/, 'airplane-outline'],
  [/phone|mobile|internet|wifi/, 'phone-portrait-outline'], [/electric|power|utility/, 'flash-outline'], [/water/, 'water-outline'],
  [/rent|house|home/, 'home-outline'], [/school|education|course|book/, 'school-outline'], [/health|medic|doctor|pharma/, 'medkit-outline'],
  [/gym|fitness|sport/, 'fitness-outline'], [/cloth|fashion|shirt/, 'shirt-outline'], [/\bpets?\b/, 'paw-outline'], [/gam(e|ing)/, 'game-controller-outline'],
  [/donat|charity|zakat|sadq|sadaq/, 'heart-outline'], [/insur/, 'shield-checkmark-outline'], [/loan|emi|instal|credit card/, 'card-outline'],
  [/saving|allowance|pocket/, 'wallet-outline'], [/kid|child|baby/, 'happy-outline'], [/bonus|commission/, 'trending-up-outline'],
  [/gift/, 'gift-outline'], [/salary|wage|pay/, 'briefcase-outline'], [/invest|profit|dividend/, 'trending-up-outline'], [/subscri/, 'repeat-outline'],
];
const generic = new Set(['pricetag-outline', 'cash-outline', '']);

export function categoryIcon(category: { name?: string | null; type?: string | null; icon?: string | null } | null | undefined): IconName {
  const name = (category?.name ?? '').trim().toLowerCase();
  if (byName[name]) return byName[name];
  if (category?.icon && !generic.has(category.icon)) return category.icon as IconName;
  const keyword = byKeyword.find(([pattern]) => pattern.test(name));
  if (keyword) return keyword[1];
  // A custom name with no known icon: the same arrows as the Add sheet's
  // Expense / Income choices, so the row still says which way the money went.
  return category?.type === 'INCOME' ? INCOME_ICON : EXPENSE_ICON;
}
export const EXPENSE_ICON: IconName = 'arrow-up-outline';
export const INCOME_ICON: IconName = 'arrow-down-outline';

export type IconTone = 'neutral' | 'negative' | 'positive';

/** Leading icon for an activity row: people, groups, transfers, adjustments, or the category. */
export function activityIcon(row: { kind: string; type: string; category_name?: string | null; group_id?: string | null }): { name: IconName; tone: IconTone } {
  if (row.kind === 'person') return { name: 'person-outline', tone: 'neutral' };
  if (row.kind === 'shared') return { name: row.group_id ? 'people-outline' : 'people-circle-outline', tone: 'negative' };
  if (row.type === 'TRANSFER') return { name: 'swap-horizontal-outline', tone: 'neutral' };
  if (row.type === 'ADJUSTMENT') return { name: 'options-outline', tone: 'neutral' };
  const income = row.type === 'INCOME';
  return { name: categoryIcon({ name: row.category_name, type: income ? 'INCOME' : 'EXPENSE' }), tone: income ? 'positive' : row.type === 'EXPENSE' ? 'negative' : 'neutral' };
}

/** Picker rows for categories: [id, label, icon]. */
export function categoryRows<T extends { id: string; name: string; type?: string | null; icon?: string | null }>(list: readonly T[], label: (category: T) => string = (category) => category.name): string[][] {
  return list.map((category) => [category.id, label(category), categoryIcon(category)]);
}

/** Account type icons: Cash, Bank, e-wallet (Easypaisa, JazzCash…), other. */
export function accountIcon(type: string | null | undefined): IconName {
  return type === 'CASH' ? 'cash-outline' : type === 'BANK' ? 'business-outline' : type === 'EWALLET' ? 'phone-portrait-outline' : 'wallet-outline';
}

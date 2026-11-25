import { suggestCategory } from '../services/categories/CategoryService';
import type { Category, Transaction } from '../types/models';

const category = (id: string, name: string, type: Category['type'], is_archived = 0): Category => ({ id, name, type, is_archived, icon: '', color_key: '', is_default: 0, created_at: '', updated_at: '', sync_status: 'LOCAL' });
const transaction = (id: string, category_id: string, occurred_on: string, type: Transaction['type'] = 'EXPENSE'): Transaction => ({ id, category_id, occurred_on, type, title: '  Shell   Station ', note: '  card   ', amount_minor: 100, account_id: 'cash', source: 'MANUAL', created_at: '', updated_at: '', sync_status: 'LOCAL' });

test('suggestion requires two exact normalized local matches and never changes a selection itself', () => {
  const categories = [category('fuel', 'Fuel', 'EXPENSE'), category('food', 'Food', 'EXPENSE')];
  expect(suggestCategory(categories, [transaction('one', 'fuel', '2026-09-01')], 'EXPENSE', 'shell station', 'card')).toBeNull();
  expect(suggestCategory(categories, [transaction('one', 'fuel', '2026-09-01'), transaction('two', 'fuel', '2026-09-02')], 'EXPENSE', 'shell station', 'card')?.id).toBe('fuel');
});

test('suggestion isolates type, ignores archived categories, then ranks count, recency, and ID', () => {
  const categories = [category('a', 'Fuel A', 'EXPENSE'), category('b', 'Fuel B', 'EXPENSE'), category('income', 'Fuel income', 'INCOME'), category('archived', 'Old fuel', 'EXPENSE', 1)];
  const rows = [transaction('1', 'a', '2026-09-01'), transaction('2', 'a', '2026-09-03'), transaction('3', 'b', '2026-09-04'), transaction('4', 'b', '2026-09-05'), transaction('5', 'income', '2026-09-10', 'INCOME'), transaction('6', 'income', '2026-09-11', 'INCOME'), transaction('7', 'archived', '2026-09-20'), transaction('8', 'archived', '2026-09-21')];
  expect(suggestCategory(categories, rows, 'EXPENSE', 'Shell Station', 'card')?.id).toBe('b');
  expect(suggestCategory(categories, rows, 'INCOME', 'Shell Station', 'card')?.id).toBe('income');
});

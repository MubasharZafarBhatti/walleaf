import type { Category, CategoryType, Transaction } from '../../types/models';

export function normalizeCategoryEvidence(value: string | null | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

export function categoryEvidence(title: string | null | undefined, note?: string | null): string {
  return `${normalizeCategoryEvidence(title)}\n${normalizeCategoryEvidence(note)}`;
}

export function suggestCategory(
  categories: Category[],
  transactions: Transaction[] | undefined,
  type: CategoryType,
  title: string,
  note?: string | null,
): Category | null {
  const evidence = categoryEvidence(title, note);
  if (!normalizeCategoryEvidence(title)) return null;
  const active = new Map(
    categories
      .filter((category) => category.type === type && !category.is_archived && !category.deleted_at)
      .map((category) => [category.id, category]),
  );
  const ranked = new Map<string, { count: number; occurredOn: string }>();
  for (const transaction of transactions ?? []) {
    if (transaction.type !== type || !transaction.category_id || transaction.deleted_at || categoryEvidence(transaction.title, transaction.note) !== evidence) continue;
    if (!active.has(transaction.category_id)) continue;
    const current = ranked.get(transaction.category_id) ?? { count: 0, occurredOn: '' };
    ranked.set(transaction.category_id, {
      count: current.count + 1,
      occurredOn: transaction.occurred_on > current.occurredOn ? transaction.occurred_on : current.occurredOn,
    });
  }
  const winner = [...ranked.entries()]
    .filter(([, rank]) => rank.count >= 2)
    .sort(([leftId, left], [rightId, right]) =>
      right.count - left.count || right.occurredOn.localeCompare(left.occurredOn) || leftId.localeCompare(rightId),
    )[0];
  return winner ? active.get(winner[0]) ?? null : null;
}

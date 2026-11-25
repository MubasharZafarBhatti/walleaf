/** Groups rows by a key in one pass (instead of filtering the whole list once per owner). */
export function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const list = groups.get(id);
    if (list) list.push(row); else groups.set(id, [row]);
  }
  return groups;
}

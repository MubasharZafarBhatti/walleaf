import { isActivityDate } from '../activity/ActivityService';

/** Format versions describe JSON contracts, independently of SQLite migrations. */
export const BACKUP_VERSION = 1;
export const BACKUP_SCHEMA_VERSION = 14;
export const BACKUP_COMPATIBLE_SCHEMA_VERSIONS = [8, 9, 10, 11, 12, 13, 14] as const;
export const BACKUP_APP = 'expense-tracker-expo';
export const MAX_BACKUP_BYTES = 25 * 1024 * 1024;
// Parent-first; deletion reverses this order. Includes tombstones and archives.
export const BACKUP_TABLES = [
  'app_settings', 'accounts', 'categories', 'people', 'groups', 'group_members',
  'budgets', 'goals', 'goal_entries', 'planned_payments', 'subscriptions',
  'split_groups', 'split_participants', 'transactions', 'person_entries',
  'planned_payment_occurrences', 'subscription_payments', 'entry_allocations',
  'allocation_exclusions', 'group_settlement_requests',
] as const;
export type BackupTable = typeof BACKUP_TABLES[number];
export type BackupRow = Record<string, string | number | null>;
export type Backup = {
  app: typeof BACKUP_APP;
  backupVersion: typeof BACKUP_VERSION;
  schemaVersion: typeof BACKUP_COMPATIBLE_SCHEMA_VERSIONS[number];
  appVersion: string;
  createdAt: string;
  data: Record<BackupTable, BackupRow[]>;
};
export type BackupColumn = { name: string; type: string; notnull: number; pk: number };
export type BackupColumns = Record<BackupTable, BackupColumn[]>;

export function backupTextBytes(text: string) {
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export function invalid(reason: string): never {
  throw new Error(`This backup cannot be restored: ${reason}`);
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('expected an object.');
  return value as Record<string, unknown>;
}
export function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return isActivityDate(value);
}
function timestamp(value: unknown) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) && validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}
const enumFields: Partial<Record<BackupTable, Record<string, string[]>>> = {
  accounts: { type: ['CASH', 'BANK', 'EWALLET', 'OTHER'] },
  categories: { type: ['EXPENSE', 'INCOME'] },
  transactions: { type: ['EXPENSE', 'INCOME', 'TRANSFER', 'ADJUSTMENT'], source: ['MANUAL', 'AI', 'SPLIT', 'PLANNED', 'SUBSCRIPTION', 'IMPORT'] },
  person_entries: { type: ['GIVEN', 'RECEIVED_BACK', 'BORROWED_FROM', 'PAID_BACK', 'ADJUSTMENT'] },
  budgets: { ownership: ['USER', 'DEMO'] },
  goal_entries: { type: ['ADD', 'WITHDRAW', 'ADJUSTMENT'] },
  planned_payments: { type: ['EXPENSE', 'INCOME'], status: ['ACTIVE', 'PAUSED', 'ENDED'], recurrence_type: ['NONE', 'DAILY', 'EVERY_N_DAYS', 'WEEKLY', 'MONTHLY', 'EVERY_N_MONTHS', 'YEARLY'] },
  subscriptions: { status: ['ACTIVE', 'PAUSED', 'CANCELLED', 'ENDED'], frequency_type: ['DAILY', 'EVERY_N_DAYS', 'WEEKLY', 'MONTHLY', 'EVERY_N_MONTHS', 'YEARLY'] },
  planned_payment_occurrences: { outcome: ['RECORDED', 'SKIPPED'] },
};
const dateFields = new Set(['occurred_on', 'scheduled_date', 'target_date', 'next_due_date', 'start_date', 'end_date', 'next_renewal_date', 'cancellation_reminder_date']);
const booleans = new Set(['is_archived', 'is_default', 'is_self', 'payer_is_self', 'user_managed', 'reminder_enabled', 'cancellation_reminder_enabled']);

/** Required fields include nullable columns: absence is not silently defaulted.
 * v1 rejects unknown fields; future versions require explicit tested migration.
 * Column names/types come only from the trusted CURRENT schema, never the file.
 */
export function parseBackup(text: string, columns: BackupColumns): Backup {
  if (text.length > MAX_BACKUP_BYTES || backupTextBytes(text) > MAX_BACKUP_BYTES) invalid('file is too large (25 MB maximum).');
  let decoded: unknown;
  try { decoded = JSON.parse(text); } catch { invalid('the file is not valid JSON.'); }
  const root = object(decoded);
  if (root.backupVersion !== BACKUP_VERSION) invalid('unsupported backup format version.');
   if (root.app !== BACKUP_APP || !BACKUP_COMPATIBLE_SCHEMA_VERSIONS.includes(root.schemaVersion as Backup['schemaVersion'])) invalid('incompatible app or database version.');
  if (typeof root.appVersion !== 'string' || !root.appVersion || !timestamp(root.createdAt)) invalid('missing or invalid version/date metadata.');
  if (Object.keys(root).sort().join() !== ['app', 'appVersion', 'backupVersion', 'createdAt', 'data', 'schemaVersion'].sort().join()) invalid('unexpected top-level fields.');
  const data = object(root.data);
  if (Object.keys(data).sort().join() !== [...BACKUP_TABLES].sort().join()) invalid('required data tables are missing or unsupported.');
  // Files from before multiple currencies showed every amount in the saved
  // currency, whatever an account had stored: everything is in that currency.
  const legacyCurrency = Number(root.schemaVersion) < 14 ? savedCurrencyOf(data) : null;
  let count = 0;
  for (const table of BACKUP_TABLES) {
    const rows = data[table];
    if (!Array.isArray(rows)) invalid(`${table} must be a list.`);
    count += rows.length;
    if (count > 100000) invalid('too many records (100,000 maximum).');
    const expected = columns[table];
    const keys = expected.map((c) => c.name).sort().join();
    const identities = new Set<string>();
    for (const raw of rows) {
      const row = object(raw);
      if (legacyCurrency) {
        if ((table === 'budgets' || table === 'goals') && 'currency' in row) invalid('legacy record has unsupported currency metadata.');
        if (table === 'transactions' && 'destination_amount_minor' in row) invalid('legacy move has unsupported amount metadata.');
        if (table === 'accounts' && typeof row.currency === 'string') row.currency = legacyCurrency;
        if (table === 'budgets' || table === 'goals') row.currency = legacyCurrency;
        if (table === 'transactions') row.destination_amount_minor = null;
      }
      if (Number(root.schemaVersion) < 13 && ['planned_payments', 'subscriptions', 'planned_payment_occurrences', 'subscription_payments'].includes(table)) {
        if ('schedule_provenance' in row) invalid('legacy schedule has unsupported provenance metadata.');
        if (['DAILY', 'EVERY_N_DAYS'].includes(String(row.recurrence_type ?? row.frequency_type))) invalid('legacy schedule has unsupported recurrence.');
        row.schedule_provenance = null;
      }
      if (Number(root.schemaVersion) < 12 && (table === 'transactions' || table === 'person_entries')) {
        if ('cash_effect_minor' in row) invalid('legacy financial row has unsupported cash-effect metadata.');
        row.cash_effect_minor = null;
      }
      // Older contracts did not store intent. Only the documented absent column
      // is upgraded; a legacy-labelled file cannot smuggle prospective intent.
      if (table === 'split_groups' && Number(root.schemaVersion) < 10) {
        if ('split_definition' in row) invalid('legacy shared expense has unsupported method metadata.');
        row.split_definition = null;
      }
      if (Object.keys(row).sort().join() !== keys) invalid(`${table} has missing or unknown fields.`);
      for (const column of expected) {
        const value = row[column.name];
        if (value === null && !column.notnull && !column.pk) continue;
        if (column.type === 'INTEGER') {
          if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid(`${table}.${column.name} must be a safe integer.`);
          if (booleans.has(column.name) && value !== 0 && value !== 1) invalid(`${table}.${column.name} must be 0 or 1.`);
          if (column.name.endsWith('_minor')) {
            const signed = column.name === 'opening_balance_minor' || column.name === 'cash_effect_minor' || (row.type === 'ADJUSTMENT' && column.name === 'amount_minor');
            if (column.name === 'cash_effect_minor' && value > 0) invalid('shared funding cannot have a positive cash effect.');
            const zeroAllowed = signed || ['initial_saved_minor', 'share_minor'].includes(column.name);
            if ((!signed && value < 0) || (!zeroAllowed && value === 0)) invalid(`${table}.${column.name} has an invalid amount.`);
          }
          if (['completed_cycles', 'completed_occurrences', 'reminder_days_before'].includes(column.name) && value < 0) invalid(`${table} has a negative count.`);
          if (['frequency_interval', 'recurrence_interval', 'total_cycles', 'occurrence_limit'].includes(column.name) && value < 1) invalid(`${table} has an invalid interval/limit.`);
          if (column.name === 'recurrence_anchor_day' && (value < 1 || value > 31)) invalid('invalid recurrence anchor.');
        } else {
          if (typeof value !== 'string' || value.length > 1000000) invalid(`${table}.${column.name} must be text.`);
          if ((column.pk || column.name === 'id' || column.name.endsWith('_id')) && !value.trim()) invalid(`${table} has an empty identity.`);
          if (dateFields.has(column.name) && !validDate(value)) invalid(`${table} has an invalid date.`);
          if (column.name.endsWith('_at') && !timestamp(value)) invalid(`${table} has an invalid timestamp.`);
          if (column.name === 'month_key' && !validDate(`${value}-01`)) invalid('invalid Spending Plan month.');
          if (column.name === 'sync_status' && !['LOCAL', 'PENDING', 'SYNCED', 'CONFLICT'].includes(value)) invalid('invalid sync metadata.');
        }
      }
      for (const [field, values] of Object.entries(enumFields[table] ?? {})) {
        if (!values.includes(row[field] as string)) invalid(`${table}.${field} has an unsupported value.`);
      }
      const identity = JSON.stringify(expected.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => row[c.name]));
      if (identities.has(identity)) invalid(`${table} contains duplicate identities.`);
      identities.add(identity);
    }
  }
  return root as unknown as Backup;
}

function savedCurrencyOf(data: Record<string, unknown>): string {
  const settings = (Array.isArray(data.app_settings) ? data.app_settings : []) as Record<string, unknown>[];
  const saved = settings.find((row) => row && row.key === 'currency')?.value;
  return typeof saved === 'string' ? saved : 'PKR';
}

export function backupPreview(backup: Backup) {
  return {
    createdAt: backup.createdAt, backupVersion: backup.backupVersion,
    compatibility: 'Compatible with this app', replacement: true,
    counts: Object.fromEntries(BACKUP_TABLES.map((table) => [table, backup.data[table].length])),
  };
}

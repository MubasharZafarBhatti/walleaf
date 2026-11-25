export type SyncStatus = 'LOCAL' | 'PENDING' | 'SYNCED' | 'CONFLICT';
export type AccountType = 'CASH' | 'BANK' | 'EWALLET' | 'OTHER';
export type CategoryType = 'EXPENSE' | 'INCOME';
export type TransactionType = 'EXPENSE' | 'INCOME' | 'TRANSFER' | 'ADJUSTMENT';
export type TransactionSource =
  'MANUAL' | 'AI' | 'SPLIT' | 'PLANNED' | 'SUBSCRIPTION' | 'IMPORT';
export type PersonEntryType =
  'GIVEN' | 'RECEIVED_BACK' | 'BORROWED_FROM' | 'PAID_BACK' | 'ADJUSTMENT';
export type SubscriptionStatus = 'ACTIVE' | 'PAUSED' | 'CANCELLED' | 'ENDED';
export type FrequencyType = 'DAILY' | 'EVERY_N_DAYS' | 'WEEKLY' | 'MONTHLY' | 'EVERY_N_MONTHS' | 'YEARLY';
export type GoalEntryType = 'ADD' | 'WITHDRAW' | 'ADJUSTMENT';
export type PlannedPaymentType = 'EXPENSE' | 'INCOME';
export type PlannedRecurrenceType = 'NONE' | FrequencyType;
export type PlannedPaymentStatus = 'ACTIVE' | 'PAUSED' | 'ENDED';

export type BaseRecord = {
  id: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  sync_status: SyncStatus;
};
export type Account = BaseRecord & {
  name: string;
  type: AccountType;
  currency: string;
  opening_balance_minor: number;
  is_archived: number;
};
export type Category = BaseRecord & {
  name: string;
  type: CategoryType;
  icon: string;
  color_key: string;
  is_default: number;
  is_archived: number;
};
export type Transaction = BaseRecord & {
  cash_effect_minor?: number | null; // Explicit shared funding; NULL = legacy interpretation.
  type: TransactionType;
  amount_minor: number;
  account_id: string;
  destination_account_id?: string | null;
  /** A move between accounts in different currencies: the exact amount that arrived. NULL = same currency. */
  destination_amount_minor?: number | null;
  category_id?: string | null;
  title: string;
  note?: string | null;
  occurred_on: string;
  source: TransactionSource;
  group_id?: string | null;
  financial_event_id?: string | null;
};
export type Budget = BaseRecord & {
  ownership: 'USER' | 'DEMO';
  month_key: string;
  /** Each currency has its own plan. */
  currency: string;
  category_id?: string | null;
  amount_minor: number;
};
export type Person = BaseRecord & {
  name: string;
  note?: string | null;
  is_archived: number;
  /** Balance in the main currency. */
  balance_minor?: number;
  /** Non-zero balance in each currency, main currency first. */
  balances?: { currency: string; amountMinor: number }[];
};
export type PersonEntry = BaseRecord & {
  cash_effect_minor?: number | null; // Shared obligation cash-neutrality is explicit.
  person_id: string;
  type: PersonEntryType;
  amount_minor: number;
  account_id: string;
  title: string;
  note?: string | null;
  occurred_on: string;
  split_group_id?: string | null;
  financial_event_id?: string | null;
};
export type SplitGroup = BaseRecord & {
  title: string;
  total_amount_minor: number;
  category_id: string;
  account_id: string;
  occurred_on: string;
  group_id?: string | null;
  financial_event_id?: string | null;
  payer_person_id?: string | null;
  payer_name: string;
  payer_is_self: number;
  split_definition?: string | null;
};
export type SplitParticipant = {
  id: string;
  split_group_id: string;
  person_id?: string | null;
  name: string;
  is_self: number;
  share_minor: number;
  created_at: string;
};
export type Subscription = BaseRecord & {
  schedule_provenance?: string | null;
  recurrence_anchor_day?: number | null;
  name: string;
  amount_minor: number;
  category_id: string;
  account_id: string;
  frequency_type: FrequencyType;
  frequency_interval: number;
  start_date: string;
  next_renewal_date: string;
  end_date?: string | null;
  total_cycles?: number | null;
  completed_cycles: number;
  reminder_enabled: number;
  reminder_days_before: number;
  cancellation_reminder_enabled: number;
  cancellation_reminder_date?: string | null;
  status: SubscriptionStatus;
  note?: string | null;
};
export type SubscriptionPayment = {
  schedule_provenance?: string | null;
  id: string;
  subscription_id: string;
  scheduled_date: string;
  transaction_id: string;
  created_at: string;
  transaction_title: string | null;
  transaction_amount_minor: number | null;
  transaction_date: string | null;
  transaction_available: number;
  account_name: string | null;
  category_name: string | null;
};
export type Settings = {
  user_name: string;
  currency: string;
  week_start: string;
  budget_alert_threshold: string;
  theme: string;
  notifications_enabled: string;
  notifications_intro_answered?: string;
  notifications_last_response?: string; // Device-local tap consumption; excluded from backups.
  ai_enabled: string;
  setup_complete: string;
  senior_demo_seeded?: string;
  local_backup_restored?: string;
  budget_auto_copy_enabled?: string;
  budget_auto_copy_processed_month?: string;
  /** Activity lists: 'DATE' (default) or 'CREATED'. */
  activity_sort_order?: string;
  /** Account preselected for new entries; falls back to Cash when unset or archived. */
  default_account_id?: string;
};
export type Goal = BaseRecord & {
  name: string;
  target_amount_minor: number;
  initial_saved_minor: number;
  target_date?: string | null;
  linked_account_id?: string | null;
  /** The linked account's currency, or the one chosen for an unlinked goal. */
  currency: string;
  note?: string | null;
  is_archived: number;
  saved_minor?: number;
  linked_account_name?: string | null; // Read-only join; not a persisted Goal field.
};
export type GoalEntry = Omit<BaseRecord, 'sync_status'> & {
  goal_id: string;
  type: GoalEntryType;
  amount_minor: number;
  occurred_on: string;
  note?: string | null;
};
export type Group = BaseRecord & {
  is_archived?: number;
  user_managed?: number;
  name: string;
  description?: string | null;
  balance_minor?: number;
  member_count?: number;
};
export type GroupMember = {
  id: string;
  group_id: string;
  person_id?: string | null;
  is_self: number;
  created_at: string;
};
export type PlannedPayment = BaseRecord & {
  schedule_provenance?: string | null;
  name: string;
  type: PlannedPaymentType;
  amount_minor: number;
  category_id: string;
  account_id: string;
  account_name?: string | null; // Read-only join, including archived accounts.
  next_due_date: string;
  recurrence_type: PlannedRecurrenceType;
  recurrence_interval: number;
  end_date?: string | null;
  occurrence_limit?: number | null;
  completed_occurrences: number;
  reminder_enabled: number;
  reminder_days_before: number;
  subscription_metadata?: string | null;
  status: PlannedPaymentStatus;
  note?: string | null;
};
export type PlannedPaymentOccurrence = {
  schedule_provenance?: string | null;
  id: string;
  planned_payment_id: string;
  scheduled_date: string;
  outcome: 'RECORDED' | 'SKIPPED';
  transaction_id?: string | null;
  created_at: string;
  transaction_deleted_at?: string | null;
  transaction_amount_minor?: number | null;
  transaction_type?: PlannedPaymentType | null;
  transaction_title?: string | null;
};

// Dependency-free reminder identifiers shared by the scheduler, the tap
// coordinator and the headless notification-action task.
export const REMINDER_MANAGER = 'expense-tracker';
// Android fixes a channel's sound and vibration when it is first created, so
// reminders that alert (user decision 2026-11-17) use a new channel; the old
// silent one is removed so Settings shows a single "Financial reminders".
export const REMINDER_CHANNEL_ID = 'financial-reminders-alert';
export const LEGACY_REMINDER_CHANNEL_IDS = ['financial-reminders'] as const;
/** Short double buzz for due-date reminders (and their Snooze); receipts stay quiet. */
export const REMINDER_VIBRATION = [0, 250, 250, 250];
export const REMINDER_ACCENT_COLOR = '#446A5A';
export const REMINDER_SNOOZE_MS = 3 * 60 * 60 * 1000;
export const REMINDER_ACTION_TASK = 'expense-tracker-reminder-actions';

export const REMINDER_ACTIONS = {
  READ: 'mark-read',
  LATER: 'remind-later',
  PAID: 'mark-paid',
  REVIEW: 'review',
} as const;

export type ReminderCategory = 'expense' | 'income' | 'review';
export const REMINDER_CATEGORY_IDS: Record<ReminderCategory, string> = {
  expense: 'expense-tracker-reminder-expense',
  income: 'expense-tracker-reminder-income',
  review: 'expense-tracker-reminder-review',
};

/** Button order on the card: Got it | Snooze | Mark as paid. Snooze waits 3 hours.
 * Mark as paid records in the background (no app opening); only Review opens the app. */
export const REMINDER_CATEGORY_BUTTONS: Record<ReminderCategory, { identifier: string; buttonTitle: string; opensApp: boolean }[]> = {
  expense: [
    { identifier: REMINDER_ACTIONS.READ, buttonTitle: 'Got it', opensApp: false },
    { identifier: REMINDER_ACTIONS.LATER, buttonTitle: 'Snooze', opensApp: false },
    { identifier: REMINDER_ACTIONS.PAID, buttonTitle: 'Mark as paid', opensApp: false },
  ],
  income: [
    { identifier: REMINDER_ACTIONS.READ, buttonTitle: 'Got it', opensApp: false },
    { identifier: REMINDER_ACTIONS.LATER, buttonTitle: 'Snooze', opensApp: false },
    { identifier: REMINDER_ACTIONS.PAID, buttonTitle: 'Mark as received', opensApp: false },
  ],
  review: [
    { identifier: REMINDER_ACTIONS.READ, buttonTitle: 'Got it', opensApp: false },
    { identifier: REMINDER_ACTIONS.LATER, buttonTitle: 'Snooze', opensApp: false },
    { identifier: REMINDER_ACTIONS.REVIEW, buttonTitle: 'Review', opensApp: true },
  ],
};

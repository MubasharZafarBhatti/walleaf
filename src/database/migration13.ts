// Prospective provenance only. NULL explicitly means historical schedule unknown.
// No historical dates, counters, payment links or financial rows are rewritten.
export const migration13 = `
ALTER TABLE planned_payments ADD COLUMN schedule_provenance TEXT;
ALTER TABLE subscriptions ADD COLUMN schedule_provenance TEXT;
ALTER TABLE planned_payment_occurrences ADD COLUMN schedule_provenance TEXT;
ALTER TABLE subscription_payments ADD COLUMN schedule_provenance TEXT;
`;

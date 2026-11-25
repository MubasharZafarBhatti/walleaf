// Additive only: old transactions and schedules are not backfilled or reinterpreted.
export const migration8 = `
ALTER TABLE subscriptions ADD COLUMN recurrence_anchor_day INTEGER CHECK (recurrence_anchor_day BETWEEN 1 AND 31);
ALTER TABLE subscriptions ADD COLUMN user_managed INTEGER NOT NULL DEFAULT 0 CHECK (user_managed IN (0, 1));
CREATE TABLE subscription_payments (
  id TEXT PRIMARY KEY NOT NULL,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  scheduled_date TEXT NOT NULL,
  transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id),
  created_at TEXT NOT NULL,
  UNIQUE(subscription_id, scheduled_date)
);
CREATE INDEX idx_subscription_payments_history ON subscription_payments(subscription_id, scheduled_date DESC);
CREATE TRIGGER subscription_payment_source BEFORE INSERT ON subscription_payments
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM transactions t JOIN subscriptions s ON s.id = NEW.subscription_id
    WHERE t.id = NEW.transaction_id AND t.financial_event_id = NEW.id
      AND t.source = 'SUBSCRIPTION' AND t.type = 'EXPENSE' AND t.deleted_at IS NULL
      AND s.status = 'ACTIVE' AND s.deleted_at IS NULL AND s.next_renewal_date = NEW.scheduled_date
  ) THEN RAISE(ABORT, 'Invalid subscription payment source') END;
END;
CREATE TRIGGER subscription_payment_immutable BEFORE UPDATE ON subscription_payments
BEGIN SELECT RAISE(ABORT, 'Subscription payment identity is immutable'); END;
`;

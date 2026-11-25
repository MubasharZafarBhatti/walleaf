export const migration7 = `
CREATE TABLE planned_payment_occurrences (
  id TEXT PRIMARY KEY NOT NULL,
  planned_payment_id TEXT NOT NULL,
  scheduled_date TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('RECORDED', 'SKIPPED')),
  transaction_id TEXT,
  created_at TEXT NOT NULL,
  CHECK (
    (outcome = 'RECORDED' AND transaction_id IS NOT NULL) OR
    (outcome = 'SKIPPED' AND transaction_id IS NULL)
  ),
  UNIQUE (planned_payment_id, scheduled_date),
  UNIQUE (transaction_id)
);

CREATE INDEX idx_planned_occurrences_plan_date
  ON planned_payment_occurrences (planned_payment_id, scheduled_date DESC);
`;

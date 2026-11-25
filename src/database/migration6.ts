// Allocation metadata never posts money. Original People entries remain authoritative.
export const migration6 = `
ALTER TABLE groups ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1));
ALTER TABLE groups ADD COLUMN user_managed INTEGER NOT NULL DEFAULT 0 CHECK (user_managed IN (0, 1));
CREATE TABLE entry_allocations (
  id TEXT PRIMARY KEY NOT NULL,
  source_entry_id TEXT NOT NULL REFERENCES person_entries(id) ON DELETE RESTRICT,
  target_entry_id TEXT NOT NULL REFERENCES person_entries(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor > 0 AND amount_minor <= 9007199254740991),
  created_at TEXT NOT NULL,
  CHECK (source_entry_id <> target_entry_id)
);
CREATE INDEX allocations_source ON entry_allocations(source_entry_id);
CREATE INDEX allocations_target ON entry_allocations(target_entry_id);
CREATE TABLE allocation_exclusions (
  source_entry_id TEXT NOT NULL REFERENCES person_entries(id) ON DELETE RESTRICT,
  target_entry_id TEXT NOT NULL REFERENCES person_entries(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_entry_id, target_entry_id)
);
CREATE TABLE group_settlement_requests (
  id TEXT PRIMARY KEY NOT NULL,
  request_json TEXT NOT NULL,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  source_entry_id TEXT NOT NULL UNIQUE REFERENCES person_entries(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);
CREATE VIEW allocation_sources AS
  SELECT e.*, ac.name account_name, CASE WHEN e.type IN ('GIVEN','PAID_BACK') THEN -1 ELSE 1 END cash_direction,
    e.amount_minor - coalesce((SELECT sum(a.amount_minor) FROM entry_allocations a WHERE a.source_entry_id = e.id),0) available_minor
  FROM person_entries e JOIN people p ON p.id = e.person_id JOIN accounts ac ON ac.id = e.account_id
  WHERE e.deleted_at IS NULL AND p.deleted_at IS NULL AND ac.deleted_at IS NULL
    AND e.split_group_id IS NULL AND e.type IN ('GIVEN','PAID_BACK','BORROWED_FROM','RECEIVED_BACK')
    AND typeof(e.amount_minor) = 'integer' AND e.amount_minor BETWEEN 1 AND 9007199254740991
    AND NOT EXISTS (SELECT 1 FROM split_groups s WHERE s.financial_event_id = e.financial_event_id)
    AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.financial_event_id = e.financial_event_id)
    AND NOT EXISTS (SELECT 1 FROM entry_allocations a WHERE a.target_entry_id = e.id);
CREATE VIEW allocation_targets AS
  SELECT e.*, s.group_id, s.title expense_title, CASE WHEN e.type = 'GIVEN' THEN 1 ELSE -1 END direction,
    e.amount_minor - coalesce((SELECT sum(a.amount_minor) FROM entry_allocations a WHERE a.target_entry_id = e.id),0) remaining_minor
  FROM person_entries e JOIN split_groups s ON s.id = e.split_group_id JOIN people p ON p.id = e.person_id
  WHERE e.deleted_at IS NULL AND s.deleted_at IS NULL AND p.deleted_at IS NULL
    AND typeof(e.amount_minor) = 'integer' AND e.amount_minor BETWEEN 1 AND 9007199254740991
    AND e.financial_event_id = s.financial_event_id
    AND NOT EXISTS (SELECT 1 FROM split_groups sibling WHERE sibling.financial_event_id = s.financial_event_id AND sibling.id <> s.id)
    AND (s.group_id IS NULL OR EXISTS (SELECT 1 FROM groups g WHERE g.id = s.group_id AND g.deleted_at IS NULL))
    AND (SELECT sum(sp.share_minor) FROM split_participants sp WHERE sp.split_group_id = s.id) = s.total_amount_minor
    AND NOT EXISTS (SELECT 1 FROM split_participants sp WHERE sp.split_group_id = s.id AND (typeof(sp.share_minor) <> 'integer' OR sp.share_minor < 0))
    AND ((s.payer_is_self = 1 AND (SELECT count(*) FROM split_participants sp WHERE sp.split_group_id = s.id AND sp.person_id = e.person_id AND sp.is_self = 0 AND sp.share_minor = e.amount_minor) = 1)
      OR (s.payer_is_self = 0 AND (SELECT sum(sp.share_minor) FROM split_participants sp WHERE sp.split_group_id = s.id AND sp.is_self = 1) = e.amount_minor))
    AND ((s.payer_is_self = 1 AND e.type = 'GIVEN') OR (s.payer_is_self = 0 AND e.type = 'BORROWED_FROM' AND s.payer_person_id = e.person_id))
    AND NOT EXISTS (SELECT 1 FROM entry_allocations a WHERE a.source_entry_id = e.id);
CREATE TRIGGER allocation_insert_guard BEFORE INSERT ON entry_allocations BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM allocation_sources source JOIN allocation_targets target ON target.person_id = source.person_id AND target.direction = source.cash_direction
    WHERE source.id = NEW.source_entry_id AND target.id = NEW.target_entry_id
      AND NEW.amount_minor <= source.available_minor AND NEW.amount_minor <= target.remaining_minor
      AND NOT EXISTS (SELECT 1 FROM allocation_exclusions x WHERE x.source_entry_id = source.id AND x.target_entry_id = target.id)
  ) THEN RAISE(ABORT, 'Invalid allocation, direction or remaining amount') END;
END;
CREATE TRIGGER allocation_no_update BEFORE UPDATE ON entry_allocations BEGIN SELECT RAISE(ABORT, 'Allocations are immutable'); END;
CREATE TRIGGER allocation_no_delete BEFORE DELETE ON entry_allocations BEGIN SELECT RAISE(ABORT, 'Allocations are immutable'); END;
CREATE TRIGGER exclusion_insert_guard BEFORE INSERT ON allocation_exclusions BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM allocation_sources source JOIN allocation_targets target ON target.person_id = source.person_id AND target.direction = source.cash_direction
    WHERE source.id = NEW.source_entry_id AND target.id = NEW.target_entry_id AND source.available_minor > 0 AND target.remaining_minor > 0
  ) THEN RAISE(ABORT, 'Invalid reconciliation choice') END;
END;
CREATE TRIGGER exclusion_no_update BEFORE UPDATE ON allocation_exclusions BEGIN SELECT RAISE(ABORT, 'Reconciliation choices are immutable'); END;
CREATE TRIGGER settlement_no_update BEFORE UPDATE ON group_settlement_requests BEGIN SELECT RAISE(ABORT, 'Settlement requests are immutable'); END;
CREATE TRIGGER settlement_no_delete BEFORE DELETE ON group_settlement_requests BEGIN SELECT RAISE(ABORT, 'Settlement requests are immutable'); END;
CREATE TRIGGER allocated_entry_no_update BEFORE UPDATE OF id, person_id, type, amount_minor, account_id, split_group_id, financial_event_id, deleted_at ON person_entries
WHEN EXISTS (SELECT 1 FROM entry_allocations WHERE source_entry_id = OLD.id OR target_entry_id = OLD.id)
  OR EXISTS (SELECT 1 FROM allocation_exclusions WHERE source_entry_id = OLD.id OR target_entry_id = OLD.id)
  OR EXISTS (SELECT 1 FROM group_settlement_requests WHERE source_entry_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'Reconciled People entries cannot be changed'); END;
CREATE TRIGGER allocated_entry_no_delete BEFORE DELETE ON person_entries
WHEN EXISTS (SELECT 1 FROM entry_allocations WHERE source_entry_id = OLD.id OR target_entry_id = OLD.id)
  OR EXISTS (SELECT 1 FROM allocation_exclusions WHERE source_entry_id = OLD.id OR target_entry_id = OLD.id)
  OR EXISTS (SELECT 1 FROM group_settlement_requests WHERE source_entry_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'Reconciled People entries cannot be deleted'); END;
CREATE TRIGGER allocated_split_no_update BEFORE UPDATE OF id, group_id, financial_event_id, payer_person_id, payer_is_self, total_amount_minor, deleted_at ON split_groups
WHEN EXISTS (SELECT 1 FROM person_entries e WHERE e.split_group_id = OLD.id AND (
  EXISTS (SELECT 1 FROM entry_allocations a WHERE a.target_entry_id = e.id) OR EXISTS (SELECT 1 FROM allocation_exclusions x WHERE x.target_entry_id = e.id)))
BEGIN SELECT RAISE(ABORT, 'Reconciled shared expenses cannot be changed'); END;
CREATE TRIGGER allocated_split_no_delete BEFORE DELETE ON split_groups
WHEN EXISTS (SELECT 1 FROM person_entries e WHERE e.split_group_id = OLD.id AND (
  EXISTS (SELECT 1 FROM entry_allocations a WHERE a.target_entry_id = e.id) OR EXISTS (SELECT 1 FROM allocation_exclusions x WHERE x.target_entry_id = e.id)))
BEGIN SELECT RAISE(ABORT, 'Reconciled shared expenses cannot be deleted'); END;
CREATE TRIGGER allocated_participant_no_update BEFORE UPDATE OF split_group_id, person_id, is_self, share_minor ON split_participants
WHEN EXISTS (SELECT 1 FROM person_entries e JOIN entry_allocations a ON a.target_entry_id = e.id WHERE e.split_group_id = OLD.split_group_id)
BEGIN SELECT RAISE(ABORT, 'Allocated participants cannot be changed'); END;
CREATE TRIGGER allocated_participant_no_delete BEFORE DELETE ON split_participants
WHEN EXISTS (SELECT 1 FROM person_entries e JOIN entry_allocations a ON a.target_entry_id = e.id WHERE e.split_group_id = OLD.split_group_id)
BEGIN SELECT RAISE(ABORT, 'Allocated participants cannot be deleted'); END;
CREATE TRIGGER allocated_participant_no_insert BEFORE INSERT ON split_participants
WHEN EXISTS (SELECT 1 FROM person_entries e JOIN entry_allocations a ON a.target_entry_id = e.id WHERE e.split_group_id = NEW.split_group_id)
BEGIN SELECT RAISE(ABORT, 'Allocated participants cannot be added'); END;
CREATE TRIGGER reconciled_group_no_delete BEFORE DELETE ON groups
WHEN EXISTS (SELECT 1 FROM split_groups s JOIN person_entries e ON e.split_group_id = s.id WHERE s.group_id = OLD.id AND (
  EXISTS (SELECT 1 FROM entry_allocations a WHERE a.target_entry_id = e.id) OR EXISTS (SELECT 1 FROM allocation_exclusions x WHERE x.target_entry_id = e.id)))
BEGIN SELECT RAISE(ABORT, 'Archive groups with reconciled history'); END;
CREATE TRIGGER reconciled_group_no_hide BEFORE UPDATE OF id, deleted_at ON groups
WHEN EXISTS (SELECT 1 FROM split_groups s JOIN person_entries e ON e.split_group_id = s.id WHERE s.group_id = OLD.id AND (
  EXISTS (SELECT 1 FROM entry_allocations a WHERE a.target_entry_id = e.id) OR EXISTS (SELECT 1 FROM allocation_exclusions x WHERE x.target_entry_id = e.id)))
BEGIN SELECT RAISE(ABORT, 'Archive groups with reconciled history'); END;
CREATE TRIGGER reconciled_person_no_delete BEFORE DELETE ON people
WHEN EXISTS (SELECT 1 FROM person_entries e WHERE e.person_id = OLD.id AND (
  EXISTS (SELECT 1 FROM entry_allocations a WHERE a.source_entry_id = e.id OR a.target_entry_id = e.id) OR EXISTS (SELECT 1 FROM allocation_exclusions x WHERE x.source_entry_id = e.id OR x.target_entry_id = e.id)))
BEGIN SELECT RAISE(ABORT, 'Reconciled people must retain their identity'); END;
CREATE TRIGGER reconciled_person_no_hide BEFORE UPDATE OF id, deleted_at ON people
WHEN EXISTS (SELECT 1 FROM person_entries e WHERE e.person_id = OLD.id AND (
  EXISTS (SELECT 1 FROM entry_allocations a WHERE a.source_entry_id = e.id OR a.target_entry_id = e.id) OR EXISTS (SELECT 1 FROM allocation_exclusions x WHERE x.source_entry_id = e.id OR x.target_entry_id = e.id)))
BEGIN SELECT RAISE(ABORT, 'Reconciled people must retain their identity'); END;
CREATE TRIGGER reconciled_account_no_delete BEFORE DELETE ON accounts
WHEN EXISTS (SELECT 1 FROM person_entries e WHERE e.account_id = OLD.id AND (
  EXISTS (SELECT 1 FROM entry_allocations a WHERE a.source_entry_id = e.id OR a.target_entry_id = e.id) OR EXISTS (SELECT 1 FROM allocation_exclusions x WHERE x.source_entry_id = e.id OR x.target_entry_id = e.id)))
BEGIN SELECT RAISE(ABORT, 'Reconciled accounts must retain their identity'); END;
CREATE TRIGGER reconciled_account_no_hide BEFORE UPDATE OF id, deleted_at ON accounts
WHEN EXISTS (SELECT 1 FROM person_entries e WHERE e.account_id = OLD.id AND (
  EXISTS (SELECT 1 FROM entry_allocations a WHERE a.source_entry_id = e.id OR a.target_entry_id = e.id) OR EXISTS (SELECT 1 FROM allocation_exclusions x WHERE x.source_entry_id = e.id OR x.target_entry_id = e.id)))
BEGIN SELECT RAISE(ABORT, 'Reconciled accounts must retain their identity'); END;
`;

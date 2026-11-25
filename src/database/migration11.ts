import { migration6 } from './migration6';

// Extend the original allocation model, never rewrite its applied migration.
// A shared obligation used as a source offsets an opposite obligation; no cash
// or People row is manufactured. Both source/target usages consume its capacity.
const targets = migration6.slice(migration6.indexOf('CREATE VIEW allocation_targets'), migration6.indexOf('CREATE TRIGGER allocation_insert_guard'))
  .replace('WHERE a.target_entry_id = e.id),0) remaining_minor', 'WHERE a.target_entry_id = e.id OR a.source_entry_id = e.id),0) remaining_minor')
  .replace('    AND NOT EXISTS (SELECT 1 FROM entry_allocations a WHERE a.source_entry_id = e.id);', ';');
const sources = migration6.slice(migration6.indexOf('CREATE VIEW allocation_sources'), migration6.indexOf('CREATE VIEW allocation_targets')).trim().replace(/;$/, `
  UNION ALL SELECT e.*, ac.name account_name, -t.direction cash_direction, t.remaining_minor available_minor
  FROM allocation_targets t JOIN person_entries e ON e.id = t.id JOIN accounts ac ON ac.id = e.account_id
  WHERE t.group_id IS NOT NULL;`);

export const migration11 = `
DROP VIEW allocation_sources;
DROP VIEW allocation_targets;
${targets}
${sources}
CREATE TRIGGER allocation_offset_guard BEFORE INSERT ON entry_allocations
WHEN EXISTS (SELECT 1 FROM person_entries WHERE id = NEW.source_entry_id AND split_group_id IS NOT NULL)
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM allocation_targets source JOIN allocation_targets target ON target.person_id = source.person_id
    JOIN groups g ON g.id = source.group_id
    WHERE source.id = NEW.source_entry_id AND target.id = NEW.target_entry_id
      AND source.group_id = target.group_id AND g.is_archived = 0 AND g.deleted_at IS NULL
      AND source.direction = -target.direction
      AND NEW.amount_minor <= source.remaining_minor AND NEW.amount_minor <= target.remaining_minor
  ) THEN RAISE(ABORT, 'Invalid group obligation offset') END;
END;
CREATE TRIGGER offset_exclusion_guard BEFORE INSERT ON allocation_exclusions
WHEN EXISTS (SELECT 1 FROM person_entries WHERE id = NEW.source_entry_id AND split_group_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'Only actual cash can be marked unrelated'); END;
CREATE TRIGGER offset_split_no_update BEFORE UPDATE OF id, group_id, financial_event_id, payer_person_id, payer_is_self, total_amount_minor, deleted_at ON split_groups
WHEN EXISTS (SELECT 1 FROM person_entries e JOIN entry_allocations a ON a.source_entry_id = e.id WHERE e.split_group_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'Offset shared expenses cannot be changed'); END;
CREATE TRIGGER offset_split_no_delete BEFORE DELETE ON split_groups
WHEN EXISTS (SELECT 1 FROM person_entries e JOIN entry_allocations a ON a.source_entry_id = e.id WHERE e.split_group_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'Offset shared expenses cannot be deleted'); END;
CREATE TRIGGER offset_participant_no_update BEFORE UPDATE OF split_group_id, person_id, is_self, share_minor ON split_participants
WHEN EXISTS (SELECT 1 FROM person_entries e JOIN entry_allocations a ON a.source_entry_id = e.id WHERE e.split_group_id = OLD.split_group_id)
BEGIN SELECT RAISE(ABORT, 'Offset participants cannot be changed'); END;
CREATE TRIGGER offset_participant_no_delete BEFORE DELETE ON split_participants
WHEN EXISTS (SELECT 1 FROM person_entries e JOIN entry_allocations a ON a.source_entry_id = e.id WHERE e.split_group_id = OLD.split_group_id)
BEGIN SELECT RAISE(ABORT, 'Offset participants cannot be deleted'); END;
CREATE TRIGGER offset_participant_no_insert BEFORE INSERT ON split_participants
WHEN EXISTS (SELECT 1 FROM person_entries e JOIN entry_allocations a ON a.source_entry_id = e.id WHERE e.split_group_id = NEW.split_group_id)
BEGIN SELECT RAISE(ABORT, 'Offset participants cannot be added'); END;
`;

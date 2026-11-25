import { migration11 } from './migration11';

// Source inputs/contributions/routes remain versioned JSON. These explicit cash
// fields are required because consumption/People deltas cannot imply funding.
const views = migration11.slice(migration11.indexOf('CREATE VIEW allocation_targets'), migration11.indexOf('CREATE TRIGGER allocation_offset_guard'));
const legacyPayer = `    AND ((s.payer_is_self = 1 AND (SELECT count(*) FROM split_participants sp WHERE sp.split_group_id = s.id AND sp.person_id = e.person_id AND sp.is_self = 0 AND sp.share_minor = e.amount_minor) = 1)
      OR (s.payer_is_self = 0 AND (SELECT sum(sp.share_minor) FROM split_participants sp WHERE sp.split_group_id = s.id AND sp.is_self = 1) = e.amount_minor))
    AND ((s.payer_is_self = 1 AND e.type = 'GIVEN') OR (s.payer_is_self = 0 AND e.type = 'BORROWED_FROM' AND s.payer_person_id = e.person_id))`;
const modernPayer = `    AND ((json_extract(s.split_definition,'$.version') IS NOT 2 AND
      ${legacyPayer.trim().replace(/^AND /, '')}) OR
      (json_extract(s.split_definition,'$.version') = 2 AND e.cash_effect_minor IS NOT NULL
        AND (SELECT count(*) FROM json_each(s.split_definition,'$.routes') route WHERE json_extract(route.value,'$.amountMinor') = e.amount_minor AND
          ((json_extract(route.value,'$.to') = 'SELF' AND json_extract(route.value,'$.from') = 'PERSON:' || e.person_id AND e.type IN ('GIVEN','PAID_BACK')) OR
           (json_extract(route.value,'$.from') = 'SELF' AND json_extract(route.value,'$.to') = 'PERSON:' || e.person_id AND e.type IN ('BORROWED_FROM','RECEIVED_BACK')))) = 1
        AND (SELECT count(*) FROM json_each(s.split_definition,'$.classifications') classification WHERE json_extract(classification.value,'$.identity') = 'PERSON:' || e.person_id AND json_extract(classification.value,'$.type') = e.type) = 1))`;
const updatedViews = views.replace("CASE WHEN e.type = 'GIVEN' THEN 1 ELSE -1 END direction", "CASE WHEN e.type IN ('GIVEN','PAID_BACK') THEN 1 ELSE -1 END direction").replace(legacyPayer, modernPayer);

const transactionGuard = `SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM split_groups s WHERE s.id = NEW.group_id AND s.financial_event_id = NEW.financial_event_id
    AND NEW.source = 'SPLIT' AND NEW.type = 'EXPENSE' AND json_extract(s.split_definition,'$.version') = 2
    AND NEW.account_id = s.account_id AND NEW.category_id = s.category_id AND NEW.occurred_on = s.occurred_on
    AND NEW.amount_minor = (SELECT share_minor FROM split_participants WHERE split_group_id = s.id AND is_self = 1)
    AND NEW.cash_effect_minor = -coalesce((SELECT json_extract(p.value,'$.paidMinor') FROM json_each(s.split_definition,'$.payers') p WHERE json_extract(p.value,'$.identity') = 'SELF'),0)
) THEN RAISE(ABORT, 'Invalid shared consumption cash effect') END;`;
const entryGuard = `SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM split_groups s JOIN json_each(s.split_definition,'$.routes') route JOIN json_each(s.split_definition,'$.classifications') classification
    WHERE s.id = NEW.split_group_id AND s.financial_event_id = NEW.financial_event_id AND json_extract(s.split_definition,'$.version') = 2
      AND NEW.account_id = s.account_id AND NEW.occurred_on = s.occurred_on
      AND json_extract(classification.value,'$.identity') = 'PERSON:' || NEW.person_id AND json_extract(classification.value,'$.type') = NEW.type
      AND json_extract(route.value,'$.amountMinor') = NEW.amount_minor AND
        ((json_extract(route.value,'$.to') = 'SELF' AND json_extract(route.value,'$.from') = 'PERSON:' || NEW.person_id AND NEW.type IN ('GIVEN','PAID_BACK')) OR
         (json_extract(route.value,'$.from') = 'SELF' AND json_extract(route.value,'$.to') = 'PERSON:' || NEW.person_id AND NEW.type IN ('BORROWED_FROM','RECEIVED_BACK')))
      AND NEW.cash_effect_minor = CASE WHEN coalesce((SELECT share_minor FROM split_participants WHERE split_group_id = s.id AND is_self = 1),0) = 0 AND NEW.type IN ('GIVEN','PAID_BACK') THEN -NEW.amount_minor ELSE 0 END
) THEN RAISE(ABORT, 'Invalid shared People cash effect') END;`;

export const migration12 = `
ALTER TABLE transactions ADD COLUMN cash_effect_minor INTEGER CHECK (cash_effect_minor IS NULL OR (typeof(cash_effect_minor) = 'integer' AND cash_effect_minor BETWEEN -9007199254740991 AND 0));
ALTER TABLE person_entries ADD COLUMN cash_effect_minor INTEGER CHECK (cash_effect_minor IS NULL OR (typeof(cash_effect_minor) = 'integer' AND cash_effect_minor BETWEEN -9007199254740991 AND 0));
DROP VIEW allocation_sources;
DROP VIEW allocation_targets;
${updatedViews}
CREATE TRIGGER shared_transaction_cash_insert BEFORE INSERT ON transactions WHEN NEW.cash_effect_minor IS NOT NULL OR (SELECT json_extract(split_definition,'$.version') FROM split_groups WHERE id = NEW.group_id) = 2 BEGIN ${transactionGuard} END;
CREATE TRIGGER shared_transaction_cash_update BEFORE UPDATE ON transactions WHEN OLD.cash_effect_minor IS NOT NULL OR NEW.cash_effect_minor IS NOT NULL OR (SELECT json_extract(split_definition,'$.version') FROM split_groups WHERE id = NEW.group_id) = 2 BEGIN ${transactionGuard} END;
CREATE TRIGGER shared_entry_cash_insert BEFORE INSERT ON person_entries WHEN NEW.cash_effect_minor IS NOT NULL OR (SELECT json_extract(split_definition,'$.version') FROM split_groups WHERE id = NEW.split_group_id) = 2 BEGIN ${entryGuard} END;
CREATE TRIGGER shared_entry_cash_update BEFORE UPDATE ON person_entries WHEN OLD.cash_effect_minor IS NOT NULL OR NEW.cash_effect_minor IS NOT NULL OR (SELECT json_extract(split_definition,'$.version') FROM split_groups WHERE id = NEW.split_group_id) = 2 BEGIN ${entryGuard} END;
CREATE TRIGGER reconciled_cash_effect_no_update BEFORE UPDATE OF cash_effect_minor ON person_entries
WHEN EXISTS (SELECT 1 FROM entry_allocations WHERE source_entry_id = OLD.id OR target_entry_id = OLD.id)
  OR EXISTS (SELECT 1 FROM allocation_exclusions WHERE source_entry_id = OLD.id OR target_entry_id = OLD.id)
  OR EXISTS (SELECT 1 FROM group_settlement_requests WHERE source_entry_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'Reconciled cash effects are immutable'); END;
CREATE TRIGGER reconciled_split_definition_no_update BEFORE UPDATE OF split_definition ON split_groups
WHEN EXISTS (SELECT 1 FROM person_entries e WHERE e.split_group_id = OLD.id AND (
  EXISTS (SELECT 1 FROM entry_allocations WHERE source_entry_id = e.id OR target_entry_id = e.id) OR EXISTS (SELECT 1 FROM allocation_exclusions WHERE source_entry_id = e.id OR target_entry_id = e.id)))
BEGIN SELECT RAISE(ABORT, 'Reconciled shared definitions are immutable'); END;
`;

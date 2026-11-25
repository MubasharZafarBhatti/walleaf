// Multiple currencies. Each account keeps one currency and every record takes the
// currency of its account; nothing is ever converted. Existing rows keep their
// meaning: plans and goals are labelled with the main currency (a goal linked to
// an account takes that account's currency). A move between accounts in different
// currencies stores the exact amount that arrived, as the user typed it.
const accountCurrency = (accountIdSql: string) => `(SELECT currency FROM accounts WHERE id = ${accountIdSql})`;
const entryCurrency = (entryIdSql: string) => `(SELECT a.currency FROM person_entries e JOIN accounts a ON a.id = e.account_id WHERE e.id = ${entryIdSql})`;
const transferGuard = `SELECT CASE
  WHEN NEW.type <> 'TRANSFER' THEN RAISE(ABORT, 'Only a move between accounts has an amount received')
  WHEN ${accountCurrency('NEW.account_id')} IS NULL OR ${accountCurrency('NEW.destination_account_id')} IS NULL THEN NULL
  WHEN ${accountCurrency('NEW.account_id')} IS ${accountCurrency('NEW.destination_account_id')} AND NEW.destination_amount_minor IS NOT NULL
    THEN RAISE(ABORT, 'A move in one currency has a single amount')
  WHEN ${accountCurrency('NEW.account_id')} IS NOT ${accountCurrency('NEW.destination_account_id')} AND NEW.destination_amount_minor IS NULL
    THEN RAISE(ABORT, 'A move between currencies needs the amount received')
END;`;
const goalGuard = `SELECT CASE WHEN NEW.currency IS NOT ${accountCurrency('NEW.linked_account_id')}
  THEN RAISE(ABORT, 'A goal uses the currency of its linked account') END;`;
/** Keeps an account's currency once anything uses it, so its history keeps its meaning. */
export const accountCurrencyLock = `CREATE TRIGGER account_currency_locked BEFORE UPDATE OF currency ON accounts
WHEN NEW.currency IS NOT OLD.currency AND (
  EXISTS (SELECT 1 FROM transactions WHERE account_id = OLD.id OR destination_account_id = OLD.id)
  OR EXISTS (SELECT 1 FROM person_entries WHERE account_id = OLD.id)
  OR EXISTS (SELECT 1 FROM split_groups WHERE account_id = OLD.id)
  OR EXISTS (SELECT 1 FROM subscriptions WHERE account_id = OLD.id)
  OR EXISTS (SELECT 1 FROM planned_payments WHERE account_id = OLD.id)
  OR EXISTS (SELECT 1 FROM goals WHERE linked_account_id = OLD.id))
BEGIN SELECT RAISE(ABORT, 'Account currency cannot change once it has records'); END;`;
const pairGuard = `SELECT CASE WHEN ${entryCurrency('NEW.source_entry_id')} IS NOT ${entryCurrency('NEW.target_entry_id')}
  THEN RAISE(ABORT, 'A payment and a bill must be in the same currency') END;`;

export const migration14 = `
ALTER TABLE transactions ADD COLUMN destination_amount_minor INTEGER CHECK (destination_amount_minor IS NULL OR (typeof(destination_amount_minor) = 'integer' AND destination_amount_minor BETWEEN 1 AND 9007199254740991));
-- Before this version every amount was shown in the saved currency, whatever an
-- account had stored, so that is the currency the user's money is in.
UPDATE accounts SET currency = coalesce((SELECT value FROM app_settings WHERE key = 'currency'), currency);
ALTER TABLE budgets ADD COLUMN currency TEXT NOT NULL DEFAULT 'PKR';
UPDATE budgets SET currency = coalesce((SELECT value FROM app_settings WHERE key = 'currency'), 'PKR');
DROP INDEX IF EXISTS budgets_month_category_unique;
CREATE UNIQUE INDEX budgets_month_category_currency_unique ON budgets (month_key, ifnull(category_id, 'TOTAL'), currency) WHERE deleted_at IS NULL;
ALTER TABLE goals ADD COLUMN currency TEXT NOT NULL DEFAULT 'PKR';
UPDATE goals SET currency = coalesce(${accountCurrency('goals.linked_account_id')}, (SELECT value FROM app_settings WHERE key = 'currency'), 'PKR');
${accountCurrencyLock}
CREATE TRIGGER transfer_currency_insert BEFORE INSERT ON transactions WHEN NEW.type = 'TRANSFER' OR NEW.destination_amount_minor IS NOT NULL BEGIN ${transferGuard} END;
CREATE TRIGGER transfer_currency_update BEFORE UPDATE ON transactions WHEN NEW.type = 'TRANSFER' OR NEW.destination_amount_minor IS NOT NULL BEGIN ${transferGuard} END;
CREATE TRIGGER goal_currency_insert BEFORE INSERT ON goals WHEN NEW.linked_account_id IS NOT NULL BEGIN ${goalGuard} END;
CREATE TRIGGER goal_currency_update BEFORE UPDATE ON goals WHEN NEW.linked_account_id IS NOT NULL BEGIN ${goalGuard} END;
CREATE TRIGGER allocation_currency_guard BEFORE INSERT ON entry_allocations BEGIN ${pairGuard} END;
CREATE TRIGGER exclusion_currency_guard BEFORE INSERT ON allocation_exclusions BEGIN ${pairGuard} END;
`;

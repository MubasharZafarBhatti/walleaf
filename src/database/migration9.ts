// Runtime relationship and ordering indexes only; no persisted data is changed.
export const migration9 = `
CREATE INDEX IF NOT EXISTS idx_split_groups_event ON split_groups(financial_event_id);
CREATE INDEX IF NOT EXISTS idx_split_participants_split_person ON split_participants(split_group_id, person_id, is_self);
CREATE INDEX IF NOT EXISTS idx_person_entries_split ON person_entries(split_group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_group_created ON group_members(group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_allocation_exclusions_target ON allocation_exclusions(target_entry_id, source_entry_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_active_renewal ON subscriptions(next_renewal_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_goal_entries_goal_date ON goal_entries(goal_id, occurred_on DESC, created_at DESC);
`;

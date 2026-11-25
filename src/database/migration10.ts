/** Prospective editor intent only; NULL preserves unknown legacy intent. */
export const migration10 = `
ALTER TABLE split_groups ADD COLUMN split_definition TEXT;
`;

export type DemoGroupValidationGroup = { id: string; name: string; user_managed?: number };
export type DemoGroupValidationMember = {
  group_id: string;
  person_id?: string | null;
  is_self: number;
};
export type DemoGroupValidationSplit = {
  id: string;
  title: string;
  total_amount_minor: number;
  group_id?: string | null;
  payer_person_id?: string | null;
  payer_is_self: number;
};
export type DemoGroupValidationParticipant = {
  id: string;
  split_group_id: string;
  person_id?: string | null;
  is_self: number;
  share_minor: number;
};

export function validateDemoGroupRows(input: {
  groups: DemoGroupValidationGroup[];
  members: DemoGroupValidationMember[];
  splitGroups: DemoGroupValidationSplit[];
  participants: DemoGroupValidationParticipant[];
}): string[] {
  const errors: string[] = [];
  const required = [
    { id: 'demo_group_university', name: 'University Friends', members: 4, expenses: 2 },
    { id: 'demo_group_murree_trip', name: 'Murree Trip', members: 5, expenses: 4 },
  ];
  const groupIds = new Set(input.groups.map((group) => group.id));
  const peopleByGroup = new Map<string, Set<string>>();
  for (const member of input.members) {
    if (!peopleByGroup.has(member.group_id)) peopleByGroup.set(member.group_id, new Set());
    peopleByGroup.get(member.group_id)?.add(member.is_self ? 'SELF' : (member.person_id ?? ''));
  }
  for (const item of required) {
    if (!groupIds.has(item.id)) errors.push(`${item.name} group is missing`);
    const memberCount = peopleByGroup.get(item.id)?.size ?? 0;
    if (memberCount !== item.members && !input.groups.find((group) => group.id === item.id)?.user_managed)
      errors.push(`${item.name} has ${memberCount} members, expected ${item.members}`);
    const expenseCount = input.splitGroups.filter((split) => split.group_id === item.id).length;
    if (expenseCount < item.expenses)
      errors.push(`${item.name} has ${expenseCount} expenses, expected at least ${item.expenses}`);
  }
  const splitsById = new Map(input.splitGroups.map((split) => [split.id, split]));
  const participantsBySplit = new Map<string, DemoGroupValidationParticipant[]>();
  for (const participant of input.participants) {
    if (!participantsBySplit.has(participant.split_group_id))
      participantsBySplit.set(participant.split_group_id, []);
    participantsBySplit.get(participant.split_group_id)?.push(participant);
  }
  for (const split of input.splitGroups) {
    if (!split.group_id || !groupIds.has(split.group_id))
      errors.push(`${split.title} has an invalid group reference`);
    if (!split.payer_is_self && !split.payer_person_id)
      errors.push(`${split.title} has an invalid payer`);
    const rows = participantsBySplit.get(split.id) ?? [];
    if (!rows.length) errors.push(`${split.title} has no participants`);
    const participantKeys = new Set(rows.map((row) => (row.is_self ? 'SELF' : row.person_id)));
    if (participantKeys.size !== rows.length)
      errors.push(`${split.title} has duplicate participants`);
    const shareTotal = rows.reduce((sum, row) => sum + row.share_minor, 0);
    if (shareTotal !== split.total_amount_minor)
      errors.push(`${split.title} shares total ${shareTotal}, expected ${split.total_amount_minor}`);
  }
  for (const participant of input.participants) {
    if (!splitsById.has(participant.split_group_id))
      errors.push(`${participant.id} has an invalid split_group_id`);
  }
  return errors;
}

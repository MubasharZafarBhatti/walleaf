import { calculateSplit, type SplitMethod } from '../services/split/SplitService';
import { decodeSplitDefinition, encodeSplitDefinition } from '../services/split/SplitDefinition';

const participants = [{ key: 'SELF', name: 'You', isSelf: true }, { key: 'PERSON:b', personId: 'b', name: 'Bea', isSelf: false }, { key: 'PERSON:a', personId: 'a', name: 'Ali', isSelf: false }];
function fixture(method: SplitMethod) {
  const values = method === 'Exact' ? ['33.34', '33.33', '33.34'] : method === 'Percentage' ? ['33.33', '33.33', '33.34'] : method === 'Shares' ? ['1', '1', '1'] : ['', '', ''];
  const result = calculateSplit({ totalMinor: 10001, method, participants, values: Object.fromEntries(participants.map((p, i) => [p.key, values[i]])) });
  const text = encodeSplitDefinition(10001, result.shares, { method, values })!;
  const rows = result.shares.map((share, i) => ({ id: String(i), split_group_id: 'split', person_id: share.personId ?? null, name: share.name, is_self: share.isSelf ? 1 : 0, share_minor: share.shareMinor, created_at: '2026-10-06' }));
  return { text, rows };
}

test.each(['Equal', 'Exact', 'Percentage', 'Shares'] as SplitMethod[])('%s restores stable participant order for canonical rounding, not database row order', (method) => {
  const { text, rows } = fixture(method);
  const decoded = decodeSplitDefinition(text, 10001, [...rows].reverse())!;
  expect(decoded.method).toBe(method);
  expect(decoded.participants.map((p) => p.person_id)).toEqual([null, 'b', 'a']);
  expect(decoded.participants.reduce((sum, p) => sum + p.share_minor, 0)).toBe(10001);
});

test.each([
  (value: any) => { value.method = 'Guessed'; },
  (value: any) => { value.version = 2; },
  (value: any) => { value.participants[1].identity = 'SELF'; },
  (value: any) => { value.participants[1].identity = 'PERSON:unknown'; },
  (value: any) => { value.participants[1].value = '-1'; },
  (value: any) => { value.participants[1].value = '2'; },
])('invalid/mismatched editor intent is rejected rather than guessed (%#)', (change) => {
  const { text, rows } = fixture('Shares');
  const value = JSON.parse(text);
  change(value);
  expect(() => decodeSplitDefinition(JSON.stringify(value), 10001, rows)).toThrow();
});

test('legacy null intent remains unknown even when all final shares match', () => {
  expect(decodeSplitDefinition(null, 10000, [])).toBeNull();
  expect(encodeSplitDefinition(10000, [{ name: 'You', isSelf: true, shareMinor: 10000 }])).toBeNull();
});

test.each(['-1', '2', 'invalid'])('Equal rejects unused malformed participant value %s', (invalidValue) => {
  const { text, rows } = fixture('Equal');
  const value = JSON.parse(text);
  value.participants[1].value = invalidValue;
  expect(() => decodeSplitDefinition(JSON.stringify(value), 10001, rows)).toThrow('Equal split definitions');
  expect(() => encodeSplitDefinition(10001, rows.map((row) => ({ name: row.name, isSelf: row.is_self === 1, personId: row.person_id, shareMinor: row.share_minor })), { method: 'Equal', values: ['', invalidValue, ''] })).toThrow('Equal split definitions');
});

import { calculateSharedBill, personIdentity, routeSettlements, type BillPosition, type Contribution } from '../services/split/SharedBillCalculation';
import type { SplitMethod } from '../services/split/SplitService';

const participants = [
  { key: 'SELF', name: 'You', isSelf: true },
  ...['atif', 'ali', 'awais'].map((personId) => ({ key: personIdentity(personId), name: personId, personId, isSelf: false })),
];
const payer = (identity: string, paidMinor: number): Contribution => ({ identity, paidMinor });
const calculate = (paid = 200000, method: SplitMethod = 'Equal', total = 1200000) => calculateSharedBill({ totalMinor: total, method, participants, values: Object.fromEntries(participants.map((p) => [p.key, method === 'Exact' ? '3000' : method === 'Percentage' ? '25' : '1'])), payers: [payer('SELF', paid), payer(personIdentity('atif'), total - paid)] });
const pos = (identity: string, netMinor: number): BillPosition => ({ identity, shareMinor: netMinor < 0 ? -netMinor : 0, paidMinor: netMinor > 0 ? netMinor : 0, netMinor });

test('single-payer Equal and Exact/common=0 preserve existing consumption/funding', () => {
  for (const method of ['Equal', 'Exact'] as const) {
    const result = calculate(1200000, method);
    expect(result.shares.map((row) => row.shareMinor)).toEqual([300000, 300000, 300000, 300000]);
    expect(result).toMatchObject({ userShareMinor: 300000, userPaidMinor: 1200000, userNetMinor: 900000 });
    expect(result.routes.filter((row) => row.to === 'SELF').reduce((sum, row) => sum + row.amountMinor, 0)).toBe(900000);
  }
});

test.each([1, 2])('%i payer(s), restaurant Exact plus common produce exact base/common/final positions', (count) => {
  const result = calculateSharedBill({ totalMinor: 560000, method: 'Exact', participants, values: Object.fromEntries(participants.map((p, i) => [p.key, ['1200', '800', '1000', '1600'][i]])), commonCostMinor: 100000, payers: count === 1 ? [payer('SELF', 560000)] : [payer('SELF', 200000), payer(personIdentity('atif'), 360000)] });
  expect(result.commonAllocations).toEqual([25000, 25000, 25000, 25000]);
  expect(result.shares.map((row) => row.shareMinor)).toEqual([145000, 105000, 125000, 185000]);
  expect(result.userPaidMinor).toBe(count === 1 ? 560000 : 200000);
  if (count === 2) expect(result.positions).toEqual(expect.arrayContaining([
    expect.objectContaining({ identity: 'SELF', netMinor: 55000 }), expect.objectContaining({ identity: personIdentity('atif'), netMinor: 255000 }),
    expect.objectContaining({ identity: personIdentity('ali'), netMinor: -125000 }), expect.objectContaining({ identity: personIdentity('awais'), netMinor: -185000 }),
  ]));
});

test.each(['Equal', 'Percentage', 'Shares'] as const)('multiple payer funding is independent of %s consumption', (method) => {
  const result = calculate(400000, method, 1000000);
  expect(result).toMatchObject({ userShareMinor: 250000, userPaidMinor: 400000, userNetMinor: 150000 });
  expect(result.positions.find((row) => row.identity === personIdentity('atif'))?.netMinor).toBe(350000);
});

test.each([[200000, -100000], [800000, 500000], [300000, 0], [0, -300000]])('user paid %i vs consumed 300,000 -> net %i', (paid, net) => {
  const result = calculate(paid);
  expect(result).toMatchObject({ userShareMinor: 300000, userPaidMinor: paid, userNetMinor: net });
  expect(result.routes.filter((row) => row.from === 'SELF' || row.to === 'SELF').reduce((sum, row) => sum + row.amountMinor, 0)).toBe(Math.abs(net));
});

test('user payer outside participant set consumes zero; absent user creates third-party routes only', () => {
  const base = { totalMinor: 1000000, method: 'Equal' as const, participants: participants.slice(1), values: {} };
  expect(calculateSharedBill({ ...base, payers: [payer('SELF', 500000), payer(personIdentity('atif'), 500000)] })).toMatchObject({ userShareMinor: 0, userPaidMinor: 500000, userNetMinor: 500000 });
  const absent = calculateSharedBill({ ...base, payers: [payer(personIdentity('atif'), 1000000)] });
  expect(absent).toMatchObject({ userShareMinor: 0, userPaidMinor: 0, userNetMinor: 0 });
  expect(absent.routes.every((row) => row.from !== 'SELF' && row.to !== 'SELF')).toBe(true);
});

test.each([999999, 1000001])('funding total %i does not equal full bill and is rejected', (funding) => {
  expect(() => calculateSharedBill({ totalMinor: 1000000, method: 'Equal', participants, values: {}, payers: [payer('SELF', funding)] })).toThrow(/below|exceed/);
});
test.each([99999, 100001])('Exact base plus common %i under/over full bill is rejected', (commonCostMinor) => {
  expect(() => calculateSharedBill({ totalMinor: 560000, method: 'Exact', participants, values: Object.fromEntries(participants.map((p, i) => [p.key, ['1200', '800', '1000', '1600'][i]])), commonCostMinor, payers: [payer('SELF', 560000)] })).toThrow(/under|over/);
});

test('common remainders and Rs.10,000/7 assign every minor unit deterministically', () => {
  const seven = [...participants, ...['x', 'y', 'z'].map((id) => ({ key: personIdentity(id), name: id, personId: id, isSelf: false }))];
  const result = calculateSharedBill({ totalMinor: 1000000, method: 'Equal', participants: seven, values: {}, payers: [payer('SELF', 1000000)] });
  expect(result.shares.map((row) => row.shareMinor)).toEqual([142858, 142857, 142857, 142857, 142857, 142857, 142857]);
  const common = calculateSharedBill({ totalMinor: 5, method: 'Exact', participants, values: Object.fromEntries(participants.map((p) => [p.key, '0'])), commonCostMinor: 5, payers: [payer('SELF', 5)] });
  expect(common.commonAllocations).toEqual([2, 1, 1, 1]);
  expect(common.shares.reduce((sum, row) => sum + row.shareMinor, 0)).toBe(5);
});

test('routing is largest-first, stable-ID tied and independent of input/name ordering', () => {
  const positions = [pos('SELF', 150000), pos('PERSON:atif', 350000), pos('PERSON:ali', -250000), pos('PERSON:awais', -250000)];
  expect(routeSettlements(positions)).toEqual([
    { from: 'PERSON:ali', to: 'PERSON:atif', amountMinor: 250000 }, { from: 'PERSON:awais', to: 'PERSON:atif', amountMinor: 100000 }, { from: 'PERSON:awais', to: 'SELF', amountMinor: 150000 },
  ]);
  expect(routeSettlements([...positions].reverse())).toEqual(routeSettlements(positions));
});
test('custom user payable allocation reserves exact creditor capacity before third parties', () => {
  const positions = [pos('SELF', -200000), pos('PERSON:atif', 200000), pos('PERSON:ali', 300000), pos('PERSON:awais', -300000)];
  const routes = routeSettlements(positions, [{ identity: 'PERSON:atif', amountMinor: 50000 }, { identity: 'PERSON:ali', amountMinor: 150000 }]);
  expect(routes.filter((row) => row.from === 'SELF')).toEqual([{ from: 'SELF', to: 'PERSON:ali', amountMinor: 150000 }, { from: 'SELF', to: 'PERSON:atif', amountMinor: 50000 }]);
  expect(routes.reduce((sum, row) => sum + row.amountMinor, 0)).toBe(500000);
});
test('custom receivable allocation, duplicate/cap/total/stale identities are validated', () => {
  const positions = [pos('SELF', 400000), pos('PERSON:a', -100000), pos('PERSON:b', -300000), pos('PERSON:c', -200000), pos('PERSON:d', 200000)];
  const custom = [{ identity: 'PERSON:b', amountMinor: 250000 }, { identity: 'PERSON:c', amountMinor: 150000 }];
  expect(routeSettlements(positions, custom).filter((row) => row.to === 'SELF')).toHaveLength(2);
  for (const invalid of [[{ identity: 'PERSON:a', amountMinor: 400000 }], [{ identity: 'PERSON:a', amountMinor: 100000 }], [{ identity: 'PERSON:removed', amountMinor: 400000 }], [{ identity: 'PERSON:b', amountMinor: 200000 }, { identity: 'PERSON:b', amountMinor: 200000 }]]) expect(() => routeSettlements(positions, invalid)).toThrow();
});
test('payer removal invalidates funding and participant removal invalidates prior user routing', () => {
  expect(() => calculateSharedBill({ totalMinor: 1200000, method: 'Equal', participants, values: {}, payers: [payer('SELF', 200000)] })).toThrow('below');
  expect(() => calculateSharedBill({ totalMinor: 1200000, method: 'Equal', participants: participants.slice(0, 3), values: {}, payers: [payer('SELF', 200000), payer('PERSON:atif', 1000000)], customUserSettlement: [{ identity: 'PERSON:atif', amountMinor: 100000 }] })).toThrow('exact');
});

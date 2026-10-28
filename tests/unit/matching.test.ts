import { expect, it } from 'vitest';
import { genderAllows, genderGroupAllows } from '../../src/worker/matching/eligibility';
import { compareMatchRank, matchReasons } from '../../src/worker/matching/rank';

it.each([
  ['ANY', 'UNDISCLOSED', 'UNDISCLOSED', true],
  ['ANY', 'UNDISCLOSED', 'MAN', true],
  ['MAN', 'WOMAN', 'MAN', true],
  ['MAN', 'WOMAN', 'WOMAN', false],
  ['MAN', 'UNDISCLOSED', 'MAN', false],
  ['WOMAN', 'MAN', 'WOMAN', true],
  ['WOMAN', 'MAN', 'MAN', false],
  ['SAME_AS_ME', 'NON_BINARY', 'NON_BINARY', true],
  ['SAME_AS_ME', 'NON_BINARY', 'WOMAN', false],
  ['SAME_AS_ME', 'UNDISCLOSED', 'UNDISCLOSED', false],
] as const)('applies %s to %s and %s as %s', (filter, owner, other, allowed) => {
  expect(genderAllows(filter, owner, other)).toBe(allowed);
});

it('requires every pair in a passenger group to satisfy both filters', () => {
  expect(genderGroupAllows([
    { gender: 'WOMAN', filter: 'WOMAN' },
    { gender: 'WOMAN', filter: 'SAME_AS_ME' },
  ])).toBe(true);
  expect(genderGroupAllows([
    { gender: 'WOMAN', filter: 'WOMAN' },
    { gender: 'MAN', filter: 'ANY' },
  ])).toBe(false);
});

it('orders requested same-department matches, then time, creation and ID deterministically', () => {
  const base = { departmentPriority: false, timeDifference: 60_000, createdAt: 1, id: 'b' };
  expect(compareMatchRank({ ...base, departmentPriority: true }, base)).toBeLessThan(0);
  expect(compareMatchRank({ ...base, timeDifference: 30_000 }, base)).toBeLessThan(0);
  expect(compareMatchRank({ ...base, createdAt: 0 }, base)).toBeLessThan(0);
  expect(compareMatchRank({ ...base, id: 'a' }, base)).toBeLessThan(0);
  expect(matchReasons(true)).toEqual(['SAME_DEPARTMENT', 'DEPARTURE_TIME']);
  expect(matchReasons(false)).toEqual(['DEPARTURE_TIME']);
});

import { expect, it } from 'vitest';
import { isLocationFresh, projectVirtualMap } from '../../src/web/location-map';

it('marks locations fresh only for the current 30 second window', () => {
  const now = 1_800_000_000_000;
  expect(isLocationFresh(now - 30_000, now)).toBe(true);
  expect(isLocationFresh(now - 30_001, now)).toBe(false);
  expect(isLocationFresh(now + 1, now)).toBe(false);
});

it('fits the stop, locations, and accuracy circles inside the virtual map', () => {
  const points = projectVirtualMap({ lat: 37, lng: 127 }, [
    { id: 'self', label: '내 위치', kind: 'self', lat: 37.0005, lng: 127.0005, accuracyM: 75 },
    { id: 'peer', label: '운전자 위치', kind: 'peer', lat: 36.9997, lng: 126.9998, accuracyM: 20 },
  ]);

  expect(points).toHaveLength(3);
  for (const point of points) {
    expect(point.x - point.radius).toBeGreaterThanOrEqual(18);
    expect(point.x + point.radius).toBeLessThanOrEqual(302);
    expect(point.y - point.radius).toBeGreaterThanOrEqual(22);
    expect(point.y + point.radius).toBeLessThanOrEqual(198);
  }
  expect(points[1].radius).toBeGreaterThan(points[2].radius);
});

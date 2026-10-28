import { expect, it } from 'vitest';
import { locationUploadSchema } from '../../src/shared/location';

const location = {
  tripId: '50000000-0000-4000-8000-000000000001',
  requestId: null,
  lat: 37.5,
  lng: 127,
  accuracyM: 8,
  capturedAt: 1_800_000_000_000,
  sequence: 1,
};

it('validates bounded location uploads and rejects extra or out-of-range values', () => {
  expect(locationUploadSchema.safeParse(location).success).toBe(true);
  expect(locationUploadSchema.safeParse({ ...location, lat: 91 }).success).toBe(false);
  expect(locationUploadSchema.safeParse({ ...location, accuracyM: 0 }).success).toBe(false);
  expect(locationUploadSchema.safeParse({ ...location, sequence: 1.5 }).success).toBe(false);
  expect(locationUploadSchema.safeParse({ ...location, nickname: 'forged' }).success).toBe(false);
});

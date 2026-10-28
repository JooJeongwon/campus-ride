import { expect, it } from 'vitest';
import { rideRequestCreateSchema, tripCreateSchema, tripSearchQuerySchema } from '../../src/shared/trips';

const validTrip = {
  routeId: '40000000-0000-4000-8000-000000000001', departureAt: Date.now() + 600_000,
  seatCapacity: 2, genderFilter: 'ANY', preferSameDepartment: true,
};

it('validates a strict trip request and bounded passenger settings', () => {
  expect(tripCreateSchema.safeParse(validTrip).success).toBe(true);
  expect(tripCreateSchema.safeParse({ ...validTrip, seatCapacity: 5 }).success).toBe(false);
  expect(tripCreateSchema.safeParse({ ...validTrip, genderFilter: 'UNKNOWN' }).success).toBe(false);
  expect(tripCreateSchema.safeParse({ ...validTrip, requestedBy: 'another-user' }).success).toBe(false);
});

it('validates a strict ride request and its matching filter', () => {
  const validRequest = { desiredDepartureAt: Date.now() + 600_000, genderFilter: 'ANY', preferSameDepartment: true };
  expect(rideRequestCreateSchema.safeParse(validRequest).success).toBe(true);
  expect(rideRequestCreateSchema.safeParse({ ...validRequest, genderFilter: 'UNKNOWN' }).success).toBe(false);
  expect(rideRequestCreateSchema.safeParse({ ...validRequest, riderId: 'another-user' }).success).toBe(false);
});

it('parses a bounded trip search query without accepting unknown filters', () => {
  const query = new URLSearchParams({
    routeId: validTrip.routeId, desiredDepartureAt: String(Date.now() + 600_000),
    genderFilter: 'ANY', preferSameDepartment: 'true',
  });
  expect(tripSearchQuerySchema.safeParse(Object.fromEntries(query)).data?.preferSameDepartment).toBe(true);
  expect(tripSearchQuerySchema.safeParse({ ...Object.fromEntries(query), preferSameDepartment: 'yes' }).success).toBe(false);
  expect(tripSearchQuerySchema.safeParse({ ...Object.fromEntries(query), hidden: 'value' }).success).toBe(false);
});

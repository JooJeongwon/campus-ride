import { expect, it } from 'vitest';
import { driverProfileDecisionSchema, driverProfileSchema } from '../../src/shared/auth';

it('validates driver profile fields without accepting client approval state', () => {
  expect(driverProfileSchema.safeParse({
    vehicleModel: '차량', vehicleColor: '검정', vehicleIdentifier: 'TEST-ONLY', passengerCapacity: 4,
  }).success).toBe(true);
  expect(driverProfileSchema.safeParse({
    vehicleModel: '차량', vehicleColor: '검정', vehicleIdentifier: 'TEST-ONLY', passengerCapacity: 5,
  }).success).toBe(false);
  expect(driverProfileSchema.safeParse({
    vehicleModel: '차량', vehicleColor: '검정', vehicleIdentifier: 'TEST-ONLY', passengerCapacity: 4,
    verificationStatus: 'VERIFIED',
  }).success).toBe(false);
  expect(driverProfileDecisionSchema.safeParse({ outcome: 'REJECTED', validUntil: Date.now() + 60_000 }).success).toBe(false);
});

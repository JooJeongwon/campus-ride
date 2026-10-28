import { z } from 'zod';

export const tripCreateSchema = z.object({
  routeId: z.uuid(),
  departureAt: z.number().int().positive(),
  seatCapacity: z.number().int().min(1).max(4),
  genderFilter: z.enum(['ANY', 'MAN', 'WOMAN', 'SAME_AS_ME']),
  preferSameDepartment: z.boolean(),
}).strict();

export const rideRequestCreateSchema = z.object({
  desiredDepartureAt: z.number().int().positive(),
  genderFilter: z.enum(['ANY', 'MAN', 'WOMAN', 'SAME_AS_ME']),
  preferSameDepartment: z.boolean(),
}).strict();

export const tripSearchSchema = z.object({
  routeId: z.uuid(),
  desiredDepartureAt: z.number().int().positive(),
  genderFilter: z.enum(['ANY', 'MAN', 'WOMAN', 'SAME_AS_ME']),
  preferSameDepartment: z.boolean(),
}).strict();

export const tripSearchQuerySchema = z.object({
  routeId: z.uuid(),
  desiredDepartureAt: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().positive()),
  genderFilter: z.enum(['ANY', 'MAN', 'WOMAN', 'SAME_AS_ME']),
  preferSameDepartment: z.enum(['true', 'false']).transform((value) => value === 'true'),
  cursor: z.string().min(1).max(1024).optional(),
}).strict();

export const tripSearchCursorSchema = z.object({
  queryHash: z.string().regex(/^[a-f0-9]{64}$/),
  departmentPriority: z.number().int().min(0).max(1),
  timeDifference: z.number().int().nonnegative(),
  createdAt: z.number().int().positive(),
  id: z.uuid(),
}).strict();

export const tripMatchSchema = z.object({
  id: z.uuid(), driverNickname: z.string(), routeId: z.uuid(), originName: z.string(), destinationName: z.string(),
  departureAt: z.number().int(), expiresAt: z.number().int(), seatCapacity: z.number().int(),
  remainingSeats: z.number().int().nonnegative(), genderFilter: z.enum(['ANY', 'MAN', 'WOMAN', 'SAME_AS_ME']),
  preferSameDepartment: z.boolean(), createdAt: z.number().int(), sameDepartment: z.boolean(),
  timeDifferenceMinutes: z.number().int().nonnegative(),
  matchReasons: z.array(z.enum(['SAME_DEPARTMENT', 'DEPARTURE_TIME'])),
});

export const tripSearchResponseSchema = z.object({
  data: z.array(tripMatchSchema), nextCursor: z.string().nullable(),
});

export type TripSearchInput = z.infer<typeof tripSearchSchema>;
export type TripMatch = z.infer<typeof tripMatchSchema>;

export const lifecycleCommandSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reasonCode: z.string().regex(/^[A-Z0-9_]{1,40}$/).optional(),
}).strict();

export const boardingCodeInputSchema = z.string().regex(/^\d{6}$/);

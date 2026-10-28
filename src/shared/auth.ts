import { z } from 'zod';

export const devLoginSchema = z.object({ identity: z.enum(['driver', 'rider', 'pending', 'admin']) }).strict();
export const profileUpdateSchema = z.object({
  nickname: z.string().trim().min(1).max(30).optional(),
  gender: z.enum(['MAN', 'WOMAN', 'NON_BINARY', 'UNDISCLOSED']).optional(),
}).strict().refine((value) => Object.keys(value).length > 0);
export const verificationDecisionSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('VERIFIED'), validUntil: z.number().int().positive() }).strict(),
  z.object({ outcome: z.literal('REJECTED') }).strict(),
]);
export const driverProfileSchema = z.object({
  vehicleModel: z.string().trim().min(1).max(80),
  vehicleColor: z.string().trim().min(1).max(30),
  vehicleIdentifier: z.string().trim().min(1).max(30),
  passengerCapacity: z.number().int().min(1).max(4),
}).strict();
export const driverProfileDecisionSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('VERIFIED'), validUntil: z.number().int().positive() }).strict(),
  z.object({ outcome: z.literal('REJECTED') }).strict(),
]);
export const consentSchema = z.object({
  kind: z.enum(['TERMS', 'PRIVACY', 'LOCATION_COLLECTION', 'LOCATION_SHARING']),
  policyVersion: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  granted: z.boolean(),
}).strict();

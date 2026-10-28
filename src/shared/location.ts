import { z } from 'zod';

export const locationUploadSchema = z.object({
  tripId: z.uuid(),
  requestId: z.uuid().nullable(),
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
  accuracyM: z.number().finite().positive(),
  capturedAt: z.number().int().positive(),
  sequence: z.number().int().positive().safe(),
}).strict();

export type LocationUpload = z.infer<typeof locationUploadSchema>;

export const locationDisclosureAckSchema = z.object({
  disclosureIds: z.array(z.uuid()).min(1).max(20),
}).strict();

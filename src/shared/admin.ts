import { z } from 'zod';

export const adminStopSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['GATE', 'DESTINATION']),
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
  active: z.boolean(),
}).strict();

export const adminRouteCreateSchema = z.object({ originStopId: z.uuid(), destinationStopId: z.uuid() })
  .strict().refine((value) => value.originStopId !== value.destinationStopId);
export const adminRouteUpdateSchema = z.object({ active: z.boolean() }).strict();

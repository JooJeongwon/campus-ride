import { z } from 'zod';

export const reportCreateSchema = z.object({
  requestId: z.uuid(),
  category: z.string().trim().min(1).max(50),
  description: z.string().trim().min(1).max(2000),
}).strict();

export const reportDecisionSchema = z.object({
  status: z.enum(['IN_REVIEW', 'RESOLVED', 'DISMISSED']),
}).strict();

export const blockCreateSchema = z.object({ blockedUserId: z.uuid() }).strict();

export const suspendUserSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

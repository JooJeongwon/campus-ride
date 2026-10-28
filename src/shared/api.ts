import { z } from 'zod';

export const healthResponse = z.object({
  data: z.object({ status: z.literal('ok') }),
  meta: z.object({ requestId: z.uuid() }),
});

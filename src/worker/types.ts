import type { Context } from 'hono';
import type { Bindings } from './env';

export type AppEnv = { Bindings: Bindings; Variables: { requestId: string } };
export type AppContext = Context<AppEnv>;

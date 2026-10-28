import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-plugin';
import type { Bindings } from '../../src/worker/env';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Cloudflare 런타임의 공식 환경 타입 확장 지점.
  namespace Cloudflare {
    interface Env extends Bindings {
      TEST_MIGRATIONS: D1Migration[];
      TEST_SEED: D1Migration[];
    }
    interface GlobalProps {
      mainModule: typeof import('../../src/worker');
    }
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
await applyD1Migrations(env.DB, env.TEST_SEED, 'test_seed_migrations');

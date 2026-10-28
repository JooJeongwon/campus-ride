import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: { bindings: {
      TEST_MIGRATIONS: await readD1Migrations('./migrations'),
      TEST_SEED: await readD1Migrations('./fixtures'),
    } },
  })],
  test: { include: ['tests/integration/**/*.test.ts'], setupFiles: ['./tests/integration/setup.ts'] },
});

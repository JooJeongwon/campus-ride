import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  use: { baseURL: 'http://localhost:8787' },
  webServer: {
    command: 'npm run dev -- --port 8787',
    url: 'http://localhost:8787/api/v1/health',
    reuseExistingServer: false,
    timeout: 60000,
  },
});

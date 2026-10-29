import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  use: { baseURL: 'http://localhost:8788' },
  webServer: {
    command: 'npm run dev -- --port 8788',
    url: 'http://localhost:8788/api/v1/health',
    env: { VITE_NAVER_MAP_CLIENT_ID: '' },
    reuseExistingServer: false,
    timeout: 60000,
  },
});

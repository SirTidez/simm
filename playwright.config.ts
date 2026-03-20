import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 120000,
  fullyParallel: false,
  workers: 1,
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run tauri:playwright',
    url: 'http://127.0.0.1:9222/json/version',
    reuseExistingServer: true,
    timeout: 180000,
  },
});

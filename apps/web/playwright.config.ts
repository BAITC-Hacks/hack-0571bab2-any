import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export default defineConfig({
  testDir: './tests',
  testIgnore: '**/integration/**',
  fullyParallel: true,
  workers: 2,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5175',
    browserName: 'chromium',
    launchOptions: existsSync(systemChrome) ? { executablePath: systemChrome } : {},
  },
  webServer: {
    command: 'npm run dev -- --port 5175 --host 127.0.0.1',
    url: 'http://127.0.0.1:5175',
    reuseExistingServer: !process.env.CI,
  },
});

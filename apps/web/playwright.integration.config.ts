import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export default defineConfig({
  testDir: './tests/integration',
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5180',
    browserName: 'chromium',
    launchOptions: existsSync(systemChrome) ? { executablePath: systemChrome } : {},
  },
  webServer: [
    {
      command: 'npm --prefix ../api run dev',
      url: 'http://127.0.0.1:3010/api/health',
      reuseExistingServer: false,
      env: {
        PORT: '3010', API_ORIGIN: 'http://127.0.0.1:3010', WEB_ORIGIN: 'http://127.0.0.1:5180',
        CATALOG_MODE: 'demo', COOKIE_SECURE: 'false', AI_PROVIDER: 'none', EXTERNAL_AI_ALLOWED: 'false',
        OPENAI_API_KEY: '', NVIDIA_API_KEY: '', EKT_API_USERNAME: '', EKT_API_PASSWORD: '',
      },
    },
    {
      command: 'npm run dev -- --port 5180 --host 127.0.0.1 --strictPort',
      url: 'http://127.0.0.1:5180',
      reuseExistingServer: false,
      env: { VITE_API_PROXY_TARGET: 'http://127.0.0.1:3010' },
    },
  ],
});

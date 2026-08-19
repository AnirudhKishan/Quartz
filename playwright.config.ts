import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  preserveOutput: 'always',
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { viewport: { width: 1280, height: 720 } },
    },
    {
      name: 'galaxy-s22-ultra',
      use: {
        viewport: { width: 384, height: 824 },
        deviceScaleFactor: 3.75,
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: 'observed-mobile-401',
      grep: /@timeline-geometry/,
      use: {
        viewport: { width: 401, height: 873 },
        deviceScaleFactor: 3,
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: 'observed-mobile-406',
      grep: /@timeline-geometry/,
      use: {
        viewport: { width: 406, height: 892 },
        deviceScaleFactor: 3,
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
  },
});

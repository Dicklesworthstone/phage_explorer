import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  timeout: 60000,
  expect: {
    timeout: 10000,
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 4,
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['list'],
  ],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173',
    headless: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'bunx vite preview --port 5173',
    port: 5173,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
  outputDir: 'test-results',
  projects: [
    // Desktop browsers
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // Mobile devices - Portrait (all using Chromium engine for consistency)
    {
      name: 'mobile-small',
      use: {
        ...devices['iPhone SE'],
        // Override to use Chromium
        defaultBrowserType: 'chromium',
      },
    },
    {
      name: 'mobile-medium',
      use: {
        ...devices['iPhone 14'],
        defaultBrowserType: 'chromium',
      },
    },
    {
      name: 'mobile-large',
      use: {
        ...devices['iPhone 14 Pro Max'],
        defaultBrowserType: 'chromium',
      },
    },
    {
      name: 'android-phone',
      use: { ...devices['Pixel 7'] },
    },
    // Mobile devices - Landscape
    {
      name: 'mobile-landscape',
      use: {
        ...devices['iPhone 14 landscape'],
        defaultBrowserType: 'chromium',
      },
    },
    // Tablets
    {
      name: 'tablet-small',
      use: {
        ...devices['iPad Mini'],
        defaultBrowserType: 'chromium',
      },
    },
    {
      name: 'tablet-large',
      use: {
        ...devices['iPad Pro 11'],
        defaultBrowserType: 'chromium',
      },
    },
    // Targeted WebKit project to approximate iPhone Safari for the sequence scroll repaint regression.
    // Keep this scoped to a single test file to avoid multiplying runtime across the full suite.
    {
      name: 'webkit-sequence',
      testMatch: /sequence-scroll-repaint\.e2e\.ts/,
      use: {
        ...devices['iPhone 14'],
        defaultBrowserType: 'webkit',
      },
    },
  ],
});

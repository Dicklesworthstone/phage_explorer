import { defineConfig, devices } from '@playwright/test';

/**
 * Specs whose assertions are viewport-independent.
 *
 * These check what the app CLAIMS about its data -- which provenance banner is
 * shown, which number the banner quotes -- not how it lays that out. Running
 * them across all seven mobile and tablet projects costs seven extra browser
 * launches per assertion and produces no signal the desktop run did not already
 * give. They stay on `chromium` only.
 *
 * This is not a blanket rule: a spec that touches layout, hit targets, or
 * scrolling belongs on the mobile projects and must not be added here.
 */
const DESKTOP_ONLY = /provenance-banner\.e2e\.ts/;

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
      testIgnore: DESKTOP_ONLY,
      use: {
        ...devices['iPhone SE'],
        // Override to use Chromium
        defaultBrowserType: 'chromium',
      },
    },
    {
      name: 'mobile-medium',
      testIgnore: DESKTOP_ONLY,
      use: {
        ...devices['iPhone 14'],
        defaultBrowserType: 'chromium',
      },
    },
    {
      name: 'mobile-large',
      testIgnore: DESKTOP_ONLY,
      use: {
        ...devices['iPhone 14 Pro Max'],
        defaultBrowserType: 'chromium',
      },
    },
    {
      name: 'android-phone',
      testIgnore: DESKTOP_ONLY,
      use: { ...devices['Pixel 7'] },
    },
    // Mobile devices - Landscape
    {
      name: 'mobile-landscape',
      testIgnore: DESKTOP_ONLY,
      use: {
        ...devices['iPhone 14 landscape'],
        defaultBrowserType: 'chromium',
      },
    },
    // Tablets
    {
      name: 'tablet-small',
      testIgnore: DESKTOP_ONLY,
      use: {
        ...devices['iPad Mini'],
        defaultBrowserType: 'chromium',
      },
    },
    {
      name: 'tablet-large',
      testIgnore: DESKTOP_ONLY,
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

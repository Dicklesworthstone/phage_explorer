import { defineConfig, devices } from '@playwright/test';

const REQUEST_USER_AGENT = 'OpenAI File Downloader, XaiImageApiFetch/1.0';
const configuredBaseURL = process.env.PLAYWRIGHT_BASE_URL;
if (process.env.PLAYWRIGHT_LIVE === '1' && !configuredBaseURL) {
  throw new Error('PLAYWRIGHT_LIVE=1 requires an explicit PLAYWRIGHT_BASE_URL.');
}
const baseURL = configuredBaseURL ?? 'http://localhost:5173';
if (!['http:', 'https:'].includes(new URL(baseURL).protocol)) {
  throw new Error('PLAYWRIGHT_BASE_URL must use HTTP or HTTPS.');
}
const browserDevice = (name: keyof typeof devices) => ({
  ...devices[name],
  userAgent: REQUEST_USER_AGENT,
});

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
// PWA lifecycle assertions use the dedicated production-worker project below.
const DESKTOP_ONLY = /(?:provenance-(?:banner|badge)|pwa)\.e2e\.ts/;

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
    baseURL,
    userAgent: REQUEST_USER_AGENT,
    headless: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  // An explicit URL means the caller owns that server, including live runs.
  webServer: configuredBaseURL ? undefined : {
    command: 'bunx vite preview --port 5173 --strictPort',
    port: 5173,
    reuseExistingServer: false,
    timeout: 30000,
  },
  outputDir: 'test-results',
  projects: [
    // Desktop browsers
    {
      name: 'chromium',
      testIgnore: /pwa\.e2e\.ts/,
      use: { ...browserDevice('Desktop Chrome') },
    },
    {
      name: 'firefox-research',
      testMatch: /(?:local-genome-import|scientific-results|accessibility)\.e2e\.ts/,
      use: {
        ...browserDevice('Desktop Firefox'),
        launchOptions: { firefoxUserPrefs: { 'general.useragent.override': REQUEST_USER_AGENT } },
      },
    },
    {
      name: 'webkit-research',
      testMatch: /(?:local-genome-import|scientific-results|accessibility)\.e2e\.ts/,
      use: { ...browserDevice('Desktop Safari') },
    },
    {
      name: 'chromium-pwa',
      testMatch: /pwa\.e2e\.ts/,
      use: {
        ...browserDevice('Desktop Chrome'),
        serviceWorkers: 'allow',
        launchOptions: { args: [`--user-agent=${REQUEST_USER_AGENT}`] },
      },
    },
    // Mobile devices - Portrait (all using Chromium engine for consistency)
    {
      name: 'mobile-small',
      testIgnore: DESKTOP_ONLY,
      use: {
        ...browserDevice('iPhone SE'),
        // Override to use Chromium
        defaultBrowserType: 'chromium',
      },
    },
    {
      name: 'mobile-medium',
      testIgnore: DESKTOP_ONLY,
      use: {
        ...browserDevice('iPhone 14'),
        defaultBrowserType: 'chromium',
      },
    },
    {
      name: 'mobile-large',
      testIgnore: DESKTOP_ONLY,
      use: {
        ...browserDevice('iPhone 14 Pro Max'),
        defaultBrowserType: 'chromium',
      },
    },
    {
      name: 'android-phone',
      testIgnore: DESKTOP_ONLY,
      use: { ...browserDevice('Pixel 7') },
    },
    // Mobile devices - Landscape
    {
      name: 'mobile-landscape',
      testIgnore: DESKTOP_ONLY,
      use: {
        ...browserDevice('iPhone 14 landscape'),
        defaultBrowserType: 'chromium',
      },
    },
    // Tablets
    {
      name: 'tablet-small',
      testIgnore: DESKTOP_ONLY,
      use: {
        ...browserDevice('iPad Mini'),
        defaultBrowserType: 'chromium',
      },
    },
    {
      name: 'tablet-large',
      testIgnore: DESKTOP_ONLY,
      use: {
        ...browserDevice('iPad Pro 11'),
        defaultBrowserType: 'chromium',
      },
    },
    // Targeted WebKit project to approximate iPhone Safari for the sequence scroll repaint regression.
    // Keep this scoped to a single test file to avoid multiplying runtime across the full suite.
    {
      name: 'webkit-sequence',
      testMatch: /sequence-scroll-repaint\.e2e\.ts/,
      use: {
        ...browserDevice('iPhone 14'),
        defaultBrowserType: 'webkit',
      },
    },
  ],
});

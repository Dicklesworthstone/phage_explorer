/**
 * Playwright Test Harness
 *
 * Standardized observability for e2e tests with structured artifacts:
 * - events.jsonl: timestamped events and step boundaries
 * - console-errors.json: console error entries
 * - page-errors.json: uncaught page errors
 * - network.json: filtered request/response data
 */

import { expect, type Page, type TestInfo, type ConsoleMessage, type Request, type Response } from '@playwright/test';
import * as fs from 'fs/promises';
import * as path from 'path';

/** Assert the selected origin, expected release data, and an actual catalog. */
export async function expectExplorerIdentity(page: Page, testInfo: TestInfo): Promise<void> {
  const baseURL = testInfo.project.use.baseURL;
  if (!baseURL) throw new Error('Explorer verification requires a configured baseURL.');
  const origin = new URL(baseURL).origin;
  expect(new URL(page.url()).origin, 'Selected explorer origin').toBe(origin);
  const expected = JSON.parse(await fs.readFile(new URL('../public/phage.db.manifest.json', import.meta.url), 'utf8'));
  const descriptor = await page.evaluate(async () => {
    const response = await fetch('/phage.db.manifest.json', { cache: 'no-store' });
    return { ok: response.ok, url: response.url, manifest: await response.json() };
  });
  expect(descriptor.ok, 'Database descriptor response').toBe(true);
  expect(new URL(descriptor.url).origin, 'Database descriptor origin').toBe(origin);
  expect(descriptor.manifest.version, 'Database descriptor contract').toBe(2);
  expect(descriptor.manifest.contentVersion, 'Expected database content version').toBe(process.env.PLAYWRIGHT_EXPECTED_CONTENT_VERSION ?? expected.contentVersion);
  expect(descriptor.manifest.sha256, 'Expected database byte digest').toBe(process.env.PLAYWRIGHT_EXPECTED_DATABASE_SHA256 ?? expected.sha256);
  await expect(page.getByRole('heading', { level: 1 }), 'Loaded lambda catalog entry').toContainText('Enterobacteria phage lambda');
  const picker = page.getByRole('button', { name: /^Explore phages\. Currently viewing/ });
  if (await picker.isVisible()) {
    const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(picker).toHaveAttribute('aria-label', /lambda, 1 of 24$/);
    await picker.click();
    const sheet = page.getByTestId('phage-picker-sheet');
    await expect(sheet.getByRole('listitem'), 'Loaded mobile catalog size').toHaveCount(24);
    await expect(sheet.getByRole('button', { name: 'Open Enterobacteria phage lambda, current phage', exact: true }), 'Loaded mobile lambda genome length').toContainText('48,502');
    await page.getByRole('dialog', { name: 'Explore phages', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(sheet).not.toBeVisible();
  } else {
    await expect(page.getByTestId('phage-list-item-selected'), 'Loaded lambda catalog entry').toContainText('Enterobacteria phage lambda');
    await expect(page.locator('[data-testid^="phage-list-item"]'), 'Loaded catalog size').toHaveCount(24);
    await expect(page.getByTestId('phage-list-item-selected'), 'Loaded lambda genome length').toContainText('48,502');
  }
  await testInfo.attach('explorer-identity', { body: JSON.stringify({ origin, manifest: descriptor.manifest, selectedPhage: 'lambda', catalogCount: 24 }), contentType: 'application/json' });
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface TestEvent {
  ts: number;
  type: 'step' | 'pageerror' | 'console' | 'request' | 'response' | 'requestfailed' | 'custom';
  data: unknown;
}

export interface ConsoleEntry {
  ts: number;
  type: string;
  text: string;
  location?: { url?: string; lineNumber?: number; columnNumber?: number };
}

export interface PageErrorEntry {
  ts: number;
  message: string;
  stack?: string;
}

export interface NetworkEntry {
  ts: number;
  type: 'request' | 'response' | 'requestfailed';
  url: string;
  method?: string;
  status?: number;
  resourceType?: string;
  failure?: string;
}

export interface TestHarnessState {
  events: TestEvent[];
  consoleErrors: ConsoleEntry[];
  consoleWarnings: ConsoleEntry[];
  pageErrors: PageErrorEntry[];
  network: NetworkEntry[];
  startTs: number;
}

// -----------------------------------------------------------------------------
// Filter patterns for network capture
// -----------------------------------------------------------------------------

const CAPTURE_NETWORK_PATTERNS = [
  /\.js$/, // Dynamic chunks
  /\.wasm$/, // WASM modules
  /phage\.db/, // SQLite database
  /\/entrez\/eutils\//, // Real scientific inputs and explicit network-failure controls
  /worker/, // Web workers
  /chunk/, // Code-split chunks
  /\.woff2?$/, // Fonts (optional, can be noisy)
];

function shouldCaptureRequest(url: string): boolean {
  return CAPTURE_NETWORK_PATTERNS.some((pattern) => pattern.test(url));
}

// -----------------------------------------------------------------------------
// Harness Implementation
// -----------------------------------------------------------------------------

interface LegacyArrays {
  pageErrors?: string[];
  consoleErrors?: string[];
}

export function createTestHarness(page: Page, legacyArrays?: LegacyArrays): TestHarnessState {
  const state: TestHarnessState = {
    events: [],
    consoleErrors: [],
    consoleWarnings: [],
    pageErrors: [],
    network: [],
    startTs: Date.now(),
  };

  // Page error handler
  page.on('pageerror', (error: Error) => {
    const entry: PageErrorEntry = {
      ts: Date.now() - state.startTs,
      message: error.message,
      stack: error.stack,
    };
    state.pageErrors.push(entry);
    state.events.push({ ts: entry.ts, type: 'pageerror', data: entry });

    // Also populate legacy array if provided (single handler, no duplicates)
    legacyArrays?.pageErrors?.push(error.message);
  });

  // Console handler
  page.on('console', (msg: ConsoleMessage) => {
    const msgType = msg.type();
    const location = msg.location();
    const entry: ConsoleEntry = {
      ts: Date.now() - state.startTs,
      type: msgType,
      text: msg.text(),
      location: location.url ? {
        url: location.url,
        lineNumber: location.lineNumber,
        columnNumber: location.columnNumber,
      } : undefined,
    };

    if (msgType === 'error') {
      if (location.url && location.url.includes('/_vercel/')) {
        return;
      }
      state.consoleErrors.push(entry);
      state.events.push({ ts: entry.ts, type: 'console', data: { level: 'error', ...entry } });

      // Also populate legacy array if provided (single handler, no duplicates)
      legacyArrays?.consoleErrors?.push(msg.text());
    } else if (msgType === 'warning') {
      state.consoleWarnings.push(entry);
      state.events.push({ ts: entry.ts, type: 'console', data: { level: 'warning', ...entry } });
    }
  });

  // Network request handler
  page.on('request', (request: Request) => {
    const url = request.url();
    if (!shouldCaptureRequest(url)) return;

    const entry: NetworkEntry = {
      ts: Date.now() - state.startTs,
      type: 'request',
      url,
      method: request.method(),
      resourceType: request.resourceType(),
    };
    state.network.push(entry);
    state.events.push({ ts: entry.ts, type: 'request', data: entry });
  });

  // Network response handler
  page.on('response', (response: Response) => {
    const url = response.url();
    if (!shouldCaptureRequest(url)) return;

    const request = response.request();
    const entry: NetworkEntry = {
      ts: Date.now() - state.startTs,
      type: 'response',
      url,
      method: request.method(),
      status: response.status(),
      resourceType: request.resourceType(),
    };
    state.network.push(entry);
    state.events.push({ ts: entry.ts, type: 'response', data: entry });
  });

  page.on('requestfailed', (request: Request) => {
    if (!shouldCaptureRequest(request.url())) return;
    const entry: NetworkEntry = {
      ts: Date.now() - state.startTs,
      type: 'requestfailed',
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      failure: request.failure()?.errorText,
    };
    state.network.push(entry);
    state.events.push({ ts: entry.ts, type: 'requestfailed', data: entry });
  });

  return state;
}

/**
 * Add a custom event to the harness log
 */
export function logEvent(state: TestHarnessState, type: TestEvent['type'], data: unknown): void {
  state.events.push({
    ts: Date.now() - state.startTs,
    type,
    data,
  });
}

/**
 * Log a test step boundary (use with test.step for correlation)
 */
export function logStep(state: TestHarnessState, name: string, status: 'start' | 'end'): void {
  logEvent(state, 'step', { name, status });
}

/**
 * Write all collected artifacts to test output directory
 */
export async function writeArtifacts(state: TestHarnessState, testInfo: TestInfo): Promise<void> {
  const outputDir = testInfo.outputDir;

  // Ensure output directory exists
  await fs.mkdir(outputDir, { recursive: true });

  // Write events.jsonl (newline-delimited JSON)
  const eventsPath = path.join(outputDir, 'events.jsonl');
  const eventsContent = state.events.map((e) => JSON.stringify(e)).join('\n');
  await fs.writeFile(eventsPath, eventsContent, 'utf-8');

  // Write console-errors.json
  const consoleErrorsPath = path.join(outputDir, 'console-errors.json');
  await fs.writeFile(consoleErrorsPath, JSON.stringify(state.consoleErrors, null, 2), 'utf-8');

  // Write page-errors.json
  const pageErrorsPath = path.join(outputDir, 'page-errors.json');
  await fs.writeFile(pageErrorsPath, JSON.stringify(state.pageErrors, null, 2), 'utf-8');

  // Write network.json
  const networkPath = path.join(outputDir, 'network.json');
  await fs.writeFile(networkPath, JSON.stringify(state.network, null, 2), 'utf-8');

  // Attach artifacts to test report
  await testInfo.attach('events.jsonl', { path: eventsPath, contentType: 'application/jsonl' });
  await testInfo.attach('console-errors.json', { path: consoleErrorsPath, contentType: 'application/json' });
  await testInfo.attach('page-errors.json', { path: pageErrorsPath, contentType: 'application/json' });
  await testInfo.attach('network.json', { path: networkPath, contentType: 'application/json' });
}

/**
 * Convenience wrapper that creates harness and registers cleanup
 */
export function setupTestHarness(page: Page, testInfo: TestInfo): {
  state: TestHarnessState;
  finalize: () => Promise<void>;
  /** Arrays for inline assertions (backwards compatible with existing patterns) */
  pageErrors: string[];
  consoleErrors: string[];
} {
  // Backwards-compatible arrays for existing inline assertions
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];

  // Create harness state with legacy arrays populated from the same handlers
  const state = createTestHarness(page, { pageErrors, consoleErrors });
  const unexpectedLocalRequests: string[] = [];
  const selectedHost = new URL(testInfo.project.use.baseURL ?? 'http://localhost').hostname;
  const isLoopback = (host: string) => host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (process.env.PLAYWRIGHT_LIVE === '1' && !isLoopback(selectedHost)) {
    page.on('request', request => {
      if (isLoopback(new URL(request.url()).hostname)) {
        unexpectedLocalRequests.push(request.url());
        logEvent(state, 'custom', { unexpectedLocalRequest: request.url() });
      }
    });
  }

  const finalize = async () => {
    await writeArtifacts(state, testInfo);
    expect(unexpectedLocalRequests, 'Live verification must not request localhost').toEqual([]);
  };

  return { state, finalize, pageErrors, consoleErrors };
}

/**
 * Get summary stats for quick assertions
 */
export function getHarnessSummary(state: TestHarnessState): {
  errorCount: number;
  warningCount: number;
  pageErrorCount: number;
  networkRequestCount: number;
  durationMs: number;
} {
  return {
    errorCount: state.consoleErrors.length,
    warningCount: state.consoleWarnings.length,
    pageErrorCount: state.pageErrors.length,
    networkRequestCount: state.network.filter((n) => n.type === 'request').length,
    durationMs: Date.now() - state.startTs,
  };
}

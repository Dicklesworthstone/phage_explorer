import { test, expect, type Page, type Route, type TestInfo } from '@playwright/test';
import { expectExplorerIdentity, setupTestHarness } from './e2e-harness';

/**
 * The banner must describe the data that was actually used.
 *
 * The phylodynamics overlay printed a green "REAL DATA" banner over a tree
 * built from hashes of accession strings. Deleting the hash was necessary and
 * not sufficient: unavailable data must remain unavailable until a user
 * explicitly selects an illustration. Real retrieved sequences must retain
 * their analysis path and the banner must count the sequences actually used.
 *
 * That is what this file checks, and it checks it by CONTROLLING the network
 * rather than hoping. A test that merely opens the overlay and reads the banner
 * asserts nothing about correctness: it passes whichever path happened to run,
 * and on a machine with no network it would pass while permanently exercising
 * one branch. Both branches are forced here.
 *
 * No-claim line: this proves the banner tracks the data source. It does not
 * prove the analysis behind the banner is correct; the distance matrix and the
 * clock are covered by unit tests in packages/core.
 */

/**
 * The app registers a service worker (VitePWA). Requests that originate inside
 * a service worker are not seen by `page.route`, so without this the mocks
 * below are silently bypassed and the overlay sits in its loading state
 * forever. Blocking the worker keeps the network under the test's control.
 *
 * This is not testing around a bug: offline behaviour has its own specs. Here
 * the subject is which provenance the overlay claims for the data it used, and
 * that requires deciding what the network returns.
 */
test.use({ serviceWorkers: 'block' });

/**
 * One worker for this file.
 *
 * The repo runs `fullyParallel: true` with four workers locally, which put
 * three browsers through a 10 MB SQLite load at once. The overlay then genuinely
 * sat in its loading state past the timeout and the run failed for a reason
 * that had nothing to do with provenance. 'default' mode runs these in order in
 * a single worker; unlike 'serial' it does not skip the rest when one fails, so
 * each still reports its own result.
 */
test.describe.configure({ mode: 'default' });

const NCBI_GLOB = 'https://eutils.ncbi.nlm.nih.gov/**';

async function bootstrap(page: Page, testInfo: TestInfo): Promise<void> {
  // Seed BEFORE the first navigation rather than setting storage and reloading.
  // The reload cost a second full boot of the app, including a 10 MB SQLite
  // load, and doubled every test's runtime for no added coverage.
  await page.addInitScript(() => {
    localStorage.setItem(
      'phage-explorer-main-prefs',
      JSON.stringify({ experienceLevel: 'power' })
    );
    // Each Playwright test starts with a fresh browser context.
  });

  await page.goto('/?phage=lambda&model=0');
  await expectExplorerIdentity(page, testInfo);

  const skip = page.locator('button:has-text("Skip")').first();
  if (await skip.isVisible().catch(() => false)) await skip.click();

}

async function openPhylodynamics(page: Page) {
  // Click the toolbar button rather than pressing Ctrl+K.
  //
  // The global hotkey is attached by an effect, so immediately after a reload
  // there is a window in which the app looks ready and the shortcut does
  // nothing. The button is part of the rendered header: if it is visible, it
  // works. Hotkey coverage belongs to hotkeys-stack.e2e.ts, not here.
  const paletteButton = page.getByRole('button', { name: /command palette/i }).first();
  await paletteButton.waitFor({ timeout: 30000 });
  await paletteButton.click();

  const palette = page.locator('[data-testid="overlay-commandPalette"]');
  await palette.waitFor({ timeout: 30000 });

  const input = page.locator('[data-testid="command-palette-input"]');
  await input.waitFor({ timeout: 30000 });
  await input.fill('phylodynamics');

  // The list filters asynchronously, and on a loaded machine the first render
  // can lag the keystroke. 10 s was not enough on the third phase.
  const item = palette.locator('[role="option"]', { hasText: /Phylodynamics/i }).first();
  await expect(item).toBeVisible({ timeout: 30000 });
  await item.click();

  const overlay = page.locator('[data-testid="overlay-phylodynamics"]');
  await overlay.waitFor({ timeout: 20000 });

  // Wait for the POSITIVE settled condition, not for LOADING to disappear.
  //
  // `toBeHidden` succeeds when the element does not exist, so a check for
  // "LOADING is hidden" passes vacuously in the instant between the overlay
  // mounting and its loading state rendering. That is not hypothetical: it let
  // a phase read the overlay mid-fetch and assert against "LOADING: Searching
  // NCBI...". Waiting for the banner itself cannot pass early.
  await expect(overlay.getByText(/DATA UNAVAILABLE|REAL DATA/i).first()).toBeVisible({
    timeout: 120000,
  });
  return overlay;
}

/**
 * Build an NCBI route handler.
 *
 * `fastaCount` controls how many of the requested accessions actually come back
 * as FASTA, which is what separates a complete fetch from a partial one.
 */
function mockNcbi(
  accessions: string[],
  dates: string[],
  fastaCount: number,
  uidBase: number
) {
  return async (route: Route) => {
    const url = route.request().url();

    if (url.includes('esearch.fcgi')) {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          esearchresult: {
            count: String(accessions.length),
            idlist: accessions.map((_, i) => String(uidBase + i)),
          },
        }),
      });
    }

    if (url.includes('esummary.fcgi')) {
      const result: Record<string, unknown> = {
        uids: accessions.map((_, i) => String(uidBase + i)),
      };
      accessions.forEach((acc, i) => {
        result[String(uidBase + i)] = {
          uid: String(uidBase + i),
          // fetchSequenceSummaries reads `caption` for the accession. Supplying
          // only `accessionversion` makes it fall back to the numeric uid, which
          // never matches the FASTA headers and silently drops every sequence.
          caption: acc,
          accessionversion: `${acc}.1`,
          title: `Synthetic phage record ${acc}`,
          organism: 'Escherichia phage lambda',
          subtype: 'collection_date',
          subname: dates[i],
          createdate: dates[i].replace(/-/g, '/'),
          slen: '2900',
        };
      });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result }) });
    }

    if (url.includes('efetch.fcgi')) {
      const fasta = accessions
        .slice(0, fastaCount)
        .map((acc, i) => {
          const seq = 'ACGTTGCAAGGCTTACGCATTGCA'.repeat(120 + i * 7) + 'ACGT'.repeat(i + 1);
          return `>${acc} synthetic test record\n${seq.match(/.{1,70}/g)!.join('\n')}\n`;
        })
        .join('');
      return route.fulfill({ contentType: 'text/plain', body: fasta });
    }

    return route.abort();
  };
}

/**
 * Move to a different phage so the overlay re-runs its analysis.
 *
 * This replaced a `page.reload()` between phases. A reload re-initialised the
 * whole app -- three inits pushed the test past a five-minute budget and made
 * it unusable in CI, which runs at 180 s per test. Switching phage costs a
 * click: the overlay's effect keys on the phage, so it re-analyses, and the
 * API cache key includes the phage so no stale result can be served.
 */
async function switchPhage(page: Page, pattern: RegExp): Promise<void> {
  // Close the overlay so the list is reachable.
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="overlay-phylodynamics"]')).toBeHidden({
    timeout: 30000,
  });

  const item = page.locator('[data-testid="phage-list-item"]', { hasText: pattern }).first();
  await item.waitFor({ timeout: 30000 });
  await item.click();

  await expect(page.getByRole('heading', { level: 1 })).toContainText(pattern, {
    timeout: 30000,
  });
}

/**
 * One test, three phases.
 *
 * Each phase needs a different network, but they do NOT need a different
 * browser. Split across three tests, each got a fresh context and paid the full
 * cost of downloading and parsing the 3.8 MB database again -- about 170 s per
 * test, most of it identical setup. Reloading inside one context reads the
 * database back from IndexedDB instead, so the expensive boot happens once.
 *
 * The phases stay independent in what they assert: each reroutes the network
 * from scratch and clears the API cache, so no phase can pass on a result the
 * previous one produced.
 */
test('the provenance banner tracks the data that was actually used', async ({
  page,
}, testInfo) => {
  // Set the budget here rather than relying on the CLI flag.
  //
  // CI runs the suite with --timeout=180000, which is ample for the specs it
  // was tuned for. This one boots the app, loads a 10 MB database, and then
  // runs three network scenarios; the first boot alone can take two minutes on
  // a loaded machine. Declaring the requirement in the spec means it cannot be
  // silently starved by a flag set for other files.
  test.setTimeout(600_000);

  const { finalize } = setupTestHarness(page, testInfo);

  // ---------------------------------------------------------------------
  // Phase 1: every NCBI call fails. The common case in practice -- offline, a
  // rate-limited endpoint, or a phage with too few dated records.
  // ---------------------------------------------------------------------
  await page.route(NCBI_GLOB, route => route.abort());

  await bootstrap(page, testInfo);
  let overlay = await openPhylodynamics(page);
  let body = (await overlay.innerText()).replace(/\s+/g, ' ');

  expect(body, 'a failed fetch must not leave a REAL DATA claim up').not.toMatch(
    /\bREAL DATA\b/
  );
  expect(body).toMatch(/DATA UNAVAILABLE/);
  await expect(overlay.getByRole('img', { name: /UPGMA phylogenetic tree/ })).toHaveCount(0);
  await overlay.getByRole('button', { name: 'Show synthetic phylodynamics illustration' }).click();
  await expect(overlay).toContainText('15 synthetic 300-base sequences');
  await expect(overlay.getByRole('img', { name: /UPGMA phylogenetic tree/ })).toBeVisible();

  // ---------------------------------------------------------------------
  // Phase 2: six dated records with six FASTA bodies of DIFFERENT lengths,
  // which is the real shape of GenBank records for one phage and the shape the
  // old aligned-only path could not handle. If the alignment-free matrix were
  // ever unwired, the analysis would throw and land on the demo path, failing
  // this phase.
  //
  // Six, not five: a test sitting exactly on the minimum tells you nothing
  // about which side of it the code is on.
  // ---------------------------------------------------------------------
  const accessions = ['NC_TEST01', 'NC_TEST02', 'NC_TEST03', 'NC_TEST04', 'NC_TEST05', 'NC_TEST06'];
  const years = [2011, 2013, 2015, 2017, 2019, 2021];

  await page.unroute(NCBI_GLOB);
  await page.route(
    NCBI_GLOB,
    mockNcbi(accessions, years.map(y => `${y}-06-01`), accessions.length, 1000)
  );

  await switchPhage(page, /T4/i);
  overlay = await openPhylodynamics(page);
  body = (await overlay.innerText()).replace(/\s+/g, ' ');

  // This is what makes phase 1 meaningful. If the overlay could never reach the
  // real path in this harness, phase 1 would pass trivially and prove nothing.
  expect(body, 'real sequences must produce a REAL DATA banner').toMatch(/\bREAL DATA\b/);

  const full = body.match(/based on (\d+) dated sequences/i);
  expect(full).not.toBeNull();
  expect(Number(full![1])).toBe(accessions.length);

  // The year range must come from the subset that was analysed.
  expect(body).toContain(String(Math.min(...years)));
  expect(body).toContain(String(Math.max(...years)));

  // ---------------------------------------------------------------------
  // Phase 3: the search finds eight records, only six FASTA bodies come back.
  // Ordinary NCBI behaviour, and where the over-reporting bug lived: the banner
  // quoted the accession count rather than the number analysed.
  // ---------------------------------------------------------------------
  const found = 8;
  const returned = 6;
  const partial = Array.from({ length: found }, (_, i) => `NC_PART${String(i).padStart(2, '0')}`);

  await page.unroute(NCBI_GLOB);
  await page.route(
    NCBI_GLOB,
    mockNcbi(
      partial,
      partial.map((_, i) => `${2010 + i}-06-01`),
      returned,
      2000
    )
  );

  await switchPhage(page, /T7/i);
  overlay = await openPhylodynamics(page);
  body = (await overlay.innerText()).replace(/\s+/g, ' ');

  expect(body, 'six retrieved sequences retain the real analysis path').toMatch(/\bREAL DATA\b/);
  const m = body.match(/based on (\d+) dated sequences/i);
  expect(m).not.toBeNull();
  expect(Number(m![1])).toBe(returned);
  expect(Number(m![1])).not.toBe(found);
  expect(body).toContain('Equal-length raw genomes are insufficient');

  await finalize();
});

import { test, expect, type Page } from '@playwright/test';
import { setupTestHarness } from './e2e-harness';

/**
 * The banner must describe the data that was actually used.
 *
 * The phylodynamics overlay printed a green "REAL DATA" banner over a tree
 * built from hashes of accession strings. Deleting the hash was necessary and
 * not sufficient: the overlay still falls back to a synthetic path whenever
 * NCBI returns too little to analyse, and nothing verified that the banner
 * followed the fallback.
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

async function bootstrap(page: Page): Promise<void> {
  // Seed BEFORE the first navigation rather than setting storage and reloading.
  // The reload cost a second full boot of the app, including a 10 MB SQLite
  // load, and doubled every test's runtime for no added coverage.
  await page.addInitScript(() => {
    localStorage.setItem(
      'phage-explorer-main-prefs',
      JSON.stringify({ experienceLevel: 'power' })
    );
    // A cached result from an earlier run of this same build would be a hit and
    // would short-circuit the path under test.
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('phage_api_cache_')) localStorage.removeItem(k);
    }
  });

  await page.goto('http://localhost:5173');
  await page.waitForSelector('#root > div', { timeout: 60000 });

  const skip = page.locator('button:has-text("Skip")').first();
  if (await skip.isVisible().catch(() => false)) await skip.click();

  // Wait for a phage to be loaded before opening anything. The overlay's effect
  // depends on currentPhage, and racing the database load is what made this
  // hang rather than fail.
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/phage/i, {
    timeout: 60000,
  });
}

async function openPhylodynamics(page: Page) {
  await page.keyboard.press('Control+k');
  const palette = page.locator('[data-testid="overlay-commandPalette"]');
  await palette.waitFor({ timeout: 15000 });
  await page.locator('[data-testid="command-palette-input"]').fill('phylodynamics');
  const item = palette.locator('[role="option"]', { hasText: /Phylodynamics/i }).first();
  await expect(item).toBeVisible({ timeout: 10000 });
  await item.click();

  const overlay = page.locator('[data-testid="overlay-phylodynamics"]');
  await overlay.waitFor({ timeout: 20000 });

  // Settle before asserting. A stuck loading state and a wrong banner look the
  // same to a text assertion, and they are different failures.
  await expect(overlay.getByText(/LOADING/i).first()).toBeHidden({ timeout: 90000 });
  return overlay;
}

test('a failed NCBI fetch never leaves a REAL DATA banner up', async ({ page }, testInfo) => {
  const { finalize } = setupTestHarness(page, testInfo);

  // Every NCBI call fails. This is the common case in practice: offline, a
  // rate-limited endpoint, or a phage with too few dated records.
  await page.route(NCBI_GLOB, route => route.abort());

  await bootstrap(page);
  const overlay = await openPhylodynamics(page);

  // Wait for the analysis to settle on one path or the other.
  await expect(overlay.getByText(/demonstration data|REAL DATA/i).first()).toBeVisible({
    timeout: 45000,
  });

  const body = (await overlay.innerText()).replace(/\s+/g, ' ');

  // The claim under test. With no network there is no real data, so the banner
  // must not assert any.
  expect(body).not.toMatch(/\bREAL DATA\b/);
  expect(body).toMatch(/demonstration data/i);

  await finalize();
});

test('the banner asserts REAL DATA only when real sequences were analysed', async ({
  page,
}, testInfo) => {
  const { finalize } = setupTestHarness(page, testInfo);

  // Six dated records with six real FASTA bodies. Six, because the overlay
  // requires at least five and a test sitting exactly on a boundary tells you
  // nothing about which side of it the code is on.
  const accessions = ['NC_TEST01', 'NC_TEST02', 'NC_TEST03', 'NC_TEST04', 'NC_TEST05', 'NC_TEST06'];
  const years = [2011, 2013, 2015, 2017, 2019, 2021];

  // Distinct sequences of DIFFERENT lengths, which is the real shape of GenBank
  // records for one phage and the shape the old aligned-only path could not
  // handle. If the alignment-free matrix were ever unwired, this fetch would
  // throw and the overlay would land on the demo path, failing the test.
  const fastaFor = (acc: string, i: number) => {
    const unit = 'ACGTTGCAAGGCTTACGCATTGCA';
    const body = unit.repeat(120 + i * 7) + 'ACGT'.repeat(i + 1);
    return `>${acc} synthetic test record\n${body.match(/.{1,70}/g)!.join('\n')}\n`;
  };

  await page.route(NCBI_GLOB, async route => {
    const url = route.request().url();

    if (url.includes('esearch.fcgi')) {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          esearchresult: { count: String(accessions.length), idlist: accessions.map((_, i) => String(1000 + i)) },
        }),
      });
    }

    if (url.includes('esummary.fcgi')) {
      const result: Record<string, unknown> = { uids: accessions.map((_, i) => String(1000 + i)) };
      accessions.forEach((acc, i) => {
        result[String(1000 + i)] = {
          uid: String(1000 + i),
          // fetchSequenceSummaries reads `caption` for the accession. Supplying
          // only `accessionversion` makes it fall back to the numeric uid, which
          // then never matches the FASTA headers and silently drops every
          // sequence -- exactly the partial-fetch path, reached by accident.
          caption: acc,
          accessionversion: `${acc}.1`,
          title: `Synthetic phage record ${acc}`,
          organism: 'Escherichia phage lambda',
          subtype: 'collection_date',
          subname: `${years[i]}-06-01`,
          createdate: `${years[i]}/06/01`,
          slen: '2900',
        };
      });
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ result }),
      });
    }

    if (url.includes('efetch.fcgi')) {
      return route.fulfill({
        contentType: 'text/plain',
        body: accessions.map((acc, i) => fastaFor(acc, i)).join(''),
      });
    }

    return route.abort();
  });

  await bootstrap(page);
  const overlay = await openPhylodynamics(page);

  await expect(overlay.getByText(/demonstration data|REAL DATA/i).first()).toBeVisible({
    timeout: 45000,
  });

  const body = (await overlay.innerText()).replace(/\s+/g, ' ');

  // This is the assertion that makes the negative case above meaningful. If the
  // overlay could never reach the real path in this harness, the first test
  // would pass trivially and prove nothing.
  expect(body).toMatch(/\bREAL DATA\b/);

  // The count in the banner must be the number of sequences ANALYSED, not the
  // number of accessions found. Those differ whenever a FASTA fetch returns
  // fewer records than the search did, and the banner used to quote the larger.
  const match = body.match(/based on (\d+) dated sequences/i);
  expect(match).not.toBeNull();
  expect(Number(match![1])).toBe(accessions.length);

  // The year range must come from the same subset that was analysed.
  expect(body).toContain(String(Math.min(...years)));
  expect(body).toContain(String(Math.max(...years)));

  await finalize();
});

test('a partial FASTA fetch reports the analysed count, not the found count', async ({
  page,
}, testInfo) => {
  const { finalize } = setupTestHarness(page, testInfo);

  // The search finds eight records; only six FASTA bodies come back. This is
  // ordinary NCBI behaviour and it is where the over-reporting bug lived.
  const found = 8;
  const returned = 6;
  const accessions = Array.from({ length: found }, (_, i) => `NC_PART${String(i).padStart(2, '0')}`);

  await page.route(NCBI_GLOB, async route => {
    const url = route.request().url();

    if (url.includes('esearch.fcgi')) {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          esearchresult: { count: String(found), idlist: accessions.map((_, i) => String(2000 + i)) },
        }),
      });
    }

    if (url.includes('esummary.fcgi')) {
      const result: Record<string, unknown> = { uids: accessions.map((_, i) => String(2000 + i)) };
      accessions.forEach((acc, i) => {
        result[String(2000 + i)] = {
          uid: String(2000 + i),
          caption: acc,
          accessionversion: `${acc}.1`,
          title: `Synthetic phage record ${acc}`,
          organism: 'Escherichia phage lambda',
          subtype: 'collection_date',
          subname: `${2010 + i}-06-01`,
          createdate: `${2010 + i}/06/01`,
          slen: '2900',
        };
      });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result }) });
    }

    if (url.includes('efetch.fcgi')) {
      // Only the first `returned` records come back.
      const body = accessions
        .slice(0, returned)
        .map((acc, i) => {
          const seq = 'ACGTTGCAAGGCTTACGCATTGCA'.repeat(120 + i * 5);
          return `>${acc} partial set\n${seq.match(/.{1,70}/g)!.join('\n')}\n`;
        })
        .join('');
      return route.fulfill({ contentType: 'text/plain', body });
    }

    return route.abort();
  });

  await bootstrap(page);
  const overlay = await openPhylodynamics(page);

  await expect(overlay.getByText(/demonstration data|REAL DATA/i).first()).toBeVisible({
    timeout: 45000,
  });

  const body = (await overlay.innerText()).replace(/\s+/g, ' ');

  if (/\bREAL DATA\b/.test(body)) {
    const match = body.match(/based on (\d+) dated sequences/i);
    expect(match).not.toBeNull();
    // The whole point: 6, not 8.
    expect(Number(match![1])).toBe(returned);
    expect(Number(match![1])).not.toBe(found);
  } else {
    // Falling back is also acceptable here; what is not acceptable is claiming
    // real data for eight sequences when six were analysed.
    expect(body).toMatch(/demonstration data/i);
  }

  await finalize();
});

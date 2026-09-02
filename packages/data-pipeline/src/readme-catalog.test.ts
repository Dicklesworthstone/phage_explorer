import { describe, expect, it } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { PHAGE_CATALOG } from './phage-catalog';

/**
 * The README's "Included Phages" table is a hand-maintained list of 24 genome
 * lengths, and it had drifted: PhiC31 was listed at 41,491 bp against 41,489 in
 * the shipped database, and Qbeta at 4,217 against 4,215. Two bases each, which
 * is exactly the kind of error nobody notices by eye and everybody quotes.
 *
 * The README is the project's front door and de facto specification, so a
 * number in it should be as testable as a number in the code. This checks the
 * table against the catalogue the pipeline actually fetches, and against the
 * shipped database when one is present.
 */

const REPO_ROOT = join(import.meta.dir, '../../..');
const README = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');

/** Rows of the README table: | **Name** | 48,502 bp | ... */
function parseReadmeGenomeLengths(): Map<string, number> {
  const rows = new Map<string, number>();
  const re = /\|\s*\*\*([^*]+)\*\*\s*\|\s*([\d,]+)\s*bp\s*\|/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(README)) !== null) {
    rows.set(m[1].trim(), Number(m[2].replace(/,/g, '')));
  }
  return rows;
}

/**
 * README display names to catalogue slugs. Kept explicit rather than fuzzy-
 * matched: a slug guess that silently fails to match would make this test pass
 * by skipping the row it was meant to check.
 */
const README_NAME_TO_SLUG: Record<string, string> = {
  'Lambda (λ)': 'lambda',
  T4: 't4',
  T7: 't7',
  PhiX174: 'phix174',
  MS2: 'ms2',
  M13: 'm13',
  P22: 'p22',
  Phi29: 'phi29',
  Mu: 'mu',
  Phi6: 'phi6',
  SPbeta: 'spbeta',
  T5: 't5',
  P1: 'p1',
  P2: 'p2',
  N4: 'n4',
  'Felix O1': 'felixo1',
  D29: 'd29',
  L5: 'l5',
  PhiC31: 'phic31',
  PhiKZ: 'phikz',
  PRD1: 'prd1',
  PM2: 'pm2',
  'Qβ': 'qbeta',
  T1: 't1',
};

describe('README phage table', () => {
  const readmeRows = parseReadmeGenomeLengths();

  it('parses all 24 rows, so the checks below cannot pass vacuously', () => {
    expect(readmeRows.size).toBe(24);
  });

  it('maps every README row to a catalogue slug', () => {
    const unmapped = [...readmeRows.keys()].filter(n => !README_NAME_TO_SLUG[n]);
    expect(unmapped).toEqual([]);
  });

  it('lists exactly the phages the pipeline fetches', () => {
    const catalogSlugs = new Set(PHAGE_CATALOG.map(p => p.slug));
    const readmeSlugs = [...readmeRows.keys()].map(n => README_NAME_TO_SLUG[n]);
    const missingFromReadme = [...catalogSlugs].filter(s => !readmeSlugs.includes(s)).sort();
    const notInCatalog = readmeSlugs.filter(s => !catalogSlugs.has(s)).sort();
    expect(missingFromReadme).toEqual([]);
    expect(notInCatalog).toEqual([]);
  });
});

/**
 * The database is a build artifact, so this block is skipped when it is absent
 * (a fresh clone before `bun run build:db`). It is the stronger check when
 * present, because it compares against what the app actually serves.
 */
const DB_PATH = join(REPO_ROOT, 'packages/web/public/phage.db');
const dbDescribe = existsSync(DB_PATH) ? describe : describe.skip;

dbDescribe('README genome lengths match the shipped database', () => {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.query('SELECT slug, genome_length FROM phages').all() as {
    slug: string;
    genome_length: number;
  }[];
  const bySlug = new Map(rows.map(r => [r.slug, r.genome_length]));
  const readmeRows = parseReadmeGenomeLengths();

  it('has a database row for every README entry', () => {
    const missing = [...readmeRows.keys()]
      .map(n => README_NAME_TO_SLUG[n])
      .filter(slug => !bySlug.has(slug));
    expect(missing).toEqual([]);
  });

  it('quotes the same length as the database for every phage', () => {
    const mismatches: string[] = [];
    for (const [name, readmeLength] of readmeRows) {
      const slug = README_NAME_TO_SLUG[name];
      const dbLength = bySlug.get(slug);
      if (dbLength !== readmeLength) {
        mismatches.push(`${name}: README ${readmeLength} vs database ${dbLength}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('the comparison is discriminating', () => {
    // Guards the guard: prove a wrong number would be caught, so the empty
    // mismatch list above means something.
    const slug = README_NAME_TO_SLUG['PhiC31'];
    const actual = bySlug.get(slug);
    expect(actual).toBeDefined();
    expect(actual).not.toBe(41491); // the value the README used to carry
    expect(actual).toBe(41489);
  });
});

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

/**
 * Annotation provenance must come from the data, not from a hardcoded string.
 *
 * The protein-domain overlay credited "InterProScan". The rows in
 * `protein_domains` were produced by `generate-pfam-domains.py`, which
 * downloads Pfam-A from EBI and scans with `pyhmmer.hmmer.hmmscan`. InterProScan
 * was never involved. This matters more than a typical attribution slip: domain
 * calls are the kind of result a user cites, and Pfam-A gathering thresholds and
 * InterPro's integrated signatures are different things.
 */
const provenanceDescribe = existsSync(DB_PATH) ? describe : describe.skip;

provenanceDescribe('protein domain provenance', () => {
  const db = new Database(DB_PATH, { readonly: true });

  it('records the tool and the database that actually produced the rows', () => {
    const row = db
      .query<{ value: string }, []>(
        "select value from annotation_meta where key = 'pfam_domains'"
      )
      .get();
    expect(row).not.toBeNull();
    const meta = JSON.parse(row!.value) as Record<string, unknown>;
    expect(meta.tool).toBe('pyhmmer.hmmer.hmmscan');
    expect(meta.database).toBe('Pfam-A');
  });

  it('records a real Pfam release rather than the string "current"', () => {
    // "current" is a moving target: it is not the same release in August as in
    // January, and domain calls depend on the release's gathering thresholds.
    const row = db
      .query<{ value: string }, []>(
        "select value from annotation_meta where key = 'pfam_domains'"
      )
      .get();
    const meta = JSON.parse(row!.value) as Record<string, unknown>;
    expect(meta.release).not.toBe('current');
    expect(meta.release).not.toBe('unknown');
    expect(String(meta.release)).toMatch(/^\d+(\.\d+)?$/);
  });

  it('the overlay credits Pfam and PyHMMER, not InterProScan', () => {
    const src = readFileSync(
      join(
        import.meta.dir,
        '../../web/src/components/overlays/ProteinDomainOverlay.tsx'
      ),
      'utf8'
    );
    // Strip comments, including the JSX ones that record what was removed and
    // why. Those must be allowed to name the old attribution.
    const code = src
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(l => !l.trimStart().startsWith('//'))
      .join('\n');
    expect(code).not.toContain('InterProScan');
    expect(code).toContain('Pfam-A');
    expect(code).toContain('PyHMMER');
  });

  it('reads the release from the database rather than hardcoding it', () => {
    // The discrimination check. Printing a literal "38.2" would satisfy the
    // test above and go stale the next time the pipeline runs.
    const src = readFileSync(
      join(
        import.meta.dir,
        '../../web/src/components/overlays/ProteinDomainOverlay.tsx'
      ),
      'utf8'
    );
    expect(src).toContain("getAnnotationMeta?.('pfam_domains')");
  });

  it('every stored domain row is a Pfam hit with an E-value', () => {
    const bad = db
      .query<{ n: number }, []>(
        "select count(*) as n from protein_domains where domain_type != 'Pfam' or e_value is null"
      )
      .get();
    expect(bad!.n).toBe(0);
  });
});

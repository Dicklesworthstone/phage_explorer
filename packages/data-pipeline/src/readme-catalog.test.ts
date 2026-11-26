import { describe, expect, it } from 'bun:test';
import { readFileSync, existsSync, statSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Database } from 'bun:sqlite';
import { PHAGE_CATALOG } from './phage-catalog';
import { computeDatabaseContentDigest } from '../../../scripts/build-web-db';
import { artifactToolchain, declaredBindgen, readProducers } from '../../../scripts/verify-wasm-toolchain';

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

/**
 * The release must actually ship the database.
 *
 * `.github/workflows/release.yml` uploads `dist/*`, and no step ever put
 * `phage.db` there. Its own header comment claimed the release includes the
 * database. A release cut from that workflow would publish binaries and no data,
 * and `install.sh --with-database` would 404 on both `phage.db.gz` and
 * `phage.db` and merely warn -- leaving the user a TUI with nothing in it.
 *
 * The v1.4.1 release does carry a 3.1 MB phage.db, from before the workflow
 * looked like this; the current database is 10.4 MB and holds Pfam domains,
 * ESM2 embeddings and codon adaptation that did not exist then.
 *
 * These are source-level assertions on the workflow because that is where the
 * defect lives; no unit test of the app can observe a missing release asset.
 */
describe('the release workflow ships the database', () => {
  const workflow = readFileSync(
    join(import.meta.dir, '../../../.github/workflows/release.yml'),
    'utf8'
  );

  it('reads the workflow', () => {
    expect(workflow).toContain('softprops/action-gh-release');
  });

  it('generates raw, compressed and manifest release assets from the committed database', () => {
    expect(workflow).toContain('packages/web/public/phage.db');
    // The gzip is ignored, so requiring it in a fresh checkout breaks releases.
    // The builder-to-browser E2E test separately executes this producer.
    expect(workflow).toContain('bun scripts/build-web-db.ts --source "$db" --output dist');
    expect(workflow).toContain('dist/phage.db dist/phage.db.gz dist/phage.db.manifest.json');
    expect(workflow).not.toContain('cp "$db" "$gz" dist/');
  });

  it('refuses to publish without a database rather than degrading quietly', () => {
    expect(workflow).toContain('refusing to publish a release without it');
  });

  it('refuses to publish a stale database', () => {
    // Guards specifically against re-shipping the 3.1 MB December file.
    expect(workflow).toContain('Refusing to publish a stale one');
    expect(workflow).toMatch(/-lt 5000000/);
  });

  it('includes the database in sha256.txt', () => {
    // A truncated SQLite download fails confusingly rather than obviously, so
    // this is the asset most worth checksumming.
    expect(workflow).toMatch(/phage-explorer-\* phage\.db phage\.db\.gz/);
    expect(workflow).toContain('phage.db.gz phage.db.manifest.json; do');
    expect(workflow).toContain('phage.db missing from sha256.txt');
  });
});

describe('the shipped database is the current one', () => {
  const dbPath = join(import.meta.dir, '../../web/public/phage.db');
  it('generates both installer forms with matching bytes and logical content from a fresh output directory', () => {
    expect(existsSync(dbPath)).toBe(true);
    // Gzip is a generated, ignored asset. Exercise the actual release producer
    // instead of relying on a previous local build to populate public/.
    const output = mkdtempSync(join(tmpdir(), 'phage-release-db-'));
    const sourceBytes = readFileSync(dbPath);
    const build = Bun.spawnSync({
      cmd: [process.execPath, join(REPO_ROOT, 'scripts/build-web-db.ts'), '--source', dbPath, '--output', output],
      stdout: 'pipe', stderr: 'pipe',
    });
    if (build.exitCode !== 0) {
      throw new Error(`Database build failed (${build.exitCode}):\n${build.stdout.toString()}\n${build.stderr.toString()}`);
    }
    const raw = readFileSync(join(output, 'phage.db'));
    const compressed = readFileSync(join(output, 'phage.db.gz'));
    const manifest = JSON.parse(readFileSync(join(output, 'phage.db.manifest.json'), 'utf8'));
    expect(gunzipSync(compressed)).toEqual(raw);
    expect(manifest.version).toBe(2);
    expect(manifest.size).toBe(raw.length);
    expect(manifest.sha256).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(readFileSync(dbPath)).toEqual(sourceBytes);
    const source = new Database(dbPath, { readonly: true });
    const shipped = new Database(join(output, 'phage.db'), { readonly: true });
    try {
      expect(manifest.contentVersion).toBe(computeDatabaseContentDigest(source));
      expect(computeDatabaseContentDigest(shipped)).toBe(manifest.contentVersion);
      expect(shipped.query('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
    } finally {
      source.close();
      shipped.close();
    }
  });

  it('is far larger than the 3.1 MB database v1.4.1 shipped', () => {
    // The size check in the workflow uses 5 MB as its floor; assert the real
    // file clears it with room, so the guard is not sitting on the boundary.
    expect(statSync(dbPath).size).toBeGreaterThan(8_000_000);
  });

  it('carries the annotations the README describes', () => {
    // The concrete reason the December database is not good enough.
    const db = new Database(dbPath, { readonly: true });
    const count = (table: string) =>
      db.query<{ n: number }, []>(`select count(*) as n from ${table}`).get()!.n;
    expect(count('protein_domains')).toBeGreaterThan(1000);
    expect(count('fold_embeddings')).toBeGreaterThan(1000);
    expect(count('codon_adaptation')).toBeGreaterThan(1000);
  });
});

/**
 * `bun run wasm:verify` used to search the raw bytes for `rustc/<hash>` and
 * `wasm-bindgen-<version>` source-path spellings and compared bindgen with an
 * untracked Cargo.lock. The committed artifacts contain no `wasm-bindgen-x.y.z`
 * path at all, so the check could not pass on a fresh checkout. It now decodes
 * the standard producers section and compares with the exact pin in Cargo.toml.
 */
describe('the WASM toolchain verifier', () => {
  const crate = join(REPO_ROOT, 'packages/wasm-compute');
  const leb = (value: number): number[] => {
    const out: number[] = [];
    do {
      let byte = value % 128;
      value = Math.floor(value / 128);
      if (value > 0) byte |= 0x80;
      out.push(byte);
    } while (value > 0);
    return out;
  };
  const text = (value: string | number[]): number[] => {
    const bytes = typeof value === 'string' ? [...new TextEncoder().encode(value)] : value;
    return [...leb(bytes.length), ...bytes];
  };
  const custom = (name: string, body: number[]): number[] => {
    const payload = [...text(name), ...body];
    return [0, ...leb(payload.length), ...payload];
  };
  type Fields = [string | number[], [string | number[], string][]][];
  const producers = (fields: Fields): number[] => [
    ...leb(fields.length),
    ...fields.flatMap(([field, tools]) => [
      ...text(field), ...leb(tools.length), ...tools.flatMap(([tool, version]) => [...text(tool), ...text(version)]),
    ]),
  ];
  const wasm = (...sections: number[][]) => new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...sections.flat()]);
  const RUSTC = '1.98.0 (88d9e12ae 2026-08-18)';
  const standard = (bindgen = '0.2.128 (246946fdd)'): Fields => [
    ['language', [['Rust', '']]],
    ['processed-by', [['rustc', RUSTC], ['wasm-bindgen', bindgen], ['walrus', '0.26.5']]],
  ];
  // Text a source-path search would mistake for producer records.
  const decoy = custom('.debug_str', [...new TextEncoder().encode(
    '/rustc/88d9e12ae178fab0fb5cc050a94da85685d449ea/library wasm-bindgen-0.2.999/src/lib.rs')]);

  it('reads both committed variants from their producers sections, matching the Cargo.toml pin', () => {
    const pinned = declaredBindgen(readFileSync(join(crate, 'Cargo.toml'), 'utf8'));
    const variants = ['pkg', 'pkg-simd'].map(variant =>
      artifactToolchain(readFileSync(join(crate, variant, 'wasm_compute_bg.wasm'))));
    for (const variant of variants) {
      expect(variant.bindgenVersion).toBe(pinned);
      expect(variant.rustcVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(variant.rustcCommit).toMatch(/^[0-9a-f]{7,40}$/);
    }
    expect(variants[1]).toEqual(variants[0]);
    // The spelling the old check searched for is absent from the shipped bytes.
    for (const variant of ['pkg', 'pkg-simd']) {
      expect(readFileSync(join(crate, variant, 'wasm_compute_bg.wasm')).toString('latin1'))
        .not.toMatch(/wasm-bindgen-\d+\.\d+\.\d+/);
    }
  });

  it('uses the producers record, not tool names that appear elsewhere in the binary', () => {
    expect(artifactToolchain(wasm(decoy, custom('producers', producers(standard('0.2.127 (a579ee62b)'))))))
      .toEqual({ rustcVersion: '1.98.0', rustcCommit: '88d9e12ae', bindgenVersion: '0.2.127' });
    // A renamed section is not a producers record, whatever strings remain.
    const renamed = wasm(decoy, custom('producerz', producers(standard())));
    expect(readProducers(renamed)).toBeNull();
    expect(() => artifactToolchain(renamed)).toThrow('no producers section');
  });

  it('requires both rustc and wasm-bindgen in processed-by', () => {
    const missing = (tools: [string, string][]) =>
      () => artifactToolchain(wasm(custom('producers', producers([['processed-by', tools]]))));
    expect(missing([['rustc', RUSTC]])).toThrow('no wasm-bindgen');
    expect(missing([['wasm-bindgen', '0.2.128 (246946fdd)']])).toThrow('no rustc');
    // A tool recorded under another field did not process the module.
    expect(() => artifactToolchain(wasm(custom('producers', producers([
      ['sdk', [['wasm-bindgen', '0.2.128']]], ['processed-by', [['rustc', RUSTC]]]]))))).toThrow('no wasm-bindgen');
  });

  it('rejects malformed modules and producers sections', () => {
    const body = producers(standard());
    const valid = wasm(custom('producers', body));
    expect(readProducers(valid)?.get('processed-by')?.get('wasm-bindgen')).toBe('0.2.128 (246946fdd)');
    const rejects = (bytes: Uint8Array, message: string) => expect(() => readProducers(bytes)).toThrow(message);
    rejects(valid.subarray(0, valid.length - 3), 'runs past the end of the module');
    rejects(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 2, 0, 0, 0]), 'unsupported binary version');
    rejects(wasm(custom('producers', body), custom('producers', body)), 'more than one producers section');
    rejects(wasm(custom('producers', [...body, 0])), 'trailing bytes');
    rejects(wasm(custom('producers', producers([['processed-by', []], ['processed-by', []]]))), 'appears twice');
    rejects(wasm(custom('producers', producers([['processed-by', [['rustc', RUSTC], ['rustc', RUSTC]]]]))),
      'lists "rustc" twice');
    rejects(wasm(custom('producers', producers([['compiled-by', []]]))), 'unknown producers field');
    rejects(wasm(custom('producers', producers([['processed-by', [[[0xff, 0xfe], '1']]]]))), 'not valid UTF-8');
    // Section size and field count beyond u32.
    rejects(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0x7f]), 'exceeds u32');
    rejects(wasm(custom('producers', [0x80, 0x80, 0x80, 0x80, 0x10])), 'exceeds u32');
    // A field count larger than the section holds.
    rejects(wasm(custom('producers', [5, ...body.slice(1)])), 'truncated');
  });

  it('requires an exact wasm-bindgen pin in Cargo.toml', () => {
    expect(declaredBindgen('[dependencies]\nwasm-bindgen = "=0.2.128"\n')).toBe('0.2.128');
    expect(declaredBindgen('[dependencies]\nwasm-bindgen = { version = "=0.2.128", default-features = false }\n'))
      .toBe('0.2.128');
    expect(() => declaredBindgen('[dependencies]\nwasm-bindgen = "0.2"\n')).toThrow('pin the version');
    expect(() => declaredBindgen('[dependencies]\nwasm-bindgen = "^0.2.128"\n')).toThrow('pin the version');
    // A dev-dependency or a similarly named crate is not the build's bindgen.
    expect(() => declaredBindgen('[dev-dependencies]\nwasm-bindgen = "=0.2.128"\n')).toThrow('no wasm-bindgen');
    expect(() => declaredBindgen('[dependencies]\nwasm-bindgen-futures = "=0.4.1"\n')).toThrow('no wasm-bindgen');
  });
});

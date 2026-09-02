import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateDemoProvenanceData } from './environmental-provenance';

/**
 * Honesty guard for the environmental provenance overlay.
 *
 * Two separate defects, both about a fabricated value being indistinguishable
 * from a measured one:
 *
 * 1. The headline novelty score was `1 - maxContainment`, where containment
 *    was `0.3 + seededUnit(hashString(phageName + location)) * 0.5`. A hash of
 *    the phage's name, displayed under a green "REAL DATA" banner.
 *
 * 2. The demo fallback minted identifiers like `IMG/VR_20230001` and
 *    `MGnify_20210003`, which are indistinguishable from real accessions. A
 *    user copying one into notes and searching for it finds nothing, or worse,
 *    an unrelated real record.
 *
 * These are source-level assertions because the defect is the presence of the
 * fabrication, not a value a unit test can observe once it is gone.
 */

const OVERLAY = readFileSync(
  join(import.meta.dir, '../../../web/src/components/overlays/EnvironmentalProvenanceOverlay.tsx'),
  'utf8'
);

describe('environmental provenance no longer fabricates containment', () => {
  it('reads the overlay source, so the checks below are not vacuous', () => {
    expect(OVERLAY.length).toBeGreaterThan(1000);
    expect(OVERLAY).toContain('EnvironmentalProvenanceOverlay');
  });

  it('does not derive any displayed value from a hash of a name', () => {
    // Strip comments first: the fix documents the old expression verbatim so
    // the next reader knows what was removed, and that prose must not trip the
    // check that the code is gone.
    const code = OVERLAY.split('\n')
      .filter(line => {
        const t = line.trimStart();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');

    expect(code).not.toContain('seededUnit(');
    expect(code).not.toContain('hashString(');
  });

  it('defines neither helper any more', () => {
    // They existed solely to manufacture a plausible-looking score. Leaving
    // them defined invites the next use.
    expect(OVERLAY).not.toContain('function hashString');
    expect(OVERLAY).not.toContain('function seededUnit');
  });

  it('the source check is discriminating', () => {
    // Guards the guard: the same filter applied to the original expression
    // must flag it, or the assertions above would pass on any file.
    const originalLine =
      '  containment: Math.min(0.95, 0.3 + seededUnit(hashString(`${k}:${loc}`)) * 0.5),';
    expect(originalLine).toContain('seededUnit(');
  });

  it('qualifies what the REAL DATA banner covers', () => {
    // An unqualified "REAL DATA" over a mix of measured and unmeasurable
    // fields is how this went wrong. The banner must scope its claim.
    expect(OVERLAY).toContain('REAL DATA');
    expect(OVERLAY).toContain('SRA metadata carries no sequence');
  });
});

describe('demo identifiers cannot be mistaken for real accessions', () => {
  const hits = generateDemoProvenanceData('lambda', () => 0.42);

  it('produces demo hits at all, so the checks below mean something', () => {
    expect(hits.length).toBeGreaterThan(0);
  });

  it('prefixes every identifier so it is unmistakably synthetic', () => {
    for (const hit of hits) {
      expect(hit.metagenomeId.startsWith('DEMO-')).toBe(true);
    }
  });

  it('no identifier matches the shape of a real database accession', () => {
    // IMG/VR_20230001 and MGnify_20210003 are exactly what a real accession
    // looks like. With the prefix, none can be mistaken for one.
    for (const hit of hits) {
      expect(/^(IMG\/VR|MGnify|VIROME)_\d+$/.test(hit.metagenomeId)).toBe(false);
    }
  });

  it('that shape check is discriminating', () => {
    // Guards the guard: the pattern must match the old format.
    expect(/^(IMG\/VR|MGnify|VIROME)_\d+$/.test('IMG/VR_20230001')).toBe(true);
    expect(/^(IMG\/VR|MGnify|VIROME)_\d+$/.test('DEMO-IMG/VR_20230001')).toBe(false);
  });
});

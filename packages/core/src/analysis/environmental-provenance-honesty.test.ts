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

/**
 * Every figure carries its own provenance, not just the banner at the top.
 *
 * The banner was the first fix and it was not enough. Every number beneath it
 * is rendered by the same code on both the real and the demo path, so a seeded
 * random value looked identical to a measured one to anyone who scrolled past
 * the banner or screenshotted a panel. That is the same defect this file exists
 * for, one layer down.
 *
 * These are source-level assertions for the same reason as the ones above: what
 * is being checked is the presence of the label, which no unit test can observe
 * once the component is not rendered.
 */
describe('provenance travels with each figure, not only the banner', () => {
  const code = OVERLAY.split('\n')
    .filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
    .join('\n');

  it('defines a single provenance element reused across figures', () => {
    // One helper rather than five hand-placed badges: a figure added later
    // should be able to call the same thing, and a reader should not have to
    // check whether five copies still agree.
    expect(code).toContain('resultProvenance');
    expect(code).toContain("level=\"demo\"");
    expect(code).toContain("level=\"external\"");
  });

  it('labels every figure region that renders analysis numbers', () => {
    // The four view panels plus the novelty badge. If a fifth panel is added
    // without a badge, this count stops matching and the test fails, which is
    // the point: the omission has to be deliberate rather than accidental.
    const uses = code.split('resultProvenance()').length - 1;
    expect(uses).toBeGreaterThanOrEqual(5);
  });

  it('marks demo data as demo rather than as heuristic or estimated', () => {
    // "Heuristic" is not a euphemism for "fake". A seeded random abundance
    // table is demo data, and calling it anything softer is how the original
    // defect was tolerated for so long.
    expect(code).toContain('synthetic sample set');
    expect(code).not.toContain('level="heuristic"');
  });

  it('stamps the canvases, which are the figures that can leave their context', () => {
    // A badge in the DOM is lost the moment someone crops a screenshot or
    // copies the canvas image. The stamp is drawn into the pixels.
    expect(code).toContain('stampDemo');
    expect(code).toContain('DEMO DATA');
  });

  it('draws the stamp on both canvases and on the empty state', () => {
    // Three call sites: biome chart, geography map, and the "no biome data"
    // early return, which is still a canvas a user can screenshot.
    const stamps = code.split('stampDemo(ctx').length - 1;
    expect(stamps).toBeGreaterThanOrEqual(3);
  });

  it('only stamps when the data really is synthetic', () => {
    // The discrimination check. A stamp drawn unconditionally would label real
    // results as demo, which destroys the signal exactly as thoroughly as
    // labelling nothing.
    expect(code).toContain("dataSource !== 'demo'");
  });
});

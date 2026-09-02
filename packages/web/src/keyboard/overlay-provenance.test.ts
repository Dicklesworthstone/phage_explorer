import { describe, expect, it } from 'bun:test';
import { ActionRegistryList } from './actionRegistry';
import { PROVENANCE_LEVELS } from '../components/overlays/primitives/OverlayProvenance';

/**
 * Provenance enforcement.
 *
 * An audit of all 46 analysis overlays found 10 that display fabricated or
 * hash-derived numbers with exactly the same visual authority as the 36 real
 * ones -- same menu, same category, same chrome. Two carried a green
 * "REAL DATA" banner over inputs that were a hash of the phage name.
 *
 * Fixing those ten individually leaves the eleventh free to ship unlabelled.
 * This test is the part that makes the class structurally impossible: every
 * overlay in the registry must declare where its numbers come from, so a new
 * overlay cannot reach the Analysis Menu without someone answering the
 * question.
 *
 * If you are here because this test failed on an overlay you just added: the
 * fix is to declare `provenance` on its registry entry, not to add it to the
 * chrome list. The chrome list is for surfaces that display no analysis
 * results at all.
 */

/**
 * Overlays that present no analysis results: navigation, reference tables,
 * settings, menus, and a dev-only benchmark. These make no claim about data,
 * so they have nothing to declare.
 */
const CHROME_OVERLAYS = new Set([
  'help',
  'search',
  'goto',
  'settings',
  'commandPalette',
  'analysisMenu',
  'simulationHub',
  'aaKey',
  'aaLegend',
  'gpuWasmBenchmark',
]);

const overlayActions = ActionRegistryList.filter(a => a.overlayId);

describe('overlay provenance is declared', () => {
  it('finds a meaningful number of overlays, so the checks are not vacuous', () => {
    expect(overlayActions.length).toBeGreaterThan(40);
  });

  it('every analysis overlay declares where its data comes from', () => {
    const undeclared = overlayActions
      .filter(a => !CHROME_OVERLAYS.has(a.overlayId!))
      .filter(a => !a.provenance)
      .map(a => a.overlayId!)
      .sort();
    expect(undeclared).toEqual([]);
  });

  it('every declared level is one the badge can render', () => {
    const invalid = overlayActions
      .filter(a => a.provenance && !PROVENANCE_LEVELS.includes(a.provenance))
      .map(a => `${a.overlayId}: ${a.provenance}`);
    expect(invalid).toEqual([]);
  });

  it('chrome surfaces do not claim a provenance they cannot have', () => {
    const overclaiming = overlayActions
      .filter(a => CHROME_OVERLAYS.has(a.overlayId!) && a.provenance)
      .map(a => a.overlayId!);
    expect(overclaiming).toEqual([]);
  });

  it('the check is discriminating', () => {
    // Guards the guard: if `provenance` were silently dropped from the type or
    // the registry, "no undeclared overlays" would pass over an empty set.
    const declared = overlayActions.filter(a => a.provenance);
    expect(declared.length).toBeGreaterThan(30);
  });
});

describe('the overlays the audit found fabricating data are labelled as such', () => {
  const levelOf = (id: string) =>
    overlayActions.find(a => a.overlayId === id)?.provenance;

  it('marks the remaining synthetic-input overlays as demo data', () => {
    // crispr scans a placeholder 6-mer spacer set; nicheNetwork analyses a
    // randomly generated abundance table and never receives the loaded phage.
    expect(levelOf('crispr')).toBe('demo');
    expect(levelOf('nicheNetwork')).toBe('demo');
  });

  it('promotes the two overlays whose fabrications were removed', () => {
    // phylodynamics built its tree from hashes of accession strings and now
    // fetches real sequences from NCBI; environmentalProvenance derived its
    // headline score from a hash of the phage name and now measures
    // catalogue distinctiveness with MinHash. Both are 'external' because
    // their primary data comes from a third-party service.
    //
    // This assertion is the reason the levels cannot quietly drift back: a
    // change that reintroduced synthesis without relabelling would leave the
    // registry claiming external data for a hash.
    expect(levelOf('phylodynamics')).toBe('external');
    expect(levelOf('environmentalProvenance')).toBe('external');
  });

  it('does not let a rule-based estimate pass as a measurement', () => {
    // Real inputs, but keyword and formula estimates rather than measurements.
    for (const id of ['defenseArmsRace', 'amgPathway', 'tropism', 'stability', 'pressure']) {
      expect(levelOf(id)).toBe('heuristic');
    }
  });

  it('marks genuinely computed overlays as measured', () => {
    for (const id of ['gcSkew', 'dotPlot', 'proteinDomains', 'codonBias', 'comparison']) {
      expect(levelOf(id)).toBe('measured');
    }
  });
});

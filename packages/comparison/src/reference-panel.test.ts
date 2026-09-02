import { describe, expect, it } from 'bun:test';
import {
  buildReferencePanel,
  referenceLabel,
  type ReferencePanelPhage,
  type ReferencePanelSource,
} from './reference-panel';
import { analyzeHGTProvenance } from './hgt-tracer';

/**
 * The web HGT overlay passed `{}` as its reference library, so
 * `analyzeHGTProvenance` had nothing to compare islands against and the
 * "Putative Donors" section could never render. These tests cover the panel
 * builder and, more importantly, assert end to end that a populated panel
 * actually yields donor attributions where an empty one yields none.
 */

/** Deterministic sequence with a controllable composition. */
function makeSequence(length: number, bases: string, seed: number): string {
  let state = seed >>> 0;
  const out: string[] = [];
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out.push(bases[state % bases.length]);
  }
  return out.join('');
}

function makeSource(sequences: Map<number, string>): ReferencePanelSource {
  return {
    async getFullGenomeLength(id) {
      const seq = sequences.get(id);
      if (!seq) throw new Error(`no such phage ${id}`);
      return seq.length;
    },
    async getSequenceWindow(id, start, end) {
      const seq = sequences.get(id);
      if (!seq) throw new Error(`no such phage ${id}`);
      return seq.slice(start, end);
    },
  };
}

/**
 * Deterministic sequence over all four bases with a target GC fraction.
 *
 * Realistic composition matters here. A degenerate two-letter sequence
 * (pure AT) collapses k-mer diversity and makes Jaccard similarity behave
 * pathologically -- an artifact of the test construct, not of the analyzer.
 */
function biasedSequence(length: number, gcFraction: number, seed: number): string {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
  const out: string[] = [];
  for (let i = 0; i < length; i++) {
    const r = next();
    if (r < gcFraction / 2) out.push('G');
    else if (r < gcFraction) out.push('C');
    else if (r < gcFraction + (1 - gcFraction) / 2) out.push('A');
    else out.push('T');
  }
  return out.join('');
}

/**
 * A query genome carrying a real 2.5 kb chunk OF the donor genome, spliced into
 * a compositionally different backbone. The island and the donor therefore share
 * actual k-mers, which is exactly the signal donor inference exists to find.
 */
const DONOR_GENOME = biasedSequence(20000, 0.28, 7);
const HOST_BACKBONE = biasedSequence(30000, 0.62, 5);
const TRANSFERRED_ISLAND = DONOR_GENOME.slice(3000, 5500);
const QUERY_GENOME =
  HOST_BACKBONE.slice(0, 12000) + TRANSFERRED_ISLAND + HOST_BACKBONE.slice(12000);

const PHAGES: ReferencePanelPhage[] = [
  { id: 1, name: 'Enterobacteria phage lambda', host: 'Escherichia coli K-12' },
  { id: 2, name: 'Enterobacteria phage T4', host: 'Escherichia coli B' },
  { id: 3, name: 'Salmonella phage P22', host: 'Salmonella enterica' },
];

describe('referenceLabel', () => {
  it('includes name, host and id so donors are unambiguous', () => {
    expect(referenceLabel(PHAGES[0])).toBe('Enterobacteria phage lambda (Escherichia coli K-12) #1');
  });

  it('degrades gracefully when metadata is missing', () => {
    expect(referenceLabel({ id: 9 })).toBe('phage-9 (unknown host) #9');
    expect(referenceLabel({ id: 9, name: null, host: null })).toBe('phage-9 (unknown host) #9');
  });
});

describe('buildReferencePanel', () => {
  const sequences = new Map<number, string>([
    [1, makeSequence(5000, 'ACGT', 11)],
    [2, makeSequence(5000, 'ACGT', 22)],
    [3, makeSequence(5000, 'ACGT', 33)],
  ]);
  const source = makeSource(sequences);

  it('builds a panel from the catalogue', async () => {
    const panel = await buildReferencePanel(source, PHAGES, null);
    expect(Object.keys(panel)).toHaveLength(3);
    expect(panel[referenceLabel(PHAGES[0])]).toHaveLength(5000);
  });

  it('excludes the phage under analysis so it is never its own donor', async () => {
    const panel = await buildReferencePanel(source, PHAGES, 2);
    const labels = Object.keys(panel);
    expect(labels).toHaveLength(2);
    expect(labels.some(l => l.endsWith('#2'))).toBe(false);
  });

  it('caps the bases taken from each reference', async () => {
    const panel = await buildReferencePanel(source, PHAGES, null, {
      maxBasesPerReference: 100,
    });
    for (const seq of Object.values(panel)) {
      expect(seq).toHaveLength(100);
    }
  });

  it('caps how many references are loaded', async () => {
    const panel = await buildReferencePanel(source, PHAGES, null, { maxReferences: 2 });
    expect(Object.keys(panel)).toHaveLength(2);
  });

  it('skips a reference that cannot be read instead of failing the panel', async () => {
    const withMissing = [...PHAGES, { id: 99, name: 'Broken', host: 'nowhere' }];
    const panel = await buildReferencePanel(source, withMissing, null);
    // The three readable references survive; the unreadable one is dropped.
    expect(Object.keys(panel)).toHaveLength(3);
  });

  it('stops early when aborted', async () => {
    const signal = { aborted: true };
    const panel = await buildReferencePanel(source, PHAGES, null, { signal });
    expect(Object.keys(panel)).toHaveLength(0);
  });

  it('returns an empty panel when the catalogue has only the current phage', async () => {
    const panel = await buildReferencePanel(source, [PHAGES[0]], 1);
    expect(panel).toEqual({});
  });
});

describe('donor inference depends on a populated panel', () => {
  const donorPhage: ReferencePanelPhage = { id: 42, name: 'Donor phage', host: 'donor host' };
  const sequences = new Map<number, string>([[42, DONOR_GENOME]]);
  const source = makeSource(sequences);

  it('names no donor when the panel is empty', () => {
    const analysis = analyzeHGTProvenance(QUERY_GENOME, [], {}, { window: 1000, step: 500 });
    // Islands are still detected from composition alone...
    expect(analysis.stamps.length).toBeGreaterThan(0);
    // ...but with nothing to compare against, no donor is ever named. This is
    // exactly what the web overlay showed before it was given a panel.
    for (const stamp of analysis.stamps) {
      expect(stamp.donorDistribution).toHaveLength(0);
      expect(stamp.donor).toBeNull();
    }
  });

  it('names the correct donor once the catalogue panel is supplied', async () => {
    const panel = await buildReferencePanel(source, [donorPhage], null);
    expect(Object.keys(panel)).toHaveLength(1);

    const analysis = analyzeHGTProvenance(QUERY_GENOME, [], panel, {
      window: 1000,
      step: 500,
    });
    expect(analysis.stamps.length).toBeGreaterThan(0);

    const attributed = analysis.stamps.filter(s => s.donorDistribution.length > 0);
    expect(attributed.length).toBeGreaterThan(0);
    expect(attributed[0].donor).not.toBeNull();
    expect(attributed[0].donorDistribution[0].taxon).toContain('Donor phage');
  });

  it('locates the island where the transfer actually was', async () => {
    const panel = await buildReferencePanel(source, [donorPhage], null);
    const analysis = analyzeHGTProvenance(QUERY_GENOME, [], panel, {
      window: 1000,
      step: 500,
    });
    const island = analysis.stamps[0].island;
    // The island was spliced in at 12,000 and is 2,500 bp long.
    expect(island.start).toBeLessThanOrEqual(12000);
    expect(island.end).toBeGreaterThanOrEqual(14500);
  });
});

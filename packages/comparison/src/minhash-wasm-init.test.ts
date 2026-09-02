import { describe, expect, it } from 'bun:test';
import {
  initMinHashWasm,
  isMinHashWasmAvailable,
  analyzeHGTProvenance,
} from './hgt-tracer';

/**
 * The WASM MinHash path was wired but unreachable.
 *
 * `initMinHashWasm` existed and worked, but its only caller was a module-load
 * invocation that was removed to stop it firing in environments that could not
 * service it. Nothing replaced that call, so `wasmMinHashAvailable` stayed
 * false forever and every MinHash consumer silently used the exact k=15
 * Set-Jaccard fallback -- including HGT donor inference, which is the workload
 * the Rust kernel was written for.
 *
 * These tests assert the path can actually be brought up, and that turning it
 * on does not change the answers.
 */

/**
 * Deterministic sequence over all four bases with a target GC fraction.
 * Realistic composition matters: a degenerate two-letter sequence collapses
 * k-mer diversity and makes Jaccard behave pathologically, which is an
 * artifact of the construct rather than of the analyzer.
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

// A real 2.5 kb chunk of the donor genome spliced into a different backbone,
// so the island and the donor genuinely share k-mers.
const DONOR_GENOME = biasedSequence(20000, 0.28, 7);
const HOST_BACKBONE = biasedSequence(30000, 0.62, 5);
const QUERY =
  HOST_BACKBONE.slice(0, 12000) + DONOR_GENOME.slice(3000, 5500) + HOST_BACKBONE.slice(12000);

const PANEL: Record<string, string> = {
  'Donor phage (donor host) #42': DONOR_GENOME,
  'Unrelated phage (other host) #43': biasedSequence(20000, 0.62, 99),
};

describe('MinHash WASM initialization', () => {
  it('starts unavailable, because nothing initializes it at module load', () => {
    // This is the state every consumer saw in production. If a future change
    // reintroduces module-load init, this assertion is the tripwire -- and the
    // fix is to decide deliberately, not to delete the test.
    expect(isMinHashWasmAvailable()).toBe(false);
  });

  it('becomes available after an explicit init', async () => {
    await initMinHashWasm();
    // initMinHashWasm self-verifies: it only reports available after checking
    // that a known signature round-trips to a Jaccard of exactly 1.0.
    expect(isMinHashWasmAvailable()).toBe(true);
  });

  it('is idempotent', async () => {
    await initMinHashWasm();
    await initMinHashWasm();
    expect(isMinHashWasmAvailable()).toBe(true);
  });
});

describe('donor inference agrees across the WASM and JS paths', () => {
  it('names the same top donor with WASM active as the JS path did', async () => {
    // Captured before init, i.e. via the exact Set-Jaccard fallback.
    const jsAnalysis = analyzeHGTProvenance(QUERY, [], PANEL, { window: 1000, step: 500 });
    const jsAttributed = jsAnalysis.stamps.filter(s => s.donorDistribution.length > 0);
    expect(jsAttributed.length).toBeGreaterThan(0);
    const jsTopDonor = jsAttributed[0].donorDistribution[0].taxon;

    await initMinHashWasm();
    expect(isMinHashWasmAvailable()).toBe(true);

    const wasmAnalysis = analyzeHGTProvenance(QUERY, [], PANEL, { window: 1000, step: 500 });
    const wasmAttributed = wasmAnalysis.stamps.filter(s => s.donorDistribution.length > 0);
    expect(wasmAttributed.length).toBeGreaterThan(0);
    const wasmTopDonor = wasmAttributed[0].donorDistribution[0].taxon;

    // Same island count and the same donor called. MinHash is an estimator, so
    // similarity scores may differ slightly; the attribution must not.
    expect(wasmAnalysis.stamps.length).toBe(jsAnalysis.stamps.length);
    expect(wasmTopDonor).toBe(jsTopDonor);
    expect(wasmTopDonor).toContain('Donor phage');
  });

  it('prefers the compositionally matching reference over the unrelated one', async () => {
    await initMinHashWasm();
    const analysis = analyzeHGTProvenance(QUERY, [], PANEL, { window: 1000, step: 500 });
    const attributed = analysis.stamps.filter(s => s.donorDistribution.length > 0);
    expect(attributed.length).toBeGreaterThan(0);

    // Guards the guard: with two references in the panel, picking the right one
    // is a real discrimination, not an artifact of there being only one option.
    const top = attributed[0].donorDistribution[0];
    expect(top.taxon).toContain('Donor phage');
    expect(top.taxon).not.toContain('Unrelated');
  });
});

#!/usr/bin/env bun
/**
 * WASM vs JS benchmark for every kernel that has both implementations.
 *
 * ## Why this exists
 *
 * Four documents state speedups and none was backed by a measurement:
 * README (~5-20x, ~2-10x, ~5-20x), CHANGELOG ("5-20x faster"), and in-code
 * comments that disagree with each other -- edit-distance.ts says 5-20x,
 * kmer-analysis.ts says 3-10x in one place and 3-5x in another, anomaly.ts says
 * ~100x and ~10x, lib.rs says ~4x.
 *
 * The e2e performance suite cannot fill the gap: it is gated behind
 * PLAYWRIGHT_PERF=1, measures wall-clock overlay time against fixed thresholds
 * rather than comparing implementations, and its analysis-timing tests contain
 * no assertions at all. It never runs in CI.
 *
 * ## What it does
 *
 * For each kernel with both a WASM and a JS implementation, across a size sweep
 * covering the real catalogue range (MS2 at 3.5 kb to phiKZ at 280 kb):
 *
 *   - runs both on the same input,
 *   - checks the outputs agree, and says so when they do not,
 *   - reports median and p95 for each, and the ratio,
 *   - writes a machine-readable JSON that can be committed and diffed.
 *
 * ## What the numbers mean, and do not
 *
 * These are measured on ONE machine under Bun, not in a browser. They are
 * comparable across commits on the same runner, which is what a regression
 * check needs. They are not a promise about any particular user's hardware, and
 * the report says so rather than implying otherwise.
 *
 * Median and p95 rather than mean: a mean over a JIT-warming run is dominated by
 * the first iteration, which is exactly the number that flatters WASM.
 *
 * Usage:
 *   bun scripts/benchmark-wasm.ts                  human-readable table
 *   bun scripts/benchmark-wasm.ts --json <path>    also write the result file
 *   bun scripts/benchmark-wasm.ts --quick          smaller sweep, for a smoke run
 */

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import {
  calculateGCContent,
  countCodonUsage,
  translateSequence,
  reverseComplement,
  countKmersDenseJS,
} from '../packages/core/src/index';
import {
  levenshteinDistance,
  minHashJaccard,
  analyzeKmers,
} from '../packages/comparison/src/index';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    json: { type: 'string', default: '' },
    quick: { type: 'boolean', default: false },
    check: { type: 'string', default: '' },
  },
});

const wasm = await import('@phage/wasm-compute');
const init = (wasm as unknown as { default?: () => Promise<unknown> }).default;
if (typeof init === 'function') await init();

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Deterministic sequence with realistic, skewed base composition. */
function sequence(length: number, gcFraction: number, seed: number): string {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
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
 * Sizes spanning the shipped catalogue: MS2 is 3.5 kb, lambda 48 kb, T4 169 kb,
 * phiKZ 280 kb. Benchmarking outside that range would measure something the app
 * never does.
 */
const SIZES = values.quick ? [1_000, 25_000] : [1_000, 5_000, 25_000, 100_000, 300_000];

/** Levenshtein is O(n*m); above this it dominates the whole run for no signal. */
const QUADRATIC_MAX = 5_000;

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

interface Timing {
  medianMs: number;
  p95Ms: number;
  runs: number;
}

/**
 * Time a function, discarding warm-up.
 *
 * Bun's JIT needs a few passes before it settles; including those makes the
 * first implementation measured look slower purely for running first.
 */
function time(fn: () => unknown, reps: number): Timing {
  for (let i = 0; i < Math.min(3, reps); i++) fn();

  const samples: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return {
    medianMs: samples[Math.floor(samples.length / 2)],
    p95Ms: samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))],
    runs: reps,
  };
}

/** Fewer repetitions for larger inputs, so the sweep finishes in reasonable time. */
function repsFor(size: number): number {
  if (size <= 5_000) return 25;
  if (size <= 25_000) return 15;
  if (size <= 100_000) return 7;
  return 5;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

interface Case {
  kernel: string;
  /** Skip sizes above this, for quadratic algorithms. */
  maxSize?: number;
  run(size: number): {
    wasm: () => unknown;
    js: () => unknown;
    /** Compare one pair of outputs. Undefined when the two are known to differ. */
    agree?: (a: unknown, b: unknown) => boolean;
    /** Why the outputs are not compared, when they are not. */
    incomparable?: string;
  };
}

const CASES: Case[] = [
  {
    kernel: 'calculate_gc_content',
    run(size) {
      const seq = sequence(size, 0.48, 7);
      return {
        wasm: () => wasm.calculate_gc_content(seq),
        js: () => calculateGCContent(seq),
        agree: (a, b) => Math.abs((a as number) - (b as number)) < 1e-9,
      };
    },
  },
  {
    kernel: 'reverse_complement',
    run(size) {
      const seq = sequence(size, 0.48, 11);
      return {
        wasm: () => wasm.reverse_complement(seq),
        js: () => reverseComplement(seq),
        agree: (a, b) => a === b,
      };
    },
  },
  {
    kernel: 'translate_sequence',
    run(size) {
      const seq = sequence(size, 0.48, 13);
      return {
        wasm: () => wasm.translate_sequence(seq, 0),
        js: () => translateSequence(seq),
        agree: (a, b) => a === b,
      };
    },
  },
  {
    kernel: 'count_codon_usage',
    run(size) {
      const seq = sequence(size, 0.48, 17);
      return {
        wasm: () => JSON.parse(wasm.count_codon_usage(seq, 0).json),
        js: () => countCodonUsage(seq, 0),
        agree: (a, b) => {
          const x = a as Record<string, number>;
          const y = b as Record<string, number>;
          const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
          for (const key of keys) if ((x[key] ?? 0) !== (y[key] ?? 0)) return false;
          return true;
        },
      };
    },
  },
  {
    kernel: 'count_kmers_dense (k=6)',
    run(size) {
      const bytes = encode(sequence(size, 0.48, 19));
      return {
        wasm: () => Array.from(wasm.count_kmers_dense(bytes, 6).counts),
        js: () => Array.from(countKmersDenseJS(bytes, 6).counts),
        agree: (a, b) => {
          const x = a as number[];
          const y = b as number[];
          if (x.length !== y.length) return false;
          for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
          return true;
        },
      };
    },
  },
  {
    kernel: 'levenshtein_distance',
    maxSize: QUADRATIC_MAX,
    run(size) {
      const a = sequence(size, 0.48, 23);
      const b = sequence(size, 0.52, 29);
      return {
        wasm: () => wasm.levenshtein_distance(a, b),
        js: () => levenshteinDistance(a, b).distance,
        agree: (x, y) => x === y,
      };
    },
  },
  {
    kernel: 'min_hash_jaccard (k=12)',
    run(size) {
      const a = sequence(size, 0.48, 31);
      const b = sequence(size, 0.52, 37);
      return {
        wasm: () => wasm.min_hash_jaccard(a, b, 12, 128),
        js: () => minHashJaccard(a, b, 12, 128),
        incomparable:
          'the two do not share a hash family, so they sample different k-mers ' +
          '(phage_explorer-i1cm)',
      };
    },
  },
  {
    kernel: 'analyze_kmers (k=6)',
    run(size) {
      const a = sequence(size, 0.48, 41);
      const b = sequence(size, 0.52, 43);
      return {
        wasm: () => wasm.analyze_kmers(a, b, 6).jaccard_index,
        js: () => analyzeKmers(a, b, 6).jaccardIndex,
        // Compared again since phage_explorer-wbil: the kernel used to count
        // plain k-mers where the JS counted canonical ones.
        agree: (x, y) => Math.abs((x as number) - (y as number)) < 1e-12,
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

interface Row {
  kernel: string;
  sizeBp: number;
  wasmMedianMs: number;
  wasmP95Ms: number;
  jsMedianMs: number;
  jsP95Ms: number;
  /** jsMedian / wasmMedian. Above 1 means WASM is faster. */
  speedup: number;
  outputsAgree: boolean | null;
  note?: string;
}

const rows: Row[] = [];

for (const c of CASES) {
  for (const size of SIZES) {
    if (c.maxSize !== undefined && size > c.maxSize) continue;

    const { wasm: w, js, agree, incomparable } = c.run(size);
    const reps = repsFor(size);

    let outputsAgree: boolean | null = null;
    if (agree) outputsAgree = agree(w(), js());

    const wt = time(w, reps);
    const jt = time(js, reps);

    rows.push({
      kernel: c.kernel,
      sizeBp: size,
      wasmMedianMs: Number(wt.medianMs.toFixed(4)),
      wasmP95Ms: Number(wt.p95Ms.toFixed(4)),
      jsMedianMs: Number(jt.medianMs.toFixed(4)),
      jsP95Ms: Number(jt.p95Ms.toFixed(4)),
      speedup: Number((jt.medianMs / Math.max(wt.medianMs, 1e-9)).toFixed(2)),
      outputsAgree,
      note: incomparable,
    });
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log('');
console.log('WASM vs JS, median of repeated runs after warm-up. Higher speedup = WASM faster.');
console.log(`Bun ${Bun.version} on ${process.platform}/${process.arch}. One machine; ratios travel, absolute times do not.`);
console.log('');
console.log('kernel                      size      wasm ms    js ms   speedup  outputs');
console.log('--------------------------- -------- --------- --------- -------- --------');

for (const r of rows) {
  const agree =
    r.outputsAgree === null ? 'differ*' : r.outputsAgree ? 'identical' : 'DIFFER!';
  console.log(
    `${r.kernel.padEnd(27)} ${String(r.sizeBp).padStart(8)} ` +
      `${r.wasmMedianMs.toFixed(3).padStart(9)} ${r.jsMedianMs.toFixed(3).padStart(9)} ` +
      `${(`${r.speedup}x`).padStart(8)} ${agree}`
  );
}

const notes = [...new Set(rows.filter(r => r.note).map(r => `  * ${r.kernel}: ${r.note}`))];
if (notes.length > 0) {
  console.log('');
  console.log('Outputs not compared:');
  for (const n of notes) console.log(n);
}

// A kernel that is slower in WASM at every size is worth knowing about: the
// bead that prompted this says so explicitly, and removing a WASM path that
// buys nothing is a legitimate outcome.
const byKernel = new Map<string, Row[]>();
for (const r of rows) {
  if (!byKernel.has(r.kernel)) byKernel.set(r.kernel, []);
  byKernel.get(r.kernel)!.push(r);
}
const neverFaster = [...byKernel.entries()]
  .filter(([, rs]) => rs.every(r => r.speedup < 1))
  .map(([k]) => k);
if (neverFaster.length > 0) {
  console.log('');
  console.log('Slower in WASM at every size measured:');
  for (const k of neverFaster) console.log(`  ${k}`);
}

const mismatched = rows.filter(r => r.outputsAgree === false);
if (mismatched.length > 0) {
  console.error('');
  console.error('Outputs disagreed where they were expected to match:');
  for (const r of mismatched) console.error(`  ${r.kernel} at ${r.sizeBp} bp`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Regression check
// ---------------------------------------------------------------------------

if (values.check) {
  /**
   * Compare against a committed result file.
   *
   * Absolute times on a shared runner vary by more than any threshold worth
   * setting, so this does NOT gate on them. It gates on one thing: a kernel that
   * was clearly faster in WASM becoming SLOWER than JavaScript. That is not a
   * performance wobble, it is the signature of the WASM path no longer being
   * taken, which is the defect worth catching.
   *
   * An earlier draft failed when a kernel dropped below 40% of its recorded
   * speedup. That fired immediately on a loaded machine -- MinHash read 20.9x in
   * a quiet run and 1.8x while builds were running -- without anything being
   * wrong. A benchmark gate that fires on load gets disabled, and a disabled
   * gate is worth nothing, so the bar is now unambiguous: below parity.
   */
  const baseline = JSON.parse(await Bun.file(values.check).text()) as { rows: Row[] };
  const key = (r: { kernel: string; sizeBp: number }) => `${r.kernel}@${r.sizeBp}`;
  const before = new Map(baseline.rows.map(r => [key(r), r]));

  const regressions: string[] = [];
  for (const r of rows) {
    const b = before.get(key(r));
    if (!b) continue;
    // Only meaningful where WASM was clearly ahead to begin with.
    if (b.speedup < 2) continue;
    // And only at sizes where the measurement is above the noise floor. At 1 kb
    // both implementations finish in tens of microseconds, so a scheduler
    // hiccup swamps the ratio: translate_sequence read 5.6x in a quiet run and
    // 0.98x under load, with nothing wrong. 25 kb is the first size where both
    // sides take long enough for the ratio to mean something.
    if (r.sizeBp < 25_000) continue;
    if (r.speedup < 1) {
      regressions.push(
        `  ${r.kernel} at ${r.sizeBp} bp: was ${b.speedup}x, now ${r.speedup}x ` +
          '(WASM is now slower than JS)'
      );
    }
  }

  if (regressions.length > 0) {
    console.error('');
    console.error('WASM advantage collapsed for:');
    for (const line of regressions) console.error(line);
    console.error('');
    console.error('This usually means the kernel fell back to JavaScript rather than');
    console.error('that it got slower. Check that the WASM module still initialises.');
    process.exit(1);
  }
  console.log('');
  console.log(`No kernel lost its WASM advantage against ${values.check}.`);
}

if (values.json) {
  const payload = {
    generatedAt: new Date().toISOString(),
    runtime: `bun ${Bun.version}`,
    platform: `${process.platform}/${process.arch}`,
    // Recorded so a later diff can tell a real regression from a different box.
    note:
      'Ratios are comparable across commits on the same runner. Absolute times are ' +
      'machine-specific and are not a claim about any user\'s hardware.',
    rows,
  };
  writeFileSync(values.json, `${JSON.stringify(payload, null, 2)}\n`);
  console.log('');
  console.log(`Wrote ${values.json}`);
}

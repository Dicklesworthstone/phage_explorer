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
 * ## How reproducible is it, actually
 *
 * Not very, and the honest answer is worth more than a confident one. Two full
 * runs back to back still disagreed:
 *
 *   mean disagreement in speedup across 37 rows   3.5x
 *   worst row (reverse_complement at 300 kb)      334x in one run, 8.9x in the next
 *   rows agreeing within 1.5x                     29 of 37
 *
 * Those two runs were taken on a shared machine carrying a load average of ~53
 * from unrelated jobs, which is stated because it changes what they prove and
 * what they do not. They are an upper bound on the disagreement, not a typical
 * one -- a quiet runner will do better. They are still the relevant number for
 * a CI gate, because a CI runner is a shared machine too, and a gate that only
 * behaves on an idle box is a gate that fires at random.
 *
 * That is AFTER interleaving, which is itself a large improvement -- the
 * previous sequential version once produced 146x and 0.46x for the same kernel,
 * a 317x swing. So interleaving took the worst case from 317x to 38x and did not
 * take it to 1x.
 *
 * The response is not to pretend otherwise. Every row carries an instability
 * flag derived from its own interquartile spread, the report marks flagged rows
 * with `~`, and the regression gate refuses to fail a build on one. Of the 8
 * rows that disagreed between those two runs, the flag caught 7.
 *
 * Practical rule: an unflagged ratio is worth quoting as an order of magnitude,
 * a flagged one is worth nothing until it is reproduced on a quiet machine, and
 * no ratio from this script belongs in a document as a precise figure. That is
 * exactly why the README carries bands rather than numbers.
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
  /** Interquartile spread as a fraction of the median. See `driftWarning`. */
  instability: number;
}

function summarize(samples: number[], reps: number): Timing {
  const s = [...samples].sort((a, b) => a - b);
  const median = s[Math.floor(s.length / 2)]!;
  const p25 = s[Math.floor(s.length * 0.25)]!;
  const p75 = s[Math.floor(s.length * 0.75)]!;
  return {
    medianMs: median,
    p95Ms: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!,
    runs: reps,
    instability: median > 0 ? (p75 - p25) / median : 0,
  };
}

/**
 * Time two implementations against each other, INTERLEAVED.
 *
 * ## Why not time them one after the other
 *
 * The original version ran `time(wasm)` to completion and then `time(js)`, and
 * divided the two medians. That makes the ratio a hostage to anything that
 * changes between the two blocks -- another process waking up, a thermal step,
 * the GC choosing one block over the other. On a loaded machine the effect is
 * not subtle: timing the same 300 kb kernel twice in a row, sequentially,
 * produced medians of 0.95 ms and 3.43 ms. A ratio taken across two such blocks can be
 * off by more than the effect it is trying to measure, and this project has the
 * scar to prove it -- `analyze_kmers` was once reported at 146x and then at
 * 0.46x on reruns of this script, a 317x swing in a published number, which is
 * what forced the README's speedup table down to hedged order-of-magnitude
 * bands.
 *
 * Interleaving one call of each arm per round means a slow patch of wall-clock
 * lands on both arms rather than being attributed to whichever ran during it.
 * The ratio of the medians is then a comparison, not a coincidence.
 *
 * ## Warm-up
 *
 * Both arms are warmed before any sample is taken, and warm-up is interleaved
 * too. Bun's JIT needs a few passes to settle, and warming only the first arm
 * would hand it the cost of compilation.
 *
 * ## The alternating order
 *
 * Round order flips each iteration, so neither arm permanently occupies the
 * position right after the other one's allocations.
 */
function timePaired(
  a: () => unknown,
  b: () => unknown,
  maxReps: number
): { a: Timing; b: Timing } {
  const warm = Math.min(3, maxReps);
  const warmStart = performance.now();
  for (let i = 0; i < warm; i++) {
    a();
    b();
  }
  const perRoundMs = (performance.now() - warmStart) / Math.max(warm, 1);

  // Adaptive repetition count.
  //
  // A fixed count spends the same number of rounds on a kernel pair that takes
  // 0.3 ms and one that takes 40 seconds. The JS MinHash reference is the
  // second kind -- it works in BigInt, and at 300 kb a single call is ~40 s --
  // so nine rounds of it alone accounted for most of a thirteen-minute run,
  // while the cheap kernels that would actually benefit from more samples were
  // capped at nine. This is a CI gate; a thirteen-minute gate gets skipped.
  //
  // So: sample as many rounds as fit a per-pair budget, never fewer than
  // MIN_REPS (below which a median means nothing) and never more than the
  // size-based cap. Rounds stay odd so the median is a real observation.
  const budgeted = Math.floor(PAIR_BUDGET_MS / Math.max(perRoundMs, 1e-6));
  // When a single round already exceeds the whole budget, the floor drops to 3.
  // That is the JS MinHash at 100 kb and above, where one call is 16-50 s: five
  // rounds of it cost four minutes to refine a ratio that is around 350x, where
  // the third significant figure changes no decision anyone makes.
  const floor = perRoundMs > PAIR_BUDGET_MS ? 3 : MIN_REPS;
  let reps = Math.max(floor, Math.min(maxReps, budgeted));
  if (reps % 2 === 0) reps -= 1;

  const sa: number[] = [];
  const sb: number[] = [];
  for (let i = 0; i < reps; i++) {
    const order: Array<[() => unknown, number[]]> =
      i % 2 === 0
        ? [[a, sa], [b, sb]]
        : [[b, sb], [a, sa]];
    for (const [fn, into] of order) {
      const t0 = performance.now();
      fn();
      into.push(performance.now() - t0);
    }
  }

  return { a: summarize(sa, reps), b: summarize(sb, reps) };
}

/**
 * Flag a row whose timings moved too much for its ratio to be worth reading.
 *
 * Interleaving removes the bias between arms; it cannot make a noisy machine
 * quiet. An interquartile spread wider than half the median means the samples
 * disagree with each other badly enough that the median is not describing a
 * stable quantity, and the honest thing is to say so next to the number rather
 * than print it with two decimal places and let a reader trust it.
 *
 * ## How well it works, measured
 *
 * Two full runs back to back on this machine, 37 rows each, comparing each
 * row's speedup between the runs:
 *
 *   disagree by >1.5x AND flagged   7   the flag did its job
 *   disagree by >1.5x NOT flagged   1   missed: translate_sequence@300000, 2.2x
 *   agree            AND flagged   13   false alarm
 *   agree            NOT flagged   16   correctly trusted
 *
 * So an unflagged row is usually reproducible and a flagged one usually is not,
 * which is what the CI gate needs. It is deliberately conservative -- 13 false
 * alarms -- because the cost of a false alarm is a skipped gate row and the cost
 * of a miss is a build failed on noise.
 *
 * The threshold is NOT tuned to catch that last 2.2x miss. Tightening it would
 * push more of the 29 reproducible rows into the flagged bucket and leave the
 * gate checking almost nothing, which is a worse tool that scores better on this
 * one table.
 */
const UNSTABLE_IQR_FRACTION = 0.5;
function driftWarning(w: Timing, j: Timing): boolean {
  return w.instability > UNSTABLE_IQR_FRACTION || j.instability > UNSTABLE_IQR_FRACTION;
}

/** Fewer repetitions for larger inputs, so the sweep finishes in reasonable time. */
/**
 * Wall-clock allowed per kernel/size pair before repetitions are cut short.
 *
 * 2 s x 37 pairs is a worst case around 75 s, plus warm-up. In practice most
 * pairs finish far inside it and only the BigInt MinHash reference is clipped.
 */
const PAIR_BUDGET_MS = 2_000;

/** Below this a median describes nothing, so the budget does not apply. */
const MIN_REPS = 5;

/** Upper bound on repetitions; `timePaired` samples fewer if the budget binds. */
function repsFor(size: number): number {
  // Odd counts, so the median is an actual sample rather than a value that was
  // never observed. Higher at the large sizes than the original 7 and 5:
  // interleaving fixes the bias between the two arms, but a median of five is
  // still a fragile statistic and the large sizes are the ones whose ratios get
  // quoted. The budget above is what stops the raised cap from costing time on
  // the pairs where each round is already expensive.
  if (size <= 5_000) return 25;
  if (size <= 25_000) return 15;
  if (size <= 100_000) return 11;
  return 9;
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
  /**
   * Repetitions actually taken. Varies per row now that the budget can cut a
   * slow pair short, so recording it keeps the JSON self-describing rather than
   * leaving a reader to assume the cap was reached.
   */
  runs: number;
  /**
   * True when either arm's samples were too scattered for the ratio to mean
   * much. Kept in the JSON so a regression gate can decline to fail a build on
   * a number the run itself does not stand behind.
   */
  unstable: boolean;
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

    const { a: wt, b: jt } = timePaired(w, js, reps);

    rows.push({
      kernel: c.kernel,
      sizeBp: size,
      wasmMedianMs: Number(wt.medianMs.toFixed(4)),
      wasmP95Ms: Number(wt.p95Ms.toFixed(4)),
      jsMedianMs: Number(jt.medianMs.toFixed(4)),
      jsP95Ms: Number(jt.p95Ms.toFixed(4)),
      speedup: Number((jt.medianMs / Math.max(wt.medianMs, 1e-9)).toFixed(2)),
      runs: wt.runs,
      unstable: driftWarning(wt, jt),
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
  // A '~' on the speedup marks a row whose own samples were too scattered to
  // support two decimal places. Printing it unmarked is how a noisy run becomes
  // a quoted figure in a README.
  const speed = r.unstable ? `~${r.speedup}x` : `${r.speedup}x`;
  console.log(
    `${r.kernel.padEnd(27)} ${String(r.sizeBp).padStart(8)} ` +
      `${r.wasmMedianMs.toFixed(3).padStart(9)} ${r.jsMedianMs.toFixed(3).padStart(9)} ` +
      `${speed.padStart(8)} ${agree}`
  );
}

const unstableCount = rows.filter(r => r.unstable).length;
if (unstableCount > 0) {
  console.log('');
  console.log(
    `~ ${unstableCount} of ${rows.length} rows had an interquartile spread over ` +
      `${UNSTABLE_IQR_FRACTION * 100}% of the median. Their ratios are indicative`
  );
  console.log('  only; rerun on an idle machine before quoting them anywhere.');
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
  // Read the baseline defensively. This runs in CI, where the two ways it fails
  // are a path that does not exist and a file half-written by an interrupted
  // run. Both throw deep inside JSON.parse with a message that says nothing
  // about which file or why, and the resulting red build looks like a
  // performance regression rather than a missing argument.
  let baseline: { rows: Row[] };
  try {
    baseline = JSON.parse(await Bun.file(values.check).text()) as { rows: Row[] };
  } catch (err) {
    console.error(`Could not read the baseline at ${values.check}: ${String(err)}`);
    console.error('Generate one with: bun run bench:wasm');
    process.exit(2);
  }
  if (!Array.isArray(baseline.rows)) {
    console.error(`${values.check} has no "rows" array; it is not a benchmark result file.`);
    process.exit(2);
  }
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
    // A row whose own samples disagreed badly cannot support failing a build.
    // The run has already declined to stand behind this ratio in the report;
    // gating on it anyway would produce exactly the intermittent red that gets
    // a benchmark gate switched off.
    if (r.unstable) continue;
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

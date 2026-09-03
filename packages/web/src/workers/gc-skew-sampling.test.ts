import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadWasmVariants } from './wasm-variants';

/**
 * The GC skew worker must not box a per-base kernel result into a JS array.
 *
 * ## The defect
 *
 * `compute_cumulative_gc_skew` returns one f64 PER BASE. For the catalogue's
 * largest genome that is 300,000 values. `analysis.worker.ts` wrapped the call
 * in `Array.from(...)` and the very next loop read only every `stepSize`-th
 * entry -- about 1,200 of them, 0.4% of what was boxed.
 *
 * Measured on this machine, 300 kb, 31 interleaved rounds:
 *
 *   kernel only                      1.85 ms
 *   kernel + Array.from (as shipped) 11.83 ms
 *   kernel, sampled from Float64Array 1.80 ms
 *
 * So the boxing was 85% of the call, and removing it is a 6.5x speedup on the
 * GC skew path. It held at every size tested (5.9x at 3.5 kb, 5.5x at 50 kb),
 * which matters because the ratio being flat across three orders of magnitude
 * is what distinguishes a real effect from a noisy machine -- this box swung a
 * baseline 3.6x between sequential runs, so single measurements here are not
 * trustworthy and these were interleaved for that reason.
 *
 * ## Why a test rather than a comment
 *
 * `Array.from` around a typed array is the kind of edit that gets reintroduced
 * by anyone who wants a `number[]`, and nothing about it looks wrong. The cost
 * is invisible until someone profiles a 300 kb genome.
 */

const variants = await loadWasmVariants();

const bases = 'ACGT';
function genome(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += bases[(i * 2654435761) % 4];
  return s;
}

/** The sampling loop from analysis.worker.ts, over whatever array-like it is given. */
function sampleCumulative(
  cumulative: { length: number; [i: number]: number | undefined },
  windows: number,
  stepSize: number
): number[] {
  const out: number[] = [];
  for (let i = 0; i < windows; i++) {
    const pos = i * stepSize;
    if (pos < cumulative.length) out.push(cumulative[pos] as number);
    else if (cumulative.length > 0) out.push(cumulative[cumulative.length - 1] as number);
  }
  return out;
}

describe('dropping Array.from is semantics-neutral', () => {
  for (const { name, wasm } of variants) {
    it(`samples identically from a Float64Array and a boxed array [${name}]`, () => {
      // If these ever diverged the optimisation would be a correctness bug, so
      // this is the assertion that licenses the change -- not the timing.
      for (const size of [3500, 50_000]) {
        const seq = genome(size);
        const cumulative = wasm.compute_cumulative_gc_skew(seq);
        const stepSize = 250;
        const windows = Math.floor((size - 1000) / stepSize) + 1;

        const fromTyped = sampleCumulative(cumulative, windows, stepSize);
        const fromBoxed = sampleCumulative(Array.from(cumulative), windows, stepSize);

        expect(fromTyped).toEqual(fromBoxed);
        expect(fromTyped.length).toBe(windows);
      }
    });

    it(`returns one value per base, which is the reason boxing was wasteful [${name}]`, () => {
      // Guards the premise: if the kernel were ever changed to return one value
      // per window, the comment in the worker would be wrong and this test
      // should fail rather than quietly describe something untrue.
      for (const size of [1000, 3500, 20_000]) {
        expect(wasm.compute_cumulative_gc_skew(genome(size)).length).toBe(size);
      }
    });
  }
});

describe('the worker does not reintroduce the boxing', () => {
  const src = readFileSync(join(import.meta.dir, 'analysis.worker.ts'), 'utf8');

  it('reads the source, so this is not vacuous', () => {
    expect(src).toContain('compute_cumulative_gc_skew');
  });

  it('does not wrap compute_cumulative_gc_skew in Array.from', () => {
    expect(src).not.toMatch(/Array\.from\(\s*wasm\.compute_cumulative_gc_skew/);
  });

  it('is discriminating', () => {
    // The matcher above must actually match the shipped-defect text, or it
    // would pass against any source at all.
    const asShipped = 'const cumulative = Array.from(wasm.compute_cumulative_gc_skew(seq));';
    expect(asShipped).toMatch(/Array\.from\(\s*wasm\.compute_cumulative_gc_skew/);
  });
});

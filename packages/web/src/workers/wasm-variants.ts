/**
 * Load both WASM variants so parity tests cover the one production actually uses.
 *
 * ## Why this exists
 *
 * The parity tests imported `@phage/wasm-compute`, whose default export resolves
 * to `pkg/` -- the baseline, non-SIMD build. The loader prefers `pkg-simd/`,
 * so the variant that runs in production was never tested at all.
 *
 * That is not a theoretical gap. The two are built from the same Rust source
 * with different `target-feature` flags, and SIMD lowering is exactly where a
 * compiler can produce a different answer: different rounding order in a float
 * reduction, different behaviour on a partial final lane. A parity suite that
 * skips it is checking the build nobody runs.
 *
 * ## What "parity" means here
 *
 * Each variant is checked against the same JavaScript reference, not against
 * each other. Comparing the two variants alone would pass if both were wrong in
 * the same way, which is the likely failure mode when they share source.
 */

import type * as WasmComputeModule from '@phage/wasm-compute';

/** The compute module's public surface, taken from the baseline build. */
export type WasmModule = typeof WasmComputeModule;

export interface WasmVariant {
  /** Human name for the test title. */
  name: string;
  /**
   * The loaded module, typed from the baseline build.
   *
   * Both variants compile from the same Rust source, so they share an ABI by
   * construction; if they ever did not, the parity assertions are what would
   * notice, and a looser type here would only hide it from the compiler too.
   */
  wasm: WasmModule;
}

type MaybeInit = { default?: () => Promise<unknown> };

async function load(name: string, specifier: string): Promise<WasmVariant | null> {
  try {
    const mod = (await import(specifier)) as WasmModule;
    const init = (mod as unknown as MaybeInit).default;
    if (typeof init === 'function') await init();
    return { name, wasm: mod };
  } catch (error) {
    // A missing variant is reported rather than silently skipped: a parity
    // suite that quietly tests nothing is worse than one that fails.
    console.error(`[wasm-variants] could not load ${name} (${specifier}):`, error);
    return null;
  }
}

/**
 * Both variants, baseline first.
 *
 * Throws rather than returning an empty list. Every caller is a test file whose
 * assertions would otherwise all be skipped, reporting green for a suite that
 * ran nothing.
 */
export async function loadWasmVariants(): Promise<WasmVariant[]> {
  const variants = (
    await Promise.all([
      load('pkg', '@phage/wasm-compute'),
      load('pkg-simd', '@phage/wasm-compute/simd'),
    ])
  ).filter((v): v is WasmVariant => v !== null);

  if (variants.length < 2) {
    throw new Error(
      `Expected both WASM variants to load, got ${variants.length} ` +
        `(${variants.map(v => v.name).join(', ') || 'none'}). ` +
        'Run: cd packages/wasm-compute && bun run build'
    );
  }

  return variants;
}

#!/usr/bin/env bun
import { $ } from "bun";
import { parseArgs } from "util";
import { fileURLToPath } from "url";
import { join } from "node:path";

// Keep runtime URLs, first-stage bundles and embedded executable entries together.
// Worker sources are not auto-discovered by Bun's standalone compiler.
export const EXECUTABLE_WORKERS = [
  { source: 'packages/tui/src/workers/abundance-worker.ts', bundle: 'abundance-worker.js', define: 'PHAGE_ABUNDANCE_WORKER' },
  { source: 'packages/tui/src/workers/host-metabolism-worker.ts', bundle: 'host-metabolism-worker.js', define: 'PHAGE_HOST_METABOLISM_WORKER' },
  { source: 'packages/tui/src/local-genome-import.worker.ts', bundle: 'local-genome-import.worker.js', define: 'PHAGE_LOCAL_GENOME_WORKER' },
  { source: 'packages/tui/src/research-replay.worker.ts', bundle: 'research-replay.worker.js', define: 'PHAGE_RESEARCH_WORKER' },
] as const;

/** The production first stage, also used for isolated executable integration tests. */
export function executableBuildOptions(outdir = './dist'): Bun.BuildConfig {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const stubPath = fileURLToPath(new URL('./react-devtools-stub.js', import.meta.url));
  return {
    entrypoints: [join(root, 'packages/tui/src/index.tsx'), ...EXECUTABLE_WORKERS.map(worker => join(root, worker.source))],
    outdir, naming: '[name].js', target: 'bun', external: [],
    define: {
      ...Object.fromEntries(EXECUTABLE_WORKERS.map(worker => [worker.define, JSON.stringify(`./${worker.bundle}`)])),
      'process.env.DEV': "'false'",
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    plugins: [{ name: 'devtools-stub', setup(build) {
      build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: stubPath }));
    } }],
  };
}

/** Second stage must embed every emitted worker, not merely leave it beside the binary. */
export function executableCompileArgs(outdir: string, outfile: string, target?: string): string[] {
  return ['bun', 'build', join(outdir, 'index.js'), ...EXECUTABLE_WORKERS.map(worker => join(outdir, worker.bundle)),
    '--compile', '--outfile', outfile, ...(target ? ['--target', target] : [])];
}

export async function buildExecutable(args: string[] = Bun.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      target: { type: "string", default: "" },
    },
  });

  // Map friendly names to bun targets
  const targetMap: Record<string, string> = {
    "mac-arm64": "bun-darwin-arm64",
    "mac-x64": "bun-darwin-x64",
    "linux-x64": "bun-linux-x64",
    "linux-arm64": "bun-linux-arm64",
    "windows-x64": "bun-windows-x64",
  };

  if (values.target && !(values.target in targetMap)) {
    console.error(`Unknown target "${values.target}". Supported: ${Object.keys(targetMap).join(", ")}`);
    process.exit(1);
  }
  const target = values.target ? targetMap[values.target] : undefined;
  const outfile = values.target
    ? `dist/phage-explorer-${values.target.replace("mac-", "macos-")}${values.target.includes("windows") ? ".exe" : ""}`
    : "dist/phage-explorer";

  console.log(`Building${target ? ` for ${target}` : ""}...`);

  // The repo ships prebuilt wasm-compute artifacts. Only rebuild when asked
  // or when the artifacts are missing, so local builds don't require wasm-pack
  // and a Rust toolchain unless the developer is actively changing the WASM code.
  const wasmArtifact = "./packages/wasm-compute/pkg/wasm_compute_bg.wasm";
  const wasmSimdArtifact = "./packages/wasm-compute/pkg-simd/wasm_compute_bg.wasm";
  const forceWasmBuild = process.env.PHAGE_FORCE_WASM_BUILD === "1";

  if (forceWasmBuild) {
    // Build BOTH variants. The web loader prefers the SIMD build wherever the
    // browser supports it, which is effectively everywhere, so rebuilding only
    // `pkg` leaves production running whatever `pkg-simd` last happened to
    // contain. That is exactly how pkg-simd fell eight months behind and lost
    // two exports; the consumers guard on `typeof fn === "function"` and
    // silently fall back to JS, so nothing surfaced the drift.
    console.log("Building wasm-compute (baseline + SIMD)...");
    try {
      await $`cd packages/wasm-compute && RUSTFLAGS="-C target-feature=-simd128" wasm-pack build --target bundler --out-dir pkg`;
      await $`cd packages/wasm-compute && RUSTFLAGS="-C target-feature=+simd128" wasm-pack build --target bundler --out-dir pkg-simd`;
    } catch (e) {
      console.error("Failed to build wasm-compute:", e);
      process.exit(1);
    }
  } else if (await Bun.file(wasmArtifact).exists()) {
    console.log("Using prebuilt wasm-compute artifacts (set PHAGE_FORCE_WASM_BUILD=1 to rebuild)...");
  } else {
    console.error("Prebuilt wasm-compute artifacts not found. Either:");
    console.error("  - run with PHAGE_FORCE_WASM_BUILD=1 to build from Rust source (requires wasm-pack), or");
    console.error("  - restore packages/wasm-compute/pkg/ from the repo.");
    process.exit(1);
  }

  // Guard against the variants drifting apart again: the loader picks SIMD when
  // available, so a SIMD build missing an export means that feature silently
  // degrades to JS for nearly every user.
  if (await Bun.file(wasmSimdArtifact).exists()) {
    const exportsOf = async (dts: string): Promise<string[]> =>
      [...(await Bun.file(dts).text()).matchAll(/^export function ([a-z_0-9]+)/gm)]
        .map((m) => m[1])
        .sort();
    const baseExports = await exportsOf("./packages/wasm-compute/pkg/wasm_compute.d.ts");
    const simdExports = await exportsOf("./packages/wasm-compute/pkg-simd/wasm_compute.d.ts");
    const missing = baseExports.filter((name) => !simdExports.includes(name));
    if (missing.length > 0) {
      console.error(
        `wasm-compute variant drift: pkg-simd is missing ${missing.length} export(s) present in pkg:`,
      );
      console.error(`  ${missing.join(", ")}`);
      console.error("Rebuild both with: cd packages/wasm-compute && bun run build");
      process.exit(1);
    }
    console.log(`✓ wasm-compute variants agree (${baseExports.length} exports).`);
  }

  try {
    await $`bun run ./scripts/inline-wasm-compute.ts`;
  } catch (e) {
    console.error("Failed to inline wasm-compute:", e);
    process.exit(1);
  }

  const result = await Bun.build(executableBuildOptions());

  if (!result.success) {
    console.error("Build failed:");
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }

  // Now compile the bundle and every manifest worker into the same executable.
  const compileArgs = executableCompileArgs('./dist', outfile, target);

  console.log(`Compiling to ${outfile}...`);
  await $`${compileArgs}`;

  // Retain intermediate bundles for worker/build diagnostics.
  console.log(`✓ Built ${outfile}`);

}

if (import.meta.main) await buildExecutable();

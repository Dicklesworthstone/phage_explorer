#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "fs";
import { join, isAbsolute } from "path";
import { parseArgs } from "util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "pkg-dir": { type: "string", default: "" },
  },
});

const pkgDirInput = values["pkg-dir"];
const pkgDir =
  pkgDirInput && pkgDirInput.length > 0
    ? isAbsolute(pkgDirInput)
      ? pkgDirInput
      : join(import.meta.dir, "../packages/wasm-compute", pkgDirInput)
    : join(import.meta.dir, "../packages/wasm-compute/pkg");

const jsPath = join(pkgDir, "wasm_compute.js");
const bgJsPath = join(pkgDir, "wasm_compute_bg.js");
const wasmPath = join(pkgDir, "wasm_compute_bg.wasm");
const gitignorePath = join(pkgDir, ".gitignore");

console.log(`Inlining wasm-compute Wasm into JS... (${pkgDir})`);

try {
  // wasm-pack --target bundler produces `wasm_compute_bg.js`, the JS glue.
  //
  // ## What these patches are, and why they now fail loudly
  //
  // Eleven regex corrections for wasm-bindgen emitting a getter that calls the
  // wrong WASM export -- `SequenceHandle.length` calling
  // `bonddetectionresult_bond_count`, and so on.
  //
  // They used to be applied with a bare `String.replace` each, and the only
  // check was whether the file changed AT ALL. A patch whose regex stopped
  // matching silently did nothing, and the failure was swallowed by a catch
  // whose comment claimed the only impact was `SequenceHandle.length`. So a
  // real miscompilation could arrive and nothing would say so -- which is
  // exactly the risk when the toolchain moves, as it just did.
  //
  // Every patch is now named and its match is checked individually. A patch
  // that matches is applied. A patch that does not match is reported, and the
  // build fails unless the patch is listed in OBSOLETE below with the reason.
  //
  // ## Their current status
  //
  // All eleven are obsolete at the pinned toolchain (see
  // packages/wasm-compute/rust-toolchain.toml): the generated glue already has
  // the correct getters, in both variants. Git history shows every committed
  // revision of the glue had correct getters, including the parent of the
  // commit that introduced these patches -- so they have been correcting a bug
  // that was never present in a tracked artifact.
  //
  // They are kept rather than deleted because deleting them would also delete
  // the detector: if a future wasm-bindgen reintroduces the defect, a patch
  // moving from obsolete to matching is the signal, and this script prints it.
  const bg = readFileSync(bgJsPath, "utf8");

  interface GluePatch {
    name: string;
    re: RegExp;
    from: string;
    to: string;
  }

  const patches: GluePatch[] = [
      {
        name: "SequenceHandle.length",
        // SequenceHandle.length incorrectly calls BondDetectionResult getter
        re: /export class SequenceHandle[\s\S]*?get length\(\) \{\n\s*const ret = wasm\.bonddetectionresult_bond_count\(this\.__wbg_ptr\);/,
        from: "const ret = wasm.bonddetectionresult_bond_count(this.__wbg_ptr);",
        to: "const ret = wasm.sequencehandle_length(this.__wbg_ptr);",
      },
      {
        name: "DenseKmerResult.k",
        // DenseKmerResult.k incorrectly calls CGR resolution getter
        re: /export class DenseKmerResult[\s\S]*?get k\(\) \{\n\s*const ret = wasm\.cgrcountsresult_resolution\(this\.__wbg_ptr\);/,
        from: "const ret = wasm.cgrcountsresult_resolution(this.__wbg_ptr);",
        to: "const ret = wasm.densekmerresult_k(this.__wbg_ptr);",
      },
      {
        name: "DotPlotBuffers.bins",
        // DotPlotBuffers.bins incorrectly calls CGR resolution getter
        re: /export class DotPlotBuffers[\s\S]*?get bins\(\) \{\n\s*const ret = wasm\.cgrcountsresult_resolution\(this\.__wbg_ptr\);/,
        from: "const ret = wasm.cgrcountsresult_resolution(this.__wbg_ptr);",
        to: "const ret = wasm.dotplotbuffers_bins(this.__wbg_ptr);",
      },
      {
        name: "KLScanResult.window_count",
        // KLScanResult.window_count incorrectly calls CGR resolution getter
        re: /export class KLScanResult[\s\S]*?get window_count\(\) \{\n\s*const ret = wasm\.cgrcountsresult_resolution\(this\.__wbg_ptr\);/,
        from: "const ret = wasm.cgrcountsresult_resolution(this.__wbg_ptr);",
        to: "const ret = wasm.klscanresult_window_count(this.__wbg_ptr);",
      },
      {
        name: "KLScanResult.k",
        // KLScanResult.k incorrectly calls DotPlotBuffers.window getter
        re: /export class KLScanResult[\s\S]*?get k\(\) \{\n\s*const ret = wasm\.dotplotbuffers_window\(this\.__wbg_ptr\);/,
        from: "const ret = wasm.dotplotbuffers_window(this.__wbg_ptr);",
        to: "const ret = wasm.klscanresult_k(this.__wbg_ptr);",
      },
      {
        name: "MinHashSignature.total_kmers",
        // MinHashSignature.total_kmers incorrectly calls DenseKmerResult.total_valid getter
        re: /export class MinHashSignature[\s\S]*?get total_kmers\(\) \{\n\s*const ret = wasm\.densekmerresult_total_valid\(this\.__wbg_ptr\);/,
        from: "const ret = wasm.densekmerresult_total_valid(this.__wbg_ptr);",
        to: "const ret = wasm.minhashsignature_total_kmers(this.__wbg_ptr);",
      },
      {
        name: "MinHashSignature.k",
        // MinHashSignature.k incorrectly calls CGR resolution getter
        re: /export class MinHashSignature[\s\S]*?get k\(\) \{\n\s*const ret = wasm\.cgrcountsresult_resolution\(this\.__wbg_ptr\);/,
        from: "const ret = wasm.cgrcountsresult_resolution(this.__wbg_ptr);",
        to: "const ret = wasm.minhashsignature_k(this.__wbg_ptr);",
      },
      {
        name: "PCAResult.n_features",
        // PCAResult.n_features incorrectly calls DotPlotBuffers.window getter
        re: /export class PCAResult[\s\S]*?get n_features\(\) \{\n\s*const ret = wasm\.dotplotbuffers_window\(this\.__wbg_ptr\);/,
        from: "const ret = wasm.dotplotbuffers_window(this.__wbg_ptr);",
        to: "const ret = wasm.pcaresult_n_features(this.__wbg_ptr);",
      },
      {
        name: "PCAResult.n_components",
        // PCAResult.n_components incorrectly calls CGR resolution getter
        re: /export class PCAResult[\s\S]*?get n_components\(\) \{\n\s*const ret = wasm\.cgrcountsresult_resolution\(this\.__wbg_ptr\);/,
        from: "const ret = wasm.cgrcountsresult_resolution(this.__wbg_ptr);",
        to: "const ret = wasm.pcaresult_n_components(this.__wbg_ptr);",
      },
      {
        name: "PCAResultF32.n_features",
        // PCAResultF32.n_features incorrectly calls MyersDiffResult.mismatches getter
        re: /export class PCAResultF32[\s\S]*?get n_features\(\) \{\n\s*const ret = wasm\.myersdiffresult_mismatches\(this\.__wbg_ptr\);/,
        from: "const ret = wasm.myersdiffresult_mismatches(this.__wbg_ptr);",
        to: "const ret = wasm.pcaresultf32_n_features(this.__wbg_ptr);",
      },
      {
        name: "PCAResultF32.n_components",
        // PCAResultF32.n_components incorrectly calls MyersDiffResult.matches getter
        re: /export class PCAResultF32[\s\S]*?get n_components\(\) \{\n\s*const ret = wasm\.myersdiffresult_matches\(this\.__wbg_ptr\);/,
        from: "const ret = wasm.myersdiffresult_matches(this.__wbg_ptr);",
        to: "const ret = wasm.pcaresultf32_n_components(this.__wbg_ptr);",
      },
    ];

  /**
   * Patches known not to match at the pinned toolchain.
   *
   * A patch listed here that DOES match is reported loudly: it means the
   * wasm-bindgen defect has returned and the entry should come off this list.
   * A patch NOT listed here that fails to match fails the build.
   */
  const OBSOLETE = new Set(patches.map((p) => p.name));

  let patched = bg;
  const applied: string[] = [];
  const missed: string[] = [];

  for (const p of patches) {
    if (!p.re.test(patched)) {
      missed.push(p.name);
      continue;
    }
    patched = patched.replace(p.re, (match) => match.replace(p.from, p.to));
    applied.push(p.name);
  }

  // A patch that matched but is marked obsolete means the defect came back.
  const resurrected = applied.filter((n) => OBSOLETE.has(n));
  if (resurrected.length > 0) {
    console.warn(
      `  NOTE: ${resurrected.length} glue patch(es) matched that were recorded as obsolete: ` +
        `${resurrected.join(", ")}. The wasm-bindgen defect they correct has returned; ` +
        `remove them from OBSOLETE in scripts/inline-wasm-compute.ts.`
    );
  }

  // A patch that did NOT match and is not recorded as obsolete is the real
  // failure: it was expected to correct something and silently did not.
  const unexplained = missed.filter((n) => !OBSOLETE.has(n));
  if (unexplained.length > 0) {
    console.error(
      `Glue patch(es) did not match and are not recorded as obsolete: ${unexplained.join(", ")}.\n` +
        `Either the generated glue changed shape, or the patch is stale. Do not ship this build.`
    );
    process.exit(1);
  }

  if (applied.length > 0) {
    writeFileSync(bgJsPath, patched);
    console.log(`  Applied ${applied.length} glue patch(es): ${applied.join(", ")}`);
  } else {
    console.log(`  All ${patches.length} glue patches obsolete at this toolchain (nothing to apply).`);
  }
} catch (e) {
  // Not swallowed. A failure here means the glue is in an unknown state and the
  // artifact must not be shipped; the previous code warned and continued.
  console.error("Failed to patch wasm_compute_bg.js:", e);
  process.exit(1);
}

// The inlining stage keeps its own error handling: a failure here also means the
// artifact must not be shipped.
try {
  const wasmBuffer = readFileSync(wasmPath);
  const wasmBase64 = wasmBuffer.toString("base64");

  // wasm-pack output has changed over time; rather than trying to patch arbitrary templates,
  // we overwrite the entrypoint with a stable, bundler-friendly wrapper that:
  // - avoids importing `.wasm` as an ES module (Vite/Rollup do not support the proposal yet)
  // - instantiates from inlined bytes (critical for Bun --compile single-binary builds)
  // - exposes a cached async `init()` default export (worker-safe) so callers can explicitly await initialization
  //   (and so wasm-loader can safely call init when needed)
  const wrapper = `import { __wbg_set_wasm } from "./wasm_compute_bg.js";
import * as wasmBg from "./wasm_compute_bg.js";
export * from "./wasm_compute_bg.js";

// Inlined Wasm bytes (base64)
const wasmBase64 = "${wasmBase64}";

function base64ToBytes(base64) {
  // Prefer Node/Bun Buffer when available (fast + works without atob).
  if (typeof Buffer !== "undefined") {
    return Uint8Array.from(Buffer.from(base64, "base64"));
  }

  // Browser/worker fallback.
  const atobFn = globalThis.atob;
  if (typeof atobFn !== "function") {
    throw new Error("No base64 decoder available (expected Buffer or atob)");
  }

  const bin = atobFn(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const wasmBytes = base64ToBytes(wasmBase64);
let initPromise = null;

async function init() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const { instance } = await WebAssembly.instantiate(wasmBytes, {
      "./wasm_compute_bg.js": wasmBg,
    });

    __wbg_set_wasm(instance.exports);

    const start = instance.exports.__wbindgen_start;
    if (typeof start === "function") {
      start.call(instance.exports);
    }
  })().catch((err) => {
    // Allow retry on transient failures.
    initPromise = null;
    throw err;
  });

  return initPromise;
}

export default init;
`;

  writeFileSync(jsPath, wrapper);

  // Ensure the wasm-pack output dir is trackable in git (Vercel does not run Rust builds).
  // wasm-pack writes a blanket `*` ignore; we replace it with an allowlist so the runtime
  // files (and any wasm-bindgen `snippets/`) can be committed without `git add -f`.
  writeFileSync(
    gitignorePath,
    [
      "*",
      "!.gitignore",
      "!package.json",
      "!wasm_compute.d.ts",
      "!wasm_compute.js",
      "!wasm_compute_bg.js",
      "!wasm_compute_bg.wasm",
      "!wasm_compute_bg.wasm.d.ts",
      "!snippets/",
      "!snippets/**",
      "",
    ].join("\n")
  );
  console.log(`✓ Inlined ${wasmBuffer.length} bytes of wasm-compute.`);
} catch (e) {
  console.error("Error inlining wasm-compute:", e);
  process.exit(1);
}

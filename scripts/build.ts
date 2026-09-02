#!/usr/bin/env bun
import { $ } from "bun";
import { parseArgs } from "util";
import { fileURLToPath } from "url";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
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
const forceWasmBuild = process.env.PHAGE_FORCE_WASM_BUILD === "1";

if (forceWasmBuild) {
  console.log("Building wasm-compute (canonical wasm module)...");
  try {
    await $`cd packages/wasm-compute && RUSTFLAGS="-C target-feature=-simd128" wasm-pack build --target bundler --out-dir pkg`;
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

try {
  await $`bun run ./scripts/inline-wasm-compute.ts`;
} catch (e) {
  console.error("Failed to inline wasm-compute:", e);
  process.exit(1);
}

// Create stub for react-devtools-core
// Use fileURLToPath to properly handle Windows paths (pathname gives POSIX-style /D:/... on Windows)
const stubPath = fileURLToPath(new URL("./react-devtools-stub.js", import.meta.url));

const result = await Bun.build({
  entrypoints: ["./packages/tui/src/index.tsx"],
  outdir: "./dist",
  // Bun.build() only accepts "browser", "bun", or "node" - NOT platform-specific targets
  // Platform targets (bun-darwin-arm64, etc.) are only for `bun build --compile --target`
  target: "bun",
  // Alias react-devtools-core to our stub
  external: [],
  define: {
    "process.env.DEV": "'false'",
    // React switches on NODE_ENV, not DEV. Without this the compiled binary
    // ships React's development build: every render pays for the dev-only
    // fiber instrumentation, and a crash prints a full internal stack trace
    // instead of an error message.
    "process.env.NODE_ENV": '"production"',
  },
  plugins: [
    {
      name: "devtools-stub",
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, () => {
          return { path: stubPath };
        });
      },
    },
  ],
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

// Now compile the bundle
const bundlePath = "./dist/index.js";
const compileArgs = [
  "bun", "build",
  bundlePath,
  "--compile",
  "--outfile", outfile,
];

if (target) {
  compileArgs.push("--target", target);
}

console.log(`Compiling to ${outfile}...`);
await $`${compileArgs}`;

// Clean up intermediate bundle
await $`rm -f ${bundlePath}`;

console.log(`✓ Built ${outfile}`);

#!/usr/bin/env bun
import { $ } from "bun";
import { parseArgs } from "util";

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

const target = values.target ? targetMap[values.target] : undefined;
const outfile = values.target
  ? `dist/phage-explorer-${values.target.replace("mac-", "macos-")}${values.target.includes("windows") ? ".exe" : ""}`
  : "dist/phage-explorer";

console.log(`Building${target ? ` for ${target}` : ""}...`);

console.log("Building wasm-compute (canonical wasm module)...");
try {
  await $`cd packages/wasm-compute && wasm-pack build --target nodejs --out-dir pkg`;
  await $`bun run scripts/inline-wasm-compute.ts`;
} catch (e) {
  console.error("Failed to build wasm-compute:", e);
  process.exit(1);
}

// Create stub for react-devtools-core
const stubPath = new URL("./react-devtools-stub.js", import.meta.url).pathname;

const result = await Bun.build({
  entrypoints: ["./packages/tui/src/index.tsx"],
  outdir: "./dist",
  target: target as any || "bun",
  // Alias react-devtools-core to our stub
  external: [],
  define: {
    "process.env.DEV": "'false'",
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

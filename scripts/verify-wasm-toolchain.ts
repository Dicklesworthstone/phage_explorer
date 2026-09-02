#!/usr/bin/env bun
/**
 * Verify the committed WASM artifacts were built by the pinned toolchain.
 *
 * ## Why
 *
 * The two shipped variants were once built by different compilers -- `pkg` with
 * rustc 1.95.0-nightly and `pkg-simd` with 1.94.0-nightly -- and both embedded a
 * wasm-bindgen older than the one `Cargo.lock` pinned. Anyone running the
 * rebuild path produced glue from a different bindgen than the one that
 * generated the committed, tested artifacts.
 *
 * That is the exact circumstance under which `inline-wasm-compute.ts`'s silent
 * no-op patching becomes dangerous: new bindgen output, old patch regexes, no
 * signal. A pin nobody checks is a comment.
 *
 * ## What it checks
 *
 * Every `.wasm` in `pkg/` and `pkg-simd/` records the rustc commit hash that
 * produced it, in the standard `producers` custom section, and the bindgen
 * version in its glue. Both are compared against `rust-toolchain.toml` and
 * `Cargo.lock`, which are the declared truth.
 *
 * Run: bun scripts/verify-wasm-toolchain.ts
 * Wired into `bun run wasm:verify`.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(import.meta.dir, '..');
const CRATE = resolve(ROOT, 'packages/wasm-compute');
const VARIANTS = ['pkg', 'pkg-simd'] as const;

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  console.error('Rebuild with the pinned toolchain:');
  console.error('  cd packages/wasm-compute && bun run build');
  process.exit(1);
}

// --- the declared toolchain -------------------------------------------------

const toolchainPath = resolve(CRATE, 'rust-toolchain.toml');
if (!existsSync(toolchainPath)) {
  fail('packages/wasm-compute/rust-toolchain.toml is missing; the build is unpinned.');
}
const channel = (readFileSync(toolchainPath, 'utf8').match(/channel\s*=\s*"([^"]+)"/) ??
  [])[1];
if (!channel) fail('rust-toolchain.toml declares no channel.');

/** Commit hash of the pinned rustc, e.g. "88d9e12ae" for 1.98.0. */
let pinnedHash: string;
try {
  const version = execFileSync('rustup', ['run', channel, 'rustc', '--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const m = version.match(/\(([0-9a-f]{8,})\s/);
  if (!m) fail(`Could not read a commit hash from: ${version.trim()}`);
  pinnedHash = m[1];
} catch {
  fail(
    `The pinned toolchain "${channel}" is not installed.\n` +
      `  Install it:  rustup toolchain install ${channel}\n` +
      `               rustup target add wasm32-unknown-unknown --toolchain ${channel}`
  );
}

// --- the declared bindgen ---------------------------------------------------

const lock = readFileSync(resolve(CRATE, 'Cargo.lock'), 'utf8');
const lockBindgen = (lock.match(
  /name = "wasm-bindgen"\s*\nversion = "([^"]+)"/
) ?? [])[1];
if (!lockBindgen) fail('Cargo.lock does not pin wasm-bindgen.');

// --- what the artifacts actually contain ------------------------------------

let problems = 0;

for (const variant of VARIANTS) {
  const wasmPath = resolve(CRATE, variant, 'wasm_compute_bg.wasm');
  if (!existsSync(wasmPath)) {
    console.error(`✗ ${variant}: wasm_compute_bg.wasm is missing`);
    problems++;
    continue;
  }

  // The producers section is plain text inside the binary; reading it as latin1
  // avoids any decoding surprises.
  const bytes = readFileSync(wasmPath).toString('latin1');

  const rustcHashes = [...bytes.matchAll(/rustc\/([0-9a-f]{8,})/g)].map(m => m[1]);
  const bindgen = (bytes.match(/wasm-bindgen-(\d+\.\d+\.\d+)/) ?? [])[1];

  if (rustcHashes.length === 0) {
    console.error(`✗ ${variant}: no rustc producer record found`);
    problems++;
  } else if (!rustcHashes.every(h => pinnedHash.startsWith(h) || h.startsWith(pinnedHash))) {
    console.error(
      `✗ ${variant}: built by rustc ${[...new Set(rustcHashes)].join(', ')}, ` +
        `pinned is ${pinnedHash} (${channel})`
    );
    problems++;
  } else {
    console.log(`✓ ${variant}: rustc ${rustcHashes[0]} matches ${channel}`);
  }

  if (!bindgen) {
    console.error(`✗ ${variant}: no wasm-bindgen version found`);
    problems++;
  } else if (bindgen !== lockBindgen) {
    console.error(
      `✗ ${variant}: wasm-bindgen ${bindgen} in the artifact, ${lockBindgen} in Cargo.lock`
    );
    problems++;
  } else {
    console.log(`✓ ${variant}: wasm-bindgen ${bindgen} matches Cargo.lock`);
  }
}

// Both variants must come from the same compiler. They did not, once.
const hashes = VARIANTS.map(v => {
  const p = resolve(CRATE, v, 'wasm_compute_bg.wasm');
  if (!existsSync(p)) return null;
  return (readFileSync(p).toString('latin1').match(/rustc\/([0-9a-f]{8,})/) ?? [])[1];
});
if (hashes[0] && hashes[1] && hashes[0] !== hashes[1]) {
  console.error(
    `✗ pkg and pkg-simd were built by different compilers: ${hashes[0]} vs ${hashes[1]}`
  );
  problems++;
} else if (hashes[0] && hashes[1]) {
  console.log('✓ both variants were built by the same compiler');
}

if (problems > 0) {
  fail(`${problems} toolchain mismatch(es) between the committed artifacts and the pins.`);
}

console.log('\nWASM artifacts match rust-toolchain.toml and Cargo.lock.');

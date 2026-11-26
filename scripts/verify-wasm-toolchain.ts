#!/usr/bin/env bun
/**
 * Verify the committed WASM artifacts were built by the pinned toolchain.
 *
 * ## Why
 *
 * The two shipped variants were once built by different compilers -- `pkg` with
 * rustc 1.95.0-nightly and `pkg-simd` with 1.94.0-nightly -- and both embedded a
 * wasm-bindgen older than the one the local lock resolved. Anyone running the
 * rebuild path produced glue from a different bindgen than the one that
 * generated the committed, tested artifacts.
 *
 * That is the exact circumstance under which `inline-wasm-compute.ts`'s silent
 * no-op patching becomes dangerous: new bindgen output, old patch regexes, no
 * signal. A pin nobody checks is a comment.
 *
 * ## What it checks
 *
 * Every `.wasm` in `pkg/` and `pkg-simd/` names the tools that produced it in
 * the standard `producers` custom section
 * (https://github.com/WebAssembly/tool-conventions/blob/main/ProducersSection.md).
 * Its `processed-by` field must record both `rustc` and `wasm-bindgen`. The
 * section is decoded structurally rather than searched as text: source paths
 * embedded elsewhere in the binary say nothing about which tools ran.
 *
 * - rustc must be the release `rust-toolchain.toml` names, and its commit must
 *   be the one the installed pinned toolchain reports.
 * - wasm-bindgen must equal the exact (`=x.y.z`) requirement in `Cargo.toml`.
 *   `Cargo.lock` is not tracked, so the manifest is the declared contract;
 *   wasm-pack picks the matching bindgen CLI from the lock that pin resolves.
 * - Both variants must come from the same rustc and the same bindgen.
 *
 * Run: bun scripts/verify-wasm-toolchain.ts
 * Wired into `bun run wasm:verify`.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

/** Tool name -> version, per producers field. */
export type ProducersRecord = Map<string, Map<string, string>>;

const PRODUCER_FIELDS = new Set(['language', 'processed-by', 'sdk']);

/**
 * Decode the `producers` custom section of a WebAssembly module.
 *
 * Returns null when the module has no producers section. Throws on anything
 * that is not a well-formed module and section: a bad header, truncated or
 * over-long LEB128 (u32) values, sections that overrun the module, invalid
 * UTF-8, a second producers section, unknown or repeated field names, repeated
 * tool names within a field, or bytes left over after the last field.
 */
export function readProducers(bytes: Uint8Array): ProducersRecord | null {
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const fail = (message: string): never => { throw new Error(`Malformed WebAssembly module: ${message}`); };
  const u32 = (at: number, end: number): [number, number] => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      if (at >= end) fail('truncated LEB128 value');
      const byte = bytes[at++];
      // The fifth byte may only carry the top four bits of a u32.
      if (i === 4 && byte > 0x0f) fail('LEB128 value exceeds u32');
      value += (byte & 0x7f) * 2 ** (7 * i);
      if ((byte & 0x80) === 0) return [value, at];
    }
    return fail('LEB128 value exceeds u32');
  };
  const name = (at: number, end: number): [string, number] => {
    const [size, start] = u32(at, end);
    if (size > end - start) fail('name runs past the end of its section');
    let text = '';
    try { text = utf8.decode(bytes.subarray(start, start + size)); }
    catch { fail('name is not valid UTF-8'); }
    return [text, start + size];
  };

  if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    fail('missing \\0asm magic');
  }
  if (bytes[4] !== 1 || bytes[5] !== 0 || bytes[6] !== 0 || bytes[7] !== 0) fail('unsupported binary version');

  let found: ProducersRecord | null = null;
  let at = 8;
  while (at < bytes.length) {
    const id = bytes[at++];
    const [size, start] = u32(at, bytes.length);
    if (size > bytes.length - start) fail(`section ${id} runs past the end of the module`);
    const end = start + size;
    if (id === 0) {
      const [sectionName, body] = name(start, end);
      if (sectionName === 'producers') {
        if (found) fail('more than one producers section');
        const record: ProducersRecord = new Map();
        let [fields, p] = u32(body, end);
        for (; fields > 0; fields--) {
          let field: string;
          [field, p] = name(p, end);
          if (!PRODUCER_FIELDS.has(field)) fail(`unknown producers field "${field}"`);
          if (record.has(field)) fail(`producers field "${field}" appears twice`);
          const tools = new Map<string, string>();
          let [count, q] = u32(p, end);
          for (; count > 0; count--) {
            let tool: string, version: string;
            [tool, q] = name(q, end);
            [version, q] = name(q, end);
            if (tools.has(tool)) fail(`producers field "${field}" lists "${tool}" twice`);
            tools.set(tool, version);
          }
          record.set(field, tools);
          p = q;
        }
        if (p !== end) fail('producers section has trailing bytes');
        found = record;
      }
    }
    at = end;
  }
  return found;
}

export interface ArtifactToolchain {
  /** rustc release, e.g. "1.98.0". */
  rustcVersion: string;
  /** Abbreviated rustc commit, e.g. "88d9e12ae". */
  rustcCommit: string;
  /** wasm-bindgen release, e.g. "0.2.128". */
  bindgenVersion: string;
}

/** Read the rustc and wasm-bindgen that processed a module, from its producers record. */
export function artifactToolchain(bytes: Uint8Array): ArtifactToolchain {
  const producers = readProducers(bytes);
  if (!producers) throw new Error('no producers section');
  const processedBy = producers.get('processed-by');
  const rustc = processedBy?.get('rustc');
  const bindgen = processedBy?.get('wasm-bindgen');
  if (rustc === undefined) throw new Error('producers section records no rustc in processed-by');
  if (bindgen === undefined) throw new Error('producers section records no wasm-bindgen in processed-by');
  // rustc records "1.98.0 (88d9e12ae 2026-08-18)"; nightlies add "-nightly".
  const r = rustc.match(/^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?) \(([0-9a-f]{7,40}) \d{4}-\d{2}-\d{2}\)$/);
  if (!r) throw new Error(`unrecognised rustc producer "${rustc}"`);
  // wasm-bindgen records "0.2.128 (246946fdd)".
  const b = bindgen.match(/^(\d+\.\d+\.\d+)(?: \([0-9a-f]+\))?$/);
  if (!b) throw new Error(`unrecognised wasm-bindgen producer "${bindgen}"`);
  return { rustcVersion: r[1], rustcCommit: r[2], bindgenVersion: b[1] };
}

/**
 * The exact wasm-bindgen version `Cargo.toml` pins in `[dependencies]`.
 * Throws unless the requirement is an exact `=x.y.z` pin: a range such as
 * "0.2" lets each fresh resolution pick a different bindgen.
 */
export function declaredBindgen(cargoToml: string): string {
  let section = '';
  let requirement: string | null = null;
  for (const raw of cargoToml.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) { section = header[1].trim(); continue; }
    if (section !== 'dependencies') continue;
    const m = line.match(/^wasm-bindgen\s*=\s*(?:"([^"]*)"|\{.*?\bversion\s*=\s*"([^"]*)".*\})$/);
    if (m) {
      if (requirement !== null) throw new Error('Cargo.toml declares wasm-bindgen twice');
      requirement = m[1] ?? m[2];
    }
  }
  if (requirement === null) throw new Error('Cargo.toml declares no wasm-bindgen dependency with a version');
  const exact = requirement.trim().match(/^=\s*(\d+\.\d+\.\d+)$/);
  if (!exact) {
    throw new Error(`Cargo.toml requires wasm-bindgen "${requirement}"; pin the version the artifacts were built with exactly, e.g. "=0.2.128"`);
  }
  return exact[1];
}

function main(): void {
  const ROOT = resolve(import.meta.dir, '..');
  const CRATE = resolve(ROOT, 'packages/wasm-compute');
  const VARIANTS = ['pkg', 'pkg-simd'] as const;

  const fail = (message: string): never => {
    console.error(`\n✗ ${message}\n`);
    console.error('Rebuild with the pinned toolchain:');
    console.error('  cd packages/wasm-compute && bun run build');
    process.exit(1);
  };

  // --- the declared toolchain -----------------------------------------------

  const toolchainPath = resolve(CRATE, 'rust-toolchain.toml');
  if (!existsSync(toolchainPath)) {
    fail('packages/wasm-compute/rust-toolchain.toml is missing; the build is unpinned.');
  }
  const channel = (readFileSync(toolchainPath, 'utf8').match(/channel\s*=\s*"([^"]+)"/) ?? [])[1];
  if (!channel) return fail('rust-toolchain.toml declares no channel.');

  /** Release and commit of the pinned rustc, e.g. "1.98.0" and "88d9e12ae". */
  let pinnedVersion = '';
  let pinnedCommit = '';
  try {
    const version = execFileSync('rustup', ['run', channel, 'rustc', '--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = version.match(/^rustc (\S+) \(([0-9a-f]{7,40})\s/);
    if (!m) fail(`Could not read a version and commit from: ${version.trim()}`);
    else [, pinnedVersion, pinnedCommit] = m;
  } catch {
    fail(
      `The pinned toolchain "${channel}" is not installed.\n` +
        `  Install it:  rustup toolchain install ${channel}\n` +
        `               rustup target add wasm32-unknown-unknown --toolchain ${channel}`
    );
  }

  // --- the declared bindgen -------------------------------------------------

  let pinnedBindgen = '';
  try {
    pinnedBindgen = declaredBindgen(readFileSync(resolve(CRATE, 'Cargo.toml'), 'utf8'));
  } catch (error) {
    fail(`packages/wasm-compute/${(error as Error).message}`);
  }

  // --- what the artifacts actually contain ----------------------------------

  let problems = 0;
  const seen: ArtifactToolchain[] = [];

  for (const variant of VARIANTS) {
    const wasmPath = resolve(CRATE, variant, 'wasm_compute_bg.wasm');
    if (!existsSync(wasmPath)) {
      console.error(`✗ ${variant}: wasm_compute_bg.wasm is missing`);
      problems++;
      continue;
    }

    let artifact: ArtifactToolchain;
    try {
      artifact = artifactToolchain(readFileSync(wasmPath));
    } catch (error) {
      console.error(`✗ ${variant}: ${(error as Error).message}`);
      problems++;
      continue;
    }
    seen.push(artifact);

    const sameCommit = pinnedCommit.startsWith(artifact.rustcCommit) || artifact.rustcCommit.startsWith(pinnedCommit);
    if (artifact.rustcVersion !== pinnedVersion || !sameCommit) {
      console.error(
        `✗ ${variant}: built by rustc ${artifact.rustcVersion} (${artifact.rustcCommit}), ` +
          `pinned is ${pinnedVersion} (${pinnedCommit}) from channel ${channel}`
      );
      problems++;
    } else {
      console.log(`✓ ${variant}: rustc ${artifact.rustcVersion} (${artifact.rustcCommit}) matches ${channel}`);
    }

    if (artifact.bindgenVersion !== pinnedBindgen) {
      console.error(
        `✗ ${variant}: wasm-bindgen ${artifact.bindgenVersion} in the artifact, =${pinnedBindgen} in Cargo.toml`
      );
      problems++;
    } else {
      console.log(`✓ ${variant}: wasm-bindgen ${artifact.bindgenVersion} matches Cargo.toml`);
    }
  }

  // Both variants must come from the same compiler and bindgen. They did not, once.
  if (seen.length === VARIANTS.length) {
    const [a, b] = seen;
    if (a.rustcVersion !== b.rustcVersion || a.rustcCommit !== b.rustcCommit) {
      console.error(
        `✗ pkg and pkg-simd were built by different compilers: ` +
          `${a.rustcVersion} (${a.rustcCommit}) vs ${b.rustcVersion} (${b.rustcCommit})`
      );
      problems++;
    } else if (a.bindgenVersion !== b.bindgenVersion) {
      console.error(`✗ pkg and pkg-simd were built by different bindgens: ${a.bindgenVersion} vs ${b.bindgenVersion}`);
      problems++;
    } else {
      console.log('✓ both variants were built by the same compiler and bindgen');
    }
  }

  if (problems > 0) {
    fail(`${problems} toolchain mismatch(es) between the committed artifacts and the pins.`);
  }

  console.log('\nWASM artifacts match rust-toolchain.toml and Cargo.toml.');
}

if (import.meta.main) main();

/**
 * Browser Capabilities - Centralized runtime feature detection
 *
 * This module provides a single source of truth for detecting browser features
 * needed by WASM kernels and worker-based computations. All new WASM beads
 * should reference this module for consistent behavior.
 *
 * Design principles:
 * - Feature-detect, never UA sniff
 * - Side-effect free detection
 * - Cache results after first probe
 * - Never block the UI during detection
 *
 * ## Browser Support Matrix (2025)
 *
 * | Feature                    | Chrome 90+ | Firefox 89+ | Safari 15+ | Edge 90+ |
 * |----------------------------|------------|-------------|------------|----------|
 * | WebAssembly (baseline)     | ✅         | ✅          | ✅         | ✅       |
 * | WASM Streaming Compilation | ✅         | ✅          | ✅         | ✅       |
 * | WASM SIMD                  | ✅         | ✅          | ✅ (16.4+) | ✅       |
 * | SharedArrayBuffer          | ✅*        | ✅*         | ✅* (15.2+)| ✅*      |
 * | Transferable ArrayBuffer   | ✅         | ✅          | ✅         | ✅       |
 *
 * *SharedArrayBuffer requires Cross-Origin Isolation (COOP/COEP headers):
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 *
 * ## Progressive Enhancement Policy
 *
 * 1. WASM unavailable → Fall back to pure JS implementations
 * 2. WASM SIMD unavailable → Use baseline WASM (no SIMD intrinsics)
 * 3. SharedArrayBuffer unavailable → Use Transferable ArrayBuffer (one copy)
 * 4. Module workers behave differently → Safari uses inline worker fallback
 *
 * ## Usage
 *
 * ```ts
 * import { canUseWasm, canUseSharedArrayBuffer, getBrowserCapabilities } from './lib/browser-capabilities';
 *
 * // Quick sync checks (cached after first call)
 * if (canUseWasm()) {
 *   // Use WASM path
 * }
 *
 * // Full async detection (for SIMD probe)
 * const caps = await getBrowserCapabilities();
 * if (caps.wasm.simd) {
 *   // Load SIMD-optimized WASM variant
 * }
 * ```
 *
 * @module browser-capabilities
 * @see phage_explorer-8qk2.7
 */

// ============================================================================
// Types
// ============================================================================

/**
 * WebAssembly feature detection results
 */
export interface WasmCapabilities {
  /** WebAssembly is supported at all */
  supported: boolean;
  /** Streaming compilation via compileStreaming() */
  streaming: boolean;
  /** BigInt support for i64 values */
  bigInt: boolean;
  /** SIMD (v128) instructions supported */
  simd: boolean;
  /** Reason if not supported */
  reason?: string;
}

/**
 * Memory sharing capabilities between threads
 */
export interface MemoryCapabilities {
  /** SharedArrayBuffer is available and usable */
  sharedArrayBuffer: boolean;
  /** Page has cross-origin isolation (required for SAB) */
  crossOriginIsolated: boolean;
  /** Atomics API is available */
  atomics: boolean;
  /** Transferable ArrayBuffer support (always true in modern browsers) */
  transferable: boolean;
}

/**
 * Worker capabilities
 */
export interface WorkerCapabilities {
  /** Web Workers are supported */
  webWorkers: boolean;
  /** Module workers (type: 'module') are supported */
  moduleWorkers: boolean;
}

/**
 * Complete browser capabilities snapshot
 */
export interface BrowserCapabilities {
  wasm: WasmCapabilities;
  memory: MemoryCapabilities;
  workers: WorkerCapabilities;
  /** Timestamp when detection was performed */
  detectedAt: number;
}

// ============================================================================
// Cached State
// ============================================================================

/** Cached sync capabilities (cheap checks) */
let syncCapabilitiesCache: {
  wasm: boolean;
  sharedArrayBuffer: boolean;
  crossOriginIsolated: boolean;
} | null = null;

/** Cached full capabilities (includes async SIMD probe) */
let fullCapabilitiesCache: BrowserCapabilities | null = null;

/** Promise for in-flight async detection (prevents duplicate probes) */
let detectionPromise: Promise<BrowserCapabilities> | null = null;

// ============================================================================
// Sync Detection (fast, cached)
// ============================================================================

/**
 * Check if basic WebAssembly is supported.
 * This is a synchronous check suitable for guards.
 *
 * @returns true if WASM compile/instantiate are available
 */
export function canUseWasm(): boolean {
  if (syncCapabilitiesCache === null) {
    initSyncCache();
  }
  return syncCapabilitiesCache!.wasm;
}

/**
 * Check if SharedArrayBuffer is available and usable.
 * Requires cross-origin isolation (COOP/COEP headers).
 *
 * @returns true if SAB can be constructed
 */
export function canUseSharedArrayBuffer(): boolean {
  if (syncCapabilitiesCache !== null) {
    return syncCapabilitiesCache.sharedArrayBuffer;
  }

  initSyncCache();
  return syncCapabilitiesCache!.sharedArrayBuffer;
}

/**
 * Check if the page has cross-origin isolation.
 * This is required for SharedArrayBuffer and some advanced features.
 *
 * @returns true if crossOriginIsolated is true
 */
export function isCrossOriginIsolated(): boolean {
  if (syncCapabilitiesCache !== null) {
    return syncCapabilitiesCache.crossOriginIsolated;
  }

  initSyncCache();
  return syncCapabilitiesCache!.crossOriginIsolated;
}

/**
 * Initialize the sync capabilities cache.
 * Called lazily on first access.
 */
function initSyncCache(): void {
  if (syncCapabilitiesCache !== null) return;

  // WASM basic check
  const wasmSupported =
    typeof WebAssembly !== 'undefined' &&
    typeof WebAssembly.compile === 'function' &&
    typeof WebAssembly.instantiate === 'function';

  // Cross-origin isolation check
  const coi =
    typeof globalThis !== 'undefined' &&
    'crossOriginIsolated' in globalThis &&
    (globalThis as typeof globalThis & { crossOriginIsolated?: boolean }).crossOriginIsolated ===
      true;

  // SharedArrayBuffer check
  let sabSupported = false;
  try {
    if (typeof SharedArrayBuffer !== 'undefined') {
      // Try to actually construct one - this fails without COOP/COEP
      const test = new SharedArrayBuffer(1);
      sabSupported = test.byteLength === 1;
    }
  } catch {
    // Construction failed (security restriction)
  }

  syncCapabilitiesCache = {
    wasm: wasmSupported,
    sharedArrayBuffer: sabSupported,
    crossOriginIsolated: coi,
  };
}

// ============================================================================
// Async Detection (full feature probe)
// ============================================================================

/**
 * Detect all browser capabilities including async probes (SIMD).
 * Results are cached after first call.
 *
 * Safe to call multiple times - returns cached result or shares in-flight promise.
 *
 * @returns Complete browser capabilities snapshot
 */
export async function getBrowserCapabilities(): Promise<BrowserCapabilities> {
  // Return cached result if available
  if (fullCapabilitiesCache !== null) {
    return fullCapabilitiesCache;
  }

  // Share in-flight detection promise
  if (detectionPromise !== null) {
    return detectionPromise;
  }

  // Start detection
  detectionPromise = detectCapabilities();

  try {
    fullCapabilitiesCache = await detectionPromise;
    return fullCapabilitiesCache;
  } finally {
    detectionPromise = null;
  }
}

/**
 * Perform full capability detection.
 */
async function detectCapabilities(): Promise<BrowserCapabilities> {
  // Ensure sync cache is initialized
  initSyncCache();

  const wasm = await detectWasmCapabilities();
  const memory = detectMemoryCapabilities();
  const workers = detectWorkerCapabilities();

  return {
    wasm,
    memory,
    workers,
    detectedAt: Date.now(),
  };
}

/**
 * Detect WebAssembly capabilities including SIMD.
 */
async function detectWasmCapabilities(): Promise<WasmCapabilities> {
  // Quick fail if basic WASM unavailable
  if (!canUseWasm()) {
    return {
      supported: false,
      streaming: false,
      bigInt: false,
      simd: false,
      reason: 'WebAssembly not available',
    };
  }

  // Verify compilation works with minimal module
  const minimalModule = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  try {
    await WebAssembly.compile(minimalModule);
  } catch (error) {
    return {
      supported: false,
      streaming: false,
      bigInt: false,
      simd: false,
      reason: `WASM compilation failed: ${String(error)}`,
    };
  }

  // Check streaming compilation
  const streaming = typeof WebAssembly.compileStreaming === 'function';

  // Check BigInt support
  const bigInt = typeof BigInt !== 'undefined';

  // Check SIMD support (async - requires compilation test)
  const simd = await detectWasmSimd();

  return {
    supported: true,
    streaming,
    bigInt,
    simd,
  };
}

/**
 * Detect WASM SIMD support by attempting to compile a v128 instruction.
 * This is an async operation that should not block the UI.
 */
async function detectWasmSimd(): Promise<boolean> {
  try {
    // Minimal WASM module with v128 type (SIMD)
    // This module declares a function that returns v128 using v128.const
    const simdModule = new Uint8Array([
      0x00,
      0x61,
      0x73,
      0x6d, // magic number
      0x01,
      0x00,
      0x00,
      0x00, // version 1
      0x01,
      0x05,
      0x01,
      0x60,
      0x00,
      0x01,
      0x7b, // type section: func () -> v128
      0x03,
      0x02,
      0x01,
      0x00, // function section: 1 function of type 0
      0x0a,
      0x0a,
      0x01,
      0x08,
      0x00,
      0xfd,
      0x0c,
      0x00,
      0x00,
      0x00,
      0x00,
      0x0b, // code: v128.const 0
    ]);

    await WebAssembly.compile(simdModule);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect memory sharing capabilities.
 */
function detectMemoryCapabilities(): MemoryCapabilities {
  initSyncCache();

  const atomics = typeof Atomics !== 'undefined' && typeof Atomics.wait === 'function';

  return {
    sharedArrayBuffer: syncCapabilitiesCache!.sharedArrayBuffer,
    crossOriginIsolated: syncCapabilitiesCache!.crossOriginIsolated,
    atomics,
    transferable: true, // Always true in browsers we support
  };
}

/**
 * Detect worker capabilities.
 */
function detectWorkerCapabilities(): WorkerCapabilities {
  const webWorkers = typeof Worker !== 'undefined';

  // Module workers detection
  // There's no reliable sync way to detect module worker support without creating one.
  // We assume module workers are available if:
  // 1. Web Workers are supported
  // 2. Dynamic import() is available (required for module workers)
  // This covers Chrome 80+, Firefox 114+, Safari 15+ which all support module workers.
  let moduleWorkers = false;
  if (webWorkers) {
    // Check for dynamic import support as a proxy for module worker support
    // This is a reasonable heuristic: browsers that support dynamic import()
    // in workers generally support module workers (type: 'module')
    moduleWorkers = typeof import.meta !== 'undefined';
  }

  return {
    webWorkers,
    moduleWorkers,
  };
}

// ============================================================================
// Convenience Functions for Common Patterns
// ============================================================================

/**
 * Check if WASM SIMD is available.
 * This is async because SIMD detection requires compilation.
 *
 * @returns true if SIMD instructions are supported
 */
export async function canUseWasmSimd(): Promise<boolean> {
  const caps = await getBrowserCapabilities();
  return caps.wasm.simd;
}

/**
 * Get the best available memory transport strategy.
 *
 * @returns 'sab' if SharedArrayBuffer available, 'transfer' otherwise
 */
export function getBestMemoryTransport(): 'sab' | 'transfer' {
  return canUseSharedArrayBuffer() ? 'sab' : 'transfer';
}

/**
 * Get a human-readable summary of capabilities (for dev tools / debugging).
 */
export async function getCapabilitiesSummary(): Promise<string> {
  const caps = await getBrowserCapabilities();

  const lines: string[] = [
    '=== Browser Capabilities ===',
    '',
    'WebAssembly:',
    `  Supported: ${caps.wasm.supported}`,
    `  Streaming: ${caps.wasm.streaming}`,
    `  SIMD: ${caps.wasm.simd}`,
    `  BigInt: ${caps.wasm.bigInt}`,
  ];

  if (caps.wasm.reason) {
    lines.push(`  Reason: ${caps.wasm.reason}`);
  }

  lines.push(
    '',
    'Memory:',
    `  SharedArrayBuffer: ${caps.memory.sharedArrayBuffer}`,
    `  Cross-Origin Isolated: ${caps.memory.crossOriginIsolated}`,
    `  Atomics: ${caps.memory.atomics}`,
    `  Transport: ${getBestMemoryTransport()}`,
    '',
    'Workers:',
    `  Web Workers: ${caps.workers.webWorkers}`,
    `  Module Workers: ${caps.workers.moduleWorkers}`
  );

  return lines.join('\n');
}

// ============================================================================
// Policy Helpers (for orchestrator / worker loaders)
// ============================================================================

/**
 * Determine the WASM loading strategy based on capabilities.
 *
 * @returns Strategy to use for loading WASM modules
 */
export async function getWasmLoadingStrategy(): Promise<{
  useWasm: boolean;
  useSimd: boolean;
  useStreaming: boolean;
  fallbackReason?: string;
}> {
  const caps = await getBrowserCapabilities();

  if (!caps.wasm.supported) {
    return {
      useWasm: false,
      useSimd: false,
      useStreaming: false,
      fallbackReason: caps.wasm.reason ?? 'WASM not supported',
    };
  }

  return {
    useWasm: true,
    useSimd: caps.wasm.simd,
    useStreaming: caps.wasm.streaming,
  };
}

/**
 * Determine how to send sequence data to workers.
 *
 * @returns Strategy for sequence transport
 */
export function getSequenceTransportStrategy(): {
  method: 'sab' | 'transfer';
  zeroCopy: boolean;
  description: string;
} {
  if (canUseSharedArrayBuffer()) {
    return {
      method: 'sab',
      zeroCopy: true,
      description: 'SharedArrayBuffer (zero-copy)',
    };
  }

  return {
    method: 'transfer',
    zeroCopy: false,
    description: 'Transferable ArrayBuffer (one copy)',
  };
}

// ============================================================================
// Reset (for testing)
// ============================================================================

/**
 * Reset cached capabilities. For testing only.
 * @internal
 */
export function _resetCapabilitiesCache(): void {
  syncCapabilitiesCache = null;
  fullCapabilitiesCache = null;
  detectionPromise = null;
}

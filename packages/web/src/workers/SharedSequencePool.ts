/**
 * SharedSequencePool - Zero-copy sequence data sharing between threads
 *
 * This pool manages SharedArrayBuffer instances for DNA sequences, enabling
 * workers to access sequence data without copying. When SharedArrayBuffer
 * is unavailable (missing COOP/COEP headers), falls back to regular ArrayBuffers
 * with transfer semantics.
 *
 * Usage:
 *   const pool = SharedSequencePool.getInstance();
 *   const { ref, transfer } = pool.getOrCreateRef(phageId, sequence);
 *   // postMessage/Comlink: pass the ref + transfer list (ArrayBuffer path needs transfer)
 *   worker.postMessage({ sequenceRef: ref }, transfer);
 */

import { canUseSharedArrayBuffer } from '../utils/wasm';
import type { SharedSequenceRef } from './types';

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

export interface SequenceBuffer {
  /** The SharedArrayBuffer (or ArrayBuffer fallback) containing encoded sequence */
  sab: SharedArrayBuffer | ArrayBuffer;
  /** Uint8Array view of the buffer for reading/writing */
  view: Uint8Array;
  /** Original sequence length in characters */
  length: number;
  /** Whether this uses SharedArrayBuffer (true) or fallback ArrayBuffer (false) */
  isShared: boolean;
}

interface PoolEntry {
  buffer: SequenceBuffer;
  /** FNV-1a of the stored sequence; used to refuse a stale genome under the same phageId. */
  fingerprint: number;
  /**
   * Pin count for eviction avoidance.
   *
   * Important: This is NOT incremented by normal accessors. It is only meant
   * for explicit "keep this resident" leases (e.g., current phage, diff ref).
   *
   * Rationale: Many call sites treat get/getOrCreate/getOrCreateRef as idempotent
   * accessors; incrementing here easily causes unbounded growth and defeats
   * eviction heuristics.
   */
  refCount: number;
  lastAccess: number;
}

function sequenceFingerprint(sequence: string): number {
  let hash = 2166136261;
  for (let i = 0; i < sequence.length; i++) {
    hash ^= sequence.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Encode a DNA sequence string to a Uint8Array.
 * Uses ASCII encoding (1 byte per character).
 * This is efficient for DNA sequences which only use A,T,G,C,N characters.
 */
function encodeSequence(sequence: string): Uint8Array {
  if (textEncoder) {
    return textEncoder.encode(sequence);
  }

  // Manual ASCII encoding fallback (older browsers / unusual worker environments).
  const out = new Uint8Array(sequence.length);
  for (let i = 0; i < sequence.length; i++) {
    out[i] = sequence.charCodeAt(i) & 0xff;
  }
  return out;
}

/**
 * Decode a Uint8Array back to a DNA sequence string.
 */
export function decodeSequence(view: Uint8Array, length?: number): string {
  const slice = length !== undefined && length < view.length ? view.subarray(0, length) : view;

  if (textDecoder) {
    // TextDecoder.decode() rejects views over SharedArrayBuffer; copy to a regular buffer first
    const safeBuf =
      typeof SharedArrayBuffer !== 'undefined' && slice.buffer instanceof SharedArrayBuffer ? new Uint8Array(slice) : slice;
    return textDecoder.decode(safeBuf);
  }

  // Manual ASCII decoding fallback.
  const CHUNK = 0x2000;
  let out = '';
  for (let i = 0; i < slice.length; i += CHUNK) {
    const chunk = slice.subarray(i, i + CHUNK);
    out += String.fromCharCode(...chunk);
  }
  return out;
}

/**
 * Pool for managing SharedArrayBuffer instances for sequence data.
 * Singleton pattern - use getInstance() to access.
 */
export class SharedSequencePool {
  private static instance: SharedSequencePool | null = null;

  private pool: Map<number, PoolEntry> = new Map();
  private maxPoolSize: number;
  private sharedAvailable: boolean;

  private constructor(maxPoolSize: number = 50) {
    this.maxPoolSize = maxPoolSize;
    this.sharedAvailable = canUseSharedArrayBuffer();

    if (this.sharedAvailable) {
      if (import.meta.env.DEV) {
        console.log('[SharedSequencePool] SharedArrayBuffer available - zero-copy mode enabled');
      }
    } else if (import.meta.env.DEV) {
      console.warn(
        '[SharedSequencePool] SharedArrayBuffer unavailable - using ArrayBuffer fallback. ' +
          'Ensure COOP/COEP headers are set for optimal performance.'
      );
    }
  }

  /**
   * Get the singleton instance of the pool.
   */
  static getInstance(maxPoolSize?: number): SharedSequencePool {
    if (!SharedSequencePool.instance) {
      SharedSequencePool.instance = new SharedSequencePool(maxPoolSize);
    }
    return SharedSequencePool.instance;
  }

  /**
   * Reset the singleton (mainly for testing).
   */
  static resetInstance(): void {
    if (SharedSequencePool.instance) {
      SharedSequencePool.instance.clear();
      SharedSequencePool.instance = null;
    }
  }

  /**
   * Check if SharedArrayBuffer is being used.
   */
  isUsingSharedMemory(): boolean {
    return this.sharedAvailable;
  }

  /**
   * Get a sequence reference suitable for sending to a worker.
   *
   * - If SharedArrayBuffer is available, returns a zero-copy ref to the pool-owned SAB.
   * - Otherwise, returns a *transferable* ArrayBuffer copy so postMessage/Comlink can avoid
   *   cloning huge strings. The pool keeps its own internal copy for reuse.
   */
  getOrCreateRef(phageId: number, sequence: string): { ref: SharedSequenceRef; transfer: Transferable[] } {
    const buffer = this.getOrCreate(phageId, sequence);
    return this.makeWorkerRef(phageId, buffer);
  }

  /**
   * Get an existing sequence reference suitable for sending to a worker.
   * Returns undefined if the sequence isn't in the pool yet.
   */
  getRef(phageId: number): { ref: SharedSequenceRef; transfer: Transferable[] } | undefined {
    const entry = this.pool.get(phageId);
    if (!entry) return undefined;
    entry.lastAccess = Date.now();
    return this.makeWorkerRef(phageId, entry.buffer);
  }

  private makeWorkerRef(phageId: number, buffer: SequenceBuffer): { ref: SharedSequenceRef; transfer: Transferable[] } {
    if (buffer.isShared) {
      return {
        ref: {
          phageId,
          buffer: buffer.sab,
          byteOffset: 0,
          byteLength: buffer.view.byteLength,
          length: buffer.length,
          encoding: 'ascii',
          isShared: true,
        },
        transfer: [],
      };
    }

    // ArrayBuffer fallback: create a transferable copy (one-shot).
    const copy = new ArrayBuffer(buffer.view.byteLength);
    new Uint8Array(copy).set(buffer.view);

    return {
      ref: {
        phageId,
        buffer: copy,
        byteOffset: 0,
        byteLength: copy.byteLength,
        length: buffer.length,
        encoding: 'ascii',
        isShared: false,
      },
      transfer: [copy],
    };
  }

  /**
   * Get or create a shared buffer for a sequence.
   * If the phageId already has a buffer for the *same* sequence, returns it.
   * A different sequence for the same id replaces the stale entry (overlays can
   * briefly call this with the previous genome while a fetch is in flight).
   *
   * @param phageId - Unique identifier for the phage
   * @param sequence - DNA sequence string
   * @returns SequenceBuffer with the encoded sequence
   */
  getOrCreate(phageId: number, sequence: string): SequenceBuffer {
    const fingerprint = sequenceFingerprint(sequence);
    const existing = this.pool.get(phageId);
    if (existing) {
      if (existing.buffer.length === sequence.length && existing.fingerprint === fingerprint) {
        existing.lastAccess = Date.now();
        return existing.buffer;
      }
      this.pool.delete(phageId);
    }

    // Evict oldest entries if at capacity
    this.evictIfNeeded();

    // Encode sequence
    const encoded = encodeSequence(sequence);

    // Create buffer (shared or fallback)
    let sab: SharedArrayBuffer | ArrayBuffer;
    if (this.sharedAvailable) {
      sab = new SharedArrayBuffer(encoded.byteLength);
    } else {
      sab = new ArrayBuffer(encoded.byteLength);
    }

    // Copy encoded data into the buffer
    const view = new Uint8Array(sab);
    view.set(encoded);

    const buffer: SequenceBuffer = {
      sab,
      view,
      length: sequence.length,
      isShared: this.sharedAvailable,
    };

    this.pool.set(phageId, {
      buffer,
      fingerprint,
      // New entries start unpinned; eviction is guided by lastAccess unless a caller pins.
      refCount: 0,
      lastAccess: Date.now(),
    });

    return buffer;
  }

  /**
   * Get an existing buffer without creating a new one.
   * Returns undefined if no buffer exists for this phageId.
   */
  get(phageId: number): SequenceBuffer | undefined {
    const entry = this.pool.get(phageId);
    if (entry) {
      entry.lastAccess = Date.now();
      return entry.buffer;
    }
    return undefined;
  }

  /**
   * Check if a buffer exists for a phageId.
   */
  has(phageId: number): boolean {
    return this.pool.has(phageId);
  }

  /**
   * Release a reference to a buffer.
   * Buffer is kept in pool for potential reuse until evicted.
   */
  release(phageId: number): void {
    const entry = this.pool.get(phageId);
    if (entry) {
      if (entry.refCount <= 0) {
        if (import.meta.env.DEV) {
          console.warn(`[SharedSequencePool] release(${phageId}) called with refCount=0`);
        }
        entry.refCount = 0;
        return;
      }
      entry.refCount -= 1;
    }
  }

  /**
   * Pin a sequence in the pool to deprioritize eviction.
   * Prefer this for long-lived UI state (current phage, diff reference), not per-job usage.
   */
  pin(phageId: number, sequence?: string): void {
    if (sequence !== undefined) {
      this.getOrCreate(phageId, sequence);
    }
    const entry = this.pool.get(phageId);
    if (!entry) {
      return;
    }
    entry.refCount += 1;
    entry.lastAccess = Date.now();
  }

  /**
   * Forcefully remove a buffer from the pool.
   */
  remove(phageId: number): boolean {
    return this.pool.delete(phageId);
  }

  /**
   * Clear all buffers from the pool.
   */
  clear(): void {
    this.pool.clear();
  }

  /**
   * Get current pool statistics.
   */
  getStats(): {
    size: number;
    maxSize: number;
    totalBytes: number;
    sharedMemory: boolean;
  } {
    let totalBytes = 0;
    for (const entry of this.pool.values()) {
      totalBytes += entry.buffer.sab.byteLength;
    }

    return {
      size: this.pool.size,
      maxSize: this.maxPoolSize,
      totalBytes,
      sharedMemory: this.sharedAvailable,
    };
  }

  /**
   * Evict oldest entries if pool is at capacity.
   * Prioritizes entries with refCount === 0.
   */
  private evictIfNeeded(): void {
    if (this.pool.size < this.maxPoolSize) {
      return;
    }

    // First try to evict unreferenced entries
    const unreferenced: Array<[number, PoolEntry]> = [];
    const referenced: Array<[number, PoolEntry]> = [];

    for (const [id, entry] of this.pool.entries()) {
      if (entry.refCount === 0) {
        unreferenced.push([id, entry]);
      } else {
        referenced.push([id, entry]);
      }
    }

    // Sort by lastAccess (oldest first)
    unreferenced.sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    referenced.sort((a, b) => a[1].lastAccess - b[1].lastAccess);

    // Evict from unreferenced first, then referenced if needed
    const toEvict = [...unreferenced, ...referenced];
    const evictCount = Math.max(1, Math.floor(this.maxPoolSize * 0.1)); // Evict 10%

    for (let i = 0; i < evictCount && i < toEvict.length; i++) {
      this.pool.delete(toEvict[i][0]);
    }
  }

  /**
   * Create a transferable view of a buffer for use with Comlink.
   * For SharedArrayBuffer, returns the buffer directly (no transfer needed).
   * For ArrayBuffer fallback, returns a copy that can be transferred.
   */
  getTransferableData(
    phageId: number
  ): { buffer: SharedArrayBuffer | ArrayBuffer; length: number; isShared: boolean } | undefined {
    const entry = this.pool.get(phageId);
    if (!entry) {
      return undefined;
    }

    entry.lastAccess = Date.now();

    if (entry.buffer.isShared) {
      // SharedArrayBuffer can be shared directly - no transfer needed
      return {
        buffer: entry.buffer.sab,
        length: entry.buffer.length,
        isShared: true,
      };
    } else {
      // For fallback mode, we need to copy for transfer
      // (The actual transfer happens in Comlink)
      const copy = new ArrayBuffer(entry.buffer.sab.byteLength);
      new Uint8Array(copy).set(entry.buffer.view);
      return {
        buffer: copy,
        length: entry.buffer.length,
        isShared: false,
      };
    }
  }
}

/**
 * Helper to create a Uint8Array view from a buffer received from SharedSequencePool.
 * Use this in workers to access the sequence data.
 */
export function createSequenceView(
  buffer: SharedArrayBuffer | ArrayBuffer,
  length: number
): Uint8Array {
  return new Uint8Array(buffer, 0, length);
}

/**
 * Type guard to check if a buffer is SharedArrayBuffer.
 */
export function isSharedBuffer(
  buffer: SharedArrayBuffer | ArrayBuffer
): buffer is SharedArrayBuffer {
  return typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer;
}

export default SharedSequencePool;

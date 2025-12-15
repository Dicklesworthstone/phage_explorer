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
 *   const buffer = pool.getOrCreate(phageId, sequence);
 *   // Pass buffer.sab to workers via Comlink
 *   // Workers can read directly without deserialization
 */

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
  refCount: number;
  lastAccess: number;
}

/**
 * Check if SharedArrayBuffer is available in the current context.
 * Requires COOP/COEP headers to be set on the page.
 */
function isSharedArrayBufferAvailable(): boolean {
  try {
    // Check if SharedArrayBuffer exists and is constructible
    if (typeof SharedArrayBuffer === 'undefined') {
      return false;
    }
    // Try to actually create one - this will fail without proper headers
    const test = new SharedArrayBuffer(1);
    return test.byteLength === 1;
  } catch {
    return false;
  }
}

/**
 * Encode a DNA sequence string to a Uint8Array.
 * Uses ASCII encoding (1 byte per character).
 * This is efficient for DNA sequences which only use A,T,G,C,N characters.
 */
function encodeSequence(sequence: string): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(sequence);
}

/**
 * Decode a Uint8Array back to a DNA sequence string.
 */
export function decodeSequence(view: Uint8Array, length?: number): string {
  const decoder = new TextDecoder();
  if (length !== undefined && length < view.length) {
    return decoder.decode(view.subarray(0, length));
  }
  return decoder.decode(view);
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
    this.sharedAvailable = isSharedArrayBufferAvailable();

    if (this.sharedAvailable) {
      console.log('[SharedSequencePool] SharedArrayBuffer available - zero-copy mode enabled');
    } else {
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
   * Get or create a shared buffer for a sequence.
   * If the phageId already has a buffer, returns the existing one.
   *
   * @param phageId - Unique identifier for the phage
   * @param sequence - DNA sequence string (only used if buffer doesn't exist)
   * @returns SequenceBuffer with the encoded sequence
   */
  getOrCreate(phageId: number, sequence: string): SequenceBuffer {
    const existing = this.pool.get(phageId);
    if (existing) {
      existing.refCount++;
      existing.lastAccess = Date.now();
      return existing.buffer;
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
      refCount: 1,
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
      entry.refCount++;
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
      entry.refCount = Math.max(0, entry.refCount - 1);
    }
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

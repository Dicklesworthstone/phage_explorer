import kmerShader from './kmer.wgsl?raw';
import gcSkewShader from './gc_skew.wgsl?raw';
import searchShader from './search.wgsl?raw';
import entropyShader from './entropy.wgsl?raw';
import repeatsShader from './repeats.wgsl?raw';
import editDistShader from './edit_dist.wgsl?raw';
import dotplotShader from './dotplot.wgsl?raw';

// ============================================================
// Types and Interfaces
// ============================================================

/** Available shader types */
export type ShaderType = 'kmer' | 'gc_skew' | 'search' | 'entropy' | 'repeats' | 'edit_dist' | 'dotplot';

/** Configuration for a compute shader */
interface ShaderConfig {
  code: string;
  entryPoint: string;
  workgroupSize: number;
}

/** Cached pipeline with its bind group layout */
interface CachedPipeline {
  pipeline: GPUComputePipeline;
  bindGroupLayout: GPUBindGroupLayout;
  lastUsed: number;
}

/** Result types for different shaders */
export interface GCSkewResult {
  skew: Float32Array;
  cumulative: Float32Array;
}

export interface SearchResult {
  positions: Uint32Array;
  matchCount: number;
}

export interface EntropyResult {
  entropy: Float32Array;
  complexity: Float32Array;
}

export interface RepeatResult {
  palindromes: Array<{ start: number; end: number; armLength: number }>;
  tandemRepeats: Array<{ start: number; end: number; unit: string; copies: number }>;
}

export interface DotplotResult {
  matches: Array<{ i: number; j: number }>;
  matchCount: number;
}

// ============================================================
// Shader Registry
// ============================================================

const SHADER_REGISTRY: Record<ShaderType, ShaderConfig> = {
  kmer: {
    code: kmerShader,
    entryPoint: 'main',
    workgroupSize: 64,
  },
  gc_skew: {
    code: gcSkewShader,
    entryPoint: 'main',
    workgroupSize: 64,
  },
  search: {
    code: searchShader,
    entryPoint: 'main',
    workgroupSize: 256,
  },
  entropy: {
    code: entropyShader,
    entryPoint: 'main',
    workgroupSize: 64,
  },
  repeats: {
    code: repeatsShader,
    entryPoint: 'main',
    workgroupSize: 128,
  },
  edit_dist: {
    code: editDistShader,
    entryPoint: 'main',
    workgroupSize: 256,
  },
  dotplot: {
    code: dotplotShader,
    entryPoint: 'main',
    workgroupSize: 16, // 16x16 2D workgroup
  },
};

// ============================================================
// GPUCompute Class
// ============================================================

export class GPUCompute {
  private adapter: GPUAdapter | null = null;
  private device: GPUDevice | null = null;
  private supported: boolean = false;
  private initPromise: Promise<void>;
  private initComplete: boolean = false;

  // Pipeline cache for shader reuse
  private pipelineCache: Map<ShaderType, CachedPipeline> = new Map();
  private readonly PIPELINE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor() {
    this.initPromise = this.checkSupport();
  }

  private async checkSupport(): Promise<void> {
    try {
      if (!navigator.gpu) return;
      this.adapter = await navigator.gpu.requestAdapter();
      if (!this.adapter) return;
      this.device = await this.adapter.requestDevice();
      this.supported = true;
    } catch (e) {
      console.warn('WebGPU init failed', e);
    } finally {
      this.initComplete = true;
    }
  }

  /** Wait for GPU initialization to complete */
  async ready(): Promise<boolean> {
    await this.initPromise;
    return this.supported;
  }

  get isSupported() {
    return this.supported;
  }

  /** Check if initialization has completed (sync check) */
  get isInitialized() {
    return this.initComplete;
  }

  /** Get the GPU device (for advanced usage) */
  getDevice(): GPUDevice | null {
    return this.device;
  }

  // ============================================================
  // Pipeline Management
  // ============================================================

  /**
   * Get or create a cached pipeline for a shader type.
   */
  private async getOrCreatePipeline(shaderType: ShaderType): Promise<CachedPipeline | null> {
    if (!this.device) return null;

    // Check cache
    const cached = this.pipelineCache.get(shaderType);
    if (cached) {
      cached.lastUsed = Date.now();
      return cached;
    }

    // Create new pipeline
    const config = SHADER_REGISTRY[shaderType];
    if (!config) {
      console.warn(`Unknown shader type: ${shaderType}`);
      return null;
    }

    try {
      const module = this.device.createShaderModule({ code: config.code });
      const pipeline = this.device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint: config.entryPoint },
      });

      const bindGroupLayout = pipeline.getBindGroupLayout(0);

      const cachedPipeline: CachedPipeline = {
        pipeline,
        bindGroupLayout,
        lastUsed: Date.now(),
      };

      this.pipelineCache.set(shaderType, cachedPipeline);
      return cachedPipeline;
    } catch (e) {
      console.warn(`Failed to create pipeline for ${shaderType}:`, e);
      return null;
    }
  }

  /**
   * Clean up old pipelines from cache.
   */
  cleanupPipelineCache(): void {
    const now = Date.now();
    for (const [type, cached] of this.pipelineCache.entries()) {
      if (now - cached.lastUsed > this.PIPELINE_CACHE_TTL) {
        this.pipelineCache.delete(type);
      }
    }
  }

  /**
   * Check if a specific shader is available.
   */
  hasShader(shaderType: ShaderType): boolean {
    return shaderType in SHADER_REGISTRY;
  }

  /**
   * Get list of available shader types.
   */
  getAvailableShaders(): ShaderType[] {
    return Object.keys(SHADER_REGISTRY) as ShaderType[];
  }

  // ============================================================
  // Helper Methods
  // ============================================================

  /**
   * Encode a DNA sequence to a Uint32Array (one base per u32).
   * A=0, C=1, G=2, T=3, N=4
   */
  encodeSequence(sequence: string): Uint32Array {
    const mapped = new Uint32Array(sequence.length);
    for (let i = 0; i < sequence.length; i++) {
      const char = sequence[i].toUpperCase();
      mapped[i] = char === 'A' ? 0 : char === 'C' ? 1 : char === 'G' ? 2 : char === 'T' ? 3 : 4;
    }
    return mapped;
  }

  /**
   * Create a GPU buffer with data.
   */
  createBuffer(
    data: ArrayBuffer | ArrayBufferView,
    usage: GPUBufferUsageFlags
  ): GPUBuffer | null {
    if (!this.device) return null;

    const buffer = this.device.createBuffer({
      size: data.byteLength,
      usage: usage | GPUBufferUsage.COPY_DST,
    });

    // Cast to satisfy stricter TypeScript WebGPU types (Uint32Array generic variance)
    this.device.queue.writeBuffer(buffer, 0, data as BufferSource);
    return buffer;
  }

  /**
   * Read data back from a GPU buffer.
   */
  async readBuffer<T extends ArrayBufferView>(
    buffer: GPUBuffer,
    size: number,
    ArrayType: new (buffer: ArrayBuffer) => T
  ): Promise<T> {
    if (!this.device) throw new Error('Device not initialized');

    const readBuffer = this.device.createBuffer({
      size,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    const commandEncoder = this.device.createCommandEncoder();
    commandEncoder.copyBufferToBuffer(buffer, 0, readBuffer, 0, size);
    this.device.queue.submit([commandEncoder.finish()]);

    await readBuffer.mapAsync(GPUMapMode.READ);
    const result = new ArrayType(readBuffer.getMappedRange().slice(0));
    readBuffer.unmap();
    readBuffer.destroy();

    return result;
  }

  async countKmers(sequence: string, k: number): Promise<Map<string, number> | null> {
    // Wait for initialization if not complete
    if (!this.initComplete) {
      await this.initPromise;
    }
    if (!this.supported || !this.device) return null;

    const device = this.device;

    // Track buffers for cleanup on error
    let seqBuffer: GPUBuffer | null = null;
    let countBuffer: GPUBuffer | null = null;
    let uniformBuffer: GPUBuffer | null = null;
    let readBuffer: GPUBuffer | null = null;

    try {
      // 1. Preprocess sequence to u32 array (0=A, 1=C, 2=G, 3=T, 4=N)
      const mappedSeq = new Uint32Array(sequence.length);
      for (let i = 0; i < sequence.length; i++) {
        const char = sequence[i].toUpperCase();
        mappedSeq[i] = char === 'A' ? 0 : char === 'C' ? 1 : char === 'G' ? 2 : char === 'T' ? 3 : 4;
      }

      const seqBufferSize = mappedSeq.byteLength;
      const countsSize = Math.pow(4, k) * 4; // 4 bytes per count

      // 2. Create buffers
      seqBuffer = device.createBuffer({
        size: seqBufferSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });

      countBuffer = device.createBuffer({
        size: countsSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      });

      const uniformBufferSize = 8; // 2 u32s
      uniformBuffer = device.createBuffer({
        size: uniformBufferSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      // 3. Upload data
      device.queue.writeBuffer(seqBuffer, 0, mappedSeq as BufferSource);
      device.queue.writeBuffer(uniformBuffer, 0, new Uint32Array([sequence.length, k]) as BufferSource);
      device.queue.writeBuffer(countBuffer, 0, new Uint32Array(Math.pow(4, k)) as BufferSource);

      // 4. Pipeline setup
      const module = device.createShaderModule({ code: kmerShader });
      const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint: 'main' },
      });

      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: seqBuffer } },
          { binding: 1, resource: { buffer: countBuffer } },
          { binding: 2, resource: { buffer: uniformBuffer } },
        ],
      });

      // 5. Dispatch
      const commandEncoder = device.createCommandEncoder();
      const pass = commandEncoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      const workgroupSize = 64;
      const dispatchCount = Math.ceil(sequence.length / workgroupSize);
      pass.dispatchWorkgroups(dispatchCount);
      pass.end();

      // 6. Read back
      readBuffer = device.createBuffer({
        size: countsSize,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
      commandEncoder.copyBufferToBuffer(countBuffer, 0, readBuffer, 0, countsSize);

      device.queue.submit([commandEncoder.finish()]);

      await readBuffer.mapAsync(GPUMapMode.READ);
      const resultArray = new Uint32Array(readBuffer.getMappedRange());

      // 7. Convert back to map
      const results = new Map<string, number>();
      const bases = ['A', 'C', 'G', 'T'];

      const indexToKmer = (idx: number, len: number): string => {
        let s = '';
        for (let i = 0; i < len; i++) {
          s = bases[idx & 3] + s;
          idx >>= 2;
        }
        return s;
      };

      for (let i = 0; i < resultArray.length; i++) {
        if (resultArray[i] > 0) {
          results.set(indexToKmer(i, k), resultArray[i]);
        }
      }

      readBuffer.unmap();
      return results;
    } catch (e) {
      console.warn('GPU k-mer computation failed:', e);
      return null;
    } finally {
      // Cleanup GPU buffers regardless of success/failure
      seqBuffer?.destroy();
      countBuffer?.destroy();
      uniformBuffer?.destroy();
      readBuffer?.destroy();
    }
  }

  // ============================================================
  // GC Skew Computation
  // ============================================================

  /**
   * Compute GC skew using GPU acceleration.
   * GC skew = (G - C) / (G + C) for each window.
   *
   * @param sequence - DNA sequence string
   * @param windowSize - Size of sliding window
   * @param stepSize - Step between windows (default: 1)
   * @returns GCSkewResult with skew and cumulative arrays, or null if GPU unavailable
   */
  async computeGCSkew(
    sequence: string,
    windowSize: number,
    stepSize: number = 1
  ): Promise<GCSkewResult | null> {
    if (!this.initComplete) await this.initPromise;
    if (!this.supported || !this.device) return null;

    const device = this.device;
    const cachedPipeline = await this.getOrCreatePipeline('gc_skew');
    if (!cachedPipeline) return null;

    const numWindows = Math.floor((sequence.length - windowSize) / stepSize) + 1;
    if (numWindows <= 0) return null;

    // Buffers for cleanup
    let seqBuffer: GPUBuffer | null = null;
    let skewBuffer: GPUBuffer | null = null;
    let cumulativeBuffer: GPUBuffer | null = null;
    let uniformBuffer: GPUBuffer | null = null;

    try {
      // Encode sequence
      const encodedSeq = this.encodeSequence(sequence);

      // Create buffers
      seqBuffer = device.createBuffer({
        size: encodedSeq.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });

      skewBuffer = device.createBuffer({
        size: numWindows * 4, // f32 per window
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });

      cumulativeBuffer = device.createBuffer({
        size: numWindows * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });

      // Uniforms: [seqLength, windowSize, stepSize, numWindows]
      uniformBuffer = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      device.queue.writeBuffer(seqBuffer, 0, encodedSeq as BufferSource);
      device.queue.writeBuffer(
        uniformBuffer,
        0,
        new Uint32Array([sequence.length, windowSize, stepSize, numWindows]) as BufferSource
      );

      // Create bind group
      const bindGroup = device.createBindGroup({
        layout: cachedPipeline.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: seqBuffer } },
          { binding: 1, resource: { buffer: skewBuffer } },
          { binding: 2, resource: { buffer: cumulativeBuffer } },
          { binding: 3, resource: { buffer: uniformBuffer } },
        ],
      });

      // Dispatch
      const commandEncoder = device.createCommandEncoder();
      const pass = commandEncoder.beginComputePass();
      pass.setPipeline(cachedPipeline.pipeline);
      pass.setBindGroup(0, bindGroup);
      const workgroupSize = SHADER_REGISTRY.gc_skew.workgroupSize;
      pass.dispatchWorkgroups(Math.ceil(numWindows / workgroupSize));
      pass.end();

      device.queue.submit([commandEncoder.finish()]);

      // Read results - only read skew buffer since shader writes same values to both
      // (cumulativeBuffer is needed for shader binding but contains identical data)
      const skew = await this.readBuffer(skewBuffer, numWindows * 4, Float32Array);

      // Compute prefix sum on CPU to get true cumulative skew
      // GPU computed per-window values; we need running total for origin detection
      const cumulative = new Float32Array(skew.length);
      let runningSum = 0;
      for (let i = 0; i < skew.length; i++) {
        runningSum += skew[i];
        cumulative[i] = runningSum;
      }

      return { skew, cumulative };
    } catch (e) {
      console.warn('GPU GC skew computation failed:', e);
      return null;
    } finally {
      seqBuffer?.destroy();
      skewBuffer?.destroy();
      cumulativeBuffer?.destroy();
      uniformBuffer?.destroy();
    }
  }

  // ============================================================
  // Motif Search
  // ============================================================

  /**
   * Search for a motif pattern in the sequence using GPU parallelism.
   *
   * @param sequence - DNA sequence to search
   * @param pattern - Pattern to search for (supports IUPAC codes)
   * @param maxMismatches - Maximum allowed mismatches (default: 0)
   * @returns SearchResult with positions array and match count, or null if GPU unavailable
   */
  async searchMotifs(
    sequence: string,
    pattern: string,
    maxMismatches: number = 0
  ): Promise<SearchResult | null> {
    if (!this.initComplete) await this.initPromise;
    if (!this.supported || !this.device) return null;

    const device = this.device;
    const cachedPipeline = await this.getOrCreatePipeline('search');
    if (!cachedPipeline) return null;

    const maxPositions = sequence.length - pattern.length + 1;
    if (maxPositions <= 0) return null;

    let seqBuffer: GPUBuffer | null = null;
    let patternBuffer: GPUBuffer | null = null;
    let matchBuffer: GPUBuffer | null = null;
    let countBuffer: GPUBuffer | null = null;
    let uniformBuffer: GPUBuffer | null = null;

    try {
      const encodedSeq = this.encodeSequence(sequence);
      const encodedPattern = this.encodeSequence(pattern);

      seqBuffer = device.createBuffer({
        size: encodedSeq.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });

      patternBuffer = device.createBuffer({
        size: encodedPattern.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });

      // Match positions buffer (worst case: every position matches)
      matchBuffer = device.createBuffer({
        size: maxPositions * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });

      // Atomic counter for matches
      countBuffer = device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      });

      // Uniforms: [seqLength, patternLength, maxMismatches, maxPositions]
      uniformBuffer = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      device.queue.writeBuffer(seqBuffer, 0, encodedSeq as BufferSource);
      device.queue.writeBuffer(patternBuffer, 0, encodedPattern as BufferSource);
      device.queue.writeBuffer(countBuffer, 0, new Uint32Array([0]) as BufferSource);
      device.queue.writeBuffer(
        uniformBuffer,
        0,
        new Uint32Array([sequence.length, pattern.length, maxMismatches, maxPositions]) as BufferSource
      );

      const bindGroup = device.createBindGroup({
        layout: cachedPipeline.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: seqBuffer } },
          { binding: 1, resource: { buffer: patternBuffer } },
          { binding: 2, resource: { buffer: matchBuffer } },
          { binding: 3, resource: { buffer: countBuffer } },
          { binding: 4, resource: { buffer: uniformBuffer } },
        ],
      });

      const commandEncoder = device.createCommandEncoder();
      const pass = commandEncoder.beginComputePass();
      pass.setPipeline(cachedPipeline.pipeline);
      pass.setBindGroup(0, bindGroup);
      const workgroupSize = SHADER_REGISTRY.search.workgroupSize;
      pass.dispatchWorkgroups(Math.ceil(maxPositions / workgroupSize));
      pass.end();

      device.queue.submit([commandEncoder.finish()]);

      const countResult = await this.readBuffer(countBuffer, 4, Uint32Array);
      const matchCount = countResult[0];

      // Only read as many positions as we found
      const positions = await this.readBuffer(
        matchBuffer,
        Math.min(matchCount, maxPositions) * 4,
        Uint32Array
      );

      return { positions: positions.slice(0, matchCount), matchCount };
    } catch (e) {
      console.warn('GPU motif search failed:', e);
      return null;
    } finally {
      seqBuffer?.destroy();
      patternBuffer?.destroy();
      matchBuffer?.destroy();
      countBuffer?.destroy();
      uniformBuffer?.destroy();
    }
  }

  // ============================================================
  // Entropy Computation
  // ============================================================

  /**
   * Compute Shannon entropy in sliding windows using GPU.
   *
   * @param sequence - DNA sequence string
   * @param windowSize - Size of sliding window
   * @param kmerSize - K-mer size for entropy calculation (default: 4)
   * @returns EntropyResult with entropy and complexity arrays
   */
  async computeEntropy(
    sequence: string,
    windowSize: number,
    kmerSize: number = 4
  ): Promise<EntropyResult | null> {
    if (!this.initComplete) await this.initPromise;
    if (!this.supported || !this.device) return null;

    const device = this.device;
    const cachedPipeline = await this.getOrCreatePipeline('entropy');
    if (!cachedPipeline) return null;

    const numWindows = sequence.length - windowSize + 1;
    if (numWindows <= 0) return null;

    let seqBuffer: GPUBuffer | null = null;
    let entropyBuffer: GPUBuffer | null = null;
    let complexityBuffer: GPUBuffer | null = null;
    let uniformBuffer: GPUBuffer | null = null;

    try {
      const encodedSeq = this.encodeSequence(sequence);

      seqBuffer = device.createBuffer({
        size: encodedSeq.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });

      entropyBuffer = device.createBuffer({
        size: numWindows * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });

      complexityBuffer = device.createBuffer({
        size: numWindows * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });

      // Uniforms: [seqLength, windowSize, kmerSize, numWindows]
      uniformBuffer = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      device.queue.writeBuffer(seqBuffer, 0, encodedSeq as BufferSource);
      device.queue.writeBuffer(
        uniformBuffer,
        0,
        new Uint32Array([sequence.length, windowSize, kmerSize, numWindows]) as BufferSource
      );

      const bindGroup = device.createBindGroup({
        layout: cachedPipeline.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: seqBuffer } },
          { binding: 1, resource: { buffer: entropyBuffer } },
          { binding: 2, resource: { buffer: complexityBuffer } },
          { binding: 3, resource: { buffer: uniformBuffer } },
        ],
      });

      const commandEncoder = device.createCommandEncoder();
      const pass = commandEncoder.beginComputePass();
      pass.setPipeline(cachedPipeline.pipeline);
      pass.setBindGroup(0, bindGroup);
      const workgroupSize = SHADER_REGISTRY.entropy.workgroupSize;
      pass.dispatchWorkgroups(Math.ceil(numWindows / workgroupSize));
      pass.end();

      device.queue.submit([commandEncoder.finish()]);

      const entropy = await this.readBuffer(entropyBuffer, numWindows * 4, Float32Array);
      const complexity = await this.readBuffer(complexityBuffer, numWindows * 4, Float32Array);

      return { entropy, complexity };
    } catch (e) {
      console.warn('GPU entropy computation failed:', e);
      return null;
    } finally {
      seqBuffer?.destroy();
      entropyBuffer?.destroy();
      complexityBuffer?.destroy();
      uniformBuffer?.destroy();
    }
  }

  // ============================================================
  // Repeat Detection
  // ============================================================

  /**
   * Detect palindromic sequences using GPU parallelism.
   *
   * @param sequence - DNA sequence string
   * @param minArmLength - Minimum length of palindrome arm (default: 4)
   * @param maxGap - Maximum gap between palindrome arms (default: 20)
   * @returns RepeatResult with detected palindromes and tandem repeats
   */
  async detectRepeats(
    sequence: string,
    minArmLength: number = 4,
    maxGap: number = 20
  ): Promise<RepeatResult | null> {
    if (!this.initComplete) await this.initPromise;
    if (!this.supported || !this.device) return null;

    const device = this.device;
    const cachedPipeline = await this.getOrCreatePipeline('repeats');
    if (!cachedPipeline) return null;

    // Estimate max number of repeats (heuristic: 1 per 100bp)
    const maxRepeats = Math.ceil(sequence.length / 100) * 2;

    let seqBuffer: GPUBuffer | null = null;
    let palindromeBuffer: GPUBuffer | null = null;
    let countBuffer: GPUBuffer | null = null;
    let uniformBuffer: GPUBuffer | null = null;

    try {
      const encodedSeq = this.encodeSequence(sequence);

      seqBuffer = device.createBuffer({
        size: encodedSeq.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });

      // Each palindrome record: [start, end, armLength] = 12 bytes
      palindromeBuffer = device.createBuffer({
        size: maxRepeats * 12,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });

      countBuffer = device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      });

      // Uniforms: [seqLength, minArmLength, maxGap, maxRepeats]
      uniformBuffer = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      device.queue.writeBuffer(seqBuffer, 0, encodedSeq as BufferSource);
      device.queue.writeBuffer(countBuffer, 0, new Uint32Array([0]) as BufferSource);
      device.queue.writeBuffer(
        uniformBuffer,
        0,
        new Uint32Array([sequence.length, minArmLength, maxGap, maxRepeats]) as BufferSource
      );

      const bindGroup = device.createBindGroup({
        layout: cachedPipeline.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: seqBuffer } },
          { binding: 1, resource: { buffer: palindromeBuffer } },
          { binding: 2, resource: { buffer: countBuffer } },
          { binding: 3, resource: { buffer: uniformBuffer } },
        ],
      });

      const commandEncoder = device.createCommandEncoder();
      const pass = commandEncoder.beginComputePass();
      pass.setPipeline(cachedPipeline.pipeline);
      pass.setBindGroup(0, bindGroup);
      const workgroupSize = SHADER_REGISTRY.repeats.workgroupSize;
      pass.dispatchWorkgroups(Math.ceil(sequence.length / workgroupSize));
      pass.end();

      device.queue.submit([commandEncoder.finish()]);

      const countResult = await this.readBuffer(countBuffer, 4, Uint32Array);
      const count = Math.min(countResult[0], maxRepeats);

      const palindromeData = await this.readBuffer(
        palindromeBuffer,
        count * 12,
        Uint32Array
      );

      // Parse palindrome results
      const palindromes: Array<{ start: number; end: number; armLength: number }> = [];
      for (let i = 0; i < count; i++) {
        palindromes.push({
          start: palindromeData[i * 3],
          end: palindromeData[i * 3 + 1],
          armLength: palindromeData[i * 3 + 2],
        });
      }

      // Tandem repeats would need a separate shader pass
      // For now, return empty array (can be added later)
      return {
        palindromes,
        tandemRepeats: [],
      };
    } catch (e) {
      console.warn('GPU repeat detection failed:', e);
      return null;
    } finally {
      seqBuffer?.destroy();
      palindromeBuffer?.destroy();
      countBuffer?.destroy();
      uniformBuffer?.destroy();
    }
  }

  // ============================================================
  // Dot Plot (Self-Similarity Matrix)
  // ============================================================

  /**
   * Compute a self-similarity dot plot using k-mer matching.
   * Returns matching positions where k-mers at (i, j) are identical.
   *
   * @param sequence - DNA sequence string
   * @param kmerSize - Size of k-mers to match (default: 11)
   * @param maxMatches - Maximum matches to record (default: 100000)
   * @returns DotplotResult with matching positions
   */
  async computeDotplot(
    sequence: string,
    kmerSize: number = 11,
    maxMatches: number = 100000
  ): Promise<DotplotResult | null> {
    if (!this.initComplete) await this.initPromise;
    if (!this.supported || !this.device) return null;

    const device = this.device;
    const cachedPipeline = await this.getOrCreatePipeline('dotplot');
    if (!cachedPipeline) return null;

    const numKmers = sequence.length - kmerSize + 1;
    if (numKmers <= 0) return null;

    let seqBuffer: GPUBuffer | null = null;
    let matchBuffer: GPUBuffer | null = null;
    let countBuffer: GPUBuffer | null = null;
    let uniformBuffer: GPUBuffer | null = null;

    try {
      const encodedSeq = this.encodeSequence(sequence);

      seqBuffer = device.createBuffer({
        size: encodedSeq.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });

      // Each match is packed as u32: (i << 16) | j
      matchBuffer = device.createBuffer({
        size: maxMatches * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });

      countBuffer = device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      });

      // Uniforms: [seqLength, kmerSize, maxMatches, startRow]
      uniformBuffer = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      device.queue.writeBuffer(seqBuffer, 0, encodedSeq as BufferSource);
      device.queue.writeBuffer(countBuffer, 0, new Uint32Array([0]) as BufferSource);

      // Process in tiles for large sequences
      const tileSize = 4096;
      const allMatches: Array<{ i: number; j: number }> = [];
      let totalMatchCount = 0;

      for (let startRow = 0; startRow < numKmers; startRow += tileSize) {
        device.queue.writeBuffer(
          uniformBuffer,
          0,
          new Uint32Array([sequence.length, kmerSize, maxMatches, startRow]) as BufferSource
        );

        // Reset counter for each tile
        device.queue.writeBuffer(countBuffer, 0, new Uint32Array([0]) as BufferSource);

        const bindGroup = device.createBindGroup({
          layout: cachedPipeline.bindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: seqBuffer } },
            { binding: 1, resource: { buffer: matchBuffer } },
            { binding: 2, resource: { buffer: countBuffer } },
            { binding: 3, resource: { buffer: uniformBuffer } },
          ],
        });

        const commandEncoder = device.createCommandEncoder();
        const pass = commandEncoder.beginComputePass();
        pass.setPipeline(cachedPipeline.pipeline);
        pass.setBindGroup(0, bindGroup);

        // 2D dispatch for dot plot
        const workgroupSize = SHADER_REGISTRY.dotplot.workgroupSize;
        const rowsThisTile = Math.min(tileSize, numKmers - startRow);
        pass.dispatchWorkgroups(
          Math.ceil(rowsThisTile / workgroupSize),
          Math.ceil(numKmers / workgroupSize)
        );
        pass.end();

        device.queue.submit([commandEncoder.finish()]);

        const countResult = await this.readBuffer(countBuffer, 4, Uint32Array);
        const count = Math.min(countResult[0], maxMatches);
        totalMatchCount += count;

        if (count > 0) {
          const matchData = await this.readBuffer(matchBuffer, count * 4, Uint32Array);

          // Unpack matches
          for (let m = 0; m < count; m++) {
            const packed = matchData[m];
            allMatches.push({
              i: packed >>> 16,
              j: packed & 0xffff,
            });
          }
        }

        // Stop if we've collected enough matches
        if (allMatches.length >= maxMatches) break;
      }

      return {
        matches: allMatches.slice(0, maxMatches),
        matchCount: totalMatchCount,
      };
    } catch (e) {
      console.warn('GPU dotplot computation failed:', e);
      return null;
    } finally {
      seqBuffer?.destroy();
      matchBuffer?.destroy();
      countBuffer?.destroy();
      uniformBuffer?.destroy();
    }
  }

  // ============================================================
  // Edit Distance (Wavefront)
  // ============================================================

  /**
   * Compute edit distance between two sequences using wavefront parallelization.
   * Note: This is iterative - dispatches O(m+n) waves, each wave computed in parallel.
   *
   * @param seqA - First DNA sequence
   * @param seqB - Second DNA sequence
   * @returns Edit distance value, or null if GPU unavailable
   */
  async computeEditDistance(seqA: string, seqB: string): Promise<number | null> {
    if (!this.initComplete) await this.initPromise;
    if (!this.supported || !this.device) return null;

    const device = this.device;
    const cachedPipeline = await this.getOrCreatePipeline('edit_dist');
    if (!cachedPipeline) return null;

    const lenA = seqA.length;
    const lenB = seqB.length;

    // For very short sequences, CPU is faster
    if (lenA < 100 || lenB < 100) return null;

    let seqABuffer: GPUBuffer | null = null;
    let seqBBuffer: GPUBuffer | null = null;
    const dpBuffers: GPUBuffer[] = [];
    let uniformBuffer: GPUBuffer | null = null;

    try {
      const encodedA = this.encodeSequence(seqA);
      const encodedB = this.encodeSequence(seqB);

      seqABuffer = device.createBuffer({
        size: encodedA.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });

      seqBBuffer = device.createBuffer({
        size: encodedB.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });

      // DP buffers - need 3 buffers for wavefront algorithm
      // Size is max diagonal length: min(lenA, lenB) + 1
      const maxDiagLen = Math.min(lenA, lenB) + 2; // +2 for safety margin
      const dpSize = maxDiagLen * 4;

      // Create 3 rotating buffers
      for (let i = 0; i < 3; i++) {
        dpBuffers.push(device.createBuffer({
          size: dpSize,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        }));
      }

      // Uniform buffer: 6 u32s [lenA, lenB, diagonal, offset, offsetPrev1, offsetPrev2]
      uniformBuffer = device.createBuffer({
        size: 24,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      device.queue.writeBuffer(seqABuffer, 0, encodedA as BufferSource);
      device.queue.writeBuffer(seqBBuffer, 0, encodedB as BufferSource);

      // Helper to compute diagonal offset (starting i index)
      const getDiagonalOffset = (d: number): number => Math.max(0, d - lenB);

      // Process each anti-diagonal
      const numDiagonals = lenA + lenB + 1;

      // Track which buffer is which (rotating indices)
      let bufferIndices = [0, 1, 2]; // [prev2, prev1, curr]

      for (let d = 0; d < numDiagonals; d++) {
        // Compute diagonal range
        const offset = getDiagonalOffset(d);
        const iEnd = Math.min(d, lenA);
        const diagLen = iEnd - offset + 1;

        if (diagLen <= 0) continue;

        // Get offsets for previous diagonals
        const offsetPrev1 = d >= 1 ? getDiagonalOffset(d - 1) : 0;
        const offsetPrev2 = d >= 2 ? getDiagonalOffset(d - 2) : 0;

        // Update uniforms: [lenA, lenB, diagonal, offset, offsetPrev1, offsetPrev2]
        device.queue.writeBuffer(
          uniformBuffer,
          0,
          new Uint32Array([lenA, lenB, d, offset, offsetPrev1, offsetPrev2])
        );

        const bindGroup = device.createBindGroup({
          layout: cachedPipeline.bindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: seqABuffer } },
            { binding: 1, resource: { buffer: seqBBuffer } },
            { binding: 2, resource: { buffer: dpBuffers[bufferIndices[0]] } }, // dpPrev2
            { binding: 3, resource: { buffer: dpBuffers[bufferIndices[1]] } }, // dpPrev1
            { binding: 4, resource: { buffer: dpBuffers[bufferIndices[2]] } }, // dpCurr
            { binding: 5, resource: { buffer: uniformBuffer } },
          ],
        });

        const commandEncoder = device.createCommandEncoder();
        const pass = commandEncoder.beginComputePass();
        pass.setPipeline(cachedPipeline.pipeline);
        pass.setBindGroup(0, bindGroup);
        const workgroupSize = SHADER_REGISTRY.edit_dist.workgroupSize;
        pass.dispatchWorkgroups(Math.ceil(diagLen / workgroupSize));
        pass.end();

        device.queue.submit([commandEncoder.finish()]);

        // Rotate buffer indices: prev2 <- prev1 <- curr <- prev2
        bufferIndices = [bufferIndices[1], bufferIndices[2], bufferIndices[0]];
      }

      // The final result is at position 0 of the last computed buffer
      // After rotation, bufferIndices[1] was the last 'curr' buffer
      const resultBuffer = dpBuffers[bufferIndices[1]];
      const result = await this.readBuffer(resultBuffer, 4, Uint32Array);

      return result[0];
    } catch (e) {
      console.warn('GPU edit distance computation failed:', e);
      return null;
    } finally {
      seqABuffer?.destroy();
      seqBBuffer?.destroy();
      dpBuffers.forEach(b => b.destroy());
      uniformBuffer?.destroy();
    }
  }

  // ============================================================
  // Cleanup
  // ============================================================

  /**
   * Dispose of GPU resources.
   */
  dispose(): void {
    this.pipelineCache.clear();
    this.device?.destroy();
    this.device = null;
    this.adapter = null;
    this.supported = false;
  }
}

export const gpuCompute = new GPUCompute();

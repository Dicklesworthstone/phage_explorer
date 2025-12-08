import kmerShader from './kmer.wgsl?raw';

export class GPUCompute {
  private adapter: GPUAdapter | null = null;
  private device: GPUDevice | null = null;
  private supported: boolean = false;

  constructor() {
    this.checkSupport();
  }

  private async checkSupport() {
    if (!navigator.gpu) return;
    try {
      this.adapter = await navigator.gpu.requestAdapter();
      if (!this.adapter) return;
      this.device = await this.adapter.requestDevice();
      this.supported = true;
    } catch (e) {
      console.warn('WebGPU init failed', e);
    }
  }

  get isSupported() {
    return this.supported;
  }

  async countKmers(sequence: string, k: number): Promise<Map<string, number> | null> {
    if (!this.supported || !this.device) return null;

    const device = this.device;

    // 1. Preprocess sequence to u32 array (0=A, 1=C, 2=G, 3=T, 4=N)
    // We use 1 u32 per base for simplicity in shader
    const mappedSeq = new Uint32Array(sequence.length);
    for (let i = 0; i < sequence.length; i++) {
      const char = sequence[i].toUpperCase();
      mappedSeq[i] = char === 'A' ? 0 : char === 'C' ? 1 : char === 'G' ? 2 : char === 'T' ? 3 : 4;
    }

    const seqBufferSize = mappedSeq.byteLength;
    const countsSize = Math.pow(4, k) * 4; // 4 bytes per count

    // 2. Create buffers
    const seqBuffer = device.createBuffer({
      size: seqBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    
    const countBuffer = device.createBuffer({
      size: countsSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });

    const uniformBufferSize = 8; // 2 u32s
    const uniformBuffer = device.createBuffer({
      size: uniformBufferSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // 3. Upload data
    device.queue.writeBuffer(seqBuffer, 0, mappedSeq);
    device.queue.writeBuffer(uniformBuffer, 0, new Uint32Array([sequence.length, k]));
    // Clear counts (optional if we trust COPY_DST, but safer)
    device.queue.writeBuffer(countBuffer, 0, new Uint32Array(Math.pow(4, k)));

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
    const readBuffer = device.createBuffer({
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
    
    // Helper to decode index to kmer string
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
    
    // Cleanup
    seqBuffer.destroy();
    countBuffer.destroy();
    uniformBuffer.destroy();
    readBuffer.destroy();

    return results;
  }
}

export const gpuCompute = new GPUCompute();

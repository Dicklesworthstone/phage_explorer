import { describe, expect, it } from 'bun:test';
import { createDemoEnvironmentalDataset, type EnvironmentalDataset } from '../../../core/src/analysis/environmental-evidence';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { EnvironmentalSession, readEnvironmentalFile, type EnvironmentalWorker } from './EnvironmentalSession';
import { executeEnvironmentalRequest, type EnvironmentalRequest, type EnvironmentalWorkerMessage } from './environmental-runtime';

function fixture(): EnvironmentalDataset {
  return {
    format: 'phage-explorer-environmental', version: 1, name: 'Local river observations',
    query: { id: 'taxon-A', label: 'Explicitly assayed taxon A', accession: null },
    source: { kind: 'local', study: 'Independent hand-calculated fixture', reference: null, version: '1', license: 'CC0' },
    measurement: { type: 'counts', method: 'Declared sample counts', normalization: 'Raw counts; no division by sample depth' },
    samples: [
      { id: 's1', accession: null, biome: 'freshwater', country: null,
        location: { latitude: 10, longitude: 20, uncertaintyKm: 4 }, collectionDate: '2024-02', occurrence: 'detected', abundance: 8 },
      { id: 's2', accession: null, biome: 'freshwater', country: 'Canada', location: null,
        collectionDate: '2024', occurrence: 'not-detected', abundance: 0 },
      { id: 's3', accession: null, biome: 'soil', country: null, location: null,
        collectionDate: null, occurrence: 'not-assayed', abundance: null },
    ],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Endpoint implements EnvironmentalWorker {
  onmessage: EnvironmentalWorker['onmessage'] = null;
  onerror: EnvironmentalWorker['onerror'] = null;
  onmessageerror: EnvironmentalWorker['onmessageerror'] = null;
  stopped = false;
  submitted: EnvironmentalRequest | null = null;
  constructor(private automatic = false) {}
  terminate() { this.stopped = true; }
  postMessage(request: EnvironmentalRequest) {
    this.submitted = request;
    if (this.automatic) void executeEnvironmentalRequest(request).then(result => this.emit({ kind: 'result', result }),
      cause => this.emit({ kind: 'error', message: cause.message }));
  }
  emit(message: EnvironmentalWorkerMessage) { this.onmessage?.({ data: structuredClone(message) } as MessageEvent<EnvironmentalWorkerMessage>); }
}
async function nativeRequest(request: EnvironmentalRequest) {
  const worker = new Worker(new URL('./environmental.worker.ts', import.meta.url));
  try {
    return await new Promise<Awaited<ReturnType<typeof executeEnvironmentalRequest>>>((resolve, reject) => {
      worker.onmessage = event => {
        const message = event.data as EnvironmentalWorkerMessage;
        if (message.kind === 'result') resolve(message.result);
        else if (message.kind === 'error') reject(new Error(message.message));
      };
      worker.onerror = event => reject(new Error(event.message));
      worker.postMessage(request);
    });
  } finally { worker.terminate(); }
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('environmental worker computation and replay', () => {
  it('imports without computing, then preserves missingness, units and date precision through a real worker', async () => {
    const dataset = fixture();
    const imported = await nativeRequest({ kind: 'import', content: JSON.stringify(dataset) });
    expect(imported).toEqual({ dataset, analysis: null, record: null, verified: false });
    const computed = await nativeRequest({ kind: 'analyze', dataset });
    expect(computed.analysis!.totals).toEqual({ samples: 3, assayed: 2, detected: 1, notDetected: 1, notAssayed: 1, located: 1, dated: 2 });
    expect(computed.analysis!.biomes.find(b => b.biome === 'freshwater')).toMatchObject({ detectionFraction: 0.5, meanAbundance: 4, abundanceSamples: 2 });
    expect(computed.analysis!.biomes.find(b => b.biome === 'soil')).toMatchObject({ detectionFraction: null, meanAbundance: null, abundanceSamples: 0 });
    const replayed = await nativeRequest({ kind: 'replay', content: serializeAnalysisRecord(computed.record!) });
    expect(replayed.verified).toBe(true);
    expect(replayed.dataset).toEqual(dataset);
    expect(replayed.record!.resultId).toBe(computed.record!.resultId);
    expect(replayed.analysis).toEqual(computed.analysis);
  });
  it('uses exact taxon selection and sample-ID joins for abundance inputs', async () => {
    const data = { format: 'phage-explorer-abundance', version: 1, name: 'Counts', units: 'counts',
      source: { kind: 'local', description: 'Field series', reference: null },
      table: { taxa: ['A', 'B'], samples: ['s2', 's1'], counts: [[0, 8], [10, 2]] },
      metadata: [{ sampleId: 's1', habitat: 'freshwater', latitude: 10, longitude: 20, collectionDate: '2024-02' }, { sampleId: 's2', habitat: 'wastewater', country: 'USA' }] };
    const imported = await executeEnvironmentalRequest({ kind: 'abundance', content: JSON.stringify(data), taxon: 'A' });
    expect(imported.analysis).toBeNull();
    expect(imported.dataset.samples.map(row => [row.id, row.biome, row.abundance, row.occurrence])).toEqual([
      ['s2', 'wastewater', 0, 'not-detected'], ['s1', 'freshwater', 8, 'detected'],
    ]);
    expect(imported.dataset.samples[0].location).toBeNull();
    expect(imported.dataset.samples[1].location).toMatchObject({ latitude: 10, longitude: 20 });
    await expect(executeEnvironmentalRequest({ kind: 'abundance', content: JSON.stringify(data), taxon: 'a' })).rejects.toThrow();
  });
  it('never substitutes a demonstration after malformed local input or a changed saved result', async () => {
    await expect(executeEnvironmentalRequest({ kind: 'import', content: 'not JSON' })).rejects.toThrow();
    const computed = await executeEnvironmentalRequest({ kind: 'analyze', dataset: fixture() });
    computed.record!.fields.environment.value = { fabricated: true };
    await expect(executeEnvironmentalRequest({ kind: 'replay', content: JSON.stringify(computed.record) })).rejects.toThrow();
    const demo = await executeEnvironmentalRequest({ kind: 'demo' });
    expect(demo.dataset).toEqual(createDemoEnvironmentalDataset());
    expect(demo.analysis).toBeNull();
    const result = await executeEnvironmentalRequest({ kind: 'analyze', dataset: demo.dataset });
    expect(result.record!.fields.environment.kind).toBe('demo');
  });
});

describe('environmental accepted-result lifecycle', () => {
  it('captures submitted inputs before await and retains the result across failed replacements', async () => {
    const endpoints: Endpoint[] = [];
    const session = new EnvironmentalSession(() => { const endpoint = new Endpoint(true); endpoints.push(endpoint); return endpoint; });
    session.activate();
    const dataset = fixture();
    const operation = session.run({ kind: 'analyze', dataset });
    dataset.samples[0].abundance = 99;
    expect(await operation).toBe(true);
    const accepted = session.getSnapshot().accepted!;
    expect(accepted.dataset.samples[0].abundance).toBe(8);
    expect(await session.run({ kind: 'import', content: '{}' })).toBe(false);
    expect(session.getSnapshot().accepted).toBe(accepted);
    expect(session.getSnapshot().error).not.toBeNull();
    expect(endpoints.every(endpoint => endpoint.stopped)).toBe(true);
    session.deactivate();
  });
  it('settles cancellation even when the underlying file read never finishes', async () => {
    let workers = 0;
    const pending = deferred<string>();
    const session = new EnvironmentalSession(() => { workers++; return new Endpoint(); });
    session.activate();
    const operation = session.run(async () => ({ kind: 'import', content: await pending.promise }));
    session.cancel();
    expect(await operation).toBe(false);
    expect(session.getSnapshot().loading).toBe(false);
    expect(workers).toBe(0);
    pending.reject(new Error('late read failure')); await tick();
    expect(session.getSnapshot().error).toBeNull();
  });
  it('terminates superseded workers and ignores late replies without unlocking new work', async () => {
    const endpoints: Endpoint[] = [];
    const session = new EnvironmentalSession(() => { const endpoint = new Endpoint(); endpoints.push(endpoint); return endpoint; });
    session.activate();
    const first = session.run({ kind: 'analyze', dataset: fixture() }); await tick();
    const oldCallback = endpoints[0].onmessage!;
    const newer = fixture(); newer.name = 'Replacement';
    const second = session.run({ kind: 'analyze', dataset: newer }); await tick();
    expect(await first).toBe(false); expect(endpoints[0].stopped).toBe(true);
    const oldResult = await executeEnvironmentalRequest(endpoints[0].submitted!);
    oldCallback({ data: { kind: 'result', result: oldResult } } as MessageEvent<EnvironmentalWorkerMessage>);
    expect(session.getSnapshot().loading).toBe(true); expect(session.getSnapshot().accepted).toBeNull();
    endpoints[1].emit({ kind: 'result', result: await executeEnvironmentalRequest(endpoints[1].submitted!) });
    expect(await second).toBe(true); expect(session.getSnapshot().accepted!.dataset.name).toBe('Replacement');
    session.deactivate();
  });
  it('refuses another input or altered display values even when they arrive from the owned worker', async () => {
    for (const alter of ['input', 'display'] as const) {
      const endpoint = new Endpoint(); const session = new EnvironmentalSession(() => endpoint); session.activate();
      const operation = session.run({ kind: 'analyze', dataset: fixture() }); await tick();
      const result = await executeEnvironmentalRequest(endpoint.submitted!);
      if (alter === 'input') result.dataset.query.label = 'Wrong query';
      else result.analysis!.totals.detected = 100;
      endpoint.emit({ kind: 'result', result });
      expect(await operation).toBe(false);
      expect(session.getSnapshot().accepted).toBeNull(); expect(session.getSnapshot().error).not.toBeNull();
      session.deactivate();
    }
  });
  it('close cancels active work and an inactive view cannot start a file read', async () => {
    let reads = 0; const session = new EnvironmentalSession(() => new Endpoint());
    expect(await session.importFile({ size: 0, arrayBuffer: async () => { reads++; return new ArrayBuffer(0); } })).toBe(false);
    expect(reads).toBe(0); session.activate();
    const operation = session.run({ kind: 'demo' }); await tick(); session.deactivate();
    expect(await operation).toBe(false); expect(session.getSnapshot().loading).toBe(false);
  });
  it('bounds actual bytes and rejects malformed UTF-8, regardless of a file size claim', async () => {
    await expect(readEnvironmentalFile({ size: 0, arrayBuffer: async () => new Uint8Array([0xff]).buffer })).rejects.toThrow();
    await expect(readEnvironmentalFile({ size: 0, arrayBuffer: async () => new ArrayBuffer(10 * 1024 * 1024 + 1) })).rejects.toThrow(/limit/);
    const bytes = new TextEncoder().encode('\uFEFF' + JSON.stringify(fixture()));
    expect(await readEnvironmentalFile({ size: bytes.length, arrayBuffer: async () => bytes.buffer })).toBe(JSON.stringify(fixture()));
  });
});

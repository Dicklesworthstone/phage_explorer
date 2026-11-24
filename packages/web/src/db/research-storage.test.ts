import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { ResearchStorage, RESEARCH_STORAGE_LIMITS, researchSnapshotName, validateResearchSnapshotContent, replaySavedResearch } from './research-storage';
import { createDemoEnvironmentalDataset, analyzeEnvironmentalDataset, createEnvironmentalAnalysisRecord,
  replayEnvironmentalAnalysisRecord } from '../../../core/src/analysis/environmental-evidence';
import { createAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { buildAlignmentPangenome, createAlignmentPangenomeRecord, type PangenomeInput } from '../../../core/src/analysis/alignment-pangenome';
import { resolvePhylogenyOptions } from '../../../core/src/analysis/aligned-phylogeny';
import { executeAlignedPhylogenyRequest } from '../workers/AlignedPhylogenySession';
import { executeTemporalRequest, temporalDatingRequest } from '../workers/TemporalSignalSession';
import { executeAncestralRequest } from '../workers/AncestralSession';
import { executeHostMetabolismRequest } from '../workers/HostMetabolismSession';
import { hostGeneWorkflowFixture } from '../../../core/src/analysis/host-gene-knockout.fixture';
import { createCompatibilityExperiment, replayCompatibilityExperiment } from '../../../core/src/analysis/alignment-compatibility';
import { executeAttachmentRequest, isProphageExcisionWork } from '../workers/ProphageAttachmentSession';

const content = JSON.stringify({ format: 'phage-explorer-local-genomes', version: 1, inputs: [{ name: 'private.fa', text: '>private\nACGTNN' }] });
/** Event/rollback fixture for the production client's ownership rules, NOT an IndexedDB engine.
 * Native transactions, reloads and cross-tab behavior are covered separately in browser tests.
 */
function transactionFixture() {
  type Data = Record<string, Map<string, unknown>>;
  const data: Data = { metadata: new Map(), contents: new Map() };
  let queue = Promise.resolve();
  let failStore: string | null = null;
  let beforeCommit: (() => void) | null = null;
  let afterCommit: (() => void) | null = null;
  let opens = 0;
  let closed = 0;
  function transaction() {
    let state = 'queued', finishQueue!: () => void;
    let local: Data;
    const pending: Array<() => void> = [];
    const tx = {
      error: null as unknown, onabort: null as (() => void) | null, oncomplete: null as (() => void) | null, onerror: null as (() => void) | null,
      abort() {
        if (state === 'finished') throw new DOMException('Already finished', 'InvalidStateError');
        state = 'finished'; tx.error ??= new DOMException('Aborted', 'AbortError');
        queueMicrotask(() => { tx.onabort?.(); finishQueue?.(); });
      },
      objectStore(name: string) {
        const request = (work: () => unknown) => {
          const req = { result: undefined as unknown, onsuccess: null as (() => void) | null };
          pending.push(() => {
            try { req.result = work(); req.onsuccess?.(); }
            catch (cause) { tx.error = cause; tx.onerror?.(); tx.abort(); }
          });
          return req;
        };
        return {
          getAll: () => request(() => structuredClone([...local[name].values()])),
          get: (id: string) => request(() => structuredClone(local[name].get(id))),
          add: (value: { id: string }) => request(() => {
            if (failStore === name) { failStore = null; throw new DOMException('Disk quota failure', 'QuotaExceededError'); }
            if (local[name].has(value.id)) throw new Error('Duplicate key');
            local[name].set(value.id, structuredClone(value)); return value.id;
          }),
          delete: (id: string) => request(() => local[name].delete(id)),
        };
      },
    };
    queue = queue.then(() => new Promise<void>(resolve => {
      finishQueue = resolve;
      if (state === 'finished') { resolve(); return; }
      state = 'active'; local = structuredClone(data);
      const process = () => {
        if (state === 'finished') return;
        const next = pending.shift();
        if (next) { next(); queueMicrotask(process); return; }
        const before = beforeCommit; beforeCommit = null; before?.();
        if (state === 'finished') return;
        data.metadata = local.metadata; data.contents = local.contents; state = 'finished';
        const after = afterCommit; afterCommit = null; after?.();
        queueMicrotask(() => { tx.oncomplete?.(); resolve(); });
      };
      queueMicrotask(process);
    }));
    return tx;
  }
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: {
    open() {
      opens++;
      const request = { onsuccess: null as (() => void) | null, result: { onversionchange: null, close: () => { closed++; }, transaction } };
      queueMicrotask(() => request.onsuccess?.()); return request;
    },
  } });
  return { data, store: new ResearchStorage('isolated-test'),
    failNext: (name: string) => { failStore = name; },
    before: (callback: () => void) => { beforeCommit = callback; },
    after: (callback: () => void) => { afterCommit = callback; },
    counts: () => ({ opens, closed }),
    restore: () => { if (prior) Object.defineProperty(globalThis, 'indexedDB', prior); else Reflect.deleteProperty(globalThis, 'indexedDB'); },
  };
}
async function fixture(test: (value: ReturnType<typeof transactionFixture>) => Promise<void>) {
  const value = transactionFixture(); try { await test(value); } finally { value.restore(); }
}

describe('saved research format routing', () => {
  it('stores and freshly replays both exact excision molecules in the attachment library', () => fixture(async ({ store }) => {
    const work = await executeAttachmentRequest({ kind: 'excise', input: { format: 'phage-explorer-prophage-excision', version: 1,
      locus: { name: 'Private integrated locus', accession: null, sequence: 'CCGACGTTGATTAA', topology: 'linear',
        source: { kind: 'local', reference: 'Hand-derived sequence composition control', version: '1', license: 'CC0' } },
      attL: { start: 2, end: 4, strand: '+', evidence: 'Declared synthetic left core' },
      attR: { start: 8, end: 10, strand: '+', evidence: 'Declared synthetic right core' },
    }, options: { flankLength: 2 } });
    const content = serializeAnalysisRecord(work.record);
    assert(validateResearchSnapshotContent('attachment', content) > 0);
    assert.throws(() => validateResearchSnapshotContent('epistasis', content), /match/);
    const saved = await store.save('attachment', 'Exact two-molecule excision', content);
    const reopened = await new ResearchStorage('isolated-test').read(saved.id, 'attachment');
    assert.equal(reopened.content, content);
    const replay = await executeAttachmentRequest({ kind: 'replay', content: reopened.content });
    assert(isProphageExcisionWork(replay));
    assert.equal(replay.verified, true);
    assert.equal(replay.result.excisedPhage.sequence, 'GACGTT');
    assert.equal(replay.result.restoredHost.sequence, 'CCGATTAA');
    assert.equal(replay.record.resultId, work.record.resultId);
    assert.deepEqual(replay.input, work.input);
    assert.deepEqual(replay.result, work.result);
  }));
  it('routes complete aligned-site experiments and reopens their exact sources through fresh calculation', async () => {
    const experiment = await createCompatibilityExperiment({ format: 'phage-explorer-alignment-compatibility', version: 1,
      name: 'Explicit synthetic compatibility fixture', source: { kind: 'demo', reference: 'Hand-counted fixture', version: '1', license: 'CC0' },
      alignment: { fasta: '>a\nAA\n>b\nAG\n>c\nGA\n>d\nGG\n', homologous: true, method: 'Constructed columns', reference: 'Synthetic hypothesis' } });
    const exported = serializeAnalysisRecord(experiment.record);
    assert(validateResearchSnapshotContent('compatibility', exported) > 0);
    assert.throws(() => validateResearchSnapshotContent('synteny', exported), /match/);
    assert.throws(() => validateResearchSnapshotContent('compatibility', content), /match/);
    assert.equal((await replayCompatibilityExperiment(exported)).record.resultId, experiment.record.resultId);
    await fixture(async ({ store }) => {
      const saved = await store.save('compatibility', 'Private exact alignment', exported);
      const read = await store.read(saved.id, 'compatibility');
      assert.equal(read.content, exported);
      assert.equal((await replayCompatibilityExperiment(read.content)).result.coverage.incompatiblePairs, 1);
    });
  });
  it('accepts existing portable formats without relabeling analysis methods', () => {
    assert.equal(validateResearchSnapshotContent('genomes', content), new TextEncoder().encode(content).length);
    assert(validateResearchSnapshotContent('workflow', JSON.stringify({ format: 'phage-explorer-commands', version: 1 })) > 0);
    for (const [kind, method] of [['codon-reference', 'reference-codon-adaptation'], ['pangenome', 'alignment-pangenome']] as const) {
      assert(validateResearchSnapshotContent(kind, JSON.stringify({ format: 'phage-explorer-analysis', version: 1, method: { id: method } })) > 0);
    }
    for (const bad of ['null', '[]', '{}', '{', JSON.stringify({ format: 'phage-explorer-local-genomes', version: 2 })]) {
      assert.throws(() => validateResearchSnapshotContent('genomes', bad));
    }
    assert.throws(() => validateResearchSnapshotContent('pangenome', content), /match/);
    assert.throws(() => validateResearchSnapshotContent('codon-reference', JSON.stringify({ format: 'phage-explorer-analysis', version: 1, method: { id: 'codon-adaptation-lens' } })), /match/);
  });
  it('bounds names and UTF-8 bytes, not only JavaScript character counts', () => {
    assert.equal(researchSnapshotName('  Genome α  '), 'Genome α');
    for (const name of ['', ' ', '\u001b[31m', 'x'.repeat(121)]) assert.throws(() => researchSnapshotName(name));
    const multibyte = JSON.stringify({ format: 'phage-explorer-local-genomes', version: 1, padding: '🧬'.repeat(3_000_000) });
    assert(multibyte.length < RESEARCH_STORAGE_LIMITS.snapshotBytes);
    assert.throws(() => validateResearchSnapshotContent('genomes', multibyte), /10 MiB/);
  });
  it('routes measured and supplied-data methods separately, without treating a checksum as scientific verification', () => {
    const methods = [
      ['abundance', 'abundance-clr-nmf'], ['environmental', 'local-environmental-evidence'],
      ['epistasis', 'measured-epistasis-assay'], ['plaque-growth', 'plaque-count-growth'],
      ['pfu-growth', 'extracellular-pfu-growth'], ['inactivation', 'plaque-count-inactivation'],
    ] as const;
    for (const [kind, method] of methods) {
      const saved = JSON.stringify({ format: 'phage-explorer-analysis', version: 1, method: { id: method, version: '2' } });
      assert(validateResearchSnapshotContent(kind, saved) > 0);
      for (const [other] of methods) if (other !== kind) assert.throws(() => validateResearchSnapshotContent(other, saved), /match/);
    }
  });
  it('routes every standalone and linked phylogeny method without dropping its lineage', () => {
    const routes = [
      ['phylogeny', 'aligned-dna-neighbor-joining'], ['phylogeny', 'explicit-outgroup-rooted-nj'],
      ['temporal', 'fixed-root-temporal-signal'], ['temporal', 'rooted-nj-temporal-signal'],
      ['strict-clock', 'fixed-root-strict-clock-dating'], ['strict-clock', 'rooted-nj-strict-clock-dating'],
      ['ancestral', 'ancestral-jc69'], ['ancestral', 'ancestral-reversible-dna'], ['ancestral', 'rooted-nj-ancestral'],
    ] as const;
    for (const [kind, id] of routes) {
      const json = JSON.stringify({ format: 'phage-explorer-analysis', version: 1, method: { id } });
      assert(validateResearchSnapshotContent(kind, json) > 0);
      for (const other of ['phylogeny', 'temporal', 'strict-clock', 'ancestral'] as const) {
        if (other !== kind) assert.throws(() => validateResearchSnapshotContent(other, json), /match/);
      }
    }
  });
});

describe('saved experiment replay ownership', () => {
  it('does not mistake a caught analysis failure for verified restoration', async () => {
    await assert.rejects(replaySavedResearch(new AbortController().signal, {
      run: async () => false, cancel: () => {}, error: () => 'Numerical results differ from the saved experiment.',
    }), /Numerical results differ/);
    await assert.rejects(replaySavedResearch(new AbortController().signal, {
      run: async () => { throw new Error('Worker unavailable'); }, cancel: () => {}, error: () => null,
    }), /Worker unavailable/);
  });
  it('does not start an aborted open and promptly cancels an uncooperative pending provider', async () => {
    const prior = new AbortController(); prior.abort(); let starts = 0, cancellations = 0;
    assert.throws(() => replaySavedResearch(prior.signal, {
      run: async () => { starts++; return true; }, cancel: () => { cancellations++; }, error: () => null,
    }), { name: 'AbortError' });
    assert.equal(starts, 0); assert.equal(cancellations, 0);
    const controller = new AbortController(); let complete!: (ok: boolean) => void;
    const pending = replaySavedResearch(controller.signal, {
      run: () => { starts++; return new Promise(resolve => { complete = resolve; }); },
      cancel: () => { cancellations++; }, error: () => null,
    });
    await Promise.resolve(); controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    complete(true); await Promise.resolve();
    assert.equal(starts, 1); assert.equal(cancellations, 1);
  });
  it('removes completed replay listeners before later unrelated session work', async () => {
    const controller = new AbortController(); let cancellations = 0;
    await replaySavedResearch(controller.signal, { run: async () => true, cancel: () => { cancellations++; }, error: () => null });
    controller.abort(); assert.equal(cancellations, 0);
  });
});

describe('saved research client transaction ownership (event fixture)', () => {
  it('reopens full host flux and gene-knockout experiments from the same local library without refetching models', () => fixture(async ({ store }) => {
    const input = hostGeneWorkflowFixture();
    const scenarios = await executeHostMetabolismRequest({ kind: 'analyze', input, options: {
      changes: [{ reactionId: 'complex', lowerBound: 0, upperBound: 2,
        evidence: { kind: 'assumption', reference: 'Independent parallel-route example', description: 'Bound one route to two units', gene: null } }],
      variability: ['complex', 'alternative'], objectiveLoss: 0,
    } });
    const knockout = await executeHostMetabolismRequest({ kind: 'knockout', input, options: {
      genes: ['c', 'd'], mode: 'joint', reference: 'Independent OR-rule example', variability: ['complex'], objectiveLoss: 0,
    } });
    assert.equal(scenarios.result!.baseline.objective, 9);
    assert.equal(scenarios.result!.perturbed!.objective, 6); // 2 + 4, below the nine-unit supply.
    assert.equal(knockout.geneResult!.runs[0].scenario.objective, 6); // Only the six-unit route remains.
    const saved = await Promise.all([scenarios, knockout].map(work => store.save('host-metabolism', 'Host experiment', serializeAnalysisRecord(work.record!))));
    assert.notEqual(saved[0].id, saved[1].id);
    const reopened = new ResearchStorage('isolated-test');
    assert.equal((await reopened.list('host-metabolism')).length, 2);
    let requests = 0;
    for (const [i, original] of [scenarios, knockout].entries()) {
      const snapshot = await reopened.read(saved[i].id, 'host-metabolism');
      const replay = await executeHostMetabolismRequest({ kind: 'import', content: snapshot.content }, undefined, {
        fetcher: async () => { requests++; throw new Error('Saved models must be self-contained'); },
      });
      assert.equal(replay.verified, true); assert.equal(replay.record!.resultId, original.record!.resultId);
      assert.deepEqual(replay.input, input); assert.deepEqual(replay.result, original.result);
      assert.deepEqual(replay.geneResult, original.geneResult);
      await assert.rejects(reopened.read(saved[i].id, 'pangenome'), /another panel/);
    }
    assert.equal(requests, 0);
    // A storage checksum alone cannot make fabricated numerical output executable.
    const forged = structuredClone(knockout.record!);
    (forged.fields.experiment.value as { runs: Array<{ disabled: unknown[] }> }).runs[0].disabled = [];
    const signed = await createAnalysisRecord({ ...forged, inputs: forged.inputs.map(({ sha256: _sha, ...row }) => row) });
    const bad = await store.save('host-metabolism', 'Forged result', serializeAnalysisRecord(signed));
    await assert.rejects(executeHostMetabolismRequest({ kind: 'import', content: (await reopened.read(bad.id, 'host-metabolism')).content }), /Fresh gene-knockout/);
    await assert.rejects(store.save('host-metabolism', 'Uncomputed input', JSON.stringify(input)), /match/);
  }));
  it('reopens the complete pangenome, root, temporal, clock and ancestral chain through fresh production replay', () => fixture(async ({ store }) => {
    const input: PangenomeInput = { format: 'phage-explorer-pangenome', version: 1, name: 'Private saved quartet', source: 'demo',
      sequences: ['A', 'B', 'C', 'D'].map((id, i) => ({ id, description: 'Synthetic sequence',
        sequence: 'A'.repeat(i * 5) + 'G'.repeat(i + 1) + 'A'.repeat(99 - i * 6) })) };
    const parent = await createAlignmentPangenomeRecord(input, buildAlignmentPangenome(input, { referenceId: 'A', alignment: 'provided' }));
    const parentText = '\ufeff' + serializeAnalysisRecord(parent).replace(/\n/g, '\r\n');
    const inference = await executeAlignedPhylogenyRequest({ kind: 'pangenome', source: {
      name: input.name, reference: 'Synthetic aligned columns; no biological homology claim', experiment: parentText,
    }, options: resolvePhylogenyOptions({ distance: 'jc69', bootstrap: 0, seed: 0 }) });
    const rooted = await executeAlignedPhylogenyRequest({ kind: 'root', content: serializeAnalysisRecord(inference.record),
      rooting: { outgroup: ['A'], fractionFromOutgroup: .25, dateIndependent: true, evidence: 'Synthetic outgroup and position chosen without dates' } });
    const rootText = serializeAnalysisRecord(rooted.rooting!.record);
    const temporal = await executeTemporalRequest({ kind: 'analyze-rooted', rootedSource: { content: rootText, metadata: {
      name: 'Private collection cohort', kind: 'demo', description: 'Synthetic dates', reference: null, license: 'CC0 synthetic fixture', dateIndependent: true,
      sampleTable: 'sampleId,collectionDate,dateSource\nD,2003.0,fixture\nA,2000.0,fixture\nC,2002.0,fixture\nB,2001.0,fixture\n',
    } }, options: { permutations: 24, seed: 0 } });
    const dated = await executeTemporalRequest(temporalDatingRequest(temporal, {}));
    assert.equal(dated.dating!.status, 'fitted');
    const ancestral = await executeAncestralRequest({ kind: 'analyze-rooted', rootedSource: { content: rootText, license: 'CC0 synthetic fixture' },
      options: { startColumn: 1, endColumn: 6, minPosterior: .7, substitution: { model: 'HKY85', source: 'Explicit synthetic model assumption',
        frequencies: [.25, .25, .25, .25], kappa: 2, siteRates: [{ rate: 1, weight: 1 }] } } });
    const saved = await Promise.all([
      store.save('phylogeny', 'Rooted backbone', rootText),
      store.save('temporal', 'Temporal diagnostics', serializeAnalysisRecord(temporal.record!)),
      store.save('strict-clock', 'Conditional clock', serializeAnalysisRecord(dated.datingRecord!)),
      store.save('ancestral', 'Conditional ancestors', serializeAnalysisRecord(ancestral.record!)),
    ]);
    const reopened = new ResearchStorage('isolated-test');
    const tree = await executeAlignedPhylogenyRequest({ kind: 'replay', content: (await reopened.read(saved[0].id, 'phylogeny')).content });
    assert.equal(tree.rooting!.record.resultId, rooted.rooting!.record.resultId);
    assert.equal(tree.record.resultId, inference.record.resultId);
    assert.equal(tree.pangenome!.source.experiment, parentText);
    const diagnostic = await executeTemporalRequest({ kind: 'import', content: (await reopened.read(saved[1].id, 'temporal')).content });
    assert.equal(diagnostic.verified, true); assert.deepEqual(diagnostic.record, temporal.record);
    assert.deepEqual(diagnostic.rootedSource, temporal.rootedSource);
    const clock = await executeTemporalRequest({ kind: 'import', content: (await reopened.read(saved[2].id, 'strict-clock')).content });
    assert.equal(clock.verified, true); assert.deepEqual(clock.datingRecord, dated.datingRecord);
    assert.deepEqual(clock.record, temporal.record); assert.deepEqual(clock.rootedSource, temporal.rootedSource);
    assert.deepEqual(clock.dating!.nodes, dated.dating!.nodes);
    const ancestors = await executeAncestralRequest({ kind: 'import', content: (await reopened.read(saved[3].id, 'ancestral')).content });
    assert.equal(ancestors.verified, true); assert.deepEqual(ancestors.record, ancestral.record);
    assert.equal(ancestors.rootedResultId, rooted.rooting!.record.resultId);
    assert.equal(ancestors.unrootedResultId, inference.record.resultId);
    assert.deepEqual(ancestors.result!.patterns, ancestral.result!.patterns);
    assert.deepEqual(ancestors.options.substitution, ancestral.options.substitution);
    // Storage integrity and a valid outer hash do not verify a changed embedded parent.
    const inputs = structuredClone(dated.datingRecord!.inputs).map(({ sha256: _sha, ...row }) => row);
    const nested = inputs.find(row => row.id === 'temporalExperiment')!;
    const forgedParent = structuredClone(temporal.record!);
    forgedParent.fields.regression.value = { forged: true };
    nested.data = JSON.parse(serializeAnalysisRecord(await createAnalysisRecord({ ...forgedParent,
      inputs: forgedParent.inputs.map(({ sha256: _sha, ...row }) => row) })));
    const forged = await createAnalysisRecord({ ...dated.datingRecord!, inputs });
    const corrupted = await store.save('strict-clock', 'Changed parent', serializeAnalysisRecord(forged));
    await assert.rejects(executeTemporalRequest({ kind: 'import', content: (await reopened.read(corrupted.id, 'strict-clock')).content }), /differs|mismatch/i);
    assert.equal((await reopened.read(saved[2].id, 'strict-clock')).content, serializeAnalysisRecord(dated.datingRecord!));
  }));
  it('retains a complete environmental experiment for independent fresh replay after reopening storage', () => fixture(async ({ store }) => {
    const dataset = createDemoEnvironmentalDataset();
    const record = await createEnvironmentalAnalysisRecord(dataset, analyzeEnvironmentalDataset(dataset));
    const json = serializeAnalysisRecord(record);
    const saved = await store.save('environmental', 'Supplied sample experiment', json);
    const reopened = await new ResearchStorage('isolated-test').read(saved.id, 'environmental');
    assert.equal(reopened.content, json);
    const replay = await replayEnvironmentalAnalysisRecord(reopened.content);
    assert.equal(replay.record.resultId, record.resultId);
    assert.deepEqual(replay.dataset, dataset);
    assert.equal(replay.dataset.samples[2].occurrence, 'not-assayed');
    assert.equal(replay.dataset.samples[2].abundance, null);
    assert.equal(replay.dataset.samples[1].abundance, 0);
    await assert.rejects(store.read(saved.id, 'abundance'), /another panel/);
  }));
  it('preserves exact export bytes and lists metadata without private payloads', () => fixture(async ({ store, counts }) => {
    const text = `  ${content}\n`;
    const entry = await store.save('genomes', 'Test', text);
    assert.equal((await new ResearchStorage('isolated-test').read(entry.id, 'genomes')).content, text);
    const [listed] = await store.list('genomes');
    assert.deepEqual(listed, entry); assert(!Object.hasOwn(listed, 'content'));
    assert.equal(counts().opens, counts().closed);
  }));
  it('keeps two independent same-name saves rather than last-writer-wins', () => fixture(async ({ store }) => {
    const entries = await Promise.all([store.save('genomes', 'Same', content), store.save('genomes', 'Same', content)]);
    assert.notEqual(entries[0].id, entries[1].id);
    assert.equal((await store.list()).length, 2);
  }));
  it('does not acknowledge a successful metadata write when the payload transaction aborts', () => fixture(async ({ store, data, failNext }) => {
    const original = await store.save('genomes', 'Original', content);
    failNext('contents');
    await assert.rejects(store.save('genomes', 'Failed', content), { name: 'QuotaExceededError' });
    assert.deepEqual([...data.metadata.keys()], [original.id]);
    assert.deepEqual([...data.contents.keys()], [original.id]);
    assert.equal((await store.read(original.id, 'genomes')).content, content);
  }));
  it('aborts before opening and rolls back cancellation after successful requests', () => fixture(async ({ store, before, counts, data }) => {
    const prior = new AbortController(); prior.abort();
    await assert.rejects(store.save('genomes', 'Cancelled', content, prior.signal), { name: 'AbortError' });
    assert.equal(counts().opens, 0);
    const pending = new AbortController(); before(() => pending.abort());
    await assert.rejects(store.save('genomes', 'Cancelled', content, pending.signal), { name: 'AbortError' });
    assert.equal(data.metadata.size, 0); assert.equal(data.contents.size, 0);
  }));
  it('reports an actual commit even if cancellation arrives before its completion notification', () => fixture(async ({ store, after }) => {
    const controller = new AbortController(); after(() => controller.abort());
    const committed = await store.save('genomes', 'Committed', content, controller.signal);
    assert.equal((await store.read(committed.id, 'genomes')).content, content);
  }));
  it('enforces the global snapshot cap atomically across concurrent writers without eviction', () => fixture(async ({ store }) => {
    for (let i = 0; i < 63; i++) await store.save('genomes', `Item ${i}`, content);
    const results = await Promise.allSettled([store.save('genomes', 'Last A', content), store.save('genomes', 'Last B', content)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.equal((await store.list()).length, 64);
  }));
  it('enforces the total byte cap before writing and retains earlier records', () => fixture(async ({ store, data }) => {
    const original = await store.save('genomes', 'Original', content);
    // Metadata fixture represents existing full snapshots; avoid allocating 64 MiB in this client test.
    data.metadata.set(original.id, { ...original, bytes: RESEARCH_STORAGE_LIMITS.snapshotBytes });
    for (let i = 0; i < 5; i++) {
      const id = crypto.randomUUID(); data.metadata.set(id, { ...original, id, bytes: RESEARCH_STORAGE_LIMITS.snapshotBytes });
    }
    const fiveMiB = JSON.stringify({ format: 'phage-explorer-local-genomes', version: 1, padding: 'A'.repeat(5 * 1024 * 1024) });
    await assert.rejects(store.save('genomes', 'Over budget', fiveMiB), /library is full/);
    assert.equal(data.metadata.size, 6); assert.equal(data.contents.size, 1);
  }));
  it('refuses wrong-panel, missing and same-length damaged contents without removing them', () => fixture(async ({ store, data }) => {
    const entry = await store.save('genomes', 'Original', content);
    await assert.rejects(store.read(entry.id, 'pangenome'), /another panel/);
    await assert.rejects(store.read(crypto.randomUUID(), 'genomes'), /missing/);
    data.contents.set(entry.id, { id: entry.id, content: content.replace('ACGTNN', 'TCGTNN') });
    await assert.rejects(store.read(entry.id, 'genomes'), /checksum/);
    assert.equal(data.metadata.size, 1); assert.equal(data.contents.size, 1);
  }));
  it('removes only an explicitly selected immutable ID and refuses wrong-panel deletion', () => fixture(async ({ store }) => {
    const a = await store.save('genomes', 'Same', content), b = await store.save('genomes', 'Same', content);
    await assert.rejects(store.remove(a.id, 'pangenome'), /another panel/);
    await store.remove(a.id, 'genomes');
    assert.deepEqual((await store.list()).map(entry => entry.id), [b.id]);
    assert.equal((await store.read(b.id, 'genomes')).content, content);
  }));
  it('isolates throwing change observers from committed saves', () => fixture(async ({ store }) => {
    let calls = 0;
    const off = store.subscribe(() => { calls++; throw new Error('Observer failed'); });
    const entry = await store.save('genomes', 'Saved', content); off();
    assert.equal(calls, 1); assert.equal((await store.read(entry.id, 'genomes')).content, content);
  }));
});

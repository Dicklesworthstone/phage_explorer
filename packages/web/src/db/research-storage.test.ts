import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { ResearchStorage, RESEARCH_STORAGE_LIMITS, researchSnapshotName, validateResearchSnapshotContent, replaySavedResearch, RESEARCH_SNAPSHOT_TYPES, RESEARCH_COLLECTION_FORMAT, RESEARCH_COLLECTION_MAX_BYTES, parseResearchCollection, type ResearchSnapshot, type ResearchSnapshotKind } from './research-storage';
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

import { readLocalTextFile } from '../utils/fileSystem';

const content = JSON.stringify({ format: 'phage-explorer-local-genomes', version: 1, inputs: [{ name: 'private.fa', text: '>private\nACGTNN' }] });
/** Event/rollback fixture for the production client's ownership rules, NOT an IndexedDB engine.
 * Native transactions, reloads and cross-tab behavior are covered separately in browser tests.
 */
function transactionFixture() {
  type Data = Record<string, Map<IDBValidKey, unknown>>;
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
          getAllKeys: () => request(() => structuredClone([...local[name].keys()])),
          getKey: (id: IDBValidKey) => request(() => local[name].has(id) ? id : undefined),
          get: (id: IDBValidKey) => request(() => structuredClone(local[name].get(id))),
          add: (value: { id: string }) => request(() => {
            if (failStore === name) { failStore = null; throw new DOMException('Disk quota failure', 'QuotaExceededError'); }
            if (local[name].has(value.id)) throw new Error('Duplicate key');
            local[name].set(value.id, structuredClone(value)); return value.id;
          }),
          delete: (id: IDBValidKey) => request(() => {
            if (failStore === name) { failStore = null; throw new DOMException('Injected delete failure', 'UnknownError'); }
            return local[name].delete(id);
          }),
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
    // String/number equality is all this event fixture needs. Native key semantics have browser tests.
    cmp: (a: IDBValidKey, b: IDBValidKey) => a === b ? 0 : 1,
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
  it('keeps healthy snapshots accessible when another panel has damaged metadata', () => fixture(async ({ store, data }) => {
    const intact = await store.save('genomes', 'Intact', content);
    const damaged = await store.save('workflow', 'Damaged workflow', JSON.stringify({ format: 'phage-explorer-commands', version: 1 }));
    data.metadata.set(damaged.id, { ...damaged, bytes: -1 });
    assert.deepEqual(await store.list('genomes'), [intact]);
    assert.equal((await store.read(intact.id, 'genomes')).content, content);
  }));
  it('reports global index problems without payloads and refuses unaccounted saves until explicit cleanup', () => fixture(async ({ store, data }) => {
    const intact = await store.save('genomes', 'Intact', content);
    const damaged = await store.save('workflow', 'Damaged', JSON.stringify({ format: 'phage-explorer-commands', version: 1 }));
    data.metadata.set(damaged.id, { ...damaged, bytes: 0 });
    const inventory = await store.inspect('genomes');
    assert.deepEqual(inventory.entries, [intact]);
    assert.deepEqual(inventory.problems, [{ key: damaged.id, keyLabel: JSON.stringify(damaged.id), name: null, removable: true, reason: 'Invalid snapshot metadata' }]);
    assert(!JSON.stringify(inventory).includes('private.fa'));
    await assert.rejects(store.save('genomes', 'Unsafe accounting', content), /damaged, incomplete or unsupported/);
    assert.equal(data.metadata.size, 2); assert.equal(data.contents.size, 2);
    await store.removeDamaged(inventory.problems[0].key);
    assert.deepEqual([...data.metadata.keys()], [intact.id]); assert.deepEqual([...data.contents.keys()], [intact.id]);
    await store.save('genomes', 'After explicit cleanup', content);
    assert.equal((await store.list()).length, 2);
    assert.equal((await store.read(intact.id, 'genomes')).content, content);
  }));
  it('uses the actual primary key when corrupt metadata has a misleading ID or a non-UUID key', () => fixture(async ({ store, data }) => {
    const intact = await store.save('genomes', 'Intact', content);
    data.metadata.set('legacy-key', { ...intact });
    data.contents.set('legacy-key', { id: 'legacy-key', content });
    data.metadata.set(17, { id: 17, name: 'Old record' });
    data.contents.set(17, { id: 17, content });
    const { entries, problems } = await store.inspect();
    assert.deepEqual(entries, [intact]); assert.deepEqual(problems.map(problem => problem.key), ['legacy-key', 17]);
    for (const problem of problems) await store.removeDamaged(problem.key);
    assert.deepEqual([...data.metadata.keys()], [intact.id]); assert.deepEqual([...data.contents.keys()], [intact.id]);
    assert.equal((await store.read(intact.id, 'genomes')).content, content);
  }));
  it('exposes missing payloads and orphan contents without losing intact snapshots', () => fixture(async ({ store, data }) => {
    const intact = await store.save('genomes', 'Intact', content);
    const missing = await store.save('genomes', 'Missing payload', content);
    const orphan = await store.save('genomes', 'Missing metadata', content);
    data.contents.delete(missing.id); data.metadata.delete(orphan.id);
    const inventory = await store.inspect();
    assert.deepEqual(inventory.entries, [intact]);
    assert.deepEqual(inventory.problems.map(problem => [problem.key, problem.reason]), [
      [missing.id, 'Saved contents are missing'], [orphan.id, 'Saved contents have no metadata'],
    ]);
    await assert.rejects(store.save('genomes', 'Unknown usage', content), /damaged, incomplete or unsupported/);
    for (const problem of inventory.problems) await store.removeDamaged(problem.key);
    assert.deepEqual(await store.inspect(), { entries: [intact], problems: [] });
    assert.deepEqual([...data.metadata.keys()], [intact.id]); assert.deepEqual([...data.contents.keys()], [intact.id]);
  }));
  it('refuses stale recovery removal after a record becomes healthy and rejects absent keys', () => fixture(async ({ store, data }) => {
    const intact = await store.save('genomes', 'Restored metadata', content);
    data.metadata.set(intact.id, { ...intact, sha256: 'invalid' });
    const [problem] = (await store.inspect()).problems;
    data.metadata.set(intact.id, intact);
    await assert.rejects(store.removeDamaged(problem.key), /no longer has an index problem/);
    assert.equal((await store.read(intact.id, 'genomes')).content, content);
    await assert.rejects(store.removeDamaged('already-removed'), /already absent/);
  }));
  it('preserves newer snapshot versions and unknown kinds while keeping supported records accessible', () => fixture(async ({ store, data }) => {
    const intact = await store.save('genomes', 'Supported', content);
    const futureKind = await store.save('genomes', 'Future kind', content);
    const futureVersion = await store.save('genomes', 'Future version', content);
    data.metadata.set(futureKind.id, { ...futureKind, kind: 'future-kind' });
    data.metadata.set(futureVersion.id, { ...futureVersion, version: 2 });
    const inventory = await store.inspect();
    assert.deepEqual(inventory.entries, [intact]); assert.equal(inventory.problems.length, 2);
    for (const problem of inventory.problems) {
      assert.equal(problem.reason, 'Unsupported snapshot format'); assert.equal(problem.removable, false);
      await assert.rejects(store.removeDamaged(problem.key), /unsupported snapshot format/);
    }
    await assert.rejects(store.save('genomes', 'Unknown accounting', content), /unsupported/);
    assert.equal(data.metadata.size, 3); assert.equal(data.contents.size, 3);
    assert.equal((await store.read(intact.id, 'genomes')).content, content);
  }));
  it('rolls back both stores when damaged-record removal fails or is cancelled', () => fixture(async ({ store, data, before, failNext }) => {
    const damaged = await store.save('genomes', 'Damaged', content);
    const broken = { ...damaged, bytes: -1 }; data.metadata.set(damaged.id, broken);
    let changes = 0; const unsubscribe = store.subscribe(() => { changes++; });
    failNext('contents');
    await assert.rejects(store.removeDamaged(damaged.id), { name: 'UnknownError' });
    assert.deepEqual(data.metadata.get(damaged.id), broken); assert(data.contents.has(damaged.id));
    const controller = new AbortController(); before(() => controller.abort());
    await assert.rejects(store.removeDamaged(damaged.id, controller.signal), { name: 'AbortError' });
    assert.deepEqual(data.metadata.get(damaged.id), broken); assert(data.contents.has(damaged.id));
    assert.equal(changes, 0); unsubscribe();
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
      data.contents.set(id, { id, content });
    }
    const fiveMiB = JSON.stringify({ format: 'phage-explorer-local-genomes', version: 1, padding: 'A'.repeat(5 * 1024 * 1024) });
    await assert.rejects(store.save('genomes', 'Over budget', fiveMiB), /library is full/);
    assert.equal(data.metadata.size, 6); assert.equal(data.contents.size, 6);
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


/** Independent collection writer for deliberate metadata conflicts. This does not
 * forge valid scientific evidence: the existing replay boundary remains separate.
 */
async function collectionText(snapshots: ResearchSnapshot[]): Promise<string> {
  const manifest = JSON.stringify({ format: RESEARCH_COLLECTION_FORMAT, version: 1,
    snapshots: snapshots.map(({ id, version, kind, name, createdAt, bytes, sha256 }) =>
      ({ id, version, kind, name, createdAt, bytes, sha256 })) });
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(manifest));
  const manifestSha256 = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  return JSON.stringify({ format: RESEARCH_COLLECTION_FORMAT, version: 1, snapshots, manifestSha256 });
}
async function savedCollection(rows: Array<{ kind: ResearchSnapshotKind; name: string; content: string }>): Promise<string> {
  let collection = '';
  await fixture(async ({ store }) => {
    for (const row of rows) await store.save(row.kind, row.name, row.content);
    collection = await store.exportCollection();
  });
  return collection;
}

describe('portable saved research collections', () => {
  it('moves exact private sources and a real experiment into another library, preserving existing snapshots and fresh replay', async () => {
    const dataset = createDemoEnvironmentalDataset();
    const record = await createEnvironmentalAnalysisRecord(dataset, analyzeEnvironmentalDataset(dataset));
    const experiment = serializeAnalysisRecord(record);
    const genomes = ' \n' + content + '\r\n';
    const exported = await savedCollection([
      { kind: 'genomes', name: 'Private source α', content: genomes },
      { kind: 'environmental', name: 'Complete measured inputs and result', content: experiment },
    ]);
    const original = await parseResearchCollection(exported);
    await fixture(async ({ store }) => {
      const kept = await store.save('workflow', 'Existing workflow', JSON.stringify({ format: 'phage-explorer-commands', version: 1 }));
      const preview = await store.previewCollection(exported);
      assert.equal(preview.additions, 2); assert.equal(preview.duplicates, 0);
      assert.equal(preview.currentSnapshots, 1); assert.equal(preview.projectedSnapshots, 3);
      assert(preview.entries.every(entry => !Object.hasOwn(entry, 'content')));
      const imported = await store.importCollection(preview);
      assert.equal(imported.added, 2); assert.equal(imported.totalSnapshots, 3);
      const reopened = new ResearchStorage('isolated-test');
      for (const snapshot of original.snapshots) assert.deepEqual(await reopened.read(snapshot.id, snapshot.kind), snapshot);
      assert.equal((await reopened.read(kept.id, 'workflow')).name, kept.name);
      const snapshot = original.snapshots.find(row => row.kind === 'environmental')!;
      const replay = await replayEnvironmentalAnalysisRecord((await reopened.read(snapshot.id, 'environmental')).content);
      assert.equal(replay.record.resultId, record.resultId); assert.deepEqual(replay.dataset, dataset);
      assert.deepEqual(replay.record.fields, record.fields);
    });
  });
  it('exports every registered kind and preserves separately named identical-content snapshots', async () => {
    const rows = (Object.keys(RESEARCH_SNAPSHOT_TYPES) as ResearchSnapshotKind[]).map(kind => {
      const definition = RESEARCH_SNAPSHOT_TYPES[kind], methods: readonly string[] = definition.methods;
      return { kind, name: 'Named ' + kind, content: JSON.stringify({
        format: definition.format, version: 1, ...(methods.length ? { method: { id: methods[0] } } : {}),
      }) };
    });
    rows.push({ ...rows[0], name: 'A second named revision with the same body' });
    const exported = await savedCollection(rows), collection = await parseResearchCollection(exported);
    assert.equal(collection.snapshots.length, rows.length);
    assert.equal(new Set(collection.snapshots.map(row => row.kind)).size, Object.keys(RESEARCH_SNAPSHOT_TYPES).length);
    await fixture(async ({ store }) => {
      const first = await store.importCollection(await store.previewCollection(exported));
      assert.equal(first.added, rows.length);
      assert.equal(await store.exportCollection(), exported);
      let changes = 0; const off = store.subscribe(() => { changes++; });
      const preview = await store.previewCollection(exported);
      assert.equal(preview.additions, 0); assert.equal(preview.duplicates, rows.length);
      const again = await store.importCollection(preview);
      assert.equal(again.added, 0); assert.equal(again.duplicates, rows.length);
      assert.equal((await store.list()).length, rows.length); assert.equal(changes, 0); off();
      assert.equal((await store.list(rows[0].kind)).length, 2);
    });
  });
  it('routes region comparisons only to their dedicated replay panel', () => {
    const json = JSON.stringify({ format: 'phage-explorer-analysis', version: 1, method: { id: 'genome-region-comparison' } });
    assert(validateResearchSnapshotContent('region-comparison', json) > 0);
    assert.throws(() => validateResearchSnapshotContent('comparison', json), /match/);
    assert.throws(() => validateResearchSnapshotContent('region-comparison', JSON.stringify({
      format: 'phage-explorer-analysis', version: 1, method: { id: 'genome-comparison' },
    })), /match/);
  });
  it('rejects unknown fields, future versions, duplicate IDs, changed bodies and changed metadata before any import', async () => {
    const exported = await savedCollection([{ kind: 'genomes', name: 'Original name', content }]);
    const original = JSON.parse(exported);
    const changed = (modify: (value: typeof original) => void) => { const copy = structuredClone(original); modify(copy); return JSON.stringify(copy); };
    const invalid = [
      '{}', 'null', '{',
      changed(value => { value.version = 2; }),
      changed(value => { value.extra = 'not silently ignored'; }),
      changed(value => { value.snapshots[0].extra = 'not silently ignored'; }),
      changed(value => { value.snapshots[0].kind = 'future-kind'; }),
      changed(value => { value.snapshots.push(value.snapshots[0]); }),
      changed(value => { value.snapshots[0].name = 'Changed name'; }),
      changed(value => { value.snapshots[0].createdAt += 1; }),
      changed(value => { value.snapshots[0].content = content.replace('ACGTNN', 'TCGTNN'); }),
      changed(value => { value.snapshots[0].bytes += 1; }),
      changed(value => { value.manifestSha256 = 'f'.repeat(64); }),
    ];
    await fixture(async ({ store, data }) => {
      const kept = await store.save('genomes', 'Kept', content), before = structuredClone(data);
      for (const json of invalid) {
        await assert.rejects(store.previewCollection(json));
        assert.deepEqual(data, before);
      }
      assert.equal((await store.read(kept.id, 'genomes')).content, content);
    });
  });
  it('enforces decoded entry/byte limits and rejects an oversized file before reading it', async () => {
    const exported = await savedCollection([{ kind: 'genomes', name: 'Original', content }]);
    const original = JSON.parse(exported), snapshot = original.snapshots[0];
    const entries = (count: number, bytes: number) => JSON.stringify({ ...original,
      snapshots: Array.from({ length: count }, () => ({ ...snapshot, id: crypto.randomUUID(), bytes })) });
    await fixture(async ({ store, data }) => {
      const before = structuredClone(data);
      await assert.rejects(store.previewCollection(entries(65, snapshot.bytes)), /64 snapshot/);
      await assert.rejects(store.previewCollection(entries(7, RESEARCH_STORAGE_LIMITS.snapshotBytes)), /64 MiB/);
      await assert.rejects(store.previewCollection(entries(1, RESEARCH_STORAGE_LIMITS.snapshotBytes + 1)), /metadata/);
      let reads = 0;
      await assert.rejects(readLocalTextFile({ size: RESEARCH_COLLECTION_MAX_BYTES + 1,
        arrayBuffer: async () => { reads++; return new ArrayBuffer(0); } }, RESEARCH_COLLECTION_MAX_BYTES, new AbortController().signal), /129 MiB/);
      assert.equal(reads, 0); assert.deepEqual(data, before);
    });
  });
  it('rejects an entire collection for a same-ID metadata or body conflict instead of partially adding other rows', async () => {
    const exported = await savedCollection([
      { kind: 'genomes', name: 'A', content },
      { kind: 'genomes', name: 'B', content },
    ]);
    const source = await parseResearchCollection(exported);
    await fixture(async ({ store, data }) => {
      const firstOnly = await collectionText([source.snapshots[0]]);
      await store.importCollection(await store.previewCollection(firstOnly));
      const before = structuredClone(data);
      const changed = structuredClone(source.snapshots); changed[0].name = 'Same ID, different name';
      await assert.rejects(store.previewCollection(await collectionText(changed)), /conflicts/);
      assert.deepEqual(data, before);
      data.contents.set(changed[0].id, { id: changed[0].id, content: content.replace('ACGTNN', 'TCGTNN') });
      const corrupted = structuredClone(data);
      await assert.rejects(store.previewCollection(exported), /different contents/);
      assert.deepEqual(data, corrupted);
    });
  });
  it('owns preview bodies privately and refuses forged, mutated or foreign-store preview capabilities', async () => {
    const exported = await savedCollection([{ kind: 'genomes', name: 'Original', content }]);
    await fixture(async ({ store }) => {
      const preview = await store.previewCollection(exported);
      assert(Object.isFrozen(preview)); assert(Object.isFrozen(preview.entries)); assert(Object.isFrozen(preview.entries[0]));
      assert.equal(Reflect.set(preview.entries[0], 'name', 'Mutated'), false);
      assert.equal(Reflect.set(preview, 'additions', 0), false);
      await assert.rejects(store.importCollection(structuredClone(preview)), /Review the collection/);
      await assert.rejects(new ResearchStorage('isolated-test').importCollection(preview), /Review the collection/);
      const result = await store.importCollection(preview);
      assert.equal(result.added, 1); assert.equal((await store.list())[0].name, 'Original');
      await assert.rejects(store.importCollection(preview), /Review the collection/);
    });
  });
  it('aborts a stale review after another saved-library write and serializes simultaneous imports atomically', async () => {
    const exported = await savedCollection([
      { kind: 'genomes', name: 'First source', content },
      { kind: 'workflow', name: 'Whole workflow', content: JSON.stringify({ format: 'phage-explorer-commands', version: 1 }) },
    ]);
    await fixture(async ({ store, data }) => {
      const stale = await store.previewCollection(exported);
      const other = await store.save('genomes', 'Saved by another tab', content), before = structuredClone(data);
      await assert.rejects(store.importCollection(stale), /changed after collection review/);
      assert.deepEqual(data, before);
      const a = await store.previewCollection(exported), b = await store.previewCollection(exported);
      const results = await Promise.allSettled([store.importCollection(a), store.importCollection(b)]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(results.filter(result => result.status === 'rejected').length, 1);
      assert.equal((await store.list()).length, 3);
      assert.equal((await store.read(other.id, 'genomes')).content, content);
    });
  });
  it('rechecks duplicate body equality inside the write transaction after review', async () => {
    const exported = await savedCollection([
      { kind: 'genomes', name: 'Already present', content },
      { kind: 'genomes', name: 'New source', content },
    ]);
    const source = await parseResearchCollection(exported);
    await fixture(async ({ store, data }) => {
      await store.importCollection(await store.previewCollection(await collectionText([source.snapshots[0]])));
      const preview = await store.previewCollection(exported);
      data.contents.set(source.snapshots[0].id, { id: source.snapshots[0].id, content: content.replace('ACGTNN', 'TCGTNN') });
      const before = structuredClone(data);
      await assert.rejects(store.importCollection(preview), /different contents/);
      assert.deepEqual(data, before);
    });
  });
  it('checks global quotas across kinds before mutation without dropping named snapshots', async () => {
    const exported = await savedCollection([{ kind: 'genomes', name: 'Incoming', content }]);
    await fixture(async ({ store, data }) => {
      for (let i = 0; i < 64; i++) await store.save('workflow', 'Existing ' + i, JSON.stringify({ format: 'phage-explorer-commands', version: 1 }));
      const before = structuredClone(data);
      await assert.rejects(store.previewCollection(exported), /64 snapshots/);
      assert.deepEqual(data, before);
    });
    await fixture(async ({ store, data }) => {
      const existing = await store.save('genomes', 'Existing accounting fixture', content);
      // Represent 64 MiB of earlier library usage without allocating it in a control-flow test.
      let remaining = RESEARCH_STORAGE_LIMITS.totalBytes;
      data.metadata = new Map(); data.contents = new Map();
      while (remaining > 0) {
        const id = crypto.randomUUID(), bytes = Math.min(remaining, RESEARCH_STORAGE_LIMITS.snapshotBytes);
        data.metadata.set(id, { ...existing, id, bytes }); data.contents.set(id, { id, content }); remaining -= bytes;
      }
      const before = structuredClone(data);
      await assert.rejects(store.previewCollection(exported), /64 MiB/);
      assert.deepEqual(data, before);
    });
  });
  it('rolls back every metadata and body write on quota failure or cancellation and only notifies committed changes', async () => {
    const exported = await savedCollection([
      { kind: 'genomes', name: 'One', content }, { kind: 'genomes', name: 'Two', content },
    ]);
    await fixture(async ({ store, data, failNext, before, counts }) => {
      await store.save('genomes', 'Existing', content);
      const original = structuredClone(data), preview = await store.previewCollection(exported);
      let changes = 0; const off = store.subscribe(() => { changes++; });
      failNext('contents');
      await assert.rejects(store.importCollection(preview), { name: 'QuotaExceededError' });
      assert.deepEqual(data, original); assert.equal(changes, 0);
      const controller = new AbortController(); before(() => controller.abort());
      await assert.rejects(store.importCollection(preview, controller.signal), { name: 'AbortError' });
      assert.deepEqual(data, original); assert.equal(changes, 0);
      const stopped = new AbortController(); stopped.abort();
      const priorOpens = counts().opens;
      await assert.rejects(store.previewCollection(exported, stopped.signal), { name: 'AbortError' });
      await assert.rejects(store.importCollection(preview, stopped.signal), { name: 'AbortError' });
      assert.equal(counts().opens, priorOpens);
      const result = await store.importCollection(preview);
      assert.equal(result.added, 2); assert.equal(changes, 1);
      assert.equal(counts().opens, counts().closed); off();
    });
  });
  it('reports committed imports even if abort arrives just before the completion notification', async () => {
    const exported = await savedCollection([{ kind: 'genomes', name: 'One', content }]);
    await fixture(async ({ store, after }) => {
      const preview = await store.previewCollection(exported), controller = new AbortController();
      after(() => controller.abort());
      const result = await store.importCollection(preview, controller.signal);
      assert.equal(result.added, 1); assert.equal((await store.list()).length, 1);
    });
  });
  it('refuses complete export when even one stored body or metadata row is damaged or unsupported', () => fixture(async ({ store, data }) => {
    const intact = await store.save('genomes', 'Intact', content), bad = await store.save('genomes', 'Damaged', content);
    const original = structuredClone(data);
    data.contents.set(bad.id, { id: bad.id, content: content.replace('ACGTNN', 'TCGTNN') });
    await assert.rejects(store.exportCollection(), /checksum/);
    data.contents.set(bad.id, { id: bad.id, content }); data.metadata.set(bad.id, { ...bad, kind: 'future-kind' });
    await assert.rejects(store.exportCollection(), /unsupported/);
    data.metadata.set(bad.id, bad); data.contents.delete(bad.id);
    await assert.rejects(store.exportCollection(), /incomplete/);
    assert.equal((await store.read(intact.id, 'genomes')).content, content);
    assert.equal(data.metadata.size, original.metadata.size);
  }));
});

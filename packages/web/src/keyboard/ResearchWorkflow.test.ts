import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import type { AnalysisRecord, LocalGenome } from '@phage-explorer/core';
import { analysisJson, createAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { parseCommandTape, serializeCommandTape } from '../../../core/src/command-session';
import { ResearchWorkflow, validateResearchView, validateResearchSpacers, researchSpacerParameters, researchSpacerGenome,
  type ResearchEnvironment, type ResearchView } from './ResearchWorkflow';
import { createGCSkewRecord } from '../../../core/src/analysis/gc-skew';
import { importLocalGenomes, exportLocalGenomeBundle } from '../../../core/src/genome-import';
import { parseWorkflowResults, workflowResultIndex } from '../../../core/src/workflow-results';
import { SPACER_METHOD, SPACER_LIMITS, searchSpacerReferences, createSpacerRecord,
  type SpacerLibrary, type ReferenceSpacerHit } from '../../../core/src/analysis/spacer-reference';

const ids = { view: 'nav.goto', repeats: 'overlay.repeats', codons: 'overlay.codonAdaptation' };
const id = 'a'.repeat(64);
const initialView: ResearchView = { contentId: id, viewMode: 'dna', readingFrame: 0, scrollPosition: 0, geneId: null };
const genome = { sequence: 'ATGAAACCCGGGTTTCAT', original: { name: 'private.gb', text: 'exact source input' }, warnings: [],
  phage: { id: -1, name: 'Private record', accession: 'LOCAL', localGenome: { contentId: id, sequenceSha256: 'b'.repeat(64), format: 'genbank', topology: 'linear' },
    genes: [{ id: 1, type: 'CDS', locusTag: 'joined', startPos: 0, endPos: 18, strand: '-',
      qualifiers: { _location: 'complement(join(1..6,13..18))', _segments: [{ start: 12, end: 18, strand: '-' }, { start: 0, end: 6, strand: '-' }] } }] },
} as unknown as LocalGenome;
const evidence = (resultId = 'c'.repeat(64)) => ({ method: { id: 'test-method', version: '1', implementation: 'test adapter' }, cacheKey: 'd'.repeat(64), resultId }) as AnalysisRecord;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture() {
  const loaded = [structuredClone(genome)];
  let view = structuredClone(initialView), calculations = 0, parsing = 0;
  const env: ResearchEnvironment = {
    genomes: () => loaded, bundle: () => 'exact exported source bundle',
    parseBundle: async () => { parsing++; return { genomes: [structuredClone(genome)] }; },
    currentView: () => view,
    applyView: async next => { view = next; },
    repeats: async () => { calculations++; return evidence(); },
    codons: async () => { calculations++; return evidence(); },
  };
  const workflow = new ResearchWorkflow(ids, env);
  workflow.start('Private commands');
  return { workflow, env, loaded, view: () => view, calculations: () => calculations, parsing: () => parsing };
}
const navigate = (workflow: ResearchWorkflow, position: number) => workflow.commands.dispatch(ids.view, analysisJson({ ...initialView, scrollPosition: position, geneId: 1 }));
const codons = (workflow: ResearchWorkflow) => workflow.commands.dispatch(ids.codons, { contentId: id, geneId: 1 });

describe('recorded sourced spacer comparisons', () => {
  const action = 'overlay.crispr', gcAction = 'overlay.gcSkew';
  // Literal independent loci: forward [4,24), reverse [34,54), both with guide-oriented AGG PAMs.
  const sequence = 'TTTTACGTCAGTTGACCTAGTGCAAGGTTTTCCTTGCACTAGGTCAACTGACGTTTTT';
  const library: SpacerLibrary = {
    format: 'phage-explorer-spacer-library', version: 1, name: 'Synthetic rule-and-strand fixture',
    source: { kind: 'demo', reference: 'Hand-constructed source fixture', version: 'fixture-1', license: 'CC0', scope: 'Two synthetic strains with the same label' },
    hosts: [{ id: 'strain-a', name: 'Shared host label', strain: 'A', accession: 'synthetic:A' },
      { id: 'strain-b', name: 'Shared host label', strain: 'B', accession: 'synthetic:B' }],
    spacers: [{ id: 'guide-a', hostId: 'strain-a', arrayAccession: 'synthetic:array-A', sequence: 'ACGTCAGTTGACCTAGTGCA',
      system: null, target: 'DNA', orientation: 'guide-equivalent',
      pam: { side: '3prime', motif: 'NGG', reference: 'Synthetic oriented PAM rule' },
      seed: { start: 12, end: 20, maxMismatches: 0, reference: 'Synthetic seed rule' } },
    { id: 'guide-b', hostId: 'strain-b', arrayAccession: 'synthetic:array-B', sequence: 'AAAAAAAAAAAAAAAAAAAA',
      system: null, target: 'DNA', orientation: 'guide-equivalent', pam: null, seed: null }],
  };
  async function spacerFixture(fasta = `>query [topology=linear]\n${sequence}\n`) {
    const parsed = await importLocalGenomes({ name: 'spacer.fa', text: fasta });
    const loaded = structuredClone(parsed.genomes), bundle = exportLocalGenomeBundle(parsed.genomes);
    let view: ResearchView | null = null, calls = 0;
    const env: ResearchEnvironment = {
      genomes: () => loaded, bundle: () => bundle,
      parseBundle: content => importLocalGenomes({ name: 'bundle.json', text: content }), currentView: () => view,
      applyView: async next => { view = structuredClone(next); },
      repeats: async () => { throw new Error('Legacy repeats are not used in this fixture.'); },
      codons: async () => { throw new Error('Illustrative codons are not used in this fixture.'); },
      gcSkew: (genome, options) => createGCSkewRecord(genome.sequence, options, { accession: genome.phage.accession, source: 'local' }),
      spacers: async (genome, reference, options) => {
        calls++;
        return createSpacerRecord(genome, reference, searchSpacerReferences(genome, reference, options));
      },
    };
    const workflow = new ResearchWorkflow({ ...ids, spacers: action, gcSkew: gcAction }, env);
    workflow.start('Private spacer and composition workflow');
    const contentId = loaded[0].phage.localGenome!.contentId;
    const parameters = researchSpacerParameters(contentId, JSON.stringify(library), 'linear', { hostId: 'strain-a', maxMismatches: 0 });
    return { workflow, env, loaded, parameters, contentId, calls: () => calls };
  }
  it('records literal strand/PAM/seed evidence and complete reference provenance for fresh replay', async () => {
    const f = await spacerFixture();
    await f.workflow.commands.dispatch(action, analysisJson(f.parameters));
    const record = f.workflow.getSnapshot().result!;
    const hits = record.fields.matches.value as unknown as ReferenceSpacerHit[];
    assert.deepEqual(hits.map(hit => ({ start: hit.start, end: hit.end, strand: hit.strand,
      pam: hit.pam.sequence, pamStatus: hit.pam.status, seed: hit.seed, mismatches: hit.mismatchPositions })), [
      { start: 4, end: 24, strand: '+', pam: 'AGG', pamStatus: 'matched', seed: { status: 'matched', mismatches: 0 }, mismatches: [] },
      { start: 34, end: 54, strand: '-', pam: 'AGG', pamStatus: 'matched', seed: { status: 'matched', mismatches: 0 }, mismatches: [] },
    ]);
    assert.deepEqual(record.method, SPACER_METHOD);
    assert.equal(record.inputs[0].source, 'local');
    assert.deepEqual(record.inputs[1].data, analysisJson(library));
    assert.equal(record.inputs[1].source, 'demo');
    assert.equal(record.fields.matches.kind, 'demo');
    assert.equal(record.seed, null);
    f.workflow.commands.stop(); const tape = f.workflow.commands.export();
    assert.deepEqual(parseCommandTape(tape).commands[0].parameters, analysisJson(f.parameters));
    f.workflow.load(tape); await f.workflow.commands.replay();
    assert.equal(f.calls(), 2);
    assert.notStrictEqual(f.workflow.getSnapshot().result, record);
    assert.equal(serializeAnalysisRecord(f.workflow.getSnapshot().result!), serializeAnalysisRecord(record));
  });
  it('uses exact host IDs and retains both analyses through mixed tapes and complete archive replay', async () => {
    const f = await spacerFixture();
    await f.workflow.commands.dispatch(action, analysisJson(f.parameters));
    const positive = f.workflow.getSnapshot().result!;
    await f.workflow.commands.dispatch(action, analysisJson({ ...f.parameters, hostId: 'strain-b' }));
    const negative = f.workflow.getSnapshot().result!;
    assert.notEqual(negative.cacheKey, positive.cacheKey);
    assert.deepEqual(negative.fields.matches.value, []);
    assert.equal((negative.fields.coverage.value as { status: string }).status, 'no-sequence-match');
    await f.workflow.commands.dispatch(gcAction, { contentId: f.contentId, windowSize: 4, stepSize: 4 });
    await f.workflow.commands.dispatch(ids.view, { contentId: f.contentId, geneId: null, scrollPosition: 2, viewMode: 'dna', readingFrame: 0 });
    f.workflow.commands.stop();
    const archiveText = await f.workflow.replayWithResults(2), archive = await parseWorkflowResults(archiveText);
    assert.equal(archive.records.length, 3);
    assert.deepEqual(archive.records[0].fields.matches.value, positive.fields.matches.value);
    assert.deepEqual(workflowResultIndex(archive.tapeJson, 2).map(row => row.analysis?.method.id ?? null),
      [SPACER_METHOD.id, SPACER_METHOD.id, 'sequence-gc-skew', null, SPACER_METHOD.id, SPACER_METHOD.id, 'sequence-gc-skew', null]);
    assert.equal(f.workflow.getSnapshot().result, null);
    assert.equal(await f.workflow.verifyCompleteResults(archiveText), archiveText);
  });
  it('requires explicit bounded reference/settings and known hosts before computing', async () => {
    const f = await spacerFixture();
    for (const change of [{ hostId: 'unknown' }, { maxMismatches: null }, { maxMismatches: 6 }, { hostId: ' strain-a ' },
      { topology: ['linear'] }, { libraryText: '/path/to/library.json' }, { ignored: true }]) {
      await assert.rejects(f.workflow.commands.dispatch(action, analysisJson({ ...f.parameters, ...change })));
    }
    const { maxMismatches: _omitted, ...implicit } = f.parameters;
    assert.throws(() => validateResearchSpacers(analysisJson(implicit)));
    assert.throws(() => researchSpacerParameters(f.contentId, ' '.repeat(SPACER_LIMITS.libraryBytes + 1), 'linear'), /2 MiB/);
    assert.equal(f.calls(), 0);
    assert.deepEqual(researchSpacerParameters(f.contentId, JSON.stringify(library), 'linear'),
      { ...f.parameters, hostId: null, maxMismatches: 0 });
  });
  it('rejects topology contradictions while permitting explicit circular searches for unknown source topology', async () => {
    const f = await spacerFixture();
    await assert.rejects(f.workflow.commands.dispatch(action, analysisJson({ ...f.parameters, topology: 'circular' })), /conflicts/);
    await assert.rejects(f.workflow.commands.dispatch(action, analysisJson({ ...f.parameters, topology: 'unknown' })), /conflicts/);
    assert.equal(f.calls(), 0);
    const unknown = structuredClone(f.loaded[0]); unknown.phage.localGenome!.topology = 'unknown';
    assert.equal(researchSpacerGenome(unknown, 'circular').topology, 'circular');
    assert.equal(researchSpacerGenome(unknown, 'unknown').topology, 'unknown');
  });
  it('records an explicitly circular origin-crossing match without treating unknown topology as circular', async () => {
    // The 20-base guide starts at 18, spans the 27-base origin and ends at 11; its PAM is [11,14).
    const f = await spacerFixture('>circle-without-topology-annotation\nGACCTAGTGCAAGGTTTTACGTCAGTT\n');
    assert.equal(f.loaded[0].phage.localGenome!.topology, 'unknown');
    await f.workflow.commands.dispatch(action, analysisJson({ ...f.parameters, topology: 'unknown' }));
    assert.deepEqual(f.workflow.getSnapshot().result!.fields.matches.value, []);
    await f.workflow.commands.dispatch(action, analysisJson({ ...f.parameters, topology: 'circular' }));
    const accepted = f.workflow.getSnapshot().result!, hits = accepted.fields.matches.value as unknown as ReferenceSpacerHit[];
    assert.equal(hits.length, 1);
    assert.deepEqual({ start: hits[0].start, end: hits[0].end, strand: hits[0].strand, wraps: hits[0].wrapsOrigin,
      segments: hits[0].segments, pam: hits[0].pam.sequence, pamSegments: hits[0].pam.segments },
    { start: 18, end: 38, strand: '+', wraps: true, segments: [{ start: 18, end: 27 }, { start: 0, end: 11 }],
      pam: 'AGG', pamSegments: [{ start: 11, end: 14 }] });
    f.workflow.commands.stop(); await f.workflow.commands.replay();
    assert.equal(f.workflow.getSnapshot().result!.resultId, accepted.resultId);
  });
  it('preserves a user-supplied library as sequence evidence without promoting matches to observations', async () => {
    const f = await spacerFixture(), localLibrary = { ...library, source: { ...library.source, kind: 'local' } };
    await f.workflow.commands.dispatch(action, analysisJson({ ...f.parameters, libraryText: JSON.stringify(localLibrary) }));
    const record = f.workflow.getSnapshot().result!;
    assert.equal(record.inputs[1].source, 'local');
    assert.equal(record.fields.matches.kind, 'sequence-score');
    assert.equal(record.fields.coverage.kind, 'sequence-score');
    assert.ok(record.fields.matches.limitations.some(limit => limit.includes('do not establish interference')));
  });
  it('refuses substituted genome, reference, settings, method, seed and evidence kind without losing accepted evidence', async () => {
    const f = await spacerFixture();
    await f.workflow.commands.dispatch(action, analysisJson(f.parameters));
    const accepted = f.workflow.getSnapshot().result, execute = f.env.spacers!;
    const substitutions: NonNullable<ResearchEnvironment['spacers']>[] = [
      (genome, library, options, signal) => execute({ ...genome, sequence: 'A'.repeat(genome.sequence.length) }, library, options, signal),
      (genome, library, options, signal) => execute(genome, { ...library, source: { ...library.source, version: 'different' } }, options, signal),
      (genome, library, options, signal) => execute(genome, library, { ...options, maxMismatches: 1 }, signal),
      async (genome, library, options, signal) => {
        const record = await execute(genome, library, options, signal);
        return createAnalysisRecord({ ...record, method: { ...record.method, version: '999' } });
      },
      async (genome, library, options, signal) => {
        const record = await execute(genome, library, options, signal);
        return createAnalysisRecord({ ...record, seed: 'unrecorded' });
      },
      async (genome, library, options, signal) => {
        const record = await execute(genome, library, options, signal);
        return createAnalysisRecord({ ...record, references: record.references.map((reference, i) =>
          i === 0 ? { ...reference, version: 'substituted-source' } : reference) });
      },
      async (genome, library, options, signal) => {
        const record = await execute(genome, library, options, signal), matches = record.fields.matches;
        // A valid rehashed record must not promote demonstration matches into observed/real evidence.
        return createAnalysisRecord({ ...record, fields: { ...record.fields,
          matches: { label: matches.label, kind: 'sequence-score', units: 'records', value: matches.value,
            coverage: matches.coverage, limitations: matches.limitations } } });
      },
    ];
    for (const substitute of substitutions) {
      f.env.spacers = substitute;
      await assert.rejects(f.workflow.commands.dispatch(action, analysisJson(f.parameters)), /does not match/);
      assert.strictEqual(f.workflow.getSnapshot().result, accepted);
      assert.equal(f.workflow.commands.getSnapshot().tape.commands.length, 1);
    }
  });
  it('snapshots provider inputs and refuses changed loaded genomes before accepting a response', async () => {
    const f = await spacerFixture(), execute = f.env.spacers!;
    f.env.spacers = async (genome, library, options, signal) => {
      const record = await execute(genome, library, options, signal);
      genome.sequence = 'changed'; library.source.version = 'changed'; options.maxMismatches = 5;
      return record;
    };
    await f.workflow.commands.dispatch(action, analysisJson(f.parameters));
    const accepted = f.workflow.getSnapshot().result;
    assert.equal(f.loaded[0].sequence, sequence);
    f.env.spacers = async (...args) => {
      const record = await execute(...args);
      f.loaded[0].sequence = 'A'.repeat(sequence.length);
      return record;
    };
    await assert.rejects(f.workflow.commands.dispatch(action, analysisJson(f.parameters)), /changed sequence/);
    assert.strictEqual(f.workflow.getSnapshot().result, accepted);
    const calls = f.calls();
    await assert.rejects(f.workflow.commands.dispatch(action, analysisJson(f.parameters)), /changed sequence/);
    assert.equal(f.calls(), calls, 'already changed sources must be rejected before computation');
  });
  it('settles cancellation promptly and ignores a late otherwise-valid worker response', async () => {
    const f = await spacerFixture();
    await f.workflow.commands.dispatch(action, analysisJson(f.parameters));
    const accepted = f.workflow.getSnapshot().result!, pending = deferred<AnalysisRecord>();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.env.spacers = () => { entered(); return pending.promise; };
    const task = f.workflow.commands.dispatch(action, analysisJson(f.parameters)); await started;
    f.workflow.commands.cancel(); await assert.rejects(task, { name: 'AbortError' });
    pending.resolve(structuredClone(accepted)); await flush();
    assert.strictEqual(f.workflow.getSnapshot().result, accepted);
    assert.strictEqual(f.workflow.getSnapshot().lastAnalysis, accepted);
    assert.equal(f.workflow.commands.getSnapshot().tape.commands.length, 1);
  });
  it('requires paired executors and distinct canonical actions', async () => {
    const f = await spacerFixture();
    assert.throws(() => new ResearchWorkflow({ ...ids, gcSkew: gcAction }, f.env), /supplied together/);
    assert.throws(() => new ResearchWorkflow({ ...ids, gcSkew: gcAction, spacers: ids.view }, f.env), /distinct/);
    const { spacers: _missing, ...withoutSpacer } = f.env;
    assert.throws(() => new ResearchWorkflow({ ...ids, gcSkew: gcAction, spacers: action }, withoutSpacer), /supplied together/);
  });
});

describe('recorded portable GC skew', () => {
  const action = 'overlay.gcSkew';
  function gcFixture() {
    const base = fixture();
    base.env.gcSkew = (genome, options) => createGCSkewRecord(genome.sequence, options, { accession: genome.phage.accession, source: 'local' });
    const workflow = new ResearchWorkflow({ ...ids, gcSkew: action }, base.env); workflow.start('Portable GC');
    return { ...base, workflow, parameters: { contentId: id, windowSize: 4, stepSize: 3 } };
  }
  it('records explicit parameters and recomputes the same result after loading the tape', async () => {
    const f = gcFixture(); await f.workflow.commands.dispatch(action, f.parameters);
    const result = f.workflow.getSnapshot().result!; f.workflow.commands.stop();
    const saved = f.workflow.commands.export(); f.workflow.load(saved);
    assert.equal(f.workflow.getSnapshot().result, null);
    await f.workflow.commands.replay();
    assert.deepEqual(f.workflow.getSnapshot().result, result);
    assert.deepEqual(parseCommandTape(saved).commands[0].parameters, f.parameters);
  });
  it('retains accepted evidence after navigation and history without assigning it to navigation outputs', async () => {
    const f = gcFixture(); await f.workflow.commands.dispatch(action, f.parameters);
    const accepted = f.workflow.getSnapshot().result;
    await navigate(f.workflow, 2); await navigate(f.workflow, 4);
    await f.workflow.moveHistory(-1); await f.workflow.moveHistory(1);
    assert.equal(f.workflow.getSnapshot().result, null);
    assert.strictEqual(f.workflow.getSnapshot().lastAnalysis, accepted);
    f.workflow.commands.stop(); const tape = f.workflow.commands.export();
    f.workflow.load(tape);
    assert.equal(f.workflow.getSnapshot().lastAnalysis, null, 'loading a tape must not present a previous tape result');
    await f.workflow.commands.replay(2);
    assert.equal(f.workflow.getSnapshot().result, null, 'navigation remains a non-analysis command for native attribution');
    assert.deepEqual(f.workflow.getSnapshot().lastAnalysis, accepted);
    assert.notStrictEqual(f.workflow.getSnapshot().lastAnalysis, accepted, 'retained replay evidence must be freshly computed');
    f.workflow.start('New experiment');
    assert.equal(f.workflow.getSnapshot().lastAnalysis, null);
  });
  it('rejects substituted inputs/settings and stale completion before publishing an accepted result', async () => {
    const f = gcFixture(); await f.workflow.commands.dispatch(action, f.parameters);
    const accepted = f.workflow.getSnapshot().result;
    const execute = f.env.gcSkew!;
    f.env.gcSkew = (genome, options, signal) => execute(genome, { ...options, stepSize: 1 }, signal);
    await assert.rejects(f.workflow.commands.dispatch(action, f.parameters), /does not match/);
    assert.strictEqual(f.workflow.getSnapshot().result, accepted);
    const pending = deferred<AnalysisRecord>(); let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.env.gcSkew = () => { entered(); return pending.promise; };
    const task = f.workflow.commands.dispatch(action, f.parameters); await started;
    f.workflow.commands.cancel(); await assert.rejects(task, { name: 'AbortError' });
    pending.resolve(await execute(f.loaded[0], { windowSize: f.parameters.windowSize, stepSize: f.parameters.stepSize }, new AbortController().signal)); await flush();
    assert.strictEqual(f.workflow.getSnapshot().result, accepted);
    assert.strictEqual(f.workflow.getSnapshot().lastAnalysis, accepted);
    assert.equal(f.workflow.commands.getSnapshot().tape.commands.length, 1);
  });
  it('rejects missing parameters and altered live genomes without running the GC producer', async () => {
    const f = gcFixture(); let computations = 0;
    const execute = f.env.gcSkew!; f.env.gcSkew = (...args) => { computations++; return execute(...args); };
    for (const parameters of [{ contentId: id, windowSize: 4 }, { ...f.parameters, stepSize: 0 }, { ...f.parameters, windowSize: 2.5 }, { ...f.parameters, circular: true }]) {
      await assert.rejects(f.workflow.commands.dispatch(action, parameters));
    }
    f.loaded[0].sequence = 'G'.repeat(f.loaded[0].sequence.length);
    await assert.rejects(f.workflow.commands.dispatch(action, f.parameters), /changed sequence/);
    assert.equal(computations, 0);
  });
});

describe('content-bound research command adapters', () => {
  it('records original inputs and absolute genome/CDS/frame/position commands', async () => {
    const f = fixture();
    await f.workflow.commands.dispatch(ids.view, analysisJson({ ...initialView, viewMode: 'dual', readingFrame: -2, scrollPosition: 12, geneId: 1 }));
    await codons(f.workflow); f.workflow.commands.stop();
    const tape = parseCommandTape(f.workflow.commands.export());
    assert.deepEqual(tape.context, { bundle: 'exact exported source bundle' });
    assert.deepEqual(tape.commands.map(c => c.actionId), [ids.view, ids.codons]);
    assert.equal(f.view().readingFrame, -2);
    assert.equal(f.view().geneId, 1);
    await f.workflow.commands.replay();
    assert.equal(f.calculations(), 2);
    assert.equal(f.workflow.getSnapshot().result!.resultId, 'c'.repeat(64));
  });
  it('validates a context once but checks actual loaded sequence and annotation data on every command', async () => {
    const f = fixture();
    await navigate(f.workflow, 1); await navigate(f.workflow, 2);
    assert.equal(f.parsing(), 1);
    f.loaded[0].sequence = 'C'.repeat(genome.sequence.length);
    await assert.rejects(codons(f.workflow), /changed sequence or annotations/);
    assert.equal(f.calculations(), 0);
    f.loaded[0] = structuredClone(genome);
    f.loaded[0].phage.genes[0].qualifiers!._location = '1..6';
    await assert.rejects(codons(f.workflow), /annotations/);
  });
  it('rejects missing inputs or commands outside the bundled genomes without computing', async () => {
    const f = fixture(); f.loaded.length = 0;
    await assert.rejects(codons(f.workflow), /Missing local genome/);
    f.loaded.push(structuredClone(genome));
    await assert.rejects(f.workflow.commands.dispatch(ids.codons, { contentId: 'f'.repeat(64), geneId: 1 }), /outside/);
    assert.equal(f.calculations(), 0);
  });
  it('preserves exact joined/complement qualifiers and gives the backend isolated inputs', async () => {
    const f = fixture();
    f.env.codons = async (input, selected) => {
      assert.equal(selected, 1);
      assert.deepEqual(input.phage.genes[0].qualifiers, genome.phage.genes[0].qualifiers);
      input.sequence = 'mutated'; input.phage.genes.length = 0;
      return evidence();
    };
    await assert.rejects(codons(f.workflow), /changed sequence or annotations/, 'backend mutation must not publish an incorrectly bound result');
    assert.deepEqual(f.loaded[0], genome);
  });
  it('rejects invalid command fields, out-of-bounds views, wrong CDS and unsupported frames', async () => {
    const f = fixture();
    await assert.rejects(navigate(f.workflow, 100), /outside/);
    await assert.rejects(f.workflow.commands.dispatch(ids.codons, { contentId: id, geneId: 999 }), /CDS/);
    await assert.rejects(f.workflow.commands.dispatch(ids.repeats, { contentId: id, minLength: 3, maxGap: 1 }), /integer/);
    await assert.rejects(f.workflow.commands.dispatch(ids.repeats, { contentId: id, minLength: 8, maxGap: 1, ignored: true }), /parameters/);
    for (const extra of [{ readingFrame: '0' }, { viewMode: 'protein' }, { geneId: -1 }, { scrollPosition: NaN }]) {
      assert.throws(() => validateResearchView({ ...initialView, ...extra } as never));
    }
    assert.equal(f.calculations(), 0);
  });
  it('undo/redo restores absolute views and a new branch discards forward history', async () => {
    const f = fixture();
    await navigate(f.workflow, 2); await navigate(f.workflow, 4);
    await f.workflow.moveHistory(-1); assert.equal(f.view().scrollPosition, 2);
    assert.equal(f.workflow.getSnapshot().redoAvailable, true);
    await f.workflow.moveHistory(1); assert.equal(f.view().scrollPosition, 4);
    await f.workflow.moveHistory(-1); await navigate(f.workflow, 7);
    assert.equal(f.workflow.getSnapshot().redoAvailable, false);
    await assert.rejects(f.workflow.moveHistory(1), /No saved view/);
    const tape = f.workflow.commands.getSnapshot().tape;
    assert.deepEqual(tape.commands.map(c => (c.parameters as { scrollPosition: number }).scrollPosition), [2, 4, 2, 4, 2, 7]);
  });
  it('failed history navigation does not move its pointer or erase the current view', async () => {
    const f = fixture(); await navigate(f.workflow, 2); await navigate(f.workflow, 4);
    f.loaded.length = 0;
    await assert.rejects(f.workflow.moveHistory(-1), /Missing/);
    assert.equal(f.view().scrollPosition, 4);
    assert.equal(f.workflow.getSnapshot().redoAvailable, false);
  });
  it('rejects changed method/reference result identity before installing a replay result', async () => {
    const f = fixture(); await codons(f.workflow); f.workflow.commands.stop();
    const previous = f.workflow.getSnapshot().result;
    f.env.codons = async () => evidence('f'.repeat(64));
    await assert.rejects(f.workflow.commands.replay(), /differs/);
    assert.strictEqual(f.workflow.getSnapshot().result, previous);
  });
  it('replay installs newly computed evidence rather than a saved result', async () => {
    const f = fixture(); await codons(f.workflow); f.workflow.commands.stop();
    const previous = f.workflow.getSnapshot().result;
    await f.workflow.commands.replay();
    assert.notStrictEqual(f.workflow.getSnapshot().result, previous);
    assert.deepEqual(f.workflow.getSnapshot().result, previous);
  });
  it('late cancelled computation cannot replace accepted evidence', async () => {
    const f = fixture(); await codons(f.workflow);
    const previous = f.workflow.getSnapshot().result, pending = deferred<AnalysisRecord>();
    f.env.codons = () => pending.promise;
    const task = codons(f.workflow); await flush();
    f.workflow.commands.cancel();
    await assert.rejects(task, { name: 'AbortError' });
    pending.resolve(evidence('f'.repeat(64))); await flush();
    assert.strictEqual(f.workflow.getSnapshot().result, previous);
  });
  it('checks loaded input again after worker computation and before publication', async () => {
    const f = fixture(), pending = deferred<AnalysisRecord>();
    f.env.codons = () => pending.promise;
    const task = codons(f.workflow); await flush();
    f.loaded[0].sequence = 'different'; pending.resolve(evidence());
    await assert.rejects(task, /changed sequence/);
    assert.equal(f.workflow.getSnapshot().result, null);
  });
  it('loading a tape and reviewing bundled inputs do not add inputs or navigate', async () => {
    const f = fixture(); await navigate(f.workflow, 2); f.workflow.commands.stop();
    const content = f.workflow.commands.export();
    f.workflow.load(content);
    const parsed = await f.workflow.bundledInputs(new AbortController().signal);
    assert.deepEqual(parsed.genomes, [genome]);
    assert.equal(f.view().scrollPosition, 2);
    assert.equal(f.workflow.getSnapshot().view, null);
    assert.equal(f.loaded.length, 1);
    await f.workflow.commands.replay(); assert.equal(f.workflow.getSnapshot().view?.scrollPosition, 2);
  });
  it('a changed genome in a saved context is rejected even when action parameters still name an old content ID', async () => {
    const f = fixture(); await navigate(f.workflow, 2); f.workflow.commands.stop();
    const tape = parseCommandTape(f.workflow.commands.export()); tape.context = { bundle: 'modified source bundle' };
    f.workflow.load(serializeCommandTape(tape));
    f.env.parseBundle = async () => ({ genomes: [{ ...structuredClone(genome), sequence: 'changed original input' }] });
    await assert.rejects(f.workflow.commands.replay(), /changed sequence/);
  });
});

it('failed and cancelled private input review preserve the previously accepted tape and result', async () => {
  const f = fixture(); await codons(f.workflow); f.workflow.commands.stop();
  const tape = f.workflow.commands.export(), previous = f.workflow.getSnapshot().result;
  const pending = deferred<{ genomes: LocalGenome[] }>();
  f.env.parseBundle = () => pending.promise;
  const controller = new AbortController();
  const task = f.workflow.loadAndReview(tape, controller.signal);
  controller.abort(); pending.resolve({ genomes: [genome] });
  await assert.rejects(task, { name: 'AbortError' });
  assert.equal(f.workflow.commands.export(), tape);
  assert.strictEqual(f.workflow.getSnapshot().result, previous);
  f.env.parseBundle = async () => { throw new Error('invalid genome bundle'); };
  await assert.rejects(f.workflow.loadAndReview(tape, new AbortController().signal), /invalid genome/);
  assert.strictEqual(f.workflow.getSnapshot().result, previous);
});


it('starting a new recording clears prior results and navigation history without altering the explorer', async () => {
  const f = fixture();
  await navigate(f.workflow, 2); await codons(f.workflow); f.workflow.commands.stop();
  assert.ok(f.workflow.getSnapshot().result);
  f.workflow.start('New experiment');
  assert.equal(f.workflow.getSnapshot().result, null);
  assert.equal(f.workflow.getSnapshot().undoAvailable, false);
  assert.equal(f.workflow.commands.getSnapshot().tape.commands.length, 0);
  assert.equal(f.view().scrollPosition, 2);
});

it('a host that ignores a saved view cannot record or verify successful navigation', async () => {
  const f = fixture();
  f.env.applyView = async () => {};
  await assert.rejects(navigate(f.workflow, 2), /did not accept/);
  assert.equal(f.workflow.commands.getSnapshot().tape.commands.length, 0);
  assert.equal(f.workflow.getSnapshot().view, null);
  assert.equal(f.workflow.getSnapshot().undoAvailable, false);
});


it('amino-acid view bounds use residue positions rather than nucleotide positions', async () => {
  const f = fixture();
  await assert.rejects(f.workflow.commands.dispatch(ids.view, analysisJson({ ...initialView, viewMode: 'aa', scrollPosition: 6 })), /outside/);
  await f.workflow.commands.dispatch(ids.view, analysisJson({ ...initialView, viewMode: 'aa', scrollPosition: 5 }));
  assert.equal(f.view().scrollPosition, 5);
});

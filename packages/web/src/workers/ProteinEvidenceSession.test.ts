import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import snapshot from '../../../../data/protein-references/lambda-lamb-v1.json';
import { createAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { parseProteinReferenceBundle, parseProteinAlignmentFasta, PROTEIN_ALIGNMENT_LIMITS, prepareProteinCoordinateInput, PROTEIN_COORDINATE_LIMITS } from '../../../core/src/protein-reference';
import { type ProteinStructureOptions } from '../../../core/src/analysis/tail-fiber-structure';
import {
  ProteinEvidenceSession, executeProteinEvidenceRequest, readProteinEvidenceFile,
  type ProteinEvidenceWorker, type ProteinEvidenceRequest, type ProteinEvidenceMessage, type ProteinEvidenceOrigin,
} from './ProteinEvidenceSession';

const origin: ProteinEvidenceOrigin = { kind: 'reference-file', name: 'exact-reference.json' };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function request(options: ProteinStructureOptions = {}): Promise<ProteinEvidenceRequest> {
  return { kind: 'analyze', reference: await parseProteinReferenceBundle(snapshot), options };
}
class WorkerProbe implements ProteinEvidenceWorker {
  onmessage: ProteinEvidenceWorker['onmessage'] = null;
  onerror: ProteinEvidenceWorker['onerror'] = null;
  onmessageerror: ProteinEvidenceWorker['onmessageerror'] = null;
  requests: ProteinEvidenceRequest[] = [];
  terminated = 0;
  postMessage(value: ProteinEvidenceRequest) { this.requests.push(value); }
  terminate() { this.terminated++; }
  emit(message: ProteinEvidenceMessage) { this.onmessage?.({ data: message } as MessageEvent<ProteinEvidenceMessage>); }
}
function workspace() {
  const workers: WorkerProbe[] = [], scope = { repository: {}, phage: { id: 1 }, selectedGeneId: 42 };
  const session = new ProteinEvidenceSession(() => { const worker = new WorkerProbe(); workers.push(worker); return worker; });
  session.activate(); session.setScope(scope); return { workers, session, scope };
}

describe('protein evidence worker operations', () => {
  it('loads the exact portable reference without running geometry', async () => {
    const result = await executeProteinEvidenceRequest({ kind: 'inspect', content: JSON.stringify(snapshot) });
    assert.equal(result.kind, 'reference');
    if (result.kind !== 'reference') throw new Error('Expected reference');
    assert.deepEqual(result.reference, snapshot);
    assert.equal('experiment' in result, false);
  });
  it('computes all real residues and verifies numerical replay with preserved source identity', async () => {
    const first = await executeProteinEvidenceRequest(await request({ contactCutoffAngstrom: 15 }));
    assert.equal(first.kind, 'experiment');
    if (first.kind !== 'experiment') throw new Error('Expected experiment');
    assert.equal(first.experiment.result.protein.length, 1132);
    assert.equal(first.experiment.result.coverage.coordinateResidues, 420);
    assert.equal(first.experiment.result.coverage.interchainContacts, 1);
    assert.equal(first.experiment.result.residues[33].alignment!.entropyBits, null);
    const replay = await executeProteinEvidenceRequest({ kind: 'replay', content: serializeAnalysisRecord(first.experiment.record) });
    if (replay.kind !== 'experiment') throw new Error('Expected replay');
    assert.equal(replay.verified, true);
    assert.equal(replay.experiment.record.resultId, first.experiment.record.resultId);
    assert.deepEqual(replay.experiment.reference, snapshot);
  });
  it('rejects rehashed invented geometry on the actual replay path', async () => {
    const first = await executeProteinEvidenceRequest(await request());
    if (first.kind !== 'experiment') throw new Error('Expected experiment');
    const forged = structuredClone(first.experiment.record);
    forged.fields.structure.value = { invented: true };
    const signed = await createAnalysisRecord(forged);
    await assert.rejects(executeProteinEvidenceRequest({ kind: 'replay', content: serializeAnalysisRecord(signed) }), /differ|recomput|identity/i);
  });
  it('rejects oversized and malformed UTF-8 files, including dishonest size metadata', async () => {
    await assert.rejects(readProteinEvidenceFile({ size: 600000, arrayBuffer: async () => { throw new Error('Must not read oversized input'); } }, 'reference'), /limit/);
    await assert.rejects(readProteinEvidenceFile({ size: 2, arrayBuffer: async () => new Uint8Array([0xc3, 0x28]).buffer }, 'reference'));
    await assert.rejects(readProteinEvidenceFile({ size: 1, arrayBuffer: async () => new ArrayBuffer(600000) }, 'reference'), /limit/);
    const source = JSON.stringify(snapshot);
    const file = { size: source.length, arrayBuffer: async () => new TextEncoder().encode('\uFEFF' + source).buffer };
    assert.equal(await readProteinEvidenceFile(file, 'reference'), source);
  });
});

describe('owned protein evidence sessions', () => {
  it('cancels a pending file read before a worker can start', async () => {
    const { workers, session, scope } = workspace();
    let release!: (value: ProteinEvidenceRequest) => void;
    const work = session.run(scope, () => new Promise(done => { release = done; }), origin);
    session.cancel(); assert.equal(await work, false);
    release(await request()); await tick();
    assert.equal(workers.length, 0); assert.equal(session.getSnapshot().accepted, null);
    session.deactivate();
  });
  it('discards late results after same-ID repository replacement or selected-gene changes', async () => {
    const { workers, session, scope } = workspace();
    const input = await request(), result = await executeProteinEvidenceRequest(input);
    const old = session.run(scope, input, { kind: 'current-cds', genomeAccession: 'NC_001416.1', geneId: 42, proteinAccession: 'P03749' });
    await tick(); const late = workers[0].onmessage!;
    const replacement = { repository: {}, phage: { id: 1 }, selectedGeneId: 42 };
    session.setScope(replacement); assert.equal(await old, false); assert.equal(workers[0].terminated, 1);
    late({ data: result } as MessageEvent<ProteinEvidenceMessage>);
    assert.equal(session.getSnapshot().accepted, null); assert.equal(session.getSnapshot().origin, null);
    const changed = session.run(replacement, input, origin); await tick();
    const lateGene = workers[1].onmessage!;
    session.setScope({ ...replacement, selectedGeneId: 41 }); assert.equal(await changed, false);
    lateGene({ data: result } as MessageEvent<ProteinEvidenceMessage>);
    assert.equal(session.getSnapshot().accepted, null); session.deactivate();
  });
  it('captures submitted data before yielding and refuses a valid result for different settings', async () => {
    const { workers, session, scope } = workspace();
    const input = await request(), other = await executeProteinEvidenceRequest(await request({ contactCutoffAngstrom: 15 }));
    const work = session.run(scope, input, origin);
    if (input.kind === 'analyze') input.reference.proteins[0].sequence = 'A';
    await tick();
    const sent = workers[0].requests[0];
    assert.equal(sent.kind === 'analyze' && sent.reference.proteins[0].sequence.length, 1132);
    workers[0].emit(other);
    assert.equal(await work, false);
    assert.match(session.getSnapshot().error!, /submitted|settings|identity/);
    assert.equal(session.getSnapshot().accepted, null);
    session.deactivate();
  });
  it('rejects correctly rehashed worker replies with foreign source metadata or a seed', async () => {
    const { workers, session, scope } = workspace();
    const input = await request(), result = await executeProteinEvidenceRequest(input);
    if (result.kind !== 'experiment') throw new Error('Expected experiment');
    try {
      for (const variant of ['source', 'accession', 'seed'] as const) {
        const changed = structuredClone(result);
        if (variant === 'source') changed.experiment.record.inputs[0].source = 'local';
        else if (variant === 'accession') changed.experiment.record.inputs[0].accession = 'FOREIGN-PROTEIN';
        else changed.experiment.record.seed = 123;
        changed.experiment.record = await createAnalysisRecord(changed.experiment.record);
        const pending = session.run(scope, input, origin); await tick();
        const worker = workers.at(-1)!; worker.emit(changed);
        assert.equal(await pending, false, 'Reject foreign ' + variant);
        assert.match(session.getSnapshot().error!, /submitted|source|identity/);
        assert.equal(session.getSnapshot().accepted, null);
        assert.equal(worker.terminated, 1);
      }
    } finally { session.deactivate(); }
  });
  it('terminates malformed replies and allows a successful retry with owned source labels', async () => {
    const { workers, session, scope } = workspace();
    const input = await request();
    const first = session.run(scope, input, origin); await tick();
    workers[0].emit({ kind: 'experiment', verified: false, experiment: {} } as ProteinEvidenceMessage);
    assert.equal(await first, false); assert.equal(workers[0].terminated, 1);
    const retry = session.run(scope, input, origin); await tick();
    workers[1].emit(await executeProteinEvidenceRequest(input));
    assert.equal(await retry, true, session.getSnapshot().error ?? 'No result');
    assert.deepEqual(session.getSnapshot().origin, origin);
    assert.equal(session.getSnapshot().accepted!.result.protein.accession, 'P03749');
    session.deactivate();
  });
  it('clears accepted exports after a settings scope change and ignores old operation replies', async () => {
    const { workers, session, scope } = workspace();
    const input = await request(), result = await executeProteinEvidenceRequest(input);
    const first = session.run(scope, input, origin); await tick(); workers[0].emit(result);
    assert.equal(await first, true);
    const edited = { ...scope, revision: 2 }; session.setScope(edited);
    assert.equal(session.getSnapshot().accepted, null);
    const pending = session.run(edited, input, origin); await tick();
    const late = workers[1].onmessage!;
    const replacement = session.run(edited, await request({ chainLabelAsymId: null }), origin); await tick();
    assert.equal(await pending, false);
    late({ data: result } as MessageEvent<ProteinEvidenceMessage>); assert.equal(session.getSnapshot().accepted, null);
    workers[2].emit(await executeProteinEvidenceRequest(workers[2].requests[0]));
    assert.equal(await replacement, true); assert.equal(session.getSnapshot().accepted!.result.chain, null);
    session.deactivate();
  });
});

describe('actual protein evidence worker', () => {
  it('runs reference load, computation and fresh replay in disposable workers', async () => {
    const scope = {}, session = new ProteinEvidenceSession(() => new Worker(new URL('./protein-evidence.worker.ts', import.meta.url), { type: 'module' }));
    session.activate(); session.setScope(scope);
    try {
      assert.equal(await session.run(scope, { kind: 'inspect', content: JSON.stringify(snapshot) }, origin), true, session.getSnapshot().error ?? '');
      assert.equal(session.getSnapshot().accepted, null);
      const reference = session.getSnapshot().reference!;
      assert.equal(await session.run(scope, { kind: 'analyze', reference, options: {} }, origin), true, session.getSnapshot().error ?? '');
      const first = session.getSnapshot().accepted!;
      assert.equal(first.result.coverage.intrachainContacts, 958);
      assert.equal(await session.run(scope, { kind: 'replay', content: serializeAnalysisRecord(first.record) }, { kind: 'saved-experiment', name: 'saved.json' }), true, session.getSnapshot().error ?? '');
      assert.equal(session.getSnapshot().verified, true);
      assert.equal(session.getSnapshot().accepted!.record.resultId, first.record.resultId);
    } finally { session.deactivate(); }
  }, 20000);
  it('terminates a started computation and never exposes a partial record', async () => {
    const scope = {}, session = new ProteinEvidenceSession(() => new Worker(new URL('./protein-evidence.worker.ts', import.meta.url), { type: 'module' }));
    session.activate(); session.setScope(scope); let started = false;
    const stop = session.subscribe(() => {
      if (!started && session.getSnapshot().phase.startsWith('Computing observed')) { started = true; session.cancel(); }
    });
    try {
      assert.equal(await session.run(scope, await request({ contactCutoffAngstrom: 30 }), origin), false);
      assert.equal(started, true); assert.equal(session.getSnapshot().busy, false); assert.equal(session.getSnapshot().accepted, null);
    } finally { stop(); session.deactivate(); }
  }, 20000);
});


describe('standalone aligned protein evidence', () => {
  const fasta = '>target supplied row\nA-CXG\n>h1\nA-CYG\n>h2\nC--ZX\n>h3\nXTC-W\n';
  const input = () => parseProteinAlignmentFasta(fasta, 'local-proteins.faa',
    { kind: 'local', description: 'Private source alignment', reference: 'Notebook 17' });
  const alignmentRequest = (proteinId = 'target'): ProteinEvidenceRequest => ({ kind: 'analyze-alignment', input: input(), options: { proteinId } });

  it('imports ordinary FASTA, computes independent counts, and replays exact source metadata', async () => {
    const inspected = await executeProteinEvidenceRequest({ kind: 'inspect-alignment', content: fasta,
      name: 'local-proteins.faa', source: input().source });
    if (inspected.kind !== 'alignment') throw new Error('Expected supplied alignment');
    assert.deepEqual(inspected.input, input());
    assert.equal('chains' in inspected.input, false);
    const first = await executeProteinEvidenceRequest(alignmentRequest());
    if (first.kind !== 'alignment-experiment') throw new Error('Expected alignment experiment');
    assert.deepEqual(first.experiment.result.residues[0].counts, { A: 2, C: 1 });
    assert.ok(Math.abs(first.experiment.result.residues[0].entropyBits! - 0.9182958340544896) < 1e-14);
    assert.equal(first.experiment.result.residues[2].entropyBits, null);
    const text = serializeAnalysisRecord(first.experiment.record);
    const replay = await executeProteinEvidenceRequest({ kind: 'replay-alignment', content: text });
    if (replay.kind !== 'alignment-experiment') throw new Error('Expected alignment replay');
    assert.equal(replay.verified, true);
    assert.equal(replay.experiment.record.resultId, first.experiment.record.resultId);
    assert.deepEqual(replay.experiment.input, input());
    await assert.rejects(executeProteinEvidenceRequest({ kind: 'replay', content: text }), /method/i);
    const forged = structuredClone(first.experiment.record);
    forged.fields.diversity.value = { invented: true };
    await assert.rejects(executeProteinEvidenceRequest({ kind: 'replay-alignment',
      content: serializeAnalysisRecord(await createAnalysisRecord(forged)) }), /differs/);
  });

  it('binds accepted results to target and provenance, and clears them on changed view scope', async () => {
    const { session, scope, workers } = workspace();
    try {
      const submitted = alignmentRequest(), wrong = await executeProteinEvidenceRequest(alignmentRequest('h3'));
      const work = session.run(scope, submitted, origin); await tick();
      workers[0].emit(wrong);
      assert.equal(await work, false);
      assert.match(session.getSnapshot().error!, /source|target|identity/);
      assert.equal(session.getSnapshot().alignmentAccepted, null);
      const good = session.run(scope, submitted, origin); await tick();
      workers[1].emit(await executeProteinEvidenceRequest(submitted));
      assert.equal(await good, true, session.getSnapshot().error ?? '');
      assert.equal(session.getSnapshot().alignmentAccepted!.result.protein.id, 'target');
      assert.equal(session.getSnapshot().accepted, null);
      session.setScope({ ...scope, revision: 1 });
      assert.equal(session.getSnapshot().alignmentAccepted, null);
      assert.equal(session.getSnapshot().alignment, null);
    } finally { session.deactivate(); }
  });

  it('captures inputs, refuses renamed source replies, and cannot claim a verified genomic CDS', async () => {
    const { session, scope, workers } = workspace();
    try {
      const submitted = alignmentRequest();
      const pending = session.run(scope, submitted, origin);
      if (submitted.kind === 'analyze-alignment') submitted.input.source.description = 'Late mutation';
      await tick();
      const sent = workers[0].requests[0];
      assert.equal(sent.kind === 'analyze-alignment' && sent.input.source.description, 'Private source alignment');
      const response = await executeProteinEvidenceRequest(sent);
      if (response.kind !== 'alignment-experiment') throw new Error('Expected experiment');
      response.experiment.record.inputs[0].source = 'external';
      response.experiment.record = await createAnalysisRecord(response.experiment.record);
      workers[0].emit(response);
      assert.equal(await pending, false);
      assert.equal(session.getSnapshot().alignmentAccepted, null);
      assert.equal(await session.run(scope, alignmentRequest(), { kind: 'current-cds',
        genomeAccession: 'NC_001416.1', geneId: 42, proteinAccession: 'P03749' }), false);
      assert.match(session.getSnapshot().error!, /cannot assert a verified genomic CDS/);
      assert.equal(workers.length, 1);
    } finally { session.deactivate(); }
  });

  it('rejects oversized or malformed alignment imports without accepting partial evidence', async () => {
    let reads = 0;
    await assert.rejects(readProteinEvidenceFile({ size: PROTEIN_ALIGNMENT_LIMITS.bytes + 1,
      arrayBuffer: async () => { reads++; return new ArrayBuffer(0); } }, 'alignment'), /limit/);
    assert.equal(reads, 0);
    await assert.rejects(executeProteinEvidenceRequest({ kind: 'inspect-alignment', content: '>one\nA-C\n>two\nA-C',
      name: 'bad.faa', source: input().source }), /all-gap/);
    const { session, scope, workers } = workspace();
    let release!: (value: ProteinEvidenceRequest) => void;
    try {
      const pending = session.run(scope, () => new Promise(done => { release = done; }), origin);
      session.cancel(); assert.equal(await pending, false);
      release(alignmentRequest()); await tick();
      assert.equal(workers.length, 0);
      assert.equal(session.getSnapshot().alignmentAccepted, null);
    } finally { session.deactivate(); }
  });

  it('runs FASTA import, a selected target and fresh replay through the actual disposable worker', async () => {
    const scope = {}, session = new ProteinEvidenceSession(() => new Worker(new URL('./protein-evidence.worker.ts', import.meta.url), { type: 'module' }));
    session.activate(); session.setScope(scope);
    try {
      assert.equal(await session.run(scope, { kind: 'inspect-alignment', content: fasta, name: 'local-proteins.faa', source: input().source }, origin), true, session.getSnapshot().error ?? '');
      assert.equal(session.getSnapshot().alignment!.rows.length, 4);
      assert.equal(session.getSnapshot().alignmentAccepted, null);
      assert.equal(await session.run(scope, alignmentRequest('h3'), origin), true, session.getSnapshot().error ?? '');
      const first = session.getSnapshot().alignmentAccepted!;
      assert.equal(first.result.protein.sequence, 'XTCW');
      assert.equal(first.result.residues[1].entropyBits, null);
      assert.equal(await session.run(scope, { kind: 'replay-alignment', content: serializeAnalysisRecord(first.record) },
        { kind: 'saved-experiment', name: 'saved-alignment.json' }), true, session.getSnapshot().error ?? '');
      assert.equal(session.getSnapshot().verified, true);
      assert.equal(session.getSnapshot().alignmentAccepted!.record.resultId, first.record.resultId);
      assert.equal(session.getSnapshot().accepted, null);
    } finally { session.deactivate(); }
  }, 20000);
});


describe('standalone local mmCIF evidence', () => {
  // Independent 3-4-5 / 5-12-13 geometry, with missing polymer positions and author insertions.
  const cif = `data_private
loop_
_atom_site.group_PDB
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.label_alt_id
_atom_site.label_comp_id
_atom_site.label_asym_id
_atom_site.label_seq_id
_atom_site.auth_asym_id
_atom_site.auth_seq_id
_atom_site.pdbx_PDB_ins_code
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
_atom_site.occupancy
_atom_site.pdbx_PDB_model_num
ATOM C CA . ALA A 1 Z -2 ? 0 0 0 1 1
ATOM C CA . ASP A 3 Z 10 A 3 4 0 1 1
ATOM C CA . GLY A 6 Z 10 B 0 0 12 1 1
#
`;
  const input = () => prepareProteinCoordinateInput(cif, '>private\nMKACDEFGH', 'private.cif',
    { labelAsymId: 'A', proteinStart: 3 }, { kind: 'local', description: 'Private coordinate source', reference: 'Notebook 23' });
  const coordinateRequest = (cutoff = 5): ProteinEvidenceRequest => ({ kind: 'analyze-coordinates', input: input(),
    options: { contactCutoffAngstrom: cutoff, minSequenceSeparation: 1 } });

  it('imports only explicitly mapped coordinates and replays independent literal distances', async () => {
    const inspected = await executeProteinEvidenceRequest({ kind: 'inspect-coordinates', input: input() });
    if (inspected.kind !== 'coordinates') throw new Error('Expected coordinate input');
    assert.deepEqual(inspected.input, input());
    assert.equal('experiment' in inspected, false);
    const first = await executeProteinEvidenceRequest(coordinateRequest());
    if (first.kind !== 'coordinate-experiment') throw new Error('Expected coordinate experiment');
    assert.deepEqual(first.experiment.result.coverage, {
      proteinResidues: 9, coordinateResidues: 3, unmappedResidues: 6, intrachainContacts: 1,
    });
    assert.deepEqual(first.experiment.result.contacts.map(contact =>
      [contact.query.proteinPosition, contact.partner.proteinPosition, contact.distanceAngstrom]), [[3, 5, 5]]);
    assert.equal(first.experiment.result.residues[3].coordinate, null);
    assert.equal(first.experiment.result.residues[3].intrachainNeighbors, null);
    assert.equal(first.experiment.result.residues[7].intrachainNeighbors, 0);
    assert.equal(first.experiment.record.fields.alignment.kind, 'unavailable');
    const exported = serializeAnalysisRecord(first.experiment.record);
    const replay = await executeProteinEvidenceRequest({ kind: 'replay-coordinates', content: exported });
    if (replay.kind !== 'coordinate-experiment') throw new Error('Expected coordinate replay');
    assert.equal(replay.verified, true);
    assert.equal(replay.experiment.record.resultId, first.experiment.record.resultId);
    assert.deepEqual(replay.experiment.input, input());
    await assert.rejects(executeProteinEvidenceRequest({ kind: 'replay', content: exported }), /method/i);
    await assert.rejects(executeProteinEvidenceRequest({ kind: 'replay-alignment', content: exported }), /method/i);
    const forged = structuredClone(first.experiment.record);
    forged.fields.geometry.value = { invented: true };
    await assert.rejects(executeProteinEvidenceRequest({ kind: 'replay-coordinates',
      content: serializeAnalysisRecord(await createAnalysisRecord(forged)) }), /differ|recomput|identity/i);
  });

  it('accepts the submitted mapping and rejects valid geometry from other settings or sources', async () => {
    const { session, workers, scope } = workspace();
    try {
      const pending = session.run(scope, { kind: 'inspect-coordinates', input: input() }, origin);
      await tick();
      workers[0].emit(await executeProteinEvidenceRequest(workers[0].requests[0]));
      assert.equal(await pending, true, session.getSnapshot().error ?? '');
      assert.equal(session.getSnapshot().coordinates!.structure.proteinStart, 3);
      assert.equal(session.getSnapshot().coordinateAccepted, null);
      const settings = session.run(scope, coordinateRequest(), origin); await tick();
      workers[1].emit(await executeProteinEvidenceRequest(coordinateRequest(12)));
      assert.equal(await settings, false);
      assert.match(session.getSnapshot().error!, /source|mapping|settings|identity/);
      assert.equal(session.getSnapshot().coordinateAccepted, null);

      const submitted = coordinateRequest();
      const captured = session.run(scope, submitted, origin);
      if (submitted.kind === 'analyze-coordinates') submitted.input.source.description = 'Late mutation';
      await tick();
      const sent = workers[2].requests[0];
      assert.equal(sent.kind === 'analyze-coordinates' && sent.input.source.description, 'Private coordinate source');
      const other = structuredClone(sent);
      if (other.kind === 'analyze-coordinates') other.input.source.description = 'A different source';
      workers[2].emit(await executeProteinEvidenceRequest(other));
      assert.equal(await captured, false);
      assert.equal(session.getSnapshot().coordinateAccepted, null);
      const good = session.run(scope, coordinateRequest(), origin); await tick();
      workers[3].emit(await executeProteinEvidenceRequest(workers[3].requests[0]));
      assert.equal(await good, true, session.getSnapshot().error ?? '');
      assert.equal(session.getSnapshot().coordinateAccepted!.result.contacts[0].distanceAngstrom, 5);
      assert.equal(session.getSnapshot().accepted, null);
      assert.equal(session.getSnapshot().alignmentAccepted, null);
      session.setScope({ ...scope, revision: 1 });
      assert.equal(session.getSnapshot().coordinateAccepted, null);
      assert.equal(session.getSnapshot().coordinates, null);
    } finally { session.deactivate(); }
  });

  it('never accepts a genomic-CDS origin, malformed mapping, or late cancelled coordinate result', async () => {
    const { session, workers, scope } = workspace();
    try {
      assert.equal(await session.run(scope, coordinateRequest(), { kind: 'current-cds',
        genomeAccession: 'NC_001416.1', geneId: 42, proteinAccession: 'P03749' }), false);
      assert.match(session.getSnapshot().error!, /cannot assert a verified genomic CDS/);
      assert.equal(workers.length, 0);
      const bad = input(); bad.structure.proteinStart = 1;
      await assert.rejects(executeProteinEvidenceRequest({ kind: 'inspect-coordinates', input: bad }), /residue|sequence|mapping/i);
      const submitted = coordinateRequest(), reply = await executeProteinEvidenceRequest(submitted);
      const pending = session.run(scope, submitted, origin); await tick();
      const late = workers[0].onmessage!;
      session.cancel();
      assert.equal(await pending, false); assert.equal(workers[0].terminated, 1);
      late({ data: reply } as MessageEvent<ProteinEvidenceMessage>);
      assert.equal(session.getSnapshot().coordinateAccepted, null);
    } finally { session.deactivate(); }
  });

  it('bounds both raw coordinate and single-protein inputs before reading their bytes', async () => {
    for (const [kind, maximum] of [['coordinates', PROTEIN_COORDINATE_LIMITS.bytes],
      ['protein', PROTEIN_COORDINATE_LIMITS.proteinBytes]] as const) {
      let reads = 0;
      await assert.rejects(readProteinEvidenceFile({ size: maximum + 1,
        arrayBuffer: async () => { reads++; return new ArrayBuffer(0); } }, kind), /limit/);
      assert.equal(reads, 0);
      await assert.rejects(readProteinEvidenceFile({ size: 1,
        arrayBuffer: async () => new ArrayBuffer(maximum + 1) }, kind), /limit/);
      await assert.rejects(readProteinEvidenceFile({ size: 2,
        arrayBuffer: async () => new Uint8Array([0xc3, 0x28]).buffer }, kind));
    }
  });

  it('imports, computes, exports and freshly replays in actual disposable workers', async () => {
    const scope = {}, session = new ProteinEvidenceSession(() => new Worker(new URL('./protein-evidence.worker.ts', import.meta.url), { type: 'module' }));
    session.activate(); session.setScope(scope);
    try {
      assert.equal(await session.run(scope, { kind: 'inspect-coordinates', input: input() }, origin), true, session.getSnapshot().error ?? '');
      assert.equal(session.getSnapshot().coordinates!.protein.id, 'private');
      assert.equal(await session.run(scope, coordinateRequest(), origin), true, session.getSnapshot().error ?? '');
      const first = session.getSnapshot().coordinateAccepted!;
      assert.deepEqual(first.result.contacts.map(contact => contact.distanceAngstrom), [5]);
      assert.equal(await session.run(scope, { kind: 'replay-coordinates', content: serializeAnalysisRecord(first.record) },
        { kind: 'saved-experiment', name: 'saved-coordinates.json' }), true, session.getSnapshot().error ?? '');
      assert.equal(session.getSnapshot().verified, true);
      assert.equal(session.getSnapshot().coordinateAccepted!.record.resultId, first.record.resultId);
      assert.equal(session.getSnapshot().accepted, null);
    } finally { session.deactivate(); }
  }, 20000);
});

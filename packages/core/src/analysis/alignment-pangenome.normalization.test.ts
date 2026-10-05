import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { buildAlignmentPangenome, createAlignmentPangenomeRecord, exportAlignmentGfa, exportPangenomeOriginalFasta,
  mapPangenomeNodeToOriginal, parsePangenomeInput, replayAlignmentPangenome, type AlignmentGraphOptions } from './alignment-pangenome';
import { createAnalysisRecord, serializeAnalysisRecord } from '../analysis-result';

const bases = 'ACGTRYSWKMBDHVN', complements = 'TGCAYRSWMKVHDBN';
const rc = (s: string) => s.split('').reverse().map(c => complements[bases.indexOf(c)]).join('');
const rotate = (s: string, offset: number) => s.slice(offset) + s.slice(0, offset);
function dna(length: number): string {
  let seed = 123456789;
  return Array.from({ length }, () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return 'ACGT'[(seed >>> 0) % 4]; }).join('');
}
const settings: AlignmentGraphOptions = { referenceId: 'ref', alignment: 'wavefront', terminalGaps: 'alleles', normalization: 'circular' };

describe('normalized pangenome producer, graph, coordinates and replay', () => {
  it('builds zero-variant graphs for exact reverse/rotated representations and reconstructs every original path from GFA', () => {
    const reference = dna(10000), originals = { ref: reference, forward: rotate(reference, 2000), reverse: rotate(rc(reference), 137) };
    const input = parsePangenomeInput(Object.entries(originals).map(([id, seq]) => `>${id}\n${seq}`).join('\n'));
    const snapshot = JSON.stringify(input), graph = buildAlignmentPangenome(input, settings);
    assert.equal(graph.variants.length, 0); assert.equal(JSON.stringify(input), snapshot);
    assert.equal(graph.diagnostics.sharedUnambiguousBases, reference.length);
    const gfa = exportAlignmentGfa(graph).split('\n'), segments = new Map<string, string>();
    const transforms = new Map<string, { strand: string; offset: number }>();
    for (const line of gfa) {
      const fields = line.split('\t');
      if (fields[0] === 'S') segments.set(fields[1], fields[2]);
      if (fields[0] === '# path-transform') transforms.set(fields[1], JSON.parse(fields[2]));
    }
    for (const line of gfa.filter(l => l.startsWith('P\t'))) {
      const [, id, walk] = line.split('\t');
      const normalized = walk.split(',').map(n => segments.get(n.slice(0, -1))).join('');
      assert.equal(normalized, reference);
      const transform = transforms.get(id)!;
      // Independent inverse, using only GFA segment/path/transform data.
      const unrotated = rotate(normalized, (normalized.length - transform.offset) % normalized.length);
      const original = transform.strand === '-' ? rc(unrotated) : unrotated;
      const sequenceId = graph.paths.find(p => p.id === id)!.sequenceId as keyof typeof originals;
      assert.equal(original, originals[sequenceId]);
    }
    const reconstructed = parsePangenomeInput(exportPangenomeOriginalFasta(graph));
    assert.deepEqual(reconstructed.sequences.map(s => [s.id, s.sequence]), input.sequences.map(s => [s.id, s.sequence]));
  });
  it('keeps SNV and indel evidence in submitted reference coordinates after reverse rotation', () => {
    const reference = dna(400), changedBase = reference[80] === 'A' ? 'C' : 'A';
    const changed = reference.slice(0, 4) + 'CCC' + reference.slice(4, 80) + changedBase + reference.slice(81, 180) + reference.slice(184);
    const input = parsePangenomeInput(`>ref\n${reference}\n>query\n${rotate(rc(changed), 173)}`);
    const graph = buildAlignmentPangenome(input, settings);
    assert.equal(graph.alignment.find(s => s.id === 'ref')!.sequence.replaceAll('-', ''), reference);
    assert.equal(graph.alignment.find(s => s.id === 'query')!.sequence.replaceAll('-', ''), changed);
    assert(graph.variants.some(v => v.type === 'snv' && v.referenceStart === 80 && v.referenceEnd === 81 && v.reference === reference[80] && v.alternate === changedBase));
    assert(graph.variants.some(v => v.type === 'insertion' && v.referenceStart === 4 && v.alternate === 'CCC'));
    // Reconstruct the full normalized query from called reference-relative alleles.
    let position = 0, sequence = '';
    for (const v of graph.variants) {
      assert.equal(reference.slice(v.referenceStart, v.referenceEnd), v.reference);
      sequence += reference.slice(position, v.referenceStart) + v.alternate; position = v.referenceEnd;
    }
    assert.equal(sequence + reference.slice(position), changed);
    for (const path of graph.paths) for (const id of path.nodes) {
      const original = input.sequences.find(s => s.id === path.sequenceId)!.sequence;
      const reconstructed = mapPangenomeNodeToOriginal(graph, path.id, id).map(segment => {
        const slice = original.slice(segment.start, segment.end);
        return segment.strand === '+' ? slice : rc(slice);
      }).join('');
      assert.equal(reconstructed, graph.nodes.find(n => n.id === id)!.sequence);
    }
  });
  it('binds original inputs, normalization choices and transforms to version-4 fresh replay', async () => {
    const reference = dna(1000), input = parsePangenomeInput(`>ref\n${reference}\n>query\n${rotate(rc(reference), 127)}`);
    const graph = buildAlignmentPangenome(input, settings), record = await createAlignmentPangenomeRecord(input, graph);
    assert.equal(record.method.version, '4'); assert.equal(record.parameters.normalization, 'circular');
    assert.deepEqual((record.inputs[0].data as unknown as typeof input).sequences, input.sequences);
    const fresh = await replayAlignmentPangenome(serializeAnalysisRecord(record));
    assert.deepEqual(fresh.graph, graph); assert.deepEqual(fresh.record, record);
    assert.equal(exportPangenomeOriginalFasta(fresh.graph), exportPangenomeOriginalFasta(graph));
    const reordered = buildAlignmentPangenome({ ...input, sequences: [...input.sequences].reverse() }, settings);
    assert.deepEqual(reordered, graph);
  });
  it('rejects rehashed forged original-coordinate transforms during recomputation', async () => {
    const reference = dna(200), input = parsePangenomeInput(`>ref\n${reference}\n>query\n${rotate(rc(reference), 57)}`);
    const graph = buildAlignmentPangenome(input, settings);
    graph.diagnostics.normalization!.sequences.find(s => s.sequenceId === 'query')!.transform.offset++;
    const forged = await createAlignmentPangenomeRecord(input, graph);
    await assert.rejects(replayAlignmentPangenome(serializeAnalysisRecord(forged)), /Recomputed/);
    const { format: _format, version: _version, resultId: _resultId, cacheKey: _cacheKey, ...options } = forged;
    const wrongMethod = await createAnalysisRecord({ ...options, method: { ...options.method, version: '3' } });
    await assert.rejects(replayAlignmentPangenome(serializeAnalysisRecord(wrongMethod)), /contract differs/);
  });
  it('requires explicit complete-circle/allele settings and disallows normalization of supplied alignments', () => {
    const input = parsePangenomeInput('>ref\nACGT\n>query\nGTAC');
    assert.throws(() => buildAlignmentPangenome(input, { ...settings, terminalGaps: 'missing' }), /complete circles/);
    for (const alignment of ['provided', 'global'] as const) assert.throws(() => buildAlignmentPangenome(input, { ...settings, alignment }), /requires wavefront/);
    assert.throws(() => buildAlignmentPangenome(input, { ...settings, normalization: 'automatic' as 'strand' }), /normalization/);
    assert.throws(() => buildAlignmentPangenome(parsePangenomeInput('>ref\nACGT-\n>query\nGT-AC'), settings), /ungapped/);
    assert.throws(() => buildAlignmentPangenome(parsePangenomeInput('>ref\nAAAACCCC\n>query\nAAAAGCCC'), settings), /decisive/);
  });
  it('keeps old provided/global/wavefront record identities unchanged when normalization is absent', async () => {
    const input = parsePangenomeInput('>ref\nACGTACGTACGT\n>query\nACGTTGGTACGT', 'Unchanged workflow');
    // Captured from a4a7675 BEFORE this implementation, not regenerated from it.
    const results = {
      provided: 'a368b2eda5fee50c0992d45a99534669f2c7f523b79143286400af8a87337de8',
      global: 'bb6ddee5da26d4589d3f9619c48bca5719a84bd3d660b0125337d4f3b93d054c',
      wavefront: '60daa6a9448f74e08583086bec465d7123259970dc42424a35abd72c1cb945ba',
    };
    for (const alignment of ['provided', 'global', 'wavefront'] as const) {
      const graph = buildAlignmentPangenome(input, { referenceId: 'ref', alignment, terminalGaps: 'alleles' });
      const record = await createAlignmentPangenomeRecord(input, graph);
      assert.equal(record.resultId, results[alignment]);
      assert.equal(graph.diagnostics.normalization, undefined);
      assert.deepEqual((await replayAlignmentPangenome(serializeAnalysisRecord(record))).record, record);
    }
  });
  it('supports strand-only normalization of incomplete linear inputs without rotating them', () => {
    const reference = dna(300), query = rc(reference.slice(10, -10));
    const graph = buildAlignmentPangenome(parsePangenomeInput(`>ref\n${reference}\n>query\n${query}`),
      { ...settings, normalization: 'strand', terminalGaps: 'missing' });
    assert.deepEqual(graph.diagnostics.normalization!.sequences.find(s => s.sequenceId === 'query')!.transform, { strand: '-', offset: 0 });
    assert.equal(graph.variants.length, 0);
    assert.equal(graph.diagnostics.comparisons[0].missingTerminalColumns, 20);
  });
  it('preserves demo provenance and refuses incomplete graph coordinate metadata on export', async () => {
    const input = { ...parsePangenomeInput('>ref\nACGTTACCA\n>query\nTACCAACGT'), source: 'demo' as const };
    const graph = buildAlignmentPangenome(input, settings), record = await createAlignmentPangenomeRecord(input, graph);
    assert(Object.values(record.fields).every(field => field.kind === 'demo'));
    graph.diagnostics.normalization!.sequences = [];
    assert.throws(() => exportPangenomeOriginalFasta(graph), /transform/);
    assert.throws(() => mapPangenomeNodeToOriginal(graph, graph.paths[0].id, graph.paths[0].nodes[0]), /transform/);
    assert.throws(() => mapPangenomeNodeToOriginal(graph, 'absent', 'absent'), /does not traverse/);
  });
});

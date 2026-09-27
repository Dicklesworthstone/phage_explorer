import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../analysis-result';
import { ALIGNMENT_GRAPH_LIMITS, alignPangenomePair, buildAlignmentPangenome, createAlignmentPangenomeRecord,
  exportAlignmentGfa, exportPangenomeAlignment, parsePangenomeInput, replayAlignmentPangenome,
  resolveAlignmentGraphOptions, serializePangenomeInput, validatePangenomeInput, type AlignmentPangenome } from './alignment-pangenome';

const FASTA = '>ref reference\nACGT--ACGT\n>q1 insertion and deletion\nACGTGGAC-T\n>q2 SNV\nATGT--ACGT\n';
const input = () => parsePangenomeInput(FASTA, 'independently checked alignment');
const graph = () => buildAlignmentPangenome(input(), { referenceId: 'ref' });
function assertPaths(value: AlignmentPangenome): void {
  const nodes = new Map(value.nodes.map(n => [n.id, n]));
  for (const path of value.paths) {
    assert.equal(path.nodes.map(id => nodes.get(id)!.sequence).join(''), value.alignment.find(s => s.id === path.sequenceId)!.sequence.replaceAll('-', ''));
    assert.equal(path.length, path.nodes.reduce((n, id) => n + nodes.get(id)!.sequence.length, 0));
    for (let i = 1; i < path.nodes.length; i++) {
      assert.ok(value.edges.some(e => e.from === path.nodes[i - 1] && e.to === path.nodes[i] && e.pathIds.includes(path.id)));
      assert.ok(nodes.get(path.nodes[i - 1])!.block < nodes.get(path.nodes[i])!.block, 'paths and links must be acyclic');
    }
  }
}
function assertVariantReconstruction(value: AlignmentPangenome): void {
  const reference = value.alignment.find(s => s.id === value.options.referenceId)!.sequence.replaceAll('-', '');
  for (const path of value.paths) {
    let result = '', position = 0;
    for (const variant of value.variants.filter(v => v.pathIds.includes(path.id))) {
      assert.ok(position <= variant.referenceStart, 'calls for one sample do not overlap');
      assert.equal(reference.slice(variant.referenceStart, variant.referenceEnd), variant.reference);
      result += reference.slice(position, variant.referenceStart) + variant.alternate;
      position = variant.referenceEnd;
    }
    result += reference.slice(position);
    assert.equal(result, value.alignment.find(s => s.id === path.sequenceId)!.sequence.replaceAll('-', ''));
  }
}
async function rewrite(record: AnalysisRecord): Promise<string> {
  return serializeAnalysisRecord(await createAnalysisRecord({ ...record, inputs: record.inputs.map(({ sha256: _sha, ...rest }) => rest) }));
}

describe('sequence-derived pangenomes', () => {
  it('parses multiline, BOM, CRLF, lowercase and Unicode FASTA without silently dropping symbols', () => {
    const data = parsePangenomeInput('\uFEFF>λ private sequence\r\nacg\r\nt-n\r\n>β\r\na g t t - r\r\n', 'local');
    assert.deepEqual(data.sequences, [{ id: 'β', description: '', sequence: 'AGTT-R' }, { id: 'λ', description: 'private sequence', sequence: 'ACGT-N' }]);
    assert.equal(data.source, 'local');
    assert.deepEqual(parsePangenomeInput(serializePangenomeInput(data)), data);
  });
  it('rejects duplicate IDs, empty sequences, unsupported symbols and missing records', () => {
    for (const content of ['>x\nA\n>x\nT', '>x\n>y\nT', '>x\n---\n>y\nACG', '>x\nACU\n>y\nACT', '>x\nAC.\n>y\nACT', '>x\nA?', '>x\nAA', 'ACGT']) {
      assert.throws(() => parsePangenomeInput(content));
    }
  });
  it('copies input and rejects invalid schema, identifiers and dimension budgets', () => {
    const data = input(), copy = validatePangenomeInput(data);
    data.sequences[0].sequence = 'AAAA';
    assert.notEqual(copy.sequences[0].sequence, data.sequences[0].sequence);
    for (const bad of [{ ...copy, version: 2 }, { ...copy, source: 'catalog' }, { ...copy, sequences: [] },
      { ...copy, name: '\x1b[31m' }, { ...copy, sequences: [...copy.sequences, { ...copy.sequences[0], id: 'bad id' }] }]) {
      assert.throws(() => validatePangenomeInput(bad));
    }
    assert.throws(() => parsePangenomeInput('X'.repeat(ALIGNMENT_GRAPH_LIMITS.bytes + 1)), /MiB/);
  });
  it('finds independently checked insertion, deletion and SNV coordinates and exact support', () => {
    const result = graph();
    assert.equal(result.referenceLength, 8);
    assert.deepEqual(result.variants.map(({ type, referenceStart, referenceEnd, reference, alternate, pathIds }) =>
      ({ type, referenceStart, referenceEnd, reference, alternate, pathIds })), [
      { type: 'snv', referenceStart: 1, referenceEnd: 2, reference: 'C', alternate: 'T', pathIds: ['p2'] },
      { type: 'insertion', referenceStart: 4, referenceEnd: 4, reference: '', alternate: 'GG', pathIds: ['p1'] },
      { type: 'deletion', referenceStart: 6, referenceEnd: 7, reference: 'G', alternate: '', pathIds: ['p1'] },
    ]);
    assert.equal(result.diagnostics.sharedUnambiguousBases, 6);
    assertPaths(result); assertVariantReconstruction(result);
  });
  it('groups shared alleles by actual sequence membership, never template names', () => {
    const result = buildAlignmentPangenome(parsePangenomeInput('>ref\nACGT\n>a\nATGT\n>b\nATGT'), { referenceId: 'ref' });
    assert.equal(result.variants.length, 1);
    assert.deepEqual(result.variants[0].pathIds, ['p1', 'p2']);
    const node = result.nodes.find(n => n.sequence === 'T')!;
    assert.deepEqual(node.pathIds, ['p1', 'p2']); assert.equal(node.core, false);
  });
  it('has stable graph and variant IDs when input rows are reordered', () => {
    const data = input(); data.sequences.reverse();
    assert.deepEqual(buildAlignmentPangenome(data, { referenceId: 'ref' }), graph());
  });
  it('changes reference coordinates and allele direction when a different reference is selected', () => {
    const result = buildAlignmentPangenome(input(), { referenceId: 'q1', terminalGaps: 'alleles' });
    assert.equal(result.referenceLength, 9);
    const referencePath = result.paths.find(p => p.sequenceId === 'ref')!;
    assert.deepEqual(result.variants.filter(v => v.pathIds.includes(referencePath.id)).map(v => [v.type, v.referenceStart, v.referenceEnd, v.reference, v.alternate]),
      [['deletion', 4, 6, 'GG', ''], ['insertion', 8, 8, '', 'G']]);
    assertPaths(result); assertVariantReconstruction(result);
  });
  it('treats terminal gaps as missing by default, not deletions or insertions', () => {
    const data = parsePangenomeInput('>ref\n--ACGT--\n>query\nTTAC-TGG');
    const result = buildAlignmentPangenome(data, { referenceId: 'ref' });
    assert.deepEqual(result.variants.map(v => [v.type, v.referenceStart, v.reference]), [['deletion', 2, 'G']]);
    assert.equal(result.diagnostics.comparisons[0].missingTerminalColumns, 4);
    const complete = buildAlignmentPangenome(data, { referenceId: 'ref', terminalGaps: 'alleles' });
    assert.deepEqual(complete.variants.map(v => [v.type, v.referenceStart, v.alternate]),
      [['insertion', 0, 'TT'], ['deletion', 2, ''], ['insertion', 4, 'GG']]);
    assertVariantReconstruction(complete);
  });
  it('retains IUPAC symbols in paths but masks ambiguous comparisons', () => {
    const result = buildAlignmentPangenome(parsePangenomeInput('>ref\nACNGT\n>query\nATAGT'), { referenceId: 'ref' });
    assert.equal(result.variants.length, 1); assert.equal(result.variants[0].referenceStart, 1);
    assert.equal(result.diagnostics.comparisons[0].ambiguousColumns, 1);
    assert.ok(result.nodes.some(n => n.ambiguous)); assertPaths(result);
  });
  it('does not call equivalent gap placements a biological change', () => {
    const result = buildAlignmentPangenome(parsePangenomeInput('>ref\nAC-A\n>query\nA-CA'), { referenceId: 'ref' });
    assert.deepEqual(result.variants, []); assertPaths(result);
  });
  it('omits all-gap columns without losing path sequence or changing reference coordinates', () => {
    const result = buildAlignmentPangenome(parsePangenomeInput('>ref\nA--CG\n>query\nA--TG'), { referenceId: 'ref' });
    assert.equal(result.diagnostics.allGapColumns, 2);
    assert.equal(result.variants[0].referenceStart, 1); assert.equal(result.referenceLength, 3); assertPaths(result);
  });
  it('compresses long conserved runs and does not classify ambiguous shared sequence as known core', () => {
    const result = buildAlignmentPangenome(parsePangenomeInput(`>a\n${'ACGT'.repeat(10000)}\n>b\n${'ACGT'.repeat(10000)}`));
    assert.equal(result.nodes.length, 1); assert.equal(result.diagnostics.sharedUnambiguousBases, 40000);
    const ambiguous = buildAlignmentPangenome(parsePangenomeInput('>a\nNNNN\n>b\nNNNN'));
    assert.equal(ambiguous.diagnostics.sharedUnambiguousBases, 0); assert.equal(ambiguous.variants.length, 0);
  });
  it('distinguishes multi-base substitution from a length-changing replacement', () => {
    const result = buildAlignmentPangenome(parsePangenomeInput('>ref\nACCT-GA\n>query\nATTCAGA'), { referenceId: 'ref' });
    assert.deepEqual(result.variants.map(v => [v.type, v.reference, v.alternate]), [['replacement', 'CCT', 'TTCA']]);
    const substitution = buildAlignmentPangenome(parsePangenomeInput('>ref\nACCA\n>query\nATTA'), { referenceId: 'ref' });
    assert.equal(substitution.variants[0].type, 'substitution');
  });
  it('refuses unequal supplied alignments and invalid options', () => {
    assert.throws(() => buildAlignmentPangenome(parsePangenomeInput('>a\nAC\n>b\nAGC')), /equal column/);
    for (const options of [{ referenceId: 'missing' }, { alignment: 'magic' }, { terminalGaps: 'infer' }, { extra: true }, null]) {
      assert.throws(() => resolveAlignmentGraphOptions(input(), options as never));
    }
  });
  it('caps fragmented graphs before constructing an unbounded display', () => {
    const data = parsePangenomeInput(`>ref\n${'AA'.repeat(2100)}\n>query\n${'AT'.repeat(2100)}`);
    assert.throws(() => buildAlignmentPangenome(data), /4,000 blocks/);
  });
  it('spells every input and reconstructs every sample from calls across adversarial alignments', () => {
    let seed = 41;
    const draw = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    for (let trial = 0; trial < 24; trial++) {
      const records = Array.from({ length: 5 }, (_, i) => `>sample${i}\nA${Array.from({ length: 70 }, () => 'ACGT-'[draw() % 5]).join('')}T`);
      const result = buildAlignmentPangenome(parsePangenomeInput(records.join('\n')), { terminalGaps: 'alleles' });
      assertPaths(result); assertVariantReconstruction(result);
    }
  });
});

describe('bounded exact reference-guided alignment', () => {
  it('aligns hand-checked internal insertion and deletion with unit edit cost', () => {
    assert.deepEqual(alignPangenomePair('ACGT', 'AGT'), { reference: 'ACGT', query: 'A-GT', distance: 1 });
    assert.deepEqual(alignPangenomePair('AGT', 'ACGT'), { reference: 'A-GT', query: 'ACGT', distance: 1 });
    assert.deepEqual(alignPangenomePair('A', 'G'), { reference: 'A', query: 'G', distance: 1 });
  });
  it('matches exhaustive enumeration of all edit alignments for every short binary sequence', () => {
    // Independent oracle: enumerate every legal complete alignment and score it.
    function exhaustive(a: string, b: string): number[] {
      if (!a.length || !b.length) return [a.length + b.length];
      return [...exhaustive(a.slice(1), b.slice(1)).map(n => n + Number(a[0] !== b[0])),
        ...exhaustive(a.slice(1), b).map(n => n + 1), ...exhaustive(a, b.slice(1)).map(n => n + 1)];
    }
    const words = ['A', 'C', 'AA', 'AC', 'CA', 'CC', 'AAA', 'AAC', 'ACA', 'ACC', 'CAA', 'CAC', 'CCA', 'CCC'];
    for (const a of words) for (const b of words) {
      const pair = alignPangenomePair(a, b);
      assert.equal(pair.distance, Math.min(...exhaustive(a, b)), `${a}/${b}`);
      assert.equal(pair.reference.replaceAll('-', ''), a); assert.equal(pair.query.replaceAll('-', ''), b);
      assert.equal(pair.reference.length, pair.query.length);
      assert.equal([...pair.reference].filter((c, i) => c !== pair.query[i]).length, pair.distance);
    }
  });
  it('merges different insertion lengths into exact paths without losing sample sequence', () => {
    const data = parsePangenomeInput('>ref\nACGT\n>q1\nACGGGT\n>q2\nAGT\n>q3\nTACGTA');
    const result = buildAlignmentPangenome(data, { referenceId: 'ref', alignment: 'global', terminalGaps: 'alleles' });
    assertPaths(result); assertVariantReconstruction(result);
    for (const row of data.sequences) assert.equal(result.alignment.find(s => s.id === row.id)!.sequence.replaceAll('-', ''), row.sequence);
    assert.ok(result.diagnostics.alignmentCells > 0);
  });
  it('rejects gapped raw input and workloads outside the total DP budget', () => {
    assert.throws(() => buildAlignmentPangenome(input(), { alignment: 'global' }), /ungapped/);
    assert.throws(() => alignPangenomePair('A'.repeat(4000), 'T'.repeat(4000)), /DP cells/);
    const data = parsePangenomeInput(`>ref\n${'A'.repeat(2500)}\n>b\n${'C'.repeat(2500)}\n>c\n${'G'.repeat(2500)}`);
    assert.throws(() => buildAlignmentPangenome(data, { referenceId: 'ref', alignment: 'global' }), /total.*budget/);
  });
});

describe('portable sequence graph evidence', () => {
  it('exports standards-shaped GFA whose independent reader spells every sample exactly', () => {
    const result = buildAlignmentPangenome(parsePangenomeInput('>λ+,{x} "local"\nAC-T\n>β\nAGGT'), { referenceId: 'β' });
    const exported = exportAlignmentGfa(result);
    assert.ok(!/[^\x00-\x7f]/.test(exported));
    const segments = new Map<string, string>(), links = new Set<string>(), paths: string[][] = [];
    for (const line of exported.trim().split('\n')) {
      const cells = line.split('\t');
      if (cells[0] === 'S') segments.set(cells[1], cells[2]);
      if (cells[0] === 'L') { assert.equal(cells[5], '0M'); links.add(`${cells[1]}:${cells[3]}`); }
      if (cells[0] === 'P') paths.push(cells);
    }
    assert.equal(paths.length, result.paths.length);
    for (const cells of paths) {
      const ids = cells[2].split(',').map(id => { assert.equal(id.at(-1), '+'); return id.slice(0, -1); });
      for (let i = 1; i < ids.length; i++) assert.ok(links.has(`${ids[i - 1]}:${ids[i]}`));
      const path = result.paths.find(p => p.id === cells[1])!;
      assert.equal(ids.map(id => segments.get(id)).join(''), result.alignment.find(s => s.id === path.sequenceId)!.sequence.replaceAll('-', ''));
      assert.ok(!segments.has(cells[1]), 'segment and path IDs share a namespace');
    }
    const comment = exported.split('\n').find(line => line.includes('\\u03bb'))!;
    assert.equal(JSON.parse(comment.split('\t')[2]).id, 'λ+,{x}');
  });
  it('exports the actual alignment with complete identifiers and characters', () => {
    const result = graph();
    assert.deepEqual(parsePangenomeInput(exportPangenomeAlignment(result)).sequences, result.alignment);
  });
  it('recomputes the exact graph and alleles from a saved analysis with matching identity', async () => {
    const value = graph(), record = await createAlignmentPangenomeRecord(input(), value);
    const replay = await replayAlignmentPangenome(serializeAnalysisRecord(record));
    assert.equal(replay.record.resultId, record.resultId); assert.deepEqual(replay.graph, value);
    assert.equal(record.fields.graph.kind, 'sequence-score'); assert.equal(record.inputs[0].source, 'local');
  });
  it('binds raw alignment parameters and exact input to an independently replayed global alignment', async () => {
    const data = parsePangenomeInput('>ref\nACGT\n>query\nAGT');
    const value = buildAlignmentPangenome(data, { referenceId: 'ref', alignment: 'global' });
    const record = await createAlignmentPangenomeRecord(data, value);
    assert.equal((await replayAlignmentPangenome(serializeAnalysisRecord(record))).record.resultId, record.resultId);
  });
  it('rejects tampering and valid-checksum forged outputs by recomputing actual sequence evidence', async () => {
    const record = await createAlignmentPangenomeRecord(input(), graph());
    const changed = structuredClone(record); changed.parameters.referenceId = 'q1';
    await assert.rejects(replayAlignmentPangenome(JSON.stringify(changed)), /identity differs/);
    (record.fields.variants.value as Array<Record<string, unknown>>)[0].alternate = 'A';
    await assert.rejects(replayAlignmentPangenome(await rewrite(record)), /Recomputed.*differ/);
  });
  it('rejects unsupported algorithm, reference versions and parameter injection even with valid hashes', async () => {
    for (const change of [
      (r: AnalysisRecord) => { r.method.version = '999'; },
      (r: AnalysisRecord) => { r.references[0].version = 'unknown'; },
      (r: AnalysisRecord) => { r.method.implementation = 'different aligner'; },
      (r: AnalysisRecord) => { r.parameters.eval = 'not executed'; },
      (r: AnalysisRecord) => { r.seed = 42; },
    ]) {
      const record = await createAlignmentPangenomeRecord(input(), graph()); change(record);
      await assert.rejects(replayAlignmentPangenome(await rewrite(record)));
    }
  });
  it('preserves explicit demonstration provenance instead of presenting synthetic data as measurements', async () => {
    const data = { ...input(), source: 'demo' as const };
    const record = await createAlignmentPangenomeRecord(data, buildAlignmentPangenome(data));
    assert.ok(Object.values(record.fields).every(f => f.kind === 'demo'));
    assert.equal((await replayAlignmentPangenome(serializeAnalysisRecord(record))).input.source, 'demo');
  });
  it('snapshots records before asynchronous hashing and parses reordered JSON keys', async () => {
    const data = input(), value = graph(), expected = await createAlignmentPangenomeRecord(data, value);
    const pending = createAlignmentPangenomeRecord(data, value);
    value.variants[0].alternate = 'AAAA'; data.sequences[0].sequence = 'NNNN';
    assert.equal((await pending).resultId, expected.resultId);
    const reversed = Object.fromEntries(Object.entries(expected).reverse());
    assert.equal((await parseAnalysisRecord(JSON.stringify(reversed))).resultId, expected.resultId);
  });
});

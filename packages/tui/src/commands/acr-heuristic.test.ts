import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { analyzeCRISPRPressure } from '../../../core/src/crispr';
import type { GeneInfo } from '../../../core/src/types';
import { executeTerminalAcrHeuristic, type TerminalAcrRequest } from './acr-heuristic';
import { runTerminalAcrHeuristic } from './spacer-reference';

const gene = (id: number, startPos: number, strand: string): GeneInfo => ({
  id, name: 'Synthetic gene ' + id, locusTag: null, startPos, endPos: startPos + 180, strand, product: null, type: 'CDS',
});
const fixture = (): TerminalAcrRequest => ({ kind: 'acr',
  genome: { name: 'Synthetic charge controls', accession: null, source: 'local', topology: 'linear',
    sequence: 'GAT'.repeat(60) + 'CCC' + 'ATC'.repeat(60) + 'CCC' + 'AAA'.repeat(60) },
  genes: [gene(1, 0, '+'), gene(2, 183, '-'), gene(3, 366, '+')] });

describe('optional native Acr size/charge heuristic', () => {
  it('retains the existing score on both supported orientations and snapshots submitted DNA/annotations', async () => {
    const request = fixture(), expected = analyzeCRISPRPressure(request.genome.sequence, request.genes).acrCandidates;
    const pending = runTerminalAcrHeuristic(request, new AbortController().signal);
    request.genome.sequence = 'C'.repeat(request.genome.sequence.length); request.genes[0].name = 'changed after submission';
    const result = await pending;
    assert.equal(result.eligibleGenes, 3); assert.equal(result.candidates.length, 2);
    assert.deepEqual(result.candidates.map(item => [item.geneId, item.score]), expected.map(item => [item.geneId, item.score]));
    assert.deepEqual(result.candidates.map(item => [item.geneId, item.score, item.strand, item.start, item.end]),
      [[1, 60, '+', 0, 180], [2, 60, '-', 183, 363]]);
    assert.equal(result.candidates[0].geneName, 'Synthetic gene 1');
    assert(!('family' in result.candidates[0])); assert(!('confidence' in result.candidates[0]));
    assert(!('pressureWindows' in result)); assert(!('spacerHits' in result));
  });

  it('reports unsupported annotations instead of flattening joined, partial or exceptional CDSs', async () => {
    const request = fixture(); request.genes = [request.genes[0]];
    const qualifiers = [
      { _segments: [{ start: 0, end: 90 }, { start: 90, end: 180 }] },
      { _location: 'join(1..90,91..180)' }, { _location: '<1..180' }, { codon_start: '2' },
      { transl_table: '4' }, { partial: '' }, { pseudo: '' }, { pseudogene: '' },
      { transl_except: '(pos:10..12,aa:Sec)' }, { exception: 'RNA editing' }, { ribosomal_slippage: '' },
    ];
    request.genes.push(...qualifiers.map((qualifiers, index) => ({ ...gene(index + 10, 0, '+'), qualifiers })));
    request.genes.push({ ...gene(30, 0, '+'), type: 'gene' }, { ...gene(31, 0, '+'), endPos: 179 }, gene(32, 0, '?'));
    const result = await runTerminalAcrHeuristic(request, new AbortController().signal);
    assert.equal(result.eligibleGenes, 1); assert.equal(result.candidates.length, 1);
    assert.equal(result.skipped['Compound, partial or exceptional translation annotation'], qualifiers.length);
    assert.equal(Object.values(result.skipped).reduce((a, b) => a + b, 0), request.genes.length - 1);
    const ambiguous = fixture(); ambiguous.genome.sequence = 'N' + ambiguous.genome.sequence.slice(1); ambiguous.genes = [ambiguous.genes[0]];
    assert.equal(executeTerminalAcrHeuristic(ambiguous).skipped['Ambiguous DNA in the annotated span'], 1);
    const empty = fixture(); empty.genes = [];
    assert.equal(executeTerminalAcrHeuristic(empty).eligibleGenes, 0);
  });

  it('enforces full-genome/annotation limits and cancels a real worker on progress', async () => {
    const oversized = fixture(); oversized.genome.sequence = 'A'.repeat(5_000_001);
    await assert.rejects(runTerminalAcrHeuristic(oversized, new AbortController().signal), /bounded IUPAC DNA/);
    const many = fixture(); many.genes = Array.from({ length: 10001 }, (_, index) => gene(index, 0, '+'));
    await assert.rejects(runTerminalAcrHeuristic(many, new AbortController().signal), /10,000/);
    const abort = new AbortController(); let sawProgress = false;
    await assert.rejects(runTerminalAcrHeuristic(fixture(), abort.signal, () => { sawProgress = true; abort.abort(); }), { name: 'AbortError' });
    assert.equal(sawProgress, true);
    await assert.rejects(runTerminalAcrHeuristic(fixture(), abort.signal), { name: 'AbortError' });
  });
});

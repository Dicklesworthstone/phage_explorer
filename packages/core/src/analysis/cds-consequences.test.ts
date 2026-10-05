import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createCdsConsequenceExperiment, replayCdsConsequenceExperiment, type CdsAlignment,
  type CdsConsequenceOptions } from './cds-consequences';
import { createAnalysisRecord, serializeAnalysisRecord } from '../analysis-result';
import { importLocalGenomes } from '../genome-import';

function genbank(sequence: string, locations = [`1..${sequence.length}`], qualifiers = '', topology = 'linear', accession = 'REF') {
  return { name: 'reference.gb', text: `LOCUS       ${accession} ${sequence.length} bp DNA ${topology}\nACCESSION   ${accession}\nFEATURES             Location/Qualifiers\n` +
    locations.map((location, i) => `     CDS             ${location}\n                     /locus_tag="gene${i + 1}"\n${qualifiers}`).join('') +
    `ORIGIN\n        1 ${sequence.toLowerCase()}\n//\n` };
}
function alignment(reference: string, ...queries: string[]): CdsAlignment {
  return { name: 'CDS fixture', source: 'local', sequences: [{ id: 'r', description: 'reference', sequence: reference },
    ...queries.map((sequence, i) => ({ id: `q${i}`, description: '', sequence }))] };
}
const options: CdsConsequenceOptions = { referenceId: 'r', terminalGaps: 'missing' };
const rc = (s: string) => [...s].reverse().map(c => ({ A: 'T', C: 'G', G: 'C', T: 'A', '-': '-' })[c] ?? c).join('');
const run = (r: string, q: string, source = genbank(r.replaceAll('-', '')), settings = options) =>
  createCdsConsequenceExperiment(alignment(r, q), source, settings);

describe('alignment-conditional coding consequences', () => {
  it('evaluates multi-base changes in the same codon jointly and retains actual coding inputs', async () => {
    // TCT and AGT both encode serine; the individual changes ACT and TGT do not.
    const result = await run('ATGTCTTAA', 'ATGAGTTAA');
    assert.equal(result.genes[0].cds, 'ATGTCTTAA');
    assert.equal(result.genes[0].protein, 'MS*');
    assert.equal(result.consequences[0].queryCds, 'ATGAGTTAA');
    assert.equal(result.consequences[0].queryProtein, 'MS*');
    assert.deepEqual(result.consequences[0].effects, ['synonymous']);
    assert.equal(result.consequences[0].changedColumns, 2);
    assert.equal(result.summary.changed, 1);
  });
  it('distinguishes amino-acid, early-stop, stop-loss and start-codon changes', async () => {
    const r = 'ATGAAAGCTTAA';
    const result = await createCdsConsequenceExperiment(alignment(r, 'ATGGAGGCTTAA', 'ATGTAAGCTTAA', 'ATGAAAGCTCAA', 'ACGAAAGCTTAA'), genbank(r), options);
    const [amino, stop, lost, start] = result.consequences;
    assert.deepEqual(amino.effects, ['amino-acid-change']); assert.equal(amino.firstProteinDifference, 1);
    assert(stop.effects.includes('premature-stop')); assert.equal(stop.queryProtein, 'M*A*');
    assert(lost.effects.includes('terminal-stop-lost')); assert.equal(lost.queryProtein, 'MKAQ');
    assert(start.effects.includes('start-codon-lost'));
  });
  it('projects reverse-strand and spliced transcripts rather than translating genomic spans', async () => {
    const r = 'ATGAAACCGCTTAA', q = 'ATGAAGTTGCCTAA';
    const forward = await run(r, q, genbank(r, ['join(1..6,9..14)']));
    assert.equal(forward.genes[0].cds, 'ATGAAAGCTTAA');
    assert.equal(forward.consequences[0].queryCds, 'ATGAAGGCCTAA');
    assert.deepEqual(forward.consequences[0].effects, ['synonymous']);
    const reverse = await run(rc(r), rc(q), genbank(rc(r), ['complement(join(1..6,9..14))']));
    assert.equal(reverse.genes[0].cds, forward.genes[0].cds);
    assert.equal(reverse.consequences[0].queryCds, forward.consequences[0].queryCds);
    assert.deepEqual(reverse.consequences[0].effects, ['synonymous']);
  });
  it('measures codon_start on reference positions even when the skipped query base is deleted', async () => {
    const result = await run('AATGAAATAA', '-ATGAAATAA', genbank('AATGAAATAA', undefined, '                     /codon_start=2\n'));
    assert.equal(result.genes[0].cds, 'ATGAAATAA');
    assert.equal(result.consequences[0].queryCds, 'ATGAAATAA');
    assert.equal(result.consequences[0].missingReferenceBases, 0);
    assert.deepEqual(result.consequences[0].effects, ['unchanged']);
  });
  it('keeps triplet insertions and deletions in frame, including a deletion across a joined segment boundary', async () => {
    const insertion = await run('ATG---AAAGCTTAA', 'ATGGGGAAAGCTTAA');
    assert.deepEqual(insertion.consequences[0].effects, ['inframe-indel']);
    assert.equal(insertion.consequences[0].queryProtein, 'MGKA*');
    assert.deepEqual(insertion.consequences[0].indels, [{ kind: 'insertion', cdsOffset: 3, length: 3 }]);
    const deletion = await run('ATGAAAGCTTAA', 'ATGA---CTTAA', genbank('ATGAAAGCTTAA', ['join(1..5,6..12)']));
    assert.deepEqual(deletion.consequences[0].effects, ['inframe-indel']);
    assert.deepEqual(deletion.consequences[0].indels, [{ kind: 'deletion', cdsOffset: 4, length: 3 }]);
  });
  it('reports temporary frame disruption even when later indels restore total length', async () => {
    const result = await run('ATG-AAAGCTTAA', 'ATGCAA-GCTTAA');
    const row = result.consequences[0];
    assert.equal(row.queryCds, 'ATGCAAGCTTAA');
    assert.equal(row.queryProtein, 'MQA*');
    assert.deepEqual(row.effects, ['frameshift', 'frame-restored']);
    assert.equal(row.insertedBases, 1); assert.equal(row.deletedBases, 1);
    const permanent = await run('ATG-AAAGCTTAA', 'ATGCAAAGCTTAA');
    assert(permanent.consequences[0].effects.includes('frameshift'));
    assert(!permanent.consequences[0].effects.includes('frame-restored'));
    assert.equal(permanent.consequences[0].queryTrailingBases, 1);
  });
  it('distinguishes internal whole-CDS deletion, absent terminal coverage and ambiguous sequence', async () => {
    const r = 'GGATGAAATAACC', source = genbank(r, ['3..11']);
    const result = await run(r, 'GG---------CC', source);
    assert.deepEqual(result.consequences[0].effects, ['cds-deleted']);
    const missing = await run(r, '---------ACC', source).catch(() => null);
    assert.equal(missing, null, 'unequal alignment lengths are not accepted');
    const partial = await run(r, '---------AACC', source);
    assert.equal(partial.consequences[0].status, 'unavailable');
    assert.equal(partial.consequences[0].missingReferenceBases, 7);
    assert.equal(partial.consequences[0].queryProtein, null);
    assert.deepEqual(partial.consequences[0].effects, []);
    const ambiguous = await run(r, 'GGATGNAATAACC', source);
    assert.equal(ambiguous.consequences[0].ambiguousQueryBases, 1);
    assert.equal(ambiguous.consequences[0].status, 'unavailable');
  });
  it('includes circular-junction insertion slots exactly once on both strands', async () => {
    const r = '---ATAACCCATGAA', q = 'GGGATAACCCATGAA', bases = r.replaceAll('-', '');
    const forward = await run(r, q, genbank(bases, ['join(8..12,1..4)'], '', 'circular'), { ...options, terminalGaps: 'alleles' });
    assert.equal(forward.genes[0].cds, 'ATGAAATAA');
    assert.equal(forward.consequences[0].queryCds, 'ATGAAGGGATAA');
    const reverse = await run(r, q, genbank(bases, ['complement(join(8..12,1..4))'], '', 'circular'), { ...options, terminalGaps: 'alleles' });
    assert.equal(reverse.genes[0].cds, rc(forward.genes[0].cds!));
    assert.equal(reverse.consequences[0].queryCds, rc(forward.consequences[0].queryCds!));
    assert.equal(reverse.consequences[0].insertedBases, 3);
  });
  it('excludes boundary insertions and introns but retains insertions inside contiguous joins', async () => {
    const r = '---ATG---AAATAA---', q = 'CCCATGGGGAAATAACCC';
    const result = await run(r, q, genbank('ATGAAATAA', ['join(1..3,4..9)']));
    assert.equal(result.consequences[0].queryCds, 'ATGGGGAAATAA');
    assert.equal(result.consequences[0].insertedBases, 3);
  });
  it('uses the selected genetic-code initiators and verifies supplied conceptual translation', async () => {
    const r = 'GTGGTGTAA';
    const bacterial = await run(r, r, genbank(r, undefined, '                     /transl_table=11\n                     /translation="MV"\n'));
    assert.equal(bacterial.genes[0].protein, 'MV*');
    assert.equal(bacterial.consequences[0].status, 'available');
    const standard = await run(r, r); assert.equal(standard.genes[0].protein, 'VV*');
    const wrong = await run(r, r, genbank(r, undefined, '                     /translation="XX"\n'));
    assert.equal(wrong.consequences[0].status, 'unavailable');
    assert.match(wrong.genes[0].reasons.join(' '), /translation differs/);
  });
  it('preserves unsupported gene and parser-coverage reasons instead of silently declaring identity', async () => {
    const r = 'ATGAAATAA';
    for (const qualifier of ['/pseudo', '/exception="RNA editing"', '/transl_except=(pos:1..3,aa:Sec)', '/ribosomal_slippage', '/transl_table=4', '/codon_start=4', '/transl_table=bad', '/codon_start=unknown']) {
      const result = await run(r, r, genbank(r, undefined, `                     ${qualifier}\n`));
      assert.equal(result.consequences[0].status, 'unavailable', qualifier);
      assert.deepEqual(result.consequences[0].effects, []);
    }
    const overlapping = await run(r, r, genbank(r, ['join(1..6,4..9)']));
    assert.match(overlapping.genes[0].reasons.join(' '), /overlapping/);
    const internalStop = await run('ATGTAATAA', 'ATGTAATAA');
    assert.match(internalStop.genes[0].reasons.join(' '), /internal stop/);
    const partial = await run('ATGAAATA', 'ATGAAATA');
    assert.match(partial.genes[0].reasons.join(' '), /complete terminal codons/);
    const warnings = await run(r, r, genbank(r, ['1..9', '<1..9']));
    assert.equal(warnings.genes.length, 1);
    assert(warnings.reference.warnings.some(w => w.includes('Unsupported feature location')));
  });
  it('refuses mismatched references and ambiguous accessions; records the selected annotation content', async () => {
    const r = 'ATGAAATAA', source = genbank(r);
    await assert.rejects(run(r, r, genbank('ATGAAGTAA')), /exactly match/);
    const multi = { name: 'same.gb', text: source.text + source.text.replace('gene1', 'other') };
    await assert.rejects(run(r, r, multi), /exactly one/);
    const parsed = await importLocalGenomes(multi), id = parsed.genomes[1].phage.localGenome!.contentId;
    const result = await run(r, r, multi, { ...options, annotationRecord: id });
    assert.equal(result.reference.contentId, id); assert.equal(result.genes[0].name, 'other');
    const selected = await run(r, r, genbank(r, ['1..9', '4..9']), { ...options, geneIds: [2] });
    assert.deepEqual(selected.genes.map(g => g.geneId), [2]);
    await assert.rejects(run(r, r, source, { ...options, geneIds: [3] }), /absent/);
  });
  it('recomputes exact identities, snapshots before awaits, and rejects correctly rehashed forged consequences', async () => {
    const r = 'ATGAAATAA', data = alignment(r, r), source = genbank(r), opts = { ...options };
    const pending = createCdsConsequenceExperiment(data, source, opts);
    data.sequences[0].sequence = 'CCCCCCCCC'; source.text = 'changed'; opts.referenceId = 'other';
    const result = await pending;
    assert.deepEqual(await replayCdsConsequenceExperiment(serializeAnalysisRecord(result.record)), result);
    const saved = structuredClone(result.record);
    const forgedRows = saved.fields.consequences.value as unknown as typeof result.consequences;
    forgedRows[0].effects = ['frameshift'];
    const forged = await createAnalysisRecord(saved);
    await assert.rejects(replayCdsConsequenceExperiment(serializeAnalysisRecord(forged)), /Recomputed/);
    const demo = await createCdsConsequenceExperiment({ ...alignment(r, r), source: 'demo' }, genbank(r), options);
    assert.equal(demo.record.fields.consequences.kind, 'demo');
  });
  it('validates payloads, selections and work budgets before producing an experiment', async () => {
    const r = 'ATGAAATAA', source = genbank(r);
    for (const change of [{ referenceId: 'absent' }, { terminalGaps: 'guess' }, { geneIds: [] }, { geneIds: [1, 1] }, { extra: true }]) {
      await assert.rejects(createCdsConsequenceExperiment(alignment(r, r), source, { ...options, ...change } as CdsConsequenceOptions));
    }
    for (const change of [{ source: 'external' }, { sequences: [] }, { name: 'bad\nname' }]) {
      await assert.rejects(createCdsConsequenceExperiment({ ...alignment(r, r), ...change } as CdsAlignment, source, options));
    }
    await assert.rejects(run(r, 'ATGAAATA?'), /Invalid aligned DNA/);
    await assert.rejects(run(r, r, { name: 'a.fa', text: '>REF\n' + r }), /GenBank/);
    const many = genbank(r, Array(523).fill('1..9'));
    await assert.rejects(createCdsConsequenceExperiment(alignment(r, ...Array(23).fill(r)), many, options), /12,000/);
    const long = 'ATG' + 'AAA'.repeat(2000) + 'TAA';
    await assert.rejects(run(long, long, genbank(long, Array(700).fill(`1..${long.length}`))), /8,000,000/);
  });
  it('does not alter identities or numerical outputs when aligned rows are reordered', async () => {
    const r = 'ATGAAATAA', input = alignment(r, r, 'ATGAACTAA');
    const first = await createCdsConsequenceExperiment(input, genbank(r), options);
    const second = await createCdsConsequenceExperiment({ ...input, sequences: [...input.sequences].reverse() }, genbank(r), options);
    assert.deepEqual(second, first);
  });
  it('checks all 61 sense reference codons against all 64 query codons using the independent NCBI codon-order oracle', async () => {
    const code = 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG';
    const codons = [...'TCAG'].flatMap(a => [...'TCAG'].flatMap(b => [...'TCAG'].map(c => a + b + c)));
    let checked = 0;
    for (let r = 0; r < 64; r++) {
      if (code[r] === '*') continue;
      const ref = 'ATG' + codons[r] + 'TAA';
      for (let start = 0; start < 64; start += 23) {
        const result = await createCdsConsequenceExperiment(alignment(ref, ...codons.slice(start, start + 23).map(c => 'ATG' + c + 'TAA')), genbank(ref), options);
        for (const row of result.consequences) {
          const q = start + Number(row.sequenceId.slice(1));
          assert.equal(row.queryProtein, `M${code[q]}*`);
          assert.equal(row.status, 'available');
          assert(row.effects.includes(q === r ? 'unchanged' : code[q] === code[r] ? 'synonymous' : code[q] === '*' ? 'premature-stop' : 'amino-acid-change'));
          checked++;
        }
      }
    }
    assert.equal(checked, 3904);
  });
});

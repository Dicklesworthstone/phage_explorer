import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../analysis-result';
import { analyzeCodonSelection, countCodonPair, createCodonSelectionRecord, parseCodonAlignmentFasta,
  replayCodonSelectionRecord, resolveCodonSelectionOptions, translateSelectionCodon, validateCodonAlignment,
  type CodonAlignmentInput } from './codon-selection';

export const codingFixture = (): CodonAlignmentInput => ({
  format: 'phage-explorer-codon-alignment', version: 1, name: 'Hand-derived coding comparison',
  source: { kind: 'demo', description: 'Ten alanine codons; one synonymous and one nonsynonymous difference.', reference: 'Analytic test fixture, not an empirical reference', license: 'CC0' },
  alignment: { fasta: '>left\n' + 'GCT'.repeat(10) + '\n>right\nGCCGAT' + 'GCT'.repeat(8),
    homologousCodons: true, orientation: 'coding-5to3', frame: 0, geneticCode: 11,
    method: 'Hand-aligned codons', reference: 'Codon columns declared by construction' },
});
const close = (a: number | null, b: number, tol = 1e-12) => { assert.ok(a !== null && Math.abs(a - b) < tol, `${a} != ${b}`); };
const jc = (p: number) => -0.75 * Math.log(1 - 4 * p / 3);
const changed = (fasta: string) => { const input = codingFixture(); input.alignment.fasta = fasta; return input; };

// Independent state-path oracle: enumerate all 64^2 possible sense endpoints,
// and all 6 full position permutations. Unlike production recursion, identical
// positions are included, then transitions are collapsed before scoring.
// The independent genetic-code string uses A,C,G,T order, not NCBI TCAG order.
const BASES = 'ACGT', AA = 'KNKNTTTTRSRSIIMIQHQHPPPPRRRRLLLLEDEDAAAAGGGGVVVV*Y*YSSSS*CWCLFLF';
const table: Record<string, string> = {};
let aai = 0;
for (const a of BASES) for (const b of BASES) for (const c of BASES) table[a + b + c] = AA[aai++];
const orders = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
function oracle(a: string, b: string) {
  let paths = 0, syn = 0;
  const unique = new Set<string>();
  for (const order of orders) {
    const effective = order.filter(i => a[i] !== b[i]);
    const key = effective.join(''); if (unique.has(key)) continue; unique.add(key);
    let state = a, n = 0, valid = true;
    for (const pos of effective) {
      const next = [...state]; next[pos] = b[pos]; const s = next.join('');
      if (table[s] === '*') { valid = false; break; }
      n += Number(table[state] === table[s]); state = s;
    }
    if (valid) { paths++; syn += n; }
  }
  const opportunities = (codon: string) => {
    let n = 0;
    for (const other of Object.keys(table)) {
      if ([0,1,2].filter(i => other[i] !== codon[i]).length === 1 && table[other] === table[codon]) n++;
    }
    return n / 3;
  };
  return { sites: (opportunities(a) + opportunities(b)) / 2, changes: syn / paths, paths, rejected: unique.size - paths };
}

describe('explicit codon inputs', () => {
  it('requires declared homology, coding orientation, frame and a supported code', () => {
    for (const patch of [{ homologousCodons: false }, { frame: 1 }, { orientation: 'genomic' }, { geneticCode: 99 }]) {
      const input = codingFixture(); Object.assign(input.alignment, patch); assert.throws(() => validateCodonAlignment(input));
    }
    assert.throws(() => validateCodonAlignment({ ...codingFixture(), mystery: true }), /Unsupported/);
    assert.throws(() => analyzeCodonSelection(codingFixture(), { bootstrap: true }), /Unsupported/);
  });
  it('rejects raw sequence, unequal lengths, invalid characters, duplicate IDs and partial gaps', () => {
    for (const text of ['ATGATG', '>a\nAT\n>b\nAT', '>a\nATG\n>b\nATGATG', '>a\nATG\n>a\nATG', '>a\nA-G\n>b\nATG', '>a\nATX\n>b\nATG', '>a\nAT G\n>b\nATG']) {
      assert.throws(() => parseCodonAlignmentFasta(text));
    }
  });
  it('preserves FASTA IDs/descriptions and aligns whole-codon gaps without deleting columns', () => {
    const rows = parseCodonAlignmentFasta('\uFEFF>α description\r\natg---GCC\r\n>__proto__\r\nATGAAAANN\r\n');
    assert.equal(rows[0].sequence, 'ATG---GCC'); assert.equal(rows[0].description, 'α description'); assert.equal(rows[1].id, '__proto__');
  });
  it('implements explicit standard, bacterial and alternative elongation codes', () => {
    for (const code of [1,11] as const) { assert.equal(translateSelectionCodon('TGA',code),'*'); assert.equal(translateSelectionCodon('GTG',code),'V'); }
    assert.equal(translateSelectionCodon('TGA',4),'W'); assert.equal(translateSelectionCodon('TAG',15),'Q'); assert.equal(translateSelectionCodon('TGA',25),'G');
    assert.equal(translateSelectionCodon('TAA',25),'*');
  });
  it('rejects invalid coordinates, IDs, deletion choices and output budgets before calculation', () => {
    for (const options of [{ startCodon: -1 }, { endCodon: 11 }, { endCodon: 0 }, { windowCodons: 0 }, { windowCodons: 1.5 }, { referenceId:'missing' }, { comparison:'all-pairs',referenceId:'left' }, { missing:'infer' }]) {
      assert.throws(() => resolveCodonSelectionOptions(codingFixture(),options));
    }
    const input = changed(Array.from({length:32},(_,i)=>`>s${i}\nGCT`).join('\n'));
    assert.throws(() => analyzeCodonSelection(input, { comparison:'all-pairs' }), /budget/);
    assert.throws(() => analyzeCodonSelection(changed('>a\n'+'GCT'.repeat(5000)+'\n>b\n'+'GCT'.repeat(5000)), { windowCodons:1 }), /budget/);
  });
});

describe('sense-path counting and distance semantics', () => {
  it('matches an exhaustive independent oracle for all standard sense-codon pairs', () => {
    assert.equal(AA.length,64);
    for (const [a,aa] of Object.entries(table)) for (const [b,bb] of Object.entries(table)) {
      if (aa === '*' || bb === '*') continue;
      const expected = oracle(a,b), actual = countCodonPair(a,b,1);
      assert.ok(actual); close(actual.synonymousSites,expected.sites); close(actual.synonymousDifferences,expected.changes);
      assert.equal(actual.acceptedPaths,expected.paths); assert.equal(actual.rejectedPaths,expected.rejected);
      close(actual.synonymousSites+actual.nonsynonymousSites,3);
      close(actual.synonymousDifferences+actual.nonsynonymousDifferences,[0,1,2].filter(i=>a[i]!==b[i]).length);
      assert.deepEqual(actual,countCodonPair(b,a,1));
    }
  });
  it('averages multiple changes in order rather than scoring each only against the original codon', () => {
    // TTT -> TCA: two shortest paths, with S=[1,0] and N=[1,2].
    const a = countCodonPair('TTT','TCA',1)!;
    const expected = oracle('TTT','TCA'); close(a.synonymousDifferences,expected.changes);
    assert.equal(a.acceptedPaths,2); close(a.nonsynonymousDifferences,1.5); close(a.synonymousDifferences,.5);
  });
  it('does not use intermediate stop codons as viable mutation histories', () => {
    const actual=countCodonPair('TGG','TAT',1)!;
    assert.equal(actual.acceptedPaths,1); assert.equal(actual.rejectedPaths,1);
    close(actual.nonsynonymousDifferences,2); close(actual.synonymousDifferences,0);
  });
  it('recovers a hand-derived pooled estimate with averaged opportunities', () => {
    const fit=analyzeCodonSelection(codingFixture()).pairs[0].overall;
    // Left 10 GCT: S=10. Right: 9 alanine codons S=9, GAT S=1/3.
    close(fit.synonymousSites,29/3); close(fit.nonsynonymousSites,61/3);
    close(fit.synonymousDifferences,1); close(fit.nonsynonymousDifferences,1);
    close(fit.dS.value,jc(3/29)); close(fit.dN.value,jc(3/61)); close(fit.omega,jc(3/61)/jc(3/29));
    assert.equal(fit.unavailableReason,null); assert.equal(fit.retained,10);
  });
  it('pools sites/counts across windows rather than averaging their ratios', () => {
    const a=analyzeCodonSelection(codingFixture(),{windowCodons:1}).pairs[0];
    const b=analyzeCodonSelection(codingFixture(),{windowCodons:10}).pairs[0];
    close(a.overall.omega,b.overall.omega!); assert.equal(a.windows.length,10);
    assert.equal(a.windows[0].dS.status,'saturated'); assert.equal(a.windows[1].omega,null);
  });
  it('returns undefined ratios for no synonymous changes, including identical inputs', () => {
    for (const right of ['GCT'.repeat(10),'GAT'+'GCT'.repeat(9)]) {
      const fit=analyzeCodonSelection(changed('>a\n'+'GCT'.repeat(10)+'\n>b\n'+right)).pairs[0].overall;
      assert.equal(fit.omega,null); assert.equal(fit.dS.value,0); assert.match(fit.unavailableReason!,/undefined/);
    }
  });
  it('reports saturation without clipping and still permits a finite zero dN/dS', () => {
    const saturated=analyzeCodonSelection(changed('>a\nGCT\n>b\nGCC')).pairs[0].overall;
    assert.equal(saturated.dS.status,'saturated'); assert.equal(saturated.dS.value,null); assert.equal(saturated.omega,null);
    const input=codingFixture(); input.alignment.fasta='>a\n'+'GCT'.repeat(10)+'\n>b\nGCC'+'GCT'.repeat(9);
    assert.equal(analyzeCodonSelection(input).pairs[0].overall.omega,0);
  });
  it('does not fabricate opportunity counts when every retained codon has no synonymous neighbours', () => {
    const fit=analyzeCodonSelection(changed('>a\nATGTGG\n>b\nATGTGG')).pairs[0].overall;
    assert.equal(fit.retained,2); assert.equal(fit.dS.status,'no-sites'); assert.equal(fit.omega,null);
  });
  it('counts gaps, ambiguity, stop and retained codons without losing coordinate coverage', () => {
    const result=analyzeCodonSelection(changed('>a\n---GCNTAAATG\n>b\nGCTGCTGCTATG'),{windowCodons:2});
    const pair=result.pairs[0]; assert.deepEqual(pair.overall.excluded,{gap:1,ambiguous:1,stop:1,'no-sense-path':0,'complete-deletion':0});
    assert.equal(pair.overall.retained,1); assert.equal(pair.windows[1].startCodon,2); assert.equal(pair.windows[1].endCodon,4);
    assert.equal(result.sequences[0].aminoAcids,'-X*M');
  });
  it('complete deletion masks the same unusable column for every comparison', () => {
    const input=changed('>a\nGCTGCT\n>b\nGCCGCT\n>c\n---GCT');
    const pair=analyzeCodonSelection(input,{comparison:'all-pairs',missing:'pairwise'}).pairs[0];
    const complete=analyzeCodonSelection(input,{comparison:'all-pairs',missing:'complete'}).pairs[0];
    assert.equal(pair.overall.retained,2); assert.equal(complete.overall.retained,1); assert.equal(complete.overall.excluded['complete-deletion'],1);
  });
  it('alternative code changes which codons can enter the comparison', () => {
    const input=changed('>a\nTGATGG\n>b\nTGG TGG'.replace(' ',''));
    assert.equal(analyzeCodonSelection(input).pairs[0].overall.excluded.stop,1);
    input.alignment.geneticCode=4;
    const fit=analyzeCodonSelection(input).pairs[0].overall; assert.equal(fit.retained,2); assert.equal(fit.excluded.stop,0); close(fit.synonymousDifferences,1);
  });
  it('makes every unordered pair exactly once and orients reference comparisons explicitly', () => {
    const input=changed('>a\nGCT\n>b\nGCC\n>c\nGCA');
    assert.deepEqual(analyzeCodonSelection(input,{comparison:'all-pairs'}).pairs.map(p=>[p.left,p.right]),[['a','b'],['a','c'],['b','c']]);
    assert.deepEqual(analyzeCodonSelection(input,{referenceId:'b'}).pairs.map(p=>[p.left,p.right]),[['b','a'],['b','c']]);
  });
  it('keeps range coordinates in the original alignment and includes the short last window', () => {
    const fit=analyzeCodonSelection(codingFixture(),{startCodon:1,endCodon:8,windowCodons:3}).pairs[0];
    assert.deepEqual(fit.windows.map(w=>[w.startCodon,w.endCodon]),[[1,4],[4,7],[7,8]]); assert.equal(fit.overall.retained,7);
  });
  it('does not mutate caller inputs and publishes bounded progress during computation', () => {
    const input=codingFixture(),before=structuredClone(input),phases:string[]=[];
    analyzeCodonSelection(input,{},p=>phases.push(p)); assert.deepEqual(input,before); assert.ok(phases.some(p=>p.includes('alignment codon')));
  });
});

describe('portable codon evidence', () => {
  it('recomputes a record including source, code, coordinates and exact numerical evidence', async () => {
    const input=codingFixture(),record=await createCodonSelectionRecord(input,analyzeCodonSelection(input));
    const replay=await replayCodonSelectionRecord(serializeAnalysisRecord(record)); assert.deepEqual(replay.record,record);
    assert.equal(record.fields.comparisons.kind,'demo'); assert.equal(record.inputs[0].source,'demo');
    input.source.kind='local'; const actual=await createCodonSelectionRecord(input,analyzeCodonSelection(input));
    assert.equal(actual.fields.comparisons.kind,'fitted-estimate'); assert.notEqual(actual.resultId,record.resultId);
  });
  it('rejects rehashed invented ratios, reference changes and method changes', async () => {
    const input=codingFixture(); const record=await createCodonSelectionRecord(input,analyzeCodonSelection(input));
    for (const change of [(r:any)=>{r.fields.comparisons.value.pairs[0].overall.omega=10;},(r:any)=>{r.references[0].version='other';},(r:any)=>{r.method.version='2';}]) {
      const r=structuredClone(record); change(r);
      const forged=await createAnalysisRecord({...r,inputs:r.inputs.map(({sha256:_sha,...v})=>v)});
      await assert.rejects(replayCodonSelectionRecord(serializeAnalysisRecord(forged)),/differs|incompatible/);
    }
  });
  it('rejects ordinary tampering before computation', async () => {
    const input=codingFixture(),record=await createCodonSelectionRecord(input,analyzeCodonSelection(input));
    record.parameters.windowCodons=2; let progress=0;
    await assert.rejects(replayCodonSelectionRecord(JSON.stringify(record),()=>progress++),/identity differs/); assert.equal(progress,0);
  });
  it('round-trips unavailable distances as null with explicit reasons', async () => {
    const input=changed('>a\nGCT\n>b\nGCT'),record=await createCodonSelectionRecord(input,analyzeCodonSelection(input));
    const parsed=await parseAnalysisRecord(serializeAnalysisRecord(record));
    const replay=await replayCodonSelectionRecord(serializeAnalysisRecord(parsed)); assert.equal(replay.result.pairs[0].overall.omega,null);
    assert.match(replay.result.pairs[0].overall.unavailableReason!,/undefined/);
  });
});

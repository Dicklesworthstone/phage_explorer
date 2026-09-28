import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { analysisJson, createAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../analysis-result';
import { validateHostModelInput } from './host-metabolism';
import { analyzeHostGeneKnockouts, createHostGeneRecord, hostGeneRuleActive, inspectHostGeneRules,
  parseHostGeneRule, replayHostGeneRecord, resolveHostGeneOptions } from './host-gene-knockout';

export function geneFixture() {
  return validateHostModelInput({ format: 'phage-explorer-host-model', version: 1,
    source: { kind: 'demo', name: 'Independent two-route fixture', version: '1', organism: 'synthetic', strain: 'none', accession: 'fixture',
      reference: 'Supply 9; complex route capacity 6; alternative route capacity 4; sum constrained by supply.', license: 'CC0-1.0', fluxUnits: 'arbitrary', objectiveUnits: 'arbitrary' },
    medium: { name: 'Supply limited', reference: 'Hand-derived constraints', bounds: [] },
    cobra: { id: 'gpr-fixture', metabolites: [{ id: 'S', compartment: 'c' }, { id: 'P', compartment: 'c' }],
      genes: ['a','b','c','d','unused'].map(id => ({ id })), reactions: [
        { id: 'supply', metabolites: { S: 1 }, lower_bound: 0, upper_bound: 9 },
        { id: 'complex', metabolites: { S: -1, P: 1 }, lower_bound: 0, upper_bound: 6, gene_reaction_rule: 'a and b' },
        { id: 'alternative', metabolites: { S: -1, P: 1 }, lower_bound: 0, upper_bound: 4, gene_reaction_rule: 'c or d' },
        { id: 'objective', metabolites: { P: -1 }, lower_bound: 0, upper_bound: 20, objective_coefficient: 1 },
      ] } });
}
const settings = (genes: string[], extra: Record<string, unknown> = {}) => ({ genes, reference: 'Explicit synthetic deletion', ...extra });
const close = (actual: number | null, expected: number, tolerance = 1e-6) => { assert.notEqual(actual, null); assert.ok(Math.abs(actual! - expected) < tolerance, `${actual} != ${expected}`); };

describe('Boolean GPR semantics and validation', () => {
  it('matches the full independent truth table for a required complex or an alternative', () => {
    const rule = parseHostGeneRule('a AND b Or c', new Set(['a','b','c']));
    // Deleted genes bit mask a=1,b=2,c=4. c rescues all combinations while present.
    const expected = [true,true,true,true,true,false,false,false];
    for (let mask=0;mask<8;mask++) assert.equal(hostGeneRuleActive(rule,new Set(['a','b','c'].filter((_,i)=>mask&(1<<i)))),expected[mask]);
    assert.deepEqual(rule.genes, ['a','b','c']);
  });
  it('parentheses change requirements without changing operator precedence', () => {
    const genes = new Set(['a','b','c']), missing = new Set(['a']);
    assert.equal(hostGeneRuleActive(parseHostGeneRule('a and (b or c)', genes),missing),false);
    assert.equal(hostGeneRuleActive(parseHostGeneRule('a and b or c', genes),missing),true);
  });
  it('keeps empty rules available and reports them as unassociated', () => {
    assert.equal(hostGeneRuleActive(parseHostGeneRule(' \n ',new Set()),new Set()),true);
    const index = inspectHostGeneRules(geneFixture());
    assert.deepEqual(index.unassociatedReactions,['supply','objective']);
    assert.deepEqual(index.genes.find(g=>g.id==='unused')!.reactionIds,[]);
  });
  it('supports literal dotted, prefixed and prototype-looking identifiers', () => {
    const ids = ['1.2','g-3','ns:x','__proto__','constructor'];
    const rule = parseHostGeneRule(ids.join(' and '),new Set(ids));
    assert.equal(hostGeneRuleActive(rule,new Set(['__proto__'])),false);
    assert.equal(hostGeneRuleActive(rule,new Set()),true);
  });
  it('rejects scripts, unsupported operators, missing operators and incomplete rules', () => {
    for (const text of ['a && b','a || b','not a','a xor b','true','a b','a and','()','(a','a)','a;process.exit()','a or missing','a\u0000']) {
      assert.throws(()=>parseHostGeneRule(text,new Set(['a','b'])),/./,text);
    }
  });
  it('bounds recursive depth and token count', () => {
    assert.throws(()=>parseHostGeneRule('('.repeat(66)+'a'+')'.repeat(66),new Set(['a'])),/nesting/);
    assert.throws(()=>parseHostGeneRule(Array(1400).fill('(a)').join(' or '),new Set(['a'])),/token/);
  });
  it('validates every rule, including a malformed rule unrelated to selected genes, before solving', () => {
    const input=geneFixture();(input.cobra as any).reactions[2].gene_reaction_rule='d and missing';
    let progress=0;
    assert.throws(()=>analyzeHostGeneKnockouts(input,settings(['a']),()=>progress++),/undeclared/);
    assert.equal(progress,0);
  });
  it('requires a declared gene list and exact known deletion IDs', () => {
    const input=geneFixture();delete (input.cobra as any).genes;
    assert.throws(()=>analyzeHostGeneKnockouts(input,settings(['a'])),/declared/);
    assert.throws(()=>analyzeHostGeneKnockouts(geneFixture(),settings(['A'])),/not declared/);
  });
  it('rejects duplicate, empty, unsupported and oversized experiment settings', () => {
    for (const value of [settings([]),settings(['a','a']),settings(['a'],{mode:'pairs'}),settings(['a'],{reference:''}),settings(['a'],{script:'x'}),settings(Array.from({length:33},(_,i)=>'g'+i))]) assert.throws(()=>resolveHostGeneOptions(value));
    assert.throws(()=>resolveHostGeneOptions(settings(Array.from({length:32},(_,i)=>'g'+i),{mode:'single',variability:Array.from({length:12},(_,i)=>'r'+i)})),/256/);
  });
});

describe('model-linked knockout experiments', () => {
  it('uses the independently derived route capacities and supply bottleneck', () => {
    const result=analyzeHostGeneKnockouts(geneFixture(),settings(['a','b','c','d'],{mode:'single'}));
    close(result.baseline.objective,9);
    assert.deepEqual(result.runs.map(r=>r.genes),[['a'],['b'],['c'],['d']]);
    result.runs.forEach((r,i)=>close(r.scenario.objective,[4,4,9,9][i]));
    close(result.runs[0].objectiveDelta,-5);close(result.runs[0].relativeObjective,4/9);
  });
  it('joint deletion disables redundant alternatives, without summing single effects', () => {
    const result=analyzeHostGeneKnockouts(geneFixture(),settings(['d','c']));
    close(result.runs[0].scenario.objective,6);
    assert.deepEqual(result.runs[0].disabled.map(r=>r.reactionId),['alternative']);
    close(analyzeHostGeneKnockouts(geneFixture(),settings(['a','c','d'])).runs[0].scenario.objective,0);
  });
  it('does not mutate the input or leak deletions into later independent experiments', () => {
    const input=geneFixture(),before=structuredClone(input);
    analyzeHostGeneKnockouts(input,settings(['a','c','d']));
    assert.deepEqual(input,before);
    close(analyzeHostGeneKnockouts(input,settings(['c'])).baseline.objective,9);
  });
  it('retains a requested unassociated gene experiment rather than calling the gene dispensable', () => {
    const result=analyzeHostGeneKnockouts(geneFixture(),settings(['unused']));
    assert.deepEqual(result.runs[0].disabled,[]);assert.deepEqual(result.runs[0].unassociatedGenes,['unused']);
    close(result.runs[0].scenario.objective,9);assert.match(result.warnings.join(' '),/not biologically dispensable/);
  });
  it('uses accepted medium bounds before deletion and records any forced-flux override', () => {
    const input=geneFixture();input.medium.bounds=[{reactionId:'complex',lowerBound:2,upperBound:3}];
    const result=analyzeHostGeneKnockouts(input,settings(['a']));
    close(result.baseline.objective,7);close(result.runs[0].scenario.objective,4);
    assert.deepEqual(result.runs[0].disabled[0],{reactionId:'complex',rule:'a and b',genes:['a','b'],previousLowerBound:2,previousUpperBound:3});
  });
  it('zeros both signed bounds of reverse-only reactions', () => {
    const input=geneFixture(), reaction=(input.cobra as any).reactions[1];
    reaction.metabolites={S:1,P:-1};reaction.lower_bound=-6;reaction.upper_bound=-1;
    const result=analyzeHostGeneKnockouts(input,settings(['a']));
    close(result.baseline.objective,9);close(result.runs[0].scenario.objective,4);
    assert.deepEqual(result.runs[0].scenario.bounds.find(r=>r.reactionId==='complex'),{reactionId:'complex',lowerBound:0,upperBound:0});
  });
  it('preserves infeasibility and reports no objective ratio or difference', () => {
    const input=geneFixture();input.medium.bounds=[{reactionId:'objective',lowerBound:8,upperBound:20}];
    const result=analyzeHostGeneKnockouts(input,settings(['a']));
    assert.equal(result.baseline.status,'optimal');assert.equal(result.runs[0].scenario.status,'infeasible');
    assert.equal(result.runs[0].objectiveDelta,null);assert.equal(result.runs[0].relativeObjective,null);
  });
  it('does not manufacture ratios for a zero baseline or evidence from an infeasible baseline', () => {
    const zero=geneFixture();zero.medium.bounds=[{reactionId:'supply',lowerBound:0,upperBound:0}];
    const result=analyzeHostGeneKnockouts(zero,settings(['a']));close(result.baseline.objective,0);assert.equal(result.runs[0].relativeObjective,null);
    zero.medium.bounds.push({reactionId:'objective',lowerBound:2,upperBound:20});
    const failed=analyzeHostGeneKnockouts(zero,settings(['a']));assert.equal(failed.baseline.status,'infeasible');assert.equal(failed.runs[0].objectiveDelta,null);
  });
  it('computes independent alternative-optimum ranges before and after deletion', () => {
    const result=analyzeHostGeneKnockouts(geneFixture(),settings(['a'],{variability:['complex','alternative']}));
    const baseline=result.baseline.ranges[0];close(baseline.minimum.value,5,2e-6);close(baseline.maximum.value,6);
    const after=result.runs[0].scenario.ranges;close(after[0].minimum.value,0);close(after[0].maximum.value,0);
    close(after[1].minimum.value,4,2e-6);close(after[1].maximum.value,4);
  });
  it('supports a gene disabling more than the manual scenario limit of 50 reactions', () => {
    const input=geneFixture(),cobra=input.cobra as any;
    cobra.reactions.splice(1,2,...Array.from({length:55},(_,i)=>({id:'r'+i,metabolites:{S:-1,P:1},lower_bound:0,upper_bound:1,gene_reaction_rule:'a'})));
    const result=analyzeHostGeneKnockouts(input,settings(['a']));assert.equal(result.runs[0].disabled.length,55);close(result.runs[0].scenario.objective,0);
  });
});

describe('portable knockout result identity', () => {
  const run=async()=>{const input=geneFixture(),result=analyzeHostGeneKnockouts(input,settings(['c','d'],{variability:['complex']}));return {input,result,record:await createHostGeneRecord(input,result)};};
  const resign=async(record:AnalysisRecord)=>serializeAnalysisRecord(await createAnalysisRecord({...record,inputs:record.inputs.map(({sha256:_sha,...input})=>input)}));
  it('recomputes and reproduces a complete record on reopening', async()=>{
    const {record,result}=await run();const fresh=await replayHostGeneRecord(serializeAnalysisRecord(record));
    assert.deepEqual(fresh.result,result);assert.equal(fresh.record.resultId,record.resultId);
  });
  it('binds normalized deletion order but distinguishes single from joint mode', async()=>{
    const {input,record}=await run();const reordered=await createHostGeneRecord(input,analyzeHostGeneKnockouts(input,settings(['d','c'],{variability:['complex']})));
    assert.equal(reordered.resultId,record.resultId);
    const separate=await createHostGeneRecord(input,analyzeHostGeneKnockouts(input,settings(['c','d'],{mode:'single',variability:['complex']})));
    assert.notEqual(separate.resultId,record.resultId);
  });
  it('rejects both tampered checksums and internally rehashed false output', async()=>{
    const {record}=await run();const changed=structuredClone(record);changed.parameters.genes=['a'];
    await assert.rejects(replayHostGeneRecord(JSON.stringify(changed)),/identity|checksum/);
    (changed.fields.experiment.value as any).runs[0].scenario.objective=999;
    await assert.rejects(replayHostGeneRecord(await resign(changed)),/Fresh gene-knockout/);
  });
  it('rejects rehashed model association changes that no longer reproduce evidence', async()=>{
    const {record}=await run();(record.inputs[0].data as any).cobra.reactions[2].gene_reaction_rule='a';
    await assert.rejects(replayHostGeneRecord(await resign(record)),/Fresh gene-knockout/);
  });
  it('rejects method/reference/evidence changes even with valid integrity hashes', async()=>{
    for (const change of [(r:AnalysisRecord)=>{r.method.version='999';},(r:AnalysisRecord)=>{r.references[1].version='other';},(r:AnalysisRecord)=>{r.fields.experiment.limitations=['perfect biological certainty'];}]) {
      const {record}=await run();change(record);await assert.rejects(replayHostGeneRecord(await resign(record)));
    }
  });
  it('captures input and result before asynchronous hashing', async()=>{
    const input=geneFixture(),result=analyzeHostGeneKnockouts(input,settings(['a']));
    const record=createHostGeneRecord(input,result);(input.cobra as any).reactions[1].upper_bound=999;result.options.genes.push('c');
    const saved=await record;assert.deepEqual(saved.parameters.genes,analysisJson(['a']));
    await replayHostGeneRecord(serializeAnalysisRecord(saved));
  });
});

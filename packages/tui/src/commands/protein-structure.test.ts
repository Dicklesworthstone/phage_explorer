import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import snapshot from '../../../../data/protein-references/lambda-lamb-v1.json';
import { parseAnalysisRecord } from '../../../core/src/analysis-result';
import { executeProteinStructureJob, parseProteinStructureCommand } from './protein-structure';

const reference=JSON.stringify(snapshot);

describe('protein-structure command contracts',()=>{
  it('parses settings and prevents changing replayed evidence',()=>{
    assert.equal(parseProteinStructureCommand([]),null);
    assert.equal(parseProteinStructureCommand(['--help']),null);
    assert.deepEqual(parseProteinStructureCommand(['analyze','ref.json','--protein','lambda-j','--chain','none','--scope','chain','--cutoff','7.5','--separation','5','--format','contacts','--output','-']),
      {operation:'analyze',input:'ref.json',output:undefined,format:'contacts',
        options:{proteinId:'lambda-j',chainLabelAsymId:null,contactScope:'chain',contactCutoffAngstrom:7.5,minSequenceSeparation:5}});
    assert.throws(()=>parseProteinStructureCommand(['replay','saved.json','--cutoff','10']));
    assert.throws(()=>parseProteinStructureCommand(['inspect','ref.json','--format','contacts']));
  });

  it('inspects the exact versioned source bundle without computing geometry',async()=>{
    const result=await executeProteinStructureJob({operation:'inspect',input:{name:'lambda.json',text:reference}});
    const parsed=JSON.parse(result.content);
    assert.equal(parsed.bundleSha256,snapshot.bundleSha256);
    assert.equal(parsed.proteins[0].accession,'P03749');
    assert.equal(result.identity,null);
    assert.equal(result.residues,null);
  });

  it('computes observed mapped geometry and verified replay with stable identity',async()=>{
    const first=await executeProteinStructureJob({operation:'analyze',input:{name:'lambda.json',text:reference},
      options:{contactScope:'assembly',contactCutoffAngstrom:8,minSequenceSeparation:3}});
    const record=await parseAnalysisRecord(first.content);
    assert.equal(record.method.id,'mapped-protein-reference-evidence');
    assert.equal(record.inputs[0].source,'external');
    const structure=record.fields.structure.value as any;
    assert.equal(structure.protein.accession,'P03749');
    assert.ok(structure.coverage.coordinateResidues>0);
    assert.ok(first.residues!.includes('protein_position_1based'));
    assert.ok(first.contacts!.includes('distance_angstrom'));
    const replay=await executeProteinStructureJob({operation:'replay',input:{name:'saved.json',text:first.content}});
    assert.equal(replay.verified,true);
    assert.equal(replay.identity,record.resultId);
    assert.equal((await parseAnalysisRecord(replay.content)).resultId,record.resultId);
  });

  it('supports alignment-only analysis without inventing unavailable coordinates',async()=>{
    const first=await executeProteinStructureJob({operation:'analyze',input:{name:'lambda.json',text:reference},
      options:{chainLabelAsymId:null}});
    const record=await parseAnalysisRecord(first.content);
    const structure=record.fields.structure.value as any;
    assert.equal(structure.chain,null);
    assert.equal(structure.coverage.coordinateResidues,0);
    assert.equal(structure.residues.every((row:any)=>row.coordinate===null),true);
  });
});

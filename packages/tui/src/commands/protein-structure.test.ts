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


describe('native standalone mmCIF prepare/analyze/replay',()=>{
  const cif='data_literal\nloop_\n'+['group_PDB','type_symbol','label_atom_id','label_alt_id','label_comp_id','label_asym_id',
    'label_seq_id','auth_asym_id','auth_seq_id','pdbx_PDB_ins_code','Cartn_x','Cartn_y','Cartn_z','occupancy','pdbx_PDB_model_num']
    .map(name=>'_atom_site.'+name).join('\n')+'\nATOM C CA . ALA A 1 Z -2 ? 0 0 0 1 1\nATOM C CA . ASP A 3 Z 10 A 3 4 0 1 1\n#\n';
  it('requires explicit chain/polymer placement and refuses preparation overrides during replay',()=>{
    const command=parseProteinStructureCommand(['prepare','private.cif','--sequence','protein.faa','--chain','A','--protein-start','3','--source','Lab coordinates'])!;
    assert.deepEqual(command.preparation,{sequence:'protein.faa',labelAsymId:'A',proteinStart:3,model:1,alternateLocation:null,
      source:{kind:'local',description:'Lab coordinates',reference:null}});
    assert.throws(()=>parseProteinStructureCommand(['prepare','private.cif','--sequence','protein.faa','--chain','A']),/protein-start/);
    assert.throws(()=>parseProteinStructureCommand(['prepare','-','--sequence','-','--chain','A','--protein-start','1']),/stdin/);
    assert.throws(()=>parseProteinStructureCommand(['replay','saved.json','--model','2']),/only to prepare/);
  });

  it('prepares ordinary input, computes literal geometry and verifies a fresh native replay',async()=>{
    const prepared=await executeProteinStructureJob({operation:'prepare',input:{name:'private.cif',text:cif},
      preparation:{proteinFasta:'>target\nMKACDEFGH\n',labelAsymId:'A',proteinStart:3,model:1,alternateLocation:null,
        source:{kind:'local',description:'Independent 3-4-5 coordinate control',reference:null}}});
    assert.equal(JSON.parse(prepared.content).format,'phage-explorer-protein-coordinates');
    assert.equal(prepared.identity,null);
    const inspected=await executeProteinStructureJob({operation:'inspect',input:{name:'input.json',text:prepared.content}});
    assert.equal(inspected.content,prepared.content);
    const result=await executeProteinStructureJob({operation:'analyze',input:{name:'input.json',text:prepared.content},
      options:{contactCutoffAngstrom:5,minSequenceSeparation:1}});
    const record=await parseAnalysisRecord(result.content),geometry=record.fields.geometry.value as any;
    assert.equal(record.method.id,'supplied-mmcif-protein-geometry');
    assert.deepEqual(geometry.contacts.map((row:any)=>[row.query.proteinPosition,row.partner.proteinPosition,row.distanceAngstrom]),[[3,5,5]]);
    assert.equal(geometry.coverage.unmappedResidues,7);
    assert.ok(result.contacts!.includes('target\tA\tZ\t3\t1\t-2'));
    const replay=await executeProteinStructureJob({operation:'replay',input:{name:'saved.json',text:result.content}});
    assert.equal(replay.verified,true);
    assert.equal(replay.content,result.content);
    assert.equal(replay.contacts,result.contacts);
    await assert.rejects(executeProteinStructureJob({operation:'analyze',input:{name:'input.json',text:prepared.content},options:{contactScope:'assembly'}}),/assembly/);
  });
});

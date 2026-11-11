import{describe,it}from'bun:test';
import assert from'node:assert/strict';
import snapshot from '../../../../data/protein-references/lambda-lamb-v1.json';
import{Readable,Writable}from'node:stream';
import{parseAnalysisRecord}from'../../../core/src/analysis-result';
import{runProteinInteractionCommand,parseProteinInteractionCommand}from'./protein-interaction';
function capture(){let value='';const stream=new Writable({write(chunk,_encoding,done){value+=chunk.toString();done();}});return{stream,value:()=>value};}
function io(input=''){const out=capture(),err=capture();return{stdin:Readable.from([Buffer.from(input)]),stdout:out.stream,stderr:err.stream,output:out.value,errors:err.value};}
describe('deposited protein-interaction command',()=>{
  it('parses explicit operations and keeps inspect non-tabular',()=>{
    assert.equal(parseProteinInteractionCommand([]),null);
    assert.deepEqual(parseProteinInteractionCommand(['analyze','-','--format','tsv','--output','-']),
      {operation:'analyze',input:'-',format:'tsv',output:undefined});
    assert.throws(()=>parseProteinInteractionCommand(['inspect','x.json','--format','tsv']));
  });
  it('creates and replay-verifies portable observation evidence',async()=>{
    const first=io(JSON.stringify(snapshot));
    assert.equal(await runProteinInteractionCommand(['analyze','-'],first),0);
    const record=await parseAnalysisRecord(first.output());
    assert.equal(record.method.id,'deposited-host-interaction-evidence');
    assert.equal(record.fields.bindingAffinity.kind,'unavailable');
    const replay=io(first.output());
    assert.equal(await runProteinInteractionCommand(['replay','-'],replay),0);
    assert.equal((await parseAnalysisRecord(replay.output())).resultId,record.resultId);
  });
  it('exports only deposited assignments, never illustrative docking quantities',async()=>{
    const streams=io(JSON.stringify(snapshot));
    assert.equal(await runProteinInteractionCommand(['analyze','-','--format','tsv'],streams),0);
    assert.match(streams.output(),/phage_domain\thost_domain/);
    assert.match(streams.output(),/No ΔG, Kd, buried surface area/);
    assert.ok(!streams.output().includes('estimatedDeltaG'));
  });
});

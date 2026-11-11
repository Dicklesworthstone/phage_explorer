import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAlignedPhylogenyExperiment } from '../packages/core/src/analysis/aligned-phylogeny';
import { rootAlignedPhylogenyExperiment } from '../packages/core/src/analysis/phylogeny-rooting';
import { ROOTED_TEMPORAL_METHOD, ROOTED_DATING_METHOD } from '../packages/core/src/analysis/phylogeny-temporal';
import { parseAnalysisRecord, serializeAnalysisRecord } from '../packages/core/src/analysis-result';
import { executePhylogenyCommand, parsePhylogenyCommand } from './phylogeny';

const fasta=['A','B','C','D'].map((id,i)=>`>${id}\n${'A'.repeat(i*5)}${'G'.repeat(i+1)}${'A'.repeat(100-i*5-i-1)}\n`).join('');
const dates='sampleId,collectionDate,dateSource,permutationGroup\nD,2003.0,synthetic,two\nB,2001.0,synthetic,one\nA,2000.0,synthetic,one\nC,2002.0,synthetic,two\n';

async function rootedContent() {
  const original=await createAlignedPhylogenyExperiment({
    name:'Synthetic quartet',kind:'demo',reference:'Synthetic fixture',fasta,
  },{distance:'jc69',bootstrap:20,seed:42});
  const rooted=await rootAlignedPhylogenyExperiment(serializeAnalysisRecord(original.record),{
    outgroup:['A'],fractionFromOutgroup:.25,
    evidence:'Synthetic outgroup chosen independently of fixture dates.',dateIndependent:true,
  });
  return serializeAnalysisRecord(rooted.record);
}

describe('phylogeny temporal/date CLI',()=>{
  it('parses temporal provenance, diagnostics and explicit exclusions',()=>{
    const command=parsePhylogenyCommand(['temporal','--experiment','rooted.json','--dates','dates.csv',
      '--name','Cohort','--source','Synthetic dates','--license','CC0','--date-independent',
      '--permutations','24','--seed','42','--scheme','within-groups','--exclude',' A, C ','--output','temporal.json']);
    assert.deepEqual(command,{
      type:'temporal',experiment:'rooted.json',dates:'dates.csv',output:'temporal.json',
      metadata:{name:'Cohort',kind:'local',description:'Synthetic dates',reference:null,license:'CC0',dateIndependent:true},
      options:{permutations:24,seed:42,permutationScheme:'within-groups',excludedSamples:['A','C']},
    });
    assert.throws(()=>parsePhylogenyCommand(['temporal','--experiment','r','--dates','d','--name','n','--source','s','--license','l','--output','o']),/date-independent/);
  });

  it('creates a complete linked temporal record and replay verifies the same identity',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'phage-phylogeny-temporal-'));
    const rooted=join(dir,'rooted.json'), datePath=join(dir,'dates.csv'), temporal=join(dir,'temporal.json');
    await writeFile(rooted,await rootedContent()); await writeFile(datePath,dates);
    const summary=await executePhylogenyCommand({
      type:'temporal',experiment:rooted,dates:datePath,output:temporal,
      metadata:{name:'Synthetic dated quartet',kind:'demo',description:'Synthetic independent dates',reference:null,license:'CC0',dateIndependent:true},
      options:{permutations:24,seed:42,permutationScheme:'unrestricted',excludedSamples:[]},
    });
    assert.equal((summary.method as any).id,ROOTED_TEMPORAL_METHOD.id);
    const record=await parseAnalysisRecord(await readFile(temporal,'utf8'));
    assert.equal(record.method.id,ROOTED_TEMPORAL_METHOD.id);
    assert.equal(record.inputs.map(input=>input.id).join('|'),'datedTree|rootedPhylogeny|collectionMetadata');
    const verified=await executePhylogenyCommand({type:'replay',experiment:temporal});
    assert.equal(verified.verified,true); assert.equal(verified.resultId,record.resultId);
  });

  it('parses bounded fixed-rate dating settings without weakening source requirements',()=>{
    const command=parsePhylogenyCommand(['date','--experiment','temporal.json','--output','dated.json',
      '--rate-mode','fixed','--fixed-rate','0.001','--rate-source','Published calibration',
      '--minimum-rate','1e-6','--maximum-rate','0.1','--iterations','5000']);
    assert.deepEqual(command,{
      type:'date',experiment:'temporal.json',output:'dated.json',
      options:{rateMode:'fixed',fixedRate:.001,rateSource:'Published calibration',minimumRate:1e-6,maximumRate:.1,maxIterations:5000},
    });
    assert.throws(()=>parsePhylogenyCommand(['date','--experiment','t','--output','o','--rate-mode','fixed','--fixed-rate','0.001']),/explicit source|fixed rate/i);
  });

  it('recognizes dating records for replay and dated-Newick export only',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'phage-phylogeny-dating-'));
    const rooted=join(dir,'rooted.json'), datePath=join(dir,'dates.csv'), temporal=join(dir,'temporal.json'), dated=join(dir,'dated.json'), newick=join(dir,'dated.nwk');
    await writeFile(rooted,await rootedContent()); await writeFile(datePath,dates);
    await executePhylogenyCommand({type:'temporal',experiment:rooted,dates:datePath,output:temporal,
      metadata:{name:'Synthetic dated quartet',kind:'demo',description:'Synthetic independent dates',reference:null,license:'CC0',dateIndependent:true},
      options:{permutations:24,seed:42,permutationScheme:'unrestricted',excludedSamples:[]}});
    const dating=await executePhylogenyCommand({type:'date',experiment:temporal,output:dated,
      options:{rateMode:'fixed',fixedRate:1e-4,rateSource:'Synthetic fixture rate',minimumRate:1e-8,maximumRate:1,maxIterations:1000}});
    assert.equal((dating.method as any).id,ROOTED_DATING_METHOD.id);
    const record=await parseAnalysisRecord(await readFile(dated,'utf8'));
    assert.equal(record.method.id,ROOTED_DATING_METHOD.id);
    const replay=await executePhylogenyCommand({type:'replay',experiment:dated});
    assert.equal(replay.verified,true); assert.equal(replay.resultId,record.resultId);
    await executePhylogenyCommand({type:'export',experiment:dated,output:newick,format:'dated-newick'});
    assert.match(await readFile(newick,'utf8'),/;\n$/);
    await assert.rejects(executePhylogenyCommand({type:'export',experiment:temporal,output:join(dir,'bad.nwk'),format:'dated-newick'}),/requires a verified strict-clock/);
  });
});

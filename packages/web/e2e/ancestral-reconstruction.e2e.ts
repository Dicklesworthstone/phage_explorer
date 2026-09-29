import { test, expect, type Page } from '@playwright/test';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../../core/src/analysis-result';
import type { AncestralResult } from '../../core/src/analysis/ancestral-reconstruction';
import { expectExplorerIdentity, setupTestHarness } from './e2e-harness';

const length=.75*Math.log(3);
const tree=`('A_α':${length},'<img>literal</img>':${length})Root;`;
const fasta='>A_α\nAACN-GR\n><img>literal</img>\nACCNAAN';
async function open(page:Page){
  await page.keyboard.press('Control+Shift+y');
  const temporal=page.getByRole('region',{name:'Private dated-tree diagnostics',exact:true});
  await temporal.getByRole('button',{name:'Open ancestral nucleotide reconstruction',exact:true}).click();
  const panel=page.getByRole('region',{name:'Ancestral nucleotide reconstruction',exact:true});await expect(panel).toBeVisible();return panel;
}
async function download(page:Page,action:()=>Promise<void>):Promise<string>{
  const pending=page.waitForEvent('download');await action();const stream=await(await pending).createReadStream();if(!stream)throw new Error('No download');
  const chunks:Buffer[]=[];for await(const chunk of stream)chunks.push(chunk);return Buffer.concat(chunks).toString('utf8');
}

test('private homologous alignments reach actual workers, node and joint-edge probabilities, and verified reload',async({page},info)=>{
  test.setTimeout(180000);const {pageErrors,finalize}=setupTestHarness(page,info);const requests:string[]=[];
  page.on('request',request=>requests.push(`${request.url()} ${request.postData()??''}`));
  await page.addInitScript(()=>localStorage.setItem('phage-explorer-main-prefs',JSON.stringify({experienceLevel:'power'})));
  let release:(()=>void)|undefined;
  try{
    await page.goto('/?phage=lambda&model=0');await expectExplorerIdentity(page,info);
    const welcome=page.getByRole('dialog',{name:'Welcome to Phage Explorer'});if(await welcome.isVisible())await welcome.getByRole('button',{name:'Skip',exact:true}).click();
    let panel=await open(page);
    await expect(panel.getByTestId('ancestral-result')).toHaveCount(0);
    await panel.getByLabel('Ancestral rooted Newick',{exact:true}).fill(tree);
    await panel.getByLabel('Homologous DNA FASTA',{exact:true}).fill(fasta);
    for(const [label,value] of Object.entries({
      'Ancestral dataset name':'Private aligned cohort α','Ancestral source description':'private-no-upload-ancestral-29',
      'Ancestral source reference':'Independent synthetic same-base probability 3/4', 'Ancestral license or permission':'CC0 test fixture',
      'Ancestral tree method and version':'Hand-constructed fixed branch lengths','Ancestral rooting evidence':'Known synthetic root',
      'Homology alignment method and version':'Hand-constructed homologous columns','Homology alignment reference':'Synthetic aligned input, not clinical evidence',
    }))await panel.getByLabel(label,{exact:true}).fill(value);
    await panel.getByRole('checkbox',{name:'I supply homologous aligned DNA and branch lengths in substitutions/site, not a time-scaled tree or merely equal-length genomes.',exact:true}).check();
    await panel.getByRole('button',{name:'Load ancestral alignment and tree',exact:true}).click();
    await expect(panel.getByTestId('ancestral-status')).toContainText('Alignment and tree loaded');
    await expect(panel.getByTestId('ancestral-result')).toHaveCount(0);
    await panel.getByLabel('Consensus posterior threshold',{exact:true}).fill('0.7');
    await panel.getByRole('button',{name:'Run ancestral reconstruction',exact:true}).click();
    await expect(panel.getByTestId('ancestral-probability-A')).toHaveText('0.75000000');
    await expect(panel.getByTestId('ancestral-consensus')).toHaveText('ANCNNNN');
    await expect(panel.getByTestId('ancestral-coverage')).toContainText('6 analyzed columns; 1 gap/all-missing exclusions; 0 zero-likelihood columns');
    await expect(panel.getByRole('group',{name:'Supplied tree and selectable ancestral nodes',exact:true})).toBeVisible();
    await expect(panel.locator('img')).toHaveCount(0);
    await expect(panel.getByLabel('Inspect ancestral node',{exact:true})).toContainText('<img>literal</img>');
    await panel.getByLabel('Inspect ancestral node',{exact:true}).selectOption('1');
    await expect(panel.getByTestId('ancestral-probability-A')).toHaveText('1.0000000');
    await expect(panel.getByTestId('ancestral-edge-difference')).toContainText('0.25000000');
    await expect(panel.getByRole('table',{name:'Joint incoming branch endpoint probabilities',exact:true})).toBeVisible();
    await panel.getByLabel('Inspect ancestral node',{exact:true}).selectOption('0');
    const exportEvidence=()=>download(page,()=>panel.getByRole('button',{name:'Export ancestral evidence',exact:true}).click());
    const saved=await exportEvidence(),record=await parseAnalysisRecord(saved),result=record.fields.reconstruction.value as unknown as AncestralResult;
    expect(record.method.id).toBe('ancestral-jc69');expect(record.inputs[0].source).toBe('local');
    expect(result.patterns[0].nodes![0][0]).toBeCloseTo(.75,12);
    expect(result.sites[3].exclusion).toBe('all-missing');expect(result.sites[4].missingTips).toBe(1);
    const consensus=await download(page,()=>panel.getByRole('button',{name:'Export conditional ancestral FASTA',exact:true}).click());
    expect(consensus).toContain('>n0 conditional-JC69 columns=1-7 threshold=0.7\nANCNNNN');
    await panel.getByLabel('Consensus posterior threshold',{exact:true}).fill('0.99');
    await expect(panel.getByTestId('ancestral-consensus')).toHaveText('ANCNNNN');
    expect((await parseAnalysisRecord(await exportEvidence())).resultId).toBe(record.resultId);
    await panel.getByRole('button',{name:'Run ancestral reconstruction',exact:true}).click();
    await expect(panel.getByTestId('ancestral-consensus')).toHaveText('NNNNNNN');
    await panel.getByLabel('Consensus posterior threshold',{exact:true}).fill('0.7');
    await panel.getByLabel('First alignment column',{exact:true}).fill('2');await panel.getByLabel('Last alignment column',{exact:true}).fill('6');
    await panel.getByLabel('Alignment gap policy',{exact:true}).selectOption('exclude-column');
    await panel.getByRole('button',{name:'Run ancestral reconstruction',exact:true}).click();
    await expect(panel.getByTestId('ancestral-consensus')).toHaveText('NCNNN');
    await expect(panel.getByTestId('ancestral-coverage')).toContainText('3 analyzed columns; 2 gap/all-missing exclusions');
    await page.reload();await expectExplorerIdentity(page,info);panel=await open(page);
    const load=(content:string)=>panel.getByLabel('Import ancestral dataset or saved evidence JSON',{exact:true}).setInputFiles({name:'private-ancestral.json',mimeType:'application/json',buffer:Buffer.from(content)});
    await load(saved);await expect(panel.getByTestId('ancestral-status')).toContainText('Verified ancestral replay');
    await expect(panel.getByTestId('ancestral-result')).toHaveAttribute('data-result-id',record.resultId);
    expect((await parseAnalysisRecord(await exportEvidence())).resultId).toBe(record.resultId);
    const forged=await parseAnalysisRecord(saved);(forged.fields.reconstruction.value as unknown as AncestralResult).patterns[0].nodes![0]=[.5,1/6,1/6,1/6];
    const resigned=await createAnalysisRecord({...forged,inputs:forged.inputs.map(({sha256:_sha,...input})=>input)});
    await load(serializeAnalysisRecord(resigned));await expect(panel.getByRole('alert')).toContainText('Fresh ancestral evidence differs');
    await expect(panel.getByTestId('ancestral-result')).toHaveAttribute('data-result-id',record.resultId);
    let requested=false;const gate=new Promise<void>(resolve=>{release=resolve;});
    await page.route(/ancestral\.worker[^/]*\.(?:js|ts)/,async route=>{requested=true;await gate;await route.continue().catch(()=>{});});
    await load(saved);await expect.poll(()=>requested).toBe(true);
    await panel.getByRole('button',{name:'Cancel ancestral work',exact:true}).click();release();
    await expect(panel.getByTestId('ancestral-status')).toContainText('Ancestral work cancelled');
    await expect(panel.getByTestId('ancestral-result')).toHaveAttribute('data-result-id',record.resultId);
    await page.unroute(/ancestral\.worker[^/]*\.(?:js|ts)/);
    // Closing the actual panel cancels its lifecycle; reopening does not pretend a saved session exists.
    await page.getByRole('button',{name:'Close ancestral reconstruction (export first)',exact:true}).click();
    await expect(panel).toHaveCount(0);
    expect(requests.some(request=>request.includes('private-no-upload-ancestral-29'))).toBe(false);
    expect(pageErrors).toEqual([]);
  }finally{release?.();await finalize();}
});

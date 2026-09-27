import {test,expect,type Page} from '@playwright/test';
import {createAnalysisRecord,parseAnalysisRecord,serializeAnalysisRecord} from '../../core/src/analysis-result';
import {expectExplorerIdentity,setupTestHarness} from './e2e-harness';

// Hand-derived root paths [.02,.03,.04,.05] at dates [2000,2001,2002,2003].
// OLS slope=.01, x-intercept=1998; one of 24 permutations is as positively correlated.
const TREE="(('A_α':.01,B:.02):.01,(C:.03,'<b>literal</b>':.04):.01);";
const SAMPLES='sampleId,collectionDate,dateSource,permutationGroup\n<b>literal</b>,2003.0,field log,two\nB,2001.0,field log,one\nA_α,2000.0,field log,one\nC,2002.0,field log,two';
async function openPanel(page:Page){await page.keyboard.press('Control+Shift+y');const panel=page.getByRole('region',{name:'Private dated-tree diagnostics',exact:true});await expect(panel).toBeVisible();return panel;}
async function download(page:Page,action:()=>Promise<void>):Promise<string>{const pending=page.waitForEvent('download');await action();const stream=await (await pending).createReadStream();if(!stream)throw new Error('No download');const chunks:Buffer[]=[];for await(const chunk of stream)chunks.push(chunk);return Buffer.concat(chunks).toString('utf8');}

test('private dated phylograms reach real workers, exact diagnostics and verified reload without upload',async({page},info)=>{
  test.setTimeout(180000);const {pageErrors,finalize}=setupTestHarness(page,info);
  const requests:string[]=[];page.on('request',request=>requests.push(`${request.url()} ${request.postData()??''}`));
  await page.addInitScript(()=>localStorage.setItem('phage-explorer-main-prefs',JSON.stringify({experienceLevel:'power'})));
  let release:(()=>void)|undefined;
  try{
    await page.goto('/?phage=lambda&model=0');await expectExplorerIdentity(page,info);
    const welcome=page.getByRole('dialog',{name:'Welcome to Phage Explorer'});if(await welcome.isVisible())await welcome.getByRole('button',{name:'Skip',exact:true}).click();
    let panel=await openPanel(page);
    await expect(panel).toContainText('No temporal data loaded');
    await expect(panel.getByTestId('temporal-result')).toHaveCount(0);
    await panel.getByLabel('Rooted Newick phylogram',{exact:true}).fill(TREE);
    await panel.getByLabel('Collection-date CSV or TSV',{exact:true}).fill(SAMPLES);
    for(const [label,value] of Object.entries({
      'Dated cohort name':'Private dated cohort α','Data source description':'User-supplied synthetic regression oracle',
      'Source license or usage permission':'CC0 test fixture','Tree estimation method and version':'Hand-constructed branch-length fixture',
      'Rooting method and evidence':'Fixed root selected without collection dates','Alignment or tree-input provenance':'Analytical paths; no biological homology claim',
    }))await panel.getByLabel(label,{exact:true}).fill(value);
    await panel.getByRole('checkbox',{name:'I confirm the tree uses substitutions/site and neither its inference nor rooting used these collection dates.',exact:true}).check();
    await panel.getByRole('button',{name:'Load and validate dated tree',exact:true}).click();
    await expect(panel.getByTestId('temporal-status')).toContainText('Dataset loaded');
    await expect(panel.getByTestId('temporal-result')).toHaveCount(0);
    await panel.getByLabel('Temporal randomization seed',{exact:true}).fill('0');
    await panel.getByRole('button',{name:'Run temporal diagnostics',exact:true}).click();
    await expect(panel.getByTestId('temporal-regression')).toContainText('0.010000000');
    await expect(panel.getByTestId('temporal-regression')).toContainText('1998.0000');
    await expect(panel.getByTestId('temporal-randomization')).toContainText('1/24');
    await expect(panel.getByRole('img',{name:'Collection date versus fixed-root genetic distance',exact:true})).toBeVisible();
    await expect(panel.getByRole('table',{name:'Dated tips, exclusions and regression residuals',exact:true}).locator('tbody tr')).toHaveCount(4);
    await expect(panel.getByRole('cell').filter({hasText:'<b>literal</b>'})).toHaveText('<b>literal</b>No accession');
    expect(await panel.locator('b').filter({hasText:'literal'}).count()).toBe(0);
    const exportResult=()=>download(page,()=>panel.getByRole('button',{name:'Export temporal diagnostics',exact:true}).click());
    const content=await exportResult(),record=await parseAnalysisRecord(content);
    const fitted=record.fields.regression.value as {slope:number;r2:number;xIntercept:number};
    expect(fitted.slope).toBeCloseTo(.01,12);expect(fitted.r2).toBeCloseTo(1,12);expect(fitted.xIntercept).toBeCloseTo(1998,8);
    expect(record.inputs[0].source).toBe('local');expect(record.fields.regression.kind).toBe('fitted-estimate');
    expect((record.fields.randomization.value as {tailFraction:number}).tailFraction).toBe(1/24);
    await panel.getByLabel('Temporal randomization seed',{exact:true}).fill('77');
    expect((await parseAnalysisRecord(await exportResult())).resultId).toBe(record.resultId);
    await panel.getByLabel('Date randomization scheme',{exact:true}).selectOption('within-groups');
    await panel.getByRole('button',{name:'Run temporal diagnostics',exact:true}).click();
    await expect(panel.getByTestId('temporal-randomization')).toContainText('1/4');
    const groupedContent=await exportResult(),grouped=await parseAnalysisRecord(groupedContent);
    expect(grouped.resultId).not.toBe(record.resultId);
    await page.reload();await expectExplorerIdentity(page,info);panel=await openPanel(page);
    const load=(text:string)=>panel.getByLabel('Import dated-tree dataset or saved diagnostics JSON',{exact:true}).setInputFiles({name:'private-temporal.json',mimeType:'application/json',buffer:Buffer.from(text)});
    await load(groupedContent);await expect(panel.getByTestId('temporal-status')).toContainText('Verified temporal replay');
    await expect(panel.getByTestId('temporal-result')).toHaveAttribute('data-result-id',grouped.resultId);
    expect((await parseAnalysisRecord(await exportResult())).resultId).toBe(grouped.resultId);
    const forged=await parseAnalysisRecord(groupedContent);(forged.fields.regression.value as Record<string,unknown>).slope=100;
    const resigned=await createAnalysisRecord({...forged,inputs:forged.inputs.map(({sha256:_sha,...input})=>input)});
    await load(serializeAnalysisRecord(resigned));await expect(panel.getByRole('alert')).toContainText('Fresh temporal diagnostic differs');
    await expect(panel.getByTestId('temporal-result')).toHaveAttribute('data-result-id',grouped.resultId);
    let requested=false;const gate=new Promise<void>(resolve=>{release=resolve;});
    await page.route(/temporal-signal\.worker[^/]*\.(?:js|ts)/,async route=>{requested=true;await gate;await route.continue().catch(()=>{});});
    await load(groupedContent);await expect.poll(()=>requested).toBe(true);
    await panel.getByRole('button',{name:'Cancel temporal work',exact:true}).click();release?.();
    await expect(panel.getByTestId('temporal-status')).toContainText('Temporal work cancelled');
    await expect(panel.getByTestId('temporal-result')).toHaveAttribute('data-result-id',grouped.resultId);
    await page.unroute(/temporal-signal\.worker[^/]*\.(?:js|ts)/);
    const uncertain=structuredClone(record.inputs[0].data) as {samples:Array<{id:string;collectionDate:unknown}>};
    uncertain.samples.find(sample=>sample.id==='A_α')!.collectionDate='2000';
    await load(JSON.stringify(uncertain));await expect(panel.getByTestId('temporal-status')).toContainText('Dataset loaded');
    await expect(panel.getByTestId('temporal-result')).toHaveCount(0);
    await panel.getByRole('button',{name:'Run temporal diagnostics',exact:true}).click();
    await expect(panel.getByTestId('temporal-unavailable')).toContainText('At least four');
    await expect(panel).toContainText('Uncertain collection date; not replaced by a midpoint');
    expect(requests.some(value=>value.includes('Private dated cohort')||value.includes('field log')||value.includes('A_α'))).toBe(false);
    expect(pageErrors).toEqual([]);
  }finally{release?.();await finalize();}
});

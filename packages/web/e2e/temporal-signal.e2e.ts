import {test,expect,type Page} from '@playwright/test';
import {createAnalysisRecord,parseAnalysisRecord,serializeAnalysisRecord} from '../../core/src/analysis-result';
import {parseTemporalNewick,temporalTreeTips,type TemporalDataset} from '../../core/src/analysis/temporal-signal';
import type {DatedTreeResult} from '../../core/src/analysis/strict-clock';
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

test('strict-clock branches, interval dates and verified exports use the actual dated-tree workspace',async({page},info)=>{
  test.setTimeout(180000);const {pageErrors,finalize}=setupTestHarness(page,info);
  const requests:string[]=[];page.on('request',request=>requests.push(`${request.url()} ${request.postData()??''}`));
  await page.addInitScript(()=>localStorage.setItem('phage-explorer-main-prefs',JSON.stringify({experienceLevel:'power'})));
  // Independent chronology: rate .01; root1990, X1998, Y2001;
  // tips2000/2002/2004/2006. Each branch is .01 * its elapsed years.
  const dataset:TemporalDataset={format:'phage-explorer-temporal-signal',version:1,name:'Private conditional dating oracle',
    source:{kind:'local',description:'Hand-derived synthetic chronology; not empirical sequences',reference:null,license:'CC0'},
    tree:{newick:"(('A_α':.02,B:.04)X:.08,(C:.03,'<b>literal</b>':.05)Y:.11)R;",units:'substitutions/site',inferredWithoutDates:true,
      method:'Analytical branch-length construction',rooting:'Fixed synthetic root',alignmentProvenance:'Synthetic oracle, not a measured alignment'},
    samples:['A_α','B','C','<b>literal</b>'].map((id,i)=>({id,accession:null,collectionDate:2000+2*i,dateSource:'Synthetic exact decimal year',permutationGroup:null}))};
  let release:(()=>void)|undefined;
  try {
    await page.goto('/?phage=lambda&model=0');await expectExplorerIdentity(page,info);
    const welcome=page.getByRole('dialog',{name:'Welcome to Phage Explorer'});if(await welcome.isVisible())await welcome.getByRole('button',{name:'Skip',exact:true}).click();
    let panel=await openPanel(page);
    const load=(content:string)=>panel.getByLabel('Import dated-tree dataset or saved diagnostics JSON',{exact:true})
      .setInputFiles({name:'private-dating.json',mimeType:'application/json',buffer:Buffer.from(content)});
    const dating=()=>panel.getByRole('region',{name:'Conditional strict-clock dating',exact:true});
    const result=()=>dating().getByTestId('strict-clock-result');
    const fit=async()=>{
      await dating().getByRole('checkbox',{name:'I accept the fixed-root strict-clock assumptions; numerical convergence is not clock validation.',exact:true}).check();
      await dating().getByRole('button',{name:'Fit strict-clock tree',exact:true}).click();
    };
    const exportFit=()=>download(page,()=>dating().getByRole('button',{name:'Export strict-clock fit',exact:true}).click());
    await load(JSON.stringify(dataset));await expect(panel.getByTestId('temporal-status')).toContainText('Dataset loaded');
    await expect(result()).toHaveCount(0);
    await panel.getByRole('button',{name:'Run temporal diagnostics',exact:true}).click();
    await expect(panel.getByTestId('temporal-result')).toBeVisible();
    const diagnosticId=await panel.getByTestId('temporal-result').getAttribute('data-result-id');
    await fit();await expect(dating().getByTestId('strict-clock-summary')).toContainText('Conditional root date: 1990.000000');
    await expect(dating().getByTestId('strict-clock-summary')).toContainText('Estimated rate: 0.010000000');
    await expect(panel.getByTestId('temporal-result')).toHaveAttribute('data-result-id',diagnosticId!);
    await expect(dating().getByRole('img',{name:'Conditional strict-clock tree in calendar years',exact:true})).toBeVisible();
    const content=await exportFit(),record=await parseAnalysisRecord(content),dates=record.fields.dating.value as unknown as DatedTreeResult;
    expect(dates.status).toBe('fitted');expect(dates.certificate.converged).toBe(true);expect(dates.clockValidated).toBe(false);
    expect(dates.uncertainty).toBe('not-estimated');expect(dates.rate).toBeCloseTo(.01,12);
    expect(Object.fromEntries(dates.nodes.map(node=>[node.label,node.date]))).toEqual({R:1990,X:1998,A_α:2000,B:2002,Y:2001,C:2004,'<b>literal</b>':2006});
    expect(record.fields.dating.kind).toBe('fitted-estimate');
    await dating().getByText('Node dates, input bounds and original versus fitted branches',{exact:true}).click();
    await expect(dating().getByRole('table',{name:'Strict-clock dates and branch residuals',exact:true}).locator('tbody tr')).toHaveCount(7);
    expect(await dating().locator('b').filter({hasText:'literal'}).count()).toBe(0);
    const newick=await download(page,()=>dating().getByRole('button',{name:'Export dated Newick (years)',exact:true}).click());
    expect(newick).toContain('branch_units=years');expect(newick).toContain('clock_validated=false');
    expect(temporalTreeTips(parseTemporalNewick(newick)).map(tip=>tip.distance)).toEqual([10,12,14,16]);
    await dating().getByLabel('Minimum dating rate',{exact:true}).fill('.02');
    expect((await parseAnalysisRecord(await exportFit())).resultId).toBe(record.resultId);

    const interval=structuredClone(dataset);interval.samples[1].collectionDate={lower:2001,upper:2005};
    await load(JSON.stringify(interval));await expect(panel.getByTestId('temporal-status')).toContainText('Dataset loaded');
    await expect(result()).toHaveCount(0);await expect(panel.getByTestId('temporal-result')).toHaveCount(0);
    await fit();await expect(result()).toBeVisible();
    const intervalText=await exportFit(),intervalRecord=await parseAnalysisRecord(intervalText);
    const intervalResult=intervalRecord.fields.dating.value as unknown as DatedTreeResult;
    expect(intervalResult.intervalTips).toBe(1);expect(intervalResult.nodes.find(node=>node.label==='B')!.date).toBeCloseTo(2002,6);
    expect(intervalResult.nodes.find(node=>node.label==='B')!.dateRange).toEqual({lower:2001,upper:2005});
    await page.reload();await expectExplorerIdentity(page,info);panel=await openPanel(page);
    await load(intervalText);await expect(panel.getByTestId('temporal-status')).toContainText('Verified strict-clock replay');
    await expect(result()).toHaveAttribute('data-result-id',intervalRecord.resultId);
    expect((await parseAnalysisRecord(await exportFit())).resultId).toBe(intervalRecord.resultId);
    const forged=structuredClone(intervalRecord);(forged.fields.dating.value as unknown as DatedTreeResult).rootDate=1234;
    const signed=await createAnalysisRecord({...forged,inputs:forged.inputs.map(({sha256:_sha,...input})=>input)});
    await load(serializeAnalysisRecord(signed));await expect(panel.getByRole('alert')).toContainText('Fresh strict-clock dating differs');
    await expect(result()).toHaveAttribute('data-result-id',intervalRecord.resultId);

    let requested=false;const gate=new Promise<void>(resolve=>{release=resolve;});
    await page.route(/temporal-signal\.worker[^/]*\.(?:js|ts)/,async route=>{requested=true;await gate;await route.continue().catch(()=>{});});
    await load(intervalText);await expect.poll(()=>requested).toBe(true);
    await panel.getByRole('button',{name:'Cancel temporal work',exact:true}).click();release?.();
    await expect(panel.getByTestId('temporal-status')).toContainText('Temporal work cancelled');
    await expect(result()).toHaveAttribute('data-result-id',intervalRecord.resultId);
    await page.unroute(/temporal-signal\.worker[^/]*\.(?:js|ts)/);
    await dating().getByLabel('Minimum dating rate',{exact:true}).fill('.02');await fit();
    await expect(dating().getByTestId('strict-clock-summary')).toContainText('Node dates unavailable');
    await expect(dating().getByRole('button',{name:'Export dated Newick (years)',exact:true})).toBeDisabled();
    await expect(dating().getByRole('img',{name:'Conditional strict-clock tree in calendar years',exact:true})).toHaveCount(0);
    const boundary=(await parseAnalysisRecord(await exportFit())).fields.dating.value as unknown as DatedTreeResult;
    expect(boundary.status).toBe('rate-boundary');expect(boundary.nodes).toEqual([]);expect(boundary.rootDate).toBe(null);

    const sameDate=structuredClone(dataset);sameDate.tree.newick="('A_α':.10,B:.12,C:.08,'<b>literal</b>':.10)R;";
    sameDate.samples.forEach(sample=>{sample.collectionDate=2000;});
    await load(JSON.stringify(sameDate));await expect(panel.getByTestId('temporal-status')).toContainText('Dataset loaded');
    await dating().getByLabel('Strict-clock rate mode',{exact:true}).selectOption('fixed');
    await dating().getByLabel('Fixed substitution rate (substitutions/site/year)',{exact:true}).fill('.01');
    await dating().getByLabel('Fixed rate source or explicit assumption',{exact:true}).fill('Synthetic external rate oracle, not measured');
    await fit();await expect(dating().getByTestId('strict-clock-summary')).toContainText('Supplied rate: 0.010000000');
    await expect(dating().getByTestId('strict-clock-summary')).toContainText('1990.000000');
    expect(requests.some(value=>value.includes('Private conditional dating oracle')||value.includes('Synthetic exact decimal year'))).toBe(false);
    expect(pageErrors).toEqual([]);
  } finally {release?.();await finalize();}
});

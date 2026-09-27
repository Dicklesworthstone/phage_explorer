import {test,expect,type Page} from '@playwright/test';
import {createAnalysisRecord,parseAnalysisRecord,serializeAnalysisRecord} from '../../core/src/analysis-result';
import type {SpacerLibrary,ReferenceSpacerHit} from '../../core/src/analysis/spacer-reference';
import {expectExplorerIdentity,setupTestHarness} from './e2e-harness';

// Hand-constructed exact targets: forward [4,24) followed by AGG, reverse
// [34,54) preceded by CCT (guide-oriented AGG). Unknown bases separate the targets.
const DNA='TTTTACGATTCGGTACCTAGTGCAAGGNNNNCCTTGCACTAGGTACCGAATCGTAAAA';
const FASTA=`>SPACER_PRIVATE_FIXTURE [topology=linear]\n${DNA}\n`;
const LIBRARY:SpacerLibrary={format:'phage-explorer-spacer-library',version:1,name:'Private synthetic reference α',
  source:{kind:'local',version:'test-1',reference:'User-supplied synthetic coordinate fixture',license:'CC0',scope:'Two artificial strains, no empirical immunity claim'},
  hosts:[{id:'one',name:'<b>literal host</b>',strain:'α strain',accession:'synthetic:one'},{id:'two',name:'Other host',strain:'no records',accession:'synthetic:two'}],
  spacers:[{id:'oriented',hostId:'one',arrayAccession:'synthetic:array',sequence:'ACGATTCGGTACCTAGTGCA',system:null,target:'DNA',orientation:'guide-equivalent',
    pam:{side:'3prime',motif:'NGG',reference:'Synthetic oriented test rule'},seed:{start:0,end:4,maxMismatches:0,reference:'Synthetic test interval'}},
    {id:'unsupported-rna',hostId:'one',arrayAccession:'synthetic:rna-array',sequence:'ACGATTCGGTACCTAGTGCA',system:'VI',target:'RNA',orientation:'guide-equivalent',pam:null,seed:null}]};
async function localGenome(page:Page){
  await page.keyboard.press('Control+k');const palette=page.getByTestId('overlay-commandPalette');await palette.getByRole('combobox').fill('Local genomes: import or export');
  await palette.getByRole('option').filter({hasText:'Local genomes: import or export'}).first().click();
  const panel=page.getByTestId('overlay-genomeImport');await panel.getByRole('textbox',{name:'Paste genome data',exact:true}).fill(FASTA);
  await panel.getByRole('button',{name:'Parse records',exact:true}).click();await panel.getByRole('button',{name:'Add records to explorer',exact:true}).click();
  await expect(page.getByTestId('phage-list-item-selected')).toContainText('SPACER_PRIVATE_FIXTURE');
}
async function open(page:Page){await page.keyboard.press('Alt+c');const panel=page.getByRole('region',{name:'Sourced CRISPR spacer comparison',exact:true});await expect(panel).toBeVisible();return panel;}
async function download(page:Page,action:()=>Promise<void>):Promise<string>{const pending=page.waitForEvent('download');await action();const stream=await(await pending).createReadStream();if(!stream)throw new Error('No download');const chunks:Buffer[]=[];for await(const chunk of stream)chunks.push(chunk);return Buffer.concat(chunks).toString('utf8');}

test('local host references reach strand-correct workers and verified evidence after reload',async({page},info)=>{
  test.setTimeout(180000);const {pageErrors,finalize}=setupTestHarness(page,info);const requests:string[]=[];
  page.on('request',request=>requests.push(`${request.url()} ${request.postData()??''}`));
  await page.addInitScript(()=>localStorage.setItem('phage-explorer-main-prefs',JSON.stringify({experienceLevel:'power'})));
  let release:(()=>void)|undefined;
  try{
    await page.goto('/?phage=lambda&model=0');await expectExplorerIdentity(page,info);
    const welcome=page.getByRole('dialog',{name:'Welcome to Phage Explorer'});if(await welcome.isVisible())await welcome.getByRole('button',{name:'Skip',exact:true}).click();
    await localGenome(page);let panel=await open(page);await expect(panel.getByTestId('spacer-result')).toHaveCount(0);
    const libraryInput=()=>panel.getByLabel('Import spacer reference library JSON',{exact:true});
    await libraryInput().setInputFiles({name:'private-spacers.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(LIBRARY))});
    await expect(panel.getByTestId('spacer-status')).toContainText('Spacer library loaded');await expect(panel.getByTestId('spacer-result')).toHaveCount(0);
    await expect(panel.getByLabel('Search genome topology',{exact:true})).toHaveValue('linear');
    await panel.getByRole('button',{name:'Run spacer comparison',exact:true}).click();
    await expect(panel.getByTestId('spacer-outcome')).toContainText('Sequence matches found');
    const table=()=>panel.getByRole('table',{name:'Sourced spacer matches',exact:true});await expect(table().locator('tbody tr')).toHaveCount(2);
    await expect(table().locator('tbody tr').nth(0)).toContainText('[4,24) +');await expect(table().locator('tbody tr').nth(1)).toContainText('[34,54) -');
    await expect(table().locator('tbody tr').nth(1)).toContainText('matched: AGG');
    await expect(panel.getByRole('img',{name:'Spacer match positions on the selected genome',exact:true})).toBeVisible();
    expect(await panel.locator('b').filter({hasText:'literal host'}).count()).toBe(0);
    const exported=()=>download(page,()=>panel.getByRole('button',{name:'Export spacer evidence',exact:true}).click());
    const content=await exported(),record=await parseAnalysisRecord(content),matches=record.fields.matches.value as unknown as ReferenceSpacerHit[];
    expect(matches.map(h=>[h.start,h.end,h.strand,h.pam.sequence,h.pam.status])).toEqual([[4,24,'+','AGG','matched'],[34,54,'-','AGG','matched']]);
    expect(record.fields.matches.kind).toBe('sequence-score');expect(record.fields.matches.coverage).toEqual({available:1,total:2,unit:'records'});
    expect(record.inputs[0].data).toMatchObject({sequence:DNA,topology:'linear',source:'local'});
    await panel.getByLabel('Maximum spacer substitutions',{exact:true}).fill('1');expect((await parseAnalysisRecord(await exported())).resultId).toBe(record.resultId);
    await panel.getByLabel('Reference host scope',{exact:true}).selectOption('two');await panel.getByRole('button',{name:'Run spacer comparison',exact:true}).click();
    await expect(panel.getByTestId('spacer-outcome')).toContainText('Nothing was searched');await expect(table().locator('tbody tr')).toHaveCount(0);
    const restore=(text:string)=>panel.getByLabel('Restore and verify spacer evidence JSON',{exact:true}).setInputFiles({name:'evidence.json',mimeType:'application/json',buffer:Buffer.from(text)});
    await restore(content);await expect(panel.getByTestId('spacer-status')).toContainText('Verified spacer replay');expect((await parseAnalysisRecord(await exported())).resultId).toBe(record.resultId);
    await page.reload();await expectExplorerIdentity(page,info);await localGenome(page);panel=await open(page);
    await restore(content);await expect(panel.getByTestId('spacer-result')).toHaveAttribute('data-result-id',record.resultId);
    await expect(panel.getByTestId('spacer-status')).toContainText('Verified spacer replay');
    const forged=await parseAnalysisRecord(content);(forged.fields.matches.value as unknown as ReferenceSpacerHit[])[0].start=123;
    const resigned=await createAnalysisRecord({...forged,inputs:forged.inputs.map(({sha256:_sha,...input})=>input)});
    await restore(serializeAnalysisRecord(resigned));await expect(panel.getByRole('alert')).toContainText('Fresh spacer evidence differs');
    await expect(panel.getByTestId('spacer-result')).toHaveAttribute('data-result-id',record.resultId);
    await libraryInput().setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{"format":"wrong"}')});
    await expect(panel.getByRole('alert')).toContainText('Unsupported spacer library');await expect(panel.getByTestId('spacer-result')).toHaveAttribute('data-result-id',record.resultId);
    let requested=false;const gate=new Promise<void>(resolve=>{release=resolve;});
    await page.route(/spacer-reference\.worker[^/]*\.(?:js|ts)/,async route=>{requested=true;await gate;await route.continue().catch(()=>{});});
    await restore(content);await expect.poll(()=>requested).toBe(true);await panel.getByRole('button',{name:'Cancel spacer work',exact:true}).click();release?.();
    await expect(panel.getByTestId('spacer-status')).toContainText('Spacer work cancelled');await expect(panel.getByTestId('spacer-result')).toHaveAttribute('data-result-id',record.resultId);
    await page.unroute(/spacer-reference\.worker[^/]*\.(?:js|ts)/);
    await panel.getByLabel('Search genome topology',{exact:true}).selectOption('circular');await restore(content);
    await expect(panel.getByRole('alert')).toContainText('topology differs');await expect(panel.getByTestId('spacer-result')).toHaveAttribute('data-result-id',record.resultId);
    expect(requests.some(value=>value.includes(DNA)||value.includes('private-spacers')||value.includes('literal host'))).toBe(false);expect(pageErrors).toEqual([]);
  }finally{release?.();await finalize();}
});

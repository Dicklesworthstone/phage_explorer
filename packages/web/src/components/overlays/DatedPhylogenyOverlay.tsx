import React, { lazy, Suspense, useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import type { PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { serializeAnalysisRecord } from '../../../../core/src/analysis-result';
import { validateTemporalDataset, type TemporalOptions, type TemporalResult } from '../../../../core/src/analysis/temporal-signal';
import { TemporalSignalSession, type TemporalRequest } from '../../workers/TemporalSignalSession';
import { downloadString } from '../../utils/export';
import { useTheme } from '../../hooks/useTheme';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisRecordDetails } from './primitives/OverlayProvenance';
import { StrictClockPanel } from './StrictClockPanel';

const AncestralReconstructionPanel = lazy(() => import('./AncestralReconstructionPanel').then(module => ({default:module.AncestralReconstructionPanel})));

const CatalogPhylodynamics = lazy(() => import('./PhylodynamicsOverlay').then(module => ({default:module.PhylodynamicsOverlay})));

/** Retain the NCBI/Mash tree workflow, but require an explicit transition into external search. */
export function DatedPhylogenyOverlay(props: {repository:PhageRepository|null;currentPhage:PhageFull|null}): React.ReactElement|null {
  const {isOpen}=useOverlay();const [catalog,setCatalog]=useState(false);
  if(!isOpen('phylodynamics'))return null;
  if(catalog&&props.currentPhage&&!props.currentPhage.localGenome)return <Suspense fallback={<Overlay id="phylodynamics" title="Loading catalog phylogeny"><p>Loading the existing NCBI sequence workflow…</p></Overlay>}>
    <CatalogPhylodynamics {...props}/>
  </Suspense>;
  return <TemporalSignalPanel localGenome={!!props.currentPhage?.localGenome} canSearch={!!props.currentPhage&&!props.currentPhage.localGenome} onCatalog={()=>setCatalog(true)}/>;
}
function TemporalPlot({result}:{result:TemporalResult}):React.ReactElement|null {
  const {theme}=useTheme();const fit=result.regression;if(!fit)return null;
  const rows=fit.residuals,minX=Math.min(...rows.map(row=>row.date)),maxX=Math.max(...rows.map(row=>row.date));
  const low=Math.min(0,...rows.map(row=>Math.min(row.distance,row.predicted))),high=Math.max(...rows.map(row=>Math.max(row.distance,row.predicted)));
  const span=Math.max(1e-12,high-low),x=(value:number)=>60+560*(value-minX)/(maxX-minX),y=(value:number)=>235-195*(value-low)/span;
  const predict=(date:number)=>fit.meanDistance+fit.slope*(date-fit.meanDate);
  return <figure style={{margin:0}}><svg viewBox="0 0 660 285" role="img" aria-label="Collection date versus fixed-root genetic distance" style={{width:'100%',maxHeight:340}}>
    <path d="M60 30V235H630" stroke={theme.colors.textDim} fill="none"/>
    <path d={`M${x(minX)} ${y(predict(minX))}L${x(maxX)} ${y(predict(maxX))}`} stroke={theme.colors.warning} strokeWidth={2} fill="none"/>
    {rows.map(row=><g key={row.id}><path d={`M${x(row.date)} ${y(row.distance)}V${y(row.predicted)}`} stroke={theme.colors.textDim} strokeDasharray="3 3"/>
      <circle cx={x(row.date)} cy={y(row.distance)} r={4} fill={theme.colors.primary}><title>{`${row.id}: collection ${row.date}, distance ${row.distance}, residual ${row.residual}`}</title></circle></g>)}
    <text x={60} y={258} fill={theme.colors.text} fontSize={12}>{minX.toFixed(3)}</text><text x={550} y={258} fill={theme.colors.text} fontSize={12}>{maxX.toFixed(3)}</text>
    <text x={2} y={40} fill={theme.colors.text} fontSize={11}>{high.toPrecision(4)}</text><text x={190} y={278} fill={theme.colors.text} fontSize={12}>Collection year · distances in substitutions/site</text>
  </svg><figcaption>Points are supplied phylogram path sums. The fitted line is exploratory; it does not date the tree or establish a molecular clock.</figcaption></figure>;
}
const readInput=(file:File|null,fallback:string):Promise<string>=>{
  if(file&&file.size>2*1024*1024)return Promise.reject(new Error('Tree and sample files are limited to 2 MiB each.'));
  return file?file.text():Promise.resolve(fallback);
};
function TemporalSignalPanel({localGenome,canSearch,onCatalog}:{localGenome:boolean;canSearch:boolean;onCatalog:()=>void}):React.ReactElement {
  const id=useId();const {theme}=useTheme();
  const session=useMemo(()=>new TemporalSignalSession(()=>new Worker(new URL('../../workers/temporal-signal.worker.ts',import.meta.url),{type:'module'})),[]);
  const {accepted,busy,phase,error,notice}=useSyncExternalStore(session.subscribe,session.getSnapshot,session.getSnapshot);
  const [newick,setNewick]=useState(''),[sampleTable,setSampleTable]=useState('');
  const [treeFile,setTreeFile]=useState<File|null>(null),[sampleFile,setSampleFile]=useState<File|null>(null);
  const [name,setName]=useState(''),[description,setDescription]=useState(''),[reference,setReference]=useState(''),[license,setLicense]=useState('');
  const [method,setMethod]=useState(''),[rooting,setRooting]=useState(''),[alignment,setAlignment]=useState(''),[confirmed,setConfirmed]=useState(false);
  const [permutations,setPermutations]=useState('999'),[seed,setSeed]=useState('42');
  const [scheme,setScheme]=useState<TemporalOptions['permutationScheme']>('unrestricted'),[excluded,setExcluded]=useState<string[]>([]);
  const [ancestralOpen,setAncestralOpen]=useState(false);
  const [exportError,setExportError]=useState<string|null>(null),[page,setPage]=useState(0);
  useEffect(()=>{session.activate();return session.deactivate;},[session]);
  useEffect(()=>{
    if(accepted){setPermutations(String(accepted.options.permutations));setSeed(String(accepted.options.seed));setScheme(accepted.options.permutationScheme);setExcluded(accepted.options.excludedSamples);}
    setExportError(null);setPage(0);
  },[accepted]);
  const result=accepted?.result,fit=result?.regression;
  const labelStyle:React.CSSProperties={display:'flex',flexDirection:'column',gap:'.25rem'};
  const grid:React.CSSProperties={display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:'.75rem'};
  const run=(request:TemporalRequest|Promise<TemporalRequest>)=>{setExportError(null);void session.run(request);};
  const save=(analysis:boolean)=>{
    try{if(!accepted)return;downloadString(analysis&&accepted.record?serializeAnalysisRecord(accepted.record):JSON.stringify(validateTemporalDataset(accepted.dataset),null,2),
      analysis?'temporal-diagnostics.json':'dated-tree-dataset.json','application/json');setExportError(null);}
    catch(cause){setExportError(cause instanceof Error?cause.message:String(cause));}
  };
  const changed=accepted&&(permutations!==String(accepted.options.permutations)||seed!==String(accepted.options.seed)||scheme!==accepted.options.permutationScheme||JSON.stringify(excluded)!==JSON.stringify(accepted.options.excludedSamples));
  const allRows=result?.tips??[],pageCount=Math.max(1,Math.ceil(allRows.length/50)),currentPage=Math.min(page,pageCount-1);
  const residuals=new Map(fit?.residuals.map(row=>[row.id,row]));
  return <Overlay id="phylodynamics" title="DATED TREE · TEMPORAL SIGNAL" size="xl" provenanceBadge={<span data-testid="temporal-source">
    {!accepted?'No input data':accepted.dataset.source.kind==='demo'?'Synthetic example':'User-supplied local phylogram'}</span>}>
    <section aria-label="Private dated-tree diagnostics" style={{display:'grid',gap:'1rem',color:theme.colors.text,overflowWrap:'anywhere'}}>
      <p>Inspect collection dates against a rooted, date-independent phylogram. Input stays local; this cohort is independent of the selected catalog genome.
        Exploratory diagnostics and optional conditional strict-clock dating are separate operations. No population skyline or selection estimate is generated. Export before closing this workspace.</p>
      <button type="button" aria-expanded={ancestralOpen} disabled={busy} onClick={()=>setAncestralOpen(!ancestralOpen)}>
        {ancestralOpen?'Close ancestral reconstruction (export first)':'Open ancestral nucleotide reconstruction'}
      </button>
      {ancestralOpen&&<Suspense fallback={<p>Loading alignment-based reconstruction…</p>}><AncestralReconstructionPanel temporalInput={accepted?.dataset}/></Suspense>}
      {localGenome&&<p>Reference data unavailable for this local genome. Its name and sequence are not sent to external reference services. Sequence analyses remain available.</p>}
      <details><summary>Existing catalog search and method scope</summary>
        <p>The existing NCBI sequence search and alignment-free Mash/UPGMA tree viewer remain available separately. They do not supply this workflow's date-independent rooted phylogram.
          Close and reopen this overlay to return to local diagnostics.</p>
        <button type="button" disabled={!canSearch||busy} onClick={()=>{session.cancel();onCatalog();}}>Open existing NCBI phylogeny search</button>
      </details>
      <label style={labelStyle} htmlFor={`${id}-saved`}>Import dated-tree dataset or saved diagnostics JSON</label>
      <input id={`${id}-saved`} type="file" accept=".json,application/json" disabled={busy} onChange={event=>{
        const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(!file)return;
        run(file.size>10*1024*1024?Promise.reject(new Error('Saved temporal file exceeds the 10 MiB limit.')):file.text().then(content=>({kind:'import' as const,content})));
      }}/>
      <div><button type="button" disabled={busy} onClick={()=>run({kind:'example'})}>Load synthetic dated-tree example</button>{' '}
        <button type="button" disabled={!busy} onClick={session.cancel}>Cancel temporal work</button></div>
      <p role="status" data-testid="temporal-status">{busy?`${phase}. The last accepted data remain unchanged.`:notice??'No temporal data loaded.'}</p>
      {(error||exportError)&&<p role="alert">{error??exportError}</p>}
      <details open={!accepted}><summary>Prepare a new rooted tree and collection-date table</summary>
        <form onSubmit={event=>{
          event.preventDefault();if(!confirmed)return;
          const dataset={format:'phage-explorer-temporal-signal' as const,version:1 as const,name,
            source:{kind:'local' as const,description,reference:reference.trim()||null,license},
            tree:{newick:'',units:'substitutions/site' as const,inferredWithoutDates:true as const,method,rooting,alignmentProvenance:alignment}};
          run(Promise.all([readInput(treeFile,newick),readInput(sampleFile,sampleTable)]).then(([tree,samples])=>({kind:'prepare' as const,dataset:{...dataset,tree:{...dataset.tree,newick:tree}},sampleTable:samples})));
        }}><fieldset disabled={busy} style={{display:'grid',gap:'.75rem'}}>
          <legend>New input draft (does not relabel accepted results)</legend>
          <label style={labelStyle} htmlFor={`${id}-newick`}>Rooted Newick phylogram</label>
          <textarea id={`${id}-newick`} value={newick} rows={3} disabled={!!treeFile} onChange={e=>setNewick(e.target.value)} spellCheck={false}/>
          <label style={labelStyle} htmlFor={`${id}-tree-file`}>Or choose a Newick file</label><input id={`${id}-tree-file`} type="file" accept=".nwk,.newick,.tree,.txt" onChange={e=>setTreeFile(e.currentTarget.files?.[0]??null)}/>
          {treeFile&&<button type="button" onClick={()=>setTreeFile(null)}>Use pasted tree instead</button>}
          <label style={labelStyle} htmlFor={`${id}-samples`}>Collection-date CSV or TSV</label>
          <textarea id={`${id}-samples`} value={sampleTable} rows={4} disabled={!!sampleFile} onChange={e=>setSampleTable(e.target.value)} spellCheck={false}/>
          <label style={labelStyle} htmlFor={`${id}-sample-file`}>Or choose sample metadata</label><input id={`${id}-sample-file`} type="file" accept=".csv,.tsv,.txt" onChange={e=>setSampleFile(e.currentTarget.files?.[0]??null)}/>
          {sampleFile&&<button type="button" onClick={()=>setSampleFile(null)}>Use pasted sample metadata instead</button>}
          <p>Headers: <code>sampleId,collectionDate,dateSource</code>; optional <code>accession,permutationGroup</code>. IDs join exactly, not by row order.
            ISO YYYY-MM-DD and decimal years such as 2020.0 are exact at the declared precision. Bare YYYY/YYYY-MM remain uncertain and are excluded.
            Quote underscores in Newick labels to preserve them. Every non-root branch needs a substitutions/site length; 500 tips maximum.</p>
          <div style={grid}>
            <label style={labelStyle}>Dated cohort name<input required value={name} onChange={e=>setName(e.target.value)}/></label>
            <label style={labelStyle}>Data source description<input required value={description} onChange={e=>setDescription(e.target.value)}/></label>
            <label style={labelStyle}>Source reference (optional)<input value={reference} onChange={e=>setReference(e.target.value)}/></label>
            <label style={labelStyle}>Source license or usage permission<input required value={license} onChange={e=>setLicense(e.target.value)}/></label>
            <label style={labelStyle}>Tree estimation method and version<input required value={method} onChange={e=>setMethod(e.target.value)}/></label>
            <label style={labelStyle}>Rooting method and evidence<input required value={rooting} onChange={e=>setRooting(e.target.value)}/></label>
            <label style={labelStyle}>Alignment or tree-input provenance<input required value={alignment} onChange={e=>setAlignment(e.target.value)}/></label>
          </div>
          <label><input type="checkbox" required checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> I confirm the tree uses substitutions/site and neither its inference nor rooting used these collection dates.</label>
          <button type="submit">Load and validate dated tree</button>
        </fieldset></form>
      </details>
      {accepted&&<>
        <h3 data-testid="temporal-dataset-name">{accepted.dataset.name}</h3>
        <p>{accepted.dataset.source.description} · {accepted.dataset.source.license}. Tree: {accepted.dataset.tree.method}; root: {accepted.dataset.tree.rooting}.
          Input provenance: {accepted.dataset.tree.alignmentProvenance}. {accepted.dataset.samples.length} sample metadata rows.</p>
        <form onSubmit={event=>{event.preventDefault();run({kind:'analyze',dataset:accepted.dataset,options:{permutations:Number(permutations),seed:Number(seed),permutationScheme:scheme,excludedSamples:excluded}});}}>
          <fieldset disabled={busy}><legend>Temporal diagnostic settings</legend><div style={grid}>
            <label style={labelStyle}>Date-label permutations<input type="number" required min={19} max={9999} step={1} value={permutations} onChange={e=>setPermutations(e.target.value)}/></label>
            <label style={labelStyle}>Temporal randomization seed<input type="number" required min={0} max={0xffffffff} step={1} value={seed} onChange={e=>setSeed(e.target.value)}/></label>
            <div><label htmlFor={`${id}-scheme`}>Date randomization scheme</label><select id={`${id}-scheme`} value={scheme} onChange={e=>setScheme(e.target.value as TemporalOptions['permutationScheme'])}>
              <option value="unrestricted">Unrestricted (requires exchangeability)</option><option value="within-groups">Within supplied permutation groups</option></select></div>
            <div><label htmlFor={`${id}-exclude`}>Explicit sample exclusions</label><select id={`${id}-exclude`} multiple value={excluded} onChange={e=>setExcluded(Array.from(e.target.selectedOptions,option=>option.value))}>
              {accepted.dataset.samples.map(sample=><option key={sample.id} value={sample.id}>{sample.id}</option>)}</select></div>
          </div><p>Groups and exclusions must reflect the sampling design, not be chosen to manufacture temporal signal. No automatic outlier removal is performed.</p>
            {changed&&<p>Edited settings are not applied. Displayed diagnostics and exports still use the last accepted parameters.</p>}
            <button type="submit">Run temporal diagnostics</button>
          </fieldset>
        </form>
        <div><button type="button" disabled={busy} onClick={()=>save(false)}>Export dated-tree dataset</button>{' '}
          <button type="button" disabled={busy||!accepted.record} onClick={()=>save(true)}>Export temporal diagnostics</button></div>
      </>}
      {accepted&&<StrictClockPanel accepted={accepted} busy={busy} onFit={options=>run({kind:'date',dataset:accepted.dataset,options})}/>}
      {result&&accepted?.record&&<section data-testid="temporal-result" data-result-id={accepted.record.resultId}>
        <h3>Fixed-root exploratory diagnostics</h3>
        <p>{result.tips.filter(tip=>!tip.exclusion).length}/{result.tips.length} tips retained. Root fixed; branch lengths in substitutions/site. No clock-calibrated tree.</p>
        {result.unavailableReason&&<p data-testid="temporal-unavailable">{result.unavailableReason}</p>}
        {fit&&<><p data-testid="temporal-regression">Slope: {fit.slope.toPrecision(8)} substitutions/site/year; R²: {fit.r2.toPrecision(6)}.
          Descriptive x-intercept: {fit.xIntercept?.toFixed(4)??'unavailable'} (not an inferred ancestor date).</p>
          <p>Leave-one-tip-out slope range: {fit.leaveOneOutSlopeRange?.map(value=>value.toPrecision(6)).join(' – ')??'unavailable'}. This is sensitivity, not a confidence interval.</p>
          <TemporalPlot result={result}/></>}
        {result.randomization?<p data-testid="temporal-randomization">{result.randomization.mode} date-label diagnostic: tail fraction {result.randomization.tailFraction.toPrecision(8)}
          {` (${result.randomization.extreme}/${result.randomization.draws} at least as positive; ${result.randomization.groups} groups)`}.
          {result.randomization.mode==='monte-carlo'?' Monte Carlo uses the plus-one correction.':''} This conditional diagnostic is not a test that validates a molecular clock.</p>
          :<p>{result.randomizationUnavailableReason??result.unavailableReason}</p>}
        <div style={{overflowX:'auto'}}><table aria-label="Dated tips, exclusions and regression residuals"><thead><tr><th>Sample / accession</th><th>Collection year or range</th><th>Distance</th><th>Residual</th><th>Leverage</th><th>Source / exclusion</th></tr></thead>
          <tbody>{allRows.slice(currentPage*50,(currentPage+1)*50).map(tip=>{const row=residuals.get(tip.id);return <tr key={tip.id}><td>{tip.id}<br/>{tip.accession??'No accession'}</td>
            <td>{tip.dateRange?`${tip.dateRange.lower}${tip.dateRange.lower!==tip.dateRange.upper?` – ${tip.dateRange.upper}`:''}`:'Missing'}</td><td>{tip.distance.toPrecision(6)}</td>
            <td>{row?.residual.toPrecision(6)??'Unavailable'}</td><td>{row?.leverage.toPrecision(4)??'Unavailable'}</td><td>{tip.dateSource??'No metadata'}<br/>{tip.exclusion??'Retained'}</td></tr>;})}</tbody></table></div>
        {pageCount>1&&<div><button type="button" disabled={!currentPage} onClick={()=>setPage(currentPage-1)}>Previous samples</button> {currentPage+1}/{pageCount} <button type="button" disabled={currentPage+1===pageCount} onClick={()=>setPage(currentPage+1)}>Next samples</button></div>}
        {result.warnings.map(warning=><p key={warning}>{warning}</p>)}
        <AnalysisRecordDetails record={accepted.record}/>
      </section>}
    </section>
  </Overlay>;
}

import React, { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { ancestralConsensus, ancestralFasta, NUCLEOTIDES,
  type AncestralOptions, type AncestralResult } from '../../../../core/src/analysis/ancestral-reconstruction';
import type { TemporalDataset } from '../../../../core/src/analysis/temporal-signal';
import '../../../../core/src/analysis/nucleotide-model';
import { serializeAnalysisRecord } from '../../../../core/src/analysis-result';
import { AncestralSession, type AncestralRequest } from '../../workers/AncestralSession';
import { downloadString } from '../../utils/export';
import { useTheme } from '../../hooks/useTheme';
import { AnalysisRecordDetails } from './primitives/OverlayProvenance';

const show=(n:number|null|undefined)=>n===null||n===undefined?'Unavailable':n.toPrecision(8);
function TreeInspector({result,selected,onSelect}:{result:AncestralResult;selected:number;onSelect:(index:number)=>void}):React.ReactElement{
  const {theme}=useTheme(),nodes=result.nodes,x:number[]=[],y:number[]=[];
  let leaf=0;nodes.forEach((n,i)=>{x[i]=(n.parent===null?0:x[n.parent])+n.length;});
  for(let i=nodes.length-1;i>=0;i--)y[i]=nodes[i].children.length?nodes[i].children.reduce((s,c)=>s+y[c],0)/nodes[i].children.length:30+22*leaf++;
  const span=Math.max(1e-15,...x),pos=(i:number)=>40+440*x[i]/span,height=Math.max(130,leaf*22+60);
  return <figure style={{margin:0}}><div style={{overflow:'auto',maxHeight:500}}><svg width={790} height={height} viewBox={`0 0 790 ${height}`} role="group" aria-label="Supplied tree and selectable ancestral nodes">
    {nodes.map((n,i)=>n.parent===null?null:<path key={`edge-${n.id}`} d={`M${pos(n.parent)} ${y[n.parent]}V${y[i]}H${pos(i)}`} stroke={theme.colors.textDim} fill="none"/>)}
    {nodes.map((n,i)=><g key={n.id}><circle cx={pos(i)} cy={y[i]} r={selected===i?6:4} fill={selected===i?theme.colors.primary:theme.colors.textDim}
      role="button" tabIndex={0} aria-label={`Inspect ${n.id} ${n.label??'unlabelled ancestor'}`} onClick={()=>onSelect(i)}
      onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onSelect(i);}}}/>
      <text x={pos(i)+9} y={y[i]+4} fill={theme.colors.text} fontSize={11}>{n.id}{n.label?` · ${n.label}`:''}</text></g>)}
    <text x={40} y={height-10} fill={theme.colors.text} fontSize={12}>Supplied branch lengths · substitutions/site · maximum root path {show(Math.max(...x))}</text>
  </svg></div><figcaption>This is the supplied topology, not an inferred or time-scaled tree. Select a node or use the selector below.</figcaption></figure>;
}
const LABELS={name:'Ancestral dataset name',description:'Ancestral source description',reference:'Ancestral source reference',license:'Ancestral license or permission',
  treeMethod:'Ancestral tree method and version',rooting:'Ancestral rooting evidence',alignmentMethod:'Homology alignment method and version',alignmentReference:'Homology alignment reference'};
type Metadata=Record<keyof typeof LABELS,string>;
const read=(file:File|null,fallback:string):Promise<string>=>file&&file.size>2*1024*1024?Promise.reject(new Error('Alignment and tree files must each fit within 2 MiB.')):file?file.text():Promise.resolve(fallback);

/** No catalog genome, external request or raw-sequence alignment is implicitly substituted. */
export function AncestralReconstructionPanel({temporalInput}:{temporalInput?:TemporalDataset}):React.ReactElement{
  const id=useId(),{theme}=useTheme();
  const session=useMemo(()=>new AncestralSession(()=>new Worker(new URL('../../workers/ancestral.worker.ts',import.meta.url),{type:'module'})),[]);
  const {accepted,busy,phase,error,notice}=useSyncExternalStore(session.subscribe,session.getSnapshot,session.getSnapshot);
  const [metadata,setMetadata]=useState<Metadata>(()=>Object.fromEntries(Object.keys(LABELS).map(k=>[k,''])) as Metadata);
  const [newick,setNewick]=useState(''),[fasta,setFasta]=useState(''),[treeFile,setTreeFile]=useState<File|null>(null),[alignmentFile,setAlignmentFile]=useState<File|null>(null);
  const [confirmed,setConfirmed]=useState(false),[start,setStart]=useState('1'),[end,setEnd]=useState('1'),[threshold,setThreshold]=useState('0.9');
  const [gap,setGap]=useState<AncestralOptions['gapPolicy']>('missing'),[node,setNode]=useState(0),[siteIndex,setSiteIndex]=useState(0),[page,setPage]=useState(0),[localError,setLocalError]=useState<string|null>(null);
  useEffect(()=>{session.activate();return session.deactivate;},[session]);
  useEffect(()=>{if(accepted){setStart(String(accepted.options.startColumn));setEnd(String(accepted.options.endColumn));setThreshold(String(accepted.options.minPosterior));setGap(accepted.options.gapPolicy);}setNode(0);setSiteIndex(0);setPage(0);setLocalError(null);},[accepted]);
  const run=(request:AncestralRequest|Promise<AncestralRequest>)=>{setLocalError(null);void session.run(request);};
  const save=(kind:'dataset'|'record'|'fasta')=>{
    if(!accepted)return;
    try{
      if(kind==='record'&&!accepted.record||kind==='fasta'&&!accepted.result)return;
      const content=kind==='dataset'?JSON.stringify(accepted.input,null,2):kind==='record'?serializeAnalysisRecord(accepted.record!):ancestralFasta(accepted.result!);
      downloadString(content,kind==='fasta'?'conditional-ancestors.fasta':kind==='record'?'ancestral-evidence.json':'ancestral-input.json',kind==='fasta'?'text/plain':'application/json');
      setLocalError(null);
    }catch(cause){setLocalError(cause instanceof Error?cause.message:String(cause));}
  };
  const result=accepted?.result,selectedNode=result?.nodes[node],site=result?.sites[siteIndex];
  const pattern=site&&!site.exclusion&&site.pattern!==null?result?.patterns[site.pattern]:null;
  const posterior=pattern?.nodes?.[node],edge=node>0?pattern?.edges?.[node-1]:null;
  const different=edge?.reduce((sum,v,i)=>sum+(Math.floor(i/4)!==i%4?v:0),0);
  const grid:React.CSSProperties={display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))',gap:'.75rem'};
  const field:React.CSSProperties={display:'flex',flexDirection:'column',gap:'.25rem'};
  const changed=accepted&&(start!==String(accepted.options.startColumn)||end!==String(accepted.options.endColumn)||threshold!==String(accepted.options.minPosterior)||gap!==accepted.options.gapPolicy);
  return <section aria-label="Ancestral nucleotide reconstruction" style={{display:'grid',gap:'1rem',color:theme.colors.text,overflowWrap:'anywhere'}}>
    <h3>Alignment-based ancestral nucleotide reconstruction</h3>
    <p>Supply a homologous DNA alignment and an explicitly rooted phylogram in substitutions/site. JC69 is conditional on that tree, with equal base frequencies and substitution rates.
      This does not align raw genomes, fit branch lengths, infer a mutation timeline, or estimate selection. Input stays local. Export before closing this panel.</p>
    <label htmlFor={`${id}-import`}>Import ancestral dataset or saved evidence JSON</label><input id={`${id}-import`} type="file" accept=".json,application/json" disabled={busy} onChange={event=>{
      const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(!file)return;
      run(file.size>10*1024*1024?Promise.reject(new Error('Ancestral file exceeds 10 MiB.')):file.text().then(content=>({kind:'import' as const,content})));
    }}/>
    <button type="button" disabled={!busy} onClick={session.cancel}>Cancel ancestral work</button>
    <p role="status" data-testid="ancestral-status">{busy?`${phase}. Accepted evidence remains unchanged.`:notice??'No ancestral alignment loaded.'}</p>
    {(error||localError)&&<p role="alert">{localError??error}</p>}
    <details open={!accepted}><summary>Prepare homologous FASTA and rooted Newick input</summary>
      <form onSubmit={event=>{
        event.preventDefault();if(!confirmed)return;
        const {name,description,reference,license,treeMethod,rooting,alignmentMethod,alignmentReference}=metadata;
        run(Promise.all([read(treeFile,newick),read(alignmentFile,fasta)]).then(([tree,aligned])=>({kind:'load' as const,input:{format:'phage-explorer-ancestral' as const,version:1 as const,name,
          source:{kind:'local' as const,description,reference,license},tree:{newick:tree,units:'substitutions/site' as const,method:treeMethod,rooting},
          alignment:{fasta:aligned,homologous:true as const,method:alignmentMethod,reference:alignmentReference}}})));
      }}><fieldset disabled={busy} style={{display:'grid',gap:'.75rem'}}><legend>Alignment and tree draft</legend>
        {temporalInput&&<button type="button" onClick={()=>{
          setTreeFile(null);setNewick(temporalInput.tree.newick);setMetadata({...metadata,treeMethod:temporalInput.tree.method,rooting:temporalInput.tree.rooting,alignmentReference:temporalInput.tree.alignmentProvenance});setConfirmed(false);
        }}>Use accepted temporal phylogram</button>}
        <label style={field}>Ancestral rooted Newick<textarea required={!treeFile} disabled={!!treeFile} value={newick} onChange={e=>setNewick(e.target.value)} rows={3} spellCheck={false}/></label>
        <label style={field}>Choose ancestral tree file<input type="file" accept=".nwk,.newick,.tree,.txt" onChange={e=>setTreeFile(e.currentTarget.files?.[0]??null)}/></label>
        {treeFile&&<button type="button" onClick={()=>setTreeFile(null)}>Use pasted ancestral tree</button>}
        <label style={field}>Homologous DNA FASTA<textarea required={!alignmentFile} disabled={!!alignmentFile} value={fasta} onChange={e=>setFasta(e.target.value)} rows={5} spellCheck={false}/></label>
        <label style={field}>Choose homologous alignment file<input type="file" accept=".fa,.fasta,.fas,.fna,.txt" onChange={e=>setAlignmentFile(e.currentTarget.files?.[0]??null)}/></label>
        {alignmentFile&&<button type="button" onClick={()=>setAlignmentFile(null)}>Use pasted homologous alignment</button>}
        <p>Complete trimmed FASTA headers must equal tree-tip labels. Quote literal underscores in Newick. DNA IUPAC, N, ? and gaps are supported; no tips are silently dropped.
          At most 128 tips, 100,000 columns and two million input cells. Each reconstruction window is at most 4096 columns and has a separate posterior-output budget.</p>
        <div style={grid}>{(Object.keys(LABELS) as Array<keyof Metadata>).map(key=><label key={key} style={field}>{LABELS[key]}<input required value={metadata[key]} onChange={e=>setMetadata({...metadata,[key]:e.target.value})}/></label>)}</div>
        <label><input type="checkbox" required checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> I supply homologous aligned DNA and branch lengths in substitutions/site, not a time-scaled tree or merely equal-length genomes.</label>
        <button type="submit">Load ancestral alignment and tree</button>
      </fieldset></form>
    </details>
    {accepted&&<>
      <h4 data-testid="ancestral-name">{accepted.input.name}</h4><p>{accepted.tips} matched tips; {accepted.columns} alignment columns. {accepted.input.source.kind==='demo'?'Synthetic example':'User-supplied local data'}.
        {` ${accepted.input.source.description}; ${accepted.input.source.reference}; ${accepted.input.source.license}`}</p>
      <form onSubmit={event=>{event.preventDefault();run({kind:'analyze',input:accepted.input,options:{startColumn:Number(start),endColumn:Number(end),minPosterior:Number(threshold),gapPolicy:gap}});}}>
        <fieldset disabled={busy}><legend>Conditional reconstruction settings</legend><div style={grid}>
          <label style={field}>First alignment column<input type="number" min={1} max={accepted.columns} step={1} required value={start} onChange={e=>setStart(e.target.value)}/></label>
          <label style={field}>Last alignment column<input type="number" min={1} max={accepted.columns} step={1} required value={end} onChange={e=>setEnd(e.target.value)}/></label>
          <label style={field}>Consensus posterior threshold<input type="number" min={0.25} max={1} step="any" required value={threshold} onChange={e=>setThreshold(e.target.value)}/></label>
          <div><label htmlFor={`${id}-gap`}>Alignment gap policy</label><select id={`${id}-gap`} value={gap} onChange={e=>setGap(e.target.value as typeof gap)}>
            <option value="missing">Treat gaps as missing observations</option><option value="exclude-column">Exclude columns containing any gap</option></select></div>
        </div><p>Unresolved or tied states remain N. A posterior is conditional on JC69 and the supplied tree, not empirical confidence.</p>
          {changed&&<p>Draft reconstruction settings are not applied. Results and exports retain the accepted window, gap policy and threshold.</p>}
          <button type="submit">Run ancestral reconstruction</button>
        </fieldset>
      </form>
      <div><button type="button" disabled={busy} onClick={()=>save('dataset')}>Export ancestral input</button>{' '}
        <button type="button" disabled={busy||!accepted.record} onClick={()=>save('record')}>Export ancestral evidence</button>{' '}
        <button type="button" disabled={busy||!result?.analyzedColumns} onClick={()=>save('fasta')}>Export conditional ancestral FASTA</button></div>
    </>}
    {result&&accepted?.record&&<section data-testid="ancestral-result" data-result-id={accepted.record.resultId} style={{display:'grid',gap:'.75rem'}}>
      <h4>Conditional node and branch evidence</h4><p data-testid="ancestral-coverage">{result.analyzedColumns} analyzed columns; {result.excludedColumns} gap/all-missing exclusions; {result.impossibleColumns} zero-likelihood columns.
        Window log likelihood: {show(result.logLikelihood)}.</p>
      {result.impossibleColumns>0&&<p role="status">Some observations are impossible under the exact supplied tree. No probabilities are invented for those columns.</p>}
      <TreeInspector result={result} selected={node} onSelect={setNode}/>
      <div style={grid}><div><label htmlFor={`${id}-node`}>Inspect ancestral node</label><select id={`${id}-node`} value={node} onChange={e=>setNode(Number(e.target.value))}>
        {result.nodes.map((n,i)=><option key={n.id} value={i}>{`${n.id} · ${n.label??'unlabelled'} · ${n.children.length?'internal':'tip'}`}</option>)}</select></div>
        <label style={field}>Inspect alignment column<input type="number" min={result.options.startColumn} max={result.options.endColumn} value={site?.column??result.options.startColumn}
          onChange={e=>{const column=Number(e.target.value);if(Number.isInteger(column)&&column>=result.options.startColumn&&column<=result.options.endColumn)setSiteIndex(column-result.options.startColumn);}}/></label></div>
      <p>{selectedNode?.id} · {selectedNode?.label??'unlabelled ancestor'}; column {site?.column}. {site?.exclusion??'Informative observations'}.
        Resolved / ambiguous / missing tips: {site?.resolvedTips} / {site?.ambiguousTips} / {site?.missingTips}.</p>
      <table aria-label="Selected-node nucleotide probabilities"><thead><tr><th>State</th><th>Conditional probability</th></tr></thead><tbody>
        {NUCLEOTIDES.map((base,i)=><tr key={base}><th>{base}</th><td data-testid={`ancestral-probability-${base}`}>{show(posterior?.[i])}</td></tr>)}</tbody></table>
      <p data-testid="ancestral-edge-difference">Incoming branch endpoint-difference probability: {show(different)}. This is not an event count or a mutation time.</p>
      {edge&&<table aria-label="Joint incoming branch endpoint probabilities"><caption>Rows: parent; columns: child. Joint conditional probabilities, not products of marginals.</caption><thead><tr><th>Parent / child</th>{NUCLEOTIDES.map(b=><th key={b}>{b}</th>)}</tr></thead>
        <tbody>{NUCLEOTIDES.map((b,i)=><tr key={b}><th>{b}</th>{NUCLEOTIDES.map((c,j)=><td key={c}>{show(edge[i*4+j])}</td>)}</tr>)}</tbody></table>}
      <h5>Accepted-threshold consensus for {selectedNode?.id}</h5><pre data-testid="ancestral-consensus" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{selectedNode?ancestralConsensus(result,selectedNode.id):''}</pre>
      <p>FASTA uses stable internal node IDs. The JSON maps those IDs to original labels and retains all probabilities and the alignment-column window; FASTA alone is not a replay record.</p>
      <div style={{overflowX:'auto'}}><table aria-label="Alignment-column ancestral evidence"><thead><tr><th>Column</th><th>Excluded</th><th>Resolved / ambiguous / missing</th>{NUCLEOTIDES.map(b=><th key={b}>{b}</th>)}</tr></thead>
        <tbody>{result.sites.slice(page*50,(page+1)*50).map(s=>{const p=s.exclusion||s.pattern===null?null:result.patterns[s.pattern].nodes?.[node];return <tr key={s.column}>
          <td>{s.column}</td><td>{s.exclusion??'No'}</td><td>{s.resolvedTips} / {s.ambiguousTips} / {s.missingTips}</td>{NUCLEOTIDES.map((b,i)=><td key={b}>{show(p?.[i])}</td>)}</tr>;})}</tbody></table></div>
      {result.sites.length>50&&<div><button type="button" disabled={!page} onClick={()=>setPage(page-1)}>Previous ancestral columns</button> {page+1}/{Math.ceil(result.sites.length/50)}{' '}
        <button type="button" disabled={(page+1)*50>=result.sites.length} onClick={()=>setPage(page+1)}>Next ancestral columns</button></div>}
      <details><summary>Accepted alignment and tree provenance</summary><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify({source:accepted.input.source,tree:accepted.input.tree,
        alignment:{method:accepted.input.alignment.method,reference:accepted.input.alignment.reference},options:result.options,nodes:result.nodes},null,2)}</pre></details>
      {result.warnings.map(w=><p key={w}>{w}</p>)}<AnalysisRecordDetails record={accepted.record}/>
    </section>}
  </section>;
}

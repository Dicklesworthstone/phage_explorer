import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { PhageFull, AcrCandidate, CRISPRAnalysisResult } from '@phage-explorer/core';
import { usePhageStore } from '@phage-explorer/state';
import type { PhageRepository } from '../../db';
import { useOverlay } from './OverlayProvider';
import { Overlay } from './Overlay';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { ActionIds } from '../../keyboard';
import { serializeAnalysisRecord } from '../../../../core/src/analysis-result';
import { resolveSpacerOptions, type SpacerGenome, type SpacerLibrary } from '../../../../core/src/analysis/spacer-reference';
import { SpacerReferenceSession, readSpacerGenome, type SpacerRequest } from '../../workers/SpacerReferenceSession';
import { downloadString } from '../../utils/export';
import { AnalysisRecordDetails } from './primitives/OverlayProvenance';

interface CRISPROverlayProps { repository: PhageRepository | null; phage: PhageFull | null }
const TEMPLATE:SpacerLibrary={format:'phage-explorer-spacer-library',version:1,name:'Synthetic format example — replace with sourced records',
  source:{kind:'demo',reference:'Hand-constructed format example, not an empirical spacer',version:'1',license:'CC0 synthetic example',scope:'One synthetic strain; no real immune-reference coverage'},
  hosts:[{id:'example-host',name:'Synthetic host',strain:'example strain',accession:'synthetic:host'}],
  spacers:[{id:'example-spacer',hostId:'example-host',arrayAccession:'synthetic:array',sequence:'ACGATTCGGTACCTAGTGCA',system:null,target:'DNA',orientation:'guide-equivalent',pam:null,seed:null}]};
const STATUSES={
  'no-spacer-data':'No spacer records for the selected host scope. Nothing was searched.',
  'unsupported-references':'Reference records exist, but none support this DNA comparison. Inspect exclusions.',
  'no-usable-windows':'No complete unambiguous genome windows were available for the supported spacers.',
  'no-sequence-match':'No sequence matches within the submitted mismatch allowance and searchable coverage.',
  'sequence-matches':'Sequence matches found. PAM and seed checks use only the supplied rules; they do not establish immunity.',
};

export function CRISPROverlay({repository,phage}:CRISPROverlayProps):React.ReactElement|null {
  const {isOpen,toggle,close}=useOverlay(),{theme}=useTheme(),id=useId();
  const scope=useMemo(()=>({repository,phage}),[repository,phage]);
  const session=useMemo(()=>new SpacerReferenceSession(()=>new Worker(new URL('../../workers/spacer-reference.worker.ts',import.meta.url),{type:'module'})),[]);
  const snapshot=useSyncExternalStore(session.subscribe,session.getSnapshot,session.getSnapshot);
  const {library,busy,phase,error,notice}=snapshot;
  const accepted=snapshot.acceptedScope===scope?snapshot.accepted:null,result=accepted?.result;
  const [hostId,setHostId]=useState(''),[mismatches,setMismatches]=useState('0');
  const [topology,setTopology]=useState<SpacerGenome['topology']>('unknown');
  const [page,setPage]=useState(0),[exportError,setExportError]=useState<string|null>(null);
  const [shortlist,setShortlist]=useState<{scope:object;rows:AcrCandidate[]}|null>(null);
  const [shortlistBusy,setShortlistBusy]=useState(false),[shortlistError,setShortlistError]=useState<string|null>(null);
  const shortlistOwner=useRef<AbortController|null>(null);
  const cancelShortlist=()=>{const old=shortlistOwner.current;shortlistOwner.current=null;old?.abort();setShortlistBusy(false);};
  useHotkey(ActionIds.OverlayCRISPR,()=>toggle('crispr'),{modes:['NORMAL']});
  useLayoutEffect(()=>{
    session.setScope(scope);setTopology(phage?.localGenome?.topology??'unknown');setExportError(null);setPage(0);
    cancelShortlist();setShortlist(null);setShortlistError(null);
  },[scope,session,phage]);
  useEffect(()=>{session.activate();return()=>{session.deactivate();shortlistOwner.current?.abort();};},[session]);
  useEffect(()=>{if(!isOpen('crispr')){session.cancel();cancelShortlist();}},[isOpen,session]);
  useEffect(()=>{setHostId('');setMismatches('0');setPage(0);},[library]);
  useEffect(()=>{if(accepted?.result){setHostId(accepted.result.options.hostId??'');setMismatches(String(accepted.result.options.maxMismatches));setTopology(accepted.genome!.topology);setPage(0);}},[accepted]);
  const run=(input:SpacerRequest|((signal:AbortSignal)=>Promise<SpacerRequest>))=>{setExportError(null);void session.run(scope,input);};
  const currentGenome=(signal:AbortSignal,submittedTopology=topology)=>{
    if(!repository||!phage)return Promise.reject(new Error('Select a genome with an available repository first.'));
    return readSpacerGenome(repository,phage,submittedTopology,signal);
  };
  const save=(value:string,name:string)=>{try{downloadString(value,name,'application/json');setExportError(null);}catch(cause){setExportError(cause instanceof Error?cause.message:String(cause));}};
  const loadLibrary=(file:File)=>run(async()=>{
    if(file.size>2*1024*1024)throw new Error('Spacer library exceeds the 2 MiB limit.');
    return {kind:'library',content:await file.text()};
  });
  const replay=(file:File)=>{
    const submittedTopology=topology;
    run(async signal=>{
      if(file.size>10*1024*1024)throw new Error('Spacer evidence exceeds the 10 MiB limit.');
      const content=await file.text();if(signal.aborted)throw new DOMException('Cancelled','AbortError');
      return {kind:'replay',content,genome:await currentGenome(signal,submittedTopology)};
    });
  };
  const computeShortlist=async()=>{
    if(!repository||!phage)return;cancelShortlist();const owner=new AbortController();shortlistOwner.current=owner;
    setShortlistBusy(true);setShortlistError(null);
    try{
      const selected=await readSpacerGenome(repository,phage,topology,owner.signal);
      const rows=await new Promise<AcrCandidate[]>((resolve,reject)=>{
        const worker=new Worker(new URL('../../workers/crispr.worker.ts',import.meta.url),{type:'module'}),jobId=crypto.randomUUID();let done=false;
        const finish=(value?:AcrCandidate[],cause?:Error)=>{if(done)return;done=true;owner.signal.removeEventListener('abort',cancel);worker.terminate();if(cause)reject(cause);else resolve(value!);};
        const cancel=()=>finish(undefined,new DOMException('Cancelled','AbortError'));owner.signal.addEventListener('abort',cancel,{once:true});
        worker.onmessage=(event:MessageEvent<{jobId?:string;ok:boolean;result?:CRISPRAnalysisResult;error?:string}>)=>{
          if(event.data.jobId!==jobId)return;
          if(event.data.ok&&Array.isArray(event.data.result?.acrCandidates))finish(event.data.result.acrCandidates);
          else finish(undefined,new Error(event.data.error??'Shortlist calculation failed.'));
        };
        worker.onerror=()=>finish(undefined,new Error('Shortlist worker failed.'));
        worker.onmessageerror=()=>finish(undefined,new Error('Shortlist result could not be read.'));
        try{if(owner.signal.aborted)cancel();else worker.postMessage({jobId,sequence:selected.sequence,genes:phage.genes,host:phage.host??undefined});}
        catch(cause){finish(undefined,cause instanceof Error?cause:new Error(String(cause)));}
      });
      if(shortlistOwner.current===owner&&!owner.signal.aborted)setShortlist({scope,rows});
    }catch(cause){if(shortlistOwner.current===owner&&!owner.signal.aborted)setShortlistError(cause instanceof Error?cause.message:String(cause));}
    finally{if(shortlistOwner.current===owner){shortlistOwner.current=null;setShortlistBusy(false);}}
  };
  if(!isOpen('crispr'))return null;
  const waiting=busy||shortlistBusy,hosts=new Map(library?.hosts.map(host=>[host.id,host])),records=new Map(library?.spacers.map(spacer=>[spacer.id,spacer]));
  const changed=result&&(result.options.hostId!==(hostId||null)||result.options.maxMismatches!==Number(mismatches)||accepted?.genome?.topology!==topology);
  const totalPages=Math.max(1,Math.ceil((result?.hits.length??0)/50)),currentPage=Math.min(page,totalPages-1);
  return <Overlay id="crispr" title="CRISPR SPACER EVIDENCE" hotkey="Alt+C" size="xl" provenanceBadge={<span data-testid="spacer-source">{!library?'No reference library':library.source.kind==='demo'?'Synthetic reference example':`${library.source.kind} spacer reference`}</span>}>
    <section aria-label="Sourced CRISPR spacer comparison" style={{display:'grid',gap:'1rem',color:theme.colors.text,overflowWrap:'anywhere'}}>
      <p>Compare the selected genome to your own sourced host spacer library. Files stay in this browser session. No hit does not imply susceptibility,
        and sequence matches do not establish immunity. Export references and evidence before closing. Changing genomes retains the library but clears obsolete results.</p>
      <label htmlFor={`${id}-library`}>Import spacer reference library JSON</label>
      <input id={`${id}-library`} type="file" accept=".json,application/json" disabled={waiting} onChange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file)loadLibrary(file);}}/>
      <details><summary>Reference format, orientation and scope</summary>
        <p>Version 1 JSON contains library source/version/license/scope, hosts with strain and accession, and spacer records with hostId and arrayAccession.
          The sequence must be written as guide-equivalent DNA 5′→3′. Supply target DNA/RNA/unknown and orientation guide-equivalent/unknown explicitly.
          Unknown system, PAM or seed values are null; no default is inferred. A PAM object contains side (5prime/3prime), IUPAC motif and reference.
          A seed object contains 0-based start, exclusive end, maxMismatches and reference. RNA targets, unknown orientations, ambiguous spacers and unsupported lengths are reported as exclusions.</p>
        <p>References are not downloaded or verified remotely. The template is synthetic and must not be relabeled as an empirical source without replacing its contents and provenance.</p>
        <button type="button" disabled={waiting} onClick={()=>save(JSON.stringify(TEMPLATE,null,2),'spacer-library-template.json')}>Download synthetic reference format example</button>
      </details>
      <p role="status" data-testid="spacer-status">{busy?phase:notice??'No spacer library loaded. Nothing has been searched.'}</p>
      {(error||exportError)&&<p role="alert">{error??exportError}</p>}
      <button type="button" disabled={!waiting} onClick={()=>{session.cancel();cancelShortlist();}}>Cancel spacer work</button>
      {!phage&&<p>Select a genome to compare or restore evidence.</p>}
      {library&&<><h3>{library.name}</h3><p>{library.source.reference} · version {library.source.version} · {library.source.license}. Scope: {library.source.scope}.
        {' '}{library.hosts.length} host definitions and {library.spacers.length} reference records.</p></>}
      <form onSubmit={event=>{
        event.preventDefault();if(!library)return;const captured=structuredClone(library),submittedTopology=topology;
        const options={hostId:hostId||null,maxMismatches:Number(mismatches)};
        run(async signal=>{resolveSpacerOptions(options);return {kind:'analyze',library:captured,options,genome:await currentGenome(signal,submittedTopology)};});
      }}><fieldset disabled={waiting} style={{display:'grid',gap:'.6rem'}}><legend>Comparison settings</legend>
        <label htmlFor={`${id}-host`}>Reference host scope</label><select id={`${id}-host`} value={hostId} onChange={e=>setHostId(e.target.value)} disabled={!library}>
          <option value="">All supplied hosts</option>{library?.hosts.map(host=><option key={host.id} value={host.id}>{host.name} — {host.strain} ({host.accession})</option>)}</select>
        <label htmlFor={`${id}-mismatches`}>Maximum spacer substitutions</label><input id={`${id}-mismatches`} type="number" min={0} max={5} step={1} required value={mismatches} onChange={e=>setMismatches(e.target.value)}/>
        <label htmlFor={`${id}-topology`}>Search genome topology</label><select id={`${id}-topology`} value={topology} onChange={e=>setTopology(e.target.value as SpacerGenome['topology'])}>
          <option value="unknown">Unknown — do not cross origin</option><option value="linear">Linear</option><option value="circular">Circular — allow origin-spanning matches</option></select>
        <p>Topology is an explicit analysis assumption. Host scope comes from the imported library, not a guessed species-name match. Rules are reported even when they fail; there is no inferred pressure score.</p>
        {changed&&<p>Edited settings are not applied. Displayed matches and exports still use the accepted inputs and parameters.</p>}
        <button type="submit" disabled={!library||!repository||!phage}>Run spacer comparison</button>
      </fieldset></form>
      <label htmlFor={`${id}-replay`}>Restore and verify spacer evidence JSON</label>
      <input id={`${id}-replay`} type="file" accept=".json,application/json" disabled={waiting||!repository||!phage} onChange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file)replay(file);}}/>
      <p>Restoration requires the same selected genome, identity and topology. It recomputes matches; saved output is never installed without verification.</p>
      <div><button type="button" disabled={waiting||!library} onClick={()=>{if(library)save(JSON.stringify(library,null,2),'spacer-reference-library.json');}}>Export spacer library</button>{' '}
        <button type="button" disabled={waiting||!accepted?.record} onClick={()=>{if(accepted?.record)save(serializeAnalysisRecord(accepted.record),'spacer-evidence.json');}}>Export spacer evidence</button></div>
      {accepted?.record&&result&&<section data-testid="spacer-result" data-result-id={accepted.record.resultId}>
        <h3>{accepted.genome!.name}: accepted spacer evidence</h3><p data-testid="spacer-outcome">{STATUSES[result.status]}</p>
        <p>{result.searchedRecords}/{result.selectedRecords} records searched; {result.distinctSequences} distinct sequences; {result.hits.length} reference-hit rows.
          Coordinates are 0-based, half-open on the forward genome. End may exceed genome length for a wrapped hit; split intervals show exact covered bases.</p>
        <div style={{overflowX:'auto'}}><table aria-label="Spacer host reference coverage"><thead><tr><th>Host / strain</th><th>Records</th><th>Searched</th><th>Excluded</th><th>Hit records</th><th>Unique oriented loci</th></tr></thead>
          <tbody>{result.hosts.map(host=><tr key={host.hostId}><td>{hosts.get(host.hostId)?.name} / {hosts.get(host.hostId)?.strain}<br/>{hosts.get(host.hostId)?.accession}</td><td>{host.records}</td><td>{host.searched}</td><td>{host.excluded}</td><td>{host.hitRecords}</td><td>{host.uniqueLoci}</td></tr>)}</tbody></table></div>
        <svg viewBox="0 0 700 62" role="img" aria-label="Spacer match positions on the selected genome" style={{width:'100%',maxHeight:90}}>
          <path d="M10 30H690" stroke={theme.colors.textDim}/>{result.hits.flatMap((hit,index)=>hit.segments.map((segment,j)=><rect key={`${index}:${j}`} x={10+680*segment.start/accepted.genome!.sequence.length} y={hit.strand==='+'?10:33} width={Math.max(1,680*(segment.end-segment.start)/accepted.genome!.sequence.length)} height={17} fill={theme.colors.primary} opacity={.65}>
            <title>{`${hit.spacerId} ${hit.strand} [${segment.start},${segment.end})`}</title></rect>))}</svg>
        <div style={{overflowX:'auto'}}><table aria-label="Sourced spacer matches"><thead><tr><th>Spacer / array / system</th><th>Host strain</th><th>Genome interval / strand</th><th>Guide-oriented target / mismatch positions</th><th>PAM evidence</th><th>Seed evidence</th><th>Inspect</th></tr></thead>
          <tbody>{result.hits.slice(currentPage*50,(currentPage+1)*50).map((hit,i)=>{const ref=records.get(hit.spacerId);return <tr key={`${hit.spacerId}:${hit.start}:${hit.strand}:${i}`}>
            <td>{hit.spacerId}<br/>{ref?.arrayAccession}<br/>{ref?.system??'Unknown system'}</td><td>{hosts.get(hit.hostId)?.strain}</td>
            <td>{hit.segments.map(s=>`[${s.start},${s.end})`).join(' + ')} {hit.strand}{hit.wrapsOrigin?' (origin crossing)':''}</td>
            <td><code>{hit.protospacer}</code><br/>{hit.mismatchPositions.length} substitutions: {hit.mismatchPositions.join(', ')||'none'}; {(hit.identity*100).toFixed(2)}% identity</td>
            <td>{hit.pam.status}: {hit.pam.sequence??'—'}<br/>{ref?.pam?`${ref.pam.side} ${ref.pam.motif}; ${ref.pam.reference}`:'No supplied rule'}<br/>{hit.pam.reason}</td>
            <td>{hit.seed.status}{hit.seed.mismatches!==null?`: ${hit.seed.mismatches} substitutions`:''}<br/>{ref?.seed?`[${ref.seed.start},${ref.seed.end}); ${ref.seed.reference}`:'No supplied rule'}</td>
            <td><button type="button" onClick={()=>{const state=usePhageStore.getState();state.setViewMode('dna');state.setScrollPosition(hit.start);close('crispr');}}>Inspect locus</button></td>
          </tr>;})}</tbody></table></div>
        {totalPages>1&&<div><button type="button" disabled={!currentPage} onClick={()=>setPage(currentPage-1)}>Previous matches</button> {currentPage+1}/{totalPages} <button type="button" disabled={currentPage+1===totalPages} onClick={()=>setPage(currentPage+1)}>Next matches</button></div>}
        <details><summary>Searchable windows and excluded reference records</summary><p>{result.coverage.map(row=>`${row.length} bp: ${row.unambiguousStarts}/${row.possibleStarts} starts have complete unambiguous DNA`).join('; ')||'No supported spacer lengths.'}</p>
          <ul>{result.excluded.map(row=><li key={row.spacerId}>{row.spacerId} ({row.hostId}): {row.reason}</li>)}</ul></details>
        {result.warnings.map(warning=><p key={warning}>{warning}</p>)}<AnalysisRecordDetails record={accepted.record}/>
      </section>}
      <details><summary>Separate sequence-only Acr shortlist</summary>
        <p>The existing size/acidity heuristic remains available. It does not use the imported spacers, validate a protein family, or establish anti-CRISPR activity.
          Its simple interval-translation path is not validated for joined CDS or alternative translation rules. Curated anti-defense domain annotations remain separate in the defense views.</p>
        <button type="button" disabled={waiting||!repository||!phage} onClick={()=>void computeShortlist()}>Compute sequence-only Acr shortlist</button>
        {shortlistBusy&&<p role="status">Computing separate sequence heuristic…</p>}{shortlistError&&<p role="alert">{shortlistError}</p>}
        {shortlist?.scope===scope&&<><p>{shortlist.rows.length} heuristic candidates; not confirmed anti-CRISPR calls.</p><ul>{shortlist.rows.map(row=><li key={row.geneId}>{row.geneName??row.geneId}: heuristic score {row.score}, category {row.family}</li>)}</ul></>}
      </details>
    </section>
  </Overlay>;
}

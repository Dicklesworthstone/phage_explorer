import React, { useEffect, useId, useState } from 'react';
import { exportDatedNewick, resolveDatingOptions, type DatingOptions, type DatedTreeResult } from '../../../../core/src/analysis/strict-clock';
import { serializeAnalysisRecord } from '../../../../core/src/analysis-result';
import type { TemporalWorkResult } from '../../workers/TemporalSignalSession';
import { useTheme } from '../../hooks/useTheme';
import { downloadString } from '../../utils/export';
import { AnalysisRecordDetails } from './primitives/OverlayProvenance';

function DatedTreePlot({result}:{result:DatedTreeResult}):React.ReactElement|null {
  const {theme}=useTheme();
  if(result.status!=='fitted')return null;
  const nodes=result.nodes,byId=new Map(nodes.map(node=>[node.id,node]));
  const children=new Map<string,string[]>(),vertical=new Map<string,number>();let tipIndex=0;
  for(const node of nodes) {
    if(node.parentId)children.set(node.parentId,[...children.get(node.parentId)??[],node.id]);
    if(node.isTip)vertical.set(node.id,35+tipIndex++*25);
  }
  for(const node of [...nodes].reverse())if(!node.isTip) {
    const ys=children.get(node.id)!.map(child=>vertical.get(child)!);
    vertical.set(node.id,(Math.min(...ys)+Math.max(...ys))/2);
  }
  const start=Math.min(...nodes.map(node=>node.date)),end=Math.max(...nodes.map(node=>node.dateRange?.upper??node.date));
  const span=Math.max(1e-8,end-start),x=(date:number)=>55+530*(date-start)/span,height=Math.max(145,tipIndex*25+75);
  return <figure style={{margin:0}}><div style={{overflow:'auto',maxHeight:470}}>
    <svg viewBox={`0 0 820 ${height}`} role="img" aria-label="Conditional strict-clock tree in calendar years" style={{width:'100%',minWidth:600}}>
      {nodes.filter(node=>node.parentId!==null).map(node=>{
        const parent=byId.get(node.parentId!)!,y=vertical.get(node.id)!;
        return <path key={node.id} d={`M${x(parent.date)} ${vertical.get(parent.id)}V${y}H${x(node.date)}`} fill="none" stroke={theme.colors.primary} strokeWidth={1.5}/>;
      })}
      {nodes.map(node=><g key={node.id}>
        {node.dateRange&&node.dateRange.lower!==node.dateRange.upper&&<path d={`M${x(node.dateRange.lower)} ${vertical.get(node.id)}H${x(node.dateRange.upper)}`} stroke={theme.colors.warning} strokeWidth={6} opacity={.4}/>}
        <circle cx={x(node.date)} cy={vertical.get(node.id)} r={3} fill={theme.colors.accent}><title>{`${node.label??node.id}: ${node.date}; ${node.duration} years from parent`}</title></circle>
        {node.isTip&&<text x={x(node.date)+7} y={vertical.get(node.id)!+4} fill={theme.colors.text} fontSize={11}>{node.label}</text>}
      </g>)}
      <path d={`M55 ${height-30}H585`} stroke={theme.colors.textDim}/>
      {[0,.25,.5,.75,1].map(fraction=><text key={fraction} x={55+530*fraction} y={height-10} fill={theme.colors.text} fontSize={10}>{(start+span*fraction).toFixed(2)}</text>)}
    </svg></div><figcaption>Calendar-year branch durations, conditional on the chosen strict clock and supplied root/topology.
      Thick tip segments are supplied collection-date bounds, not confidence intervals. Original topology and zero-duration branches are retained.</figcaption></figure>;
}

/** Separate from exploratory date-label diagnostics; fitting never prunes their excluded tips. */
export function StrictClockPanel({accepted,busy,onFit}:{accepted:TemporalWorkResult;busy:boolean;onFit:(options:DatingOptions)=>void}):React.ReactElement {
  const id=useId();
  const [mode,setMode]=useState<DatingOptions['rateMode']>('estimate'),[fixed,setFixed]=useState('.01'),[source,setSource]=useState('');
  const [minimum,setMinimum]=useState('1e-10'),[maximum,setMaximum]=useState('1'),[iterations,setIterations]=useState('10000');
  const [confirmed,setConfirmed]=useState(false),[error,setError]=useState<string|null>(null);
  const result=accepted.dating,record=accepted.datingRecord;
  useEffect(()=>{
    const options=result?.options??resolveDatingOptions();
    setMode(options.rateMode);setFixed(String(options.fixedRate??.01));setSource(options.rateSource??'');
    setMinimum(String(options.minimumRate));setMaximum(String(options.maximumRate));setIterations(String(options.maxIterations));
    setConfirmed(false);setError(null);
  },[accepted.dataset,result]);
  const save=(tree:boolean)=>{
    try {
      if(!result||!record)return;
      downloadString(tree?exportDatedNewick(result):serializeAnalysisRecord(record),tree?'strict-clock-years.nwk':'strict-clock-fit.json',tree?'text/plain':'application/json');
      setError(null);
    }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
  };
  return <section aria-label="Conditional strict-clock dating" style={{display:'grid',gap:'.75rem'}}>
    <h3>Fit a time-scaled tree under a strict clock</h3>
    <p>This fits every branch, not the root-to-tip regression line. All supplied tips are retained; diagnostic exclusions do not prune this fit.
      Every tip needs a sourced date or interval. An estimated rate requires two different exact tip dates; a fixed rate requires one exact tip date.
      The dense solver supports up to 128 tips. A rate at its search bound or an unresolved solver produces no node dates.</p>
    <form onSubmit={event=>{
      event.preventDefault();if(!confirmed)return;
      try {const options=resolveDatingOptions({rateMode:mode,fixedRate:mode==='fixed'?Number(fixed):null,rateSource:mode==='fixed'?source:null,
        minimumRate:Number(minimum),maximumRate:Number(maximum),maxIterations:Number(iterations)});setError(null);onFit(options);}
      catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
    }}><fieldset disabled={busy} style={{display:'grid',gap:'.6rem'}}>
      <legend>Explicit full-tree model and rate settings</legend>
      <label htmlFor={`${id}-mode`}>Strict-clock rate mode</label>
      <select id={`${id}-mode`} value={mode} onChange={event=>setMode(event.target.value as DatingOptions['rateMode'])}>
        <option value="estimate">Estimate from dated tips</option><option value="fixed">Supply a sourced fixed rate</option>
      </select>
      {mode==='fixed'&&<>
        <label htmlFor={`${id}-fixed`}>Fixed substitution rate (substitutions/site/year)</label>
        <input id={`${id}-fixed`} type="number" min={1e-12} max={10} step="any" required value={fixed} onChange={event=>setFixed(event.target.value)}/>
        <label htmlFor={`${id}-source`}>Fixed rate source or explicit assumption</label>
        <input id={`${id}-source`} required maxLength={2000} value={source} onChange={event=>setSource(event.target.value)}/>
      </>}
      <label htmlFor={`${id}-min`}>Minimum dating rate</label>
      <input id={`${id}-min`} type="number" min={1e-12} max={10} step="any" required value={minimum} onChange={event=>setMinimum(event.target.value)}/>
      <label htmlFor={`${id}-max`}>Maximum dating rate</label>
      <input id={`${id}-max`} type="number" min={1e-12} max={10} step="any" required value={maximum} onChange={event=>setMaximum(event.target.value)}/>
      <label htmlFor={`${id}-iterations`}>Maximum dating solver iterations</label>
      <input id={`${id}-iterations`} type="number" min={1} max={20000} step={1} required value={iterations} onChange={event=>setIterations(event.target.value)}/>
      <p>Equal branch weights; fixed root and topology; one substitution rate. No confidence intervals or clock-adequacy test.
        Editing these settings does not alter a previously accepted result or its export. Fitting runs in the cancellable temporal worker.</p>
      <label><input type="checkbox" required checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>
        I accept the fixed-root strict-clock assumptions; numerical convergence is not clock validation.</label>
      <button type="submit">Fit strict-clock tree</button>
    </fieldset></form>
    {error&&<p role="alert">{error}</p>}
    {result&&record&&<section data-testid="strict-clock-result" data-result-id={record.resultId}>
      <h4>Conditional branch-length fit</h4>
      <p data-testid="strict-clock-summary">{result.status==='fitted'
        ? `${result.options.rateMode==='fixed'?'Supplied':'Estimated'} rate: ${result.rate.toPrecision(8)} substitutions/site/year. Conditional root date: ${result.rootDate!.toFixed(6)}.`
        : 'Node dates unavailable; the rate is only a boundary or unresolved candidate.'}</p>
      {result.reason&&<p role="alert">{result.reason}</p>}
      <p>{result.exactTips} exact-date tips; {result.intervalTips} interval-date tips; {result.zeroDurationBranches} zero-duration fitted branches.
        Sum of squared branch residuals: {result.sumSquaredResiduals.toPrecision(7)}. No population-history or confidence claim is made.</p>
      <details><summary>Numerical optimality certificate</summary><p>Converged: {String(result.certificate.converged)}; iterations: {result.certificate.iterations};
        design condition number: {result.certificate.conditionNumber.toPrecision(6)}; primal violation: {result.certificate.primalViolation.toPrecision(4)};
        stationarity residual: {result.certificate.stationarity.toPrecision(4)}; complementarity: {result.certificate.complementarity.toPrecision(4)}.
        These check the optimization, not the biological model.</p></details>
      <DatedTreePlot result={result}/>
      {result.nodes.length>0&&<details><summary>Node dates, input bounds and original versus fitted branches</summary>
        <div style={{overflowX:'auto'}}><table aria-label="Strict-clock dates and branch residuals"><thead><tr><th>Node / parent</th><th>Calendar year</th><th>Supplied date bounds</th><th>Years from parent</th><th>Input length</th><th>Fitted length</th><th>Residual</th></tr></thead>
          <tbody>{result.nodes.map(node=><tr key={node.id}><td>{node.label??node.id} / {node.parentId??'root'}</td><td>{node.date.toFixed(6)}</td>
            <td>{node.dateRange?`${node.dateRange.lower} – ${node.dateRange.upper}${node.atDateBound?' (active bound)':''}`:'Internal node'}<br/>{node.dateSource??''}</td>
            <td>{node.duration.toPrecision(6)}</td><td>{node.sourceLength.toPrecision(6)}</td><td>{node.fittedLength.toPrecision(6)}</td><td>{node.residual.toPrecision(6)}</td></tr>)}</tbody>
        </table></div></details>}
      {result.warnings.map(warning=><p key={warning}>{warning}</p>)}
      <button type="button" disabled={busy||result.status!=='fitted'} onClick={()=>save(true)}>Export dated Newick (years)</button>{' '}
      <button type="button" disabled={busy} onClick={()=>save(false)}>Export strict-clock fit</button>
      <p>Restore the JSON fit using the existing dated-tree import control. It reruns the solver and checks the complete record before acceptance.
        Newick is a visualization/interchange export in years, not a substitutions/site input or a complete replay record.</p>
      <AnalysisRecordDetails record={record}/>
    </section>}
  </section>;
}

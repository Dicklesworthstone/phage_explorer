import React, { useEffect, useId, useRef, useState } from 'react';
import { DEFAULT_GROWTH_CONDITIONS, GROWTH_BOUNDS, GROWTH_PARAMETERS, resolveGrowthOptions,
  type GrowthConditions, type GrowthParameter, type GrowthMeasurement, type GrowthFitOptions } from '../../../../core/src/analysis/growth-inference';
import { serializeAnalysisRecord } from '../../../../core/src/analysis-result';
import type { GrowthProfileResult } from '../../../../core/src/analysis/growth-profile';
import type { GrowthRequest, GrowthWorkResult } from '../../workers/growth-inference.worker';
import { runGrowthWork } from '../../workers/growth-inference-client';
import { downloadString } from '../../utils/export';
import { useTheme } from '../../hooks/useTheme';
import { AnalysisRecordDetails } from '../overlays/primitives/OverlayProvenance';

const CONDITIONS: Array<{ key: keyof GrowthConditions; label: string; min: number; max: number; step: number | 'any' }> = [
  { key: 'initialBacteria', label: 'Initial susceptible cells/mL', min: 0, max: 1e9, step: 'any' },
  { key: 'initialPhage', label: 'Initial extracellular PFU/mL', min: 0, max: 1e9, step: 'any' },
  { key: 'bacterialGrowthRate', label: 'Fixed bacterial growth rate /min', min: 0, max: .05, step: 'any' },
  { key: 'phageDecayRate', label: 'Fixed phage decay rate /min', min: 0, max: .1, step: 'any' },
  { key: 'odCellsPerMl', label: 'OD calibration cells/mL per OD', min: 1e4, max: 1e12, step: 'any' },
  { key: 'stages', label: 'Fixed infected-stage count', min: 1, max: 8, step: 1 },
];
const LABELS: Record<GrowthParameter, string> = {
  adsorptionRate: 'Adsorption rate (mL/PFU/min)', latentPeriod: 'Mean infection-to-lysis time (min)', burstSize: 'Burst yield (PFU/cell)',
};
const strings = <T extends string>(value: Record<T, number>): Record<T, string> => Object.fromEntries(Object.entries(value).map(([k,v]) => [k,String(v)])) as Record<T,string>;
const numeric = <T extends string>(value: Record<T, string>): Record<T, number> => Object.fromEntries(Object.entries(value).map(([k,v]) => [k,String(v).trim() === '' ? NaN : Number(v)])) as Record<T,number>;

function GrowthPlot({ accepted, measurement }: { accepted: GrowthWorkResult; measurement: GrowthMeasurement }): React.ReactElement | null {
  const { theme } = useTheme();
  const fit = accepted.result;
  if (!fit) return null;
  const rows = fit.residuals.filter(row => row.type === measurement);
  if (!rows.length) return <p>No {measurement} measurements in this dataset.</p>;
  const transform = (v: number) => measurement === 'OD' ? v : Math.log10(v);
  const prediction = (row: typeof fit.trajectory[number]) => measurement === 'OD' ? row.od : measurement === 'PFU' ? row.phage : row.bacteria;
  const values = [...rows.map(row => transform(row.value)), ...fit.trajectory.map(row => transform(prediction(row)))].filter(Number.isFinite);
  const low = Math.min(...values), high = Math.max(...values), span = Math.max(1e-6, high-low);
  const end = fit.trajectory.at(-1)!.timeMin;
  const x = (t: number) => 60 + 600*t/end, y = (v: number) => 225 - 185*(transform(v)-low)/span;
  const segments = fit.trajectory.filter(row => Number.isFinite(transform(prediction(row))))
    .map(row => `${x(row.timeMin)},${y(prediction(row))}`).join(' ');
  return <figure style={{ margin: 0 }}>
    <svg viewBox="0 0 700 270" role="img" aria-label={`Observed and fitted ${measurement} growth curve`} style={{ width:'100%', maxHeight:320 }}>
      <path d="M60 30V225H670" fill="none" stroke={theme.colors.textDim} />
      <polyline points={segments} fill="none" stroke={theme.colors.primary} strokeWidth={2} />
      {rows.map((row,i) => row.censoring === 'left'
        ? <g key={i} data-testid="growth-censored-point" stroke={theme.colors.accent} fill="none" strokeWidth={2}>
          <path d={`M${x(row.timeMin)-5} ${y(row.value)}h10 M${x(row.timeMin)} ${y(row.value)}v10 m-4 -4 l4 4 4 -4`} />
          <title>{`${row.timeMin} min: below ${row.value} ${measurement}/mL (detection limit, not a measured concentration); predicted ${row.predicted}`}</title>
        </g>
        : <circle key={i} cx={x(row.timeMin)} cy={y(row.value)} r={4} fill={theme.colors.accent}>
          <title>{`${row.timeMin} min: observed ${row.value}, predicted ${row.predicted}`}</title>
        </circle>)}
      <text x={60} y={250} fill={theme.colors.text}>0 min</text><text x={590} y={250} fill={theme.colors.text}>{end} min</text>
      <text x={2} y={35} fill={theme.colors.text} fontSize={11}>{high.toPrecision(4)}</text>
      <text x={2} y={225} fill={theme.colors.text} fontSize={11}>{low.toPrecision(4)}</text>
    </svg>
    <figcaption>Circles: quantified observations. Downward arrows: positive detection limits; the concentration was reported below the limit.
      Line: fitted mechanistic model. {measurement === 'OD' ? 'Linear OD600 axis.' : `log10 ${measurement}/mL axis.`}
      Quantified residuals and censored likelihood contributions are tabulated below.</figcaption>
  </figure>;
}

/** Gaps denote failed candidates; never draw a line through missing evidence. */
function ProfileDetails({ profile }: { profile: GrowthProfileResult }): React.ReactElement {
  const { theme } = useTheme();
  const points = profile.points;
  const minimum = Math.log(points[0].value), maximum = Math.log(points.at(-1)!.value);
  const span = Math.max(1e-8, maximum - minimum);
  const top = Math.max(profile.cutoff * 1.3, ...points.filter(p => p.converged).map(p => p.delta ?? 0));
  const x = (value: number) => 60 + 590 * (Math.log(value) - minimum) / span;
  const y = (delta: number) => 220 - 180 * Math.max(0, delta) / top;
  const paths: string[] = [];
  let path = '';
  for (const point of points) {
    if (!point.converged || point.delta === null) { if (path) paths.push(path); path = ''; continue; }
    path += `${path ? 'L' : 'M'}${x(point.value)},${y(point.delta)} `;
  }
  if (path) paths.push(path);
  return <section aria-label="Growth profile likelihood">
    <h4>Profile likelihood: {LABELS[profile.parameter]}</h4>
    <p data-testid="growth-profile-interval">{profile.interval95
      ? `Individual asymptotic 95% profile interval: ${profile.interval95.map(value => value.toPrecision(6)).join(' – ')}`
      : 'Profile interval unavailable. The traced values are descriptive, not a bounded confidence claim.'}</p>
    <svg viewBox="0 0 700 265" role="img" aria-label="Nuisance-refitted growth profile likelihood" style={{width:'100%',maxHeight:300}}>
      <path d="M60 30V220H660" fill="none" stroke={theme.colors.textDim} />
      <path d={`M60 ${y(profile.cutoff)}H660`} fill="none" stroke={theme.colors.warning} strokeDasharray="5 4" />
      {paths.map((value,i)=><path key={i} d={value} fill="none" stroke={theme.colors.primary} strokeWidth={2} />)}
      {points.filter(p=>p.converged&&p.delta!==null).map((p,i)=><circle key={i} cx={x(p.value)} cy={y(p.delta!)} r={3} fill={theme.colors.accent}>
        <title>{`${p.value}: delta objective ${p.delta}`}</title>
      </circle>)}
      <text x={60} y={245} fontSize={11} fill={theme.colors.text}>{points[0].value.toPrecision(4)}</text>
      <text x={560} y={245} fontSize={11} fill={theme.colors.text}>{points.at(-1)!.value.toPrecision(4)}</text>
      <text x={5} y={35} fontSize={11} fill={theme.colors.text}>{top.toPrecision(3)}</text>
      <text x={5} y={y(profile.cutoff)-5} fontSize={11} fill={theme.colors.text}>3.84146</text>
    </svg>
    <p>Horizontal axis: parameter value on a log scale. Vertical axis: increase in minus twice the log likelihood after refitting the other estimated parameters.
      Dashed line: the individual 95% asymptotic likelihood-ratio cutoff. Failed candidates are gaps, not excluded parameter values.</p>
    <table aria-label="Growth profile endpoints"><thead><tr><th>Side</th><th>Candidate</th><th>Delta objective</th><th>Resolution</th></tr></thead>
      <tbody>{(['lower','upper'] as const).map(side=><tr key={side}><th>{side}</th><td>{profile[side].value?.toPrecision(6)??'Unavailable'}</td>
        <td>{profile[side].delta?.toPrecision(6)??'Unavailable'}</td><td>{profile[side].status}: {profile[side].reason}</td></tr>)}</tbody></table>
    <details><summary>All evaluated profile candidates and nuisance refits</summary>
      <div style={{overflowX:'auto'}}><table aria-label="Growth profile candidates"><thead><tr><th>Candidate</th><th>Profile objective</th><th>Fixed-nuisance objective</th><th>Refitted parameters / failure</th></tr></thead>
        <tbody>{points.map((point,i)=><tr key={i}><td>{point.value.toPrecision(6)}</td><td>{point.objective?.toPrecision(6)??'Unavailable'}</td>
          <td>{point.conditionalObjective?.toPrecision(6)??'Unavailable'}</td><td>{point.reason??(point.parameters?GROWTH_PARAMETERS.map(key=>`${key}: ${point.parameters![key].toPrecision(6)}`).join('; '):'Unavailable')}</td></tr>)}</tbody></table></div>
    </details>
    {profile.warnings.map(warning=><p key={warning}>{warning}</p>)}
  </section>;
}

/** Private observations are independent of the selected catalog genome and forward simulation. */
export function GrowthInferencePanel(): React.ReactElement {
  const id = useId();
  const [accepted, setAccepted] = useState<GrowthWorkResult | null>(null);
  const [conditions, setConditions] = useState(() => strings(DEFAULT_GROWTH_CONDITIONS));
  const [initial, setInitial] = useState(() => strings(resolveGrowthOptions().initial));
  const [free, setFree] = useState<GrowthParameter[]>([...GROWTH_PARAMETERS]);
  const [seed, setSeed] = useState('42');
  const [starts, setStarts] = useState('3'), [iterations, setIterations] = useState('80');
  const [busy, setBusy] = useState(false), [status, setStatus] = useState('No experimental data loaded.');
  const [error, setError] = useState<string | null>(null);
  const [profileParameter, setProfileParameter] = useState<GrowthParameter>('burstSize');
  const [measurement, setMeasurement] = useState<GrowthMeasurement>('PFU');
  const [confirmed, setConfirmed] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { controller.current?.abort(); controller.current = null; }, []);

  const perform = async (request: GrowthRequest | Promise<GrowthRequest>) => {
    controller.current?.abort();
    const owner = new AbortController(); controller.current = owner;
    setBusy(true); setError(null); setStatus('Reading local observations; the previous accepted data is unchanged.');
    try {
      const result = await runGrowthWork(request, owner.signal, message => { if (controller.current === owner) setStatus(message); });
      if (owner.signal.aborted || controller.current !== owner) return;
      setAccepted(result); setConditions(strings(result.dataset.conditions)); setInitial(strings(result.options.initial));
      setFree(result.options.freeParameters); setProfileParameter(result.profile?.parameter ?? result.options.freeParameters[0]); setSeed(String(result.options.seed));
      setStarts(String(result.options.starts)); setIterations(String(result.options.maxIterations));
      setMeasurement(result.dataset.observations[0].type);
      setConfirmed(result.result !== null);
      setStatus(result.verified ? result.profile ? 'Verified: fresh fit, nuisance-refitted profile and complete result identities match.' : 'Verified: fresh fit and complete result identity match the saved experiment.'
        : result.profile ? 'Profile complete. Inspect crossings, nuisance fits and limitations before interpreting intervals.' : result.result ? 'Fit finished. Check identifiability, convergence and residuals before interpreting parameters.' : 'Data loaded. Confirm conditions, select parameters and run the fit.');
    } catch (cause) {
      if (owner.signal.aborted || controller.current !== owner) return;
      setError(cause instanceof Error ? cause.message : String(cause)); setStatus('Operation failed; the previous accepted dataset and fit were preserved.');
    } finally {
      if (controller.current === owner) { controller.current = null; setBusy(false); }
    }
  };
  const cancel = () => { controller.current?.abort(); controller.current = null; setBusy(false); setError(null); setStatus('Growth work cancelled; previous accepted data and fit preserved.'); };
  const options: GrowthFitOptions = { initial: numeric(initial), freeParameters: free, seed: seed.trim() === '' ? NaN : Number(seed), starts: starts.trim() === '' ? NaN : Number(starts), maxIterations: iterations.trim() === '' ? NaN : Number(iterations) };
  const changed = accepted && (JSON.stringify(numeric(conditions)) !== JSON.stringify(accepted.dataset.conditions)
    || JSON.stringify(options) !== JSON.stringify(accepted.options));
  const result = accepted?.result;
  const inputStyle = { width: '100%', minHeight:44, padding:'.4rem', background:'var(--color-background)', color:'inherit', border:'1px solid var(--color-border)' };
  const load = (file?: File) => {
    if (!file) return;
    const submitted = numeric(conditions);
    void perform(file.size > 10*1024*1024 ? Promise.reject(new Error('Growth file exceeds 10 MiB.'))
      : file.text().then(content => ({ kind: 'load' as const, content, name: file.name, conditions: submitted })));
  };
  return <section aria-label="Experimental growth inference" style={{ display:'grid', gap:'1rem', overflowWrap:'anywhere' }}>
    <h3>Fit your experimental growth observations</h3>
    <p>Data stays in this browser worker. These observations are independent of the selected catalog genome and of the forward simulation.
      No paper-derived observations, genome-based latency, or mutation predictions are invented. Export your accepted dataset/fit before leaving this view.</p>
    <label htmlFor={`${id}-file`}>Import growth CSV, TSV, dataset JSON or saved fit</label>
    <input id={`${id}-file`} type="file" accept=".csv,.tsv,.json" disabled={busy} onChange={event => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value=''; load(file);
    }} />
    <p>CSV/TSV header: <code>timeMin,type,value,sigma</code>, optionally followed by <code>,censoring</code>. Each row is PFU/mL, CFU/mL, or OD600.
      Supply known measurement SD: <strong>log10 units for PFU/CFU; ordinary OD units for OD</strong>.
      In the optional column, use <code>none</code> for a quantified observation or <code>left</code> for a PFU/CFU concentration below a known positive detection limit.
      For example, <code>10,PFU,100,.1,left</code> means below 100 PFU/mL with log10 SD 0.1; it does not mean 100 PFU/mL was observed.
      Supply the assay limit in <code>value</code>; zero, missing values, OD censoring and unknown limits are unsupported. Replicate rows are retained.
      Limits: 6–256 observations, at least three times, 0–180 minutes.</p>
    <form onSubmit={event => {
      event.preventDefault();
      if (!accepted || !confirmed || busy) return;
      void perform({ kind:'fit', dataset:{ ...accepted.dataset, conditions:numeric(conditions) }, options });
    }}>
      <fieldset disabled={busy} style={{ display:'grid', gap:'.6rem' }}>
        <legend>Fixed experimental conditions — defaults are not measurements</legend>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(210px,1fr))', gap:'.75rem' }}>
          {CONDITIONS.map(({key,label,min,max,step}) => <label key={key}>{label}<input type="number" min={min} max={max} step={step} required style={inputStyle}
            value={conditions[key]} onChange={e => { setConditions({...conditions,[key]:e.target.value}); setConfirmed(false); }} /></label>)}
        </div>
        <p>Initially infected cells are zero. The stage count fixes an Erlang infection-to-lysis distribution; the fitted time is its mean, not the onset of a fixed-delay burst.
          No nutrient limitation, resistance, infected-cell adsorption or OD contribution from debris is modeled.</p>
      </fieldset>
      <fieldset disabled={busy} style={{ display:'grid', gap:'.6rem' }}>
        <legend>Fit selection and starting values</legend>
        {GROWTH_PARAMETERS.map(key => <div key={key}>
          <label>{LABELS[key]}<input type="number" required min={GROWTH_BOUNDS[key][0]} max={GROWTH_BOUNDS[key][1]} step="any" style={inputStyle}
            value={initial[key]} onChange={event => setInitial({...initial,[key]:event.target.value})} /></label>
          <label><input type="checkbox" checked={free.includes(key)} onChange={event => setFree(event.target.checked ? [...free,key] : free.filter(k=>k!==key))} /> Estimate {key}; unchecked means fixed, not inferred</label>
        </div>)}
        <label>Fit initialization seed<input type="number" required min={0} max={0xffffffff} step={1} value={seed} style={inputStyle} onChange={e=>setSeed(e.target.value)} /></label>
        <label>Optimizer starts<input type="number" required min={1} max={5} step={1} value={starts} style={inputStyle} onChange={e=>setStarts(e.target.value)} /></label>
        <label>Maximum iterations per start<input type="number" required min={10} max={160} step={1} value={iterations} style={inputStyle} onChange={e=>setIterations(e.target.value)} /></label>
        <label><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)} /> I have checked the fixed conditions, measurement definitions and supplied observation SDs.</label>
        <button type="submit" disabled={!accepted || !confirmed || free.length===0}>Fit experimental growth data</button>
      </fieldset>
    </form>
    <button type="button" disabled={!busy} onClick={cancel}>Cancel growth work</button>
    <p role="status" data-testid="growth-status">{status}</p>
    {error && <p role="alert">{error}</p>}
    {accepted && <>
      <p data-testid="growth-source">{accepted.dataset.source.kind === 'demo' ? 'SYNTHETIC DATA' : 'USER-SUPPLIED DATA — not independently verified'}: {accepted.dataset.name}.
        {' '}{accepted.dataset.observations.length} observations. {accepted.dataset.source.reference ?? 'No source reference supplied.'}</p>
      {changed && <p>Draft settings differ from the accepted dataset/fit. Existing plots and exports retain the last accepted inputs and settings.</p>}
      <div style={{display:'flex',gap:'.5rem',flexWrap:'wrap'}}>
        <button type="button" disabled={busy} onClick={()=>downloadString(JSON.stringify(accepted.dataset,null,2),'growth-data.json','application/json')}>Export accepted growth dataset</button>
        <button type="button" disabled={busy || !accepted.record} onClick={()=>{
          try { if(accepted.record) downloadString(serializeAnalysisRecord(accepted.record),'growth-fit.json','application/json'); }
          catch(cause) { setError(cause instanceof Error?cause.message:String(cause)); }
        }}>Export accepted growth fit</button>
      </div>
    </>}
    {result && accepted?.record && <section data-testid="growth-result" data-result-id={accepted.record.resultId}>
      <h4>Conditional fit, not a validated biological phenotype</h4>
      <p>{result.converged?'Optimizer converged':'Optimizer did NOT converge'}: {result.termination}.
        {' '}{result.censoring ? 'Likelihood objective (minus twice log likelihood, up to fixed constants)' : 'Weighted residual sum of squares'}: {result.objective.toPrecision(6)};
        {' '}{result.censoring ? 'observations minus fitted parameters' : 'residual degrees of freedom'}: {result.degreesOfFreedom}.
        {' '}Sensitivity rank: {result.sensitivityRank}/{accepted.options.freeParameters.length}; condition: {result.sensitivityCondition?.toPrecision(4)??'rank deficient'}.
        {' '}Numerical cross-check: {result.solverDiscrepancySigma.toPrecision(3)} {result.censoring ? 'likelihood-residual units' : 'observation SD'}.</p>
      {result.censoring && <p data-testid="growth-censoring-summary">{result.censoring.censoredObservations} left-censored observations and {result.censoring.quantifiedObservations} quantified observations.
        {' '}Quantified residual sum of squares: {result.censoring.quantifiedResidualSumSquares.toPrecision(6)};
        {' '}quantified support rank: {result.censoring.quantifiedSensitivityRank}/{accepted.options.freeParameters.length}.
        {' '}No exact residual or local Wald interval is assigned to a detection limit. The mixed objective has no residual chi-square calibration here.</p>}
      <table aria-label="Growth parameter inference"><thead><tr><th>Parameter</th><th>Candidate/fixed value</th><th>Local 95% interval</th><th>Status and limits</th></tr></thead>
        <tbody>{GROWTH_PARAMETERS.map(key=><tr key={key} data-testid={`growth-${key}`}><th>{LABELS[key]}</th><td>{result.estimates[key].value.toPrecision(6)}</td>
          <td>{result.estimates[key].interval95?.map(v=>v.toPrecision(6)).join(' – ')??'Unavailable / not estimated'}</td>
          <td>{result.estimates[key].status}: {result.estimates[key].reason}</td></tr>)}</tbody></table>
      <label htmlFor={`${id}-measurement`}>Displayed growth measurement</label>
      <select id={`${id}-measurement`} value={measurement} onChange={event=>setMeasurement(event.target.value as GrowthMeasurement)}>
        {(['PFU','CFU','OD'] as const).map(type=><option key={type}>{type}</option>)}
      </select>
      <GrowthPlot accepted={accepted} measurement={measurement} />
      <div style={{overflowX:'auto'}}><table aria-label="Growth observations and residuals"><thead><tr><th>Minutes</th><th>Type</th><th>Observed / limit</th><th>Predicted</th><th>Residual / SD</th>{result.censoring && <th>Censoring deviance (−2 log probability)</th>}</tr></thead>
        <tbody>{result.residuals.filter(row=>row.type===measurement).map((row,i)=><tr key={i}><td>{row.timeMin}</td><td>{row.type}</td><td>{row.censoring === 'left' ? `< ${row.value.toPrecision(6)} (limit)` : row.value.toPrecision(6)}</td>
          <td>{row.predicted.toPrecision(6)}</td><td>{row.standardizedResidual?.toPrecision(5) ?? 'Not observed'}</td>
          {result.censoring && <td>{row.likelihoodDeviance?.toPrecision(6) ?? '—'}</td>}</tr>)}</tbody></table></div>
      {result.warnings.map(warning=><p key={warning}>{warning}</p>)}
      <fieldset disabled={busy}>
        <legend>Profile likelihood of the accepted fit</legend>
        <p>Use the last accepted observations and fit settings, not unsubmitted edits. The other estimated parameters are reoptimized at every candidate.
          Local intervals above are approximations; this separate diagnostic can expose parameter tradeoffs and unsupported confidence limits.</p>
        <label htmlFor={`${id}-profile`}>Profile parameter</label>
        <select id={`${id}-profile`} value={profileParameter} onChange={event=>setProfileParameter(event.target.value as GrowthParameter)}>
          {accepted.options.freeParameters.map(key=><option key={key} value={key}>{LABELS[key]}</option>)}
        </select>
        <button type="button" onClick={()=>void perform({kind:'profile',dataset:accepted.dataset,options:accepted.options,
          parameter:profileParameter,baselineResultId:accepted.record!.resultId})}>Compute profile likelihood</button>
      </fieldset>
      {accepted.profile && accepted.profileRecord && <div data-testid="growth-profile" data-result-id={accepted.profileRecord.resultId}>
        <ProfileDetails profile={accepted.profile} />
        <button type="button" disabled={busy} onClick={()=>{
          try { downloadString(serializeAnalysisRecord(accepted.profileRecord!),'growth-profile.json','application/json'); }
          catch(cause) { setError(cause instanceof Error?cause.message:String(cause)); }
        }}>Export growth profile</button>
        <AnalysisRecordDetails record={accepted.profileRecord} />
      </div>}
      <AnalysisRecordDetails record={accepted.record} />
    </section>}
  </section>;
}

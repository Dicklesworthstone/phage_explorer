import React, { useEffect, useId, useRef, useState } from 'react';
import { DEFAULT_GROWTH_CONDITIONS, GROWTH_BOUNDS, GROWTH_PARAMETERS, resolveGrowthOptions,
  type GrowthConditions, type GrowthParameter, type GrowthMeasurement, type GrowthFitOptions } from '../../../../core/src/analysis/growth-inference';
import { serializeAnalysisRecord } from '../../../../core/src/analysis-result';
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
      {rows.map((row,i) => <circle key={i} cx={x(row.timeMin)} cy={y(row.value)} r={4} fill={theme.colors.accent}>
        <title>{`${row.timeMin} min: observed ${row.value}, predicted ${row.predicted}`}</title>
      </circle>)}
      <text x={60} y={250} fill={theme.colors.text}>0 min</text><text x={590} y={250} fill={theme.colors.text}>{end} min</text>
      <text x={2} y={35} fill={theme.colors.text} fontSize={11}>{high.toPrecision(4)}</text>
      <text x={2} y={225} fill={theme.colors.text} fontSize={11}>{low.toPrecision(4)}</text>
    </svg>
    <figcaption>Points: supplied observations. Line: fitted mechanistic model. {measurement === 'OD' ? 'Linear OD600 axis.' : `log10 ${measurement}/mL axis.`} Numerical values and standardized residuals are tabulated below.</figcaption>
  </figure>;
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
      setFree(result.options.freeParameters); setSeed(String(result.options.seed));
      setStarts(String(result.options.starts)); setIterations(String(result.options.maxIterations));
      setMeasurement(result.dataset.observations[0].type);
      setConfirmed(result.result !== null);
      setStatus(result.verified ? 'Verified: fresh fit and complete result identity match the saved experiment.'
        : result.result ? 'Fit finished. Check identifiability, convergence and residuals before interpreting parameters.' : 'Data loaded. Confirm conditions, select parameters and run the fit.');
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
    <p>CSV/TSV header: <code>timeMin,type,value,sigma</code>. Each row is PFU/mL, CFU/mL, or OD600.
      Supply known measurement SD: <strong>log10 units for PFU/CFU; ordinary OD units for OD</strong>.
      Positive quantified counts only; detection-limit zeros and censored measurements are not supported. Replicate rows are retained.
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
        {' '}Weighted residual sum of squares: {result.objective.toPrecision(6)}; residual degrees of freedom: {result.degreesOfFreedom}.
        {' '}Sensitivity rank: {result.sensitivityRank}/{accepted.options.freeParameters.length}; condition: {result.sensitivityCondition?.toPrecision(4)??'rank deficient'}.
        {' '}Numerical cross-check: {result.solverDiscrepancySigma.toPrecision(3)} observation SD.</p>
      <table aria-label="Growth parameter inference"><thead><tr><th>Parameter</th><th>Candidate/fixed value</th><th>Local 95% interval</th><th>Status and limits</th></tr></thead>
        <tbody>{GROWTH_PARAMETERS.map(key=><tr key={key} data-testid={`growth-${key}`}><th>{LABELS[key]}</th><td>{result.estimates[key].value.toPrecision(6)}</td>
          <td>{result.estimates[key].interval95?.map(v=>v.toPrecision(6)).join(' – ')??'Unavailable / not estimated'}</td>
          <td>{result.estimates[key].status}: {result.estimates[key].reason}</td></tr>)}</tbody></table>
      <label htmlFor={`${id}-measurement`}>Displayed growth measurement</label>
      <select id={`${id}-measurement`} value={measurement} onChange={event=>setMeasurement(event.target.value as GrowthMeasurement)}>
        {(['PFU','CFU','OD'] as const).map(type=><option key={type}>{type}</option>)}
      </select>
      <GrowthPlot accepted={accepted} measurement={measurement} />
      <div style={{overflowX:'auto'}}><table aria-label="Growth observations and residuals"><thead><tr><th>Minutes</th><th>Type</th><th>Observed</th><th>Predicted</th><th>Residual / SD</th></tr></thead>
        <tbody>{result.residuals.filter(row=>row.type===measurement).map((row,i)=><tr key={i}><td>{row.timeMin}</td><td>{row.type}</td><td>{row.value.toPrecision(6)}</td>
          <td>{row.predicted.toPrecision(6)}</td><td>{row.standardizedResidual.toPrecision(5)}</td></tr>)}</tbody></table></div>
      {result.warnings.map(warning=><p key={warning}>{warning}</p>)}
      <AnalysisRecordDetails record={accepted.record} />
    </section>}
  </section>;
}

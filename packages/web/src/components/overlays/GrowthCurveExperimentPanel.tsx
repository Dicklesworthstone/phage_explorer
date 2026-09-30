/** Measured-data workflow; deliberately separate from illustrative simulations. */
import React, { useEffect, useId, useRef, useState } from 'react';
import {
  GROWTH_CURVE_LIMITS, GROWTH_CURVE_METHOD, fitOneStepGrowth,
  parseGrowthCurveCSV, parseGrowthCurveExperiment, serializeGrowthCurveExperiment,
  type GrowthCurveExperiment, type GrowthCurveFit, type GrowthEstimates,
} from '@phage-explorer/core';
import { useTheme } from '../../hooks/useTheme';

interface Draft {
  title: string;
  source: string;
  kind: 'user-supplied' | 'synthetic';
  csv: string;
  centers: string;
  bootstrap: string;
  seed: string;
  extracellular: boolean;
}
interface Completed { experiment: GrowthCurveExperiment; fit: GrowthCurveFit }
const STORAGE_KEY = 'phage-explorer:extracellular-growth-draft:v1';
const EMPTY_DRAFT: Draft = { title: '', source: '', kind: 'user-supplied', csv: 'time_min,pfu_per_ml\n', centers: '', bootstrap: '100', seed: '1', extracellular: false };

function restoreDraft(): Draft {
  try {
    if (typeof window === 'undefined') return { ...EMPTY_DRAFT };
    const text = window.sessionStorage.getItem(STORAGE_KEY);
    if (!text || text.length > GROWTH_CURVE_LIMITS.bytes) return { ...EMPTY_DRAFT };
    const saved: unknown = JSON.parse(text);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return { ...EMPTY_DRAFT };
    const value = saved as Record<string, unknown>;
    if (!['title', 'source', 'csv', 'centers', 'bootstrap', 'seed'].every(key => typeof value[key] === 'string') ||
        (value.kind !== 'user-supplied' && value.kind !== 'synthetic') || typeof value.extracellular !== 'boolean') return { ...EMPTY_DRAFT };
    return { title: value.title as string, source: value.source as string, csv: value.csv as string,
      centers: value.centers as string, bootstrap: value.bootstrap as string, seed: value.seed as string,
      kind: value.kind, extracellular: value.extracellular };
  } catch { return { ...EMPTY_DRAFT }; }
}

function draftFor(experiment: GrowthCurveExperiment): Draft {
  return { title: experiment.title, source: experiment.provenance.source, kind: experiment.provenance.kind,
    csv: 'time_min,pfu_per_ml\n' + experiment.observations.map(row => `${row.timeMin},${row.pfuPerMl}`).join('\n'),
    centers: experiment.options.infectedCentersPerMl === null ? '' : String(experiment.options.infectedCentersPerMl),
    bootstrap: String(experiment.options.bootstrapSamples), seed: String(experiment.options.seed), extracellular: true };
}

function displayNumber(value: number | null): string {
  if (value === null) return 'Not identified / not supplied';
  if (value === 0) return '0';
  return Math.abs(value) >= 1e5 || Math.abs(value) < 0.001 ? value.toExponential(3) : Number(value.toPrecision(5)).toString();
}

function download(text: string, filename: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename;
  document.body.appendChild(anchor);
  try { anchor.click(); } finally { anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

function GrowthChart({ fit, residuals = false }: { fit: GrowthCurveFit; residuals?: boolean }): React.ReactElement {
  const { theme } = useTheme();
  const colors = theme.colors;
  const id = useId();
  const first = fit.fitted[0].timeMin;
  const last = fit.fitted[fit.fitted.length - 1].timeMin;
  const max = Math.max(...fit.fitted.map(row => residuals ? Math.abs(row.residualPFUPerMl) : Math.max(row.pfuPerMl, row.predictedPFUPerMl))) || 1;
  const x = (time: number) => 64 + (time - first) / (last - first) * 550;
  const y = (value: number) => residuals ? 118 - value / max * 86 : 204 - value / max * 172;
  return (
    <svg viewBox="0 0 640 248" role="img" aria-labelledby={id} style={{ width: '100%', display: 'block', color: colors.text }}>
      <title id={id}>{residuals ? 'Residuals in PFU/mL against sampling time' : 'Observed extracellular PFU/mL (circles) and fitted curve (line)'}</title>
      <path d="M64 24 V204 H614" stroke={colors.textMuted} fill="none" />
      <line x1={64} x2={614} y1={y(0)} y2={y(0)} stroke={colors.textMuted} strokeDasharray="4 4" />
      {[0, 0.5, 1].map(fraction => {
        const value = residuals ? (fraction * 2 - 1) * max : fraction * max;
        return <text key={fraction} x={59} y={y(value) + 4} textAnchor="end" fill="currentColor" fontSize={10}>{displayNumber(value)}</text>;
      })}
      {[0, 0.25, 0.5, 0.75, 1].map(fraction => (
        <text key={fraction} x={x(first + (last - first) * fraction)} y={222} textAnchor="middle" fill="currentColor" fontSize={11}>{displayNumber(first + (last - first) * fraction)}</text>
      ))}
      <text x={339} y={242} textAnchor="middle" fill="currentColor" fontSize={11}>Time (minutes)</text>
      <text x={64} y={15} fill="currentColor" fontSize={11}>{residuals ? 'Residual PFU/mL' : 'Extracellular PFU/mL — linear scale'}</text>
      {!residuals && <polyline points={fit.fitted.map(row => `${x(row.timeMin)},${y(row.predictedPFUPerMl)}`).join(' ')} fill="none" stroke={colors.accent} strokeWidth={2} />}
      {fit.fitted.map((row, index) => (
        <circle key={index} cx={x(row.timeMin)} cy={y(residuals ? row.residualPFUPerMl : row.pfuPerMl)} r={3} fill={colors.text} opacity={0.75}>
          <title>{`${row.timeMin} min; observed ${row.pfuPerMl}; predicted ${row.predictedPFUPerMl}; residual ${row.residualPFUPerMl} PFU/mL`}</title>
        </circle>
      ))}
    </svg>
  );
}

const METRICS: Array<[keyof GrowthEstimates, string]> = [
  ['baselinePFUPerMl', 'Baseline (PFU/mL)'], ['plateauPFUPerMl', 'Plateau (PFU/mL)'],
  ['increasePFUPerMl', 'Net extracellular increase (PFU/mL)'], ['riseStartMin', 'Population rise start (min)'],
  ['riseEndMin', 'Population rise end (min)'], ['infectiousYieldPerInfectedCenter', 'Net infectious yield per measured infected center'],
];

export function GrowthCurveExperimentPanel(): React.ReactElement {
  const { theme } = useTheme();
  const colors = theme.colors;
  const id = useId();
  const [draft, setDraft] = useState<Draft>(restoreDraft);
  const [completed, setCompleted] = useState<Completed | null>(null);
  const [reference, setReference] = useState<Completed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState(false);
  const [loading, setLoading] = useState(false);
  const revision = useRef(0);
  useEffect(() => () => { revision.current++; }, []);
  useEffect(() => {
    try { window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draft)); setStorageError(false); }
    catch { setStorageError(true); }
  }, [draft]);

  const invalidate = () => { revision.current++; setCompleted(null); setError(null); setLoading(false); };
  const edit = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    invalidate(); setDraft(previous => ({ ...previous, [key]: value }));
  };
  const report = (problem: unknown) => setError(problem instanceof Error ? problem.message : 'Unable to analyze this experiment.');

  const fitDraft = (event: React.FormEvent) => {
    event.preventDefault(); invalidate();
    try {
      if (!draft.extracellular) throw new Error('Confirm that the measurements are extracellular free-phage PFU/mL, not total infective-center titers.');
      if (!draft.seed.trim() || !draft.bootstrap.trim()) throw new Error('Provide a seed and bootstrap count; blank is not zero.');
      const centers = draft.centers.trim() ? Number(draft.centers) : null;
      if (centers !== null && (!Number.isFinite(centers) || centers <= 0)) throw new Error('Infected centers must be a positive measured concentration, or blank.');
      const experiment = parseGrowthCurveExperiment(JSON.stringify({
        schemaVersion: 'one-step-growth-v1', method: GROWTH_CURVE_METHOD, measurement: 'extracellular-pfu-per-ml',
        title: draft.title, provenance: { kind: draft.kind, source: draft.source }, observations: parseGrowthCurveCSV(draft.csv),
        options: { infectedCentersPerMl: centers,
          bootstrapSamples: Number(draft.bootstrap), seed: Number(draft.seed) },
      }));
      setCompleted({ experiment, fit: fitOneStepGrowth(experiment.observations, experiment.options) });
    } catch (problem) { report(problem); }
  };

  const importFile = async (file: File) => {
    invalidate(); const request = revision.current; setLoading(true);
    try {
      if (file.size > GROWTH_CURVE_LIMITS.bytes) throw new Error('Maximum import size is 1 MB.');
      const text = await file.text();
      if (request !== revision.current) return;
      if (/\.json$/i.test(file.name) || text.trimStart().startsWith('{')) {
        const experiment = parseGrowthCurveExperiment(text);
        const fit = fitOneStepGrowth(experiment.observations, experiment.options);
        setDraft(draftFor(experiment)); setCompleted({ experiment, fit });
      } else {
        parseGrowthCurveCSV(text);
        setDraft({ ...EMPTY_DRAFT, title: file.name.slice(0, 200), source: `User-supplied file: ${file.name}`.slice(0, 2000), csv: text });
      }
    } catch (problem) { if (request === revision.current) report(problem); }
    finally { if (request === revision.current) setLoading(false); }
  };

  const example = () => {
    invalidate();
    setDraft(draftFor({ schemaVersion: 'one-step-growth-v1', method: GROWTH_CURVE_METHOD, measurement: 'extracellular-pfu-per-ml',
      title: 'Synthetic ramp — not measured phage data', provenance: { kind: 'synthetic', source: 'Generated baseline/ramp/plateau example. Both PFU values and infected-center denominator are synthetic.' },
      observations: Array.from({ length: 11 }, (_, i) => ({ timeMin: i * 5, pfuPerMl: 10000 + 100000 * Math.max(0, Math.min(1, (i * 5 - 15) / 15)) })),
      options: { infectedCentersPerMl: 2000, bootstrapSamples: 100, seed: 1 } }));
  };
  const exportJSON = () => {
    if (!completed) return;
    try { download(serializeGrowthCurveExperiment(completed.experiment), 'extracellular-growth-experiment.json', 'application/json'); }
    catch (problem) { report(problem); }
  };
  const exportResiduals = () => {
    if (!completed) return;
    try {
      const csv = 'time_min,observed_pfu_per_ml,predicted_pfu_per_ml,residual_pfu_per_ml\n' + completed.fit.fitted.map(row => `${row.timeMin},${row.pfuPerMl},${row.predictedPFUPerMl},${row.residualPFUPerMl}`).join('\n');
      download(csv, 'extracellular-growth-residuals.csv', 'text/csv');
    } catch (problem) { report(problem); }
  };
  const control: React.CSSProperties = { width: '100%', boxSizing: 'border-box', minHeight: 44, padding: '0.5rem', color: colors.text, background: colors.background, border: `1px solid ${colors.borderLight}`, borderRadius: 4 };
  const button: React.CSSProperties = { ...control, width: 'auto', cursor: 'pointer' };
  const label: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.25rem' };

  return (
    <section aria-labelledby={`${id}-heading`} style={{ padding: '1rem', color: colors.text, minWidth: 0 }} onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation(); }}>
      <h3 id={`${id}-heading`}>Measured extracellular growth curves</h3>
      <p>Import your own free-phage PFU/mL observations or reload an exported experiment. Fits describe the population curve; they do not establish biological latency, adsorption, or single-cell burst size.</p>
      <p style={{ color: colors.textMuted }}>Data stay in this browser. Drafts are retained in this tab when storage is available; export JSON for durable, reproducible records. Saved results are recomputed on import.</p>
      {storageError && <p role="status">Browser draft storage is unavailable. Export before leaving to avoid losing your inputs.</p>}
      <form onSubmit={fitDraft}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' }}>
          <label style={label}>Import CSV, TSV, or experiment JSON (up to 1 MB)
            <input type="file" accept=".csv,.tsv,.json,text/csv,text/tab-separated-values,application/json" style={control} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void importFile(file); }} />
          </label>
          <button type="button" style={button} onClick={example}>Load clearly labeled synthetic example</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: '0.75rem', marginTop: '0.75rem' }}>
          <label style={label}>Experiment title<input style={control} value={draft.title} maxLength={200} required onChange={event => edit('title', event.target.value)} /></label>
          <label style={label}>Data provenance<select style={control} value={draft.kind} onChange={event => edit('kind', event.target.value as Draft['kind'])}><option value="user-supplied">User supplied — not independently verified</option><option value="synthetic">Synthetic — not experimental evidence</option></select></label>
          <label style={label}>Source, assay context, and denominator measurement<input style={control} value={draft.source} maxLength={2000} required onChange={event => edit('source', event.target.value)} /></label>
          <label style={label}>Measured infected centers/mL (optional)<input style={control} inputMode="decimal" value={draft.centers} placeholder="Leave blank if unmeasured" onChange={event => edit('centers', event.target.value)} /></label>
          <label style={label}>Bootstrap samples (0, or 20–200)<input style={control} type="number" min={0} max={200} step={1} value={draft.bootstrap} required onChange={event => edit('bootstrap', event.target.value)} /></label>
          <label style={label}>Reproducible seed (0–4294967295)<input style={control} type="number" min={0} max={4294967295} step={1} value={draft.seed} required onChange={event => edit('seed', event.target.value)} /></label>
        </div>
        <label style={{ ...label, marginTop: '0.75rem' }}>Observations: time_min,pfu_per_ml
          <textarea rows={9} spellCheck={false} style={{ ...control, fontFamily: 'monospace' }} value={draft.csv} maxLength={GROWTH_CURVE_LIMITS.bytes} onChange={event => edit('csv', event.target.value)} aria-describedby={`${id}-format`} />
        </label>
        <p id={`${id}-format`} style={{ color: colors.textMuted }}>Minutes and dilution-corrected extracellular PFU/mL. Use 6–64 distinct times and up to 2,048 rows. Duplicate times are independent replicate observations; missing/censored values, OD, and total infective-center titers are not supported.</p>
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', minHeight: 44 }}><input type="checkbox" checked={draft.extracellular} onChange={event => edit('extracellular', event.target.checked)} />I confirm that these are extracellular free-phage measurements, not total infective-center counts.</label>
        <p style={{ color: colors.textMuted }}>Optional net yield is the fitted extracellular PFU/mL increase divided by independently measured infected centers/mL on the same concentration basis. Initial PFU and total host counts are not substitutes. Denominator uncertainty is not included.</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
          <button type="submit" style={button} disabled={loading}>Fit observations</button>
          <button type="button" style={button} disabled={!completed || loading} onClick={exportJSON}>Export replayable experiment JSON</button>
          <button type="button" style={button} disabled={!completed || loading} onClick={exportResiduals}>Export residuals CSV</button>
          <button type="button" style={button} disabled={!completed || loading} onClick={() => setReference(completed)}>Pin result for comparison</button>
          {reference && <button type="button" style={button} onClick={() => setReference(null)}>Clear comparison</button>}
        </div>
      </form>
      {reference && <p role="status">Comparison pinned: {reference.experiment.title} ({reference.experiment.provenance.kind}). Edit inputs or import another experiment, then fit to compare. Deltas are descriptive, not significance tests; export each experiment to retain both.</p>}
      {loading && <p role="status">Reading experiment file…</p>}
      {error && <p role="alert" style={{ color: colors.error }}>{error}</p>}
      {completed && <section aria-label="Growth-curve fit results">
        <h4>{completed.experiment.title}</h4>
        <p><strong>{completed.experiment.provenance.kind === 'synthetic' ? 'SYNTHETIC — NOT EXPERIMENTAL EVIDENCE' : 'USER-SUPPLIED OBSERVATIONS — NOT INDEPENDENTLY VERIFIED'}</strong></p>
        <p>{completed.experiment.provenance.source}</p>
        <GrowthChart fit={completed.fit} />
        <p>Circles: observations. Line: descriptive fit. R²: {displayNumber(completed.fit.rSquared)}. RMSE: {displayNumber(completed.fit.rmsePFUPerMl)} PFU/mL.</p>
        <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <caption style={{ textAlign: 'left', padding: '0.5rem 0' }}>Descriptive estimates and conditional 95% residual-bootstrap intervals</caption>
          <thead><tr><th scope="col" style={{ textAlign: 'left' }}>Quantity</th><th scope="col">Estimate</th><th scope="col">Interval</th>{reference && <><th scope="col">Pinned reference</th><th scope="col">Current − reference</th></>}</tr></thead>
          <tbody>{METRICS.map(([key, name]) => {
            const interval = completed.fit.intervals?.[key];
            const currentValue = completed.fit[key];
            const referenceValue = reference?.fit[key] ?? null;
            const delta = currentValue === null || referenceValue === null ? null : currentValue - referenceValue;
            return <tr key={key}><th scope="row" style={{ textAlign: 'left', padding: '0.5rem 0', borderTop: `1px solid ${colors.borderLight}` }}>{name}</th><td style={{ padding: '0.5rem' }}>{displayNumber(completed.fit[key])}</td><td style={{ padding: '0.5rem' }}>{interval ? `${displayNumber(interval[0])} – ${displayNumber(interval[1])}` : completed.fit.intervals ? 'Unavailable / unidentified' : 'Disabled'}</td>{reference && <><td style={{ padding: '0.5rem' }}>{displayNumber(referenceValue)}</td><td style={{ padding: '0.5rem' }}>{displayNumber(delta)}</td></>}</tr>;
          })}</tbody>
        </table></div>
        <details><summary style={{ cursor: 'pointer', padding: '0.75rem 0' }}>Inspect residuals</summary><GrowthChart fit={completed.fit} residuals /></details>
        <details open><summary style={{ cursor: 'pointer', padding: '0.75rem 0' }}>Assumptions and limitations</summary>{completed.fit.warnings.map(warning => <p key={warning}>{warning}</p>)}</details>
      </section>}
    </section>
  );
}

/** Measured inactivation is a preparation/condition-specific count experiment. */
import React, { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createInactivationTemplate, parseInactivationCSV, INACTIVATION_LIMITS,
  type InactivationInput, type InactivationFit } from '../../../../core/src/analysis/virion-stability';
import { GrowthExperimentSession, VIRION_INACTIVATION_MODEL, inactivationDraftContent,
  readPlaqueGrowthFile, type InactivationDraft, type AcceptedGrowth } from '../../workers/PlaqueGrowthSession';
import { downloadString } from '../../utils/export';
import { AnalysisRecordDetails } from './primitives/OverlayProvenance';

const EMPTY: InactivationDraft = {
  title: '', source: '', reference: '', license: '', kind: 'user-supplied',
  phageId: '', accession: '', batchId: '', temperatureC: '', buffer: '', pH: '', assayHost: '', description: '',
  csv: 'time_min,plaque_count,dilution_fraction,volume_ml\n', support: '3.84',
};
const numberText = (value: number | null): string => value === null ? 'Unavailable' : Number(value.toPrecision(6)).toString();
function draftFor(input: InactivationInput): InactivationDraft {
  return { title: input.title, source: input.provenance.source, reference: input.provenance.reference ?? '',
    license: input.provenance.license, kind: input.provenance.kind, ...input.preparation,
    accession: input.preparation.accession ?? '', ...input.conditions,
    temperatureC: String(input.conditions.temperatureC), pH: input.conditions.pH === null ? '' : String(input.conditions.pH),
    csv: input.csv, support: String(input.options.supportDeviance) };
}

function InactivationChart({ fit, residuals = false }: { fit: InactivationFit; residuals?: boolean }): React.ReactElement {
  const id = useId(), rows = fit.fitted;
  const first = fit.referenceTimeMin, span = fit.lastTimeMin - first;
  const observed = (row: typeof rows[number]) => row.count / (row.dilution * row.volumeMl);
  const maximum = Math.max(1, ...rows.map(row => residuals ? Math.abs(row.devianceResidual ?? 0)
    : Math.max(observed(row), row.predictedPFUPerMl ?? 0)));
  const x = (time: number) => span ? 85 + 485 * (time - first) / span : 327.5;
  const y = (value: number) => residuals ? 105 - 70 * value / maximum : 180 - 150 * value / maximum;
  return <svg viewBox="0 0 600 225" role="img" aria-labelledby={id} style={{ width: '100%', maxHeight: 320 }}>
    <title id={id}>{residuals ? 'Signed deviance residuals of individual plates' : 'Observed plaque counts divided by exposure and fitted infectious concentration'}</title>
    <path d="M85 25V180H570" fill="none" stroke="currentColor" />
    {residuals && <path d="M85 105H570" stroke="currentColor" strokeDasharray="4 4" />}
    {[0, 0.5, 1].map(f => {
      const value = residuals ? (2 * f - 1) * maximum : f * maximum;
      return <text key={f} x={80} y={y(value) + 4} fontSize={10} textAnchor="end" fill="currentColor">{numberText(value)}</text>;
    })}
    {(span ? [0, 0.5, 1] : [0.5]).map(f => <text key={f} x={85 + 485 * f} y={200} fontSize={11} textAnchor="middle" fill="currentColor">{numberText(first + span * f)}</text>)}
    <text x={325} y={220} fontSize={11} textAnchor="middle" fill="currentColor">Time (minutes)</text>
    <text x={85} y={16} fontSize={11} fill="currentColor">{residuals ? 'Signed deviance residual' : 'PFU/mL — linear display scale'}</text>
    {!residuals && fit.status !== 'unbounded-rate' && <polyline
      points={rows.map(row => x(row.timeMin) + ',' + y(row.predictedPFUPerMl)).join(' ')}
      fill="none" stroke="var(--color-primary, currentColor)" strokeWidth={2} />}
    {rows.map((row, index) => {
      const value = residuals ? row.devianceResidual : observed(row);
      if (value === null) return null;
      return <circle key={index} cx={x(row.timeMin)} cy={y(value)} r={3} fill="currentColor" opacity={0.75}>
        <title>{row.timeMin + ' min; count ' + row.count + '; exposure ' + row.dilution * row.volumeMl
          + ' mL; expected ' + numberText(row.expectedCount) + '; residual ' + numberText(row.devianceResidual)}</title>
      </circle>;
    })}
  </svg>;
}

export function VirionInactivationPanel(): React.ReactElement {
  const id = useId();
  const session = useMemo(() => new GrowthExperimentSession(() => new Worker(
    new URL('../../workers/plaque-growth.worker.ts', import.meta.url), { type: 'module' }), VIRION_INACTIVATION_MODEL), []);
  const { busy, phase, error, accepted } = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [draft, setDraft] = useState<InactivationDraft>({ ...EMPTY });
  const [dirty, setDirty] = useState(false), [reading, setReading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null), [page, setPage] = useState(0);
  const reader = useRef<AbortController | null>(null), revision = useRef(0), exactInput = useRef<string | null>(null);
  useEffect(() => {
    session.activate();
    return () => { revision.current++; reader.current?.abort(); session.deactivate(); };
  }, [session]);
  const cancel = () => { revision.current++; reader.current?.abort(); reader.current = null; setReading(false); session.cancel(); };
  const edit = <K extends keyof InactivationDraft>(key: K, value: InactivationDraft[K]) => {
    cancel(); exactInput.current = null; setDraft(previous => ({ ...previous, [key]: value })); setDirty(true); setLocalError(null);
  };
  const run = async (type: 'fit' | 'replay', source: string | ((signal: AbortSignal) => Promise<string>)) => {
    cancel(); const generation = revision.current; setLocalError(null);
    if (await session.run(type, source) && revision.current === generation) {
      const result = session.getSnapshot().accepted!;
      setDraft(draftFor(result.input)); exactInput.current = result.inputText; setDirty(false); setPage(0);
    }
  };
  const loadCsv = async (file: File) => {
    cancel(); const owner = new AbortController(); reader.current = owner; setReading(true); setLocalError(null);
    try {
      const csv = await readPlaqueGrowthFile(file, INACTIVATION_LIMITS.bytes, owner.signal);
      parseInactivationCSV(csv);
      if (reader.current !== owner || owner.signal.aborted) return;
      exactInput.current = null; setDraft(previous => ({ ...previous, csv })); setDirty(true);
    } catch (cause) { if (!owner.signal.aborted) setLocalError(cause instanceof Error ? cause.message : 'Could not read plate CSV.'); }
    finally { if (reader.current === owner) { reader.current = null; setReading(false); } }
  };
  const save = (text: string, filename: string, mime: string) => {
    try { downloadString(text, filename, mime); setLocalError(null); }
    catch (cause) { setLocalError(cause instanceof Error ? cause.message : 'Download failed.'); }
  };
  const example = () => {
    cancel(); exactInput.current = null; setLocalError(null); setDirty(true);
    setDraft(draftFor(createInactivationTemplate()));
  };
  const locked = busy || reading;
  const control: React.CSSProperties = { width: '100%', minHeight: 44, boxSizing: 'border-box', padding: '.5rem',
    background: 'var(--color-background)', color: 'inherit', border: '1px solid var(--color-border)', borderRadius: 4 };
  const grid: React.CSSProperties = { display: 'grid', gap: '.5rem' };
  return <section aria-labelledby={id + '-title'} style={{ ...grid, overflowWrap: 'anywhere' }}>
    <h3 id={id + '-title'}>Measured virion inactivation</h3>
    <p>Fit loss of infectious concentration over time from exact plaque counts, dilution fractions and plated volumes.
      Each experiment describes one phage preparation at one fixed temperature and buffer condition.
      The fitted nonnegative decay rate is conditional on an exponential Poisson count model.</p>
    <p>Import CSV to review its metadata, or fit a complete input JSON. Inputs stay in session memory; export before closing.
      Input, evidence and TSV downloads retain private measurements and experimental context.</p>
    <div style={grid}>
      <label>Load inactivation plate CSV/TSV for review (up to 1 MB)<input type="file" style={control}
        accept=".csv,.tsv,text/csv,text/tab-separated-values" disabled={locked} onChange={e => {
          const file = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (file) void loadCsv(file);
        }} /></label>
      <label>Fit inactivation input JSON (up to 1 MB)<input type="file" style={control}
        accept=".json,application/json" disabled={locked} onChange={e => {
          const file = e.currentTarget.files?.[0]; e.currentTarget.value = '';
          if (file) void run('fit', signal => readPlaqueGrowthFile(file, INACTIVATION_LIMITS.bytes, signal));
        }} /></label>
      <label>Restore and verify inactivation evidence JSON (up to 10 MiB)<input type="file" style={control}
        accept=".json,application/json" disabled={locked} onChange={e => {
          const file = e.currentTarget.files?.[0]; e.currentTarget.value = '';
          if (file) void run('replay', signal => readPlaqueGrowthFile(file, 10 * 1024 * 1024, signal));
        }} /></label>
    </div>
    <button type="button" disabled={locked} onClick={example}>Load synthetic inactivation example</button>
    <form onSubmit={event => {
      event.preventDefault(); setLocalError(null);
      try { void run('fit', exactInput.current ?? inactivationDraftContent(draft)); }
      catch (cause) { setLocalError(cause instanceof Error ? cause.message : 'Invalid inactivation draft.'); }
    }}><fieldset disabled={locked} style={grid}><legend>Preparation, fixed conditions and measured counts</legend>
      <label>Inactivation experiment title<input style={control} required maxLength={200} value={draft.title} onChange={e => edit('title', e.target.value)} /></label>
      <label>Inactivation data provenance<select style={control} value={draft.kind} onChange={e => edit('kind', e.target.value as InactivationDraft['kind'])}>
        <option value="user-supplied">User supplied — source not independently verified</option>
        <option value="synthetic">Synthetic — not empirical evidence</option>
      </select></label>
      <label>Measurement source and attribution<textarea style={control} required maxLength={2000} value={draft.source} onChange={e => edit('source', e.target.value)} /></label>
      <div style={{ ...grid, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        {([
          ['reference', 'Source reference (optional)', false], ['license', 'Source license or permission', true],
          ['phageId', 'Phage identity', true], ['accession', 'Phage accession (optional)', false],
          ['batchId', 'Preparation / batch identity', true], ['buffer', 'Buffer and composition', true],
          ['assayHost', 'Plaque assay host identity', true],
        ] as const).map(([key, label, required]) => <label key={key}>{label}<input style={control} required={required}
          maxLength={2000} value={draft[key]} onChange={e => edit(key, e.target.value)} /></label>)}
        <label>Measured temperature (°C)<input style={control} required inputMode="decimal" value={draft.temperatureC} onChange={e => edit('temperatureC', e.target.value)} /></label>
        <label>Measured pH (optional)<input style={control} inputMode="decimal" placeholder="Blank means unmeasured" value={draft.pH} onChange={e => edit('pH', e.target.value)} /></label>
      </div>
      <label>Exposure and assay context<textarea style={control} required maxLength={2000} value={draft.description} onChange={e => edit('description', e.target.value)} /></label>
      <label>Raw inactivation plate CSV<textarea rows={9} style={{ ...control, fontFamily: 'monospace' }} spellCheck={false}
        maxLength={INACTIVATION_LIMITS.bytes} value={draft.csv} onChange={e => edit('csv', e.target.value)} aria-describedby={id + '-format'} /></label>
      <p id={id + '-format'}>Columns: time_min,plaque_count,dilution_fraction,volume_ml. Dilution is a fraction such as 0.001.
        Supply exact integer counts, including zeros, with explicit plated mL. Maximum 2,048 plates.
        TNTC, count bounds, optical density and already corrected PFU/mL are unsupported here.
        Separate preparations or changing conditions require separate experiments.</p>
      <label>Inactivation likelihood support deviance cutoff<input style={control} required inputMode="decimal" value={draft.support} onChange={e => edit('support', e.target.value)} /></label>
      <p>The cutoff defines likelihood support; it is not a confidence percentage. Independent plates, known exposures and a constant exponential decay rate are assumptions.</p>
      <button type="submit">Fit measured inactivation</button>
    </fieldset></form>
    <button type="button" disabled={!locked} onClick={cancel}>Cancel inactivation work</button>
    <p role="status" aria-live="polite" data-testid="inactivation-status">{reading ? 'Reading inactivation plate CSV…' : phase}</p>
    {(localError || error) && <p role="alert">{localError ?? error}</p>}
    {accepted && <VirionInactivationResults accepted={accepted} dirty={dirty} page={page} onPage={setPage} locked={locked} save={save} />}
  </section>;
}

export function VirionInactivationResults({ accepted, dirty = false, page = 0, onPage, locked = false, save }: {
  accepted: AcceptedGrowth<InactivationInput>; dirty?: boolean; page?: number; onPage?: (page: number) => void; locked?: boolean;
  save: (text: string, filename: string, mime: string) => void;
}): React.ReactElement {
  const fit = accepted.record.fields.fit.value as unknown as InactivationFit;
  const grid: React.CSSProperties = { display: 'grid', gap: '.5rem' };
  return <section aria-label="Accepted measured inactivation" data-testid="inactivation-result"
      data-result-id={accepted.record.resultId} style={grid}>
      <h4>{accepted.input.title}</h4>
      <p><strong>{accepted.input.provenance.kind === 'synthetic' ? 'SYNTHETIC — NOT EMPIRICAL EVIDENCE' : 'USER-SUPPLIED — SOURCE NOT INDEPENDENTLY VERIFIED'}</strong></p>
      <p>{accepted.input.provenance.source}</p>
      <p>Phage: {accepted.input.preparation.phageId}; accession: {accepted.input.preparation.accession ?? 'unsupplied'};
        preparation: {accepted.input.preparation.batchId}; assay host: {accepted.input.conditions.assayHost}.</p>
      <p>Measured temperature: {accepted.input.conditions.temperatureC} °C; buffer: {accepted.input.conditions.buffer};
        pH: {accepted.input.conditions.pH ?? 'unmeasured'}. {accepted.input.conditions.description}</p>
      <p>{accepted.verifiedReplay ? 'Saved numerical evidence verified by fresh replay.' : 'Fresh fit; no saved numerical result was used as evidence.'}</p>
      {dirty && <p role="status">Draft edits are not applied. Results and exports still use the accepted measurements and conditions above.</p>}
      <p data-testid="inactivation-fit-status">Fit status: {fit.status}. {fit.reason}</p>
      <p>{fit.observations} plates; {fit.distinctTimes} distinct times; {fit.totalPlaques} total plaques.
        Observed time range: {numberText(fit.referenceTimeMin)}–{numberText(fit.lastTimeMin)} minutes.</p>
      <div style={{ overflowX: 'auto' }}><table aria-label="Measured inactivation estimates"><thead><tr><th scope="col">Quantity</th><th scope="col">Estimate</th></tr></thead><tbody>
        {([
          ['Reference concentration at first observed time (PFU/mL)', fit.referencePFUPerMl],
          ['Exponential decay rate (per minute)', fit.decayRatePerMin],
          ['Log10 loss per minute', fit.log10LossPerMin], ['Conditional half-life (minutes)', fit.halfLifeMin],
          ['Conditional one-log reduction time (minutes)', fit.oneLogReductionMin],
        ] as const).map(([label, value]) => <tr key={label}><th scope="row">{label}</th><td>{numberText(value)}</td></tr>)}
      </tbody></table></div>
      <p data-testid="inactivation-support">Rate likelihood support (per minute): [{numberText(fit.support.lowerRatePerMin)},{' '}
        {fit.support.upperRatePerMin === null ? '+∞)' : numberText(fit.support.upperRatePerMin) + ']'}.
        Cutoff: {fit.support.devianceCutoff}; lower endpoint: {fit.support.lowerStatus}; upper endpoint: {fit.support.upperStatus}.
        This is not a calibrated confidence interval.</p>
      <p>Half-life and one-log reduction times use the fitted exponential model at these measured conditions.
        They do not establish a storage recommendation, molecular capsid integrity, or behavior at another temperature or buffer.</p>
      <InactivationChart fit={fit} />
      <p>Points show count divided by dilution × plated volume. The fit uses each original count and exposure.
        Display values are not substituted for the Poisson observations. Fitted basis: {fit.fittedBasis}.
        {fit.status === 'unbounded-rate' && ' A finite-rate curve is unavailable; the table retains the limiting fit.'}</p>
      <details><summary>Inspect every plate and residual</summary>
        <InactivationChart fit={fit} residuals />
        <p>Deviance: {numberText(fit.deviance)}. Residuals describe this model; no calibrated goodness-of-fit test is claimed.</p>
        <p>Natural-log fitted values retain very small positive means. Log values are unavailable for exact or limiting zeros.</p>
        <p>Plates {page * 50 + 1}–{Math.min((page + 1) * 50, fit.fitted.length)} of {fit.fitted.length}. JSON and TSV include all plates.</p>
        <div style={{ overflowX: 'auto' }}><table aria-label="Inactivation plate observations and residuals">
          <thead><tr><th>Minute</th><th>Count</th><th>Dilution fraction</th><th>Plated mL</th><th>Fitted PFU/mL</th><th>Expected count</th><th>ln fitted PFU/mL</th><th>ln expected count</th><th>Deviance residual</th></tr></thead>
          <tbody>{fit.fitted.slice(page * 50, (page + 1) * 50).map((row, index) => <tr key={page * 50 + index} data-testid="inactivation-plate">
            {[row.timeMin, row.count, row.dilution, row.volumeMl, row.predictedPFUPerMl, row.expectedCount,
              row.logPredictedPFUPerMl, row.logExpectedCount, row.devianceResidual]
              .map((value, column) => <td key={column}>{numberText(value)}</td>)}
          </tr>)}</tbody>
        </table></div>
        <button type="button" disabled={page === 0} onClick={() => onPage?.(page - 1)}>Previous plates</button>{' '}
        <button type="button" disabled={(page + 1) * 50 >= fit.fitted.length} onClick={() => onPage?.(page + 1)}>Next plates</button>
      </details>
      {fit.warnings.length > 0 && <ul>{fit.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
        <button type="button" disabled={locked} onClick={() => save(accepted.inputText, 'inactivation-input.json', 'application/json')}>Export accepted inactivation input JSON</button>
        <button type="button" disabled={locked} onClick={() => save(accepted.json, 'inactivation-evidence.json', 'application/json')}>Export inactivation evidence JSON</button>
        <button type="button" disabled={locked} onClick={() => save(accepted.tsv, 'inactivation-plates.tsv', 'text/tab-separated-values')}>Export all inactivation plates TSV</button>
      </div>
      <AnalysisRecordDetails record={accepted.record} />
    </section>;
}

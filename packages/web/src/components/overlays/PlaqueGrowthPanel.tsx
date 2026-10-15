/** Raw-count experiments share the native numerical method, not the PFU/mL observation model. */
import React, { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { parsePlaqueGrowthCSV, PLAQUE_GROWTH_LIMITS, type PlaqueGrowthResult, type PlaqueGrowthInput } from '../../../../core/src/analysis/plaque-growth';
import { GrowthExperimentSession, PLAQUE_GROWTH_MODEL, plaqueGrowthDraftContent, readPlaqueGrowthFile, type PlaqueGrowthDraft } from '../../workers/PlaqueGrowthSession';
import { downloadString } from '../../utils/export';
import { AnalysisRecordDetails } from './primitives/OverlayProvenance';

const EMPTY: PlaqueGrowthDraft = { version: 1, title: '', source: '', kind: 'user-supplied',
  csv: 'time_min,plaque_count,dilution_fraction,volume_ml\n', centers: '', support: '3.84', extracellular: false };
const numberText = (value: number | null): string => value === null ? 'Unavailable' : Number(value.toPrecision(6)).toString();
const intervalsText = (ranges: Array<[number, number]> | null): string => ranges === null ? 'Unavailable'
  : ranges.map(([a, b]) => `[${numberText(a)}, ${numberText(b)}]`).join(' ∪ ');
function draftFor(input: PlaqueGrowthInput): PlaqueGrowthDraft {
  return { version: input.version, title: input.title, source: input.provenance.source, kind: input.provenance.kind, csv: input.csv,
    centers: input.options.infectedCentersPerMl === null ? '' : String(input.options.infectedCentersPerMl),
    support: String(input.options.supportDeviance), extracellular: true };
}

function PlateChart({ fit, residuals = false }: { fit: PlaqueGrowthResult; residuals?: boolean }): React.ReactElement {
  const id = useId(), rows = fit.fitted;
  const first = rows[0].timeMin, span = rows[rows.length - 1].timeMin - first;
  const observed = (row: typeof rows[number]) => row.count / (row.dilution * row.volumeMl);
  const maximum = Math.max(...rows.map(row => residuals ? Math.abs(row.devianceResidual ?? 0) : Math.max(observed(row), row.predictedPFUPerMl))) || 1;
  const x = (t: number) => 80 + 490 * (t - first) / span;
  const y = (v: number) => residuals ? 105 - 70 * v / maximum : 180 - 150 * v / maximum;
  return <svg viewBox="0 0 600 225" role="img" aria-labelledby={id} style={{ width: '100%', maxHeight: 320 }}>
    <title id={id}>{residuals ? 'Exact-plate deviance residuals; bound-plate residuals are unavailable' : 'Reported count or bound divided by exposure and fitted concentration by time'}</title>
    <path d="M80 25V180H570" fill="none" stroke="currentColor" />
    {residuals && <path d="M80 105H570" stroke="currentColor" strokeDasharray="4 4" />}
    {[0, 0.5, 1].map(f => {
      const value = residuals ? (2 * f - 1) * maximum : f * maximum;
      return <text key={f} x={75} y={y(value) + 4} fontSize={10} textAnchor="end" fill="currentColor">{numberText(value)}</text>;
    })}
    {[0, 0.5, 1].map(f => <text key={f} x={80 + 490 * f} y={200} fontSize={11} textAnchor="middle" fill="currentColor">{numberText(first + span * f)}</text>)}
    <text x={325} y={220} fontSize={11} textAnchor="middle" fill="currentColor">Time (minutes)</text>
    <text x={80} y={16} fontSize={11} fill="currentColor">{residuals ? 'Signed deviance residual' : 'PFU/mL — linear display scale'}</text>
    {!residuals && <polyline points={rows.map(row => `${x(row.timeMin)},${y(row.predictedPFUPerMl)}`).join(' ')} fill="none" stroke="var(--color-primary, currentColor)" strokeWidth={2} />}
    {rows.map((row, i) => {
      const status = 'countStatus' in row ? row.countStatus : 'exact';
      const value = residuals ? row.devianceResidual : observed(row);
      if (value === null) return null; // A bound is not an observed zero residual.
      const px = x(row.timeMin), py = y(value);
      return <g key={i} data-plate-status={status}>
        <title>{`${row.timeMin} min; ${status} ${row.count}; exposure ${row.dilution * row.volumeMl} mL; expected ${row.expectedCount}; residual ${numberText(row.devianceResidual)}`}</title>
        {status === 'exact' || residuals ? <circle cx={px} cy={py} r={3} fill="currentColor" opacity={0.7} />
          : <path aria-label={`${status} count bound`} d={status === 'at-most'
            ? `M${px - 4} ${py - 5}H${px + 4}L${px} ${py + 3}Z`
            : `M${px - 4} ${py + 5}H${px + 4}L${px} ${py - 3}Z`} fill="none" stroke="currentColor" />}
      </g>;
    })}
  </svg>;
}

export function PlaqueGrowthPanel(): React.ReactElement {
  const id = useId();
  const session = useMemo(() => new GrowthExperimentSession(() => new Worker(new URL('../../workers/plaque-growth.worker.ts', import.meta.url), { type: 'module' }), PLAQUE_GROWTH_MODEL), []);
  const { busy, phase, error, accepted } = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [draft, setDraft] = useState<PlaqueGrowthDraft>({ ...EMPTY });
  const [dirty, setDirty] = useState(false), [reading, setReading] = useState(false), [localError, setLocalError] = useState<string | null>(null);
  const reader = useRef<AbortController | null>(null), revision = useRef(0), exactInput = useRef<string | null>(null);
  useEffect(() => {
    session.activate();
    return () => { revision.current++; reader.current?.abort(); session.deactivate(); };
  }, [session]);
  const cancel = () => { revision.current++; reader.current?.abort(); reader.current = null; setReading(false); session.cancel(); };
  const edit = <K extends keyof PlaqueGrowthDraft>(key: K, value: PlaqueGrowthDraft[K]) => {
    cancel(); exactInput.current = null; setDraft(previous => ({ ...previous, [key]: value })); setDirty(true); setLocalError(null);
  };
  const run = async (type: 'fit' | 'replay', source: string | ((signal: AbortSignal) => Promise<string>)) => {
    cancel(); const generation = revision.current; setLocalError(null);
    if (await session.run(type, source) && revision.current === generation) {
      const result = session.getSnapshot().accepted!;
      setDraft(draftFor(result.input)); exactInput.current = result.inputText; setDirty(false);
    }
  };
  const loadCsv = async (file: File) => {
    const version = draft.version; // Bind the selected schema before an asynchronous read.
    cancel(); const owner = new AbortController(); reader.current = owner; setReading(true); setLocalError(null);
    try {
      const csv = await readPlaqueGrowthFile(file, PLAQUE_GROWTH_LIMITS.bytes, owner.signal);
      parsePlaqueGrowthCSV(csv, version);
      if (reader.current !== owner || owner.signal.aborted) return;
      exactInput.current = null;
      setDraft({ ...EMPTY, version, title: file.name.slice(0, 200), csv }); setDirty(true);
    } catch (cause) { if (!owner.signal.aborted) setLocalError(cause instanceof Error ? cause.message : 'Could not read plate CSV.'); }
    finally { if (reader.current === owner) { reader.current = null; setReading(false); } }
  };
  const save = (text: string, filename: string, mime: string) => {
    try { downloadString(text, filename, mime); setLocalError(null); }
    catch (cause) { setLocalError(cause instanceof Error ? cause.message : 'Download failed.'); }
  };
  const example = () => {
    const version = draft.version;
    cancel(); exactInput.current = null; setLocalError(null); setDirty(true);
    setDraft({ ...EMPTY, version, title: 'Synthetic plate counts — not empirical evidence', kind: 'synthetic', extracellular: true,
      source: version === 1 ? 'Hand-constructed background 10 and increase 100 PFU/mL, rise from 3 to 5 minutes. Not experimental data.'
        : 'Hand-constructed exact counts and inclusive bounds for format testing, not experimental observations or calibrated estimates.',
      csv: EMPTY.csv.trimEnd() + (version === 2 ? ',count_status' : '') + '\n'
        + Array.from({ length: 9 }, (_, time) => `${time},${10 + 100 * Math.max(0, Math.min(1, (time - 3) / 2))},1,1`
          + (version === 2 ? `,${time === 2 ? 'at-most' : time === 5 ? 'at-least' : 'exact'}` : '')).join('\n') + '\n' });
  };
  const fit = accepted?.record.fields.fit.value as unknown as PlaqueGrowthResult | undefined;
  const locked = busy || reading;
  const control: React.CSSProperties = { width: '100%', minHeight: 44, boxSizing: 'border-box', padding: '.5rem', background: 'var(--color-background)', color: 'inherit', border: '1px solid var(--color-border)', borderRadius: 4 };
  const rowStyle: React.CSSProperties = { display: 'grid', gap: '.4rem' };
  return <section aria-labelledby={`${id}-title`} style={{ display: 'grid', gap: '.75rem', marginBottom: '2rem', overflowWrap: 'anywhere' }}>
    <h3 id={`${id}-title`}>Raw plaque-count growth experiments</h3>
    <p>Fit integer extracellular plaque counts or explicit inclusive count bounds with their dilution fractions and plated volumes. This uses the same versioned Poisson exposure models as the terminal,
      not the equal-weight corrected-PFU fit below. It is descriptive, not a mechanistic estimate of adsorption or individual-cell latency.</p>
    <p>Raw inputs stay in session memory and are not automatically saved. Export before closing. JSON and TSV both contain private measurements; neither anonymizes them.</p>
    <div style={rowStyle}>
      <label>Plate CSV format<select style={control} value={draft.version} disabled={locked} onChange={e => edit('version', e.target.value === '2' ? 2 : 1)}>
        <option value={1}>Version 1 — exact counts (four columns)</option><option value={2}>Version 2 — exact counts and inclusive bounds (five columns)</option>
      </select></label>
      <p>Select the CSV format before loading. Switching format does not rewrite counts, infer thresholds, or change the accepted result. JSON carries its own explicit version.</p>
      <label>Load plate CSV/TSV for review (up to 1 MB)<input type="file" style={control} accept=".csv,.tsv,text/csv,text/tab-separated-values" disabled={locked} onChange={e => {
        const file = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (file) void loadCsv(file);
      }} /></label>
      <label>Fit plaque input JSON (up to 1 MB)<input type="file" style={control} accept=".json,application/json" disabled={locked} onChange={e => {
        const file = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (file) void run('fit', signal => readPlaqueGrowthFile(file, PLAQUE_GROWTH_LIMITS.bytes, signal));
      }} /></label>
      <label>Restore and verify plaque evidence JSON (up to 10 MiB)<input type="file" style={control} accept=".json,application/json" disabled={locked} onChange={e => {
        const file = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (file) void run('replay', signal => readPlaqueGrowthFile(file, 10 * 1024 * 1024, signal));
      }} /></label>
    </div>
    <button type="button" disabled={locked} onClick={example}>Load synthetic plate-count example</button>
    <form onSubmit={event => {
      event.preventDefault(); setLocalError(null);
      try { void run('fit', exactInput.current ?? plaqueGrowthDraftContent(draft)); }
      catch (cause) { setLocalError(cause instanceof Error ? cause.message : 'Invalid plate draft.'); }
    }}><fieldset disabled={locked} style={rowStyle}><legend>Raw plate inputs and explicit assumptions</legend>
      <label>Plate experiment title<input style={control} required maxLength={200} value={draft.title} onChange={e => edit('title', e.target.value)} /></label>
      <label>Plate data provenance<select style={control} value={draft.kind} onChange={e => edit('kind', e.target.value as PlaqueGrowthDraft['kind'])}>
        <option value="user-supplied">User supplied — not independently verified</option><option value="synthetic">Synthetic — not empirical evidence</option>
      </select></label>
      <label>Plate source and assay context<textarea style={control} required maxLength={2000} value={draft.source} onChange={e => edit('source', e.target.value)} /></label>
      <label>Raw plate CSV<textarea rows={9} style={{ ...control, fontFamily: 'monospace' }} spellCheck={false} maxLength={PLAQUE_GROWTH_LIMITS.bytes} value={draft.csv} onChange={e => edit('csv', e.target.value)} aria-describedby={`${id}-format`} /></label>
      <p id={`${id}-format`}>Columns: time_min,plaque_count,dilution_fraction,volume_ml{draft.version === 2 ? ',count_status' : ''}. Dilution is a fraction such as 0.001, not its reciprocal.
        Supply 6–32 distinct times and at most 2,048 plates. OD, PFU/mL rows and infective-center assays cannot be substituted.</p>
      <p>{draft.version === 1 ? 'Version 1 accepts uncensored integer counts including zero. Censored rows require explicit version 2.'
        : 'Version 2 requires exact (N=k), at-most (N≤k), or at-least (N≥k) for every row. Bounds are inclusive; a threshold is not a measured count. Bare TNTC or a guessed countability threshold is not supported. At least one exact or at-most observation at either of the last two times is required to bound every candidate plateau.'}</p>
      <label>Independent infected centers/mL (optional)<input style={control} inputMode="decimal" value={draft.centers} placeholder="Blank means yield unavailable" onChange={e => edit('centers', e.target.value)} /></label>
      <p>Only an independent infected-center concentration supplies the yield denominator. Initial PFU, MOI and total host concentration are not substitutes. Denominator uncertainty is not propagated.</p>
      <label>Likelihood support deviance cutoff<input style={control} type="number" required min={0.01} max={100} step="any" value={draft.support} onChange={e => edit('support', e.target.value)} /></label>
      <p>The cutoff defines a likelihood support set, not a calibrated confidence interval or confidence percentage. Separate supported ranges are retained.</p>
      <label><input type="checkbox" checked={draft.extracellular} onChange={e => edit('extracellular', e.target.checked)} /> I confirm extracellular free-phage counts and any explicitly recorded inclusive bounds.</label>
      <button type="submit">Fit raw plaque counts</button>
    </fieldset></form>
    <button type="button" disabled={!locked} onClick={cancel}>Cancel plate-count work</button>
    <p role="status" aria-live="polite" data-testid="plaque-growth-status">{reading ? 'Reading plate CSV…' : phase}</p>
    {(localError || error) && <p role="alert">{localError ?? error}</p>}
    {accepted && fit && <section aria-label="Accepted plaque-count fit" data-testid="plaque-growth-result" data-result-id={accepted.record.resultId} style={rowStyle}>
      <h4>{accepted.input.title}</h4>
      <p><strong>{accepted.input.provenance.kind === 'synthetic' ? 'SYNTHETIC — NOT EMPIRICAL EVIDENCE' : 'USER-SUPPLIED — SOURCE NOT INDEPENDENTLY VERIFIED'}</strong></p>
      <p>{accepted.input.provenance.source}</p>
      <p>{accepted.verifiedReplay ? 'Saved numerical evidence verified by fresh replay.' : 'Fresh fit; no prior result was used as evidence.'}</p>
      {dirty && <p role="status">Draft edits are not applied. Results and exports still use the accepted source and settings above.</p>}
      <p data-testid="plaque-timing-status">Timing: {fit.timingStatus}. {fit.timingStatus === 'unresolved' ? 'The constant curve remains supported; rise timing is unavailable.' : 'The rise is a sampled population-curve interval, not individual-cell latency.'}</p>
      <p>Accepted method version: {accepted.input.version}; cutoff: {fit.supportDeviance}. Plates: {fit.fitted.length}; total plaques: {numberText(fit.totalPlaques)}; candidate knot pairs: {fit.candidates}.</p>
      {'countCoverage' in fit && <p data-testid="plaque-count-coverage">Exact plates: {fit.countCoverage.exact}; upper-bound plates: {fit.countCoverage.atMost}; lower-bound plates: {fit.countCoverage.atLeast}.
        Known plaques from exact plates only: {fit.exactPlaques}. A total over bound plates is unavailable; thresholds are never added as observed counts.</p>}
      <div style={{ overflowX: 'auto' }}><table aria-label="Plaque-count fit estimates"><thead><tr><th scope="col">Quantity</th><th scope="col">Estimate</th></tr></thead><tbody>
        {([['Background PFU/mL', fit.backgroundPFUPerMl], ['Increase PFU/mL', fit.increasePFUPerMl], ['Plateau PFU/mL', fit.plateauPFUPerMl],
          ['Rise start (min)', fit.riseStartMin], ['Rise end (min)', fit.riseEndMin], ['Infectious yield per measured center', fit.infectiousYieldPerInfectedCenter]] as const)
          .map(([label, value]) => <tr key={label}><th scope="row">{label}</th><td>{numberText(value)}</td></tr>)}
      </tbody></table></div>
      <p>Increase likelihood support (PFU/mL): <span data-testid="plaque-increase-support">{intervalsText(fit.increaseSupport)}</span></p>
      <p>Yield likelihood support: {intervalsText(fit.yieldSupport)}. These ranges are not calibrated confidence intervals.</p>
      <PlateChart fit={fit} />
      <p>Circles are exact counts divided by exposure; downward/upward triangles are reported upper/lower count bounds divided by exposure, not confidence limits on concentration.
        The fitted line uses the count/bound likelihood, not least squares on those display ratios. Bound plates have no residual points.</p>
      <details><summary>Inspect plate residuals and exposures</summary><PlateChart fit={fit} residuals />
        <p>Deviance: {numberText(fit.deviance)}; constant-model deviance: {numberText(fit.constantDeviance)}. Preview: first {Math.min(50, fit.fitted.length)} plates; JSON and TSV retain all plates.</p>
        <p>For bound plates, the contribution is −2 log P(recorded event), not a squared observed residual. This mixed objective is not a calibrated goodness-of-fit test.</p>
        <div style={{ overflowX: 'auto' }}><table aria-label="Accepted plate counts and residuals"><thead><tr><th>Minute</th><th>Count / bound</th><th>Status</th><th>Dilution</th><th>Volume mL</th><th>Expected count</th><th>Deviance residual</th><th>Contribution</th></tr></thead>
          <tbody>{fit.fitted.slice(0, 50).map((row, i) => <tr key={i}>
            <td>{numberText(row.timeMin)}</td><td>{numberText(row.count)}</td><td>{'countStatus' in row ? row.countStatus : 'exact'}</td>
            {[row.dilution, row.volumeMl, row.expectedCount, row.devianceResidual,
              'devianceContribution' in row ? row.devianceContribution : row.devianceResidual ** 2].map((v, j) => <td key={j}>{numberText(v)}</td>)}
          </tr>)}</tbody>
        </table></div>
      </details>
      <details><summary>Inspect supported sampled-time knot pairs ({fit.knotSupport.length})</summary>
        <p>Conditional on the grid, model and cutoff. Null reported timing is not repaired by choosing a row from this list. JSON retains every pair.</p>
        <div style={{ overflowX: 'auto' }}><table aria-label="Supported plaque-growth knot pairs"><thead><tr><th>Start min</th><th>End min</th><th>Delta deviance</th></tr></thead>
          <tbody>{fit.knotSupport.map((row, i) => <tr key={i}><td>{row.startMin}</td><td>{row.endMin}</td><td>{numberText(row.deltaDeviance)}</td></tr>)}</tbody>
        </table></div>
      </details>
      <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
        <button type="button" disabled={locked} onClick={() => save(accepted.inputText, 'plaque-growth-input.json', 'application/json')}>Export accepted plate input JSON</button>
        <button type="button" disabled={locked} onClick={() => save(accepted.json, 'plaque-growth-evidence.json', 'application/json')}>Export plaque evidence JSON</button>
        <button type="button" disabled={locked} onClick={() => save(accepted.tsv, 'plaque-growth-plates.tsv', 'text/tab-separated-values')}>Export fitted plates TSV</button>
      </div>
      <details open><summary>Plaque-model assumptions and limitations</summary>{fit.warnings.map(warning => <p key={warning}>{warning}</p>)}</details>
      <AnalysisRecordDetails record={accepted.record} />
    </section>}
  </section>;
}

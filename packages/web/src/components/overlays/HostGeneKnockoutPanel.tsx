import React, { useEffect, useId, useMemo, useState } from 'react';
import { inspectHostGeneRules, resolveHostGeneOptions, type HostGeneOptions } from '../../../../core/src/analysis/host-gene-knockout';
import type { HostFluxScenario } from '../../../../core/src/analysis/host-metabolism';
import type { HostMetabolismSession, HostMetabolismWork } from '../../workers/HostMetabolismSession';
import { AnalysisRecordDetails } from './primitives/OverlayProvenance';

const number = (value: number | null | undefined) => value === null || value === undefined ? 'Unavailable' : value.toPrecision(7);
const flux = (scenario: HostFluxScenario, id: string) => Object.hasOwn(scenario.fluxes, id) ? scenario.fluxes[id] : undefined;
const range = (scenario: HostFluxScenario, id: string) => {
  const r = scenario.ranges.find(item => item.reactionId === id);
  return r ? `${number(r.minimum.value)} … ${number(r.maximum.value)} (${r.minimum.status}/${r.maximum.status})` : 'Not requested';
};

/** Uses the same accepted model and cancellation owner as imports and manual-bound scenarios. */
export function HostGeneKnockoutPanel({ accepted, session, busy }: {
  accepted: HostMetabolismWork; session: HostMetabolismSession; busy: boolean;
}): React.ReactElement {
  const id = useId();
  const [genes, setGenes] = useState<string[]>([]), [mode, setMode] = useState<HostGeneOptions['mode']>('joint');
  const [reference, setReference] = useState(''), [variability, setVariability] = useState<string[]>([]), [loss, setLoss] = useState('0');
  const [selected, setSelected] = useState(0), [error, setError] = useState<string | null>(null);
  const preview = useMemo(() => {
    try { return { value: inspectHostGeneRules(accepted.input), error: null }; }
    catch (cause) { return { value: null, error: cause instanceof Error ? cause.message : String(cause) }; }
  }, [accepted.input]);
  const result = accepted.geneResult;
  useEffect(() => {
    setGenes(result?.options.genes ?? []); setMode(result?.options.mode ?? 'joint'); setReference(result?.options.reference ?? '');
    setVariability(result?.options.variability ?? []); setLoss(String(result?.options.objectiveLoss ?? 0)); setSelected(0); setError(null);
  }, [accepted]);
  const run = result?.runs[selected] ?? result?.runs[0];
  const dirty = result && (JSON.stringify(genes) !== JSON.stringify(result.options.genes) || mode !== result.options.mode || reference !== result.options.reference
    || JSON.stringify(variability) !== JSON.stringify(result.options.variability) || loss !== String(result.options.objectiveLoss));
  return <section aria-label="Model gene knockout experiments" style={{ display: 'grid', gap: '.75rem' }}>
    <h4>Model-gene knockout experiments</h4>
    <p>Evaluate the supplied AND/OR gene–reaction rules. Unselected genes are assumed functional; inactive reactions receive bounds [0, 0], including reverse flux.
      This overrides any forced flux for those reactions. No genes are physically edited. These are conditional model experiments, not measured essentiality or AMG predictions.</p>
    {preview.error ? <p>Gene-rule analysis unavailable: {preview.error} Manual reaction-bound analysis remains available.</p> : <>
      <p>{preview.value!.genes.length} declared model genes; {preview.value!.unassociatedReactions.length} reactions lack a gene rule and will not be disabled by gene deletion.</p>
      <form onSubmit={event => {
        event.preventDefault();
        try {
          if (!loss.trim()) throw new Error('Supply an objective-loss value.');
          const options = resolveHostGeneOptions({ genes, mode, reference, variability, objectiveLoss: Number(loss) });
          setError(null); void session.run({ kind: 'knockout', input: accepted.input, options });
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      }}><fieldset disabled={busy} style={{ display: 'grid', gap: '.5rem' }}><legend>Gene-deletion draft</legend>
        <label htmlFor={`${id}-genes`}>Knockout model gene IDs (up to 32)</label>
        <select id={`${id}-genes`} multiple size={8} value={genes} onChange={event => setGenes(Array.from(event.target.selectedOptions, option => option.value))}>
          {preview.value!.genes.map(g => <option key={g.id} value={g.id}>{g.id} — {g.reactionIds.length} associated reactions</option>)}
        </select>
        <label htmlFor={`${id}-mode`}>Gene-deletion mode</label><select id={`${id}-mode`} value={mode} onChange={event => setMode(event.target.value as HostGeneOptions['mode'])}>
          <option value="joint">Delete selected genes together</option><option value="single">Screen separate single-gene deletions</option>
        </select>
        <label htmlFor={`${id}-reference`}>Gene-deletion source or what-if assumption</label>
        <input id={`${id}-reference`} required maxLength={2000} value={reference} onChange={event => setReference(event.target.value)} />
        <label htmlFor={`${id}-ranges`}>Knockout flux-range reactions</label><select id={`${id}-ranges`} multiple value={variability} onChange={event => setVariability(Array.from(event.target.selectedOptions, option => option.value))}>
          {accepted.network.reactions.map(r => <option key={r.id} value={r.id}>{r.id}</option>)}
        </select>
        <label htmlFor={`${id}-loss`}>Knockout allowed absolute objective loss</label><input id={`${id}-loss`} required type="number" min={0} max={1000000} step="any" value={loss} onChange={event => setLoss(event.target.value)} />
        <p>Up to 256 LP solves per experiment. Single mode is not cumulative. Ranges describe alternative optima, not confidence intervals.
          The manual reaction-change draft above is not applied to this separate experiment.</p>
        {dirty && <p>Gene-deletion draft changes are not applied. Exports retain the accepted experiment.</p>}
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={!genes.length}>Run gene knockout experiments</button>
      </fieldset></form>
    </>}
    {result && run && accepted.record && <section data-testid="host-gene-result" data-result-id={accepted.record.resultId}>
      <h4>Accepted gene-deletion results</h4>
      <p data-testid="host-gene-baseline">Baseline: {result.baseline.status} / {number(result.baseline.objective)} {accepted.input.source.objectiveUnits}.</p>
      <p>Accepted mode: {result.options.mode}; source/assumption: {result.options.reference}. Export with “Export accepted host experiment” above.</p>
      <table aria-label="Gene-deletion scenario outcomes"><thead><tr><th>Deleted genes</th><th>Disabled reactions</th><th>Solver status</th><th>Objective</th><th>Difference</th><th>Objective / baseline</th><th>No associations</th></tr></thead>
        <tbody>{result.runs.map((row,i) => <tr key={i}><td>{row.genes.join(', ')}</td><td>{row.disabled.length}</td><td>{row.scenario.status}</td>
          <td>{number(row.scenario.objective)}</td><td>{number(row.objectiveDelta)}</td><td>{number(row.relativeObjective)}</td><td>{row.unassociatedGenes.join(', ') || 'None'}</td></tr>)}</tbody></table>
      <label htmlFor={`${id}-run`}>Inspect knockout scenario</label><select id={`${id}-run`} value={Math.min(selected, result.runs.length-1)} onChange={event => setSelected(Number(event.target.value))}>
        {result.runs.map((row,i) => <option key={i} value={i}>{row.genes.join(' + ')}</option>)}
      </select>
      <p>Scenario objective floor: {number(run.scenario.objectiveFloor)}; numerical slack: {number(run.scenario.objectiveSlack)}.
        Max balance residual: {number(run.scenario.certificate?.maxBalanceResidual)}; bound violation: {number(run.scenario.certificate?.maxBoundViolation)}; objective residual: {number(run.scenario.certificate?.objectiveResidual)}.</p>
      <details><summary>Disabled rules and overridden bounds ({run.disabled.length})</summary><table aria-label="Disabled gene reaction rules"><thead><tr><th>Reaction</th><th>Original rule</th><th>Previous medium bounds</th><th>New bounds</th></tr></thead>
        <tbody>{run.disabled.map(r => <tr key={r.reactionId}><td>{r.reactionId}</td><td>{r.rule}</td><td>{r.previousLowerBound} … {r.previousUpperBound}</td><td>0 … 0</td></tr>)}</tbody></table></details>
      <details><summary>Reaction fluxes and requested ranges</summary><div style={{ overflowX: 'auto' }}><table aria-label="Knockout fluxes and ranges"><thead><tr><th>Reaction</th><th>Baseline point</th><th>Knockout point</th><th>Baseline range</th><th>Knockout range</th></tr></thead><tbody>
        {accepted.network.reactions.map(r => <tr key={r.id}><td>{r.id}</td><td>{number(flux(result.baseline,r.id))}</td><td>{number(flux(run.scenario,r.id))}</td><td>{range(result.baseline,r.id)}</td><td>{range(run.scenario,r.id)}</td></tr>)}
      </tbody></table></div></details>
      {result.warnings.map(warning => <p key={warning}>{warning}</p>)}
      <AnalysisRecordDetails record={accepted.record} />
    </section>}
  </section>;
}

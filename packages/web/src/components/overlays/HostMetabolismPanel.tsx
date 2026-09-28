import React, { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { resolveHostFluxOptions, type HostFluxChange, type HostModelSource, type HostFluxScenario } from '../../../../core/src/analysis/host-metabolism';
import { serializeAnalysisRecord } from '../../../../core/src/analysis-result';
import { HostMetabolismSession, type HostMetabolismRequest } from '../../workers/HostMetabolismSession';
import { AnalysisRecordDetails } from './primitives/OverlayProvenance';
import { downloadString } from '../../utils/export';
import { HostGeneKnockoutPanel } from './HostGeneKnockoutPanel';

const SOURCE_LABELS: Record<Exclude<keyof HostModelSource, 'kind'>, string> = {
  name: 'Host model name', version: 'Host model version', organism: 'Host organism', strain: 'Host strain',
  accession: 'Host model accession', reference: 'Host model source reference', license: 'Host model license or permissions',
  fluxUnits: 'Host reaction flux units', objectiveUnits: 'Host objective units',
};
const sourceKeys = Object.keys(SOURCE_LABELS) as Array<Exclude<keyof HostModelSource, 'kind'>>;
const number = (v: number | null | undefined): string => v === null || v === undefined ? 'Unavailable' : v.toPrecision(7);
const pointValue = (value: HostFluxScenario | null, id: string): number | undefined => value && Object.hasOwn(value.fluxes, id) ? value.fluxes[id] : undefined;
const boundsText = (value: HostFluxScenario | null, id: string): string => {
  const range = value?.ranges.find(row => row.reactionId === id);
  return range ? `${number(range.minimum.value)} … ${number(range.maximum.value)} (${range.minimum.status}/${range.maximum.status})` : 'Not requested';
};

/** Explicit model/medium input stays independent of the selected catalog phage and marker-name heuristic. */
export function HostMetabolismPanel(): React.ReactElement {
  const id = useId();
  const session = useMemo(() => new HostMetabolismSession(() => new Worker(new URL('../../workers/host-metabolism.worker.ts', import.meta.url), { type: 'module' })), []);
  const { accepted, busy, phase, error, notice } = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [source, setSource] = useState<HostModelSource>(() => ({ kind: 'local', ...Object.fromEntries(sourceKeys.map(key => [key, ''])) } as HostModelSource));
  const [cobraFile, setCobraFile] = useState<File | null>(null), [cobraText, setCobraText] = useState('');
  const [mediumName, setMediumName] = useState(''), [mediumReference, setMediumReference] = useState(''), [mediumBounds, setMediumBounds] = useState('[]');
  const [changes, setChanges] = useState<HostFluxChange[]>([]), [variability, setVariability] = useState<string[]>([]), [loss, setLoss] = useState('0');
  const [reaction, setReaction] = useState(''), [lower, setLower] = useState(''), [upper, setUpper] = useState('');
  const [evidenceKind, setEvidenceKind] = useState<'assumption' | 'annotation'>('assumption');
  const [mappingReference, setMappingReference] = useState(''), [mappingDescription, setMappingDescription] = useState('');
  const [geneAccession, setGeneAccession] = useState(''), [locusTag, setLocusTag] = useState('');
  const [localError, setLocalError] = useState<string | null>(null), [page, setPage] = useState(0);
  useEffect(() => { session.activate(); return session.deactivate; }, [session]);
  useEffect(() => {
    if (!accepted) return;
    setChanges(accepted.options.changes); setVariability(accepted.options.variability); setLoss(String(accepted.options.objectiveLoss));
    setReaction(accepted.network.reactions[0]?.id ?? ''); setLocalError(null); setPage(0);
  }, [accepted]);
  useEffect(() => {
    const selected = accepted?.network.reactions.find(row => row.id === reaction);
    const medium = accepted?.input.medium.bounds.find(row => row.reactionId === reaction);
    if (selected) { setLower(String(medium?.lowerBound ?? selected.lowerBound)); setUpper(String(medium?.upperBound ?? selected.upperBound)); }
  }, [accepted, reaction]);
  const run = (request: HostMetabolismRequest | Promise<HostMetabolismRequest>) => { setLocalError(null); void session.run(request); };
  const save = (analysis: boolean) => {
    if (!accepted || analysis && !accepted.record) return;
    try { downloadString(analysis ? serializeAnalysisRecord(accepted.record!) : JSON.stringify(accepted.input, null, 2),
      analysis ? 'host-metabolism-result.json' : 'host-model-input.json', 'application/json'); setLocalError(null); }
    catch (cause) { setLocalError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: '.75rem' };
  const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '.25rem' };
  const result = accepted?.result;
  const draftChanged = accepted && (JSON.stringify(changes) !== JSON.stringify(accepted.options.changes)
    || JSON.stringify(variability) !== JSON.stringify(accepted.options.variability) || loss !== String(accepted.options.objectiveLoss));
  const reactions = accepted?.network.reactions ?? [], currentPage = Math.min(page, Math.max(0, Math.ceil(reactions.length / 40) - 1));
  return <section aria-label="Sourced host metabolism" style={{ display: 'grid', gap: '1rem', overflowWrap: 'anywhere' }}>
    <h3>Sourced host-model scenarios</h3>
    <p>Load an explicit host model and medium, then compare simultaneous reaction-bound changes. No host, biomass objective or AMG capacity is guessed from the selected phage.
      Inputs stay local. Model flux is not measured growth, fitness or burst yield. Export before leaving this workspace.</p>
    <label htmlFor={`${id}-saved`}>Import host-model dataset or saved experiment JSON</label>
    <input id={`${id}-saved`} type="file" accept=".json,application/json" disabled={busy} onChange={event => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (!file) return;
      run(file.size > 10 * 1024 * 1024 ? Promise.reject(new Error('Saved host file exceeds 10 MiB.')) : file.text().then(content => ({ kind: 'import' as const, content })));
    }} />
    <button type="button" disabled={!busy} onClick={session.cancel}>Cancel host-model work</button>
    <p role="status" data-testid="host-model-status">{busy ? `${phase}. Accepted evidence remains unchanged.` : notice ?? 'No host model loaded.'}</p>
    {(error || localError) && <p role="alert">{localError ?? error}</p>}
    <details open={!accepted}><summary>Prepare a sourced COBRA JSON model</summary>
      <form onSubmit={event => {
        event.preventDefault();
        try {
          const medium = { name: mediumName, reference: mediumReference, bounds: JSON.parse(mediumBounds) };
          run(cobraFile && cobraFile.size > 2 * 1024 * 1024 ? Promise.reject(new Error('COBRA JSON exceeds 2 MiB.'))
            : (cobraFile ? cobraFile.text() : Promise.resolve(cobraText)).then(content => ({ kind: 'prepare' as const, content, source, medium })));
        } catch (cause) { setLocalError(cause instanceof Error ? cause.message : String(cause)); }
      }}><fieldset disabled={busy} style={{ display: 'grid', gap: '.75rem' }}>
        <legend>New model draft</legend>
        <label style={field}>COBRA model JSON<textarea value={cobraText} disabled={!!cobraFile} onChange={event => setCobraText(event.target.value)} rows={4} spellCheck={false} /></label>
        <label style={field}>Or choose COBRA JSON<input type="file" accept=".json,application/json" onChange={event => setCobraFile(event.currentTarget.files?.[0] ?? null)} /></label>
        {cobraFile && <button type="button" onClick={() => setCobraFile(null)}>Use pasted COBRA JSON instead</button>}
        <p>Finite bounds, compartments and a maximized nonzero linear objective are required. Up to 200 reactions and metabolites.
          Custom mathematical constraints and minimization are rejected, not silently discarded. GPR rules are retained as metadata, not applied as kinetic regulation.</p>
        <div style={grid}>{sourceKeys.map(key => <label key={key} style={field}>{SOURCE_LABELS[key]}<input required value={source[key]} onChange={event => setSource({ ...source, [key]: event.target.value })} /></label>)}</div>
        <div><label htmlFor={`${id}-source`}>Host model provenance category</label><select id={`${id}-source`} value={source.kind} onChange={event => setSource({ ...source, kind: event.target.value as HostModelSource['kind'] })}>
          <option value="local">User-supplied local model</option><option value="reference">Published reference (source supplied by user)</option><option value="demo">Synthetic teaching model</option>
        </select></div>
        <label style={field}>Host medium name<input required value={mediumName} onChange={event => setMediumName(event.target.value)} /></label>
        <label style={field}>Host medium reference and assumptions<input required value={mediumReference} onChange={event => setMediumReference(event.target.value)} /></label>
        <label style={field}>Medium bound overrides JSON<textarea value={mediumBounds} onChange={event => setMediumBounds(event.target.value)} rows={3} spellCheck={false} /></label>
        <p>Use an array of <code>{'{"reactionId":"EX_glc","lowerBound":-10,"upperBound":0}'}</code>. Unlisted reactions retain source bounds.
          An empty array explicitly retains all source-model bounds; no medium completion or automatic exchange closure is performed.</p>
        <button type="submit">Load and validate host model</button>
      </fieldset></form>
    </details>
    {accepted && <>
      <h4 data-testid="host-model-name">{accepted.input.source.name} · {accepted.input.source.version}</h4>
      <p>{accepted.input.source.kind === 'demo' ? 'Synthetic model' : 'Supplied source (not independently verified)'}: {accepted.input.source.organism}, {accepted.input.source.strain}, {accepted.input.source.accession}.
        {' '}{accepted.input.source.reference}. License/permissions: {accepted.input.source.license}. Medium: {accepted.input.medium.name} — {accepted.input.medium.reference}.
        Flux units: {accepted.input.source.fluxUnits}; objective units: {accepted.input.source.objectiveUnits}.</p>
      <form onSubmit={event => {
        event.preventDefault();
        try {
          if (lower.trim() === '' || upper.trim() === '') throw new Error('Enter both signed reaction bounds.');
          const candidate: HostFluxChange = { reactionId: reaction, lowerBound: Number(lower), upperBound: Number(upper),
            evidence: { kind: evidenceKind, reference: mappingReference, description: mappingDescription,
              gene: evidenceKind === 'annotation' ? { accession: geneAccession, locusTag } : null } };
          const next = resolveHostFluxOptions({ changes: [...changes, candidate], variability, objectiveLoss: Number(loss) });
          setChanges(next.changes); setLocalError(null);
        } catch (cause) { setLocalError(cause instanceof Error ? cause.message : String(cause)); }
      }}><fieldset disabled={busy} style={{ display: 'grid', gap: '.5rem' }}><legend>Explicit reaction-change draft</legend>
        <div><label htmlFor={`${id}-reaction`}>Mapped model reaction</label><select id={`${id}-reaction`} value={reaction} onChange={event => setReaction(event.target.value)}>
          {reactions.map(row => <option key={row.id} value={row.id}>{row.id} — {row.name}</option>)}</select></div>
        <div style={grid}><label style={field}>Scenario lower bound<input required type="number" step="any" value={lower} onChange={event => setLower(event.target.value)} /></label>
          <label style={field}>Scenario upper bound<input required type="number" step="any" value={upper} onChange={event => setUpper(event.target.value)} /></label></div>
        <div><label htmlFor={`${id}-evidence`}>Reaction-change evidence</label><select id={`${id}-evidence`} value={evidenceKind} onChange={event => setEvidenceKind(event.target.value as typeof evidenceKind)}>
          <option value="assumption">Explicit what-if assumption</option><option value="annotation">Sourced gene annotation with assumed capacity effect</option></select></div>
        <label style={field}>Reaction-change reference<input required value={mappingReference} onChange={event => setMappingReference(event.target.value)} /></label>
        <label style={field}>Capacity-change explanation<input required value={mappingDescription} onChange={event => setMappingDescription(event.target.value)} /></label>
        {evidenceKind === 'annotation' && <div style={grid}><label style={field}>Mapped gene accession<input required value={geneAccession} onChange={event => setGeneAccession(event.target.value)} /></label>
          <label style={field}>Mapped gene locus tag<input required value={locusTag} onChange={event => setLocusTag(event.target.value)} /></label></div>}
        <p>These are absolute signed bounds, applied together. An annotation does not by itself establish a capacity change. No name/Pfam rule infers one here.</p>
        <button type="submit">Add reaction change</button>
      </fieldset></form>
      <table aria-label="Draft host reaction changes"><thead><tr><th>Reaction</th><th>Bounds</th><th>Evidence / assumed effect</th><th>Action</th></tr></thead>
        <tbody>{changes.map(row => <tr key={row.reactionId}><td>{row.reactionId}</td><td>{row.lowerBound} … {row.upperBound}</td>
          <td>{row.evidence.reference}: {row.evidence.description}{row.evidence.gene && ` (${row.evidence.gene.accession}/${row.evidence.gene.locusTag})`}</td>
          <td><button type="button" disabled={busy} onClick={() => setChanges(changes.filter(other => other.reactionId !== row.reactionId))}>Remove {row.reactionId}</button></td></tr>)}</tbody></table>
      <form onSubmit={event => { event.preventDefault(); run({ kind: 'analyze', input: accepted.input, options: { changes, variability, objectiveLoss: Number(loss) } }); }}>
        <fieldset disabled={busy}><legend>Scenario and flux-range calculation</legend>
          <label htmlFor={`${id}-variability`}>Flux-range reactions (up to 12)</label><select id={`${id}-variability`} multiple value={variability} onChange={event => setVariability(Array.from(event.target.selectedOptions, option => option.value))}>
            {reactions.map(row => <option key={row.id} value={row.id}>{row.id}</option>)}</select>
          <label style={field}>Allowed absolute objective loss<input type="number" required step="any" min={0} max={1000000} value={loss} onChange={event => setLoss(event.target.value)} /></label>
          <p>Each range uses its own scenario optimum minus the allowed loss and reported numerical slack. Ranges are not confidence intervals; cycles are allowed.</p>
          {draftChanged && <p>Draft changes are not applied. Displayed results and exports retain the last accepted settings.</p>}
          <button type="submit">Run host-model scenarios</button>
        </fieldset>
      </form>
      <div><button type="button" disabled={busy} onClick={() => save(false)}>Export accepted host model</button>{' '}
        <button type="button" disabled={busy || !accepted.record} onClick={() => save(true)}>Export accepted host experiment</button></div>
    </>}
    {accepted && <HostGeneKnockoutPanel accepted={accepted} session={session} busy={busy} />}
    {result && accepted?.record && <section data-testid="host-model-result" data-result-id={accepted.record.resultId}>
      <h4>Conditional model results</h4>
      <p data-testid="host-model-objectives">Baseline: {result.baseline.status} / {number(result.baseline.objective)}. Scenario: {result.perturbed?.status ?? 'Not requested'} / {number(result.perturbed?.objective)}.
        Objective difference: {number(result.objectiveDelta)}; percent change: {number(result.percentChange)}.</p>
      {[['Baseline', result.baseline], ['Scenario', result.perturbed]].map(([label, value]) => {
        const scenario = value as HostFluxScenario | null; return scenario && <p key={String(label)}>{String(label)} objective floor: {number(scenario.objectiveFloor)}; numerical slack: {number(scenario.objectiveSlack)}.
          Max stoichiometric residual: {number(scenario.certificate?.maxBalanceResidual)}; bound violation: {number(scenario.certificate?.maxBoundViolation)}; objective residual: {number(scenario.certificate?.objectiveResidual)}.</p>;
      })}
      <div style={{ overflowX: 'auto' }}><table aria-label="Host fluxes and alternative-optimum ranges"><thead><tr><th>Reaction</th><th>Baseline point</th><th>Scenario point</th><th>Baseline range</th><th>Scenario range</th><th>Range difference</th></tr></thead>
        <tbody>{reactions.slice(currentPage * 40, (currentPage + 1) * 40).map(row => {
          const delta = result.rangeChanges.find(item => item.reactionId === row.id);
          return <tr key={row.id}><td>{row.id}<br />{row.name}</td><td>{number(pointValue(result.baseline, row.id))}</td><td>{number(pointValue(result.perturbed, row.id))}</td>
            <td>{boundsText(result.baseline, row.id)}</td><td>{boundsText(result.perturbed, row.id)}</td><td>{delta ? `${number(delta.lower)} … ${number(delta.upper)}: ${delta.interpretation}` : 'Not requested'}</td></tr>;
        })}</tbody></table></div>
      {reactions.length > 40 && <div><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous reactions</button>{' '}{currentPage + 1}/{Math.ceil(reactions.length / 40)}{' '}
        <button type="button" disabled={(currentPage + 1) * 40 >= reactions.length} onClick={() => setPage(currentPage + 1)}>Next reactions</button></div>}
      <details><summary>Accepted model, medium and scenario inputs</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify({
        source: accepted.input.source, medium: accepted.input.medium,
        objective: accepted.network.reactions.filter(row => row.objective !== 0).map(row => ({ reactionId: row.id, coefficient: row.objective })),
        settings: result.options,
      }, null, 2)}</pre></details>
      {result.warnings.map(warning => <p key={warning}>{warning}</p>)}
      <AnalysisRecordDetails record={accepted.record} />
    </section>}
  </section>;
}
